<script setup lang="ts">
import { computed } from 'vue'
import { useConfigStore } from '../../stores/configStore'
import type { Template } from '../../types'

const props = defineProps<{
  template?: Template
}>()

const configStore = useConfigStore()

const labelMap: Record<string, string> = {
  das_id: 'DAS 编号',
  target_path: '目标材料路径',
  cnvd_email: 'CNVD 账号',
  cnvd_password: 'CNVD 密码',
  cnnvd_email: 'CNNVD 账号',
  cnnvd_username: 'CNNVD 用户名',
  cnnvd_password: 'CNNVD 密码',
  ncc_username: 'NCC 账号',
  ncc_email: 'NCC 邮箱',
  ncc_password: 'NCC 密码',
  platform_username: '预警平台账号',
  platform_password: '预警平台密码',
  report_upload_host: '报告上传主机',
  report_upload_user: '报告上传用户',
  report_upload_password: '报告上传密码',
  dingtalk_webhook: '钉钉 Webhook',
  dingtalk_secret: '钉钉加签密钥',
  entity_description: '实体描述',
  verification: '验证过程',
  prefer_source: '优先来源',
  submit: '正式提交',
  dingtalk_notify: '钉钉通知',
  update_summary: '更新汇总',
  batch_dir: '批次目录',
  submitter: '提交人',
  cve: 'CVE 编号',
  advisory_url: '公告链接',
  vuln_title: '漏洞标题',
  wechat_draft: '公众号草稿',
  publish: '发布/预览',
  month: '月份',
  require_critical_descriptions: '要求高危描述',
  remote_host: '远端主机',
  remote_user: '远端用户',
  docker_container: 'Docker 容器',
  dry_run: '演练模式'
}

const configSchema = computed<Record<string, any>>(() => props.template?.configSchema || {})

const fields = computed(() =>
  Object.entries(configSchema.value).map(([key, raw]) => {
    const schema =
      typeof raw === 'object' && raw !== null && 'type' in raw
        ? raw
        : {
            type:
              typeof raw === 'boolean' ? 'boolean' : typeof raw === 'number' ? 'number' : 'text',
            default: raw
          }
    return {
      key,
      type: schema.type || 'text',
      label: schema.label || labelMap[key] || key,
      help: schema.help || '',
      options: schema.options || [],
      default: schema.default
    }
  })
)

function valueFor(field: { key: string; default: any }) {
  return configStore.templateConfig[field.key] ?? field.default
}

function updateField(field: string, value: any) {
  configStore.updateField(field, value)
}

function resetConfig() {
  const defaults: Record<string, any> = {}
  for (const field of fields.value) {
    defaults[field.key] = field.default
  }
  configStore.resetConfig(defaults)
}
</script>

