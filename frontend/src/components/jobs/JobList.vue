<script setup lang="ts">
import { computed } from 'vue'
import { useJobStore } from '../../stores/jobStore'
import JobCard from './JobCard.vue'

const jobStore = useJobStore()

const jobs = computed(() => jobStore.filteredJobs)
</script>

<template>
  <div class="jobs-list">
    <div v-if="jobStore.isLoading" class="loading">加载中...</div>

    <div v-else-if="jobs.length === 0" class="empty">暂无任务</div>

    <JobCard v-for="job in jobs" :key="job.id" :job="job" />
  </div>
</template>

<style scoped>
.jobs-list {
  @apply space-y-2 overflow-y-auto pr-1;
  max-height: calc(100vh - 360px);
}

.loading,
.empty {
  @apply rounded-lg border py-8 text-center text-sm;
  border-color: var(--line);
  color: var(--ink-muted);
  background: var(--surface-muted);
}
</style>
