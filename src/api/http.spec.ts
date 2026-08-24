import { describe, expect, it } from 'vitest'
import { serializeParams } from './http'

describe('serializeParams', () => {
  it('白名单 key statuses 单值数组 → CSV 单值形式', () => {
    expect(serializeParams({ statuses: ['DRAFT'] })).toBe('statuses=DRAFT')
  })

  it('白名单 key statuses 多值数组 → CSV 多值', () => {
    expect(serializeParams({ statuses: ['DRAFT', 'SUBMITTED'] })).toBe(
      'statuses=DRAFT%2CSUBMITTED',
    )
  })

  it('白名单 key statuses 空数组 → 该 key 不出现', () => {
    expect(serializeParams({ statuses: [] })).toBe('')
  })

  it('白名单 key statuses 数组含空串 → 过滤', () => {
    expect(serializeParams({ statuses: ['DRAFT', '', 'SUBMITTED'] })).toBe(
      'statuses=DRAFT%2CSUBMITTED',
    )
  })

  it('非白名单 key 数组维持重复 key 形式（保留 v1 兼容）', () => {
    expect(serializeParams({ ids: ['1', '2'] })).toBe('ids=1&ids=2')
  })

  it('undefined/null 值跳过', () => {
    expect(serializeParams({ a: undefined, b: null, c: 'x' })).toBe('c=x')
  })

  it('混合：白名单 CSV + 普通键', () => {
    const out = serializeParams({ statuses: ['DRAFT'], customer_id: '190000000000100' })
    expect(out).toBe('statuses=DRAFT&customer_id=190000000000100')
  })
})
