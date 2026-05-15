/**
 * Output parsing, event extraction, and output validation.
 * Extracted from server.js for maintainability.
 */

const path = require("node:path");
const fsp = require("node:fs/promises");
const { listFiles } = require("./jobs-crud.js");
const { requiredOutputsFor } = require("./templates.js");

function parseExecutionEvents(stdout = "", stderr = "", adapter = "", job = {}, progress = "") {
  const progressEvents = parseProgressEvents(progress).map(progressEvent);
  if (adapter === "adapter") {
    return progressEvents;
  }
  return mergeEvents(progressEvents, parseLLMEvents(stdout, stderr));
}

function parseAdapterEvents(progress = "") {
  return parseProgressEvents(progress).map(progressEvent);
}

function progressEvent(entry) {
  return {
    time: entry.time,
    type: "progress",
    stage: entry.stage || "",
    status: normalizeProgressStatus(entry.status),
    label: entry.label || businessStageLabel(entry.stage || ""),
    detail: entry.detail || entry.label || "",
  };
}

function mergeEvents(progressEvents, llmEvents) {
  const seen = new Set();
  const result = [];
  for (const event of [...progressEvents, ...llmEvents]) {
    const key = [
      event.time || "",
      event.type || "",
      event.stage || "",
      event.status || "",
      event.label || "",
      event.detail || "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result.sort((a, b) => {
    const at = Date.parse(a.time || "") || 0;
    const bt = Date.parse(b.time || "") || 0;
    return at - bt;
  });
}

