/**
 * Deterministic adapter for phase2-cnvd-report.
 *
 * submit=false → directly run prepare_form_context.py (no LLM needed)
 * submit=true  → deterministic CDP browser flow
 */

const path = require("node:path");
const fsp = require("node:fs/promises");
const { connectToPage } = require("./cdp-client.js");
const { appendProgress, findMaterialTarget, runPython, readServiceConfig, writeAdapterLog } = require("./runner.js");

const SKILL_NAME = "phase2-cnvd-report";
const SCRIPT = "scripts/prepare_form_context.py";

async function run(job, body, mode, context = {}) {
  const config = await readServiceConfig(job.paths);
  const serviceConfig = config.serviceConfig || {};

  const target = await findMaterialTarget(job.paths.input, serviceConfig);
  if (!target) {
    const error = "未找到目标材料：请上传 DAS-* 目录或在配置中指定 das_id / target_path。";
    await appendProgress(job.paths, { stage: "form_context", status: "failed", label: "准备表单上下文失败", detail: error });
    await writeAdapterLog(job.paths, [`ERROR: ${error}`]);
    return { success: false, error, stdout: "", stderr: error };
  }

  const outputContext = path.join(job.paths.output, "form_context.json");
  const args = [
    SCRIPT,
    target,
    "--data-dir", path.join(job.paths.input, "materials"),
    "--output", outputContext,
  ];

  await writeAdapterLog(job.paths, [
    `adapter: ${SKILL_NAME}`,
    `mode: ${mode || "single"}`,
    `target: ${target}`,
    `submit: ${serviceConfig.submit === true}`,
    `command: python3 ${args.join(" ")}`,
  ]);
  await appendProgress(job.paths, { stage: "form_context", status: "running", label: "准备表单上下文", detail: path.basename(target) });

  const result = await runPython(SKILL_NAME, args, {
    timeoutMs: 60_000,
    onChild: context.registerChild,
    onClose: context.unregisterChild,
  });
  await appendProgress(job.paths, {
    stage: "form_context",
    status: result.exitCode === 0 ? "done" : "failed",
    label: result.exitCode === 0 ? "表单上下文已生成" : "表单上下文生成失败",
    detail: result.exitCode === 0
      ? (serviceConfig.submit === true ? "form_context.json 已生成，进入浏览器提交阶段。" : "submit=false，未进入浏览器提交阶段。")
      : `退出码 ${result.exitCode}`,
  });

  // Write summary
  if (result.exitCode !== 0) {
    const summaryLines = [
      `# ${SKILL_NAME} adapter summary`,
      "",
      `- mode: ${mode || "single"}`,
      `- target: ${target}`,
      `- submit: ${serviceConfig.submit === true}`,
      `- exit_code: ${result.exitCode}`,
      "",
      `prepare_form_context.py 执行失败 (exit ${result.exitCode})。`,
    ];
    if (result.stderr) summaryLines.push("", "## stderr", "", result.stderr);
    await fsp.writeFile(path.join(job.paths.output, "summary.txt"), summaryLines.join("\n") + "\n", "utf8");
    if (result.stdout) await fsp.appendFile(path.join(job.paths.logs, "run.jsonl"), result.stdout, "utf8");
    if (result.stderr) await fsp.appendFile(path.join(job.paths.logs, "stderr.log"), result.stderr, "utf8");
    await writeAdapterLog(job.paths, ["exit_code: " + result.exitCode, `output: ${outputContext}`]);
    return {
      success: false,
      error: `prepare_form_context.py exited with code ${result.exitCode}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  if (result.stdout) await fsp.appendFile(path.join(job.paths.logs, "run.jsonl"), result.stdout, "utf8");
  if (result.stderr) await fsp.appendFile(path.join(job.paths.logs, "stderr.log"), result.stderr, "utf8");
  await writeAdapterLog(job.paths, [`exit_code: ${result.exitCode}`, `output: ${outputContext}`]);

  if (serviceConfig.submit === true) {
    return runBrowserSubmit(job, outputContext, serviceConfig, mode);
  }

  const summaryLines = [
    `# ${SKILL_NAME} adapter summary`,
    "",
    `- mode: ${mode || "single"}`,
    `- target: ${target}`,
    `- submit: false`,
    `- exit_code: ${result.exitCode}`,
    "",
    result.exitCode === 0
      ? `form_context.json 已生成。submit=false，未进入浏览器提交阶段。`
      : `prepare_form_context.py 执行失败 (exit ${result.exitCode})。`,
  ];
  if (result.stderr) {
    summaryLines.push("", "## stderr", "", result.stderr);
  }
  await fsp.writeFile(path.join(job.paths.output, "summary.txt"), summaryLines.join("\n") + "\n", "utf8");

  return { success: true, stdout: result.stdout, stderr: result.stderr };
}

async function runBrowserSubmit(job, contextPath, serviceConfig, mode) {
  const formContext = JSON.parse(await fsp.readFile(contextPath, "utf8"));
  if (formContext.ready !== true) {
    const error = "form_context.json ready=false，停止提交。";
    await writeFailureSummary(job, formContext, error, mode);
    return { success: false, error };
  }

  const browserUrl = serviceConfig.browser_url || process.env.CNVD_BROWSER_URL || browserBaseUrl("CNVD", "browser-cnvd", "9332");
  await writeAdapterLog(job.paths, [`browser_url: ${browserUrl}`]);
  await appendProgress(job.paths, { stage: "browser", status: "running", label: "连接 CNVD Docker Chrome", detail: browserUrl });

  let cdp;
  try {
    cdp = await connectToPage(browserUrl);
    await cdp.send("Page.navigate", { url: "https://www.cnvd.org.cn/flaw/create" });
    await sleep(3500);

    const guard = await checkLoginGuard(cdp);
    if (guard.hasCloudflare) {
      await requestHumanVerification(job, cdp, "captcha-cloudflare.png", "Cloudflare 人机验证", "cloudflare");
      await waitHumanConfirmation(job);
      await cdp.send("Page.navigate", { url: "https://www.cnvd.org.cn/flaw/create" });
      await sleep(2500);
    }

    const beforeLogin = await checkLoginGuard(cdp);
    if (beforeLogin.hasCloudflare) {
      const error = "人工确认后仍停留在 Cloudflare 验证页。";
      await writeFailureSummary(job, formContext, error, mode);
      return { success: false, error };
    }
    if (beforeLogin.isLoginPage || !beforeLogin.hasCreateForm) {
      const loginResult = await handleLogin(job, cdp, serviceConfig);
      if (!loginResult.ok) {
        await writeFailureSummary(job, formContext, loginResult.error, mode);
        return { success: false, error: loginResult.error };
      }
      await cdp.send("Page.navigate", { url: "https://www.cnvd.org.cn/flaw/create" });
      await sleep(2500);
      const afterLogin = await checkLoginGuard(cdp);
      if (!afterLogin.hasCreateForm) {
        const error = `登录后未进入上报表单：${afterLogin.href || "unknown"}`;
        await writeFailureSummary(job, formContext, error, mode);
        return { success: false, error };
      }
    }

    await appendProgress(job.paths, { stage: "fill_form", status: "running", label: "填写 CNVD 表单", detail: formContext.title_final_expected || formContext.title || "" });
    await fillCnvdForm(cdp, formContext);
    await appendProgress(job.paths, { stage: "fill_form", status: "done", label: "表单字段已填写", detail: "Select2、文本字段、是否公开已处理。" });

    await appendProgress(job.paths, { stage: "upload", status: "running", label: "上传 CNVD 附件", detail: formContext.attachment_zip_path || "" });
    await uploadAttachment(cdp, formContext.attachment_zip_path);
    await appendProgress(job.paths, { stage: "upload", status: "done", label: "附件已上传", detail: path.basename(formContext.attachment_zip_path || "") });

    const missing = await validateForm(cdp);
    if (missing.length) {
      const error = `提交前字段缺失：${missing.join(", ")}`;
      await writeFailureSummary(job, formContext, error, mode);
      return { success: false, error };
    }

    await appendProgress(job.paths, { stage: "captcha", status: "warning", label: "等待人工验证码", detail: "请在前端查看验证码截图并输入验证码。" });
    const code = await requestCaptchaCode(job, cdp, "captcha-cnvd-submit.png");
    await appendProgress(job.paths, { stage: "submit", status: "running", label: "提交 CNVD", detail: "已收到人工验证码，正在提交。" });
    await submitCaptcha(cdp, code);
    await sleep(3500);

    const platformId = await extractPlatformId(cdp);
    if (!platformId) {
      await saveScreenshot(cdp, path.join(job.paths.logs, "submission-unknown-result.png"));
      const error = "提交后未提取到 CNVD 编号，请检查页面结果截图。";
      await writeFailureSummary(job, formContext, error, mode);
      return { success: false, error };
    }

    await writeSubmissionResult(job, formContext, platformId);
    await appendProgress(job.paths, { stage: "extract_id", status: "done", label: "提取 CNVD 编号", detail: platformId });
    await appendProgress(job.paths, { stage: "summary", status: "done", label: "上报完成", detail: platformId });
    return { success: true };
  } catch (error) {
    await writeFailureSummary(job, formContext, error.message || String(error), mode);
    await appendProgress(job.paths, { stage: "summary", status: "failed", label: "上报失败", detail: error.message || String(error) });
    return { success: false, error: error.message || String(error) };
  } finally {
    cdp?.close();
  }
}

function browserBaseUrl(prefix, fallbackHost, fallbackPort) {
  const host = process.env[`CHROME_DEVTOOLS_${prefix}_HOST`] || fallbackHost;
  const port = process.env[`CHROME_DEVTOOLS_${prefix}_PORT`] || fallbackPort;
  return `http://${host}:${port}`;
}

async function checkLoginGuard(cdp) {
  return cdp.evaluate(`(${loginGuardScript()})()`);
}

async function handleLogin(job, cdp, serviceConfig) {
  const email = String(serviceConfig.cnvd_email || serviceConfig.email || "").trim();
  const password = String(serviceConfig.cnvd_password || serviceConfig.password || "").trim();
  if (!email || !password) {
    await requestHumanVerification(job, cdp, "human-login-cnvd.png", "CNVD 登录态失效", "cloudflare");
    await waitHumanConfirmation(job);
    return { ok: true };
  }

  await appendProgress(job.paths, { stage: "login", status: "running", label: "填写 CNVD 登录信息", detail: "使用前端传入的账号密码，不读取 skill .env。" });
  const captcha = await requestCaptchaCode(job, cdp, "captcha-cnvd-login.png");
  const result = await cdp.evaluateFunction((payload) => {
    const setValue = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const okEmail = setValue("#email, input[name='email']", payload.email);
    const okPassword = setValue("#password, input[type='password']", payload.password);
    const okCode = setValue("#myCode, input[name='myCode']", payload.captcha);
    const button = Array.from(document.querySelectorAll("a.btn, button, input[type='submit']"))
      .find((el) => /登录/.test(el.innerText || el.value || ""));
    if (button) button.click();
    return { okEmail, okPassword, okCode, clicked: Boolean(button) };
  }, { email, password, captcha });
  await sleep(3500);
  const text = await cdp.evaluate("document.body ? document.body.innerText : ''");
  if (/Invalid RSA public key|RSA public key/i.test(String(text))) {
    return { ok: false, error: "CNVD 登录失败：页面返回 Invalid RSA public key。建议先人工登录 Docker Chrome profile 后重新运行。" };
  }
  await appendProgress(job.paths, { stage: "login", status: "done", label: "登录动作已提交", detail: JSON.stringify(result) });
  return { ok: true };
}

async function fillCnvdForm(cdp, formContext) {
  const select = formContext.page_payloads?.select_first || {};
  await cdp.evaluate(`(${select2Script(select.form_type_label || formContext.form_type_label, select.vuln_type || formContext.vuln_type, select.object_type_label || "应用程序")})()`);
  await sleep(1200);
  await cdp.evaluate(`(${isOpenNoScript()})()`);
  const vendor = formContext.page_payloads?.vendor_info || {};
  const detail = formContext.page_payloads?.detail_info || {};
  await cdp.evaluateFunction((payload) => {
    const setValue = (selectors, value) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        el.value = value == null ? "" : String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    };
    return {
      manuName: setValue(["#manuName", "#producerName", "input[name='manuName']"], payload.unit_name),
      url: setValue(["#changshang1", "#vendorUrl", "input[name='url']"], payload.url),
      product: setValue(["#productCategoryName", "#affectedProduct", "input[name='productCategoryName']"], payload.affected_product),
      version: setValue(["#edition", "#version", "input[name='edition']"], payload.version),
      title: setValue(["#title1", "#title", "input[name='title']"], payload.title_input),
      description: setValue(["#description1", "#description", "textarea[name='description']"], payload.description),
      detailUrl: setValue(["#url1", "#detailUrl", "input[name='detailUrl']"], payload.detail_url),
      tempWay: setValue(["#tempWay1", "#tempWay", "textarea[name='tempWay']"], payload.temp_solution),
      formalWay: setValue(["#formalWay11", "#formalWay1", "#formalWay", "textarea[name='formalWay']"], payload.formal_solution),
      poc: setValue(["#poc", "#poc1", "textarea[name='poc']"], payload.other_required_default || "见附件"),
    };
  }, { ...vendor, ...detail });
}

