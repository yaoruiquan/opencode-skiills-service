/**
 * Deterministic adapter for phase2-cnvd-report.
 *
 * submit=false → directly run prepare_form_context.py (no LLM needed)
 * submit=true  → deterministic CDP browser flow
 */

const path = require("node:path");
const fsp = require("node:fs/promises");
const { connectToPage } = require("./cdp-client.js");
const { appendProgress, findMaterialTarget, pathExists, runPython, readServiceConfig, writeAdapterLog } = require("./runner.js");

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
    if (guard.hasProtectionCaptcha) {
      const resolved = await resolveProtectionGuard(job, cdp, formContext, mode);
      if (!resolved.ok) return resolved;
    }

    const afterProtection = await checkLoginGuard(cdp);
    if (afterProtection.hasCloudflare) {
      await requestHumanVerification(job, cdp, "captcha-cloudflare.png", "Cloudflare 人机验证", "cloudflare");
      await waitHumanConfirmation(job);
      await cdp.send("Page.navigate", { url: "https://www.cnvd.org.cn/flaw/create" });
      await sleep(2500);
    }

    let beforeLogin = await checkLoginGuard(cdp);
    if (beforeLogin.hasProtectionCaptcha) {
      const resolved = await resolveProtectionGuard(job, cdp, formContext, mode);
      if (!resolved.ok) return resolved;
      beforeLogin = await checkLoginGuard(cdp);
    }
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

    // Re-check login state before form filling (session may have expired)
    const preFillGuard = await checkLoginGuard(cdp);
    if (preFillGuard.isLoginPage || !preFillGuard.hasCreateForm) {
      await appendProgress(job.paths, { stage: "login", status: "running", label: "会话过期，重新登录", detail: "填写表单前检测到登录态失效。" });
      const reLogin = await handleLogin(job, cdp, serviceConfig);
      if (!reLogin.ok) {
        await writeFailureSummary(job, formContext, reLogin.error, mode);
        return { success: false, error: reLogin.error };
      }
      await cdp.send("Page.navigate", { url: "https://www.cnvd.org.cn/flaw/create" });
      await sleep(2500);
      const reLoginGuard = await checkLoginGuard(cdp);
      if (!reLoginGuard.hasCreateForm) {
        const error = "重新登录后仍未进入上报表单。";
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

    const maxSubmitRetries = 2;
    let platformId = null;
    for (let attempt = 0; attempt <= maxSubmitRetries; attempt++) {
      if (attempt > 0) {
        await appendProgress(job.paths, { stage: "captcha", status: "running", label: `提交验证码重试 ${attempt}/${maxSubmitRetries}`, detail: "验证码可能错误，刷新后重新识别。" });
      } else {
        await appendProgress(job.paths, { stage: "captcha", status: "running", label: "识别提交验证码", detail: "正在截取验证码图片并调用 captcha_ocr.py。" });
      }
      const code = await resolveCaptchaCode(job, cdp, "captcha-cnvd-submit.png", "提交验证码", 2, "codeSpan1");
      await appendProgress(job.paths, { stage: "submit", status: "running", label: "提交 CNVD", detail: `验证码已识别，正在提交（第 ${attempt + 1} 次）。` });
      await submitCaptcha(cdp, code);
      await sleep(3500);

      platformId = await extractPlatformId(cdp);
      if (platformId) break;

      // Check if still on form page (captcha was wrong)
      const postGuard = await checkLoginGuard(cdp);
      if (postGuard.hasCreateForm) {
        await writeAdapterLog(job.paths, [`submit: attempt ${attempt + 1} still on form page, captcha likely wrong`]);
        if (attempt < maxSubmitRetries) continue;
      }
      break;
    }

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
    // Poll to verify login actually succeeded after human input
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      const guard = await checkLoginGuard(cdp);
      if (guard.hasCreateForm || !guard.isLoginPage) {
        await appendProgress(job.paths, { stage: "login", status: "done", label: "人工登录已验证", detail: "检测到已离开登录页。" });
        return { ok: true };
      }
      await sleep(5000);
    }
    return { ok: false, error: "人工登录超时：3 分钟内未检测到登录成功。" };
  }

  await appendProgress(job.paths, { stage: "login", status: "running", label: "填写 CNVD 登录信息", detail: "使用前端传入的账号密码，不读取 skill .env。" });
  const maxCaptchaRetries = 3;
  for (let attempt = 0; attempt < maxCaptchaRetries; attempt++) {
    if (attempt > 0) {
      await appendProgress(job.paths, { stage: "login", status: "running", label: `登录验证码重试 ${attempt}/${maxCaptchaRetries}`, detail: "登录未成功，重新获取验证码。" });
      await sleep(1000);
    }
    const captcha = await resolveCaptchaCode(job, cdp, "captcha-cnvd-login.png", "登录验证码", 2, "codeSpan");
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
    const guard = await checkLoginGuard(cdp);
    if (guard.hasCreateForm || !guard.isLoginPage) {
      await appendProgress(job.paths, { stage: "login", status: "done", label: "登录成功", detail: `第 ${attempt + 1} 次尝试登录成功。` });
      return { ok: true };
    }
    await writeAdapterLog(job.paths, [`login: attempt ${attempt + 1} still on login page, href=${guard.href}`]);
  }
  // All captcha attempts exhausted — fall back to human
  await appendProgress(job.paths, { stage: "login", status: "warning", label: "自动登录失败", detail: `${maxCaptchaRetries} 次验证码尝试均未成功，切换人工登录。` });
  await requestHumanVerification(job, cdp, "human-login-cnvd.png", "CNVD 自动登录失败，请人工登录", "cloudflare");
  await waitHumanConfirmation(job);
  const guard = await checkLoginGuard(cdp);
  if (guard.hasCreateForm || !guard.isLoginPage) {
    return { ok: true };
  }
  return { ok: false, error: "人工登录后仍未进入上报表单。" };
}

