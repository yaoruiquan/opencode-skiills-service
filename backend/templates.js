/**
 * Template definitions for all skills.
 * Extracted from server.js for maintainability.
 */

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
      platform_username: "",
      platform_password: "",
      report_upload_host: "",
      report_upload_user: "root",
      report_upload_password: "",
      dingtalk_webhook: "",
      dingtalk_secret: "",
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
    recommendedInputs: ["xml/*.xml"],
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
      cnvd_email: "",
      cnvd_password: "",
      submit: false,
      dingtalk_notify: false,
    },
    outputCategory: "submission",
    stateMachine: ["prepare", "form_context", "browser", "login", "cloudflare", "captcha", "fill_form", "upload", "submit", "extract_id", "summary"],
    serviceContract: {
      requiredInputs: ["input/materials/**", "input/service-config.json"],
      requiredProgress: ["prepare", "form_context", "browser", "login", "captcha", "fill_form", "upload", "submit", "extract_id", "summary"],
      successOutput: "submission-result.json",
      successFields: ["cnvd_id", "submission_id", "submission_url"],
      failureOutput: "summary.txt",
      browserProfile: "docker-chrome-profiles/cnvd-report",
      captchaPolicy: "CNVD 防火墙/WAF 访问验证码先使用 skill 内 captcha_ocr.py 自动识别，最多尝试 3 次；3 次仍未通过或无法取得真实验证码图片时再切换前端人工。登录验证码和提交验证码也优先使用 skill 内 captcha_ocr.py。",
    },
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
      cnnvd_email: "",
      cnnvd_password: "",
      entity_description: "",
      verification: "",
      submit: false,
      update_summary: false,
      dingtalk_notify: false,
    },
    outputCategory: "submission",
    stateMachine: ["prepare", "form_context", "browser", "login", "captcha", "fill_form", "upload", "submit", "extract_id", "summary"],
    serviceContract: {
      requiredInputs: ["input/materials/**", "input/service-config.json"],
      requiredProgress: ["prepare", "form_context", "browser", "login", "captcha", "fill_form", "upload", "submit", "extract_id", "summary"],
      successOutput: "submission-result.json",
      successFields: ["cnnvd_id", "submission_id", "submission_url"],
      failureOutput: "summary.txt",
      browserProfile: "docker-chrome-profiles/cnnvd-report",
      captchaPolicy: "按 phase2-cnnvd-report skill 内脚本和说明处理验证码。",
    },
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
      ncc_username: "",
      ncc_password: "",
      prefer_source: "CNVD",
      submit: false,
      dingtalk_notify: false,
    },
    outputCategory: "submission",
    stateMachine: ["prepare", "form_context", "browser", "login", "captcha", "fill_form", "upload", "submit", "extract_id", "summary"],
    serviceContract: {
      requiredInputs: ["input/materials/**", "input/service-config.json"],
      requiredProgress: ["prepare", "form_context", "browser", "login", "captcha", "fill_form", "upload", "submit", "extract_id", "summary"],
      successOutput: "submission-result.json",
      successFields: ["ncc_id", "submission_id", "submission_url"],
      failureOutput: "summary.txt",
      browserProfile: "docker-chrome-profiles/ncc-report",
      captchaPolicy: "按 phase2-ncc-report skill 内脚本和说明处理验证码；需要人工拖拽时返回前端截图和人工动作。",
    },
    outputGroups: [
      { key: "result", label: "上报结果", icon: "✅", patterns: ["submission-result.json"] },
      { key: "context", label: "表单上下文", icon: "🔧", patterns: ["form_context.json"] },
      { key: "summary", label: "执行摘要", icon: "📋", patterns: ["summary.txt"] },
      { key: "other", label: "其他文件", icon: "📁", patterns: ["*"] },
    ],
  },
};

function knownTemplate(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

function resolveCreateTemplate(body) {
  if (typeof body.template === "string" && body.template.trim()) {
    const template = body.template.trim();
    if (!knownTemplate(template)) throw new Error(`invalid template: ${template}`);
    return template;
  }
  if (typeof body.type === "string" && knownTemplate(body.type.trim())) return body.type.trim();
  return "custom";
}

function resolveRunTemplate(job, body) {
  if (typeof body.template === "string" && body.template.trim()) {
    const template = body.template.trim();
    if (!knownTemplate(template)) throw new Error(`invalid template: ${template}`);
    return template;
  }
  return job.template || "custom";
}

function runMode(template, body) {
  const definition = TEMPLATES[template] || {};
  const options = runOptions(body);
  return typeof options.mode === "string" && options.mode.trim()
    ? options.mode.trim()
    : (definition.modes || ["single"])[0];
}

function runOptions(body) {
  if (body && typeof body.options === "object" && body.options !== null && !Array.isArray(body.options)) {
    return body.options;
  }
  if (body && typeof body.config === "object" && body.config !== null && !Array.isArray(body.config)) {
    return body.config;
  }
  return {};
}

function serviceConfig(body) {
  const options = runOptions(body);
  return typeof options.serviceConfig === "object" && options.serviceConfig !== null
    ? options.serviceConfig
    : options;
}

function taskBrief(body) {
  const options = runOptions(body);
  return typeof options.taskBrief === "string" ? options.taskBrief.trim() : "";
}

function requiredOutputsFor(template, mode) {
  const definition = TEMPLATES[template];
  if (!definition) return [];
  if (definition.requiredOutputsByMode && mode) return definition.requiredOutputsByMode[mode] || [];
  return definition.requiredOutputs || [];
}

module.exports = {
  TEMPLATES,
  knownTemplate,
  resolveCreateTemplate,
  resolveRunTemplate,
  runMode,
  runOptions,
  serviceConfig,
  taskBrief,
  requiredOutputsFor,
};
