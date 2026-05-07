const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.SKILLS_API_JOBS_ROOT = path.join(os.tmpdir(), `skills-api-test-${process.pid}`);

const {
  createJob,
  complexSkillPrompt,
  md2wechatPrompt,
  promptForRun,
  resolveCreateTemplate,
  resolveRunTemplate,
} = require("./server");

test.after(async () => {
  await fs.rm(process.env.SKILLS_API_JOBS_ROOT, { recursive: true, force: true });
});

test("resolves md2wechat template from explicit template or known type", () => {
  assert.equal(resolveCreateTemplate({ template: "md2wechat" }), "md2wechat");
  assert.equal(resolveCreateTemplate({ type: "md2wechat" }), "md2wechat");
  assert.equal(resolveCreateTemplate({ template: "phase2-cnvd-report" }), "phase2-cnvd-report");
  assert.equal(resolveCreateTemplate({ template: "msrc-vulnerability-report" }), "msrc-vulnerability-report");
  assert.equal(resolveCreateTemplate({ template: "cnvd-weekly-db-update" }), "cnvd-weekly-db-update");
  assert.equal(resolveCreateTemplate({ type: "one-off" }), "custom");
  assert.throws(() => resolveCreateTemplate({ template: "unknown" }), /invalid template/);
});

test("run template can override job template and rejects unknown values", async () => {
  const job = await createJob({ type: "custom" });

  assert.equal(resolveRunTemplate(job, {}), "custom");
  assert.equal(resolveRunTemplate(job, { template: "md2wechat" }), "md2wechat");
  assert.throws(() => resolveRunTemplate(job, { template: "unknown" }), /invalid template/);
});

test("md2wechat template requires input article and owns the prompt", async () => {
  const job = await createJob({ type: "md2wechat" });

  await assert.rejects(
    () => promptForRun(job, { template: "md2wechat" }, "md2wechat"),
    /requires input\/article\.md/,
  );

  await fs.writeFile(path.join(job.paths.input, "article.md"), "# 测试标题\n\n测试正文\n", "utf8");

  await assert.rejects(
    () => promptForRun(job, { template: "md2wechat", prompt: "custom" }, "md2wechat"),
    /does not accept a custom prompt/,
  );

  const prompt = await promptForRun(job, { template: "md2wechat" }, "md2wechat");
  assert.match(prompt, /render_wechat_article\.py/);
  assert.match(prompt, /render_alert_cover\.py/);
  assert.match(prompt, new RegExp(`${job.paths.output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*wechat-article\\.html`));
  assert.match(prompt, /不要上传公众号草稿箱/);
});

test("md2wechat prompt writes outputs under the job directories", async () => {
  const job = await createJob({ template: "md2wechat" });
  const prompt = md2wechatPrompt(job);

  assert.match(prompt, new RegExp(`${job.paths.input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*article\\.md`));
  assert.match(prompt, new RegExp(`${job.paths.output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*wechat-cover\\.png`));
  assert.match(prompt, new RegExp(`${job.paths.logs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*render_wechat_article\\.json`));
});

test("complex templates require uploaded input files or a task brief", async () => {
  const job = await createJob({ template: "phase2-cnvd-report" });

  await assert.rejects(
    () => promptForRun(job, { template: "phase2-cnvd-report" }, "phase2-cnvd-report"),
    /requires uploaded input files or options\.taskBrief/,
  );

  const prompt = await promptForRun(
    job,
    {
      template: "phase2-cnvd-report",
      options: {
        mode: "single",
        taskBrief: "上报 DAS-T100001",
      },
    },
    "phase2-cnvd-report",
  );

  assert.match(prompt, /phase2-cnvd-report skill/);
  assert.match(prompt, /chrome-devtools-cnvd/);
  assert.match(prompt, /9332/);
  assert.match(prompt, /上报 DAS-T100001/);
  assert.match(prompt, new RegExp(job.paths.output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("complex templates include uploaded input files in the prompt", async () => {
  const job = await createJob({ template: "phase1-material-processor" });
  await fs.mkdir(path.join(job.paths.input, "materials", "DAS-T100001-demo"), { recursive: true });
  await fs.writeFile(path.join(job.paths.input, "materials", "DAS-T100001-demo", "report.docx"), "placeholder");

  const prompt = await promptForRun(
    job,
    {
      template: "phase1-material-processor",
      options: { mode: "batch" },
    },
    "phase1-material-processor",
  );

  assert.match(prompt, /phase1-material-processor skill/);
  assert.match(prompt, /input\/materials\/DAS-T100001-demo\/report\.docx/);
  assert.match(prompt, /processed-materials/);
});

test("complexSkillPrompt uses job paths and mode options", async () => {
  const job = await createJob({ template: "vulnerability-alert-processor" });
  const prompt = complexSkillPrompt(
    job,
    "vulnerability-alert-processor",
    { options: { mode: "report-only", taskBrief: "只生成报告" } },
    [],
  );

  assert.match(prompt, /vulnerability-alert-processor skill/);
  assert.match(prompt, /report-only/);
  assert.match(prompt, /只生成报告/);
  assert.match(prompt, /final\.docx/);
});

test("msrc template keeps report workflow inside job paths", async () => {
  const job = await createJob({ template: "msrc-vulnerability-report" });
  await fs.mkdir(path.join(job.paths.input, "materials", "2026-05"), { recursive: true });
  await fs.writeFile(path.join(job.paths.input, "materials", "2026-05", "msrc.json"), "{}");

  const prompt = await promptForRun(
    job,
    {
      template: "msrc-vulnerability-report",
      options: { mode: "generate", taskBrief: "生成 2026-05 MSRC 预警" },
    },
    "msrc-vulnerability-report",
  );

  assert.match(prompt, /msrc-vulnerability-report skill/);
  assert.match(prompt, /msrc_main\.py/);
  assert.match(prompt, /format_word\.py/);
  assert.match(prompt, /report\.pdf/);
  assert.match(prompt, /不要读取 ~\/Downloads 或 macOS 绝对路径/);
});

test("cnvd weekly template separates check and update modes", async () => {
  const job = await createJob({ template: "cnvd-weekly-db-update" });
  const prompt = await promptForRun(
    job,
    {
      template: "cnvd-weekly-db-update",
      options: { mode: "check", taskBrief: "检查本周 XML 更新环境" },
    },
    "cnvd-weekly-db-update",
  );

  assert.match(prompt, /cnvd-weekly-db-update skill/);
  assert.match(prompt, /check 模式只检查 SSH 免密/);
  assert.match(prompt, /update 模式必须在任务备注明确授权后/);
  assert.match(prompt, /output\/update-result\.json/);
});
