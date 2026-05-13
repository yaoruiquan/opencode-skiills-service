<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useJobStore } from '../../stores/jobStore'
import { useConfigStore } from '../../stores/configStore'
import { useApi } from '../../composables/useApi'
import TemplateSelector from './TemplateSelector.vue'
import ConfigForm from './ConfigForm.vue'
import MarkdownEditor from './MarkdownEditor.vue'

const jobStore = useJobStore()
const configStore = useConfigStore()
const api = useApi()

const selectedTemplate = ref('md2wechat')
const jobTitle = ref('')
const markdown = ref('')
const prompt = ref('')
const markdownFile = ref<File | null>(null)
const materialFiles = ref<File[]>([])
const isCreating = ref(false)
const isRunning = ref(false)
const isSaving = ref(false)
const uploadProgress = ref('')
const uploadError = ref('')
const taskBrief = ref('')
const mode = ref('')
const lastAutoTitle = ref('')

const currentTemplate = computed(() => jobStore.templates[selectedTemplate.value])

const hasMaterials = computed(() => {
  const inputMode = currentTemplate.value?.inputMode
  return inputMode === 'materials' || inputMode === 'directory' || inputMode === 'directory-zip'
})

const uploadedMaterialFiles = computed(() =>
  (jobStore.currentJob?.files || [])
    .filter((file) => file.path.startsWith('materials/') && !file.path.endsWith('/.DS_Store'))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
)

function isIgnoredMaterial(file: File) {
  const relative = (file as any).webkitRelativePath || file.name
  const name = relative.split('/').pop() || file.name
  return name === '.DS_Store' || name === 'Thumbs.db' || file.size === 0
}

const ignoredSelectedCount = computed(
  () => materialFiles.value.filter((file) => isIgnoredMaterial(file)).length
)

const validSelectedMaterials = computed(() =>
  materialFiles.value.filter((file) => !isIgnoredMaterial(file))
)

const runButtonLabel = computed(() => {
  if (isRunning.value) return '运行中...'
  if (
    ['phase2-cnvd-report', 'phase2-cnnvd-report', 'phase2-ncc-report'].includes(
      selectedTemplate.value
    )
  ) {
    return '开始上报'
  }
  if (selectedTemplate.value === 'md2wechat') return '开始转换'
  if (selectedTemplate.value === 'phase1-material-processor') return '开始整理'
  return '开始执行'
})

function defaultJobTitle(template: string) {
  const label = jobStore.templates[template]?.label || template
  const time = new Date().toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  return `${label} ${time}`
}

function setAutoTitle(template: string) {
  const next = defaultJobTitle(template)
  jobTitle.value = next
  lastAutoTitle.value = next
}

watch(selectedTemplate, (template) => {
  configStore.loadConfig(template)
  mode.value = jobStore.templates[template]?.modes?.[0] || 'single'
  if (!jobTitle.value || jobTitle.value === lastAutoTitle.value) {
    setAutoTitle(template)
  }
  // Clear state when switching
  markdownFile.value = null
  materialFiles.value = []
  uploadProgress.value = ''
  uploadError.value = ''
  taskBrief.value = ''
})

watch(
  currentTemplate,
  (template) => {
    if (template && !mode.value) {
      mode.value = template.modes?.[0] || 'single'
    }
    if (template && (!jobTitle.value || jobTitle.value === lastAutoTitle.value)) {
      setAutoTitle(template.name)
    }
  },
  { immediate: true }
)

watch(
  () => jobStore.currentJob,
  (job) => {
    if (!job) return
    selectedTemplate.value = job.template
    jobTitle.value = job.title || defaultJobTitle(job.template)
    lastAutoTitle.value = jobTitle.value
    mode.value = job.run?.options?.mode || jobStore.templates[job.template]?.modes?.[0] || 'single'
  },
  { deep: false }
)

async function createJob() {
  if (!selectedTemplate.value || !jobTitle.value) return

  isCreating.value = true
  try {
    await jobStore.createJob(selectedTemplate.value, jobTitle.value)
  } finally {
    isCreating.value = false
  }
}

function onMarkdownFile(event: Event) {
  const input = event.target as HTMLInputElement
  markdownFile.value = input.files?.[0] || null
}

function onMaterialFiles(event: Event) {
  const input = event.target as HTMLInputElement
  uploadError.value = ''
  const merged = [...materialFiles.value, ...Array.from(input.files || [])]
  const deduped = new Map<string, File>()
  for (const file of merged) {
    const relative = (file as any).webkitRelativePath || file.name
    deduped.set(relative, file)
  }
  materialFiles.value = Array.from(deduped.values())
  if (materialFiles.value.length > 0 && validSelectedMaterials.value.length === 0) {
    uploadError.value = '选择的目录里没有有效材料，请确认包含 docx、zip、pdf 或图片文件。'
  }
  input.value = ''
}

