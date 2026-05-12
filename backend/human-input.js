/**
 * Human input management — read, write, list human actions.
 * Extracted from server.js for maintainability.
 */

const path = require("node:path");
const fsp = require("node:fs/promises");

const HUMAN_INPUT_FILE = "human-input.json";

function maskHumanInputValue(value) {
  if (!value) return "";
  const str = String(value);
  if (str.length <= 4) return "*".repeat(str.length);
  return str.slice(0, 2) + "*".repeat(str.length - 4) + str.slice(-2);
}

function redactSensitiveText(value = "") {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/([?&]access_token=)[^&\s"']+/gi, "$1[REDACTED_TOKEN]")
    .replace(/\b(PASSWORD|TOKEN|SECRET|WEBHOOK)\s*=\s*[^\s]+/gi, (match) => {
      const [key] = match.split("=");
      return `${key}=*****`;
    })
    .replace(/["']?password["']?\s*[:=]\s*["'][^"']+["']/gi, (match) => {
      const prefix = match.match(/^["']?password["']?\s*[:=]\s*["']?/i)?.[0] || "";
      return `${prefix}*****"`;
    })
    .replace(/["']?(cnvd_password|cnvd_email|cnnvd_password|cnnvd_email|cnnvd_username|ncc_password|ncc_username|ncc_email|platform_username|platform_password|report_upload_password|dingtalk_webhook|dingtalk_secret)["']?\s*[:=]\s*["'][^"']+["']/gi, (match) => {
      const prefix = match.match(/^["']?[^"']*["']?\s*[:=]\s*["']?/i)?.[0] || "";
      return `${prefix}*****"`;
    });
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
          if (parsed.status === "warning" && parsed.label?.includes("等待人工")) {
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

module.exports = {
  maskHumanInputValue,
  redactSensitiveText,
  readHumanInput,
  writeHumanInput,
  listHumanActions,
};
