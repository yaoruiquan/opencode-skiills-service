import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useApi } from '../composables/useApi'
import type { Job, Template, JobStatus } from '../types'

export const useJobStore = defineStore('job', () => {
  const api = useApi()

  const jobs = ref<Job[]>([])
  const currentJob = ref<Job | null>(null)
  const templates = ref<Record<string, Template>>({})
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const filteredJobs = ref<Job[]>([])
  const activeTemplateFilter = ref<string | undefined>(undefined)
  const activeStatusFilter = ref<JobStatus | undefined>(undefined)

  const runningJobs = computed(() => jobs.value.filter((job) => job.status === 'running'))

  const completedJobs = computed(() => jobs.value.filter((job) => job.status === 'completed'))

  async function loadTemplates() {
    try {
      const response = await api.get('/health')
      templates.value = Array.isArray(response.templates)
        ? Object.fromEntries(
            response.templates.map((template: Template) => [template.name, template])
          )
        : response.templates || {}
    } catch (e) {
      error.value = 'Failed to load templates'
      throw e
    }
  }

  async function loadJobs() {
    isLoading.value = true
    try {
      const response = await api.get('/jobs')
      jobs.value = Array.isArray(response) ? response : response.jobs || []
      applyFilters()
    } catch (e) {
      error.value = 'Failed to load jobs'
      throw e
    } finally {
      isLoading.value = false
    }
  }

  async function loadJob(jobId: string) {
    try {
      const response = await api.get(`/jobs/${jobId}`)
      currentJob.value = response
      upsertJob(response)
      return response
    } catch (e) {
      error.value = 'Failed to load job'
      throw e
    }
  }

  async function createJob(template: string, title: string) {
    try {
      const response = await api.post('/jobs', { template, title })
      jobs.value.unshift(response)
      currentJob.value = response
      return response
    } catch (e) {
      error.value = 'Failed to create job'
      throw e
    }
  }

  async function runJob(jobId: string, options: any) {
    try {
      const response = await api.post(`/jobs/${jobId}/run`, options)
      upsertJob(response)
      await loadJob(jobId)
      await loadJobs()
      return response
    } catch (e) {
      error.value = 'Failed to run job'
      throw e
    }
  }

  async function cancelJob(jobId: string) {
    try {
      await api.post(`/jobs/${jobId}/cancel`)
      await loadJob(jobId)
      await loadJobs()
    } catch (e) {
      error.value = 'Failed to cancel job'
      throw e
    }
  }

  async function deleteJob(jobId: string) {
    try {
      await api.del(`/jobs/${jobId}`)
      jobs.value = jobs.value.filter((job) => job.id !== jobId)
      filteredJobs.value = filteredJobs.value.filter((job) => job.id !== jobId)
      if (currentJob.value?.id === jobId) {
        currentJob.value = null
      }
    } catch (e) {
      error.value = 'Failed to delete job'
      throw e
    }
  }

  function filterJobs(template?: string, status?: JobStatus) {
    activeTemplateFilter.value = template
    activeStatusFilter.value = status
    applyFilters()
  }

  function applyFilters() {
    filteredJobs.value = jobs.value.filter((job) => {
      if (activeTemplateFilter.value && job.template !== activeTemplateFilter.value) return false
      if (activeStatusFilter.value && job.status !== activeStatusFilter.value) return false
      return true
    })
  }

  function upsertJob(job: Job) {
    const index = jobs.value.findIndex((item) => item.id === job.id)
    if (index >= 0) {
      jobs.value[index] = { ...jobs.value[index], ...job }
    } else {
      jobs.value.unshift(job)
    }
    applyFilters()
  }

  function patchCurrentJob(jobId: string, patch: Partial<Job>) {
    if (currentJob.value?.id === jobId) {
      currentJob.value = { ...currentJob.value, ...patch }
    }
    const index = jobs.value.findIndex((item) => item.id === jobId)
    if (index >= 0) {
      jobs.value[index] = { ...jobs.value[index], ...patch }
      applyFilters()
    }
  }

  function clearError() {
    error.value = null
  }

  return {
    jobs,
    currentJob,
    templates,
    isLoading,
    error,
    filteredJobs,
    runningJobs,
    completedJobs,
    loadTemplates,
    loadJobs,
    loadJob,
    createJob,
    runJob,
    cancelJob,
    deleteJob,
    patchCurrentJob,
    filterJobs,
    clearError
  }
})