async function uploadAttachment(cdp, attachmentPath) {
  if (!attachmentPath) throw new Error("form_context.json 缺少 attachment_zip_path");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const selectors = ["#flawAttFile", "input[type='file']", "input[name='flawAttFile']"];
  for (const selector of selectors) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (nodeId) {
      await cdp.send("DOM.setFileInputFiles", { nodeId, files: [attachmentPath] });
      return;
    }
  }
  throw new Error("未找到 CNVD 附件上传 input[type=file]");
}

async function validateForm(cdp) {
  const result = await cdp.evaluate(`(() => {
    const valueOf = (selector) => {
      const el = document.querySelector(selector);
      return el ? String(el.value || '').trim() : '';
    };
    const isOpenNo = Array.from(document.querySelectorAll('input[name="isOpen"]'))
      .some((el) => (el.value === '0' || el.value === '否') && el.checked);
    const required = {
      "是否公开": isOpenNo ? '否' : '',
      "漏洞厂商": valueOf('#manuName'),
      "厂商官网": valueOf('#changshang1'),
      "影响产品": valueOf('#productCategoryName'),
      "影响版本": valueOf('#edition'),
      "漏洞名称": valueOf('#title1'),
      "漏洞描述": valueOf('#description1'),
      "漏洞URL": valueOf('#url1'),
      "临时解决方案": valueOf('#tempWay1'),
      "正式解决方案": valueOf('#formalWay11') || valueOf('#formalWay1')
    };
    return Object.entries(required).filter(([, value]) => !value).map(([field]) => field);
  })()`);
  return Array.isArray(result) ? result : [];
}

