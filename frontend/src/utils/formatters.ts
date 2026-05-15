export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return dateString
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}时${minutes}分`
}

export function jobRuntimeSeconds(job: any, nowMs = Date.now()): number | null {
  const startedAt = Date.parse(job?.run?.startedAt || '')
  if (!Number.isFinite(startedAt)) return null

  const finishedAt = Date.parse(job?.run?.finishedAt || '')
  const fallbackEnd = ['running', 'retrying'].includes(job?.status)
    ? nowMs
    : Date.parse(job?.updatedAt || '')
  const endAt = Number.isFinite(finishedAt)
    ? finishedAt
    : Number.isFinite(fallbackEnd)
      ? fallbackEnd
      : nowMs

  return Math.max(0, Math.floor((endAt - startedAt) / 1000))
}

export function formatJobRuntime(job: any, nowMs = Date.now()): string {
  const seconds = jobRuntimeSeconds(job, nowMs)
  if (seconds === null) return '未开始'
  const prefix = ['running', 'retrying'].includes(job?.status) ? '已运行 ' : '耗时 '
  return `${prefix}${formatDuration(seconds)}`
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + '...'
}
