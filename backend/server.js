const http = require("node:http");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
const SKILL_ROOT = process.env.SKILLS_API_SKILL_ROOT || "/root/.agents/skills";
const ACTIVE_RUNS = new Map();
const CANCEL_MARKER = "cancel-requested.json";
const USE_DETERMINISTIC_ADAPTERS = process.env.SKILLS_API_USE_ADAPTERS === "true";
const SUCCESS_STATUS = "succeeded";
const LEGACY_SUCCESS_STATUS = "completed";
const SUMMARY_FALLBACK_TEMPLATES = new Set([
  "vulnerability-alert-processor",
  "phase2-cnvd-report",
  "phase2-cnnvd-report",
  "phase2-ncc-report",
]);

// ── Module imports ─────────────────────────────────────────────────────────

const templates = require("./templates.js");
const { TEMPLATES, knownTemplate, resolveCreateTemplate, resolveRunTemplate, runMode, runOptions, serviceConfig, taskBrief, requiredOutputsFor } = templates;

const jobsCrud = require("./jobs-crud.js");
const { configureJobsRoot, jobPaths, assertJobId, safeRelativePath, safeJoin, now, isActiveStatus, ensureJobDirs, readJob, writeJob, createJob, deleteJob, listJobs, writeInputFile, hasInputFiles, ensureTemplateInputs, readLogs, listFiles } = jobsCrud;

const humanInput = require("./human-input.js");
const { maskHumanInputValue, redactSensitiveText, readHumanInput, writeHumanInput, listHumanActions } = humanInput;

const output = require("./output.js");
const { parseExecutionEvents: parseExecutionEventsRaw, parseProgressEvents, validateRequiredOutputs: inspectRequiredOutputs, matchesOutputPattern, groupOutputFilesByTemplate, readProgress } = output;

const pushModule = require("./push.js");
const { push, subscribe } = pushModule;

const executor = require("./executor.js");
const { tryLoadAdapter, stopActiveChild, runOpenCodeAttempt, isCapacityError, buildAttemptPlan } = executor;

// ── Configure shared state ─────────────────────────────────────────────────

configureJobsRoot(JOBS_ROOT);

function startPush(jobId) {
  return pushModule.startPush(jobId, {
    readJob,
    readLogs: (job) => readLogs(job),
    readProgress,
    parseExecutionEvents,
    listFiles,
    parseProgressEvents,
    groupOutputFilesByTemplate,
    validateRequiredOutputs: (job, template, mode) => validateRequiredOutputsReport(job, template, mode),
    TEMPLATES,
  });
}

// ── HTTP utilities ─────────────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function binary(res, status, data, contentType = "application/octet-stream") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function notFound(res) { json(res, 404, { error: "not_found" }); }
function badRequest(res, message) { json(res, 400, { error: message }); }
function serverError(res, error) { json(res, 500, { error: error?.message || "internal error" }); }

