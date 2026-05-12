<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useConfigStore } from '../../stores/configStore'

const configStore = useConfigStore()
const apiBaseInput = ref(configStore.apiBase)
const showSettings = ref(false)
const popoverRef = ref<HTMLElement | null>(null)

function saveApiBase() {
  configStore.setApiBase(apiBaseInput.value)
  showSettings.value = false
}

function handleClickOutside(event: MouseEvent) {
  if (showSettings.value && popoverRef.value && !popoverRef.value.contains(event.target as Node)) {
    const target = event.target as HTMLElement
    if (!target.closest('.settings-btn')) {
      showSettings.value = false
    }
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <header class="topbar">
    <div class="brand-block">
      <div class="mark">OS</div>
      <div>
        <p class="eyebrow">OpenCode Skills</p>
        <h1>自动化任务控制台</h1>
      </div>
    </div>

    <div class="relative">
      <button class="settings-btn" @click="showSettings = !showSettings" title="设置 API 地址">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
          ></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </button>

      <div v-if="showSettings" ref="popoverRef" class="settings-popover">
        <div class="p-4">
          <label
            for="apiBase"
            class="block text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide"
            >API 服务地址</label
          >
          <input
            id="apiBase"
            v-model="apiBaseInput"
            type="url"
            class="input mb-3"
            placeholder="http://127.0.0.1:4100"
            @keyup.enter="saveApiBase"
          />
          <button type="button" class="btn btn-primary w-full" @click="saveApiBase">
            保存并应用
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  @apply sticky top-0 z-40 flex items-center justify-between border-b px-6 py-3;
  background: rgba(255, 255, 255, 0.85);
  border-color: var(--line);
  backdrop-filter: blur(12px);
}

.brand-block {
  @apply flex items-center gap-3;
}

.mark {
  @apply flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white;
  background: linear-gradient(135deg, var(--brand) 0%, var(--brand-strong) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    0 2px 4px rgba(37, 99, 235, 0.2);
}

.eyebrow {
  @apply text-[10px] font-bold uppercase tracking-wider mb-0.5;
  color: var(--brand);
}

h1 {
  @apply text-lg font-bold leading-none text-slate-800;
  letter-spacing: -0.01em;
}

.settings-btn {
  @apply p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer outline-none;
}

.settings-popover {
  @apply absolute right-0 mt-2 w-72 bg-white rounded-xl border shadow-xl z-50;
  border-color: var(--line);
  box-shadow:
    0 10px 25px -5px rgba(0, 0, 0, 0.1),
    0 8px 10px -6px rgba(0, 0, 0, 0.1);
  transform-origin: top right;
  animation: scale-in 0.15s ease-out;
}

@keyframes scale-in {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