async function handleProtectionCaptcha(job, cdp) {
  const maxOcrAttempts = 3;
  for (let attempt = 1; attempt <= maxOcrAttempts; attempt += 1) {
    await clearHumanInput(job);
    const screenshotName = attempt === 1 ? "human-cnvd-firewall.png" : `human-cnvd-firewall-${attempt}.png`;
    const imageName = `captcha-cnvd-protection-${attempt}.png`;
    const imagePath = path.join(job.paths.logs, imageName);
    await saveScreenshot(cdp, path.join(job.paths.logs, screenshotName));
    await appendProgress(job.paths, {
      stage: "captcha",
      status: "running",
      label: `防火墙验证码 OCR 尝试 ${attempt}/${maxOcrAttempts}`,
      detail: `CNVD 验证码保护页已截图，正在调用 captcha_ocr.py 识别 logs/${imageName}。`,
    });

    const captured = await saveCaptchaImage(cdp, imagePath);
    let code = "";
    if (captured.ok) {
      const result = await runPython(SKILL_NAME, ["scripts/captcha_ocr.py", imagePath, "--preprocess", "cnvd"], {
        timeoutMs: 120_000,
      });
      code = result.stdout.trim().split(/\r?\n/).pop()?.trim() || "";
      await writeAdapterLog(job.paths, [
        `protection captcha: captcha_ocr exit=${result.exitCode} (attempt ${attempt}/${maxOcrAttempts})`,
        result.stderr ? `protection captcha: captcha_ocr stderr=${result.stderr.trim()}` : "",
      ].filter(Boolean));
      if (result.exitCode !== 0 || /^ERROR\b/i.test(code) || isInvalidCaptchaText(code)) {
        code = "";
      }
    } else {
      await writeAdapterLog(job.paths, [`protection captcha: image capture failed (${captured.reason || "unknown"})`]);
    }

    if (!code) {
      await refreshProtectionCaptcha(cdp);
      await sleep(1500);
      continue;
    }

    const result = await cdp.evaluateFunction((value) => {
      const inputs = Array.from(document.querySelectorAll("input"))
        .filter((el) => {
          const type = String(el.getAttribute("type") || "text").toLowerCase();
          return !["hidden", "submit", "button", "checkbox", "radio", "file"].includes(type);
        });
      const input = inputs.find((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }) || inputs[0];
      if (!input) return { ok: false, reason: "未找到防火墙验证码输入框" };
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], a"));
      const submit = buttons.find((el) => /提交验证码|提交|验证|继续访问/.test(el.innerText || el.value || ""))
        || buttons.find((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
      if (!submit) return { ok: false, reason: "未找到防火墙验证码提交按钮" };
      submit.click();
      return { ok: true };
    }, code);
    if (!result?.ok) {
      if (attempt < maxOcrAttempts) continue;
      return { ok: false, error: result?.reason || "防火墙验证码提交失败" };
    }
    await sleep(2500);
    const guard = await checkLoginGuard(cdp);
    if (!guard.hasProtectionCaptcha) {
      await appendProgress(job.paths, {
        stage: "captcha",
        status: "done",
        label: "防火墙验证码已提交",
        detail: "已通过 CNVD 验证码保护页，继续登录/上报流程。",
      });
      return { ok: true };
    }
    await refreshProtectionCaptcha(cdp);
    await sleep(1500);
  }

  await saveScreenshot(cdp, path.join(job.paths.logs, "human-cnvd-firewall.png"));
  const code = await requestCaptchaCode(job, "human-cnvd-firewall.png", "防火墙验证码");
  const result = await cdp.evaluateFunction((value) => {
    const input = Array.from(document.querySelectorAll("input")).find((el) => {
      const type = String(el.getAttribute("type") || "text").toLowerCase();
      const box = el.getBoundingClientRect();
      return !["hidden", "submit", "button", "checkbox", "radio", "file"].includes(type) && box.width > 0 && box.height > 0;
    });
    if (!input) return { ok: false, reason: "未找到防火墙验证码输入框" };
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const submit = Array.from(document.querySelectorAll("button, input[type='submit'], a"))
      .find((el) => /提交验证码|提交|验证|继续访问/.test(el.innerText || el.value || ""));
    if (!submit) return { ok: false, reason: "未找到防火墙验证码提交按钮" };
    submit.click();
    return { ok: true };
  }, code);
  if (!result?.ok) return { ok: false, error: result?.reason || "人工防火墙验证码提交失败" };
  await sleep(2500);
  const guard = await checkLoginGuard(cdp);
  return guard.hasProtectionCaptcha
    ? { ok: false, error: "人工防火墙验证码提交后仍未通过。" }
    : { ok: true };
}

async function resolveProtectionGuard(job, cdp, formContext, mode) {
  const protectionResult = await handleProtectionCaptcha(job, cdp);
  if (!protectionResult.ok) {
    await writeFailureSummary(job, formContext, protectionResult.error, mode);
    return { success: false, error: protectionResult.error };
  }
  await cdp.send("Page.navigate", { url: "https://www.cnvd.org.cn/flaw/create" });
  await sleep(2500);
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
      binaryVersion: setValue(["#binaryVulnerabilityVersion", "#binaryVulnerabilityVersion1"], payload.version),
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

async function resolveCaptchaCode(job, cdp, filename, label, maxRetries = 2, captchaId) {
  const imagePath = path.join(job.paths.logs, filename);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await appendProgress(job.paths, {
        stage: "captcha",
        status: "running",
        label: `${label} OCR 重试 ${attempt}/${maxRetries}`,
        detail: "刷新验证码图片并重新识别。",
      });
      await cdp.evaluate(`(() => {
        const img = document.querySelector('#codeSpan1 img, #codeSpan img, img[src*="/common/myCodeNew"], img[src*="myCode"]');
        if (img) { img.click(); img.src = img.src.split('?')[0] + '?t=' + Date.now(); }
      })()`);
      await sleep(2000);
    }

    const captured = await saveCaptchaImage(cdp, imagePath, captchaId);
    if (!captured.ok) {
      if (attempt < maxRetries) continue;
      await appendProgress(job.paths, {
        stage: "captcha",
        status: "warning",
        label: `${label} 截图失败`,
        detail: captured.reason || "未能截取验证码图片本体，切换前端人工输入。",
      });
      await saveScreenshot(cdp, imagePath);
      return requestCaptchaCode(job, filename, label);
    }

    await appendProgress(job.paths, {
      stage: "captcha",
      status: "running",
      label: `${label} OCR 识别`,
      detail: `已保存验证码图片 logs/${filename}，正在调用 captcha_ocr.py。`,
    });
    const result = await runPython(SKILL_NAME, ["scripts/captcha_ocr.py", imagePath, "--preprocess", "cnvd"], {
      timeoutMs: 120_000,
    });
    const code = result.stdout.trim().split(/\r?\n/).pop()?.trim() || "";
    await writeAdapterLog(job.paths, [
      `${label}: captcha_ocr exit=${result.exitCode} (attempt ${attempt + 1}/${maxRetries + 1})`,
      result.stderr ? `${label}: captcha_ocr stderr=${result.stderr.trim()}` : "",
    ].filter(Boolean));
    if (result.exitCode === 0 && code && !/^ERROR\b/i.test(code)) {
      await appendProgress(job.paths, {
        stage: "captcha",
        status: "done",
        label: `${label} OCR 已完成`,
        detail: `captcha_ocr.py 返回 ${code.length} 位验证码。`,
      });
      return code;
    }
  }

  await appendProgress(job.paths, {
    stage: "captcha",
    status: "warning",
    label: `${label} OCR 多次失败`,
    detail: `${maxRetries + 1} 次 OCR 尝试均未返回有效验证码，切换前端人工输入。`,
  });
  return requestCaptchaCode(job, filename, label);
}

