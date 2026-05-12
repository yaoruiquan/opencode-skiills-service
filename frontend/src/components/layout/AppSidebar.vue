<script setup lang="ts">
import { computed } from 'vue'
import { useJobStore } from '../../stores/jobStore'
import JobList from '../jobs/JobList.vue'
import JobFilters from '../jobs/JobFilters.vue'

const jobStore = useJobStore()

const currentJob = computed(() => jobStore.currentJob)
const isRunning = computed(() => currentJob.value?.status === 'running')
const displayStatus = computed(() => currentJob.value?.effectiveStatus || currentJob.value?.status)
const platformId = computed(
  () =>
    currentJob.value?.platformId ||
    currentJob.value?.submissionResult?.cnvd_id ||
    currentJob.value?.submissionResult?.cnnvd_id ||
    currentJob.value?.submissionResult?.ncc_id ||
    ''
)
const statusText = computed(() => {
  const labels: Record<string, string> = {
    created: '已创建',
    running: '运行中',
    completed: '已完成',
    submitted: '平台已提交',
    failed: '已失败',
    canceled: '已中断'
  }
  return currentJob.value
    ? labels[displayStatus.value || ''] ||
        currentJob.value.effectiveStatusLabel ||
        displayStatus.value
    : '未选择任务'
})

function cancelJob() {
  if (currentJob.value) {
    jobStore.cancelJob(currentJob.value.id)
  }
}
</script>

<template>
  <aside class="side" aria-label="任务列表和状态">
    <section class="status-panel">
      <div class="status-head">
        <div>
          <p class="section-kicker">当前任务</p>
          <div class="status-title">
            <span
              class="status-dot"
              :class="{
                'status-created': currentJob?.status === 'created',
                'status-running': isRunning,
                'status-completed': displayStatus === 'completed' || displayStatus === 'submitted',
                'status-failed': displayStatus === 'failed',
                'status-canceled': displayStatus === 'canceled'
              }"
            ></span>
            <span id="statusLabel">
              {{ statusText }}
            </span>
          </div>
        </div>
        <button v-if="isRunning" class="btn btn-danger btn-sm" type="button" @click="cancelJob">
          中断任务
        </button>
      </div>

      <div v-if="currentJob" class="job-meta-card">
        <dl class="job-meta">
          <dt>标题</dt>
          <dd class="font-semibold text-slate-800">{{ currentJob.title || '未命名任务' }}</dd>
          <dt>模板</dt>
          <dd>{{ currentJob.template }}</dd>
          <dt v-if="platformId">平台编号</dt>
          <dd v-if="platformId" class="platform-id">{{ platformId }}</dd>
          <dt>时间</dt>
          <dd>{{ new Date(currentJob.createdAt).toLocaleString() }}</dd>
          <dt>ID</dt>
          <dd class="mono" :title="currentJob.id">{{ currentJob.id }}</dd>
        </dl>
      </div>
      <div v-else class="empty-state">
        <p>尚未选择或创建任何任务</p>
      </div>

      <div id="jobProgress" class="job-progress"></div>
    </section>

    <section class="jobs-panel">
      <div class="section-head">
        <div>
          <p class="section-kicker">历史队列</p>
          <h2>任务列表</h2>
        </div>
        <button class="refresh-button" type="button" @click="jobStore.loadJobs()" title="刷新列表">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
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

      <JobFilters />
      <div class="mt-3">
        <JobList />
      </div>
    </section>
  </aside>
</template>

<style scoped>
.side {
  @apply sticky top-20 space-y-6;
}

.status-panel {
  @apply rounded-xl border p-5 bg-white shadow-sm;
  border-color: var(--line);
}

.status-head {
  @apply mb-4 flex items-start justify-between gap-3;
}

.section-kicker {
  @apply text-[10px] font-bold uppercase tracking-wider mb-1;
  color: var(--brand);
}

.status-title {
  @apply mt-1 flex items-center gap-2 text-lg font-bold text-slate-800;
  letter-spacing: -0.01em;
}

.status-dot {
  @apply w-2.5 h-2.5 rounded-full;
}

.btn-sm {
  @apply px-2.5 py-1 text-xs;
}

.job-meta-card {
  @apply bg-slate-50 border rounded-lg p-3.5;
  border-color: var(--line);
}

.job-meta {
  @apply grid grid-cols-[48px_1fr] gap-x-2 gap-y-2 text-sm;
}

.job-meta dt {
  @apply text-slate-400 font-medium text-xs self-center;
}

.job-meta dd {
  @apply min-w-0 truncate text-slate-600;
}

.job-meta .mono {
  @apply font-mono text-xs text-slate-500 bg-white border border-slate-200 px-1 py-0.5 rounded w-fit;
}

.job-meta .platform-id {
  @apply font-mono text-xs font-semibold rounded border px-1.5 py-0.5 w-fit;
  color: var(--success);
  border-color: rgba(5, 150, 105, 0.28);
  background: rgba(5, 150, 105, 0.08);
}

.empty-state {
  @apply py-6 text-center text-sm text-slate-400 border border-dashed rounded-lg bg-slate-50;
  border-color: var(--line-strong);
}

.jobs-panel {
  @apply rounded-xl border p-5 bg-white shadow-sm;
  border-color: var(--line);
}

.section-head {
  @apply mb-4 flex items-end justify-between;
}

.section-head h2 {
  @apply text-xl font-bold text-slate-800 leading-none;
  letter-spacing: -0.02em;
}

.refresh-button {
  @apply p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer border border-transparent hover:border-blue-100;
}
</style>
