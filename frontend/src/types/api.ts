export interface HealthResponse {
  ok: boolean
  templates: Record<string, Template>
}

export interface Template {
  name: string
  label?: string
  description: string
  type: 'adapter' | 'llm'
  inputMode?: string
  modes?: string[]
  configSchema?: Record<string, ConfigField>
}

export interface ConfigField {
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select'
  label: string
  help?: string
  default?: any
  options?: { value: string; label: string }[]
}

export interface Job {
  id: string
  type: string
  template: string
  title: string
  status: 'created' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'canceled'
  effectiveStatus?: 'created' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'canceled' | 'submitted'
  effectiveStatusLabel?: string
  platformId?: string
  submissionResult?: Record<string, any> | null
  createdAt: string
  updatedAt: string
  paths: {
    root: string
    input: string
    output: string
    logs: string
    metadata: string
  }
  files: FileInfo[]
  outputs?: OutputFile[]
  logs?: LogsResponse & { files?: FileInfo[] }
  events?: Array<Record<string, any>>
  actions?: Array<Record<string, any>>
  humanInput?: Record<string, any> | null
  run?: RunInfo
}

export interface FileInfo {
  path: string
  size: number
  writtenAt: string
}

export interface RunInfo {
  template: string
  options: any
  model?: string
  models?: string[]
  prompt?: string
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  attempts?: Attempt[]
  adapter?: boolean
  error?: string
}

export interface Attempt {
  model: string
  attempt: number
  retry: number
  startedAt: string
  finishedAt?: string
  exitCode?: number
}

export interface LogsResponse {
  stdout: string
  stderr: string
}

export interface OutputsResponse {
  files: OutputFile[]
  grouped: Record<string, OutputFile[]>
}

export interface OutputFile {
  path: string
  name: string
  size: number
  group?: string
}