function contentTypeFor(filePath) {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".pdf")) return "application/pdf";
  if (filePath.endsWith(".json") || filePath.endsWith(".jsonl")) return "application/json";
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".md")) return "text/markdown";
  if (filePath.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function decodePathSegments(segments) {
  try { return segments.map((segment) => decodeURIComponent(segment)).join("/"); }
  catch { throw new Error("invalid encoded path"); }
}

function contentDispositionAttachment(filename) {
  const safeName = filename.replaceAll('"', "").replaceAll("\\", "").replace(/[^\x20-\x7E]/g, "_");
  const fallbackName = safeName && safeName !== "." && safeName !== ".." ? safeName : "download";
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function statusLabel(status) {
  const labels = {
    created: "已创建",
    running: "运行中",
    retrying: "重试中",
    succeeded: "已完成",
    completed: "已完成",
    failed: "已失败",
    canceled: "已中断",
  };
  return labels[status] || status || "未知";
}

function normalizeJobStatus(status) {
  return status === LEGACY_SUCCESS_STATUS ? SUCCESS_STATUS : status;
}

function isSuccessStatus(status) {
  return status === SUCCESS_STATUS || status === LEGACY_SUCCESS_STATUS;
}

function outputPath(pattern) {
  return `output/${pattern}`;
}

function shouldRequireSubmissionResult(job, template) {
  const definition = TEMPLATES[template];
  if (definition?.outputCategory !== "submission") return false;
  return job?.run?.options?.serviceConfig?.submit === true || job?.run?.options?.submit === true;
}

function platformIdFromSubmissionResult(result = {}) {
  return result.cnvd_id || result.cnvdId ||
    result.cnnvd_id || result.cnnvdId ||
    result.ncc_id || result.nccId ||
    result.platform_id || result.platformId ||
    result.submission_id || result.submissionId || "";
}

function isSuccessfulSubmissionResult(result = {}) {
  const status = String(result.status || result.result || "").toLowerCase();
  const success = result.success === true ||
    result.submitted === true ||
    ["success", "submitted", "completed", "ok", "待研判", "待披露"].includes(status);
  return success && Boolean(platformIdFromSubmissionResult(result));
}

async function readSubmissionResult(job) {
  try {
    const target = path.join(job.paths.output, "submission-result.json");
    return JSON.parse(await fsp.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

async function effectiveJobState(job) {
  const result = await readSubmissionResult(job);
  if (result && isSuccessfulSubmissionResult(result)) {
    return {
      effectiveStatus: "submitted",
      effectiveStatusLabel: "平台已提交",
      platformId: platformIdFromSubmissionResult(result),
      submissionResult: result,
    };
  }
  return {
    effectiveStatus: normalizeJobStatus(job.status),
    effectiveStatusLabel: statusLabel(normalizeJobStatus(job.status)),
    platformId: "",
    submissionResult: result,
  };
}

function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (typeof value === "string") return redactSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|secret|token|webhook|email|username/i.test(key)) {
      result[key] = item ? "[REDACTED]" : item;
    } else {
      result[key] = redactObject(item);
    }
  }
  return result;
}

function jobForResponse(job) {
  const normalized = { ...job };
  if (normalized.status) normalized.status = normalizeJobStatus(normalized.status);
  if (normalized.effectiveStatus) normalized.effectiveStatus = normalizeJobStatus(normalized.effectiveStatus);
  return redactObject(normalized);
}

async function jobForResponseWithEffectiveState(job) {
  return jobForResponse({
    ...job,
    ...(await effectiveJobState(job)),
  });
}

async function validateRequiredOutputsReport(job, template, mode = "") {
  const report = await inspectRequiredOutputs(job, template, mode, TEMPLATES);
  if (!report) {
    return { required: [], missing: [], found: [], ok: true };
  }

  const submissionResult = await readSubmissionResult(job);
  if (submissionResult && isSuccessfulSubmissionResult(submissionResult)) {
    return {
      ...report,
      required: ["submission-result.json"],
      missing: [],
      ok: true,
      successResult: submissionResult,
    };
  }

  const required = [...report.required];
  const missing = [...report.missing];
  const files = await listFiles(job.paths.output);

  if (shouldRequireSubmissionResult(job, template)) {
    required.push("submission-result.json");
    if (!files.some((file) => matchesOutputPattern(file.path, "submission-result.json"))) {
      missing.push("submission-result.json");
    }
  }

  return {
    ...report,
    required,
    missing,
    ok: missing.length === 0,
  };
}

async function validateRequiredOutputs(job, template, mode = "") {
  const report = await validateRequiredOutputsReport(job, template, mode);
  if (!report.ok) {
    throw new Error(
      `template ${template} missing required outputs: ${report.missing.map(outputPath).join(", ")}`,
    );
  }
  return report;
}

async function writeFallbackSummary(job, template, {
  outcome = "failed",
  error = "",
  mode = "",
  force = false,
} = {}) {
  if (!SUMMARY_FALLBACK_TEMPLATES.has(template)) return false;

  const summaryPath = path.join(job.paths.output, "summary.txt");
  try {
    await fsp.access(summaryPath);
    return false;
  } catch {
    // Missing summary.txt is the only case this helper handles.
  }

  if (!force) {
    const report = await validateRequiredOutputsReport(job, template, mode);
    const missing = report?.missing || [];
    if (missing.length !== 1 || missing[0] !== "summary.txt") return false;
  }

  const files = await listFiles(job.paths.output).catch(() => []);
  const progress = parseProgressEvents(await readProgress(job).catch(() => ""));
  const recentProgress = progress.slice(-5);
  const lines = [
    "# 执行摘要",
    "",
    `- job: ${job.id}`,
    `- template: ${template}`,
    `- mode: ${mode || job.run?.options?.mode || ""}`,
    `- status: ${outcome}`,
    `- generated_by: skills-api fallback`,
    `- generated_at: ${now()}`,
  ];

  if (error) lines.push(`- error: ${redactSensitiveText(error)}`);

  lines.push("", "## 输出文件");
  if (files.length) {
    for (const file of files) {
      lines.push(`- ${file.path} (${file.size} bytes)`);
    }
  } else {
    lines.push("- 无输出文件");
  }

  if (recentProgress.length) {
    lines.push("", "## 最近进度");
    for (const event of recentProgress) {
      const label = event.label || event.stage || "progress";
      const detail = event.detail || "";
      lines.push(`- [${event.status || "info"}] ${label}${detail ? `: ${detail}` : ""}`);
    }
  }

  await fsp.writeFile(summaryPath, lines.join("\n") + "\n", "utf8");
  return true;
}

async function outputFilesForJob(job) {
  const files = await listFiles(job.paths.output);
  const groups = groupOutputFilesByTemplate(files, TEMPLATES[job.template]?.outputGroups || []);
  return files.map((file) => {
    const group = groups.find((item) => item.files.some((candidate) => candidate.path === file.path));
    return {
      ...file,
      name: path.basename(file.path),
      group: group?.label || "其他文件",
    };
  });
}

async function createOutputArchive(job) {
  const files = await listFiles(job.paths.output);
  if (!files.length) throw new Error("no output files to archive");

  const archivePath = path.join(job.paths.logs, `${job.id}-outputs.zip`);
  await new Promise((resolve, reject) => {
    const child = spawn("zip", ["-qr", archivePath, "."], {
      cwd: job.paths.output,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `zip exited with code ${code}`));
    });
  });
  return fsp.readFile(archivePath);
}

function parseExecutionEvents(stdout = "", stderr = "", adapter = "", job = {}, progress = "") {
  const events = parseExecutionEventsRaw(stdout, stderr, adapter, job, progress);
  for (const line of stdout.split("\n").filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      if (item.type === "attempt_start") {
        events.push({
          time: item.timestamp || item.time || new Date().toISOString(),
          type: "attempt",
          label: `第 ${item.attempt} 次模型尝试`,
          detail: item.model || "",
          status: "running",
        });
      }
      const part = item.part || {};
      if (item.type === "tool_use" && String(part.tool || "").includes("chrome-devtools")) {
        const failed = /ECONNREFUSED|Could not connect|error/i.test(String(part.state?.output || ""));
        events.push({
          time: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(),
          type: "tool",
          label: "浏览器 MCP 操作",
          detail: String(part.state?.output || part.tool || ""),
          status: failed ? "failed" : "done",
        });
      }
    } catch {
      // Ignore non-JSON OpenCode lines.
    }
  }

  if (/missing required outputs/i.test(stderr)) {
    events.push({
      time: job?.run?.finishedAt || new Date().toISOString(),
      type: "validation",
      label: "输出文件校验失败",
      detail: stderr.trim(),
      status: "failed",
    });
  }

  if (job?.status) {
    events.push({
      time: job?.run?.finishedAt || job?.updatedAt || new Date().toISOString(),
      type: "status",
      label: statusLabel(job.status),
      detail: job?.run?.error || "",
      status: job.status === "failed" ? "failed" : isSuccessStatus(job.status) ? "done" : "running",
    });
  }

  return sanitizeExecutionEvents(events);
}

function sanitizeExecutionEvents(events) {
  return events.map((event) => ({
    ...event,
    label: typeof event.label === "string" ? redactSensitiveText(event.label) : event.label,
    detail: typeof event.detail === "string" ? redactSensitiveText(event.detail) : event.detail,
  }));
}

// ── Prompt helpers ─────────────────────────────────────────────────────────

function defaultPrompt(job) {
  return `请根据输入目录中的材料，完成任务。\n\n输入目录：${job.paths.input}\n输出目录：${job.paths.output}\n日志目录：${job.paths.logs}`;
}

