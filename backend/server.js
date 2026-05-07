const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.SKILLS_API_PORT || 4100);
const HOST = process.env.SKILLS_API_HOST || "0.0.0.0";
const JOBS_ROOT = process.env.SKILLS_API_JOBS_ROOT || "/data/work/jobs";
const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL || "http://opencode-server:4096";
const DEFAULT_MODEL = process.env.OPENCODE_RUN_MODEL || "deepseek-anthropic/deepseek-v4-flash";
const FALLBACK_MODELS = (process.env.OPENCODE_FALLBACK_MODELS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const CAPACITY_RETRIES = Number(process.env.OPENCODE_CAPACITY_RETRIES || 1);
const CAPACITY_RETRY_DELAY_MS = Number(process.env.OPENCODE_CAPACITY_RETRY_DELAY_MS || 5000);
const MAX_BODY_BYTES = Number(process.env.SKILLS_API_MAX_BODY_MB || 50) * 1024 * 1024;

function now() {
  return new Date().toISOString();
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function badRequest(res, message) {
  json(res, 400, { error: "bad_request", message });
}

function serverError(res, error) {
  json(res, 500, { error: "internal_error", message: error.message || String(error) });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobPaths(id) {
  const root = path.join(JOBS_ROOT, id);
  return {
    root,
    input: path.join(root, "input"),
    output: path.join(root, "output"),
    logs: path.join(root, "logs"),
    metadata: path.join(root, "job.json"),
  };
}

function assertJobId(id) {
  if (!/^job_[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("invalid job id");
  }
}

function safeRelativePath(value) {
  if (!value || typeof value !== "string") {
    throw new Error("filename is required");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("invalid relative path");
  }
  return normalized;
}

function safeJoin(root, relativePath) {
  const target = path.resolve(root, safeRelativePath(relativePath));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error("path escapes job directory");
  }
  return target;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readJob(id) {
  assertJobId(id);
  const paths = jobPaths(id);
  const raw = await fsp.readFile(paths.metadata, "utf8");
  return JSON.parse(raw);
}

async function writeJob(job) {
  job.updatedAt = now();
  await fsp.writeFile(job.paths.metadata, JSON.stringify(job, null, 2) + "\n", "utf8");
}

async function appendFile(file, data) {
  await fsp.appendFile(file, data).catch(() => {});
}

async function ensureJobDirs(paths) {
  await fsp.mkdir(paths.input, { recursive: true });
  await fsp.mkdir(paths.output, { recursive: true });
  await fsp.mkdir(paths.logs, { recursive: true });
}

async function createJob(body) {
  const id = `job_${randomUUID().replaceAll("-", "")}`;
  const paths = jobPaths(id);
  await ensureJobDirs(paths);
  const createdAt = now();
  const job = {
    id,
    type: body.type || "custom",
    title: body.title || "",
    status: "created",
    createdAt,
    updatedAt: createdAt,
    paths,
    files: [],
    run: null,
  };
  await writeJob(job);
  return job;
}

async function listJobs() {
  await fsp.mkdir(JOBS_ROOT, { recursive: true });
  const entries = await fsp.readdir(JOBS_ROOT, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("job_")) continue;
    try {
      jobs.push(await readJob(entry.name));
    } catch {
      // Ignore incomplete job directories.
    }
  }
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return jobs;
}

async function writeInputFile(job, body) {
  const relativePath = safeRelativePath(body.filename);
  const target = safeJoin(job.paths.input, relativePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  let data;
  if (typeof body.contentBase64 === "string") {
    data = Buffer.from(body.contentBase64, "base64");
  } else if (typeof body.content === "string") {
    data = Buffer.from(body.content, "utf8");
  } else {
    throw new Error("content or contentBase64 is required");
  }

  await fsp.writeFile(target, data);
  const item = {
    path: relativePath,
    size: data.length,
    writtenAt: now(),
  };
  job.files.push(item);
  await writeJob(job);
  return item;
}

function defaultPrompt(job) {
  const skillHint = job.type && job.type !== "custom" ? `${job.type} skill` : "合适的 skill";
  return [
    `请使用 ${skillHint} 处理当前任务。`,
    `任务根目录：${job.paths.root}`,
    `输入目录：${job.paths.input}`,
    `输出目录：${job.paths.output}`,
    "请把所有生成结果写入输出目录，并在回复中简要说明输出文件。",
  ].join("\n");
}

async function runJob(job, body) {
  if (job.status === "running") {
    throw new Error("job is already running");
  }

  const prompt = body.prompt || defaultPrompt(job);
  const requestedModels = Array.isArray(body.models) ? body.models : [];
  const modelCandidates = [...requestedModels, body.model || DEFAULT_MODEL, ...FALLBACK_MODELS]
    .filter((model) => typeof model === "string" && model.trim())
    .map((model) => model.trim())
    .filter((model, index, models) => models.indexOf(model) === index);
  const stdoutPath = path.join(job.paths.logs, "run.jsonl");
  const stderrPath = path.join(job.paths.logs, "stderr.log");
  const startedAt = now();

  job.status = "running";
  job.run = {
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

  await fsp.writeFile(stdoutPath, "", "utf8");
  await fsp.writeFile(stderrPath, "", "utf8");

  runJobAttempts(job.id, prompt, modelCandidates, body).catch(async (error) => {
    const latest = await readJob(job.id);
    latest.status = "failed";
    latest.run.finishedAt = now();
    latest.run.error = error.message || String(error);
    await writeJob(latest);
  });

  return job;
}

function isCapacityError(output) {
  return /selected model is at capacity|model is at capacity|capacity/i.test(output);
}

function buildAttemptPlan(models) {
  const plan = [];
  for (const model of models) {
    const repeats = plan.length === 0 ? CAPACITY_RETRIES + 1 : 1;
    for (let i = 0; i < repeats; i += 1) {
      plan.push(model);
    }
  }
  return plan;
}

async function runJobAttempts(jobId, prompt, models, body) {
  const plan = buildAttemptPlan(models);
  let lastExitCode = null;
  let lastCapacityError = false;

  for (let index = 0; index < plan.length; index += 1) {
    const model = plan[index];
    const attemptNumber = index + 1;
    const job = await readJob(jobId);
    const attempt = {
      number: attemptNumber,
      model,
      startedAt: now(),
      finishedAt: null,
      exitCode: null,
      capacityError: false,
      stdout: path.join(job.paths.logs, `run-attempt-${attemptNumber}.jsonl`),
      stderr: path.join(job.paths.logs, `stderr-attempt-${attemptNumber}.log`),
    };

    job.run.model = model;
    job.run.attempts.push(attempt);
    await writeJob(job);

    if (attemptNumber > 1) {
      await sleep(CAPACITY_RETRY_DELAY_MS);
    }

    await fsp.writeFile(attempt.stdout, "", "utf8");
    await fsp.writeFile(attempt.stderr, "", "utf8");
    await appendFile(job.run.stdout, `\n{"type":"attempt_start","attempt":${attemptNumber},"model":${JSON.stringify(model)},"timestamp":${JSON.stringify(now())}}\n`);

    const result = await runOpenCodeAttempt(job, prompt, model, body, attempt.stdout, attempt.stderr);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    lastExitCode = result.exitCode;
    lastCapacityError = isCapacityError(combinedOutput);

    const latest = await readJob(jobId);
    const latestAttempt = latest.run.attempts.find((item) => item.number === attemptNumber);
    if (latestAttempt) {
      latestAttempt.finishedAt = now();
      latestAttempt.exitCode = result.exitCode;
      latestAttempt.capacityError = lastCapacityError;
    }
    latest.run.exitCode = result.exitCode;
    latest.run.model = model;
    await appendFile(latest.run.stdout, result.stdout);
    await appendFile(latest.run.stderr, result.stderr);

    if (result.exitCode === 0) {
      latest.status = "succeeded";
      latest.run.finishedAt = now();
      await writeJob(latest);
      return;
    }

    if (!lastCapacityError) {
      latest.status = "failed";
      latest.run.finishedAt = now();
      latest.run.error = "opencode run failed";
      await writeJob(latest);
      return;
    }

    latest.status = "retrying";
    latest.run.error = "selected model is at capacity";
    await writeJob(latest);
  }

  const latest = await readJob(jobId);
  latest.status = "failed";
  latest.run.finishedAt = now();
  latest.run.exitCode = lastExitCode;
  latest.run.capacityError = lastCapacityError;
  latest.run.error = lastCapacityError ? "all model attempts failed because selected model is at capacity" : "all model attempts failed";
  await writeJob(latest);
}

function runOpenCodeAttempt(job, prompt, model, body, stdoutPath, stderrPath) {
  return new Promise((resolve) => {
  const args = [
    "run",
    "--attach",
    OPENCODE_SERVER_URL,
    "--dir",
    job.paths.root,
    "--model",
    model,
    "--format",
    "json",
  ];

  if (body.dangerouslySkipPermissions === true) {
    args.push("--dangerously-skip-permissions");
  }

  args.push(prompt);

  const child = spawn("opencode", args, {
    cwd: job.paths.root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      fs.appendFile(stdoutPath, chunk, () => {});
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      fs.appendFile(stderrPath, chunk, () => {});
    });

    child.on("error", (error) => {
      stderr += error.message;
      resolve({ exitCode: 1, stdout, stderr });
    });

    child.on("close", (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

async function readLogs(job) {
  const stdout = await fsp.readFile(path.join(job.paths.logs, "run.jsonl"), "utf8").catch(() => "");
  const stderr = await fsp.readFile(path.join(job.paths.logs, "stderr.log"), "utf8").catch(() => "");
  return { stdout, stderr };
}

async function listFiles(root) {
  const results = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const stat = await fsp.stat(full);
        results.push({ path: rel, size: stat.size, updatedAt: stat.mtime.toISOString() });
      }
    }
  }
  await walk(root);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      service: "skills-api",
      opencodeServerUrl: OPENCODE_SERVER_URL,
      jobsRoot: JOBS_ROOT,
      defaultModel: DEFAULT_MODEL,
      fallbackModels: FALLBACK_MODELS,
      capacityRetries: CAPACITY_RETRIES,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/jobs") {
    const body = await readBody(req);
    json(res, 201, await createJob(body));
    return;
  }

  if (req.method === "GET" && url.pathname === "/jobs") {
    json(res, 200, { jobs: await listJobs() });
    return;
  }

  if (parts[0] !== "jobs" || !parts[1]) {
    notFound(res);
    return;
  }

  const job = await readJob(parts[1]);

  if (req.method === "GET" && parts.length === 2) {
    json(res, 200, job);
    return;
  }

  if (req.method === "POST" && parts.length === 3 && parts[2] === "files") {
    const body = await readBody(req);
    json(res, 201, { file: await writeInputFile(job, body), job: await readJob(job.id) });
    return;
  }

  if (req.method === "POST" && parts.length === 3 && parts[2] === "run") {
    const body = await readBody(req);
    json(res, 202, await runJob(job, body));
    return;
  }

  if (req.method === "GET" && parts.length === 3 && parts[2] === "logs") {
    json(res, 200, await readLogs(job));
    return;
  }

  if (req.method === "GET" && parts.length === 3 && parts[2] === "outputs") {
    json(res, 200, { files: await listFiles(job.paths.output) });
    return;
  }

  if (req.method === "GET" && parts.length >= 4 && parts[2] === "outputs") {
    const relativePath = parts.slice(3).join("/");
    const target = safeJoin(job.paths.output, relativePath);
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": data.length,
      "Content-Disposition": `attachment; filename="${path.basename(target).replaceAll('"', "")}"`,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
    return;
  }

  notFound(res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (error.message === "invalid job id" || error.message.includes("required") || error.message.includes("invalid")) {
      badRequest(res, error.message);
      return;
    }
    if (error.code === "ENOENT") {
      notFound(res);
      return;
    }
    serverError(res, error);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`skills-api listening on http://${HOST}:${PORT}`);
});
