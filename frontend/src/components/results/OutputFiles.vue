<script setup lang="ts">
import { computed } from 'vue'
import { useJobStore } from '../../stores/jobStore'
import { useApi } from '../../composables/useApi'
import { formatSize } from '../../utils/formatters'

const jobStore = useJobStore()
const api = useApi()

const currentJob = computed(() => jobStore.currentJob)
const submissionResult = computed(() => currentJob.value?.submissionResult || null)
const platformId = computed(
  () =>
    currentJob.value?.platformId ||
    submissionResult.value?.cnvd_id ||
    submissionResult.value?.cnnvd_id ||
    submissionResult.value?.ncc_id ||
    ''
)
const submissionUrl = computed(
  () => submissionResult.value?.submission_url || submissionResult.value?.url || ''
)

interface OutputFile {
  path: string
  name?: string
  size: number
  group?: string
}

const outputs = computed<OutputFile[]>(() => {
  if (!currentJob.value) return []
  return currentJob.value.outputs || []
})

const groupedOutputs = computed(() => {
  const groups: Record<string, OutputFile[]> = {}
  for (const file of outputs.value) {
    const group = file.group || '其他'
    if (!groups[group]) {
      groups[group] = []
    }
    groups[group].push(file)
  }
  return groups
})

function getOutputUrl(filePath: string) {
  if (!currentJob.value) return '#'
  return api.outputUrl(currentJob.value.id, filePath)
}

const archiveUrl = computed(() => (currentJob.value ? api.archiveUrl(currentJob.value.id) : '#'))
</script>

<template>
  <div class="outputs">
    <div v-if="platformId" class="submission-success">
      <div>
        <span>平台已提交</span>
        <strong>{{ platformId }}</strong>
      </div>
      <a v-if="submissionUrl" :href="submissionUrl" target="_blank">查看平台记录</a>
    </div>

    <div v-if="outputs.length" class="output-toolbar">
      <a :href="archiveUrl" target="_blank">下载全部输出</a>
    </div>

    <div v-if="outputs.length === 0" class="empty">暂无输出文件</div>

    <div v-for="(files, group) in groupedOutputs" :key="group" class="output-group">
      <h3>{{ group }}</h3>
      <ul>
        <li v-for="file in files" :key="file.path">
          <a :href="getOutputUrl(file.path)" target="_blank">
            {{ file.name || file.path.split('/').pop() || file.path }}
          </a>
          <span class="file-size">{{ formatSize(file.size) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.outputs {
  @apply space-y-4;
}

.submission-success {
  @apply flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3;
  color: var(--success);
  border-color: rgba(5, 150, 105, 0.28);
  background: rgba(5, 150, 105, 0.08);
}

.submission-success div {
  @apply flex flex-col gap-1;
}

.submission-success span {
  @apply text-xs font-medium;
}

.submission-success strong {
  @apply font-mono text-sm;
}

.submission-success a {
  @apply rounded border px-2.5 py-1 text-xs font-semibold;
  border-color: rgba(5, 150, 105, 0.32);
}

.empty {
  @apply rounded-lg border py-8 text-center text-sm;
  border-color: var(--line);
  color: var(--ink-muted);
  background: var(--surface-muted);
}

.output-toolbar {
  @apply flex justify-end;
}

.output-toolbar a {
  @apply rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors;
  border-color: var(--line);
  color: var(--brand);
}

.output-toolbar a:hover {
  background: var(--surface-muted);
}

.output-group {
  @apply rounded-lg border p-3;
  border-color: var(--line);
}

.output-group h3 {
  @apply mb-2 text-sm font-semibold;
  color: var(--ink);
}

.output-group ul {
  @apply space-y-1;
}

.output-group li {
  @apply flex items-center justify-between gap-3 rounded px-2 py-1.5;
}

.output-group li:hover {
  background: var(--surface-muted);
}

.output-group a {
  @apply truncate text-sm font-medium;
  color: var(--brand);
}

.file-size {
  @apply shrink-0 text-xs;
  color: var(--ink-soft);
}
</style>
