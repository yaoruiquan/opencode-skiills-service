/**
 * Deterministic adapter for phase1-material-processor.
 *
 * Directly calls `python3 scripts/test_material.py` instead of going through
 * OpenCode.  The LLM is not needed for this scripted workflow.
 *
 * Modes:
 *   - batch: process all DAS-* in materials dir, rename batch folder, modify docx
 *   - list:  list vuln dirs and their processing status
 *   - single: process a single DAS-ID
 */

const path = require("node:path");
const fsp = require("node:fs/promises");
const { runPython, readServiceConfig, writeAdapterLog } = require("./runner.js");

const SKILL_NAME = "phase1-material-processor";
const SCRIPT = "scripts/test_material.py";

/**
 * Find the batch directory inside job input/materials.
 * Priority: serviceConfig.batch_dir > first directory containing DAS-* subdirs.
 */
async function findBatchDir(inputDir, serviceConfig) {
  const materialsDir = path.join(inputDir, "materials");

  // Explicit batch_dir from config
  if (serviceConfig.batch_dir) {
    const candidate = path.join(materialsDir, serviceConfig.batch_dir);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // fall through
    }
  }

  // Auto-detect: first directory containing DAS-* subdirs
  try {
    const entries = await fsp.readdir(materialsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(materialsDir, entry.name);
      const subEntries = await fsp.readdir(subDir).catch(() => []);
      if (subEntries.some((name) => name.startsWith("DAS-"))) {
        return subDir;
      }
    }
  } catch {
    // materialsDir doesn't exist
  }

  // Fall back to materialsDir itself if it has DAS-* dirs
  try {
    const entries = await fsp.readdir(materialsDir);
    if (entries.some((name) => name.startsWith("DAS-"))) {
      return materialsDir;
    }
  } catch {
    // no materials
  }

  return null;
}

/**
 * Run the phase1-material-processor adapter.
 *
 * @param {object} job      - the job object (with .paths, .id, etc.)
 * @param {object} body     - the POST /run request body
 * @param {string} mode     - "batch", "list", or a DAS-ID for single mode
 * @returns {Promise<{success: boolean, error?: string, stdout: string, stderr: string}>}
 */
async function run(job, body, mode, context = {}) {
  const config = await readServiceConfig(job.paths);
  const serviceConfig = config.serviceConfig || {};
  const action = mode || "batch";

  const batchDir = await findBatchDir(job.paths.input, serviceConfig);
  if (!batchDir && action !== "list") {
    const error = "未找到批次目录：请上传包含 DAS-* 子目录的材料目录，或在配置中指定 batch_dir。";
    await writeAdapterLog(job.paths, [`ERROR: ${error}`]);
    return { success: false, error, stdout: "", stderr: error };
  }

  const args = [SCRIPT];

  if (batchDir) {
    args.push("--dir", batchDir);
  } else {
    // list mode without materials
    args.push("--dir", path.join(job.paths.input, "materials"));
  }

  // Service-mode output flags
  args.push("--output-root", job.paths.output);
  args.push("--summary", path.join(job.paths.output, "summary.txt"));
  args.push("--json", path.join(job.paths.output, "material-result.json"));

  // The action/DAS-ID
  args.push(action);

  // Optional submitter
  if (serviceConfig.submitter) {
    args.push(serviceConfig.submitter);
  }

  await writeAdapterLog(job.paths, [
    `adapter: ${SKILL_NAME}`,
    `mode: ${action}`,
    `batch_dir: ${batchDir || "(none)"}`,
    `command: python3 ${args.join(" ")}`,
  ]);

  const result = await runPython(SKILL_NAME, args, {
    cwd: batchDir || job.paths.input,
    timeoutMs: 120_000,
    onChild: context.registerChild,
    onClose: context.unregisterChild,
  });

  await writeAdapterLog(job.paths, [
    `exit_code: ${result.exitCode}`,
    `stdout_length: ${result.stdout.length}`,
    `stderr_length: ${result.stderr.length}`,
  ]);

  // Write stdout/stderr to job logs for consistency
  if (result.stdout) {
    await fsp.appendFile(path.join(job.paths.logs, "run.jsonl"), result.stdout, "utf8");
  }
  if (result.stderr) {
    await fsp.appendFile(path.join(job.paths.logs, "stderr.log"), result.stderr, "utf8");
  }

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `test_material.py exited with code ${result.exitCode}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return { success: true, stdout: result.stdout, stderr: result.stderr };
}

module.exports = { run, SKILL_NAME };
