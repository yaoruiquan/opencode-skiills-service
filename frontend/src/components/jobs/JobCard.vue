<script setup lang="ts">
import { computed } from 'vue'
import { useJobStore } from '../../stores/jobStore'
import type { Job } from '../../types'

const props = defineProps<{
  job: Job
}>()

const jobStore = useJobStore()

const isSelected = computed(() => jobStore.currentJob?.id === props.job.id)

const displayStatus = computed(() => props.job.effectiveStatus || props.job.status)
const platformId = computed(
  () =>
    props.job.platformId ||
    props.job.submissionResult?.cnvd_id ||
    props.job.submissionResult?.cnnvd_id ||
    props.job.submissionResult?.ncc_id ||
    ''
)

const statusClass = computed(() => ({
  'status-created': displayStatus.value === 'created',
  'status-running': displayStatus.value === 'running',
  'status-completed': displayStatus.value === 'succeeded' || displayStatus.value === 'submitted',
  'status-failed': displayStatus.value === 'failed',
  'status-canceled': displayStatus.value === 'canceled'
}))

const statusText = computed(
  () =>
    ({
      created: '已创建',
      running: '运行中',
      retrying: '重试中',
      succeeded: '已完成',
      submitted: '平台已提交',
      failed: '失败',
      canceled: '已中断'
    })[displayStatus.value] ||
    props.job.effectiveStatusLabel ||
    displayStatus.value
)

function selectJob() {
  jobStore.loadJob(props.job.id)
}

async function deleteJob(event: MouseEvent) {
  event.stopPropagation()
  if (props.job.status === 'running') return
  const ok = window.confirm(`确认删除任务「${props.job.title || props.job.id}」？`)
  if (!ok) return
  await jobStore.deleteJob(props.job.id)
}
</script>

<template>
  <div class="job-card" :class="{ selected: isSelected }" @click="selectJob">
    <div class="job-header">
      <div class="status-line">
        <span class="status-dot" :class="statusClass"></span>
        <span class="status-pill">{{ statusText }}</span>
      </div>
      <button
        class="delete-button"
        type="button"
        :disabled="job.status === 'running'"
        title="删除任务"
        @click="deleteJob"
      >
        删除
      </button>
    </div>
    <div class="job-info">
      <div class="job-title">{{ job.title || '未命名任务' }}</div>
      <div class="job-template">{{ job.template }}</div>
      <div v-if="platformId" class="platform-id">{{ platformId }}</div>
      <div class="job-id">{{ job.id }}</div>
      <div class="job-time">
        {{ new Date(job.createdAt).toLocaleString() }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.job-card {
  @apply cursor-pointer rounded-lg border p-3 transition;
  border-color: var(--line);
  background: white;
}

.job-card.selected {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
}

.job-card:hover {
  border-color: var(--line-strong);
}

.job-header {
  @apply mb-2 flex items-center justify-between gap-2;
}

.status-line {
  @apply flex items-center gap-2;
}

.status-dot {
  @apply w-2 h-2 rounded-full;
}

.status-pill {
  @apply rounded-full px-2 py-0.5 text-xs font-medium;
  background: var(--surface-strong);
  color: var(--ink-muted);
}

.delete-button {
  @apply rounded px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40;
  color: var(--danger);
}

.delete-button:hover:not(:disabled) {
  background: rgba(180, 35, 24, 0.08);
}

.job-id {
  @apply mt-2 truncate font-mono text-xs;
  color: var(--ink-soft);
}

.platform-id {
  @apply mt-2 truncate rounded border px-2 py-1 font-mono text-xs font-semibold;
  color: var(--success);
  border-color: rgba(5, 150, 105, 0.28);
  background: rgba(5, 150, 105, 0.08);
}

.job-info {
  @apply text-sm;
}

.job-title {
  @apply truncate font-semibold;
  color: var(--ink);
}

.job-template {
  @apply mt-1 truncate text-xs;
  color: var(--ink-muted);
}

.job-time {
  @apply mt-1 text-xs;
  color: var(--ink-soft);
}
</style>
