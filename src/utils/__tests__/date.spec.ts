// date.ts 单元测试（2026-08-25 frontend-overall-refactor）。
//
// 验证 formatDate / formatDateTime 在以下场景下的行为：
// - 空值（null/undefined/''）→ DEFAULT_DATE ('—')
// - ISO 字符串（带 'Z'）→ UTC 格式化
// - Date 实例 → 同样格式化
// - 无效输入 → DEFAULT_DATE
// - withSeconds 选项

import { describe, it, expect } from 'vitest'
import { formatDate, formatDateTime } from '../date'

describe('formatDate', () => {
  it('空值返回占位符', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
    expect(formatDate('')).toBe('—')
  })

  it('ISO 字符串 → YYYY-MM-DD（UTC）', () => {
    expect(formatDate('2024-08-25T10:30:00Z')).toBe('2024-08-25')
    expect(formatDate('2024-08-25T23:59:59Z')).toBe('2024-08-25')
    // 跨 UTC 日期：UTC 8:00 之前显示前一日
    expect(formatDate('2024-08-25T01:00:00Z')).toBe('2024-08-25')
  })

  it('Date 实例同样输出 UTC YYYY-MM-DD', () => {
    const d = new Date('2024-01-15T12:00:00Z')
    expect(formatDate(d)).toBe('2024-01-15')
  })

  it('无效字符串返回占位符', () => {
    expect(formatDate('not-a-date')).toBe('—')
    expect(formatDate('2024-13-45')).toBe('—')
  })
})

describe('formatDateTime', () => {
  it('空值返回占位符', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime(undefined)).toBe('—')
    expect(formatDateTime('')).toBe('—')
  })

  it('默认输出 YYYY-MM-DD HH:mm', () => {
    expect(formatDateTime('2024-08-25T10:30:00Z')).toBe('2024-08-25 10:30')
    expect(formatDateTime('2024-08-25T10:30:45Z')).toBe('2024-08-25 10:30')
  })

  it('withSeconds: true 输出 YYYY-MM-DD HH:mm:ss', () => {
    expect(formatDateTime('2024-08-25T10:30:45Z', { withSeconds: true })).toBe('2024-08-25 10:30:45')
  })

  it('Date 实例同样工作', () => {
    const d = new Date('2024-01-15T12:34:56Z')
    expect(formatDateTime(d)).toBe('2024-01-15 12:34')
    expect(formatDateTime(d, { withSeconds: true })).toBe('2024-01-15 12:34:56')
  })

  it('无效输入返回占位符', () => {
    expect(formatDateTime('not-a-date')).toBe('—')
  })
})
