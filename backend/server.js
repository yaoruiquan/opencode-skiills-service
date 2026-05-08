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

const TEMPLATES = {
  custom: {
    name: "custom",
    label: "自定义",
    description: "运行调用方提供的提示词，或使用通用默认提示词。",
    inputMode: "freeform",
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
  const mode = typeof options.mode === "string" && options.mode.trim()
    ? options.mode.trim()
    : (definition.modes || ["single"])[0];
  const brief = taskBrief(body) || "调用方未提供额外备注，请以 input 目录材料和 skill 固定流程为准。";
  const skillDir = path.join(SKILL_ROOT, definition.skill);
  const materialsDir = path.join(job.paths.input, "materials");
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
    "2. 所有脚本命令从 skill 目录执行，使用 python3。",
    "3. 不要使用或要求 macOS 绝对路径；所有服务输入只能来自本 job input 目录或任务备注中的 DAS-ID。",
    "4. 所有生成文件、状态文件、摘要和可下载产物必须复制或写入本 job output 目录。",
    "5. 运行过程中的关键命令、平台编号、失败原因和人工介入事项写入 output/summary.txt；临时脚本或调试文件写入 logs 目录，不要写入 /tmp。",
    "6. 最终回复必须列出输出文件、状态和下一步人工动作。",
  ];

  const specifics = {
    "vulnerability-alert-processor": [
      "模板要求：漏洞预警材料生成。",
      "1. 按 skill 规则先读 references/runtime-rules.md；需要完整流程时读 workflow、field-mapping、auto-determine、output-spec 和 notes。",
      "2. 如果 input 中已有 vuln-data JSON 和下载的 Word 模版，优先走阶段二报告生成：validate_vuln_data.py -> build_render_context.py -> render_markdown.py -> fill_word_template.py -> docx_to_pdf.py。",
      "3. 如果只有任务备注、CVE、漏洞标题或公告链接，按 skill 信息检索流程生成可追溯 vuln-data JSON，再继续处理。",
      "4. 如果需要浏览器阶段下载预警模版，使用已配置的 Chrome/MCP，不要直接跳过编辑保存和列表验证。",
      "5. 输出建议命名：output/final.md、output/final.docx、output/final.pdf、output/render_context.json、output/summary.txt。",
    ],
    "phase1-material-processor": [
      "模板要求：监管上报前材料整理。",
      "1. 输入材料应位于 input/materials；如果上传的是文件集合，先在 job 内整理出一个批次目录。",
      "2. 必须在 output/processed-materials 下创建重命名后的批次目录副本，不要直接把批次目录放在 output 根目录，不要修改 input 原件。",
      "3. 必须处理 CNVD/CNNVD docx 模版，执行 list/batch/single 对应模式；如果 skill 脚本缺失，必须在 output/summary.txt 记录缺失并以失败结束，不要只复制文件后报告成功。",
      "4. 必须验证 docx 修改点，并把处理摘要写入 output/summary.txt。",
      "5. 必须输出：output/processed-materials/、output/summary.txt。",
    ],
    "msrc-vulnerability-report": [
      "模板要求：MSRC 安全更新漏洞预警报告生成。",
      "1. 按 skill 规则先读 references/runtime-rules.md，再按场景读取 workflow.md 和 output-spec.md。",
      "2. 输入材料包必须来自 input/materials 或任务备注指定的 job 内相对路径，不要读取 ~/Downloads 或 macOS 绝对路径。",
      "3. 如果 input 中包含 critical-descriptions.json，先按 skill 规则保存并应用 CVSS>=9.0 漏洞描述。",
      "4. generate 模式执行 msrc_main.py -> generate_word_dynamic.py -> format_word.py -> convert_docx_to_pdf.py。",
      "5. publish 模式只有在 job 备注明确要求、且 skill .env 已在容器可用时才执行上传和钉钉通知；不要把 webhook、SSH 密码或服务器密钥写入 job 输出。",
      "6. 输出建议命名：output/report.md、output/report.docx、output/report.pdf、output/preview.html、output/summary.txt。",
    ],
    "cnvd-weekly-db-update": [
      "模板要求：CNVD 每周 XML 数据库更新。",
      "1. 按 skill 规则读取 SKILL.md、README.md 和 references/troubleshooting.md。",
      "2. 服务化任务不得读取 ~/Downloads；XML 文件必须上传到 input/xml 或在任务备注中说明已存在的 job 内路径。",
      "3. check 模式只检查 SSH 免密、Docker 目标环境和输入 XML，不执行真实更新。",
      "4. update 模式必须在任务备注明确授权后才执行远端上传、Docker cp、parse.py、归档和钉钉通知。",
      "5. SSH key、远端地址、钉钉 webhook 和密钥只能来自 skill 环境或服务器预配置，不要写入 job、日志或输出。",
      "6. 输出建议命名：output/summary.txt、output/update-result.json，并记录远端执行结果和人工后续动作。",
    ],
    "phase2-cnvd-report": [
      "模板要求：CNVD 平台上报。",
      "1. 使用 MCP 通道 chrome-devtools-cnvd，Chrome 调试端口 9332。",
      "2. 单个模式先运行 scripts/prepare_form_context.py，批量模式先运行 scripts/batch_report.py init/start-next。",
      "3. 浏览器填写阶段只读取 form_context.json、page_payloads 和 browser_helpers，不重新读取 Word 或临时判断字段。",
      "4. 验证码按 skill 的 captcha-ocr 规则处理；如需人工输入，在 logs/summary.txt 明确记录。",
      "5. 成功后记录 CNVD-ID；批量模式每条 record，全部完成后只 notify 一次。",
    ],
    "phase2-cnnvd-report": [
      "模板要求：CNNVD 平台上报。",
      "1. 使用 MCP 通道 chrome-devtools-cnnvd，Chrome 调试端口 9333。",
      "2. 单个模式先运行 scripts/prepare_form_context.py，批量模式先运行 scripts/batch_report.py init/start-next。",
      "3. 第 1 页下拉和所有文本字段只按 dropdown_plan 与 page_payloads 填写。",
      "4. 上传 verification_video_path 和 poc_file_path 指向的材料，不重新压缩或临时查找文件。",
      "5. 成功后记录 CNNVD-ID；需要维护汇总表时按 references/summary-table.md 执行。",
    ],
    "phase2-ncc-report": [
      "模板要求：NCC 平台上报。",
      "1. 使用 MCP 通道 chrome-devtools-ncc，Chrome 调试端口 9334。",
      "2. 先运行 scripts/prepare_form_context.py 生成 form_context.json，浏览器阶段只读这个文件。",
      "3. 打开 NCC 企业中心并进入提交漏洞表单；如果出现拖拽拼图验证，记录为人工介入步骤。",
      "4. 上传 form_context.json 中的 upload_zip_path，成功后记录 NCC 编号。",
      "5. 输出建议命名：output/form_context.json、output/submission-result.json、output/summary.txt。",
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

  if (template === "md2wechat") {
    return md2wechatPrompt(job);
  }

  if (TEMPLATES[template]) {
    return complexSkillPrompt(job, template, body, await listFiles(job.paths.input));
  }

  throw new Error(`invalid template: ${template}`);
}

async function runJob(job, body) {
  if (job.status === "running") {
    throw new Error("job is already running");
  }

  const template = resolveRunTemplate(job, body);
  const prompt = await promptForRun(job, body, template);
  const requestedModels = Array.isArray(body.models) ? body.models : [];
  const modelCandidates = [...requestedModels, body.model || DEFAULT_MODEL, ...FALLBACK_MODELS]
    .filter((model) => typeof model === "string" && model.trim())
    .map((model) => model.trim())
    .filter((model, index, models) => models.indexOf(model) === index);
  const stdoutPath = path.join(job.paths.logs, "run.jsonl");
  const stderrPath = path.join(job.paths.logs, "stderr.log");
  const startedAt = now();
  const options = runOptions(body);

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
      try {
        await validateRequiredOutputs(latest, latest.run.template);
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

async function validateRequiredOutputs(job, template) {
  const definition = TEMPLATES[template] || {};
  const requiredOutputs = definition.requiredOutputs || [];
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

  if (req.method === "GET" && parts.length === 3 && parts[2] === "logs") {
    json(res, 200, await readLogs(job));
    return;
  }

  if (req.method === "GET" && parts.length === 3 && parts[2] === "outputs") {
    json(res, 200, { files: await listFiles(job.paths.output) });
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
  md2wechatPrompt,
  promptForRun,
  resolveCreateTemplate,
  resolveRunTemplate,
  safeRelativePath,
  validateRequiredOutputs,
};
