/**
 * Human input management — read, write, list human actions.
 * Extracted from server.js for maintainability.
 */

const path = require("node:path");
const fsp = require("node:fs/promises");

const HUMAN_INPUT_FILE = "human-input.json";
const SENSITIVE_KEYS = [
  "password",
  "cnvd_password",
  "cnvd_email",
  "cnnvd_password",
  "cnnvd_email",
  "cnnvd_username",
  "ncc_password",
  "ncc_username",
  "ncc_email",
  "platform_username",
  "platform_password",
  "report_upload_password",
  "dingtalk_webhook",
  "dingtalk_secret",
];

function maskHumanInputValue(value) {
  if (!value) return "";
  const str = String(value);
  if (str.length <= 4) return "*".repeat(str.length);
  return str.slice(0, 2) + "*".repeat(str.length - 4) + str.slice(-2);
}

function redactSensitiveText(value = "") {
  let text = String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/([?&]access_token=)[^&\s"']+/gi, "$1[REDACTED_TOKEN]")
    .replace(/\b(PASSWORD|TOKEN|SECRET|WEBHOOK)\s*=\s*[^\s]+/gi, (match) => {
      const [key] = match.split("=");
      return `${key}=*****`;
    })
    .replace(/\b(password|token|secret|webhook)\b\s*[:=]\s*[^\s,}]+/gi, "$1=*****");

  for (const key of SENSITIVE_KEYS) {
    text = redactPlainJsonValue(text, key);
    text = redactEscapedJsonValue(text, key);
  }
  return text;
}

function redactPlainJsonValue(text, key) {
  const pattern = new RegExp(`(["']?${key}["']?\\s*[:=]\\s*)(["'])[^"']*\\2`, "gi");
  return text.replace(pattern, (_match, prefix, quote) => `${prefix}${quote}*****${quote}`);
}

function redactEscapedJsonValue(text, key) {
  const onceEscaped = new RegExp(`(\\\\?"${key}\\\\?"\\s*[:=]\\s*\\\\?")[^"\\\\]*(\\\\?")`, "gi");
  const multiEscaped = new RegExp(`(\\\\+"${key}\\\\+"\\s*[:=]\\s*\\\\+")[^"\\\\]*(\\\\+")`, "gi");
  return text
    .replace(onceEscaped, "$1*****$2")
    .replace(multiEscaped, "$1*****$2");
}

async function readHumanInput(job) {
  const inputPath = path.join(job.paths.input, HUMAN_INPUT_FILE);
  try {
    return JSON.parse(await fsp.readFile(inputPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeHumanInput(job, body) {
  const inputPath = path.join(job.paths.input, HUMAN_INPUT_FILE);
  const value = String(body.value || body.code || body.text || body.captcha_value || "").trim();
  const payload = {
    ...body,
    value,
    code: value,
    text: value,
    captcha_value: value,
    status: body.status || "submitted",
    time: new Date().toISOString(),
  };
  await fsp.writeFile(inputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await appendHumanInputProgress(job, payload);
  return payload;
}

async function appendHumanInputProgress(job, payload) {
  const progressPath = path.join(job.paths.logs, "progress.jsonl");
  const event = {
    time: new Date().toISOString(),
    stage: payload.type === "confirmation" ? "cloudflare" : "captcha",
    status: "done",
    label: payload.type === "confirmation" ? "人工验证已确认" : "人工验证码已提交",
    detail: payload.type === "confirmation"
      ? "前端已确认人工验证完成。"
      : `前端已提交 ${payload.value ? String(payload.value).length : 0} 位验证码。`,
  };
  await fsp.appendFile(progressPath, JSON.stringify(event) + "\n", "utf8").catch(() => {});
}

async function listHumanActions(job) {
  const progressPath = path.join(job.paths.logs, "progress.jsonl");
  try {
    const submitted = await readHumanInput(job);
    const submittedAt = submitted?.time ? Date.parse(submitted.time) : 0;
    const content = await fsp.readFile(progressPath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          if (isPendingHumanAction(parsed)) {
            const actionAt = parsed.time ? Date.parse(parsed.time) : 0;
            if (submitted?.status === "submitted" && submittedAt >= actionAt) return null;
            return {
              time: parsed.time,
              stage: parsed.stage || "",
              label: parsed.label || "",
              detail: parsed.detail || "",
            };
          }
          return null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isPendingHumanAction(event = {}) {
  const status = String(event.status || "").toLowerCase();
  const text = [event.stage, event.label, event.detail, event.warning]
    .filter(Boolean)
    .join(" ");

  if (!["warning", "blocked", "waiting"].includes(status)) return false;
  if (/等待人工|人工.*验证码|human-input|human-cnvd-firewall/i.test(text)) return true;
  if (/防火墙|WAF|Cloudflare|Turnstile|验证码保护|CNVD_CAPTCHA_IMAGE_BROKEN/i.test(text)) return true;
  return false;
}

module.exports = {
  maskHumanInputValue,
  redactSensitiveText,
  readHumanInput,
  writeHumanInput,
  listHumanActions,
  isPendingHumanAction,
};