async function readTextFile(file: File) {
  return await file.text()
}

async function readBase64(file: File) {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i])
  return window.btoa(binary)
}

async function ensureJob() {
  const current = jobStore.currentJob
  const shouldCreate =
    !current ||
    current.template !== selectedTemplate.value ||
    current.status !== 'created' ||
    current.title !== jobTitle.value

  if (shouldCreate) {
    await createJob()
  }
  return jobStore.currentJob
}

async function saveMarkdown() {
  const job = await ensureJob()
  if (!job) return

  isSaving.value = true
  try {
    const content = markdownFile.value ? await readTextFile(markdownFile.value) : markdown.value
    await api.post(`/jobs/${job.id}/files`, { filename: 'article.md', content })
  } finally {
    isSaving.value = false
    await jobStore.loadJob(job.id)
  }
}

async function saveMaterials() {
  const job = await ensureJob()
  if (!job || materialFiles.value.length === 0) return

  isSaving.value = true
  uploadError.value = ''
  uploadProgress.value = ''
  try {
    const files = validSelectedMaterials.value
    if (files.length === 0) {
      uploadError.value = '没有有效材料可上传，请选择包含 docx、zip、pdf 或图片的材料目录。'
      return
    }
    for (const [index, file] of files.entries()) {
      const relative = (file as any).webkitRelativePath || file.name
      uploadProgress.value = `正在上传 ${index + 1}/${files.length}: ${relative}`
      await api.post(`/jobs/${job.id}/files`, {
        filename: `materials/${relative}`,
        contentBase64: await readBase64(file)
      })
    }
    uploadProgress.value = `已上传 ${files.length} 个材料文件`
    materialFiles.value = []
  } catch (error: any) {
    uploadError.value = error?.message || '上传材料失败'
    window.alert(`上传材料失败：${uploadError.value}`)
    throw error
  } finally {
    isSaving.value = false
    await jobStore.loadJob(job.id)
  }
}

async function runJob() {
  const job = await ensureJob()
  if (!job) return

  isRunning.value = true
  uploadError.value = ''
  try {
    if (hasMaterials.value) {
      const hasExistingFiles =
        uploadedMaterialFiles.value.length > 0 ||
        (job.files || []).some(
          (file) => file.path.startsWith('materials/') && !file.path.endsWith('/.DS_Store')
        )
      const hasSelectedFiles = validSelectedMaterials.value.length > 0
      const config = configStore.templateConfig
      const hasTargetConfig = Boolean(config.das_id || config.target_path || config.batch_dir)
      if (!hasExistingFiles && !hasSelectedFiles && !hasTargetConfig) {
        uploadError.value = '请先上传有效材料目录，或在运行配置中填写 DAS 编号 / 目标材料路径。'
        window.alert(uploadError.value)
        return
      }
    }
    if (!hasMaterials.value) {
      if (markdown.value || markdownFile.value) {
        await saveMarkdown()
      }
    } else if (validSelectedMaterials.value.length > 0) {
      await saveMaterials()
    }
    const options = {
      template: selectedTemplate.value,
      prompt: selectedTemplate.value === 'custom' ? prompt.value || undefined : undefined,
      options: {
        mode: mode.value || currentTemplate.value?.modes?.[0] || 'single',
        taskBrief: hasMaterials.value ? taskBrief.value : prompt.value || '',
        serviceConfig: configStore.templateConfig
      }
    }
    await jobStore.runJob(job.id, options)
  } catch (error: any) {
    uploadError.value = error?.message || '任务启动失败'
    window.alert(`任务启动失败：${uploadError.value}`)
  } finally {
    isRunning.value = false
  }
}
</script>

