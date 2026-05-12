/**
 * Job executor — runs adapters, OpenCode prompts, manages attempts and cancellation.
 * Extracted from server.js for maintainability.
 */

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { readJob, writeJob, safeJoin, now, isActiveStatus, isSubmitRun } = require("./jobs-crud.js");
const { runOptions } = require("./templates.js");

const CANCEL_MARKER = "cancel-requested.json";

function tryLoadAdapter(template) {
  const relativePath = `./adapters/${template}.js`;
  try {
    return require(relativePath);
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND" && error.message.includes(relativePath)) return null;
    throw error;
  }
}

async function runJob(job, body, template, mode, {
  OPENCODE_SERVER_URL,
  SKILL_ROOT,
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  CAPACITY_RETRIES,
  CAPACITY_RETRY_DELAY_MS,
  useDeterministicAdapters = false,
  md2wechatPrompt,
  complexSkillPrompt,
  hasInputFiles,
  ensureTemplateInputs,
  writeServiceConfig,
  startPush,
}) {
  if (isActiveStatus(job.status)) throw new Error("job is already running");

  const options = runOptions(body);
  const stdoutPath = path.join(job.paths.logs, "run.jsonl");
  const stderrPath = path.join(job.paths.logs, "stderr.log");
  const startedAt = now();

  // For non-custom templates, write the service-config before anything else
  if (template !== "custom") {
    await ensureTemplateInputs(job, template, body);
    await writeServiceConfig(job, template, body);
  }

  // Deterministic adapters are legacy/optional. The default execution path is
  // OpenCode + skills, matching local agent behavior.
  const adapter = useDeterministicAdapters ? tryLoadAdapter(template) : null;
  if (adapter) {
    job.status = "running";
    job.template = template;
    job.run = {
      template,
      options,
      model: "adapter",
      models: [],
      prompt: "(deterministic adapter)",
      startedAt,
      finishedAt: null,
      exitCode: null,
      stdout: stdoutPath,
      stderr: stderrPath,
      attempts: [],
      adapter: true,
    };
    await writeJob(job);
    await fsp.writeFile(stdoutPath, "", "utf8");
    await fsp.writeFile(stderrPath, "", "utf8");

    // Run adapter asynchronously
    runAdapterAsync(job.id, adapter, body, mode, { startPush }).catch(async (error) => {
      const latest = await readJob(job.id);
      if (latest.status === "canceled") return;
      latest.status = "failed";
      latest.run.finishedAt = now();
      latest.run.error = error.message || String(error);
      await writeJob(latest);
      startPush(latest.id).catch(() => {});
    });

    return job;
  }

  // No adapter — use OpenCode prompt path
  const prompt = await promptForRun(job, body, template, {
    md2wechatPrompt,
    complexSkillPrompt,
    hasInputFiles,
  });
  const requestedModels = Array.isArray(body.models) ? body.models : [];
  const modelCandidates = [...requestedModels, body.model || DEFAULT_MODEL, ...FALLBACK_MODELS]
    .filter((model) => typeof model === "string" && model.trim())
    .map((model) => model.trim())
    .filter((model, index, models) => models.indexOf(model) === index);

  job.status = "running";
  job.template = template;
  job.run = {
    template,
    options,
    model: modelCandidates[0],
    models: modelCandidates,
    prompt,
    startedAt,
    finishedAt: null,
    exitCode: null,
    stdout: stdoutPath,
    stderr: stderrPath,
    attempts: [],
  };
  await writeJob(job);

  // Run OpenCode attempts asynchronously
  runJobAttempts(job.id, prompt, modelCandidates, body, {
    OPENCODE_SERVER_URL,
    SKILL_ROOT,
    CAPACITY_RETRIES,
    CAPACITY_RETRY_DELAY_MS,
    startPush,
  }).catch(async (error) => {
    const latest = await readJob(job.id);
    if (latest.status === "canceled") return;
    latest.status = "failed";
    latest.run.finishedAt = now();
    latest.run.error = error.message || String(error);
    await writeJob(latest);
    startPush(latest.id).catch(() => {});
  });

  return job;
}

async function promptForRun(job, body, template, { md2wechatPrompt, complexSkillPrompt, hasInputFiles }) {
  if (template === "custom") {
    if (body.prompt) return body.prompt;
    return "请根据输入目录中的材料，完成任务。";
  }

  if (body.prompt) return body.prompt;

  if (template === "md2wechat") return md2wechatPrompt(job);

  return complexSkillPrompt(job, template, body);
}

async function writeCancelMarker(job, canceledAt) {
  const payload = {
    canceled: true,
    id: job.id,
    canceledAt: canceledAt || now(),
  };
  await fsp.writeFile(path.join(job.paths.input, CANCEL_MARKER), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function stopActiveChild(active) {
  if (!active) return;
  const { child } = active;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      const pid = child.pid;
      try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
          }
        } catch {}
      }, 5000).unref();
    }
  } catch {}
}

async function cancelJob(job, { ACTIVE_RUNS, startPush }) {
  if (job.status === "canceled" || job.status === "completed" || job.status === "failed") return;
  const canceledAt = now();
  job.status = "canceled";
  job.finishedAt = canceledAt;
  if (job.run) job.run.finishedAt = canceledAt;
  await writeJob(job);
  await writeCancelMarker(job, canceledAt);

  const active = ACTIVE_RUNS.get(job.id);
  if (active) {
    stopActiveChild(active);
    ACTIVE_RUNS.delete(job.id);
  }
  startPush(job.id).catch(() => {});
}

