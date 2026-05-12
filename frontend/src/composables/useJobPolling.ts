import { ref, onUnmounted, watch } from 'vue'
import { useJobStore } from '../stores/jobStore'

export function useJobPolling(jobId: string | (() => string)) {
  const jobStore = useJobStore()
  const isPolling = ref(false)
  const pollInterval = ref(2500) // 2.5 seconds
  let pollTimer: number | null = null

  function getJobId(): string {
    return typeof jobId === 'function' ? jobId() : jobId
  }

  function startPolling() {
    if (pollTimer) {
      stopPolling()
    }

    const currentJobId = getJobId()
    if (!currentJobId) {
      return
    }

    isPolling.value = true

    pollTimer = window.setInterval(async () => {
      try {
        await jobStore.loadJob(currentJobId)
        const job = jobStore.currentJob

        // Stop polling if job is no longer running
        if (job && !['running', 'retrying'].includes(job.status)) {
          stopPolling()
        }
      } catch (error) {
        console.error('Polling error:', error)
        stopPolling()
      }
    }, pollInterval.value)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    isPolling.value = false
  }

  function updateInterval(newInterval: number) {
    pollInterval.value = newInterval
    if (isPolling.value) {
      stopPolling()
      startPolling()
    }
  }

  // Watch for jobId changes
  watch(
    () => getJobId(),
    (newJobId) => {
      if (newJobId) {
        startPolling()
      } else {
        stopPolling()
      }
    },
    { immediate: true }
  )

  // Cleanup on unmount
  onUnmounted(() => {
    stopPolling()
  })

  return {
    isPolling,
    pollInterval,
    startPolling,
    stopPolling,
    updateInterval
  }
}
