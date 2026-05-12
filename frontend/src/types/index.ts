export * from './api'

export interface AppState {
  apiBase: string
  currentJobId: string
  jobs: any[]
  currentJob: any | null
  templates: Record<string, any>
  logs: {
    stdout: string
    stderr: string
  }
  events: any[]
  humanActions: any[]
  humanInput: any
  humanDraft: string
  humanDraftType: string
  humanInputFocused: boolean
  activeLog: 'stdout' | 'stderr'
  pollTimer: number | null
}

export type JobStatus = 'created' | 'running' | 'completed' | 'failed' | 'canceled'

export interface JobFilter {
  template?: string
  status?: JobStatus
}