function md2wechatPrompt(job) {
  const articlePath = path.join(job.paths.input, "article.md");
  const htmlPath = path.join(job.paths.output, "wechat-article.html");
  const coverPath = path.join(job.paths.output, "wechat-cover.png");
  const htmlLogPath = path.join(job.paths.logs, "render_wechat_article.json");
  const coverLogPath = path.join(job.paths.logs, "render_alert_cover.json");
  const skillDir = path.join(SKILL_ROOT, "md2wechat");

  return [
    "请严格使用 md2wechat skill 完成本地生成流程，不要上传公众号草稿箱，不要打开浏览器。",
    "",
    "固定路径：",
    `- skill 目录：${skillDir}`,
    `- 输入 Markdown：${articlePath}`,
    `- 输出 HTML：${htmlPath}`,
    `- 输出封面：${coverPath}`,
    `- HTML 生成日志：${htmlLogPath}`,
    `- 封面生成日志：${coverLogPath}`,
    "",
    "执行要求：",
    `1. 读取 ${articlePath} 获取文章内容`,
    "2. 调用 scripts/render_wechat_article.py 生成公众号正文 HTML",
    "3. 调用 scripts/render_alert_cover.py 生成预警封面图",
    `4. HTML 写入 ${htmlPath}，封面写入 ${coverPath}`,
    `5. 关键脚本结果分别记录到 ${htmlLogPath} 和 ${coverLogPath}`,
    '4. 完成后在输出目录写入 summary.txt，包含文件列表和生成状态',
  ].join("\n");
}

function progressInstructions(job, template, definition) {
  const progressPath = path.join(job.paths.logs, "progress.jsonl");
  const stages = progressStagesFor(template, definition);
  return [
    "执行进度记录要求：",
    `- 必须把业务阶段实时追加到 ${progressPath}，每行一个 JSON 对象。`,
    '- 字段格式：{"time":"ISO 时间","stage":"阶段","status":"running|done|failed|warning","label":"中文阶段名","detail":"简短说明"}',
    "- 每进入一个阶段先写 status=running，完成后写 status=done，遇到阻塞或失败写 warning/failed。",
    "- 这些进度会直接显示在前端，请不要只在最终 summary 里描述。",
    `- 推荐阶段顺序：${stages.join(" -> ")}`,
    "",
  ].join("\n");
}

function progressStagesFor(template, definition = {}) {
  if (Array.isArray(definition.stateMachine) && definition.stateMachine.length) {
    return definition.stateMachine;
  }
  if (definition.outputCategory === "submission") {
    return [
      "prepare",
      "form_context",
      "browser",
      "login",
      "cloudflare",
      "captcha",
      "fill_form",
      "upload",
      "submit",
      "extract_id",
      "summary",
    ];
  }
  const stagesByTemplate = {
    "vulnerability-alert-processor": ["prepare", "research", "login", "download_template", "render", "export", "summary"],
    "phase1-material-processor": ["prepare", "scan_materials", "process_docx", "summary"],
    "msrc-vulnerability-report": ["prepare", "parse_materials", "render", "export", "summary"],
    "cnvd-weekly-db-update": ["prepare", "check_remote", "upload_xml", "update_db", "summary"],
  };
  return stagesByTemplate[template] || ["prepare", "run_skill", "summary"];
}

function serviceContractInstructions(template, definition = {}) {
  const contract = definition.serviceContract;
  if (!contract) return "";
  const lines = [
    "服务化执行契约：",
    "- 默认执行路径是 OpenCode + skills；adapter 只作为 legacy，不要主动切换 adapter 思路。",
    "- 固定目录：只能从 input/ 读取任务输入，只能向 output/ 写最终产物，只能向 logs/ 写日志和截图。",
    "- 固定配置：input/service-config.json 由 skills-api 生成，禁止重写、覆盖或伪造。",
    "- 固定进度：每个状态机阶段都必须写 logs/progress.jsonl。",
    `- 状态机：${(definition.stateMachine || contract.requiredProgress || []).join(" -> ")}`,
    `- 成功输出：output/${contract.successOutput || "summary.txt"}`,
    `- 失败输出：output/${contract.failureOutput || "summary.txt"}`,
  ];
  if (contract.successFields?.length) {
    lines.push(`- 成功字段：${contract.successFields.join(", ")}`);
  }
  if (contract.browserProfile) {
    lines.push(`- Docker Chrome profile：${contract.browserProfile}；不要假设 macOS 本机 Chrome 登录态存在。`);
  }
  if (contract.captchaPolicy) {
    lines.push(`- 验证码策略：${contract.captchaPolicy}`);
  }
  if (template === "phase2-cnvd-report") {
    lines.push(
      "- CNVD 成功判定：只要平台页面或结果文件出现 CNVD-C-YYYY-NNNNNN 和 submission_url，即使后续 job 被取消，也必须保留 output/submission-result.json 的成功状态。",
    );
  }
  return lines.join("\n") + "\n";
}

function promptConfigForDisplay(configService) {
  if (!Object.keys(configService).length) return {};
  return redactObject(configService);
}

