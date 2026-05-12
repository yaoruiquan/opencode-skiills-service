import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { ConfigField } from '../types'

export const useConfigStore = defineStore('config', () => {
  function defaultApiBase() {
    if (typeof window === 'undefined') return 'http://127.0.0.1:4100'
    const { protocol, hostname } = window.location
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://127.0.0.1:4100'
    }
    return `${protocol}//${hostname}:4100`
  }

  const apiBase = ref(localStorage.getItem('skillsApiBase') || defaultApiBase())
  const currentTemplate = ref('')
  const templateConfig = ref<Record<string, any>>({})
  const serviceConfig = ref('{}')

  // Load config from localStorage
  function loadConfig(templateName: string) {
    const saved = localStorage.getItem(`skillsTemplateConfig:${templateName}`)
    if (saved) {
      try {
        templateConfig.value = JSON.parse(saved)
      } catch {
        templateConfig.value = {}
      }
    } else {
      templateConfig.value = {}
    }
    currentTemplate.value = templateName
  }

  // Save config to localStorage
  function saveConfig() {
    if (currentTemplate.value) {
      localStorage.setItem(
        `skillsTemplateConfig:${currentTemplate.value}`,
        JSON.stringify(templateConfig.value)
      )
    }
  }

  // Update API base URL
  function setApiBase(url: string) {
    apiBase.value = url
    localStorage.setItem('skillsApiBase', url)
  }

  // Update template config field
  function updateField(field: string, value: any) {
    templateConfig.value[field] = value
    saveConfig()
  }

  // Reset config to defaults
  function resetConfig(defaults: Record<string, any>) {
    templateConfig.value = { ...defaults }
    saveConfig()
  }

  // Generate service config from template config
  function generateServiceConfig(configSchema: Record<string, ConfigField>) {
    const config: Record<string, any> = {}
    for (const [key, schema] of Object.entries(configSchema)) {
      config[key] = templateConfig.value[key] ?? schema.default
    }
    return JSON.stringify(config, null, 2)
  }

  // Watch for changes and auto-save
  watch(templateConfig, saveConfig, { deep: true })

  return {
    apiBase,
    currentTemplate,
    templateConfig,
    serviceConfig,
    loadConfig,
    saveConfig,
    setApiBase,
    updateField,
    resetConfig,
    generateServiceConfig
  }
})
