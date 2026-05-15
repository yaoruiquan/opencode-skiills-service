import { describe, it, expect } from 'vitest'
import { formatSize, formatDate, formatJobRuntime, jobRuntimeSeconds } from '../formatters'

describe('formatters', () => {
  describe('formatSize', () => {
    it('formats bytes correctly', () => {
      expect(formatSize(0)).toBe('0 B')
      expect(formatSize(100)).toBe('100 B')
      expect(formatSize(1024)).toBe('1.0 KB')
      expect(formatSize(1024 * 1024)).toBe('1.0 MB')
      expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB')
    })

    it('handles decimal values', () => {
      expect(formatSize(1500)).toBe('1.5 KB')
      expect(formatSize(1500000)).toBe('1.4 MB')
    })
  })

  describe('formatDate', () => {
    it('formats ISO date strings', () => {
      const date = '2024-01-15T10:30:00.000Z'
      const result = formatDate(date)
      expect(result).toContain('2024')
      expect(result).toContain('01')
      expect(result).toContain('15')
    })

    it('handles invalid dates gracefully', () => {
      const result = formatDate('invalid-date')
      expect(result).toBeDefined()
    })
  })

  describe('job runtime formatting', () => {
    it('formats completed job duration from run timestamps', () => {
      const job = {
        status: 'succeeded',
        run: {
          startedAt: '2026-05-15T01:00:00.000Z',
          finishedAt: '2026-05-15T01:02:05.000Z'
        }
      }

      expect(jobRuntimeSeconds(job)).toBe(125)
      expect(formatJobRuntime(job)).toBe('耗时 2分5秒')
    })

    it('formats running job duration with current time', () => {
      const job = {
        status: 'running',
        run: {
          startedAt: '2026-05-15T01:00:00.000Z'
        }
      }

      expect(formatJobRuntime(job, Date.parse('2026-05-15T01:00:09.000Z'))).toBe('已运行 9秒')
    })

    it('shows not started when run has not begun', () => {
      expect(formatJobRuntime({ status: 'created' })).toBe('未开始')
    })
  })
})