<template>
  <section v-if="fields.length > 0" class="config-panel">
    <div class="config-head">
      <div>
        <h3>运行配置</h3>
        <p>账号、提交开关和模板参数会写入 job 的 service-config。</p>
      </div>
      <button type="button" class="reset-btn" @click="resetConfig">恢复默认</button>
    </div>

    <div class="config-grid">
      <div
        v-for="field in fields"
        :key="field.key"
        class="form-field"
        :class="{ 'is-boolean': field.type === 'boolean' }"
      >
        <template v-if="field.type === 'boolean'">
          <div class="flex items-center justify-between w-full">
            <div>
              <label :for="`config-${field.key}`" class="boolean-label">{{ field.label }}</label>
              <p v-if="field.help" class="help-text">{{ field.help }}</p>
            </div>
            <button
              type="button"
              class="toggle-switch"
              :class="{ 'is-on': valueFor(field) }"
              :aria-pressed="valueFor(field)"
              @click="updateField(field.key, !valueFor(field))"
            >
              <span class="toggle-knob"></span>
            </button>
          </div>
        </template>

        <template v-else>
          <label :for="`config-${field.key}`" class="block font-semibold text-slate-600 mb-1.5">{{
            field.label
          }}</label>

          <input
            v-if="field.type === 'text'"
            :id="`config-${field.key}`"
            :type="field.key.includes('password') ? 'password' : 'text'"
            :value="valueFor(field)"
            class="input"
            @input="updateField(field.key, ($event.target as HTMLInputElement).value)"
          />

          <textarea
            v-else-if="field.type === 'textarea'"
            :id="`config-${field.key}`"
            :value="valueFor(field)"
            class="input textarea-input"
            spellcheck="false"
            @input="updateField(field.key, ($event.target as HTMLTextAreaElement).value)"
          ></textarea>

          <input
            v-else-if="field.type === 'number'"
            :id="`config-${field.key}`"
            type="number"
            :value="valueFor(field)"
            class="input"
            @input="updateField(field.key, Number(($event.target as HTMLInputElement).value))"
          />

          <select
            v-else-if="field.type === 'select'"
            :id="`config-${field.key}`"
            :value="valueFor(field)"
            class="input"
            @change="updateField(field.key, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="option in field.options" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>

          <p v-if="field.help" class="help-text mt-1.5">{{ field.help }}</p>
        </template>
      </div>
    </div>

    <details class="advanced-config">
      <summary>查看完整 JSON 配置</summary>
      <div class="json-wrapper">
        <textarea
          :value="JSON.stringify(configStore.templateConfig, null, 2)"
          spellcheck="false"
          readonly
        ></textarea>
      </div>
    </details>
  </section>
</template>

<style scoped>
.config-panel {
  @apply rounded-xl border bg-white p-5;
  border-color: var(--line);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
}

.config-head {
  @apply mb-5 flex items-start justify-between gap-4;
}

.config-head h3 {
  @apply text-base font-bold text-slate-800;
}

.config-head p {
  @apply mt-1 text-sm text-slate-500;
}

.reset-btn {
  @apply text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 px-2.5 py-1.5 rounded-lg transition-colors;
}

.config-grid {
  @apply grid grid-cols-1 md:grid-cols-2 gap-4;
}

.form-field {
  @apply flex flex-col text-sm;
}

.form-field:not(.is-boolean) {
  @apply bg-slate-50 border border-slate-100 p-3.5 rounded-xl;
}

.form-field.is-boolean {
  @apply flex-row items-center bg-slate-50 border border-slate-100 px-4 py-3 rounded-xl transition-colors;
}

.form-field.is-boolean:hover {
  @apply bg-slate-100;
}

.boolean-label {
  @apply font-semibold text-slate-700 cursor-pointer select-none;
}

.help-text {
  @apply text-xs text-slate-400 mt-1;
}

.textarea-input {
  min-height: 112px;
  resize: vertical;
}

/* Toggle Switch Styles */
.toggle-switch {
  @apply relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2;
  background-color: var(--line-strong);
}

.toggle-switch.is-on {
  background-color: var(--brand);
}

.toggle-knob {
  @apply pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out;
  transform: translateX(0);
}

.toggle-switch.is-on .toggle-knob {
  transform: translateX(1.25rem);
}

/* Advanced Config Accordion */
.advanced-config {
  @apply mt-6 border-t pt-4;
  border-color: var(--line);
}

.advanced-config summary {
  @apply cursor-pointer text-sm font-semibold text-slate-500 hover:text-slate-800 transition-colors select-none flex items-center gap-1;
}

.advanced-config summary::-webkit-details-marker {
  display: none;
}

.advanced-config summary::before {
  content: '►';
  @apply inline-block text-[10px] transition-transform duration-200 opacity-60 mr-1;
}

.advanced-config[open] summary::before {
  transform: rotate(90deg);
}

.json-wrapper {
  @apply mt-3 p-1 rounded-lg border bg-slate-50;
  border-color: var(--line);
}

.advanced-config textarea {
  @apply w-full h-32 bg-transparent text-slate-600 font-mono text-xs p-3 outline-none resize-y;
}
</style>