function verificationInstructions(job, template) {
  if (template === "phase2-cnvd-report") {
    return [
      "验证码处理规则：",
      "- CNVD 防火墙/WAF 访问验证码不要直接切换人工；识别特征包括页面标题或正文出现“本站开启了验证码保护”“请输入验证码，以继续访问”“防火墙”“WAF”。",
      "- 遇到 CNVD 防火墙/WAF 访问验证码时，先用 OCR 自动识别，最多尝试 3 次。每次必须截取真实验证码 img 元素本体到 /tmp/cnvd-waf-captcha-<attempt>.png，再调用 skill 内 scripts/captcha_ocr.py --preprocess cnvd 识别。",
      "- 每次 OCR 尝试前保存当前防火墙页截图到 logs/human-cnvd-firewall.png 或 logs/human-cnvd-firewall-<attempt>.png，并追加进度：{\"stage\":\"captcha\",\"status\":\"running\",\"label\":\"防火墙验证码 OCR 尝试 1/3\",\"detail\":\"正在识别 CNVD 防火墙验证码。\"}，attempt 按实际次数递增。",
      "- OCR 结果为空、以 ERROR 开头、包含“看不清/点击更换/存在/二进制/验证码”等页面文字，或提交后仍停留在“本站开启了验证码保护/请输入验证码，以继续访问/验证码已过期”页面，都算本次 OCR 未通过，必须刷新/换一张后重试，不复用旧验证码和旧结果。",
      "- 3 次 OCR 仍未通过、无法取得真实验证码 img、验证码图片加载失败，或页面只剩占位文字时，才切换前端人工处理。",
      "- CNVD 登录验证码、提交验证码仍必须优先调用 skill 内 scripts/captcha_ocr.py 识别，不要因为普通登录/提交验证码就等待前端人工。",
      "- 其他平台或其他验证码不要切换前端人工，继续按对应 skill 的脚本和说明处理。",
      '- 切换人工时追加进度：{"stage":"captcha","status":"warning","label":"等待人工防火墙验证码","detail":"OCR 已尝试 3 次仍未通过，截图已保存至 logs/human-cnvd-firewall.png，请在前端输入验证码。"}',
      "- 如果 phase2-cnvd-report 的 browser_helpers.open_captcha_tab_command 返回 CNVD_CAPTCHA_IMAGE_BROKEN，说明 /common/myCodeNew 被防火墙验证码拦截或提交验证码图片加载失败；先按防火墙验证码 OCR 规则尝试识别当前 WAF 页面验证码，最多 3 次，仍未通过再前端人工。",
      "- 如果 submit-captcha 返回 INVALID_OCR_TEXT，说明 OCR 识别到了页面占位文字，禁止提交该值，必须重新获取真实验证码或进入防火墙人工处理。",
      "- 禁止在 OpenCode 回复中只询问用户如何处理后就退出；必须留在任务内等待 input/human-input.json。",
      '- 写入进度后暂停轮询 input/human-input.json；不要创建空的占位 human-input.json；每 3 秒检查一次，至少等待 10 分钟。',
      '- 只有读到 status="submitted" 且 value/code/text/captcha_value 任一字段非空，才认为前端已提交验证码。',
      "- 读到验证码后填入防火墙验证码输入框并提交，然后继续原 skill 上报流程。",
      "- 如果等待超时或无法继续，必须写入 output/summary.txt，说明正在等待/已等待人工防火墙验证码、截图路径和失败原因。",
      "",
    ].join("\n");
  }

  if (TEMPLATES[template]?.outputCategory === "submission") {
    return [
      "验证码处理规则：",
      "- 本任务验证码默认按 skill 中的脚本和说明自动处理，例如 captcha_ocr.py 或平台专用验证码流程。",
      "- 不要把普通登录验证码、提交验证码切换为前端人工处理，除非 skill 明确要求人工。",
      "",
    ].join("\n");
  }

  return "";
}

function browserUrlForTemplate(template, definition) {
  const envByTemplate = {
    "phase2-cnvd-report": ["CHROME_DEVTOOLS_CNVD_HOST", "CHROME_DEVTOOLS_CNVD_PORT", "browser-cnvd"],
    "phase2-cnnvd-report": ["CHROME_DEVTOOLS_CNNVD_HOST", "CHROME_DEVTOOLS_CNNVD_PORT", "browser-cnnvd"],
    "phase2-ncc-report": ["CHROME_DEVTOOLS_NCC_HOST", "CHROME_DEVTOOLS_NCC_PORT", "browser-ncc"],
  };
  const [hostEnv, portEnv, defaultHost] = envByTemplate[template] || [];
  const host = (hostEnv && process.env[hostEnv]) || defaultHost || "127.0.0.1";
  const port = (portEnv && process.env[portEnv]) || definition.chromePort;
  return `http://${host}:${port}`;
}

function complexSkillPrompt(job, template, body) {
  const definition = TEMPLATES[template];
  if (!definition) return defaultPrompt(job);

  const mode = runMode(template, body);
  const skillName = definition.skill || template;
  const skillDir = path.join(SKILL_ROOT, skillName);
  const configService = serviceConfig(body);
  const options = runOptions(body);

  const parts = [
    `请使用 ${skillName} skill 完成任务。`,
    "",
    `Skill 目录：${skillDir}`,
    `输入目录：${job.paths.input}`,
    `输出目录：${job.paths.output}`,
    `日志目录：${job.paths.logs}`,
    `模式：${mode}`,
    "",
  ];

  parts.push(progressInstructions(job, template, definition));
  const contractText = serviceContractInstructions(template, definition);
  if (contractText) parts.push(contractText);
  const verificationText = verificationInstructions(job, template);
  if (verificationText) parts.push(verificationText);

  if (Object.keys(configService).length > 0) {
    parts.push(
      "配置参数摘要（敏感字段已隐藏）：",
      JSON.stringify(promptConfigForDisplay(configService), null, 2),
      "完整敏感配置请读取 input/service-config.json，不要把密码、token、webhook 写入日志或输出文件。",
      "禁止重写、覆盖或伪造 input/service-config.json；该文件由 skills-api 写入，是账号、密码和运行参数的唯一可信来源。",
      "",
    );
  }

  if (options.taskBrief) {
    parts.push("任务说明：", options.taskBrief, "");
  }

  if (definition.browserMcp) {
    const browserUrl = browserUrlForTemplate(template, definition);
    parts.push(
      `浏览器 MCP：${definition.browserMcp}`,
      `Chrome 调试端口：${definition.chromePort}`,
      `容器内 Chrome DevTools 地址：${browserUrl}`,
      "请使用对应 MCP 通道控制浏览器；不要把 127.0.0.1 当作浏览器地址，除非 service-config 或环境变量明确指定。",
      "",
    );
  }

  if (definition.outputs?.length) {
    parts.push("预期输出：", ...definition.outputs.map((item) => `- output/${item}`), "");
  }

  if (template === "phase1-material-processor") {
    parts.push(
      "请优先执行 scripts/test_material.py 验证材料整理逻辑。",
      "处理后的材料必须写入 output/processed-materials/。",
      "输入材料可能位于 input/materials/DAS-T*/ 或更深层目录。",
      "",
    );
  }

  if (template === "msrc-vulnerability-report") {
    parts.push(
      "请使用 scripts/msrc_main.py 生成报告，再使用 scripts/format_word.py 格式化 Word。",
      "需要生成 report.md、report.docx，并尽量生成 report.pdf。",
      "不要读取 ~/Downloads 或 macOS 绝对路径，所有输入都必须来自当前 job 的 input 目录。",
      "",
    );
  }

  if (template === "vulnerability-alert-processor") {
    parts.push(
      "漏洞预警服务化输出要求：",
      "- 无论任务成功、部分成功还是失败，最后都必须写入 output/summary.txt。",
      "- summary.txt 必须列出已生成文件、缺失文件、是否发布/上传/推送，以及失败原因或人工处理项。",
      "- 不要只写 logs/progress.jsonl；summary.txt 是后端验收和前端失败说明的必需文件。",
      "",
    );
  }

  if (template === "cnvd-weekly-db-update") {
    parts.push(
      "输入要求：CNVD 周库更新只处理上传到 input/xml/ 下的 .xml 文件，不要读取 ~/Downloads 或任意本机绝对路径。",
      "check 模式只检查 input/xml/*.xml 数据和远端环境，不执行写入更新。",
      "update 模式必须同时满足 mode=update 和配置允许写入后才执行更新。",
      "执行结果必须写入 output/update-result.json。",
      "",
    );
  }

  if (definition.outputCategory === "submission") {
    const submit = configService.submit === true;
    parts.push(
      `submit=${submit}`,
      "submit=true 时必须写入 output/submission-result.json；submit=false 时只准备和校验表单上下文。",
      "",
    );
  }

  parts.push("服务配置文件：input/service-config.json");

  return parts.join("\n");
}

