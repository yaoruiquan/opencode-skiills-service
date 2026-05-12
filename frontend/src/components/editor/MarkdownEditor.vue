<script setup lang="ts">
defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

function onInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
}
</script>

<template>
  <div class="markdown-editor">
    <label>
      Markdown 内容
      <textarea :value="modelValue" spellcheck="false" @input="onInput"></textarea>
    </label>
  </div>
</template>

<style scoped>
.markdown-editor {
  @apply rounded-lg border p-4;
  border-color: var(--line);
  background: var(--surface);
}

.markdown-editor label {
  @apply block;
}

.markdown-editor textarea {
  @apply mt-2 h-72 w-full resize-y rounded-md border px-4 py-3 font-mono text-sm outline-none;
  border-color: var(--line);
  color: var(--ink);
}
</style>
