/**
 * SSE push notifications for job progress.
 * Extracted from server.js for maintainability.
 */

const { isSubmitRun } = require("./jobs-crud.js");

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

async function startPush(jobId, { readJob, readLogs, parseExecutionEvents, listFiles, parseProgressEvents, groupOutputFilesByTemplate, validateRequiredOutputs, TEMPLATES }) {
  push(jobId, "push", { status: "started", jobId });

  let job;
  try {
    job = await readJob(jobId);
  } catch {
    push(jobId, "push", { status: "done" });
    return;
  }

  // Initial push with job state
  const detail = executionDetail(job, await readLogs(job));
  push(jobId, "push", { status: "info", jobId, ...detail });

  // Poll for changes
  const deadlineMs = 30 * 60_000;
  const started = Date.now();
  let lastUpdated = job.updatedAt;

  while (Date.now() - started < deadlineMs) {
    await sleep(3000);
    try {
      job = await readJob(jobId);
    } catch {
      push(jobId, "push", { status: "done" });
      return;
    }

    if (job.updatedAt === lastUpdated) continue;
    lastUpdated = job.updatedAt;

    const terminalStates = ["completed", "failed", "canceled"];
    const isTerminal = terminalStates.includes(job.status);
    const logs = await readLogs(job);

    if (isTerminal) {
      // Final push with all data
      const finalDetail = executionDetail(job, logs);
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
        ...finalDetail,
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

    push(jobId, "push", { status: "info", jobId, ...executionDetail(job, logs) });
  }

  // Timeout
  push(jobId, "push", { status: "done", jobId });
}

function executionDetail(job, logs) {
  const latestRun = job.run;
  const events = latestRun
    ? parseExecutionEvents(
        latestRun.stdout || "",
        latestRun.stderr || "",
        latestRun.adapter ? "adapter" : "",
        job,
        job.paths.logs,
      )
    : [];
  return {
    run: latestRun,
    status: job.status,
    logs,
    events,
  };
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