async function promptForRun(job, body, template) {
  if (template === "custom") {
    return body.prompt || defaultPrompt(job);
  }

  await ensureTemplateRunRequirements(job, template, body);
  await writeServiceConfig(job, template, body);

  if (body.prompt) throw new Error(`template ${template} does not accept a custom prompt`);

  if (template === "md2wechat") return md2wechatPrompt(job);

  if (TEMPLATES[template]) {
    const prompt = complexSkillPrompt(job, template, body);
    const inputs = await listFiles(job.paths.input);
    if (!inputs.length) return prompt;
    return [
      prompt,
      "",
      "已上传输入文件：",
      ...inputs.map((file) => `- input/${file.path}`),
    ].join("\n");
  }

  throw new Error(`invalid template: ${template}`);
}

async function writeServiceConfig(job, template, body) {
  const config = {
    template,
    mode: runMode(template, body),
    taskBrief: taskBrief(body),
    serviceConfig: serviceConfig(body),
    paths: {
      jobRoot: job.paths.root,
      input: job.paths.input,
      output: job.paths.output,
      logs: job.paths.logs,
      materials: path.join(job.paths.input, "materials"),
    },
    writtenAt: now(),
  };
  const target = safeJoin(job.paths.input, "service-config.json");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(config, null, 2) + "\n", "utf8");
  return target;
}

async function ensureTemplateRunRequirements(job, template, body) {
  await ensureTemplateInputs(job, template, TEMPLATES);
  const definition = TEMPLATES[template];
  if (template === "cnvd-weekly-db-update") {
    await ensureCnvdWeeklyXmlInput(job);
  }
  if (definition?.requiresInputOrBrief && !(await hasInputFiles(job)) && !taskBrief(body)) {
    throw new Error(`template ${template} requires uploaded input files or options.taskBrief`);
  }
  if (["phase2-cnvd-report", "phase2-cnnvd-report", "phase2-ncc-report"].includes(template)) {
    await ensureSubmissionMaterials(job, template, body);
  }
}

async function ensureCnvdWeeklyXmlInput(job) {
  const files = await listFiles(path.join(job.paths.input, "xml"));
  const xmlFiles = files.filter((file) => path.extname(file.path).toLowerCase() === ".xml");
  if (xmlFiles.length > 0) return;
  throw new Error("template cnvd-weekly-db-update requires input/xml/*.xml");
}

async function ensureSubmissionMaterials(job, template, body) {
  const options = runOptions(body);
  const config = serviceConfig(body);
  const hasTargetConfig = Boolean(config.das_id || config.target_path || config.batch_dir);
  if (hasTargetConfig || taskBrief(body)) return;

  const files = await listFiles(path.join(job.paths.input, "materials"));
  const ignored = new Set([".DS_Store", "Thumbs.db"]);
  const validExtensions = template === "phase2-ncc-report"
    ? [".docx", ".zip", ".pdf", ".png", ".jpg", ".jpeg"]
    : [".docx", ".zip"];
  const validFiles = files.filter((file) => {
    const name = path.basename(file.path);
    const ext = path.extname(name).toLowerCase();
    return !ignored.has(name) && validExtensions.includes(ext);
  });
  if (validFiles.length > 0) return;

  const mode = typeof options.mode === "string" ? options.mode : "";
  const hint = mode === "batch"
    ? "请上传包含 DAS-* 子目录的完整批次材料，至少包含平台 docx 或 zip。"
    : "请上传完整 DAS 材料目录，至少包含平台 docx 或 zip；不要只上传 .DS_Store。";
  throw new Error(`${template} 缺少有效上报材料。${hint}`);
}

// ── Prompt-based execution (non-adapter) ───────────────────────────────────