<template>
  <div class="task-editor">
    <div class="editor-head">
      <div>
        <p class="section-kicker">任务编排</p>
        <h2>创建并运行 Workflow</h2>
      </div>
      <div class="header-actions">
        <button type="button" class="btn btn-secondary" :disabled="isCreating" @click="createJob">
          <svg
            v-if="!isCreating"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M5 12h14" />
            <path d="M12 5v14" />
          </svg>
          {{ isCreating ? '创建中...' : '新建任务' }}
        </button>
        <button
          class="btn btn-primary shadow-blue btn-lg"
          type="button"
          :disabled="isRunning"
          @click="runJob"
        >
          <svg
            v-if="!isRunning"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          {{ runButtonLabel }}
        </button>
      </div>
    </div>

    <div class="toolbar">
      <TemplateSelector v-model="selectedTemplate" />

      <label class="field">
        任务标题
        <input
          v-model="jobTitle"
          type="text"
          class="input"
          placeholder="输入任务标题"
          @input="lastAutoTitle = ''"
        />
      </label>

      <label v-if="currentTemplate?.modes" class="field compact">
        执行模式
        <select v-model="mode" class="input">
          <option v-for="item in currentTemplate.modes" :key="item" :value="item">
            {{ item }}
          </option>
        </select>
      </label>
    </div>

    <section v-if="currentTemplate" class="template-card">
      <div class="flex-1 min-w-0">
        <strong class="block text-slate-800 text-base font-bold truncate">{{
          currentTemplate.label || currentTemplate.name
        }}</strong>
        <p class="text-slate-500 text-sm mt-1 truncate">{{ currentTemplate.description }}</p>
      </div>
      <div class="template-meta">
        <span v-if="currentTemplate.modes" class="badge">
          {{ currentTemplate.modes.length }} 个模式
        </span>
        <span class="badge badge-brand">{{ currentTemplate.inputMode || 'freeform' }}</span>
      </div>
    </section>

    <ConfigForm :template="currentTemplate" />

    <section class="input-panel">
      <div class="panel-head">
        <div>
          <h3>{{ hasMaterials ? '输入材料' : '内容输入' }}</h3>
          <p>
            {{
              hasMaterials
                ? '上传目录或追加单个文件，后端会写入当前 job/input/materials。'
                : '上传或粘贴 article.md 内容。'
            }}
          </p>
        </div>
        <div class="action-row">
          <template v-if="!hasMaterials">
            <label class="btn btn-secondary cursor-pointer" for="fileInput">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" x2="12" y1="3" y2="15" />
              </svg>
              选择文件
            </label>
            <input
              id="fileInput"
              type="file"
              class="hidden"
              accept=".md,.markdown,text/markdown,text/plain"
              @change="onMarkdownFile"
            />
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="isSaving"
              @click="saveMarkdown"
            >
              {{ isSaving ? '保存中...' : '保存文件' }}
            </button>
          </template>
          <template v-else>
            <label class="btn btn-secondary cursor-pointer" for="materialDirInput">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" x2="12" y1="3" y2="15" />
              </svg>
              上传目录
            </label>
            <input
              id="materialDirInput"
              type="file"
              class="hidden"
              multiple
              webkitdirectory
              @change="onMaterialFiles"
            />
            <label class="btn btn-secondary cursor-pointer" for="materialInput">追加文件</label>
            <input
              id="materialInput"
              type="file"
              class="hidden"
              multiple
              @change="onMaterialFiles"
            />
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="isSaving || validSelectedMaterials.length === 0"
              @click="saveMaterials"
            >
              {{
                isSaving
                  ? '保存中...'
                  : validSelectedMaterials.length > 0
                    ? `保存 ${validSelectedMaterials.length} 个文件`
                    : '保存材料'
              }}
            </button>
          </template>
          <button
            class="btn btn-primary shadow-blue btn-lg ml-2"
            type="button"
            :disabled="isRunning"
            @click="runJob"
          >
            <svg
              v-if="!isRunning"
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            {{ runButtonLabel }}
          </button>
        </div>
      </div>

      <div v-if="hasMaterials && materialFiles.length" class="selected-files">
        <div class="flex items-center justify-between">
          <span class="font-medium text-blue-700">
            已选择 {{ validSelectedMaterials.length }} 个有效文件准备上传
            <span v-if="ignoredSelectedCount" class="text-slate-400">
              ，已忽略 {{ ignoredSelectedCount }} 个系统文件
            </span>
          </span>
          <button
            type="button"
            class="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
            @click="materialFiles = []"
          >
            清空列表
          </button>
        </div>
      </div>
      <div v-if="hasMaterials && uploadedMaterialFiles.length" class="uploaded-files">
        <div class="uploaded-head">
          <span>已上传材料 {{ uploadedMaterialFiles.length }} 个</span>
          <span v-if="jobStore.currentJob" class="text-slate-400">{{ jobStore.currentJob.id }}</span>
        </div>
        <ul>
          <li v-for="file in uploadedMaterialFiles.slice(0, 8)" :key="file.path">
            <span>{{ file.path.replace(/^materials\//, '') }}</span>
            <em>{{ Math.max(1, Math.round(file.size / 1024)) }} KB</em>
          </li>
        </ul>
        <p v-if="uploadedMaterialFiles.length > 8" class="uploaded-more">
          还有 {{ uploadedMaterialFiles.length - 8 }} 个文件已保存
        </p>
      </div>
      <div v-if="uploadProgress" class="upload-progress">{{ uploadProgress }}</div>
      <div v-if="uploadError" class="upload-error">{{ uploadError }}</div>
      <div v-if="!hasMaterials && markdownFile" class="selected-files">
        <div class="flex items-center justify-between">
          <span class="font-medium text-blue-700">已选择文件: {{ markdownFile.name }}</span>
          <button
            type="button"
            class="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
            @click="markdownFile = null"
          >
            清除
          </button>
        </div>
      </div>
    </section>

    <MarkdownEditor v-if="!hasMaterials" v-model="markdown" />

    <label class="prompt-wrap">
      <span class="block mb-2">{{ hasMaterials ? '任务备注 / 批次说明' : '自定义提示词' }}</span>
      <textarea
        v-if="hasMaterials"
        v-model="taskBrief"
        spellcheck="false"
        placeholder="例如：批量处理 input/materials 下的 DAS-T 目录；或上报 DAS-T100001。"
      ></textarea>
      <textarea
        v-else
        v-model="prompt"
        spellcheck="false"
        placeholder="custom 模板会作为提示词；其他模板仅作为任务备注。"
      ></textarea>
    </label>
  </div>
</template>

<style scoped>
.task-editor {
  @apply space-y-6;
}

.editor-head {
  @apply flex items-end justify-between gap-4 pb-2;
}

.header-actions {
  @apply flex shrink-0 items-center gap-2;
}

.section-kicker {
  @apply text-xs font-bold uppercase tracking-wider mb-1;
  color: var(--brand);
}

.editor-head h2 {
  @apply text-2xl font-bold text-slate-800 leading-none;
  letter-spacing: -0.02em;
}

.toolbar {
  @apply grid grid-cols-12 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-100;
}

.field {
  @apply col-span-12 md:col-span-5 flex flex-col text-xs font-semibold text-slate-500 uppercase tracking-wide;
}

.field.compact {
  @apply col-span-12 md:col-span-2;
}

.field .input {
  @apply mt-2 font-normal normal-case text-sm;
}

.template-card {
  @apply flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border p-5;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  border-color: var(--line);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.02);
}

.template-meta {
  @apply flex shrink-0 gap-2;
}

.badge {
  @apply rounded-lg border px-2.5 py-1 text-xs font-medium bg-white;
  border-color: var(--line);
  color: var(--ink-muted);
}

.badge-brand {
  @apply bg-blue-50 text-blue-700 border-blue-200;
}

.input-panel {
  @apply rounded-xl border p-5 border-dashed;
  border-color: var(--line-strong);
  background: var(--surface-muted);
}

.panel-head {
  @apply flex flex-col md:flex-row md:items-center justify-between gap-4;
}

.panel-head h3 {
  @apply text-base font-bold text-slate-800;
}

.panel-head p {
  @apply mt-1 text-sm text-slate-500;
}

.action-row {
  @apply flex flex-wrap shrink-0 items-center gap-2;
}

.shadow-blue {
  box-shadow: 0 4px 14px 0 rgba(37, 99, 235, 0.39);
}

.btn-lg {
  @apply px-5 py-2.5 text-base font-semibold;
}

.selected-files {
  @apply mt-4 rounded-lg border px-4 py-3 text-sm bg-blue-50/50 border-blue-100;
}

.uploaded-files {
  @apply mt-4 rounded-lg border bg-white px-4 py-3 text-sm;
  border-color: var(--line);
}

.uploaded-head {
  @apply mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-slate-500;
}

.uploaded-files ul {
  @apply space-y-1;
}

.uploaded-files li {
  @apply flex items-center justify-between gap-4 rounded bg-slate-50 px-2 py-1;
}

.uploaded-files li span {
  @apply min-w-0 truncate text-slate-700;
}

.uploaded-files li em {
  @apply shrink-0 not-italic text-xs text-slate-400;
}

.uploaded-more,
.upload-progress,
.upload-error {
  @apply mt-3 rounded-lg px-4 py-2 text-sm;
}

.uploaded-more,
.upload-progress {
  @apply bg-slate-50 text-slate-500;
}

.upload-error {
  @apply border text-red-700;
  border-color: rgba(239, 68, 68, 0.22);
  background: rgba(239, 68, 68, 0.06);
}

.prompt-wrap {
  @apply block text-sm font-semibold text-slate-700;
}

.prompt-wrap textarea {
  @apply w-full resize-y rounded-xl border p-4 font-mono text-sm outline-none transition-all duration-200;
  background: #fbfcfd;
  border-color: var(--line);
  color: var(--ink);
}

.prompt-wrap textarea:focus {
  @apply bg-white;
  border-color: var(--brand);
  box-shadow: 0 0 0 4px var(--brand-soft);
}
</style>