async function submitCaptcha(cdp, code) {
  const result = await cdp.evaluateFunction((captcha) => {
    const input = document.querySelector("#myCode1, #myCode, input[name='myCode']");
    if (!input) return { ok: false, reason: "未找到验证码输入框" };
    input.value = captcha;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const submit = document.querySelector("#subForm") || Array.from(document.querySelectorAll("button, input[type='submit'], a.btn"))
      .find((el) => /提交|上报|确认/.test(el.innerText || el.value || ""));
    if (!submit) return { ok: false, reason: "未找到提交按钮" };
    submit.click();
    return { ok: true };
  }, code);
  if (!result?.ok) throw new Error(result?.reason || "验证码提交失败");
}

async function extractPlatformId(cdp) {
  return cdp.evaluate(`(() => {
    const text = document.body ? document.body.innerText : '';
    const match = text.match(/CNVD-[C-]?\\d{4,}-\\d+/i) || text.match(/CNVD-\\d+-\\d+/i);
    return match ? match[0] : null;
  })()`);
}

async function requestHumanVerification(job, cdp, filename, label, type) {
  await clearHumanInput(job);
  await saveScreenshot(cdp, path.join(job.paths.logs, filename));
  await appendProgress(job.paths, {
    stage: type === "cloudflare" ? "login" : "captcha",
    status: "warning",
    label: `等待人工处理：${label}`,
    detail: `截图已保存至 logs/${filename}，请在前端处理后提交。`,
  });
}