async function runJob(job, body) {
  if (isActiveStatus(job.status)) {
    throw new Error(`job ${job.id} is already ${job.status}`);
  }
  const existingSubmission = await readSubmissionResult(job);
  if (existingSubmission && isSuccessfulSubmissionResult(existingSubmission)) {
    throw new Error(`job ${job.id} already submitted as ${platformIdFromSubmissionResult(existingSubmission)}`);
  }

  const template = resolveRunTemplate(job, body);
  const options = runOptions(body);
  const mode = typeof options.mode === "string" ? options.mode.trim() : "";
  const stdoutPath = path.join(job.paths.logs, "run.jsonl");
  const stderrPath = path.join(job.paths.logs, "stderr.log");
  const startedAt = now();
  const cancelMarkerPath = path.join(job.paths.input, CANCEL_MARKER);

  await fsp.rm(cancelMarkerPath, { force: true }).catch(() => {});
  await fsp.rm(job.paths.output, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(job.paths.output, { recursive: true });
  await fsp.writeFile(stdoutPath, "", "utf8");
  await fsp.writeFile(stderrPath, "", "utf8");
  await fsp.writeFile(path.join(job.paths.logs, "progress.jsonl"), "", "utf8");

  if (template !== "custom") {
    await ensureTemplateRunRequirements(job, template, body);
    await writeServiceConfig(job, template, body);
  }

  const adapter = USE_DETERMINISTIC_ADAPTERS ? tryLoadAdapter(template) : null;
  if (adapter) {
    job.status = "running";
    job.template = template;
    job.run = {
      template, options, model: "adapter", models: [], prompt: "(deterministic adapter)",
      startedAt, finishedAt: null, exitCode: null,
      stdout: stdoutPath, stderr: stderrPath, attempts: [], adapter: true,
    };
    await writeJob(job);
    await fsp.writeFile(stdoutPath, "", "utf8");
    await fsp.writeFile(stderrPath, "", "utf8");

    runAdapterAsyncInner(job.id, adapter, body, mode).catch(async (error) => {
      ACTIVE_RUNS.delete(job.id);
      const latest = await readJob(job.id);
      if (latest.status === "canceled") return;
      latest.status = "failed";
      latest.run.finishedAt = now();
      latest.run.error = error.message || String(error);
      await writeFallbackSummary(latest, latest.run.template, {
        outcome: "failed",
        error: latest.run.error,
        mode: latest.run.options?.mode || "",
        force: true,
      });
      await writeJob(latest);
      startPush(latest.id).catch(() => {});
    });

    return job;
  }

  const prompt = await promptForRun(job, body, template);
  const requestedModels = Array.isArray(body.models) ? body.models : [];
  const modelCandidates = [...requestedModels, body.model || DEFAULT_MODEL, ...FALLBACK_MODELS]
    .filter((model) => typeof model === "string" && model.trim())
    .map((model) => model.trim())
    .filter((model, index, models) => models.indexOf(model) === index);

  job.status = "running";
  job.finishedAt = null;
  job.template = template;
  job.run = {
    template, options, model: modelCandidates[0], models: modelCandidates, prompt,
    startedAt, finishedAt: null, exitCode: null,
    stdout: stdoutPath, stderr: stderrPath, attempts: [],
  };
  await writeJob(job);

  runJobAttemptsInner(job.id, prompt, modelCandidates, body).catch(async (error) => {
    ACTIVE_RUNS.delete(job.id);
    const latest = await readJob(job.id);
    if (latest.status === "canceled") return;
    latest.status = "failed";
    latest.run.finishedAt = now();
    latest.run.error = error.message || String(error);
    await writeFallbackSummary(latest, latest.run.template, {
      outcome: "failed",
      error: latest.run.error,
      mode: latest.run.options?.mode || "",
      force: true,
    });
    await writeJob(latest);
    startPush(latest.id).catch(() => {});
  });

  return job;
}

// ── Adapter execution with ACTIVE_RUNS tracking ───────────────────────────

async function runAdapterAsyncInner(jobId, adapter, body, mode) {
  const job = await readJob(jobId);
  let childProcess = null;

  const result = await adapter.run(job, body, mode || "", {
    registerChild: (child) => {
      childProcess = child;
      if (child) {
        ACTIVE_RUNS.set(jobId, { child, startedAt: now(), adapter: true });
      }
    },
    unregisterChild: () => {
      childProcess = null;
      ACTIVE_RUNS.delete(jobId);
    },
  });

  const latest = await readJob(jobId);
  if (latest.status === "canceled") return;

  const finishedAt = now();
  latest.run.finishedAt = finishedAt;

  if (result === null) {
    // Adapter fell through — mark for retry via OpenCode
    latest.run.adapter = false;
    latest.status = "created";
    await writeJob(latest);
    ACTIVE_RUNS.delete(jobId);
    return;
  }

  if (result.success) {
    try {
      await writeFallbackSummary(latest, latest.run.template, {
        outcome: SUCCESS_STATUS,
        mode: mode || latest.run.options?.mode || "",
      });
      await validateRequiredOutputs(latest, latest.run.template, mode || latest.run.options?.mode || "");
      latest.status = SUCCESS_STATUS;
    } catch (error) {
      latest.status = "failed";
      latest.run.error = error.message || String(error);
      await writeFallbackSummary(latest, latest.run.template, {
        outcome: "failed",
        error: latest.run.error,
        mode: mode || latest.run.options?.mode || "",
        force: true,
      });
      await fsp.appendFile(latest.run.stderr, `${latest.run.error}\n`, "utf8").catch(() => {});
    }
  } else {
    latest.status = "failed";
    latest.run.error = result.error || "adapter failed";
    await writeFallbackSummary(latest, latest.run.template, {
      outcome: "failed",
      error: latest.run.error,
      mode: mode || latest.run.options?.mode || "",
      force: true,
    });
  }
  latest.run.exitCode = result.success ? 0 : 1;
  latest.run.finishedAt = finishedAt;
  await writeJob(latest);
  ACTIVE_RUNS.delete(jobId);
  startPush(jobId).catch(() => {});
}

// ── OpenCode execution with ACTIVE_RUNS tracking ──────────────────────────

async function runJobAttemptsInner(jobId, prompt, models, body) {
  const attemptPlan = buildAttemptPlan(models);

  for (let index = 0; index < attemptPlan.length; index++) {
    const { model } = attemptPlan[index];
    let lastError = "";

    for (let retry = 0; retry <= Math.max(0, CAPACITY_RETRIES); retry++) {
      let job = await readJob(jobId);
      if (job.status === "canceled") return;

      if (retry > 0) await sleep(CAPACITY_RETRY_DELAY_MS);

      const active = { model, attempt: index, retry, startedAt: now(), child: null, adapter: false };
      ACTIVE_RUNS.set(jobId, active);

      const stdoutPath = job.paths.logs + "/run.jsonl";
      const stderrPath = job.paths.logs + "/stderr.log";

      const exitCode = await runOpenCodeAttempt(
        jobId, prompt, model, body, stdoutPath, stderrPath,
        SKILL_ROOT, OPENCODE_SERVER_URL,
        (child) => { active.child = child; },
        () => {},
      );

      job = await readJob(jobId);
      if (job.status === "canceled") {
        ACTIVE_RUNS.delete(jobId);
        return;
      }

      const runAttempt = {
        model, attempt: index, retry,
        startedAt: active.startedAt, finishedAt: now(), exitCode: exitCode ?? -1,
      };
      if (!job.run) job.run = { attempts: [] };
      if (!job.run.attempts) job.run.attempts = [];
      job.run.attempts.push(runAttempt);

      if (exitCode === 0) {
        try {
          await writeFallbackSummary(job, job.run.template, {
            outcome: SUCCESS_STATUS,
            mode: job.run.options?.mode || runMode(job.run.template, body),
          });
          await validateRequiredOutputs(job, job.run.template, job.run.options?.mode || runMode(job.run.template, body));
          job.status = SUCCESS_STATUS;
        } catch (error) {
          job.status = "failed";
          job.run.error = error.message || String(error);
          await writeFallbackSummary(job, job.run.template, {
            outcome: "failed",
            error: job.run.error,
            mode: job.run.options?.mode || runMode(job.run.template, body),
            force: true,
          });
          await fsp.appendFile(stderrPath, `${job.run.error}\n`, "utf8").catch(() => {});
        }
        job.run.finishedAt = now();
        job.run.exitCode = isSuccessStatus(job.status) ? 0 : 1;
        job.run.model = model;
        await writeJob(job);
        ACTIVE_RUNS.delete(jobId);
        startPush(jobId).catch(() => {});
        return;
      }

      const output = await fsp.readFile(stdoutPath, "utf8").catch(() => "");
      if (isCapacityError(output)) {
        lastError = `capacity error on ${model} (retry ${retry + 1}/${CAPACITY_RETRIES + 1})`;
        continue;
      }
      break;
    }

    const job = await readJob(jobId);
    if (job.status === "canceled") { ACTIVE_RUNS.delete(jobId); return; }

    job.run.finishedAt = now();
    job.run.exitCode = -1;
    job.run.model = model;
    job.run.error = lastError || `${model} failed`;
    if (index === attemptPlan.length - 1) {
      job.status = "failed";
      await writeFallbackSummary(job, job.run.template, {
        outcome: "failed",
        error: job.run.error,
        mode: job.run.options?.mode || runMode(job.run.template, body),
        force: true,
      });
      await writeJob(job);
      ACTIVE_RUNS.delete(jobId);
      startPush(jobId).catch(() => {});
    }
  }
}

// ── Cancel ─────────────────────────────────────────────────────────────────

async function writeCancelMarkerFile(job, canceledAt) {
  const payload = { canceled: true, id: job.id, canceledAt: canceledAt || now() };
  await fsp.writeFile(path.join(job.paths.input, CANCEL_MARKER), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function cancelJobHandler(job) {
  if (["canceled", "completed", "succeeded", "failed"].includes(job.status)) return;
  const canceledAt = now();
  job.status = "canceled";
  job.finishedAt = canceledAt;
  if (job.run) job.run.finishedAt = canceledAt;
  await writeJob(job);
  await writeCancelMarkerFile(job, canceledAt);

  const active = ACTIVE_RUNS.get(job.id);
  if (active) {
    stopActiveChild(active);
    ACTIVE_RUNS.delete(job.id);
  } else {
    await stopOrphanedOpenCodeRuns(job.id);
  }
  startPush(job.id).catch(() => {});
}

async function stopOrphanedOpenCodeRuns(jobId) {
  if (!/^job_[a-zA-Z0-9_-]+$/.test(jobId)) return;
  await new Promise((resolve) => {
    const child = spawn("pkill", ["-TERM", "-f", `opencode run .*${jobId}`], {
      stdio: "ignore",
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

// ── API Routes ─────────────────────────────────────────────────────────────

async function route(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  try {
    // Health
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "skills-api",
        useAdapters: USE_DETERMINISTIC_ADAPTERS,
        executionMode: USE_DETERMINISTIC_ADAPTERS ? "legacy-adapter" : "opencode-skills",
        templates: TEMPLATES,
      });
    }

    // Create job
    if (req.method === "POST" && url.pathname === "/jobs") {
      const body = await readBody(req);
      const template = resolveCreateTemplate(body);
      if (template === "custom" && !body.prompt) return badRequest(res, "custom template requires prompt field");
      const job = await createJob(body, template);
      return json(res, 201, job);
    }

    // List jobs
    if (req.method === "GET" && url.pathname === "/jobs") {
      const jobs = await listJobs();
      return json(res, 200, { jobs: await Promise.all(jobs.map(jobForResponseWithEffectiveState)) });
    }

    // Job routes: /jobs/:id/* or /jobs/:id
    if (parts.length >= 2 && parts[0] === "jobs") {
      const jobId = parts[1];
      assertJobId(jobId);

      // GET /jobs/:id
      if (req.method === "GET" && parts.length === 2) {
        const job = await readJob(jobId);
        const detail = {
          ...job,
          ...(await effectiveJobState(job)),
          events: [],
          actions: [],
          humanInput: null,
          outputs: await outputFilesForJob(job),
        };
        if (job.run) {
          const logs = await readLogs(job);
          const stdoutText = job.run.stdout ? await fsp.readFile(job.run.stdout, "utf8").catch(() => "") : "";
          const stderrText = job.run.stderr ? await fsp.readFile(job.run.stderr, "utf8").catch(() => "") : "";
          detail.logs = {
            files: logs,
            stdout: redactSensitiveText(stdoutText),
            stderr: redactSensitiveText(stderrText),
          };
          const progress = await readProgress(job);
          detail.events = job.run.adapter
            ? parseProgressEvents(progress).map((e) => ({
                time: e.time, type: "progress", stage: e.stage || "",
                status: e.status === "done" ? "done" : e.status === "failed" ? "failed" : "running",
                label: e.label || e.stage || "", detail: e.detail || "",
              }))
            : parseExecutionEvents(
                stdoutText,
                stderrText,
                "",
                job,
                progress,
              );
        }
        try { detail.humanInput = await readHumanInput(job); } catch {}
        try { detail.actions = await listHumanActions(job); } catch {}
        return json(res, 200, jobForResponse(detail));
      }

      // DELETE /jobs/:id
      if (req.method === "DELETE" && parts.length === 2) {
        const result = await deleteJob(jobId);
        return json(res, 200, result);
      }

      // POST /jobs/:id/files
      if (req.method === "POST" && parts.length === 3 && parts[2] === "files") {
        const job = await readJob(jobId);
        const body = await readBody(req);
        const result = await writeInputFile(job, body);
        return json(res, 200, result);
      }

      // POST /jobs/:id/run
      if (req.method === "POST" && parts.length === 3 && parts[2] === "run") {
        const job = await readJob(jobId);
        const body = await readBody(req);
        await runJob(job, body);
        return json(res, 202, await jobForResponseWithEffectiveState(await readJob(jobId)));
      }

      // POST /jobs/:id/cancel
      if (req.method === "POST" && parts.length === 3 && parts[2] === "cancel") {
        const job = await readJob(jobId);
        if (!job) return notFound(res);
        await cancelJobHandler(job);
        return json(res, 200, { canceled: true });
      }

      // POST /jobs/:id/human-input
      if (req.method === "POST" && parts.length === 3 && parts[2] === "human-input") {
        const job = await readJob(jobId);
        const body = await readBody(req);
        await writeHumanInput(job, body);
        return json(res, 200, { ok: true });
      }

      // GET /jobs/:id/logs
      if (req.method === "GET" && parts.length === 3 && parts[2] === "logs") {
        const job = await readJob(jobId);
        const logs = await readLogs(job);
        return json(res, 200, {
          files: logs,
          stdout: job.run?.stdout ? redactSensitiveText(await fsp.readFile(job.run.stdout, "utf8").catch(() => "")) : "",
          stderr: job.run?.stderr ? redactSensitiveText(await fsp.readFile(job.run.stderr, "utf8").catch(() => "")) : "",
        });
      }

      // GET /jobs/:id/logs/:file
      if (req.method === "GET" && parts.length >= 4 && parts[2] === "logs") {
        const job = await readJob(jobId);
        const relativePath = decodePathSegments(parts.slice(3));
        const target = safeJoin(job.paths.logs, relativePath);
        const data = await fsp.readFile(target);
        return binary(res, 200, data, contentTypeFor(target));
      }

      // GET /jobs/:id/outputs
      if (req.method === "GET" && parts.length === 3 && parts[2] === "outputs") {
        const job = await readJob(jobId);
        const files = await outputFilesForJob(job);
        return json(res, 200, { files });
      }

      // GET /jobs/:id/outputs/:file
      if (req.method === "GET" && parts.length >= 4 && parts[2] === "outputs") {
        const job = await readJob(jobId);
        const relativePath = decodePathSegments(parts.slice(3));
        const target = safeJoin(job.paths.output, relativePath);
        const data = await fsp.readFile(target);
        return binary(res, 200, data, contentTypeFor(target));
      }

      // GET /jobs/:id/archive
      if (req.method === "GET" && parts.length === 3 && parts[2] === "archive") {
        const job = await readJob(jobId);
        const archive = await createOutputArchive(job);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": archive.length,
          "Content-Disposition": contentDispositionAttachment(`${job.id}-outputs.zip`),
        });
        res.end(archive);
        return;
      }

      // POST /jobs/:id/write-output
      if (req.method === "POST" && parts.length === 3 && parts[2] === "write-output") {
        const job = await readJob(jobId);
        const body = await readBody(req);
        const relativePath = safeRelativePath(body.filename || body.path || "");
        const target = safeJoin(job.paths.output, relativePath);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        let data;
        if (typeof body.contentBase64 === "string") {
          data = Buffer.from(body.contentBase64, "base64");
        } else if (typeof body.content === "string") {
          data = Buffer.from(body.content, "utf8");
        } else {
          return badRequest(res, "content or contentBase64 is required");
        }
        await fsp.writeFile(target, data);
        return json(res, 200, { path: relativePath, size: data.length });
      }

      // SSE push subscription
      if (req.method === "GET" && parts.length === 3 && parts[2] === "push") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        const clientId = subscribe(jobId, res);
        res.write(`data: ${JSON.stringify({ subscribed: true, jobId, clientId })}\n\n`);
        startPush(jobId).catch(() => {});
        return;
      }
    }

    return notFound(res);
  } catch (error) {
    if (error.message?.includes("not_found") || error.code === "ENOENT") {
      return notFound(res);
    }
    if (
      error.message?.startsWith("invalid") ||
      error.message?.startsWith("template") ||
      error.message?.includes("already submitted") ||
      error.message?.includes("already running")
    ) {
      return badRequest(res, error.message);
    }
    return serverError(res, error);
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// ── Server start ───────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    serverError(res, error);
  });
});

