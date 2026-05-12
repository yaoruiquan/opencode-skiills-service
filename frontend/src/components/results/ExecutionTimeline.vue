<script setup lang="ts">
import { computed } from 'vue'
import { useJobStore } from '../../stores/jobStore'

const jobStore = useJobStore()

const events = computed(() => jobStore.currentJob?.events || [])

function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    running: '进行中',
    done: '完成',
    failed: '失败',
    warning: '等待处理'
  }
  return labels[status || ''] || status || '记录'
}

function formatTime(value?: string) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return value
  }
}
</script>

<template>
  <div class="timeline">
    <div v-if="events.length === 0" class="empty">
      暂无执行状态。确定性适配器会显示业务阶段；OpenCode 路径会显示模型尝试和工具调用。
    </div>

    <ol v-else>
      <li
        v-for="(event, index) in events"
        :key="`${event.time || index}-${event.label || event.stage || event.type}`"
        class="event"
        :class="`is-${event.status || 'info'}`"
      >
        <div class="event-dot"></div>
        <div class="event-body">
          <div class="event-head">
            <strong>{{ event.label || event.stage || event.type || '执行事件' }}</strong>
            <span>{{ statusLabel(event.status) }}</span>
          </div>
          <p v-if="event.detail">{{ event.detail }}</p>
          <div class="event-meta">
            <span>{{ formatTime(event.time) }}</span>
            <span v-if="event.stage">{{ event.stage }}</span>
            <span v-if="event.tool">{{ event.tool }}</span>
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.timeline {
  @apply rounded-lg border p-4;
  border-color: var(--line);
  background: var(--surface);
}

.empty {
  @apply rounded-lg border py-8 text-center text-sm;
  border-color: var(--line);
  color: var(--ink-muted);
  background: var(--surface-muted);
}

ol {
  @apply space-y-3;
}

.event {
  @apply relative flex gap-3 rounded-lg border p-3;
  border-color: var(--line);
  background: #fbfcfd;
}

.event-dot {
  @apply mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full;
  background: var(--ink-soft);
}

.event.is-running .event-dot {
  @apply animate-pulse;
  background: #2563eb;
}

.event.is-done .event-dot {
  background: var(--success);
}

.event.is-failed .event-dot {
  background: var(--danger);
}

.event.is-warning .event-dot {
  background: var(--warning);
}

.event-body {
  @apply min-w-0 flex-1;
}

.event-head {
  @apply flex items-center justify-between gap-3;
}

.event-head strong {
  @apply truncate text-sm;
  color: var(--ink);
}

.event-head span {
  @apply shrink-0 rounded-full px-2 py-0.5 text-xs font-medium;
  color: var(--ink-muted);
  background: var(--surface-strong);
}

.event p {
  @apply mt-1 break-words text-sm;
  color: var(--ink-muted);
}

.event-meta {
  @apply mt-2 flex flex-wrap gap-2 text-xs;
  color: var(--ink-soft);
}
</style>