async function waitHumanConfirmation(job) {
  const input = await waitForHumanInput(job, 10 * 60_000);
  await appendProgress(job.paths, {
    stage: "login",
    status: "done",
    label: "人工验证已确认",
    detail: String(input.note || input.value || "前端已确认人工处理完成。").slice(0, 120),
  });
}

async function requestCaptchaCode(job, cdp, filename) {
  await clearHumanInput(job);
  await saveScreenshot(cdp, path.join(job.paths.logs, filename));
  await appendProgress(job.paths, {
    stage: "captcha",
    status: "warning",
    label: "等待人工验证码",
    detail: `截图已保存至 logs/${filename}，请在前端输入验证码。`,
  });
  const input = await waitForHumanInput(job, 10 * 60_000);
  const value = String(input.value || input.code || input.text || "").trim();
  if (!value) throw new Error("人工验证码为空");
  return value;
}

async function clearHumanInput(job) {
  await fsp.rm(path.join(job.paths.input, "human-input.json"), { force: true }).catch(() => {});
}

async function waitForHumanInput(job, timeoutMs) {
  const started = Date.now();
  const inputPath = path.join(job.paths.input, "human-input.json");
  const cancelPath = path.join(job.paths.input, "cancel-requested.json");
  while (Date.now() - started < timeoutMs) {
    if (await exists(cancelPath)) throw new Error("任务已取消");
    try {
      return JSON.parse(await fsp.readFile(inputPath, "utf8"));
    } catch {
      await sleep(5000);
    }
  }
  throw new Error("等待人工输入超时");
}

async function saveScreenshot(cdp, filePath) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fsp.writeFile(filePath, Buffer.from(result.data, "base64"));
}