function parseLLMEvents(stdout = "", stderr = "") {
  const events = [];
  const inferredEvents = [];
  const inferredKeys = new Set();
  let stepCount = 0;
  for (const line of stdout.split("\n").filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "step_start") {
        stepCount += 1;
        events.push({
          time: normalizeEventTime(parsed.timestamp || parsed.time),
          type: "step",
          status: "running",
          label: `OpenCode 步骤 ${stepCount}`,
          detail: parsed.sessionID ? `session: ${parsed.sessionID}` : "",
        });
      } else if (parsed.type === "step_finish") {
        const tokens = parsed.part?.tokens;
        const detail = tokens
          ? `tokens: ${tokens.total || 0} (input ${tokens.input || 0}, output ${tokens.output || 0})`
          : parsed.part?.reason || "";
        events.push({
          time: normalizeEventTime(parsed.timestamp || parsed.time),
          type: "step",
          status: "done",
          label: "OpenCode 步骤完成",
          detail,
        });
      } else if (parsed.type === "progress" || parsed.stage) {
        events.push({
          time: normalizeEventTime(parsed.time),
          type: "progress",
          stage: parsed.stage || "",
          status: normalizeProgressStatus(parsed.status),
          label: businessStageLabel(parsed.stage || ""),
          detail: parsed.detail || parsed.label || "",
        });
      } else if (parsed.type === "step_result" || parsed.type === "tool_use") {
        events.push(toolUseEvent(parsed, normalizeEventTime(parsed.time)));
      }
      const inferred = inferBusinessEvent(parsed);
      if (inferred) {
        const key = `${inferred.stage}:${inferred.status}:${inferred.detail}`;
        if (!inferredKeys.has(key)) {
          inferredKeys.add(key);
          inferredEvents.push(inferred);
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }
  if (stderr && /missing required outputs/i.test(stderr)) {
    inferredEvents.push({
      time: new Date().toISOString(),
      type: "validation",
      stage: "summary",
      status: "failed",
      label: "输出文件校验失败",
      detail: compactLine(stderr, 220),
    });
  }
  return inferredEvents.length ? [...inferredEvents, ...events] : events;
}

function parseProgressEvents(progress = "") {
  if (!progress) return [];
  const lines = typeof progress === "string" ? progress.split("\n").filter(Boolean) : [];
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

function businessStageLabel(stage) {
  const labels = {
    prepare: "准备任务",
    form_context: "准备表单上下文",
    browser: "浏览器自动化",
    login: "登录平台",
    cloudflare: "人机验证",
    fill_form: "填写表单",
    upload: "上传附件",
    captcha: "验证码识别",
    submit: "提交表单",
    extract_id: "提取编号",
    summary: "生成摘要",
  };
  return labels[stage] || stage;
}

function inferBusinessEvent(data) {
  const part = data.part || {};
  if (!["tool_use", "text"].includes(data.type)) return null;
  if (data.type === "tool_use" && !["bash", "todowrite"].includes(part.tool || "") && !String(part.tool || "").startsWith("chrome-devtools-")) {
    return null;
  }
  const text = collectEventText(data);
  if (!text) return null;
  const lower = text.toLowerCase();
  const time = normalizeEventTime(data.timestamp || data.time);
  const state = part.state || {};
  const failureText = [state.output, state.metadata?.output, state.status].filter(Boolean).join(" ");
  const failed = /error|failed|could not|econnrefused|target closed|timeout|未找到|无法|失败/i.test(failureText);

  if (/CNVD_CAPTCHA_IMAGE_BROKEN/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "cloudflare",
      status: "running",
      label: "防火墙验证码 OCR",
      detail: "CNVD 提交验证码图片未加载成功，疑似 /common/myCodeNew 被防火墙验证码拦截，正在先尝试 OCR 识别。",
    };
  }

  if (/INVALID_OCR_TEXT/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "captcha",
      status: "failed",
      label: "验证码识别失败",
      detail: "OCR 结果像页面占位文字，不是真实验证码，已阻止提交。",
    };
  }

  if (/field integrity|完整性检查|all fields pass/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "fill_form",
      status: failed ? "failed" : "done",
      label: "表单字段校验",
      detail: failed ? "表单字段完整性检查失败。" : "表单字段已填写并通过完整性检查。",
    };
  }

  if (/本站开启了验证码保护|请输入验证码|验证码|captcha/i.test(text)) {
    const wafCaptcha = /本站开启了验证码保护|请输入验证码，以继续访问|防火墙|waf|cloudflare|turnstile/i.test(text);
    return {
      time,
      type: "progress",
      stage: wafCaptcha ? "cloudflare" : "captcha",
      status: failed ? "failed" : "running",
      label: wafCaptcha ? "防火墙验证码 OCR" : "验证码识别",
      detail: wafCaptcha
        ? "CNVD 页面进入访问验证码保护，正在先尝试 OCR 识别；连续 3 次未通过后再切换前端人工。"
        : "任务正在调用 skill 内验证码识别脚本处理登录或提交验证码。",
    };
  }

  if (/cloudflare|turnstile|人机|防火墙|waf/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "cloudflare",
      status: "warning",
      label: "人机验证",
      detail: "页面触发人机验证或防火墙校验，自动化流程正在尝试处理。",
    };
  }

  if (/login|登录|password|username|email/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "login",
      status: failed ? "failed" : "running",
      label: "登录平台",
      detail: failed ? "登录或登录态检查失败。" : "正在执行登录或登录态检查。",
    };
  }

  if (/prepare_form_context|form_context|表单上下文/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "form_context",
      status: failed ? "failed" : "done",
      label: "准备表单上下文",
      detail: failed ? "表单上下文准备失败。" : "已执行表单上下文准备步骤。",
    };
  }

  if (/flaw\/create|填写|填表|fill|form|表单/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: failed ? "form_context" : "fill_form",
      status: failed ? "failed" : "running",
      label: failed ? "打开上报表单失败" : "填写表单",
      detail: failed ? "未能进入上报表单页面。" : "正在进入或填写上报表单。",
    };
  }

  if (/upload|上传|附件|zip|docx|poc/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "upload",
      status: failed ? "failed" : "running",
      label: "上传附件",
      detail: failed ? "附件上传步骤失败。" : "正在处理或上传附件。",
    };
  }

  if (/submit|提交/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "submit",
      status: failed ? "failed" : "running",
      label: "提交表单",
      detail: failed ? "提交步骤失败。" : "正在执行提交步骤。",
    };
  }

  if (/extract|编号|cnvd-\d|cnnvd-\d/i.test(text)) {
    return {
      time,
      type: "progress",
      stage: "extract_id",
      status: failed ? "failed" : "done",
      label: "提取编号",
      detail: failed ? "提取平台编号失败。" : "正在提取或记录平台编号。",
    };
  }

  if (/chrome-devtools|browser|chrome|mcp|list_pages|take_snapshot|new_page|navigate/i.test(lower)) {
    return {
      time,
      type: "progress",
      stage: "browser",
      status: failed ? "failed" : "running",
      label: "浏览器自动化",
      detail: failed ? compactLine(text, 220) : "正在通过 Chrome DevTools 控制浏览器。",
    };
  }

  return null;
}

function collectEventText(data) {
  const part = data.part || {};
  const state = part.state || {};
  return [
    data.type,
    part.tool,
    part.title,
    part.text,
    state.title,
    state.input?.command,
    state.input?.description,
    state.input?.url,
    state.output,
    state.metadata?.output,
    state.metadata?.description,
  ]
    .filter(Boolean)
    .map((item) => compactLine(item, 500))
    .join(" ");
}

function normalizeProgressStatus(status) {
  if (!status) return "running";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "warning") return "warning";
  if (status === "blocked" || status === "waiting") return "warning";
  return "running";
}

