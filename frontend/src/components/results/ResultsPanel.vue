<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useJobStore } from '../../stores/jobStore'
import { useSSE } from '../../composables/useSSE'
import OutputFiles from './OutputFiles.vue'
import LogViewer from './LogViewer.vue'
import ExecutionTimeline from './ExecutionTimeline.vue'

const jobStore = useJobStore()

const activeTab = ref<'events' | 'outputs' | 'logs'>('events')

const currentJob = computed(() => jobStore.currentJob)
const hasJob = computed(() => !!currentJob.value)
const currentJobId = computed(() => currentJob.value?.id || '')
const failureReason = computed(() => {
  const job = currentJob.value
  if (!job || !['failed', 'canceled'].includes(job.status)) return ''
  return job.run?.error || job.logs?.stderr?.split('\n').filter(Boolean).slice(-1)[0] || ''
})
const { events: pushEvents, connectionStatus } = useSSE(() => currentJobId.value)
const jobStatuses = new Set(['created', 'running', 'retrying', 'succeeded', 'failed', 'canceled'])

function pushPatch(data: any) {
  const patch: Record<string, any> = {}
  if (jobStatuses.has(data.status)) patch.status = data.status
  if (data.run) patch.run = data.run
  if (data.logs) patch.logs = data.logs
  if (Array.isArray(data.events)) patch.events = data.events
  if (data.outputs) patch.outputs = data.outputs
  if (data.outputGroups) patch.outputGroups = data.outputGroups
  if (data.validation) patch.validation = data.validation
  return patch
}

watch(
  pushEvents,
  (items) => {
    const latest = items[items.length - 1]
    if (!latest || latest.type !== 'push' || !latest.data?.jobId) return
    const patch = pushPatch(latest.data)
    if (Object.keys(patch).length === 0) return
    jobStore.patchCurrentJob(latest.data.jobId, patch)
  },
  { deep: true }
)
</script>

<template>
  <section v-if="hasJob" class="results">
    <div class="section-head">
      <div>
        <p class="section-kicker">结果面板</p>
        <h2>输出与运行日志</h2>
      </div>

      <div class="flex items-center gap-4">
        <span class="stream-status" :class="`is-${connectionStatus}`">
          {{ connectionStatus === 'connected' ? '实时连接' : connectionStatus === 'connecting' ? '连接中' : connectionStatus === 'error' ? '连接异常' : '未连接' }}
        </span>
        <div class="segmented-control">
          <button
            :class="{ 'is-active': activeTab === 'events' }"
            type="button"
            @click="activeTab = 'events'"
          >
            执行状态
          </button>
          <button
            :class="{ 'is-active': activeTab === 'outputs' }"
            type="button"
            @click="activeTab = 'outputs'"
          >
            输出文件
          </button>
          <button
            :class="{ 'is-active': activeTab === 'logs' }"
            type="button"
            @click="activeTab = 'logs'"
          >
            运行日志
          </button>
        </div>

        <button
          class="refresh-button"
          type="button"
          @click="jobStore.loadJob(currentJob!.id)"
          title="刷新结果"
        >
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
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 21v-5h5" />
          </svg>
        </button>
      </div>
    </div>

    <div class="results-content">
      <div v-if="failureReason" class="failure-reason">
        <strong>{{ currentJob?.status === 'canceled' ? '中断原因' : '失败原因' }}</strong>
        <span>{{ failureReason }}</span>
      </div>
      <ExecutionTimeline v-if="activeTab === 'events'" />
      <OutputFiles v-if="activeTab === 'outputs'" />
      <LogViewer v-if="activeTab === 'logs'" />
    </div>
  </section>
</template>

<style scoped>
.results {
  @apply mt-6 rounded-xl border p-6 bg-white shadow-sm;
  border-color: var(--line);
}

.section-head {
  @apply flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6 pb-4 border-b border-slate-100;
}

.section-kicker {
  @apply text-xs font-bold uppercase tracking-wider mb-1;
  color: var(--brand);
}

.section-head h2 {
  @apply text-2xl font-bold text-slate-800 leading-none;
  letter-spacing: -0.02em;
}

.refresh-button {
  @apply p-2 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer border border-transparent hover:border-blue-100;
}

.stream-status {
  @apply hidden rounded-full px-2.5 py-1 text-xs font-semibold md:inline-flex;
  color: var(--ink-muted);
  background: var(--surface-muted);
}

.stream-status.is-connected {
  color: var(--success);
  background: rgba(5, 150, 105, 0.08);
}

.stream-status.is-error {
  color: var(--danger);
  background: rgba(220, 38, 38, 0.08);
}

.segmented-control {
  @apply inline-flex rounded-lg p-1 bg-slate-100 border border-slate-200/50;
}

.segmented-control button {
  @apply relative rounded-md px-5 py-1.5 text-sm font-semibold transition-all duration-200 z-10;
  color: var(--ink-muted);
}

.segmented-control button.is-active {
  @apply text-slate-800 shadow-sm bg-white;
}

.segmented-control button:not(.is-active):hover {
  @apply text-slate-600;
}

.results-content {
  @apply min-h-[300px];
}

.failure-reason {
  @apply mb-4 flex flex-col gap-1 rounded-lg border p-3 text-sm;
  color: var(--danger);
  border-color: rgba(220, 38, 38, 0.24);
  background: rgba(220, 38, 38, 0.06);
}

.failure-reason span {
  @apply break-words;
  color: var(--ink-muted);
}
</style>
