import { describe, expect, it } from 'vitest'
import { serializeParams, serializeParamsV1, serializeParamsV2 } from './http'

describe('serializeParamsV2', () => {
  // v2 端点（Rust axum）期望白名单 key（statuses）的数组 → CSV 单值。
  // 2026-08-29 拆分：原本与 v1 共用 serializeParams，v1 业务端点收到 CSV 会 422；
  // 现 v1/v2 分别走各自的具名 serializer。

  it('白名单 key statuses 单值数组 → CSV 单值形式', () => {
    expect(serializeParamsV2({ statuses: ['DRAFT'] })).toBe('statuses=DRAFT')
  })

  it('白名单 key statuses 多值数组 → CSV 多值', () => {
    expect(serializeParamsV2({ statuses: ['DRAFT', 'SUBMITTED'] })).toBe(
      'statuses=DRAFT%2CSUBMITTED',
    )
  })

  it('白名单 key statuses 空数组 → 该 key 不出现', () => {
    expect(serializeParamsV2({ statuses: [] })).toBe('')
  })

  it('白名单 key statuses 数组含空串 → 过滤', () => {
    expect(serializeParamsV2({ statuses: ['DRAFT', '', 'SUBMITTED'] })).toBe(
      'statuses=DRAFT%2CSUBMITTED',
    )
  })

  it('非白名单 key 数组维持重复 key 形式（保留 v1 兼容）', () => {
    expect(serializeParamsV2({ ids: ['1', '2'] })).toBe('ids=1&ids=2')
  })

  it('undefined/null 值跳过', () => {
    expect(serializeParamsV2({ a: undefined, b: null, c: 'x' })).toBe('c=x')
  })

  it('混合：白名单 CSV + 普通键', () => {
    const out = serializeParamsV2({
      statuses: ['DRAFT'],
      customer_id: '190000000000100',
    })
    expect(out).toBe('statuses=DRAFT&customer_id=190000000000100')
  })
})

describe('serializeParamsV1', () => {
  // v1 端点（Python FastAPI）期望数组走重复 key 形式（?k=a&k=b）。
  // FastAPI 的 List[OrderStatus] = Query(None) 收到 CSV 形式的单 key
  // 会把整个 "A,B" 解析成单元素列表 ["A,B"]，枚举校验失败 422。

  it('回归守卫：statuses 多值数组 → 重复 key 形式（不含逗号）', () => {
    // 2026-08-29 bug 守卫：listParts / listOutsourceQuotes 的 statuses 筛选
    // 因为原 serializeParams 被 v1/v2 共用 → 拿到 CSV → 后端 422。
    expect(
      serializeParamsV1({ statuses: ['PENDING', 'INSPECTION'] }),
    ).toBe('statuses=PENDING&statuses=INSPECTION')
    // 反向断言：不能是 CSV 单值（?statuses=PENDING%2CINSPECTION）
    expect(
      serializeParamsV1({ statuses: ['PENDING', 'INSPECTION'] }),
    ).not.toContain('%2C')
  })

  it('单值数组 → 单个重复 key', () => {
    expect(serializeParamsV1({ statuses: ['PENDING'] })).toBe(
      'statuses=PENDING',
    )
  })

  it('空数组 → 该 key 不出现', () => {
    expect(serializeParamsV1({ statuses: [] })).toBe('')
  })

  it('undefined/null 顶层值跳过', () => {
    expect(serializeParamsV1({ a: undefined, b: null, c: 'x' })).toBe('c=x')
  })

  it('其它数组（ids）维持重复 key 形式', () => {
    expect(serializeParamsV1({ ids: ['1', '2'] })).toBe('ids=1&ids=2')
  })

  it('空串数组元素：v1 不走 CSV 分支，原实现不过滤 → 输出 statuses=', () => {
    // 实际行为记录：v1 的「其它数组」分支只是把每个元素 push 一遍，
    // encodeURIComponent('') === ''，所以会拼出 ?statuses=&statuses=x。
    // 这是潜伏问题：FastAPI 解析空串仍会进 enum 校验失败。
    // 2026-08-29 决策：本次只拆 serializer，不动过滤语义；待后续如确认 v1 也需
    // 过滤空串再单独处理。详见本次任务报告。
    expect(
      serializeParamsV1({ statuses: ['PENDING', ''] }),
    ).toBe('statuses=PENDING&statuses=')
  })
})

describe('serializeParams（向后兼容别名）', () => {
  // 2026-08-29：serializeParams 保留为 serializeParamsV1 的 alias，供历史 import
  // 不至于崩。新代码请用具名版本。

  it('行为与 serializeParamsV1 一致', () => {
    const input = { statuses: ['PENDING', 'INSPECTION'], page: 1 }
    expect(serializeParams(input)).toBe(serializeParamsV1(input))
  })
})