function startServer() {
  return server.listen(PORT, HOST, () => {
    console.log(`skills-api listening on http://${HOST}:${PORT}`);
    console.log(`jobs root: ${JOBS_ROOT}`);
    console.log(`openCode server: ${OPENCODE_SERVER_URL}`);
    console.log(`default model: ${DEFAULT_MODEL}`);
    console.log(`templates: ${Object.keys(TEMPLATES).join(", ")}`);
    markInterruptedRunsOnStartup().catch((error) => {
      console.error(`failed to reconcile interrupted jobs: ${error.message || error}`);
    });
  });
}

async function markInterruptedRunsOnStartup() {
  const jobs = await listJobs();
  const interruptedAt = now();
  for (const job of jobs) {
    if (job.status !== "running" && job.status !== "retrying") continue;
    job.status = "failed";
    if (job.run) {
      job.run.finishedAt = interruptedAt;
      job.run.exitCode = job.run.exitCode ?? 1;
      job.run.error = "skills-api restarted while job was running; OpenCode child process is no longer attached";
      if (job.run.stderr) {
        await fsp.appendFile(
          job.run.stderr,
          `${interruptedAt} skills-api restarted while job was running; marked as failed\n`,
          "utf8",
        ).catch(() => {});
      }
    }
    await fsp.appendFile(
      path.join(job.paths.logs, "progress.jsonl"),
      JSON.stringify({
        time: interruptedAt,
        stage: "summary",
        status: "failed",
        label: "任务运行中断",
        detail: "skills-api 服务重启，原 OpenCode 执行进程已丢失，请重新运行任务。",
      }) + "\n",
      "utf8",
    ).catch(() => {});
    await writeJob(job);
    startPush(job.id).catch(() => {});
  }
}

