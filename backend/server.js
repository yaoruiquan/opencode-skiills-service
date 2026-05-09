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
const SKILL_ROOT = process.env.SKILLS_API_SKILL_ROOT || "/root/.agents/skills";
const ACTIVE_RUNS = new Map();
const CANCEL_MARKER = "cancel-requested.json";

const TEMPLATES = {
  custom: {
    name: "custom",
    label: "自定义",
    description: "运行调用方提供的提示词，或使用通用默认提示词。",
    inputMode: "freeform",
    outputGroups: [
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
  md2wechat: {
    name: "md2wechat",
    label: "公众号转换",
    description: "将 input/article.md 转换为公众号正文 HTML 和预警封面图。",
    skill: "md2wechat",
    inputMode: "markdown",
    requiredInputs: ["article.md"],
    outputs: ["wechat-article.html", "wechat-cover.png"],
    requiredOutputs: ["wechat-article.html", "wechat-cover.png"],
    outputGroups: [
      { key: "article", label: "公众号正文", icon: "📄", patterns: ["wechat-article.html"] },
      { key: "cover", label: "预警封面图", icon: "🖼️", patterns: ["wechat-cover.png", "*.png", "*.jpg"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
  "vulnerability-alert-processor": {
    name: "vulnerability-alert-processor",
    label: "漏洞预警材料",
    description: "生成漏洞预警 Markdown、Word、PDF 和相关报告产物。",
    skill: "vulnerability-alert-processor",
    inputMode: "materials",
    requiresInputOrBrief: true,
    recommendedInputs: ["task.md", "materials/", "vuln-data.json", "downloaded-template.docx"],
    modes: ["full", "report-only", "browser-template"],
    outputs: ["final.md", "final.docx", "final.pdf", "render_context.json"],
    requiredOutputsByMode: {
      full: ["summary.txt", "final.md", "final.docx", "render_context.json"],
      "report-only": ["summary.txt", "final.md", "final.docx", "render_context.json"],
      "browser-template": ["summary.txt"],
    },
    configSchema: {
      cve: "",
      advisory_url: "",
      vuln_title: "",
      wechat_draft: false,
      publish: false,
    },
    outputGroups: [
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "reports", label: "预警报告", icon: "📝", patterns: ["final.md", "final.docx", "final.pdf"] },
      { key: "context", label: "渲染上下文", icon: "🔧", patterns: ["render_context.json"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
  "phase1-material-processor": {
    name: "phase1-material-processor",
    label: "材料整理",
    description: "整理监管上报前材料，重命名批次目录并修改 CNVD/CNNVD docx 模板。",
    skill: "phase1-material-processor",
    inputMode: "directory",
    requiresInputOrBrief: true,
    recommendedInputs: ["materials/DAS-T*/", "materials/**/*.docx"],
    modes: ["batch", "list", "single"],
    outputs: ["processed-materials/", "summary.txt"],
    requiredOutputs: ["processed-materials/", "summary.txt"],
    configSchema: {
      batch_dir: "",
      das_id: "",
      submitter: "",
    },
    outputGroups: [
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "result", label: "处理结果", icon: "📊", patterns: ["material-result.json"] },
      { key: "materials", label: "处理后材料", icon: "📂", patterns: ["processed-materials/**"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
  "msrc-vulnerability-report": {
    name: "msrc-vulnerability-report",
    label: "MSRC 预警报告",
    description: "处理 MSRC 安全更新材料包，生成 report.md、Word、PDF，并可选发布预览和钉钉通知。",
    skill: "msrc-vulnerability-report",
    inputMode: "directory",
    requiresInputOrBrief: true,
    recommendedInputs: ["materials/", "critical-descriptions.json", "logo.png"],
    modes: ["generate", "format-only", "publish"],
    outputs: ["report.md", "report.docx", "report.pdf", "preview.html", "summary.txt"],
    requiredOutputsByMode: {
      generate: ["summary.txt", "report.md", "report.docx"],
      "format-only": ["summary.txt", "report.docx"],
      publish: ["summary.txt", "report.md", "report.docx"],
    },
    configSchema: {
      month: "",
      require_critical_descriptions: true,
      publish: false,
      dingtalk_notify: false,
    },
    outputGroups: [
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "reports", label: "MSRC 报告", icon: "📝", patterns: ["report.md", "report.docx", "report.pdf"] },
      { key: "preview", label: "预览", icon: "👁️", patterns: ["preview.html"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
  "cnvd-weekly-db-update": {
    name: "cnvd-weekly-db-update",
    label: "CNVD 周库更新",
    description: "处理 CNVD 每周 XML 数据更新，执行上传、解析、归档和钉钉通知。",
    skill: "cnvd-weekly-db-update",
    inputMode: "file",
    requiresInputOrBrief: true,
    recommendedInputs: ["xml/", "task.md"],
    modes: ["check", "update"],
    outputs: ["summary.txt", "update-result.json"],
    requiredOutputs: ["summary.txt", "update-result.json"],
    configSchema: {
      remote_host: "",
      remote_user: "root",
      docker_container: "crawlab",
      dry_run: true,
      dingtalk_notify: false,
    },
    outputGroups: [
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "result", label: "更新结果", icon: "📊", patterns: ["update-result.json"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
  "phase2-cnvd-report": {
    name: "phase2-cnvd-report",
    label: "CNVD 上报",
    description: "通过 Chrome DevTools MCP 完成单个或批量 CNVD 漏洞上报。",
    skill: "phase2-cnvd-report",
    inputMode: "directory",
    requiresInputOrBrief: true,
    recommendedInputs: ["materials/DAS-*/", "materials/CNVD-*/", "materials/**/*.docx", "materials/**/*.zip"],
    modes: ["single", "batch"],
    browserMcp: "chrome-devtools-cnvd",
    chromePort: 9332,
    outputs: ["form_context.json", "submission-result.json", "batch-state.json"],
    requiredOutputsByMode: {
      single: ["summary.txt", "form_context.json"],
      batch: ["summary.txt", "batch-state.json"],
    },
    configSchema: {
      das_id: "",
      target_path: "",
      submit: false,
      dingtalk_notify: false,
    },
    outputCategory: "submission",
    outputGroups: [
      { key: "result", label: "上报结果", icon: "✅", patterns: ["submission-result.json", "batch-state.json"] },
      { key: "context", label: "表单上下文", icon: "🔧", patterns: ["form_context.json"] },
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
  "phase2-cnnvd-report": {
    name: "phase2-cnnvd-report",
    label: "CNNVD 上报",
    description: "通过 Chrome DevTools MCP 完成单个或批量 CNNVD 漏洞上报。",
    skill: "phase2-cnnvd-report",
    inputMode: "directory",
    requiresInputOrBrief: true,
    recommendedInputs: ["materials/DAS-*/", "materials/CNNVD-*/", "materials/**/*.docx", "materials/**/*.zip"],
    modes: ["single", "batch"],
    browserMcp: "chrome-devtools-cnnvd",
    chromePort: 9333,
    outputs: ["form_context.json", "submission-result.json", "batch-state.json"],
    requiredOutputsByMode: {
      single: ["summary.txt", "form_context.json"],
      batch: ["summary.txt", "batch-state.json"],
    },
    configSchema: {
      das_id: "",
      target_path: "",
      entity_description: "",
      verification: "",
      submit: false,
      update_summary: false,
      dingtalk_notify: false,
    },
    outputCategory: "submission",
    outputGroups: [
      { key: "result", label: "上报结果", icon: "✅", patterns: ["submission-result.json", "batch-state.json"] },
      { key: "context", label: "表单上下文", icon: "🔧", patterns: ["form_context.json"] },
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
  "phase2-ncc-report": {
    name: "phase2-ncc-report",
    label: "NCC 上报",
    description: "通过 Chrome DevTools MCP 完成 NCC 平台漏洞上报。",
    skill: "phase2-ncc-report",
    inputMode: "directory",
    requiresInputOrBrief: true,
    recommendedInputs: ["materials/DAS-*/", "materials/**/*.docx", "materials/**/*.zip"],
    modes: ["single"],
    browserMcp: "chrome-devtools-ncc",
    chromePort: 9334,
    outputs: ["form_context.json", "submission-result.json"],
    requiredOutputsByMode: {
      single: ["summary.txt", "form_context.json"],
    },
    configSchema: {
      das_id: "",
      target_path: "",
      prefer_source: "CNVD",
      submit: false,
      dingtalk_notify: false,
    },
    outputCategory: "submission",
    outputGroups: [
      { key: "result", label: "上报结果", icon: "✅", patterns: ["submission-result.json"] },
      { key: "context", label: "表单上下文", icon: "🔧", patterns: ["form_context.json"] },
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
};

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

function binary(res, status, data, contentType = "application/octet-stream") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
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

function decodePathSegments(segments) {
  try {
    return segments.map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    throw new Error("invalid encoded path");
  }
}

function contentDispositionAttachment(filename) {
  const safeName = filename.replaceAll('"', "").replaceAll("\\", "").replace(/[^\x20-\x7E]/g, "_");
  const fallbackName = safeName && safeName !== "." && safeName !== ".." ? safeName : "download";
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function knownTemplate(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

function resolveCreateTemplate(body) {
  if (typeof body.template === "string" && body.template.trim()) {
    const template = body.template.trim();
    if (!knownTemplate(template)) {
      throw new Error(`invalid template: ${template}`);
    }
    return template;
  }

  if (typeof body.type === "string" && knownTemplate(body.type.trim())) {
    return body.type.trim();
  }

  return "custom";
}

function resolveRunTemplate(job, body) {
  if (typeof body.template === "string" && body.template.trim()) {
    const template = body.template.trim();
    if (!knownTemplate(template)) {
      throw new Error(`invalid template: ${template}`);
    }
    return template;
  }

  return job.template || "custom";
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

function isActiveStatus(status) {
  return status === "running" || status === "retrying";
}

function isCanceled(job) {
  return job.status === "canceled" || job.run?.canceledAt;
}

async function ensureJobDirs(paths) {
  await fsp.mkdir(paths.input, { recursive: true });
  await fsp.mkdir(paths.output, { recursive: true });
  await fsp.mkdir(paths.logs, { recursive: true });
}

async function createJob(body) {
  const id = `job_${randomUUID().replaceAll("-", "")}`;
  const paths = jobPaths(id);
  const template = resolveCreateTemplate(body);
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

async function ensureTemplateInputs(job, template) {
  const definition = TEMPLATES[template];
  const requiredInputs = definition.requiredInputs || [];
  for (const relativePath of requiredInputs) {
    const target = safeJoin(job.paths.input, relativePath);
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(`template ${template} requires input/${relativePath}`);
    }
  }
}

async function hasInputFiles(job) {
  const files = await listFiles(job.paths.input);
  return files.length > 0;
}

function runOptions(body) {
  const options = body && typeof body.options === "object" && body.options !== null && !Array.isArray(body.options)
    ? body.options
    : {};
  return options;
}

function serviceConfig(body) {
  const options = runOptions(body);
  const raw = options.serviceConfig || options.config || {};
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("options.serviceConfig must be an object");
  }
  return raw;
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

function runMode(template, body) {
  const definition = TEMPLATES[template] || {};
  const options = runOptions(body);
  return typeof options.mode === "string" && options.mode.trim()
    ? options.mode.trim()
    : (definition.modes || ["single"])[0];
}

function taskBrief(body) {
  const options = runOptions(body);
  return typeof options.taskBrief === "string" ? options.taskBrief.trim() : "";
}

async function ensureTemplateRunRequirements(job, template, body) {
  await ensureTemplateInputs(job, template);
  const definition = TEMPLATES[template];
  if (definition.requiresInputOrBrief && !(await hasInputFiles(job)) && !taskBrief(body)) {
    throw new Error(`template ${template} requires uploaded input files or options.taskBrief`);
  }
}

function md2wechatPrompt(job) {
  const articlePath = path.join(job.paths.input, "article.md");
  const htmlPath = path.join(job.paths.output, "wechat-article.html");
  const coverPath = path.join(job.paths.output, "wechat-cover.png");
  const renderJsonPath = path.join(job.paths.logs, "render_wechat_article.json");
  const skillDir = path.join(SKILL_ROOT, "md2wechat");

  return [
    "请严格使用 md2wechat skill 完成本地生成流程，不要上传公众号草稿箱，不要打开浏览器。",
    "",
    "固定路径：",
    `- skill 目录：${skillDir}`,
    `- 输入 Markdown：${articlePath}`,
    `- 输出 HTML：${htmlPath}`,
    `- 输出封面：${coverPath}`,
    `- 渲染 JSON 日志：${renderJsonPath}`,
    "",
    "执行要求：",
    "1. 确认输入 Markdown 文件存在。",
    "2. 阅读 md2wechat/SKILL.md 中要求的当前任务相关引用文件。",
    "3. 进入 md2wechat skill 目录，运行脚本生成 HTML，不要手写 HTML：",
    `   python3 scripts/render_wechat_article.py ${JSON.stringify(articlePath)} --output ${JSON.stringify(htmlPath)} --json > ${JSON.stringify(renderJsonPath)}`,
    "4. 运行脚本生成封面：",
    `   python3 scripts/render_alert_cover.py ${JSON.stringify(articlePath)} --output ${JSON.stringify(coverPath)} --poc true --exp true --wild false --research true`,
    "5. 校验 HTML 不包含 <style>、<script>、class=、contenteditable=、ProseMirror、微信后台页面壳或旧漏洞内容。",
    "6. 只把结果写入本 job 的 output 或 logs 目录。",
    "7. 最终回复列出生成的输出文件路径。",
  ].join("\n");
}

function complexSkillPrompt(job, template, body, inputFiles) {
  const definition = TEMPLATES[template];
  const options = runOptions(body);
  const mode = runMode(template, body);
  const brief = taskBrief(body) || "调用方未提供额外备注，请以 input 目录材料和 skill 固定流程为准。";
  const skillDir = path.join(SKILL_ROOT, definition.skill);
  const materialsDir = path.join(job.paths.input, "materials");
  const configPath = path.join(job.paths.input, "service-config.json");
  const humanInputPath = path.join(job.paths.input, "human-input.json");
  const cancelMarkerPath = path.join(job.paths.input, CANCEL_MARKER);
  const progressPath = path.join(job.paths.logs, "progress.jsonl");
  const fileList = inputFiles.length
    ? inputFiles.map((file) => `- input/${file.path} (${file.size} bytes)`).join("\n")
    : "- 未上传文件；请只使用任务备注或 skill 配置中可解析的 DAS-ID/批次信息。";

  const shared = [
    `请严格使用 ${template} skill 处理当前服务化任务。`,
    "",
    "固定路径：",
    `- skill 目录：${skillDir}`,
    `- job 根目录：${job.paths.root}`,
    `- 输入目录：${job.paths.input}`,
    `- 材料目录：${materialsDir}`,
    `- 输出目录：${job.paths.output}`,
    `- 日志目录：${job.paths.logs}`,
    `- 业务进度文件：${progressPath}`,
    `- 人工输入文件：${humanInputPath}`,
    `- 取消标记文件：${cancelMarkerPath}`,
    `- 服务化配置：${configPath}`,
    "",
    "调用参数：",
    `- 执行模式：${mode}`,
    `- 任务备注：${brief}`,
    `- 选项 JSON：${JSON.stringify(options, null, 2)}`,
    "",
    "已上传输入：",
    fileList,
    "",
    "通用执行规则：",
    "1. 执行前加载该 skill 的 SKILL.md 和其中要求的直接相关 references。",
    "2. 必须先读取 input/service-config.json；前端配置、DAS-ID、目标路径、发布开关、远端参数均以该文件为准。",
    "3. 所有脚本命令从 skill 目录执行，使用 python3；shell 脚本只在 skill 明确要求时运行。",
    "4. 不要使用或要求 macOS 绝对路径、~/Downloads、/Users/yao/LLM/vulns、宿主机 Chrome profile；所有服务输入只能来自本 job input 目录、service-config.json 或任务备注中的 DAS-ID。",
    "5. 所有生成文件、状态文件、摘要和可下载产物必须复制或写入本 job output 目录。",
    "6. 运行过程中的关键命令、平台编号、失败原因和人工介入事项写入 output/summary.txt；临时脚本或调试文件写入 logs 目录，不要写入 /tmp。",
    "7. 如果缺少必要输入、账号登录态、远端密钥或验证码，需要明确失败并写入 summary.txt，不要伪造成功。",
    `8. 必须在每个业务阶段开始/成功/失败时向 ${progressPath} 追加一行 JSONL，格式固定为 {"stage":"login|form_context|browser|fill_form|upload|captcha|submit|extract_id|summary","status":"running|done|failed|warning","label":"中文阶段名","detail":"简短说明","time":"ISO-8601 时间"}。`,
    `9. 写进度推荐使用：python3 -c 'import json,datetime,sys,pathlib; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True); d=json.loads(sys.argv[2]); d.setdefault("time", datetime.datetime.now(datetime.timezone.utc).isoformat()); p.open("a", encoding="utf-8").write(json.dumps(d, ensure_ascii=False)+"\\n")' ${JSON.stringify(progressPath)} '<JSON对象>'`,
    `10. 遇到 Cloudflare、人机验证、登录验证码或 OCR 无法识别时，不要继续猜测或安装 OCR 依赖；必须截图保存到 logs 目录，文件名包含 captcha、cloudflare、cf 或 human-verification，并写入 progress.jsonl：{"stage":"captcha","status":"warning","label":"等待人工验证","detail":"请在前端查看截图并输入验证码/处理结果"}。`,
    `11. 写入等待人工验证后，每 5 秒读取一次 ${humanInputPath}；文件存在且 JSON 中 value/code/text 非空后，使用该值继续填写验证码或确认人工已完成。最多等待 10 分钟，超时则写 output/summary.txt 并失败。等待期间如果发现 ${cancelMarkerPath} 存在，必须立即停止后续浏览器操作并退出。`,
    `12. 每个长耗时等待、验证码重试、登录重试或提交重试前，都必须检查 ${cancelMarkerPath}；存在则写入 progress.jsonl 的 failed 事件并退出，不要继续填表或提交。`,
    "13. 最终回复必须列出输出文件、状态和下一步人工动作。",
  ];

  const specifics = {
    "vulnerability-alert-processor": [
      "模板要求：漏洞预警材料生成。",
      "1. 按 skill 规则先读 references/runtime-rules.md；需要完整流程时读 workflow、field-mapping、auto-determine、output-spec 和 notes。",
      "2. 如果 input 中已有 vuln-data JSON 和下载的 Word 模版，优先走确定性阶段二：validate_vuln_data.py -> build_render_context.py -> render_markdown.py -> fill_word_template.py -> docx_to_pdf.py。",
      "3. 将 RenderContext 写为 output/render_context.json，Markdown 写为 output/final.md，Word 写为 output/final.docx，PDF 写为 output/final.pdf。",
      "4. 如果只有任务备注、CVE、漏洞标题或公告链接，按 skill 信息检索流程生成可追溯 vuln-data JSON 后再继续处理，不能读取本机下载目录。",
      "5. 如果 service-config.json 中 wechat_draft/publish 为 false，不上传公众号、不上传报告、不推送钉钉。",
      "6. 必须输出：output/summary.txt；report-only/full 模式还必须输出 final.md、final.docx、render_context.json。",
    ],
    "phase1-material-processor": [
      "模板要求：监管上报前材料整理。",
      "1. 输入材料应位于 input/materials；如果上传的是文件集合，先在 job 内整理出一个批次目录。",
      `2. 必须运行 scripts/test_material.py 的服务化输出模式：python3 scripts/test_material.py --dir "<批次目录>" --output-root ${JSON.stringify(job.paths.output)} --summary ${JSON.stringify(path.join(job.paths.output, "summary.txt"))} --json ${JSON.stringify(path.join(job.paths.output, "material-result.json"))} ${mode === "single" ? "<DAS-ID>" : mode}`,
      "3. 批次目录优先使用 service-config.json 的 serviceConfig.batch_dir；未配置时自动选择 input/materials 下第一个包含 DAS-* 子目录的目录。",
      "4. 不要直接把批次目录放在 output 根目录，不要修改 input 原件。",
      "5. 必须输出：output/processed-materials/、output/summary.txt、output/material-result.json。",
    ],
    "msrc-vulnerability-report": [
      "模板要求：MSRC 安全更新漏洞预警报告生成。",
      "1. 按 skill 规则先读 references/runtime-rules.md，再按场景读取 workflow.md 和 output-spec.md。",
      "2. 输入材料包必须来自 input/materials 或任务备注指定的 job 内相对路径，不要读取 ~/Downloads 或 macOS 绝对路径。",
      "3. 如果 input 中包含 critical-descriptions.json，先按 skill 规则保存并应用 CVSS>=9.0 漏洞描述。",
      "4. generate 模式使用 job 内材料目录执行 msrc_main.py 生成 report.md，再执行 generate_word_dynamic.py、format_word.py，PDF 仅在 LibreOffice 可用时生成。",
      "5. 最终产物复制或直接写入 output/report.md、output/report.docx、output/report.pdf、output/preview.html、output/summary.txt。",
      "6. publish 模式只有在 service-config.json 中 publish=true 且 skill .env/服务器密钥可用时才执行上传和钉钉通知；不要把 webhook、SSH 密码或服务器密钥写入 job 输出。",
    ],
    "cnvd-weekly-db-update": [
      "模板要求：CNVD 每周 XML 数据库更新。",
      "1. 按 skill 规则读取 SKILL.md、README.md 和 references/troubleshooting.md。",
      "2. 服务化任务不得读取 ~/Downloads；XML 文件必须上传到 input/xml 或在任务备注中说明已存在的 job 内路径。",
      "3. check 模式只检查 input/xml 是否存在 XML、远端参数是否配置、SSH 是否可连接，不执行真实更新。",
      "4. update 模式必须同时满足 mode=update、service-config.json 中 dry_run=false 或 explicit_update=true，才执行远端上传、Docker cp、parse.py、归档和钉钉通知。",
      "5. 远端 host/user/container 优先来自 service-config.json；SSH key、钉钉 webhook 和密钥只能来自服务器预配置，不要写入 job、日志或输出。",
      "6. 输出建议命名：output/summary.txt、output/update-result.json，并记录远端执行结果和人工后续动作。",
    ],
    "phase2-cnvd-report": [
      "模板要求：CNVD 平台上报。",
      "0. 业务进度必须按 form_context -> browser -> login -> fill_form -> upload -> captcha -> submit -> extract_id -> summary 写入；submit=false 时 browser/login/fill_form/upload/captcha/submit 可写为 skipped 或 warning。",
      "1. 使用 MCP 通道 chrome-devtools-cnvd；Docker Chrome 地址为 http://browser-cnvd:9332，不要启动本地 Chrome，不要改用 127.0.0.1:9332。",
      "2. 单个模式必须先运行 scripts/prepare_form_context.py <DAS目录或docx> --data-dir input/materials --output output/form_context.json；目标优先 serviceConfig.target_path/das_id。",
      "3. 批量模式必须先运行 scripts/batch_report.py init <批次目录> --output output/batch-state.json --force，再 start-next，单条上下文仍写 output/form_context.json。",
      "4. 浏览器填写阶段只读取 output/form_context.json、page_payloads 和 browser_helpers，不重新读取 Word 或临时判断字段。",
      "5. service-config.json 中 submit=false 时只完成 form_context 准备和环境检查，不提交平台；submit=true 时才进入浏览器提交。",
      "6. 验证码按 skill 的 captcha-ocr 规则处理；如需人工输入，在 output/summary.txt 明确记录。",
      "7. 成功后必须写 output/submission-result.json，包含 submitted=true、platform_id/CNVD-ID、title、submitted_at；批量模式每条 record，全部完成后只 notify 一次。",
    ],
    "phase2-cnnvd-report": [
      "模板要求：CNNVD 平台上报。",
      "0. 业务进度必须按 form_context -> browser -> login -> fill_form -> upload -> captcha -> submit -> extract_id -> summary 写入；submit=false 时 browser/login/fill_form/upload/captcha/submit 可写为 skipped 或 warning。",
      "1. 使用 MCP 通道 chrome-devtools-cnnvd；Docker Chrome 地址为 http://browser-cnnvd:9333，不要启动本地 Chrome，不要改用 127.0.0.1:9333。",
      "2. 单个模式必须先运行 scripts/prepare_form_context.py <DAS目录或docx> --data-dir input/materials --output output/form_context.json；entity_description 和 verification 来自 service-config.json。",
      "3. 批量模式必须先运行 scripts/batch_report.py init <批次目录> --output output/batch-state.json --force，再 start-next，单条上下文仍写 output/form_context.json。",
      "4. 第 1 页下拉和所有文本字段只按 dropdown_plan 与 page_payloads 填写。",
      "5. service-config.json 中 submit=false 时只完成 form_context 准备和环境检查，不提交平台；submit=true 时才进入浏览器提交。",
      "6. 上传 verification_video_path 和 poc_file_path 指向的材料，不重新压缩或临时查找文件。",
      "7. 成功后必须写 output/submission-result.json，包含 submitted=true、platform_id/CNNVD-ID、title、submitted_at；update_summary=true 时才按 references/summary-table.md 执行汇总表更新。",
    ],
    "phase2-ncc-report": [
      "模板要求：NCC 平台上报。",
      "0. 业务进度必须按 form_context -> browser -> login -> fill_form -> upload -> captcha -> submit -> extract_id -> summary 写入；submit=false 时 browser/login/fill_form/upload/captcha/submit 可写为 skipped 或 warning。",
      "1. 使用 MCP 通道 chrome-devtools-ncc；Docker Chrome 地址为 http://browser-ncc:9334，不要启动本地 Chrome，不要改用 127.0.0.1:9334。",
      "2. 必须先运行 scripts/prepare_form_context.py --data-dir input/materials --output output/form_context.json；DAS-ID、target_path、prefer_source 优先来自 service-config.json。",
      "3. 浏览器阶段只读 output/form_context.json，不重新读取 Word 或临时判断字段。",
      "4. service-config.json 中 submit=false 时只完成 form_context 准备和环境检查，不提交平台；submit=true 时才打开 NCC 企业中心并提交。",
      "5. 如果出现拖拽拼图验证，记录为人工介入步骤。",
      "6. 上传 form_context.json 中的 upload_zip_path，成功后必须写 output/submission-result.json，包含 submitted=true、platform_id/NCC 编号、title、submitted_at。",
      "7. 输出建议命名：output/form_context.json、output/submission-result.json、output/summary.txt。",
    ],
  };

  return [...shared, "", ...(specifics[template] || [])].join("\n");
}

async function promptForRun(job, body, template) {
  if (template === "custom") {
    return body.prompt || defaultPrompt(job);
  }

  if (body.prompt) {
    throw new Error(`template ${template} does not accept a custom prompt`);
  }

  await ensureTemplateRunRequirements(job, template, body);
  await writeServiceConfig(job, template, body);

  if (template === "md2wechat") {
    return md2wechatPrompt(job);
  }

  if (TEMPLATES[template]) {
    return complexSkillPrompt(job, template, body, await listFiles(job.paths.input));
  }

  throw new Error(`invalid template: ${template}`);
}

async function runJob(job, body) {
  if (isActiveStatus(job.status)) {
    throw new Error("job is already running");
  }

  const template = resolveRunTemplate(job, body);
  const options = runOptions(body);
  const mode = typeof options.mode === "string" ? options.mode.trim() : "";
  const stdoutPath = path.join(job.paths.logs, "run.jsonl");
  const stderrPath = path.join(job.paths.logs, "stderr.log");
  const startedAt = now();

  // For non-custom templates, write the service-config before anything else
  if (template !== "custom") {
    await ensureTemplateRunRequirements(job, template, body);
    await writeServiceConfig(job, template, body);
  }

  // Try deterministic adapter first
  const adapter = tryLoadAdapter(template);
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
    runAdapterAsync(job.id, adapter, body, mode).catch(async (error) => {
      const latest = await readJob(job.id);
      if (isCanceled(latest)) return;
      latest.status = "failed";
      latest.run.finishedAt = now();
      latest.run.error = error.message || String(error);
      await writeJob(latest);
    });

    return job;
  }

  // No adapter or adapter not applicable — use OpenCode prompt path
  const prompt = await promptForRun(job, body, template);
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

  await fsp.writeFile(stdoutPath, "", "utf8");
  await fsp.writeFile(stderrPath, "", "utf8");

  runJobAttempts(job.id, prompt, modelCandidates, body).catch(async (error) => {
    const latest = await readJob(job.id);
    if (isCanceled(latest)) {
      return;
    }
    latest.status = "failed";
    latest.run.finishedAt = now();
    latest.run.error = error.message || String(error);
    await writeJob(latest);
  });

  return job;
}

/**
 * Try to load a deterministic adapter for the given template.
 * Returns null if no adapter exists or if it can't be loaded.
 */
function tryLoadAdapter(template) {
  const relativePath = `./adapters/${template}.js`;
  try {
    return require(relativePath);
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND" && error.message.includes(relativePath)) {
      return null;
    }
    throw error;
  }
}

async function writeCancelMarker(job, canceledAt) {
  const payload = {
    canceled: true,
    canceledAt,
    reason: "canceled by user",
  };
  await fsp.writeFile(path.join(job.paths.input, CANCEL_MARKER), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function stopActiveChild(active) {
  const child = active?.child;
  if (!child || child.killed) return;

  if (typeof child.pid === "number" && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort cancellation; the persisted cancel marker still guards long waits.
      }
    }
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore final best-effort failure.
          }
        }
      }
    }, 5000);
    killTimer.unref?.();
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore best-effort failure.
  }
}

/**
 * Run a deterministic adapter asynchronously.
 * If the adapter returns null, fall through to OpenCode prompt path.
 */
async function runAdapterAsync(jobId, adapter, body, mode) {
  const job = await readJob(jobId);
  if (isCanceled(job)) return;

  const adapterContext = {
    registerChild(child) {
      ACTIVE_RUNS.set(jobId, { child, startedAt: now(), adapter: true });
    },
    unregisterChild(child) {
      const active = ACTIVE_RUNS.get(jobId);
      if (active?.child === child) {
        ACTIVE_RUNS.delete(jobId);
      }
    },
  };

  const result = await adapter.run(job, body, mode, adapterContext);

  // Adapter returned null → needs OpenCode (e.g. submit=true)
  if (result === null) {
    const latest = await readJob(jobId);
    if (isCanceled(latest)) return;

    // Switch to OpenCode prompt path
    const template = latest.run.template;
    const prompt = await promptForRun(latest, body, template);
    const requestedModels = Array.isArray(body.models) ? body.models : [];
    const modelCandidates = [...requestedModels, body.model || DEFAULT_MODEL, ...FALLBACK_MODELS]
      .filter((m) => typeof m === "string" && m.trim())
      .map((m) => m.trim())
      .filter((m, i, arr) => arr.indexOf(m) === i);

    latest.run.model = modelCandidates[0];
    latest.run.models = modelCandidates;
    latest.run.prompt = prompt;
    latest.run.adapter = false;
    await writeJob(latest);

    await runJobAttempts(jobId, prompt, modelCandidates, body);
    return;
  }

  const latest = await readJob(jobId);
  if (isCanceled(latest)) return;

  if (result.success) {
    try {
      await validateRequiredOutputs(latest, latest.run.template, mode);
    } catch (error) {
      latest.status = "failed";
      latest.run.finishedAt = now();
      latest.run.exitCode = 0;
      latest.run.error = error.message || String(error);
      await writeJob(latest);
      return;
    }
    latest.status = "succeeded";
    latest.run.finishedAt = now();
    latest.run.exitCode = 0;
  } else {
    latest.status = "failed";
    latest.run.finishedAt = now();
    latest.run.exitCode = 1;
    latest.run.error = result.error || "adapter execution failed";
  }
  await writeJob(latest);
}

async function cancelJob(job) {
  if (!isActiveStatus(job.status)) {
    throw new Error("job is not running");
  }

  const active = ACTIVE_RUNS.get(job.id);
  const canceledAt = now();
  job.status = "canceled";
  if (job.run) {
    job.run.finishedAt = canceledAt;
    job.run.canceledAt = canceledAt;
    job.run.error = "canceled by user";
  }
  await writeCancelMarker(job, canceledAt);
  await appendFile(path.join(job.paths.logs, "stderr.log"), `canceled by user at ${canceledAt}\n`);
  await writeJob(job);

  if (active?.child) {
    stopActiveChild(active);
  } else {
    ACTIVE_RUNS.delete(job.id);
  }

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
    if (isCanceled(job)) {
      return;
    }
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
      const afterDelay = await readJob(jobId);
      if (isCanceled(afterDelay)) {
        return;
      }
    }

    await fsp.writeFile(attempt.stdout, "", "utf8");
    await fsp.writeFile(attempt.stderr, "", "utf8");
    await appendFile(job.run.stdout, `\n{"type":"attempt_start","attempt":${attemptNumber},"model":${JSON.stringify(model)},"timestamp":${JSON.stringify(now())}}\n`);

    const result = await runOpenCodeAttempt(job, prompt, model, body, attempt.stdout, attempt.stderr);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    lastExitCode = result.exitCode;
    lastCapacityError = isCapacityError(combinedOutput);

    const latest = await readJob(jobId);
    if (isCanceled(latest)) {
      return;
    }
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
      try {
        await validateRequiredOutputs(latest, latest.run.template, latest.run.options?.mode || "");
      } catch (error) {
        latest.status = "failed";
        latest.run.finishedAt = now();
        latest.run.error = error.message || String(error);
        await appendFile(latest.run.stderr, `${latest.run.error}\n`);
        await writeJob(latest);
        return;
      }
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
      detached: process.platform !== "win32",
    });
    ACTIVE_RUNS.set(job.id, { child, startedAt: now() });

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
      const active = ACTIVE_RUNS.get(job.id);
      if (active?.child === child) {
        ACTIVE_RUNS.delete(job.id);
      }
      resolve({ exitCode: 1, stdout, stderr });
    });

    child.on("close", (code) => {
      const active = ACTIVE_RUNS.get(job.id);
      if (active?.child === child) {
        ACTIVE_RUNS.delete(job.id);
      }
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

async function readLogs(job) {
  const stdout = await fsp.readFile(path.join(job.paths.logs, "run.jsonl"), "utf8").catch(() => "");
  const stderr = await fsp.readFile(path.join(job.paths.logs, "stderr.log"), "utf8").catch(() => "");
  const adapter = await fsp.readFile(path.join(job.paths.logs, "adapter.log"), "utf8").catch(() => "");
  const progress = await fsp.readFile(path.join(job.paths.logs, "progress.jsonl"), "utf8").catch(() => "");
  const humanActions = await listHumanActions(job);
  const humanInput = await readHumanInput(job);
  const redactedStdout = redactSensitiveText(stdout);
  const redactedStderr = redactSensitiveText(stderr);
  const redactedAdapter = redactSensitiveText(adapter);
  const redactedProgress = redactSensitiveText(progress);
  return {
    stdout: redactedStdout,
    stderr: redactedStderr,
    adapter: redactedAdapter,
    progress: redactedProgress,
    events: parseExecutionEvents(redactedStdout, redactedStderr, redactedAdapter, job, redactedProgress),
    humanActions,
    humanInput,
  };
}

function redactSensitiveText(value = "") {
  return String(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/((?:PASSWORD|PASSWD|SECRET|TOKEN|WEBHOOK|ACCESS_TOKEN|API_KEY|EMAIL)\s*[=:]\s*)([^\s"',]+)/gi, "$1[REDACTED]")
    .replace(/("(?:password|passwd|secret|token|webhook|access_token|api_key|email)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/("value"\s*:\s*")([^"]*(?:@|password|passwd|secret|token|webhook|access_token|api_key)[^"]*)(")/gi, "$1[REDACTED]$3");
}

async function listHumanActions(job) {
  const files = await listFiles(job.paths.logs);
  return files
    .filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file.path))
    .filter((file) => /captcha|cloudflare|cf_|human|verify|verification/i.test(file.path))
    .map((file) => ({
      ...file,
      url: `/jobs/${encodeURIComponent(job.id)}/logs/${file.path.split("/").map(encodeURIComponent).join("/")}`,
    }));
}

async function readHumanInput(job) {
  const target = path.join(job.paths.input, "human-input.json");
  try {
    return JSON.parse(await fsp.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

async function writeHumanInput(job, body) {
  const value = String(body.value || body.code || body.text || "").trim();
  if (!value) {
    throw new Error("human input value is required");
  }
  const payload = {
    type: String(body.type || "captcha"),
    value,
    note: String(body.note || ""),
    createdAt: now(),
  };
  const inputPath = path.join(job.paths.input, "human-input.json");
  const logPath = path.join(job.paths.logs, "human-input.json");
  await fsp.writeFile(inputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await fsp.writeFile(logPath, JSON.stringify({ ...payload, value: maskHumanInputValue(value) }, null, 2) + "\n", "utf8");
  await appendFile(
    path.join(job.paths.logs, "progress.jsonl"),
    JSON.stringify({
      stage: payload.type === "cloudflare" ? "login" : "captcha",
      status: "done",
      label: payload.type === "cloudflare" ? "人工验证已完成" : "人工验证码已提交",
      detail: payload.type === "cloudflare" ? "前端已确认人工处理完成。" : "前端已提交验证码。",
      time: payload.createdAt,
    }) + "\n",
  );
  return { ok: true, humanInput: payload };
}

function maskHumanInputValue(value) {
  if (value.length <= 2) return "*".repeat(value.length);
  return `${value.slice(0, 1)}${"*".repeat(Math.max(1, value.length - 2))}${value.slice(-1)}`;
}

function parseExecutionEvents(stdout = "", stderr = "", adapter = "", job = {}, progress = "") {
  const businessEvents = parseProgressEvents(progress);
  if (businessEvents.length) {
    const terminal = [];
    if (job.run?.finishedAt) {
      terminal.push({
        time: job.run.finishedAt,
        status: job.status === "succeeded" ? "done" : job.status === "failed" ? "failed" : "info",
        label: `任务${job.status === "succeeded" ? "成功" : job.status === "failed" ? "失败" : "结束"}`,
        detail: job.run.error || "",
      });
    }
    return [...businessEvents, ...terminal].slice(-80);
  }

  const events = [];
  const push = (event) => {
    if (!event.label) return;
    const previous = events[events.length - 1];
    if (previous?.label === event.label && previous?.status === event.status) return;
    events.push({
      time: event.time || null,
      status: event.status || "info",
      label: event.label,
      detail: event.detail || "",
    });
  };

  if (job.createdAt) {
    push({ time: job.createdAt, status: "done", label: "任务已创建", detail: job.id || "" });
  }
  if (job.run?.startedAt) {
    push({
      time: job.run.startedAt,
      status: "running",
      label: job.run.adapter ? "adapter 开始执行" : "OpenCode 开始执行",
      detail: job.run.adapter ? "确定性 adapter" : (job.run.model || ""),
    });
  }

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let data = null;
    try {
      data = JSON.parse(line);
    } catch {
      push({ status: "info", label: "输出日志", detail: compactLine(line) });
      continue;
    }

    const time = normalizeEventTime(data.timestamp);
    if (data.type === "attempt_start") {
      push({
        time,
        status: "running",
        label: `第 ${data.attempt || "?"} 次模型尝试`,
        detail: data.model || "",
      });
      continue;
    }

    if (data.type === "step_start") {
      push({ time, status: "running", label: "OpenCode 进入新步骤" });
      continue;
    }

    if (data.type === "step_finish") {
      const reason = data.part?.reason || "";
      push({ time, status: "done", label: "OpenCode 完成一个步骤", detail: reason });
      continue;
    }

    if (data.type === "tool_use") {
      push(toolUseEvent(data, time));
    }
  }

  for (const rawLine of adapter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (key === "adapter") push({ status: "running", label: "adapter 已选择", detail: value });
    else if (key === "command") push({ status: "running", label: "执行脚本命令", detail: value });
    else if (key === "exit_code") push({ status: value === "0" ? "done" : "failed", label: "脚本执行结束", detail: `退出码 ${value}` });
    else if (key === "error") push({ status: "failed", label: "adapter 错误", detail: value });
  }

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    if (!line) continue;
    if (/permission requested/i.test(line)) {
      push({ status: "warning", label: "等待或拒绝权限", detail: compactLine(line) });
    } else if (/missing required outputs/i.test(line)) {
      push({ status: "failed", label: "输出文件校验失败", detail: compactLine(line) });
    } else if (/capacity|rate.?limit|overloaded/i.test(line)) {
      push({ status: "warning", label: "模型容量或限流", detail: compactLine(line) });
    } else if (/canceled by user/i.test(line)) {
      push({ status: "failed", label: "任务已被中断", detail: compactLine(line) });
    } else {
      push({ status: "warning", label: "错误输出", detail: compactLine(line) });
    }
  }

  if (job.run?.finishedAt) {
    push({
      time: job.run.finishedAt,
      status: job.status === "succeeded" ? "done" : job.status === "failed" ? "failed" : "info",
      label: `任务${job.status === "succeeded" ? "成功" : job.status === "failed" ? "失败" : "结束"}`,
      detail: job.run.error || "",
    });
  }

  return events.slice(-80);
}

function parseProgressEvents(progress = "") {
  const events = [];
  for (const rawLine of progress.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let data = null;
    try {
      data = JSON.parse(line);
    } catch {
      events.push({ time: null, status: "warning", label: "进度记录格式错误", detail: compactLine(line) });
      continue;
    }
    const label = data.label || businessStageLabel(data.stage);
    if (!label) continue;
    events.push({
      time: normalizeEventTime(data.time || data.timestamp),
      status: normalizeProgressStatus(data.status),
      label,
      detail: compactLine(data.detail || data.message || data.stage || ""),
      stage: data.stage || "",
    });
  }
  return events.slice(-80);
}

function businessStageLabel(stage) {
  const labels = {
    form_context: "准备表单上下文",
    browser: "连接浏览器",
    login: "登录态检查",
    fill_form: "填写表单",
    upload: "上传附件",
    captcha: "验证码识别",
    submit: "提交平台",
    extract_id: "提取平台编号",
    summary: "生成执行摘要",
  };
  return labels[stage] || stage || "";
}

function normalizeProgressStatus(status) {
  if (["running", "done", "failed", "warning", "info"].includes(status)) return status;
  if (status === "skipped") return "warning";
  if (status === "success" || status === "succeeded") return "done";
  if (status === "error") return "failed";
  return "info";
}

function toolUseEvent(data, time) {
  const part = data.part || {};
  const tool = part.tool || "tool";
  const state = part.state || {};
  const status = state.status || "running";
  const input = state.input || {};
  const output = typeof state.output === "string" ? state.output : "";
  const detail = toolDetail(tool, input, output);
  const eventStatus = /Could not connect|ECONNREFUSED|not found|failed|error/i.test(output)
    ? "failed"
    : status === "completed" ? "done" : status === "error" ? "failed" : "running";

  return {
    time,
    status: eventStatus,
    label: toolLabel(tool),
    detail,
  };
}

function toolLabel(tool) {
  if (tool === "skill") return "加载 skill";
  if (tool === "bash") return "执行命令";
  if (tool === "read") return "读取文件";
  if (tool === "write" || tool === "edit") return "写入文件";
  if (tool === "todowrite") return "更新执行清单";
  if (tool.startsWith("chrome-devtools-")) return "浏览器 MCP 操作";
  return `调用工具：${tool}`;
}

function toolDetail(tool, input, output) {
  if (tool === "skill") return input.name || "";
  if (tool === "bash") return input.description || input.command || compactLine(output);
  if (tool === "read") return input.filePath ? path.basename(input.filePath) : "";
  if (tool === "todowrite") return "执行步骤已更新";
  if (tool.startsWith("chrome-devtools-")) {
    const action = tool.replace(/^chrome-devtools-[^_]+_?/, "");
    return compactLine(output) || action || tool;
  }
  return compactLine(output);
}

function normalizeEventTime(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function compactLine(value, maxLength = 180) {
  const text = stripAnsi(String(value || "")).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
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

function requiredOutputsFor(template, mode) {
  const definition = TEMPLATES[template] || {};
  if (definition.requiredOutputsByMode) {
    return definition.requiredOutputsByMode[mode] || definition.requiredOutputsByMode.default || [];
  }
  return definition.requiredOutputs || [];
}

function isSubmitRun(job, template) {
  const definition = TEMPLATES[template] || {};
  return definition.outputCategory === "submission" && job.run?.options?.serviceConfig?.submit === true;
}

async function validateRequiredOutputs(job, template, mode = "") {
  const requiredOutputs = [...requiredOutputsFor(template, mode)];
  if (isSubmitRun(job, template) && !requiredOutputs.includes("submission-result.json")) {
    requiredOutputs.push("submission-result.json");
  }
  const missing = [];

  for (const relativePath of requiredOutputs) {
    const expectsDirectory = relativePath.endsWith("/");
    const target = safeJoin(job.paths.output, relativePath);
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat || (expectsDirectory ? !stat.isDirectory() : !stat.isFile())) {
      missing.push(`output/${relativePath}`);
    }
  }

  if (missing.length) {
    throw new Error(`template ${template} missing required outputs: ${missing.join(", ")}`);
  }
}

function matchesOutputPattern(filePath, pattern) {
  if (pattern === "*") return true;
  const lower = filePath.toLowerCase();
  const patternLower = pattern.toLowerCase();
  if (patternLower === lower || patternLower === path.basename(lower)) return true;
  if (patternLower.startsWith("*.")) {
    return lower.endsWith(patternLower.slice(1));
  }
  if (patternLower.endsWith("/**")) {
    const prefix = patternLower.slice(0, -3);
    return lower.startsWith(prefix + "/") || lower === prefix;
  }
  return false;
}

function groupOutputFilesByTemplate(files, outputGroups) {
  const claimed = new Set();
  const groups = outputGroups.map((groupDef) => {
    const matched = [];
    for (const file of files) {
      if (claimed.has(file.path)) continue;
      for (const pattern of groupDef.patterns) {
        if (matchesOutputPattern(file.path, pattern)) {
          matched.push(file);
          claimed.add(file.path);
          break;
        }
      }
    }
    return {
      key: groupDef.key,
      label: groupDef.label,
      icon: groupDef.icon || "",
      files: matched,
    };
  });
  return groups.filter((group) => group.files.length > 0);
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
      templates: Object.values(TEMPLATES),
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

  if (req.method === "POST" && parts.length === 3 && parts[2] === "cancel") {
    json(res, 202, await cancelJob(job));
    return;
  }

  if (req.method === "POST" && parts.length === 3 && parts[2] === "human-input") {
    const body = await readBody(req);
    json(res, 201, await writeHumanInput(job, body));
    return;
  }

  if (req.method === "GET" && parts.length === 3 && parts[2] === "logs") {
    json(res, 200, await readLogs(job));
    return;
  }

  if (req.method === "GET" && parts.length >= 4 && parts[2] === "logs") {
    const relativePath = decodePathSegments(parts.slice(3));
    const target = safeJoin(job.paths.logs, relativePath);
    const data = await fsp.readFile(target);
    const lower = target.toLowerCase();
    const contentType = lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
        ? "image/jpeg"
        : lower.endsWith(".webp")
          ? "image/webp"
          : "application/octet-stream";
    binary(res, 200, data, contentType);
    return;
  }

  if (req.method === "GET" && parts.length === 3 && parts[2] === "outputs") {
    const files = await listFiles(job.paths.output);
    const template = job.template || job.type || "custom";
    const definition = TEMPLATES[template] || {};
    const outputGroups = definition.outputGroups || null;
    const outputCategory = definition.outputCategory || null;
    const groups = outputGroups ? groupOutputFilesByTemplate(files, outputGroups) : null;
    json(res, 200, { files, template, outputCategory, groups });
    return;
  }

  if (req.method === "GET" && parts.length >= 4 && parts[2] === "outputs") {
    const relativePath = decodePathSegments(parts.slice(3));
    const target = safeJoin(job.paths.output, relativePath);
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": data.length,
      "Content-Disposition": contentDispositionAttachment(path.basename(target)),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
    return;
  }

  notFound(res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (
      error.message === "invalid job id" ||
      error.message === "job is not running" ||
      error.message.includes("required") ||
      error.message.includes("requires") ||
      error.message.includes("invalid")
    ) {
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

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`skills-api listening on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  TEMPLATES,
  complexSkillPrompt,
  contentDispositionAttachment,
  createJob,
  defaultPrompt,
  decodePathSegments,
  groupOutputFilesByTemplate,
  matchesOutputPattern,
  md2wechatPrompt,
  parseExecutionEvents,
  promptForRun,
  redactSensitiveText,
  resolveCreateTemplate,
  resolveRunTemplate,
  serviceConfig,
  safeRelativePath,
  cancelJob,
  validateRequiredOutputs,
  writeJob,
  writeServiceConfig,
};
