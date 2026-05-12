import { ref, computed, onUnmounted, watch } from 'vue'
import { useConfigStore } from '../stores/configStore'

export interface SSEEvent {
  type: string
  data: any
  timestamp: number
}

export function useSSE(jobId: string | (() => string)) {
  const configStore = useConfigStore()
  const events = ref<SSEEvent[]>([])
  const connectionStatus = ref<'connecting' | 'connected' | 'disconnected' | 'error'>(
    'disconnected'
  )
  let eventSource: EventSource | null = null
  let reconnectTimeout: number | null = null

  const jobIdValue = computed(() => (typeof jobId === 'function' ? jobId() : jobId))

  function connect() {
    if (eventSource) {
      eventSource.close()
    }

    if (!jobIdValue.value) {
      connectionStatus.value = 'disconnected'
      return
    }

    connectionStatus.value = 'connecting'
    const url = `${configStore.apiBase}/jobs/${jobIdValue.value}/push`

    try {
      eventSource = new EventSource(url)

      eventSource.onopen = () => {
        connectionStatus.value = 'connected'
      }

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          events.value.push({
            type: 'message',
            data,
            timestamp: Date.now()
          })
        } catch {
          // Handle non-JSON messages
        }
      }

      eventSource.addEventListener('progress', (event) => {
        try {
          const data = JSON.parse(event.data)
          events.value.push({
            type: 'progress',
            data,
            timestamp: Date.now()
          })
        } catch {
          // Handle parse error
        }
      })

      eventSource.addEventListener('warning', (event) => {
        try {
          const data = JSON.parse(event.data)
          events.value.push({
            type: 'warning',
            data,
            timestamp: Date.now()
          })
        } catch {
          // Handle parse error
        }
      })

      eventSource.addEventListener('complete', (event) => {
        try {
          const data = JSON.parse(event.data)
          events.value.push({
            type: 'complete',
            data,
            timestamp: Date.now()
          })
        } catch {
          // Handle parse error
        }
      })

      eventSource.onerror = () => {
        connectionStatus.value = 'error'
        scheduleReconnect()
      }
    } catch (error) {
      connectionStatus.value = 'error'
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
    }
    reconnectTimeout = window.setTimeout(() => {
      connect()
    }, 3000)
  }

  function disconnect() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    connectionStatus.value = 'disconnected'
  }

  function clearEvents() {
    events.value = []
  }

  // Watch for jobId changes
  watch(
    jobIdValue,
    (newJobId) => {
      if (newJobId) {
        connect()
      } else {
        disconnect()
      }
    },
    { immediate: true }
  )

  // Cleanup on unmount
  onUnmounted(() => {
    disconnect()
  })

  return {
    events,
    connectionStatus,
    connect,
    disconnect,
    clearEvents
  }
}
