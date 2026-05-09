/**
 * Deterministic adapter for phase2-cnnvd-report.
 *
 * submit=false → directly run prepare_form_context.py (no LLM needed)
 * submit=true  → return null to fall through to OpenCode prompt path
 */

const path = require("node:path");
const fsp = require("node:fs/promises");
const { appendProgress, findMaterialTarget, runPython, readServiceConfig, writeAdapterLog } = require("./runner.js");

const SKILL_NAME = "phase2-cnnvd-report";
const SCRIPT = "scripts/prepare_form_context.py";

async function run(job, body, mode, context = {}) {
  const config = await readServiceConfig(job.paths);
  const serviceConfig = config.serviceConfig || {};

  if (serviceConfig.submit === true) {
    await appendProgress(job.paths, {
      stage: "browser",
      status: "running",
      label: "进入浏览器上报流程",
      detail: "submit=true，切换到 OpenCode 执行登录、填表、验证码和提交。",
    });
    await writeAdapterLog(job.paths, [
      `adapter: ${SKILL_NAME}`,
      `submit=true: falling through to OpenCode prompt for browser phase`,
    ]);
    return null;
  }

  const target = await findMaterialTarget(job.paths.input, serviceConfig);
  if (!target) {
    const error = "未找到目标材料：请上传 DAS-* 目录或在配置中指定 das_id / target_path。";
    await appendProgress(job.paths, { stage: "form_context", status: "failed", label: "准备表单上下文失败", detail: error });
    await writeAdapterLog(job.paths, [`ERROR: ${error}`]);
    return { success: false, error, stdout: "", stderr: error };
  }

  const outputContext = path.join(job.paths.output, "form_context.json");
  const args = [
    SCRIPT,
    target,
    "--data-dir", path.join(job.paths.input, "materials"),
    "--output", outputContext,
  ];
  if (serviceConfig.entity_description) {
    args.push("--entity-description", serviceConfig.entity_description);
  }
  if (serviceConfig.verification) {
    args.push("--verification", serviceConfig.verification);
  }

  await writeAdapterLog(job.paths, [
    `adapter: ${SKILL_NAME}`,
    `mode: ${mode || "single"}`,
    `target: ${target}`,
    `submit: false (deterministic adapter)`,
    `command: python3 ${args.join(" ")}`,
  ]);
  await appendProgress(job.paths, { stage: "form_context", status: "running", label: "准备表单上下文", detail: path.basename(target) });

  const result = await runPython(SKILL_NAME, args, {
    timeoutMs: 60_000,
    onChild: context.registerChild,
    onClose: context.unregisterChild,
  });
  await appendProgress(job.paths, {
    stage: "form_context",
    status: result.exitCode === 0 ? "done" : "failed",
    label: result.exitCode === 0 ? "表单上下文已生成" : "表单上下文生成失败",
    detail: result.exitCode === 0 ? "submit=false，未进入浏览器提交阶段。" : `退出码 ${result.exitCode}`,
  });

  const summaryLines = [
    `# ${SKILL_NAME} adapter summary`,
    "",
    `- mode: ${mode || "single"}`,
    `- target: ${target}`,
    `- submit: false`,
    `- exit_code: ${result.exitCode}`,
    "",
    result.exitCode === 0
      ? `form_context.json 已生成。submit=false，未进入浏览器提交阶段。`
      : `prepare_form_context.py 执行失败 (exit ${result.exitCode})。`,
  ];
  if (result.stderr) summaryLines.push("", "## stderr", "", result.stderr);
  await fsp.writeFile(path.join(job.paths.output, "summary.txt"), summaryLines.join("\n") + "\n", "utf8");

  if (result.stdout) await fsp.appendFile(path.join(job.paths.logs, "run.jsonl"), result.stdout, "utf8");
  if (result.stderr) await fsp.appendFile(path.join(job.paths.logs, "stderr.log"), result.stderr, "utf8");

  await writeAdapterLog(job.paths, [`exit_code: ${result.exitCode}`, `output: ${outputContext}`]);

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `prepare_form_context.py exited with code ${result.exitCode}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return { success: true, stdout: result.stdout, stderr: result.stderr };
}

module.exports = { run, SKILL_NAME };
