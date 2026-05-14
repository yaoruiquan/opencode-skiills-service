<script setup lang="ts">
import { computed } from 'vue'
import { useJobStore } from '../../stores/jobStore'
import type { JobStatus } from '../../types'

const jobStore = useJobStore()

const templates = computed(() => Object.keys(jobStore.templates))
const templateLabel = (template: string) => jobStore.templates[template]?.label || template

function onTemplateChange(event: Event) {
  const target = event.target as HTMLSelectElement
  const status = (document.getElementById('filterStatus') as HTMLSelectElement)?.value as
    | JobStatus
    | ''
  jobStore.filterJobs(target.value || undefined, status || undefined)
}

function onStatusChange(event: Event) {
  const target = event.target as HTMLSelectElement
  const template = (document.getElementById('filterTemplate') as HTMLSelectElement)?.value
  jobStore.filterJobs(template || undefined, (target.value as JobStatus) || undefined)
}
</script>

<template>
  <div class="filter-bar">
    <select id="filterTemplate" @change="onTemplateChange">
      <option value="">全部模板</option>
      <option v-for="template in templates" :key="template" :value="template">
        {{ templateLabel(template) }}
      </option>
    </select>

    <select id="filterStatus" @change="onStatusChange">
      <option value="">全部状态</option>
      <option value="created">已创建</option>
      <option value="running">运行中</option>
      <option value="succeeded">已成功</option>
      <option value="failed">已失败</option>
      <option value="canceled">已中断</option>
    </select>
  </div>
</template>

<style scoped>
.filter-bar {
  @apply mb-4 grid grid-cols-2 gap-2;
}

.filter-bar select {
  @apply rounded-md border px-3 py-2 text-sm outline-none;
  border-color: var(--line);
  color: var(--ink);
  background: white;
}
</style>
