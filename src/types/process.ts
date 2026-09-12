/** 工序 (Process) — 零件的加工步骤 */

export type ProcessCategory = 'INHOUSE' | 'OUTSOURCE'

export const PROCESS_CATEGORY_LABEL: Record<ProcessCategory, string> = {
  INHOUSE: '自产',
  OUTSOURCE: '外协',
}

export interface Process {
  id: string
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number
  code: string
  name: string
  category: ProcessCategory
  sort_order: number
  description: string | null
  /**
   * 外协工序是否需要报价审批（2026-07-28 新增）：
   * - true：走原有报价 + MANAGER 审批 + 发送流程（OUTSOURCE 默认）
   * - false：CLERK/INSPECTOR 可在「零件位于 C2 货架」前提下跳过报价直接发送
   * INHOUSE 工序固定为 false（无业务含义，仅占位）。
   */
  requires_approval: boolean
  created_at: string
  updated_at: string
  /** 2026-09-12 新增：可选，工序卡片左侧 4px 竖条颜色（hex #RRGGBB）。后端阶段二补字段。 */
  color?: string | null
}

/** 2026-09-12 新增：工序卡片配色预设（Element Plus 主题色 + 互补色），按 sort_order 顺序循环取用。 */
export const PROCESS_COLOR_PRESETS: readonly string[] = [
  '#409EFF', // Element Primary 蓝
  '#67C23A', // Element Success 绿
  '#E6A23C', // Element Warning 橙
  '#F56C6C', // Element Danger 红
  '#909399', // Element Info 灰
  '#9B59B6', // 紫
  '#1ABC9C', // 青
  '#E15C5C', // 暗红
] as const

export interface ProcessListResult {
  items: Process[]
  total: number
  limit: number
  offset: number
}

export interface ProcessCreatePayload {
  code: string
  name: string
  category: ProcessCategory
  sort_order?: number
  description?: string | null
  /** OUTSOURCE 默认 true；INHOUSE 由后端强制覆盖为 false */
  requires_approval?: boolean
}

export interface ProcessUpdatePayload {
  name?: string
  category?: ProcessCategory
  sort_order?: number
  description?: string | null
  requires_approval?: boolean
}