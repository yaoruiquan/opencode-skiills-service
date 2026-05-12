/**
 * SSE push notifications for job progress.
 * Extracted from server.js for maintainability.
 */

const { isSubmitRun } = require("./jobs-crud.js");
const fsp = require("node:fs/promises");

const clients = new Map();
let clientsCounter = 0;

function push(jobId, event, data) {
  for (const [clientId, client] of clients) {
    if (client.jobId !== jobId) continue;
    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      client.res.write(payload);
    } catch {
      clients.delete(clientId);
    }
  }
}

async function startPush(jobId, { readJob, readLogs, readProgress, parseExecutionEvents, listFiles, groupOutputFilesByTemplate, validateRequiredOutputs, TEMPLATES }) {
  push(jobId, "push", { status: "started", jobId });

  let job;
  try {
    job = await readJob(jobId);
  } catch {
    push(jobId, "push", { status: "done" });
    return;
  }

  // Initial push with job state
  const detail = await executionDetail(job, await readLogs(job), readProgress);
  push(jobId, "push", { status: "info", jobId, ...detail });

  // Poll for changes
  const deadlineMs = 30 * 60_000;
  const started = Date.now();
  let lastUpdated = job.updatedAt;
  let lastSignature = detailSignature(detail);

  while (Date.now() - started < deadlineMs) {
    await sleep(3000);
    try {
      job = await readJob(jobId);
    } catch {
      push(jobId, "push", { status: "done" });
      return;
    }

    const logs = await readLogs(job);
    const currentDetail = await executionDetail(job, logs, readProgress);
    const currentSignature = detailSignature(currentDetail);
    if (job.updatedAt === lastUpdated && currentSignature === lastSignature) continue;
    lastUpdated = job.updatedAt;
    lastSignature = currentSignature;

    const terminalStates = ["completed", "failed", "canceled"];
    const isTerminal = terminalStates.includes(job.status);

    if (isTerminal) {
      // Final push with all data
      const outputs = await listFiles(job.paths.output);
      const template = job.template || "custom";
      const outputGroups = groupOutputFilesByTemplate(outputs, TEMPLATES[template]?.outputGroups);

      // Validate required outputs for submit runs
      let validation = null;
      if (isSubmitRun(job, template)) {
        validation = await validateRequiredOutputs(job, template, job.run?.options?.mode);
      }

      push(jobId, "push", {
        status: job.status,
        jobId,
        ...currentDetail,
        outputs,
        outputGroups,
        validation,
      });

      // Clean up client after final push
      for (const [clientId, client] of clients) {
        if (client.jobId === jobId) {
          clients.delete(clientId);
        }
      }
      return;
    }

    push(jobId, "push", { status: "info", jobId, ...currentDetail });
  }

  // Timeout
  push(jobId, "push", { status: "done", jobId });
}

async function executionDetail(job, logs, readProgress) {
  const latestRun = job.run;
  const progress = readProgress ? await readProgress(job).catch(() => "") : "";
  const stdout = latestRun?.stdout ? await fsp.readFile(latestRun.stdout, "utf8").catch(() => "") : "";
  const stderr = latestRun?.stderr ? await fsp.readFile(latestRun.stderr, "utf8").catch(() => "") : "";
  const events = latestRun
    ? parseExecutionEvents(
        stdout,
        stderr,
        latestRun.adapter ? "adapter" : "",
        job,
        progress,
      )
    : [];
  return {
    run: latestRun,
    status: job.status,
    logs,
    events,
  };
}

function detailSignature(detail) {
  const events = detail.events || [];
  const lastEvent = events[events.length - 1] || {};
  return [
    detail.status || "",
    events.length,
    lastEvent.time || "",
    lastEvent.stage || "",
    lastEvent.status || "",
    lastEvent.label || "",
    detail.logs?.length || 0,
  ].join("\u0000");
}

function subscribe(jobId, res) {
  const clientId = String(++clientsCounter);
  const client = { id: clientId, jobId, res };
  clients.set(clientId, client);
  res.on("close", () => clients.delete(clientId));
  return clientId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  push,
  startPush,
  subscribe,
  executionDetail,
};
