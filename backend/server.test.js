const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.SKILLS_API_JOBS_ROOT = path.join(os.tmpdir(), `skills-api-test-${process.pid}`);

const {
  createJob,
  cancelJob,
  complexSkillPrompt,
  contentDispositionAttachment,
  md2wechatPrompt,
  normalizeJobStatus,
  parseExecutionEvents,
  promptForRun,
  redactSensitiveText,
  decodePathSegments,
  ensureSubmissionMaterials,
  effectiveJobState,
  isSuccessfulSubmissionResult,
  platformIdFromSubmissionResult,
  resolveCreateTemplate,
  resolveRunTemplate,
  serviceConfig,
  validateRequiredOutputs,
  writeFallbackSummary,
  writeJob,
  writeServiceConfig,
} = require("./server");
const { isPendingHumanAction, listHumanActions } = require("./human-input.js");

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
  assert.match(prompt, /input\/service-config\.json/);
  assert.match(prompt, /submit=false/);
  assert.match(prompt, /上报 DAS-T100001/);
  assert.match(prompt, new RegExp(job.paths.output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("submission templates reject material uploads that only contain system files", async () => {
  const job = await createJob({ template: "phase2-cnvd-report" });
  const materialDir = path.join(job.paths.input, "materials", "DAS-T000001");
  await fs.mkdir(materialDir, { recursive: true });
  await fs.writeFile(path.join(materialDir, ".DS_Store"), "metadata", "utf8");

  await assert.rejects(
    () =>
      ensureSubmissionMaterials(job, "phase2-cnvd-report", {
        options: { mode: "single", serviceConfig: {} },
      }),
    /缺少有效上报材料/,
  );

  await fs.writeFile(path.join(materialDir, "CNVD-test.docx"), "docx", "utf8");
  await ensureSubmissionMaterials(job, "phase2-cnvd-report", {
    options: { mode: "single", serviceConfig: {} },
  });
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
  assert.match(prompt, /scripts\/test_material\.py/);
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

test("submission prompt includes service contract and state machine", async () => {
  const job = await createJob({ template: "phase2-cnvd-report" });
  const prompt = complexSkillPrompt(
    job,
    "phase2-cnvd-report",
    { options: { mode: "single", serviceConfig: { submit: true } } },
  );

  assert.match(prompt, /服务化执行契约/);
  assert.match(prompt, /prepare -> form_context -> browser -> login/);
  assert.match(prompt, /禁止重写、覆盖或伪造 input\/service-config\.json/);
  assert.match(prompt, /CNVD 防火墙\/WAF 访问验证码先使用 skill 内 captcha_ocr\.py 自动识别/);
  assert.match(prompt, /最多尝试 3 次/);
  assert.match(prompt, /attachment_prepare_command -> MCP upload_file -> attachment_verify_command/);
  assert.match(prompt, /禁止为了绕过附件上传失败而使用 JS DataTransfer/);
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
  await assert.rejects(
    () =>
      promptForRun(
        job,
        {
          template: "cnvd-weekly-db-update",
          options: { mode: "check", taskBrief: "检查本周 XML 更新环境" },
        },
        "cnvd-weekly-db-update",
      ),
    /requires input\/xml\/\*\.xml/,
  );

  await fs.mkdir(path.join(job.paths.input, "xml"), { recursive: true });
  await fs.writeFile(
    path.join(job.paths.input, "xml", "2026-05-04_2026-05-10.xml"),
    "<root></root>\n",
    "utf8",
  );

  const prompt = await promptForRun(
    job,
    {
      template: "cnvd-weekly-db-update",
      options: { mode: "check", taskBrief: "检查本周 XML 更新环境" },
    },
    "cnvd-weekly-db-update",
  );

  assert.match(prompt, /cnvd-weekly-db-update skill/);
  assert.match(prompt, /CNVD 周库更新只处理上传到 input\/xml\/ 下的 \.xml 文件/);
  assert.match(prompt, /check 模式只检查 input\/xml\/\*\.xml/);
  assert.match(prompt, /update 模式必须同时满足 mode=update/);
  assert.match(prompt, /output\/update-result\.json/);
});

test("output download paths decode url encoded nested chinese filenames", () => {
  const encoded = [
    "processed-materials",
    "%E6%9D%AD%E5%B7%9E%E5%AE%89%E6%81%92%E4%BF%A1%E6%81%AF%E5%8E%9F%E5%88%9B%E6%BC%8F%E6%B4%9E%E6%8A%A5%E9%80%811%E4%B8%AA-2026-03-30-161902",
    "%E6%BC%8F%E6%B4%9E%E5%88%97%E8%A1%A8%E6%B1%87%E6%80%BB.xlsx",
  ];

  assert.equal(
    decodePathSegments(encoded),
    "processed-materials/杭州安恒信息原创漏洞报送1个-2026-03-30-161902/漏洞列表汇总.xlsx",
  );
  assert.throws(() => decodePathSegments(["%E0%A4%A"]), /invalid encoded path/);
});

test("output download header supports chinese filenames", () => {
  const header = contentDispositionAttachment("漏洞列表汇总.xlsx");

  assert.match(header, /attachment; filename="______\.xlsx"/);
  assert.match(header, /filename\*=UTF-8''%E6%BC%8F%E6%B4%9E/);
  assert.doesNotThrow(() => Buffer.from(header, "latin1"));
});

test("phase1 template validates required output contract", async () => {
  const job = await createJob({ template: "phase1-material-processor" });

  await assert.rejects(
    () => validateRequiredOutputs(job, "phase1-material-processor"),
    /missing required outputs: output\/processed-materials\/, output\/summary\.txt/,
  );

  await fs.mkdir(path.join(job.paths.output, "processed-materials"), { recursive: true });
  await fs.writeFile(path.join(job.paths.output, "summary.txt"), "ok\n", "utf8");

  await assert.doesNotReject(() => validateRequiredOutputs(job, "phase1-material-processor"));
});

test("vulnerability alert fallback summary satisfies output contract when only summary is missing", async () => {
  const job = await createJob({ template: "vulnerability-alert-processor" });
  job.run = {
    template: "vulnerability-alert-processor",
    options: { mode: "full" },
  };
  await fs.writeFile(path.join(job.paths.output, "final.md"), "# report\n", "utf8");
  await fs.writeFile(path.join(job.paths.output, "final.docx"), "docx", "utf8");
  await fs.writeFile(path.join(job.paths.output, "render_context.json"), "{}\n", "utf8");

  await assert.rejects(
    () => validateRequiredOutputs(job, "vulnerability-alert-processor", "full"),
    /output\/summary\.txt/,
  );

  const wrote = await writeFallbackSummary(job, "vulnerability-alert-processor", {
    outcome: "succeeded",
    mode: "full",
  });
  const summary = await fs.readFile(path.join(job.paths.output, "summary.txt"), "utf8");

  assert.equal(wrote, true);
  assert.match(summary, /generated_by: skills-api fallback/);
  assert.match(summary, /final\.md/);
  await assert.doesNotReject(() => validateRequiredOutputs(job, "vulnerability-alert-processor", "full"));
});

test("submission fallback summary records failed submit jobs even when submission result is missing", async () => {
  const job = await createJob({ template: "phase2-cnvd-report" });
  job.run = {
    template: "phase2-cnvd-report",
    options: { mode: "single", serviceConfig: { submit: true } },
  };
  await fs.writeFile(path.join(job.paths.output, "form_context.json"), "{}\n", "utf8");
  await fs.appendFile(
    path.join(job.paths.logs, "progress.jsonl"),
    JSON.stringify({
      time: "2026-05-14T01:48:46.000Z",
      stage: "captcha",
      status: "blocked",
      label: "验证码被防火墙拦截",
      detail: "CNVD WAF 拦截了 /common/myCodeNew，截图保存到 logs/human-cnvd-firewall.png",
    }) + "\n",
    "utf8",
  );

  const wrote = await writeFallbackSummary(job, "phase2-cnvd-report", {
    outcome: "failed",
    error: "template phase2-cnvd-report missing required outputs: output/summary.txt, output/submission-result.json",
    mode: "single",
    force: true,
  });
  const summary = await fs.readFile(path.join(job.paths.output, "summary.txt"), "utf8");

  assert.equal(wrote, true);
  assert.match(summary, /generated_by: skills-api fallback/);
  assert.match(summary, /form_context\.json/);
  assert.match(summary, /验证码被防火墙拦截/);
  await assert.rejects(
    () => validateRequiredOutputs(job, "phase2-cnvd-report", "single"),
    /output\/submission-result\.json/,
  );
});

test("blocked CNVD firewall progress is exposed as pending human action", async () => {
  const job = await createJob({ template: "phase2-cnvd-report" });
  const event = {
    time: "2026-05-14T01:48:46.000Z",
    stage: "captcha",
    status: "blocked",
    label: "验证码被防火墙拦截",
    detail: "CNVD WAF 拦截了 /common/myCodeNew，日志截图保存到 logs/human-cnvd-firewall.png",
  };
  await fs.appendFile(path.join(job.paths.logs, "progress.jsonl"), JSON.stringify(event) + "\n", "utf8");

  assert.equal(isPendingHumanAction(event), true);
  const actions = await listHumanActions(job);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].label, "验证码被防火墙拦截");
});

test("successful job status normalizes legacy completed to succeeded", () => {
  assert.equal(normalizeJobStatus("completed"), "succeeded");
  assert.equal(normalizeJobStatus("succeeded"), "succeeded");
  assert.equal(normalizeJobStatus("failed"), "failed");
});

test("service config is written into job input and referenced by prompt", async () => {
  const job = await createJob({ template: "phase2-cnnvd-report" });
  const body = {
    template: "phase2-cnnvd-report",
    options: {
      mode: "single",
      taskBrief: "准备 DAS-T100001",
      serviceConfig: {
        das_id: "DAS-T100001",
        submit: false,
        entity_description: "测试实体描述",
      },
    },
  };

  const configPath = await writeServiceConfig(job, "phase2-cnnvd-report", body);
  const raw = await fs.readFile(configPath, "utf8");
  const data = JSON.parse(raw);

  assert.equal(data.template, "phase2-cnnvd-report");
  assert.equal(data.mode, "single");
  assert.equal(data.serviceConfig.das_id, "DAS-T100001");
  assert.equal(data.serviceConfig.submit, false);
  assert.equal(serviceConfig(body).entity_description, "测试实体描述");
});

test("mode-specific required output contract is enforced", async () => {
  const single = await createJob({ template: "phase2-cnvd-report" });
  await fs.writeFile(path.join(single.paths.output, "summary.txt"), "ok\n", "utf8");
  await assert.rejects(
    () => validateRequiredOutputs(single, "phase2-cnvd-report", "single"),
    /output\/form_context\.json/,
  );
  await fs.writeFile(path.join(single.paths.output, "form_context.json"), "{}\n", "utf8");
  await assert.doesNotReject(() => validateRequiredOutputs(single, "phase2-cnvd-report", "single"));

  const batch = await createJob({ template: "phase2-cnvd-report" });
  await fs.writeFile(path.join(batch.paths.output, "summary.txt"), "ok\n", "utf8");
  await assert.rejects(
    () => validateRequiredOutputs(batch, "phase2-cnvd-report", "batch"),
    /output\/batch-state\.json/,
  );
});

test("submit=true submission templates require submission result", async () => {
  const job = await createJob({ template: "phase2-cnvd-report" });
  job.run = {
    template: "phase2-cnvd-report",
    options: { mode: "single", serviceConfig: { submit: true } },
  };
  await fs.writeFile(path.join(job.paths.output, "summary.txt"), "ok\n", "utf8");
  await fs.writeFile(path.join(job.paths.output, "form_context.json"), "{}\n", "utf8");

  await assert.rejects(
    () => validateRequiredOutputs(job, "phase2-cnvd-report", "single"),
    /output\/submission-result\.json/,
  );

  await fs.writeFile(path.join(job.paths.output, "submission-result.json"), "{\"submitted\":true}\n", "utf8");
  await assert.doesNotReject(() => validateRequiredOutputs(job, "phase2-cnvd-report", "single"));
});

test("successful submission result wins over missing summary outputs", async () => {
  const job = await createJob({ template: "phase2-cnvd-report" });
  job.run = {
    template: "phase2-cnvd-report",
    options: { mode: "single", serviceConfig: { submit: true } },
  };
  await fs.writeFile(
    path.join(job.paths.output, "submission-result.json"),
    JSON.stringify({
      status: "success",
      cnvd_id: "CNVD-C-2026-213629",
      submission_url: "https://www.cnvd.org.cn/user/reportManage/28813516",
    }) + "\n",
    "utf8",
  );

  await assert.doesNotReject(() => validateRequiredOutputs(job, "phase2-cnvd-report", "single"));
});

test("cnnvd camelCase submission result is treated as submitted even after cancellation", async () => {
  const job = await createJob({ template: "phase2-cnnvd-report" });
  job.status = "canceled";
  job.finishedAt = "2026-05-14T06:17:51.834Z";
  job.run = {
    template: "phase2-cnnvd-report",
    options: { mode: "single", serviceConfig: { submit: true } },
    finishedAt: job.finishedAt,
  };
  const result = {
    cnnvdId: "CNNVD-2026-81852337",
    title: "Claude Code系统-getMcpHeadersFromHelper模块存在命令执行漏洞",
    submitTime: "2026-05-14 14:19:24",
    status: "待研判",
  };
  await fs.writeFile(path.join(job.paths.output, "submission-result.json"), JSON.stringify(result) + "\n", "utf8");

  assert.equal(platformIdFromSubmissionResult(result), "CNNVD-2026-81852337");
  assert.equal(isSuccessfulSubmissionResult(result), true);

  const effective = await effectiveJobState(job);
  assert.equal(effective.effectiveStatus, "submitted");
  assert.equal(effective.effectiveStatusLabel, "平台已提交");
  assert.equal(effective.platformId, "CNNVD-2026-81852337");
});

test("submit=false submission templates do not require submission result", async () => {
  const job = await createJob({ template: "phase2-cnvd-report" });
  job.run = {
    template: "phase2-cnvd-report",
    options: { mode: "single", serviceConfig: { submit: false } },
  };
  await fs.writeFile(path.join(job.paths.output, "summary.txt"), "ok\n", "utf8");
  await fs.writeFile(path.join(job.paths.output, "form_context.json"), "{}\n", "utf8");

  await assert.doesNotReject(() => validateRequiredOutputs(job, "phase2-cnvd-report", "single"));
});

test("running jobs can be canceled and record cancellation state", async () => {
  const job = await createJob({ template: "custom" });
  job.status = "running";
  job.run = {
    template: "custom",
    options: {},
    model: "test-model",
    models: ["test-model"],
    prompt: "sleep",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    stdout: path.join(job.paths.logs, "run.jsonl"),
    stderr: path.join(job.paths.logs, "stderr.log"),
    attempts: [],
  };
  await writeJob(job);
  await fs.writeFile(job.run.stderr, "", "utf8");

  const canceled = await cancelJob(job);
  const stderr = await fs.readFile(job.run.stderr, "utf8");
  const cancelMarker = JSON.parse(await fs.readFile(path.join(job.paths.input, "cancel-requested.json"), "utf8"));

  assert.equal(canceled.status, "canceled");
  assert.match(canceled.run.error, /canceled by user/);
  assert.ok(canceled.run.canceledAt);
  assert.equal(cancelMarker.canceled, true);
  assert.match(stderr, /canceled by user/);
});

test("log redaction masks common secrets before returning logs", () => {
  const raw = [
    "EMAIL=user@example.com",
    "PASSWORD=example-password",
    "WEBHOOK=https://example.invalid/robot/send?access_token=abc123",
    JSON.stringify({ password: "secret-pass", value: "user@example.com" }),
    JSON.stringify({ output: '{\\"cnvd_email\\": \\"cnvd@example.com\\", \\"cnvd_password\\": \\"12345678\\"}' }),
  ].join("\n");
  const redacted = redactSensitiveText(raw);

  assert.doesNotMatch(redacted, /user@example.com/);
  assert.doesNotMatch(redacted, /cnvd@example.com/);
  assert.doesNotMatch(redacted, /example-password/);
  assert.doesNotMatch(redacted, /access_token=abc123/);
  assert.doesNotMatch(redacted, /secret-pass/);
  assert.doesNotMatch(redacted, /12345678/);
  assert.match(redacted, /\[REDACTED/);
});

test("execution events summarize opencode jsonl and stderr", () => {
  const stdout = [
    JSON.stringify({ type: "attempt_start", attempt: 1, model: "deepseek/test", timestamp: "2026-05-09T02:00:00.000Z" }),
    JSON.stringify({
      type: "tool_use",
      timestamp: 1778292692765,
      part: {
        tool: "chrome-devtools-cnvd_list_pages",
        state: {
          status: "completed",
          input: {},
          output: "Could not connect to Chrome. Cause: connect ECONNREFUSED 127.0.0.1:9222",
        },
      },
    }),
  ].join("\n");
  const stderr = "template phase2-cnvd-report missing required outputs: output/summary.txt\n";
  const events = parseExecutionEvents(stdout, stderr, "", {
    id: "job_test",
    createdAt: "2026-05-09T01:59:00.000Z",
    status: "failed",
    run: { startedAt: "2026-05-09T02:00:00.000Z", finishedAt: "2026-05-09T02:01:00.000Z", error: "missing outputs" },
  });

  assert.ok(events.some((event) => event.label === "第 1 次模型尝试" && event.detail === "deepseek/test"));
  assert.ok(events.some((event) => event.label === "浏览器 MCP 操作" && event.status === "failed" && /ECONNREFUSED/.test(event.detail)));
  assert.ok(events.some((event) => event.label === "输出文件校验失败"));
});

test("execution events merge business progress with opencode jsonl", () => {
  const progress = [
    JSON.stringify({ stage: "login", status: "running", detail: "检查 CNVD 登录态", time: "2026-05-09T02:00:00.000Z" }),
    JSON.stringify({ stage: "fill_form", status: "done", label: "表单字段已填写", detail: "base_info/detail_info", time: "2026-05-09T02:01:00.000Z" }),
    JSON.stringify({ stage: "captcha", status: "warning", detail: "需要人工识别验证码", time: "2026-05-09T02:02:00.000Z" }),
  ].join("\n");
  const events = parseExecutionEvents(
    [
      JSON.stringify({ type: "step_start", timestamp: "2026-05-09T02:03:00.000Z" }),
      JSON.stringify({
        type: "text",
        timestamp: "2026-05-09T02:04:00.000Z",
        part: { text: "All fields pass integrity check. Now proceeding with captcha handling." },
      }),
    ].join("\n"),
    "template phase2-cnvd-report missing required outputs: output/summary.txt\n",
    "",
    { status: "running", run: { startedAt: "2026-05-09T01:59:00.000Z" } },
    progress,
  );

  assert.equal(events[0].label, "登录平台");
  assert.equal(events[1].label, "表单字段已填写");
  assert.equal(events[2].label, "验证码识别");
  assert.ok(events.some((event) => event.label === "OpenCode 步骤 1"));
  assert.ok(events.some((event) => event.label === "表单字段校验" && event.status === "done"));
});

test("normal CNVD captcha is not treated as manual firewall verification", () => {
  const events = parseExecutionEvents(
    JSON.stringify({
      type: "tool_use",
      timestamp: "2026-05-09T02:04:00.000Z",
      part: {
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "python3 /root/.agents/skills/phase2-cnvd-report/scripts/captcha_ocr.py /tmp/captcha.png --context submit" },
          output: "szsx\n",
        },
      },
    }),
    "",
    "",
    { status: "running", run: { startedAt: "2026-05-09T01:59:00.000Z" } },
    "",
  );

  assert.ok(events.some((event) => event.stage === "captcha" && event.status === "running"));
  assert.ok(!events.some((event) => event.label === "等待人工防火墙验证码"));
});

test("broken CNVD captcha image first surfaces as firewall OCR", () => {
  const events = parseExecutionEvents(
    JSON.stringify({
      type: "tool_use",
      timestamp: "2026-05-09T02:04:00.000Z",
      part: {
        tool: "bash",
        state: {
          status: "completed",
          output: '{"ok":false,"code":"CNVD_CAPTCHA_IMAGE_BROKEN","reason":"提交验证码图片未加载成功"}',
        },
      },
    }),
    "",
    "",
    { status: "running", run: { startedAt: "2026-05-09T01:59:00.000Z" } },
    "",
  );

  assert.ok(events.some((event) => event.label === "防火墙验证码 OCR" && event.status === "running"));
  assert.ok(!events.some((event) => event.label === "等待人工防火墙验证码"));
});

test("invalid CNVD OCR text is surfaced as captcha failure", () => {
  const events = parseExecutionEvents(
    JSON.stringify({
      type: "tool_use",
      timestamp: "2026-05-09T02:05:00.000Z",
      part: {
        tool: "bash",
        state: {
          status: "completed",
          output: '{"ok":false,"code":"INVALID_OCR_TEXT","value":"存在"}',
        },
      },
    }),
    "",
    "",
    { status: "running", run: { startedAt: "2026-05-09T01:59:00.000Z" } },
    "",
  );

  assert.ok(events.some((event) => event.label === "验证码识别失败" && event.status === "failed"));
});

test("adapter target lookup supports nested materials and target_path under materials", async () => {
  const { findMaterialTarget } = require("./adapters/runner.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adapter-target-"));
  const nestedDas = path.join(root, "materials", "2026-05-07-102233", "DAS-T106053-demo");
  await fs.mkdir(nestedDas, { recursive: true });

  assert.equal(
    await findMaterialTarget(root, { das_id: "DAS-T106053" }),
    nestedDas,
  );
  assert.equal(
    await findMaterialTarget(root, { target_path: "2026-05-07-102233/DAS-T106053-demo" }),
    nestedDas,
  );

  await fs.rm(root, { recursive: true, force: true });
});

