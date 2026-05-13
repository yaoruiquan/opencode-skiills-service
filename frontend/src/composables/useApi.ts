import { useConfigStore } from '../stores/configStore'

export function useApi() {
  const configStore = useConfigStore()

  async function request(path: string, options: RequestInit = {}) {
    const url = `${configStore.apiBase}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    })

    const text = await response.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        const plainText = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        const message =
          response.status === 413
            ? '上传文件过大，请压缩材料或分批上传。'
            : plainText || `HTTP ${response.status}`
        throw new Error(message)
      }
    }

    if (!response.ok) {
      const message =
        data.message && data.error
          ? `${data.message}: ${data.error}`
          : data.message || data.error || `HTTP ${response.status}`
      throw new Error(message)
    }

    return data
  }

  function get(path: string) {
    return request(path)
  }

  function post(path: string, body?: any) {
    return request(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined
    })
  }

  function put(path: string, body?: any) {
    return request(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined
    })
  }

  function del(path: string) {
    return request(path, { method: 'DELETE' })
  }

  function outputUrl(jobId: string, filePath: string) {
    return `${configStore.apiBase}/jobs/${jobId}/outputs/${encodeURIComponent(filePath)}`
  }

  function logUrl(jobId: string, logFile: string) {
    return `${configStore.apiBase}/jobs/${jobId}/logs/${encodeURIComponent(logFile)}`
  }

  function archiveUrl(jobId: string) {
    return `${configStore.apiBase}/jobs/${jobId}/archive`
  }

  return {
    request,
    get,
    post,
    put,
    del,
    outputUrl,
    logUrl,
    archiveUrl
  }
}
