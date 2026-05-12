#!/usr/bin/env node

const fs = require("node:fs/promises");

const API = process.env.SKILLS_API_BASE || "http://127.0.0.1:4100";
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "";

const BUSINESS_TEMPLATES = [
  "md2wechat",
  "vulnerability-alert-processor",
  "phase1-material-processor",
  "msrc-vulnerability-report",
  "cnvd-weekly-db-update",
  "phase2-cnvd-report",
  "phase2-cnnvd-report",
  "phase2-ncc-report",
];

async function request(path) {
  const res = await fetch(`${API}${path}`);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${res.status} ${path}: ${data.error || text}`);
  return data;
}

function requiredOutputs(template, job) {
  const mode = job?.run?.options?.mode || job?.run?.options?.serviceConfig?.mode || "";
  const byMode = template.requiredOutputsByMode || {};
  if (mode && byMode[mode]) return byMode[mode];
  return template.requiredOutputs || [];
}

function matches(filePath, pattern) {
  if (pattern.endsWith("/")) return filePath.startsWith(pattern);
  if (pattern.endsWith("/**")) return filePath.startsWith(pattern.slice(0, -3));
  if (pattern.includes("*")) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(filePath) || new RegExp(`^${escaped}$`).test(filePath.split("/").pop() || "");
  }
  return filePath === pattern || filePath.endsWith(`/${pattern}`);
}

function statusOf(job, missing) {
  if (!job) return "未执行";
  if (job.effectiveStatus === "submitted") return "通过";
  if (["failed", "canceled"].includes(job.status)) return "失败";
  if (["completed", "succeeded"].includes(job.status) && missing.length === 0) return "通过";
  if (["completed", "succeeded"].includes(job.status)) return "部分通过";
  return "运行中";
}

function latestJob(jobs, templateName) {
  return jobs
    .filter((job) => job.template === templateName && job.run)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))[0];
}

function failurePoint(job) {
  if (!job) return "没有找到该模板的执行记录";
  if (!["failed", "canceled"].includes(job.status)) return "";
  const failedEvent = [...(job.events || [])].reverse().find((event) => ["failed", "warning"].includes(event.status));
  return job.run?.error || failedEvent?.detail || job.submissionResult?.error || "";
}

function stageCoverage(job, template) {
  const expected = template.stateMachine || [];
  if (!expected.length) return "";
  const seen = new Set((job?.events || []).map((event) => event.stage).filter(Boolean));
  const covered = expected.filter((stage) => seen.has(stage));
  return `${covered.length}/${expected.length}`;
}

async function main() {
  const health = await request("/health");
  const jobsResponse = await request("/jobs");
  const jobs = jobsResponse.jobs || [];
  const rows = [];

  for (const name of BUSINESS_TEMPLATES) {
    const template = health.templates[name];
    const jobSummary = latestJob(jobs, name);
    const job = jobSummary ? await request(`/jobs/${jobSummary.id}`) : null;
    const outputs = job ? (await request(`/jobs/${job.id}/outputs`)).files || [] : [];
    const required = template ? requiredOutputs(template, job) : [];
    const missing = required.filter((pattern) => !outputs.some((file) => matches(file.path, pattern)));
    rows.push({
      name,
      label: template?.label || name,
      job,
      status: statusOf(job, missing),
      required,
      missing,
      outputs,
      stageCoverage: stageCoverage(job, template || {}),
      failurePoint: failurePoint(job),
    });
  }

  const now = new Date().toISOString();
  const lines = [
    "# Skill 验收审计记录",
    "",
    `生成时间：${now}`,
    `API：${API}`,
    "",
    "本记录按当前服务器 job 列表逐个审计 8 个业务 skill 的最新执行记录，不复用旧结论。",
    "",
    "| Skill | 最新状态 | Job ID | 必需输出缺失 | 浏览器阶段覆盖 | 失败/阻塞点 |",
    "|---|---|---|---|---|---|",
  ];

  for (const row of rows) {
    lines.push([
      `\`${row.name}\``,
      row.status,
      row.job ? `\`${row.job.id}\`` : "-",
      row.missing.length ? row.missing.map((item) => `\`${item}\``).join("<br>") : "无",
      row.stageCoverage || "-",
      row.failurePoint ? row.failurePoint.replace(/\|/g, "\\|").slice(0, 180) : "-",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push("", "## 详细输出", "");
  for (const row of rows) {
    lines.push(`### ${row.label} (${row.name})`, "");
    if (!row.job) {
      lines.push("- 未找到执行记录。", "");
      continue;
    }
    lines.push(`- Job：\`${row.job.id}\``);
    lines.push(`- 状态：${row.job.status} / ${row.job.effectiveStatus || row.job.status}`);
    lines.push(`- 更新时间：${row.job.updatedAt}`);
    lines.push(`- 输出文件数：${row.outputs.length}`);
    if (row.missing.length) lines.push(`- 缺失输出：${row.missing.join(", ")}`);
    if (row.failurePoint) lines.push(`- 失败/阻塞点：${row.failurePoint}`);
    const latestEvents = (row.job.events || []).slice(-8);
    if (latestEvents.length) {
      lines.push("- 最近事件：");
      for (const event of latestEvents) {
        lines.push(`  - ${event.stage || event.type || "event"} / ${event.status || ""}：${event.label || ""}${event.detail ? ` - ${event.detail}` : ""}`);
      }
    }
    lines.push("");
  }

  const markdown = lines.join("\n");
  if (OUT) {
    await fs.writeFile(OUT, markdown + "\n", "utf8");
  } else {
    process.stdout.write(markdown + "\n");
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