async function runAdapterAsync(jobId, adapter, body, mode, { startPush }) {
  const job = await readJob(jobId);
  const result = await adapter.run(job, body, mode || "", {
    registerChild: () => {},
    unregisterChild: () => {},
  });

  if (job.status === "canceled") return;

  const finishedAt = now();
  job.run.finishedAt = finishedAt;

  if (result === null) {
    // Adapter fell through — need to restart with OpenCode prompt
    job.run.adapter = false;
    job.status = "created";
    await writeJob(job);
    // Server will handle restart
    return;
  }

  job.status = result.success ? "completed" : "failed";
  if (!result.success) job.run.error = result.error || "adapter failed";
  await writeJob(job);
  startPush(jobId).catch(() => {});
}

function isCapacityError(output) {
  return (
    /capacity|rate_limit|too many requests|overloaded|try again|见解受限|容量已满|负载过高/i.test(output || "")
  );
}

function buildAttemptPlan(models) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const seen = new Set();
  const plan = [];
  for (const model of models) {
    if (seen.has(model)) continue;
    seen.add(model);
    plan.push({ model, maxRetries: 0 });
  }
  return plan;
}

async function runJobAttempts(jobId, prompt, models, body, {
  OPENCODE_SERVER_URL,
  SKILL_ROOT,
  CAPACITY_RETRIES,
  CAPACITY_RETRY_DELAY_MS,
  startPush,
}) {
  const stdoutPath = path.join((await readJob(jobId)).paths.logs, "run.jsonl");
  const stderrPath = path.join((await readJob(jobId)).paths.logs, "stderr.log");
  let attemptPlan = buildAttemptPlan(models);

  for (let index = 0; index < attemptPlan.length; index++) {
    const { model } = attemptPlan[index];
    let lastError = "";

    for (let retry = 0; retry <= Math.max(0, CAPACITY_RETRIES); retry++) {
      let job = await readJob(jobId);
      if (job.status === "canceled") return;

      if (retry > 0) {
        await new Promise((resolve) => setTimeout(resolve, CAPACITY_RETRY_DELAY_MS));
      }

      const active = { model, attempt: index, retry, startedAt: now(), child: null };
      // The ACTIVE_RUNS is managed by server.js; we attach via a callback

      const exitCode = await runOpenCodeAttempt(
        jobId, prompt, model, body, stdoutPath, stderrPath, SKILL_ROOT, OPENCODE_SERVER_URL,
        (child) => { active.child = child; },
        () => { /* unregister handled by caller */ },
      );

      job = await readJob(jobId);
      if (job.status === "canceled") return;

      const runAttempt = {
        model,
        attempt: index,
        retry,
        startedAt: active.startedAt,
        finishedAt: now(),
        exitCode: exitCode ?? -1,
      };
      if (!job.run) job.run = { attempts: [] };
      if (!job.run.attempts) job.run.attempts = [];
      job.run.attempts.push(runAttempt);

      if (exitCode === 0) {
        job.status = "completed";
        job.run.finishedAt = now();
        job.run.exitCode = 0;
        job.run.model = model;
        await writeJob(job);
        startPush(jobId).catch(() => {});
        return;
      }

      // Check if we should retry for capacity
      const output = await fsp.readFile(stdoutPath, "utf8").catch(() => "");
      if (isCapacityError(output)) {
        lastError = `capacity error on ${model} (retry ${retry + 1}/${CAPACITY_RETRIES + 1})`;
        continue;
      }
      break;
    }

    // Last model — mark as failed
    const job = await readJob(jobId);
    if (job.status === "canceled") return;

    job.run.finishedAt = now();
    job.run.exitCode = -1;
    job.run.model = model;
    job.run.error = lastError || `${model} failed`;
    if (index === attemptPlan.length - 1) {
      job.status = "failed";
      await writeJob(job);
      startPush(jobId).catch(() => {});
    }
  }
}

async function runOpenCodeAttempt(jobId, prompt, model, body, stdoutPath, stderrPath, SKILL_ROOT, OPENCODE_SERVER_URL, onChild, onClose) {
  return new Promise((resolve) => {
    readJob(jobId).then((job) => {
      const args = [
        "run",
        "--attach", OPENCODE_SERVER_URL,
        "--dir", job.paths.root,
        "--model", model,
        "--format", "json",
        "--dangerously-skip-permissions",
        "--title", job.title || job.id,
        prompt,
      ];

      const child = spawn("opencode", args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { ...process.env, SKILL_ROOT, PYTHONUNBUFFERED: "1" },
      });

      onChild?.(child);

      const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "a" });
      const stderrStream = fs.createWriteStream(stderrPath, { flags: "a" });

      child.stdout.on("data", (chunk) => { stdoutStream.write(chunk); });
      child.stderr.on("data", (chunk) => { stderrStream.write(chunk); });

      function cleanup() {
        stdoutStream.end();
        stderrStream.end();
      }

      child.on("error", (error) => {
        stderrStream.write(`${error.message}\n`);
        onClose?.();
        cleanup();
        resolve(1);
      });

      child.on("close", (code) => {
        onClose?.();
        cleanup();
        resolve(code ?? 1);
      });
    }).catch((error) => {
      fsp.appendFile(stderrPath, `${error.message || String(error)}\n`, "utf8").catch(() => {});
      resolve(1);
    });
  });
}

module.exports = {
  tryLoadAdapter,
  runJob,
  cancelJob,
  writeCancelMarker,
  stopActiveChild,
  runAdapterAsync,
  runJobAttempts,
  runOpenCodeAttempt,
  isCapacityError,
  buildAttemptPlan,
};