function toolUseEvent(data, time) {
  const part = data.part || {};
  const state = part.state || {};
  const tool = data.tool || data.step?.tool || part.tool || {};
  return {
    time: normalizeEventTime(data.timestamp || data.time || time),
    type: "tool",
    tool: toolLabel(tool),
    label: toolLabel(tool) === "unknown" ? "工具调用" : `工具调用：${toolLabel(tool)}`,
    detail: toolDetail(tool, data.input || data.step?.input || state.input, data.output || data.step?.output || state.output || state.metadata),
    duration: data.duration || data.step?.duration || state.time?.end && state.time?.start ? state.time.end - state.time.start : 0,
    status: data.isError || state.status === "error" || state.status === "failed" ? "failed" : state.status === "running" ? "running" : "done",
  };
}

function toolLabel(tool) {
  if (!tool) return "unknown";
  if (typeof tool === "string") return tool;
  return tool.name || tool.server_name || tool.serverName || "unknown";
}

function toolDetail(tool, input, output) {
  if (!tool) return "";
  const parts = [];
  if (tool.server_name || tool.serverName) parts.push(`[${tool.server_name || tool.serverName}]`);
  if (tool.name) parts.push(tool.name);
  if (input?.command) parts.push(`command: ${compactLine(input.command)}`);
  if (input?.description) parts.push(compactLine(input.description));
  if (input?.filePath) parts.push(input.filePath);
  if (input?.url) parts.push(input.url);
  if (input?.text) parts.push(compactLine(input.text));
  if (typeof output === "string") parts.push(compactLine(output));
  if (output?.title) parts.push(compactLine(output.title));
  if (output?.filepath) parts.push(output.filepath);
  return parts.join(" ") || "";
}

function normalizeEventTime(value) {
  if (!value) return new Date().toISOString();
  try {
    const date = new Date(value);
    return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function compactLine(value, maxLength = 180) {
  if (!value) return "";
  const cleaned = stripAnsi(String(value)).replace(/\s+/g, " ").trim();
  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength) + "...";
}

function stripAnsi(value) {
  if (!value) return "";
  return String(value).replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][0-9;]*[a-zA-Z]/g, "");
}

async function readProgress(job) {
  try {
    const progressPath = path.join(job.paths.logs, "progress.jsonl");
    return await fsp.readFile(progressPath, "utf8");
  } catch {
    return "";
  }
}

async function validateRequiredOutputs(job, template, mode = "", TEMPLATES) {
  const required = requiredOutputsFor(template, mode, TEMPLATES);
  if (!required.length) return null;

  const outputs = await listFiles(job.paths.output);
  const missing = [];
  const found = [];

  for (const pattern of required) {
    const matched = outputs.filter((f) => matchesOutputPattern(f.path, pattern));
    if (matched.length > 0) {
      found.push(...matched);
    } else if (pattern.endsWith("/")) {
      const target = path.join(job.paths.output, pattern);
      try {
        const stat = await fsp.stat(target);
        if (stat.isDirectory()) {
          found.push({ path: pattern, size: 0, mtime: stat.mtime.toISOString() });
          continue;
        }
        missing.push(pattern);
      } catch {
        missing.push(pattern);
      }
    } else {
      missing.push(pattern);
    }
  }

  return {
    required,
    missing,
    found: [...new Set(found)],
    ok: missing.length === 0,
  };
}

function matchesOutputPattern(filePath, pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  // Directory pattern (ends with /)
  if (normalized.endsWith("/")) {
    return filePath.startsWith(normalized) || filePath.startsWith(normalized.slice(0, -1));
  }
  // Glob pattern with **
  if (normalized.includes("**")) {
    const regex = new RegExp("^" + normalized.replace(/\*\*/g, ".+").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$");
    return regex.test(filePath);
  }
  // Simple glob
  if (normalized.includes("*")) {
    const regex = new RegExp("^" + normalized.replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$");
    return regex.test(path.basename(filePath));
  }
  // Exact match or basename match
  return filePath === normalized || path.basename(filePath) === normalized;
}

function groupOutputFilesByTemplate(files, outputGroups) {
  if (!outputGroups) return [];
  return outputGroups.map((group) => ({
    key: group.key,
    label: group.label,
    icon: group.icon,
    files: files.filter((f) => group.patterns.some((p) => matchesOutputPattern(f.path, p))),
  }));
}

module.exports = {
  parseExecutionEvents,
  parseProgressEvents,
  parseAdapterEvents,
  parseLLMEvents,
  businessStageLabel,
  normalizeProgressStatus,
  toolUseEvent,
  toolLabel,
  toolDetail,
  normalizeEventTime,
  compactLine,
  stripAnsi,
  readProgress,
  validateRequiredOutputs,
  requiredOutputsFor,
  matchesOutputPattern,
  groupOutputFilesByTemplate,
};
