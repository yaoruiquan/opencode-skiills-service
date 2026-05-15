<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useJobStore } from './stores/jobStore'
import AppHeader from './components/layout/AppHeader.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import TaskEditor from './components/editor/TaskEditor.vue'
import ResultsPanel from './components/results/ResultsPanel.vue'
import HumanVerification from './components/human/HumanVerification.vue'

const jobStore = useJobStore()
const isLoading = ref(true)
const toastMessage = ref('')
const showToast = ref(false)
let refreshTimer: number | null = null

function showToastMessage(message: string) {
  toastMessage.value = message
  showToast.value = true
  setTimeout(() => {
    showToast.value = false
  }, 3000)
}

onMounted(async () => {
  try {
    await jobStore.loadTemplates()
    await jobStore.loadJobs()
  } catch (error) {
    console.error('Failed to initialize:', error)
    showToastMessage('初始化失败，请检查网络连接')
  } finally {
    isLoading.value = false
  }

  refreshTimer = window.setInterval(async () => {
    jobStore.tickNow()
    const hasRunningJob = jobStore.jobs.some((job) => job.status === 'running')
    const currentJobId = jobStore.currentJob?.id
    if (!hasRunningJob && jobStore.currentJob?.status !== 'running') return
    try {
      if (currentJobId) await jobStore.loadJob(currentJobId, { onlyIfCurrent: true })
      await jobStore.loadJobs()
    } catch (error) {
      console.error('Failed to refresh jobs:', error)
    }
  }, 2500)
})

onUnmounted(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
})
</script>

<template>
  <div class="shell">
    <AppHeader />

    <main class="workspace">
      <section class="workbench card" aria-label="任务编辑器">
        <TaskEditor />
        <HumanVerification />
      </section>

      <AppSidebar />
    </main>

    <section class="results-wrap">
      <ResultsPanel />
    </section>

    <div v-if="showToast" class="toast" role="status" aria-live="polite">
      {{ toastMessage }}
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 18px;
  padding: 18px 22px 0;
  align-items: start;
}

.workbench {
  min-height: 560px;
}

.results-wrap {
  padding: 0 22px 24px;
}

.toast {
  @apply fixed bottom-4 right-4 rounded-md px-4 py-2 text-sm text-white shadow-lg z-50;
  background: var(--ink);
}
</style>