async function writeFakePrepareScript(skillRoot, skillName) {
  const scriptDir = path.join(skillRoot, skillName, "scripts");
  await fs.mkdir(scriptDir, { recursive: true });
  await fs.writeFile(
    path.join(scriptDir, "prepare_form_context.py"),
    [
      "import json, pathlib, sys",
      "args = sys.argv[1:]",
      "if '--das-id' in args:",
      "    print('unexpected --das-id', file=sys.stderr)",
      "    sys.exit(2)",
      "output = args[args.index('--output') + 1] if '--output' in args else 'form_context.json'",
      "pathlib.Path(output).parent.mkdir(parents=True, exist_ok=True)",
      "pathlib.Path(output).write_text(json.dumps({'ready': True, 'args': args}, ensure_ascii=False), encoding='utf-8')",
      "print(json.dumps({'args': args}, ensure_ascii=False))",
      "",
    ].join("\n"),
    "utf8",
  );
}

test("phase2 ncc adapter uses supported prepare_form_context arguments", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "adapter-skills-"));
  process.env.SKILLS_API_SKILL_ROOT = skillRoot;
  await writeFakePrepareScript(skillRoot, "phase2-ncc-report");
  delete require.cache[require.resolve("./adapters/runner.js")];
  delete require.cache[require.resolve("./adapters/phase2-ncc-report.js")];
  const adapter = require("./adapters/phase2-ncc-report.js");

  const job = await createJob({ template: "phase2-ncc-report" });
  const nestedDas = path.join(job.paths.input, "materials", "2026-05-07-102233", "DAS-T106053-demo");
  await fs.mkdir(nestedDas, { recursive: true });
  await writeServiceConfig(job, "phase2-ncc-report", {
    template: "phase2-ncc-report",
    options: {
      mode: "single",
      serviceConfig: {
        das_id: "DAS-T106053",
        target_path: "2026-05-07-102233/DAS-T106053-demo",
        prefer_source: "CNVD",
        submit: false,
      },
    },
  });

  const result = await adapter.run(job, {}, "single");
  const context = JSON.parse(await fs.readFile(path.join(job.paths.output, "form_context.json"), "utf8"));

  assert.equal(result.success, true);
  assert.ok(context.args.includes("--input-path"));
  assert.ok(context.args.includes(nestedDas));
  assert.ok(!context.args.includes("--das-id"));

  await fs.rm(skillRoot, { recursive: true, force: true });
});