async function createJobCompat(body = {}) {
  return createJob(body, resolveCreateTemplate(body));
}

async function cancelJobCompat(job) {
  const canceledAt = now();
  job.status = "canceled";
  job.finishedAt = canceledAt;
  if (job.run) {
    job.run.finishedAt = canceledAt;
    job.run.canceledAt = canceledAt;
    job.run.error = "canceled by user";
    if (job.run.stderr) {
      await fsp.appendFile(job.run.stderr, "canceled by user\n", "utf8").catch(() => {});
    }
  }
  await writeJob(job);
  await writeCancelMarkerFile(job, canceledAt);
  return job;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  TEMPLATES,
  complexSkillPrompt,
  contentDispositionAttachment,
  createJob: createJobCompat,
  cancelJob: cancelJobCompat,
  decodePathSegments,
  defaultPrompt,
  groupOutputFilesByTemplate,
  ensureSubmissionMaterials,
  matchesOutputPattern,
  md2wechatPrompt,
  parseExecutionEvents,
  effectiveJobState,
  promptForRun,
  platformIdFromSubmissionResult,
  redactSensitiveText,
  isSuccessfulSubmissionResult,
  normalizeJobStatus,
  resolveCreateTemplate,
  resolveRunTemplate,
  route,
  safeRelativePath,
  serviceConfig,
  startServer,
  validateRequiredOutputs,
  writeFallbackSummary,
  writeJob,
  writeServiceConfig,
};