function isInvalidCaptchaText(value) {
  const text = String(value || "").trim();
  return !text || /看不清|点击更换|存在|二进制|验证码/i.test(text);
}

async function refreshProtectionCaptcha(cdp) {
  await cdp.evaluate(`(() => {
    const refresh = Array.from(document.querySelectorAll('a, button, span'))
      .find((el) => /换一张|看不清/.test(el.innerText || el.value || ''));
    if (refresh) {
      refresh.click();
      return;
    }
    const img = document.querySelector('img[alt*="验证码"], img[src^="data:image"], img');
    if (img && img.src && !img.src.startsWith('data:')) {
      img.src = img.src.split('?')[0] + '?t=' + Date.now();
    }
  })()`).catch(() => {});
}

async function requestCaptchaCode(job, filename, label = "验证码") {
  await clearHumanInput(job);
  await appendProgress(job.paths, {
    stage: "captcha",
    status: "warning",
    label: `等待人工${label}`,
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
    if (await pathExists(cancelPath)) throw new Error("任务已取消");
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

async function saveCaptchaImage(cdp, filePath, captchaId) {
  const captchaExpr = captchaId ? `'${captchaId}'` : 'undefined';
  const result = await cdp.evaluate(`(async (captchaId) => {
    const selectors = captchaId
      ? ['#' + captchaId, '#' + captchaId + ' img']
      : ['#codeSpan1', '#codeSpan1 img', '#codeSpan', '#codeSpan img', 'img[src*="/common/myCodeNew"]', 'img[src*="myCode"]', 'img[alt*="验证码"]', 'img[src^="data:image"]'];
    const image = selectors.reduce((found, sel) => found || document.querySelector(sel), null);
    if (!image) return { ok: false, reason: '未找到验证码图片元素' };
    const rawSrc = image.currentSrc || image.src || image.getAttribute('src');
    if (!rawSrc) return { ok: false, reason: '验证码图片没有 src' };
    const src = new URL(rawSrc, location.href).href;
    const response = await fetch(src, { credentials: 'include' });
    if (!response.ok) return { ok: false, reason: '验证码图片请求失败: HTTP ' + response.status, src };
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { ok: true, src, dataUrl };
  })(${captchaExpr})`);
  if (!result?.ok || !result.dataUrl) {
    return result || { ok: false, reason: "验证码图片截取失败" };
  }
  const match = String(result.dataUrl).match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (!match) return { ok: false, reason: "验证码图片不是 base64 data URL" };
  await fsp.writeFile(filePath, Buffer.from(match[1], "base64"));
  return { ok: true, src: result.src };
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
    const hasProtectionCaptcha = !hasCreateForm && /本站开启了验证码保护|请输入验证码，以继续访问|提交验证码|验证码保护/.test(text);
    const hasPasswordInput = Boolean(document.querySelector('input[type="password"], input[name*="password"], input[id*="password"], #password'));
    const isLoginPage = !hasCreateForm && !hasProtectionCaptcha && (/login|user\\/login/i.test(href) || hasPasswordInput || /用户登录|会员登录|登录名|密码/.test(text));
    return { ok: !hasCloudflare && !hasProtectionCaptcha && !isLoginPage && hasCreateForm, hasCloudflare, hasProtectionCaptcha, isLoginPage, hasCreateForm, href };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { run, SKILL_NAME };
