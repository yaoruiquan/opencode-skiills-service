/**
 * Job CRUD operations — create, read, list, update jobs and their files.
 * Extracted from server.js for maintainability.
 */

const path = require("node:path");
const fsp = require("node:fs/promises");

let JOBS_ROOT = "/data/work/jobs";

function configureJobsRoot(root) {
  JOBS_ROOT = root;
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
  if (!value || typeof value !== "string") throw new Error("filename is required");
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.includes("\0") || normalized.split("/").includes("..")) throw new Error("invalid relative path");
  return normalized;
}

function safeJoin(root, relativePath) {
  const target = path.resolve(root, safeRelativePath(relativePath));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) throw new Error("path escapes job directory");
  return target;
}

function now() {
  return new Date().toISOString();
}

function isActiveStatus(status) {
  return status === "running" || status === "retrying";
}

function isCanceled(job) {
  return job.status === "canceled";
}

function isSubmitRun(job, template) {
  if (job.run?.adapter) return false;
  if (!template || template === "custom") return false;
  return true;
}

async function ensureJobDirs(paths) {
  await fsp.mkdir(paths.input, { recursive: true });
  await fsp.mkdir(paths.output, { recursive: true });
  await fsp.mkdir(paths.logs, { recursive: true });
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

async function createJob(body, template) {
  const id = `job_${require("node:crypto").randomUUID().replaceAll("-", "")}`;
  const paths = jobPaths(id);
  await ensureJobDirs(paths);
  const createdAt = now();
  const job = {
    id,
    type: body.type || template,
    template,
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

async function deleteJob(id) {
  assertJobId(id);
  const job = await readJob(id);
  if (job.status === "running" || job.status === "retrying") {
    throw new Error("running job cannot be deleted");
  }
  await fsp.rm(job.paths.root, { recursive: true, force: true });
  return { deleted: true, id };
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
  return { path: relativePath, size: data.length };
}

async function hasInputFiles(job) {
  try {
    const entries = await fsp.readdir(job.paths.input);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function ensureTemplateInputs(job, template, TEMPLATES) {
  const definition = TEMPLATES[template];
  if (!definition?.requiredInputs) return;
  for (const relativePath of definition.requiredInputs) {
    const target = safeJoin(job.paths.input, relativePath);
    try {
      await fsp.access(target);
    } catch {
      throw new Error(`template ${template} requires input/${relativePath}`);
    }
  }
}

async function readLogs(job) {
  const logsDir = job.paths.logs;
  try {
    const entries = await fsp.readdir(logsDir);
    const files = [];
    for (const name of entries) {
      const filePath = path.join(logsDir, name);
      const stat = await fsp.stat(filePath);
      files.push({ name, size: stat.size, mtime: stat.mtime.toISOString() });
    }
    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return files;
  } catch {
    return [];
  }
}

async function listFiles(root) {
  const results = [];
  async function walk(dir, relativePath) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else {
        try {
          const stat = await fsp.stat(full);
          results.push({ path: rel, size: stat.size, mtime: stat.mtime.toISOString() });
        } catch {
          // skip inaccessible files
        }
      }
    }
  }
  await walk(root, "");
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

module.exports = {
  configureJobsRoot,
  jobPaths,
  assertJobId,
  safeRelativePath,
  safeJoin,
  now,
  isActiveStatus,
  isCanceled,
  isSubmitRun,
  ensureJobDirs,
  readJob,
  writeJob,
  createJob,
  deleteJob,
  listJobs,
  writeInputFile,
  hasInputFiles,
  ensureTemplateInputs,
  readLogs,
  listFiles,
};