async function writeSubmissionResult(job, formContext, platformId) {
  const payload = {
    submitted: true,
    platform: "CNVD",
    platform_id: platformId,
    title: formContext.title_final_expected || formContext.title || "",
    das_id: formContext.das_id || "",
    submitted_at: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(job.paths.output, "submission-result.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  await fsp.writeFile(path.join(job.paths.output, "summary.txt"), [
    "# phase2-cnvd-report submit summary",
    "",
    `- status: submitted`,
    `- platform_id: ${platformId}`,
    `- title: ${payload.title}`,
    `- das_id: ${payload.das_id}`,
    "",
  ].join("\n"), "utf8");
}

async function writeFailureSummary(job, formContext, error, mode) {
  await fsp.writeFile(path.join(job.paths.output, "summary.txt"), [
    "# phase2-cnvd-report submit summary",
    "",
    `- status: failed`,
    `- mode: ${mode || "single"}`,
    `- title: ${formContext?.title_final_expected || formContext?.title || ""}`,
    `- error: ${error}`,
    "",
  ].join("\n"), "utf8");
}

function loginGuardScript() {
  return `() => {
    const text = document.body ? document.body.innerText : '';
    const href = location.href;
    const hasCreateForm = Boolean(document.querySelector('#isEvent1, #title1, #flawAttFile, #subForm'));
    const cloudflarePattern = /cloudflare|cf-chl|turnstile|checking your browser|ray id|人机验证|安全验证|正在验证|验证您是真人/i;
    const hasCloudflare = !hasCreateForm && cloudflarePattern.test(text + ' ' + href);
    const hasPasswordInput = Boolean(document.querySelector('input[type="password"], input[name*="password"], input[id*="password"], #password'));
    const isLoginPage = !hasCreateForm && (/login|user\\/login/i.test(href) || hasPasswordInput || /用户登录|会员登录|登录名|密码/.test(text));
    return { ok: !hasCloudflare && !isLoginPage && hasCreateForm, hasCloudflare, isLoginPage, hasCreateForm, href };
  }`;
}

function select2Script(formType, vulnType, objectType) {
  const assignments = [
    { name: "漏洞所属类型", selectors: ["#isEvent1", "#isEvent"], label: formType || "通用型漏洞" },
    { name: "漏洞类型", selectors: ["#titlel1", "#titlel"], label: vulnType || "" },
    { name: "影响对象类型", selectors: ["#softStyleId1", "#softStyleId"], label: objectType || "应用程序" },
  ];
  return `async () => {
    const assignments = ${JSON.stringify(assignments)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const aliases = {'通用型漏洞':'0','事件型漏洞':'1','操作系统':'27','应用程序':'28','WEB应用':'29','数据库':'30','网络设备':'31','安全产品':'32','智能设备':'33','工业控制':'38','其他':'other','其它':'other'};
    const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
    const resolveOption = (el, label) => {
      const options = Array.from(el.options || []);
      const target = options.find((option) => option.value === label || option.value === aliases[label] || option.text.trim() === label || normalize(option.text) === normalize(label));
      return { options, target };
    };
    const setSelect2 = async (selectors, label) => {
      let el = null; let options = []; let target = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        el = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
        if (!el) { await sleep(300); continue; }
        const resolved = resolveOption(el, label);
        options = resolved.options; target = resolved.target;
        if (target) break;
        await sleep(300);
      }
      if (!el) return { ok: false, reason: '未找到 ' + selectors.join(' / ') };
      if (!target) return { ok: false, reason: '未找到选项: ' + label, options: options.map((option) => ({ value: option.value, text: option.text.trim() })) };
      el.value = target.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.jQuery) {
        const $el = window.jQuery(el);
        $el.val(target.value).trigger('change');
        if ($el.data('select2')) $el.trigger('select2:select');
      }
      return { ok: true, value: el.value, text: target.text.trim() };
    };
    const results = [];
    for (const item of assignments) {
      const result = await setSelect2(item.selectors, item.label);
      results.push({ name: item.name, ...result });
      await sleep(300);
    }
    return { ok: results.every((item) => item.ok), results };
  }`;
}

function isOpenNoScript() {
  return `() => {
    const radios = document.querySelectorAll('input[name="isOpen"]');
    const yes = []; const no = [];
    radios.forEach((r) => { (r.value === '0' ? no : yes).push(r); });
    yes.forEach((r) => { r.checked = false; });
    no.forEach((r) => {
      r.checked = true;
      r.dispatchEvent(new Event('click', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return { ok: yes.every((r) => !r.checked) && no.every((r) => r.checked), yesCount: yes.length, noCount: no.length };
  }`;
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { run, SKILL_NAME };
