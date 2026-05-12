<script setup lang="ts">
import { ref, computed } from 'vue'
import { useJobStore } from '../../stores/jobStore'
import { useApi } from '../../composables/useApi'

const jobStore = useJobStore()
const api = useApi()

const verificationType = ref<'captcha' | 'confirmation'>('captcha')
const inputValue = ref('')
const isSubmitting = ref(false)

const currentJob = computed(() => jobStore.currentJob)
const hasPendingVerification = computed(
  () => currentJob.value?.status === 'running' && (currentJob.value.actions?.length || 0) > 0
)

const pendingActions = computed(() => currentJob.value?.actions || [])

function screenshotPath(action: Record<string, any>) {
  const detail = String(action.detail || '')
  const match = detail.match(/logs\/([^\s，。；,;]+?\.(?:png|jpg|jpeg|webp))/i)
  return match?.[1] || ''
}

function screenshotUrl(action: Record<string, any>) {
  if (!currentJob.value) return ''
  const logFile = screenshotPath(action)
  return logFile ? api.logUrl(currentJob.value.id, logFile) : ''
}

async function submitVerification() {
  if (!currentJob.value || !inputValue.value) return

  isSubmitting.value = true
  try {
    await api.post(`/jobs/${currentJob.value.id}/human-input`, {
      type: verificationType.value,
      value: inputValue.value
    })
    inputValue.value = ''
    await jobStore.loadJob(currentJob.value.id)
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div v-if="hasPendingVerification" class="human-verification">
    <h3>人工验证</h3>
    <p class="description">任务需要人工验证才能继续。</p>

    <ul v-if="pendingActions.length" class="action-list">
      <li v-for="action in pendingActions" :key="`${action.time}-${action.stage}`">
        <strong>{{ action.label || action.stage }}</strong>
        <span>{{ action.detail }}</span>
        <img
          v-if="screenshotUrl(action)"
          class="verification-shot"
          :src="screenshotUrl(action)"
          alt="验证码截图"
        />
      </li>
    </ul>

    <div class="verification-form">
      <label>
        验证类型
        <select v-model="verificationType">
          <option value="captcha">验证码</option>
          <option value="confirmation">确认</option>
        </select>
      </label>

      <label>
        输入内容
        <input
          v-model="inputValue"
          type="text"
          :placeholder="verificationType === 'captcha' ? '请输入验证码' : '请输入确认内容'"
          @keyup.enter="submitVerification"
        />
      </label>

      <button type="button" :disabled="!inputValue || isSubmitting" @click="submitVerification">
        {{ isSubmitting ? '提交中...' : '提交验证' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.human-verification {
  @apply bg-yellow-50 border border-yellow-200 rounded-lg p-4 mt-4;
}

h3 {
  @apply text-lg font-semibold text-yellow-800 mb-2;
}

.description {
  @apply text-yellow-700 mb-4;
}

.action-list {
  @apply space-y-2 mb-4 text-sm text-yellow-800;
}

.action-list li {
  @apply flex flex-col gap-1 rounded border border-yellow-200 bg-white p-2;
}

.verification-shot {
  @apply mt-2 max-h-72 w-full rounded border object-contain;
  border-color: var(--line);
  background: #fff;
}

.verification-form {
  @apply space-y-4;
}

.verification-form label {
  @apply block;
}

.verification-form input,
.verification-form select {
  @apply w-full px-3 py-2 border border-yellow-300 rounded mt-1;
}

.verification-form button {
  @apply w-full px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50;
}
</style>
