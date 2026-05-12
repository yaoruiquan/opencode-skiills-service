<script setup lang="ts">
import { computed } from 'vue'
import { useJobStore } from '../../stores/jobStore'

defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const jobStore = useJobStore()

const templates = computed(() => Object.keys(jobStore.templates))

const templateLabels: Record<string, string> = {
  md2wechat: '公众号转换',
  custom: '自定义',
  'vulnerability-alert-processor': '漏洞预警材料',
  'phase1-material-processor': '材料整理',
  'msrc-vulnerability-report': 'MSRC 预警报告',
  'cnvd-weekly-db-update': 'CNVD 周库更新',
  'phase2-cnvd-report': 'CNVD 上报',
  'phase2-cnnvd-report': 'CNNVD 上报',
  'phase2-ncc-report': 'NCC 上报'
}

function onChange(event: Event) {
  const target = event.target as HTMLSelectElement
  emit('update:modelValue', target.value)
}
</script>

<template>
  <label class="template-select">
    任务模板
    <select :value="modelValue" @change="onChange">
      <option v-for="template in templates" :key="template" :value="template">
        {{ templateLabels[template] || template }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.template-select {
  @apply col-span-3 flex flex-col text-sm font-medium;
  color: var(--ink-muted);
}

select {
  @apply mt-1 rounded-md border px-3 py-2 text-sm outline-none;
  border-color: var(--line);
  color: var(--ink);
}
</style>
