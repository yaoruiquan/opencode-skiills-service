function defaultApiBase() {
  const { protocol, hostname } = window.location;
  if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://127.0.0.1:4100";
  }
  return `${protocol}//${hostname}:4100`;
}

const state = {
  apiBase: localStorage.getItem("skillsApiBase") || defaultApiBase(),
  currentJobId: localStorage.getItem("currentJobId") || "",
  jobs: [],
  currentJob: null,
  templates: {},
  logs: { stdout: "", stderr: "" },
  activeLog: "stdout",
  pollTimer: null,
};

const els = {
  apiBase: document.querySelector("#apiBase"),
  saveApi: document.querySelector("#saveApi"),
  template: document.querySelector("#template"),
  title: document.querySelector("#title"),
  createJob: document.querySelector("#createJob"),
  templateName: document.querySelector("#templateName"),
  templateDescription: document.querySelector("#templateDescription"),
  templateMeta: document.querySelector("#templateMeta"),
  markdownPanel: document.querySelector("#markdownPanel"),
  fileInput: document.querySelector("#fileInput"),
  materialInput: document.querySelector("#materialInput"),
  materialDirInput: document.querySelector("#materialDirInput"),
  saveMarkdown: document.querySelector("#saveMarkdown"),
  saveMaterials: document.querySelector("#saveMaterials"),
  runJob: document.querySelector("#runJob"),
  runMaterialJob: document.querySelector("#runMaterialJob"),
  markdown: document.querySelector("#markdown"),
  materialsPanel: document.querySelector("#materialsPanel"),
  mode: document.querySelector("#mode"),
  taskBrief: document.querySelector("#taskBrief"),
  selectedFiles: document.querySelector("#selectedFiles"),
  promptWrap: document.querySelector("#promptWrap"),
  prompt: document.querySelector("#prompt"),
  statusDot: document.querySelector("#statusDot"),
  statusLabel: document.querySelector("#statusLabel"),
  jobMeta: document.querySelector("#jobMeta"),
  refreshJobs: document.querySelector("#refreshJobs"),
  refreshCurrent: document.querySelector("#refreshCurrent"),
  jobsList: document.querySelector("#jobsList"),
  outputs: document.querySelector("#outputs"),
  logs: document.querySelector("#logs"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  toast: document.querySelector("#toast"),
};

const STATUS_LABELS = {
  created: "已创建",
  running: "运行中",
  retrying: "重试中",
  succeeded: "已成功",
  failed: "已失败",
};

const TEMPLATE_LABELS = {
  custom: "自定义",
  md2wechat: "公众号转换",
  "vulnerability-alert-processor": "漏洞预警材料",
  "phase1-material-processor": "材料整理",
  "msrc-vulnerability-report": "MSRC 预警报告",
  "cnvd-weekly-db-update": "CNVD 周库更新",
  "phase2-cnvd-report": "CNVD 上报",
  "phase2-cnnvd-report": "CNNVD 上报",
  "phase2-ncc-report": "NCC 上报",
};

const MODE_LABELS = {
  full: "完整流程",
  "report-only": "仅生成报告",
  "browser-template": "浏览器模板阶段",
  generate: "生成报告",
  "format-only": "仅格式化",
  publish: "发布通知",
  check: "检查环境",
  update: "执行更新",
  batch: "批量",
  list: "列出状态",
  single: "单个",
};

els.apiBase.value = state.apiBase;

function api(path) {
  return `${state.apiBase.replace(/\/+$/, "")}${path}`;
}

function outputUrl(jobId, filePath) {
  return api(`/jobs/${jobId}/outputs/${filePath.split("/").map(encodeURIComponent).join("/")}`);
}

async function request(path, options = {}) {
  const response = await fetch(api(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.message && data.error ? `${data.error}: ${data.message}` : data.message || data.error;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return data;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("is-visible"), 3200);
}

function setBusy(isBusy) {
  for (const button of [
    els.createJob,
    els.saveMarkdown,
    els.saveMaterials,
    els.runJob,
    els.runMaterialJob,
    els.refreshJobs,
    els.refreshCurrent,
  ]) {
    button.disabled = isBusy;
  }
}

function templateValue() {
  return els.template.value || "md2wechat";
}

function jobTemplate(job) {
  return job?.template || job?.type || "custom";
}

function canReuseJob(job, template) {
  return job && jobTemplate(job) === template && !["running", "retrying"].includes(job.status);
}

function hasTaskBrief() {
  return Boolean(els.taskBrief.value.trim());
}

function renderStatus() {
  const job = state.currentJob;
  const status = job ? displayStatus(job.status) : "未选择任务";
  els.statusLabel.textContent = status;
  els.statusDot.className = `status-dot ${job ? job.status : ""}`;

  if (!job) {
    els.jobMeta.innerHTML = "";
    return;
  }

  const rows = [
    ["任务 ID", job.id],
    ["模板", displayTemplate(job.template || job.type || "custom")],
    ["标题", job.title || "-"],
    ["更新时间", job.updatedAt || "-"],
    ["模型", job.run?.model || "-"],
    ["退出码", job.run?.exitCode ?? "-"],
  ];

  els.jobMeta.innerHTML = rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("");
}

function renderJobs() {
  if (!state.jobs.length) {
    els.jobsList.innerHTML = '<div class="empty">暂无任务</div>';
    return;
  }

  els.jobsList.innerHTML = state.jobs
    .map((job) => {
      const active = job.id === state.currentJobId ? " is-active" : "";
      const title = job.title || job.id;
      const template = job.template || job.type || "custom";
      return `
        <button class="job-item${active}" type="button" data-job-id="${escapeHtml(job.id)}">
          <span>
            <span class="job-title">${escapeHtml(title)}</span>
            <span class="job-sub">${escapeHtml(job.id)} · ${escapeHtml(displayTemplate(template))}</span>
          </span>
          <span class="badge">${escapeHtml(displayStatus(job.status))}</span>
        </button>
      `;
    })
    .join("");

  for (const item of els.jobsList.querySelectorAll(".job-item")) {
    item.addEventListener("click", () => selectJob(item.dataset.jobId));
  }
}

function renderOutputs(files = []) {
  if (!state.currentJob) {
    els.outputs.innerHTML = '<div class="empty">未选择任务</div>';
    return;
  }

  if (!files.length) {
    els.outputs.innerHTML = '<div class="empty">暂无输出文件</div>';
    return;
  }

  els.outputs.innerHTML = files
    .map((file) => `
      <a class="output-link" href="${escapeAttribute(outputUrl(state.currentJob.id, file.path))}" target="_blank" rel="noreferrer">
        <span>${escapeHtml(file.path)}</span>
        <span>${formatBytes(file.size)}</span>
      </a>
    `)
    .join("");
}

function renderLogs() {
  els.logs.textContent = state.logs[state.activeLog] || "";
}

function renderTemplateControls() {
  const template = templateValue();
  const definition = state.templates[template] || {};
  const isCustom = template === "custom";
  const isMarkdown = ["custom", "md2wechat"].includes(template);
  const modes = definition.modes || [];

  els.promptWrap.classList.toggle("is-visible", isCustom);
  els.markdownPanel.classList.toggle("is-hidden", !isMarkdown);
  els.markdown.classList.toggle("is-hidden", !isMarkdown);
  els.materialsPanel.classList.toggle("is-visible", !isMarkdown);
  els.templateName.textContent = displayTemplate(template);
  els.templateDescription.textContent = definition.description || "使用当前模板创建并运行服务化任务。";
  els.title.value = els.title.value || `${displayTemplate(template)}任务`;

  els.mode.innerHTML = modes.length
    ? modes.map((mode) => `<option value="${escapeAttribute(mode)}">${escapeHtml(displayMode(mode))}</option>`).join("")
    : '<option value="single">单个</option>';

  const recommended = definition.recommendedInputs || definition.requiredInputs || [];
  const outputs = definition.outputs || [];
  const meta = [];
  if (definition.browserMcp) {
    meta.push(`<div>浏览器通道：<span class="meta-pill">${escapeHtml(definition.browserMcp)}</span></div>`);
  }
  if (recommended.length) {
    meta.push(`<div>建议输入：${recommended.map((item) => `<span class="meta-pill">${escapeHtml(item)}</span>`).join("")}</div>`);
  }
  if (outputs.length) {
    meta.push(`<div>输出约定：${outputs.map((item) => `<span class="meta-pill">${escapeHtml(item)}</span>`).join("")}</div>`);
  }
  els.templateMeta.innerHTML = meta.join("") || "<div>无固定输入约束。</div>";
}

function shouldPoll(job) {
  return job && ["running", "retrying"].includes(job.status);
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!shouldPoll(state.currentJob)) return;
  state.pollTimer = setTimeout(() => refreshCurrent(), 2500);
}

async function loadHealth() {
  const health = await request("/health");
  if (Array.isArray(health.templates) && health.templates.length) {
    state.templates = Object.fromEntries(health.templates.map((item) => [item.name, item]));
    const current = templateValue();
    els.template.innerHTML = health.templates
      .map((item) => `<option value="${escapeAttribute(item.name)}">${escapeHtml(displayTemplate(item.name))}</option>`)
      .join("");
    els.template.value = health.templates.some((item) => item.name === current) ? current : "md2wechat";
  }
  renderTemplateControls();
}

async function loadJobs() {
  const data = await request("/jobs");
  state.jobs = data.jobs || [];
  renderJobs();
  const selectedTemplate = templateValue();
  const firstMatchingJob = state.jobs.find((job) => jobTemplate(job) === selectedTemplate);
  if (!state.currentJobId && firstMatchingJob) {
    state.currentJobId = firstMatchingJob.id;
    localStorage.setItem("currentJobId", state.currentJobId);
  }
}

async function selectJob(jobId) {
  state.currentJobId = jobId;
  localStorage.setItem("currentJobId", jobId);
  await refreshCurrent();
  renderJobs();
}

async function refreshCurrent() {
  if (!state.currentJobId) {
    renderStatus();
    renderOutputs();
    renderLogs();
    return;
  }

  const [job, logs, outputs] = await Promise.all([
    request(`/jobs/${state.currentJobId}`),
    request(`/jobs/${state.currentJobId}/logs`).catch(() => ({ stdout: "", stderr: "" })),
    request(`/jobs/${state.currentJobId}/outputs`).catch(() => ({ files: [] })),
  ]);

  state.currentJob = job;
  state.logs = logs;
  renderStatus();
  renderOutputs(outputs.files || []);
  renderLogs();
  schedulePoll();
}

async function createJob() {
  const template = templateValue();
  const body = {
    type: template,
    template,
    title: els.title.value.trim() || `${displayTemplate(template)}任务`,
  };
  const job = await request("/jobs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  state.currentJobId = job.id;
  state.currentJob = job;
  localStorage.setItem("currentJobId", job.id);
  await loadJobs();
  await refreshCurrent();
  toast(`已创建任务 ${job.id}`);
  return job;
}

async function ensureJob() {
  const selectedTemplate = templateValue();
  if (state.currentJobId) {
    const job = state.currentJob || await request(`/jobs/${state.currentJobId}`);
    if (canReuseJob(job, selectedTemplate)) return job;
  }
  return createJob();
}

async function saveMarkdown(job = null) {
  const targetJob = job || await ensureJob();
  const content = els.markdown.value;
  await request(`/jobs/${targetJob.id}/files`, {
    method: "POST",
    body: JSON.stringify({ filename: "article.md", content }),
  });
  await refreshCurrent();
  toast("已保存 article.md");
}

async function saveMaterials(job = null) {
  const targetJob = job || await ensureJob();
  const files = selectedMaterialFiles();
  if (!files.length) {
    toast("未选择材料文件；将仅使用任务备注运行。");
    return;
  }

  for (const file of files) {
    const relative = materialRelativePath(file);
    await request(`/jobs/${targetJob.id}/files`, {
      method: "POST",
      body: JSON.stringify({
        filename: relative,
        contentBase64: await fileToBase64(file),
      }),
    });
  }

  await refreshCurrent();
  toast(`已保存 ${files.length} 个材料文件`);
}

async function saveTemplateInputs(job) {
  if (["custom", "md2wechat"].includes(templateValue())) {
    await saveMarkdown(job);
    return;
  }
  if (!selectedMaterialFiles().length && !hasTaskBrief()) {
    throw new Error("请先上传材料目录/文件，或填写任务备注。");
  }
  await saveMaterials(job);
}

async function runJob() {
  const job = await ensureJob();
  await saveTemplateInputs(job);
  const template = templateValue();
  const body = template === "custom"
    ? { template, prompt: els.prompt.value.trim() || undefined }
    : {
        template,
        options: {
          mode: els.mode.value || undefined,
          taskBrief: els.taskBrief.value.trim() || undefined,
        },
      };

  await request(`/jobs/${job.id}/run`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  await refreshCurrent();
  toast("任务已开始运行");
}

function materialRelativePath(file) {
  const sourcePath = file.webkitRelativePath || file.name;
  const normalized = sourcePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.startsWith("materials/") ? normalized : `materials/${normalized}`;
}

function isUsableMaterialFile(file) {
  const relative = materialRelativePath(file);
  return relative
    .split("/")
    .every((part) => part && !part.startsWith(".") && part !== "__MACOSX");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",").pop() : value);
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayStatus(status) {
  return STATUS_LABELS[status] || status || "-";
}

function displayTemplate(template) {
  return TEMPLATE_LABELS[template] || template || "-";
}

function displayMode(mode) {
  return MODE_LABELS[mode] || mode || "-";
}

async function guarded(action) {
  setBusy(true);
  try {
    await action();
  } catch (error) {
    toast(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

els.saveApi.addEventListener("click", () => {
  state.apiBase = els.apiBase.value.trim() || "http://127.0.0.1:4100";
  localStorage.setItem("skillsApiBase", state.apiBase);
  guarded(async () => {
    await loadHealth();
    await loadJobs();
    await refreshCurrent();
    toast("API 地址已保存");
  });
});

els.template.addEventListener("change", () => {
  const template = templateValue();
  els.title.value = `${displayTemplate(template)}任务`;
  if (state.currentJob && jobTemplate(state.currentJob) !== template) {
    state.currentJobId = "";
    state.currentJob = null;
    state.logs = { stdout: "", stderr: "" };
    localStorage.removeItem("currentJobId");
  }
  renderTemplateControls();
  renderStatus();
  renderOutputs();
  renderLogs();
  renderJobs();
});
els.createJob.addEventListener("click", () => guarded(createJob));
els.saveMarkdown.addEventListener("click", () => guarded(saveMarkdown));
els.saveMaterials.addEventListener("click", () => guarded(saveMaterials));
els.runJob.addEventListener("click", () => guarded(runJob));
els.runMaterialJob.addEventListener("click", () => guarded(runJob));
els.refreshJobs.addEventListener("click", () => guarded(loadJobs));
els.refreshCurrent.addEventListener("click", () => guarded(refreshCurrent));

els.fileInput.addEventListener("change", async () => {
  const [file] = els.fileInput.files;
  if (!file) return;
  els.markdown.value = await file.text();
  toast(`已载入 ${file.name}`);
});

els.materialInput.addEventListener("change", () => {
  renderSelectedMaterialFiles();
});

els.materialDirInput.addEventListener("change", () => {
  renderSelectedMaterialFiles();
});

function selectedMaterialFiles() {
  return [
    ...Array.from(els.materialDirInput.files || []),
    ...Array.from(els.materialInput.files || []),
  ].filter(isUsableMaterialFile);
}

function renderSelectedMaterialFiles() {
  const files = selectedMaterialFiles();
  if (!files.length) {
    els.selectedFiles.textContent = "尚未选择材料。";
    return;
  }
  const preview = files.slice(0, 8).map((file) => `input/${materialRelativePath(file)}`);
  const suffix = files.length > preview.length ? `\n... 另有 ${files.length - preview.length} 个文件` : "";
  els.selectedFiles.textContent = `已选择 ${files.length} 个文件：\n${preview.join("\n")}${suffix}`;
}

for (const tab of els.tabs) {
  tab.addEventListener("click", () => {
    state.activeLog = tab.dataset.log;
    for (const item of els.tabs) item.classList.toggle("is-active", item === tab);
    renderLogs();
  });
}

guarded(async () => {
  await loadHealth();
  await loadJobs();
  await refreshCurrent();
});