test("phase2 cnnvd adapter forwards service config fields", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "adapter-skills-"));
  process.env.SKILLS_API_SKILL_ROOT = skillRoot;
  await writeFakePrepareScript(skillRoot, "phase2-cnnvd-report");
  delete require.cache[require.resolve("./adapters/runner.js")];
  delete require.cache[require.resolve("./adapters/phase2-cnnvd-report.js")];
  const adapter = require("./adapters/phase2-cnnvd-report.js");

  const job = await createJob({ template: "phase2-cnnvd-report" });
  const nestedDas = path.join(job.paths.input, "materials", "batch", "DAS-T106053-demo");
  await fs.mkdir(nestedDas, { recursive: true });
  await writeServiceConfig(job, "phase2-cnnvd-report", {
    template: "phase2-cnnvd-report",
    options: {
      mode: "single",
      serviceConfig: {
        das_id: "DAS-T106053",
        entity_description: "测试实体描述",
        verification: "测试验证过程",
        submit: false,
      },
    },
  });

  const result = await adapter.run(job, {}, "single");
  const context = JSON.parse(await fs.readFile(path.join(job.paths.output, "form_context.json"), "utf8"));

  assert.equal(result.success, true);
  assert.ok(context.args.includes("--entity-description"));
  assert.ok(context.args.includes("测试实体描述"));
  assert.ok(context.args.includes("--verification"));
  assert.ok(context.args.includes("测试验证过程"));

  await fs.rm(skillRoot, { recursive: true, force: true });
});
