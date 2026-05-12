<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useJobStore } from '../../stores/jobStore'

const jobStore = useJobStore()

const activeLog = ref<'stdout' | 'stderr'>('stdout')

const currentJob = computed(() => jobStore.currentJob)

const logs = computed(() => {
  if (!currentJob.value) return { stdout: '', stderr: '' }
  return {
    stdout: currentJob.value.logs?.stdout || '',
    stderr: currentJob.value.logs?.stderr || currentJob.value.run?.error || ''
  }
})

const currentLog = computed(() => logs.value[activeLog.value])

watch(
  () => currentJob.value?.id,
  () => {
    // Reset to stdout when job changes
    activeLog.value = 'stdout'
  }
)
</script>

<template>
  <div class="log-viewer">
    <div class="log-tabs">
      <button
        :class="{ 'is-active': activeLog === 'stdout' }"
        type="button"
        @click="activeLog = 'stdout'"
      >
        标准输出
      </button>
      <button
        :class="{ 'is-active': activeLog === 'stderr' }"
        type="button"
        @click="activeLog = 'stderr'"
      >
        错误输出
      </button>
    </div>

    <pre class="log-content">{{ currentLog }}</pre>
  </div>
</template>

<style scoped>
.log-viewer {
  @apply space-y-2;
}

.log-tabs {
  @apply inline-flex rounded-md border p-1;
  border-color: var(--line);
  background: var(--surface-muted);
}

.log-tabs button {
  @apply rounded px-4 py-2 text-sm font-medium;
  color: var(--ink-muted);
}

.log-tabs button.is-active {
  background: var(--ink);
  color: white;
}

.log-tabs button:not(.is-active) {
  @apply hover:bg-white;
}

.log-content {
  @apply max-h-80 overflow-auto rounded-lg p-4 font-mono text-sm;
  background: #101620;
  color: #b9f5d0;
}
</style>
