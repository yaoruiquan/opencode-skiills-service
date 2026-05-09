/**
 * Adapter runner — shared utilities for deterministic skill adapters.
 *
 * An adapter directly spawns a Python script from the skill directory instead
 * of going through the OpenCode LLM.  This gives deterministic outcomes for
 * scripted workflows (prepare_form_context, test_material, …).
 *
 * Adapters are optional: if a template does not have an adapter, the original
 * OpenCode prompt path is used.
 */

const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SKILL_ROOT = process.env.SKILLS_API_SKILL_ROOT || "/root/.agents/skills";

/**
 * Spawn a Python3 command inside the skill directory and capture stdout/stderr.
 *
 * @param {string} skillName    - e.g. "phase1-material-processor"
 * @param {string[]} args       - arguments to pass to python3
 * @param {object} options
 * @param {string} options.cwd  - override working directory (default: skill dir)
 * @param {number} options.timeoutMs - kill after this many ms (default: 300_000)
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
function runPython(skillName, args, options = {}) {
  const skillDir = path.join(SKILL_ROOT, skillName);
  const cwd = options.cwd || skillDir;
  const timeoutMs = options.timeoutMs || 300_000;

  return new Promise((resolve) => {
    // Resolve script path relative to skill dir if not absolute
    const resolvedArgs = [...args];
    if (resolvedArgs.length > 0 && !path.isAbsolute(resolvedArgs[0])) {
      resolvedArgs[0] = path.join(skillDir, resolvedArgs[0]);
    }

    const child = spawn("python3", resolvedArgs, {
      cwd,
      env: {
        ...process.env,
        PYTHONPATH: path.join(skillDir, "scripts"),
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    options.onChild?.(child);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      options.onClose?.(child);
      stderr += error.message;
      resolve({ exitCode: 1, stdout, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      options.onClose?.(child);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Read the service-config.json that the API layer wrote into the job input dir.
 */
async function readServiceConfig(jobPaths) {
  const configPath = path.join(jobPaths.input, "service-config.json");
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Write adapter-level execution log into the job logs dir.
 */
async function writeAdapterLog(jobPaths, lines) {
  const logPath = path.join(jobPaths.logs, "adapter.log");
  const content = lines.map((line) => `[${new Date().toISOString()}] ${line}`).join("\n") + "\n";
  await fsp.appendFile(logPath, content, "utf8");
}

async function appendProgress(jobPaths, event) {
  const logPath = path.join(jobPaths.logs, "progress.jsonl");
  const payload = {
    status: "info",
    ...event,
    time: event.time || new Date().toISOString(),
  };
  await fsp.appendFile(logPath, JSON.stringify(payload) + "\n", "utf8");
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function findFirstDasPath(root, dasId = "") {
  const queue = [root];
  const normalizedDasId = String(dasId || "").trim();

  while (queue.length) {
    const current = queue.shift();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const isMatch = normalizedDasId
        ? entry.name.startsWith(normalizedDasId)
        : entry.name.startsWith("DAS-");
      if (isMatch) {
        return full;
      }
      if (entry.isDirectory()) {
        queue.push(full);
      }
    }
  }

  return null;
}

async function findMaterialTarget(inputDir, serviceConfig = {}) {
  const materialsDir = path.join(inputDir, "materials");

  if (serviceConfig.target_path) {
    const relative = String(serviceConfig.target_path).replaceAll("\\", "/").replace(/^\/+/, "");
    const candidates = [
      path.join(inputDir, relative),
      path.join(materialsDir, relative),
    ];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  if (serviceConfig.das_id) {
    const match = await findFirstDasPath(materialsDir, serviceConfig.das_id);
    if (match) return match;
  }

  return findFirstDasPath(materialsDir);
}

/**
 * Check whether an adapter exists for a given template and mode combination.
 * Returns null if no adapter is available (fall through to OpenCode prompt).
 */
function getAdapter(template) {
  try {
    return require(`./${template}.js`);
  } catch {
    return null;
  }
}

module.exports = {
  SKILL_ROOT,
  getAdapter,
  findMaterialTarget,
  readServiceConfig,
  runPython,
  appendProgress,
  writeAdapterLog,
};
