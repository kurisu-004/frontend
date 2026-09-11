// 2026-09-11 新增：零件 → 工序流程 (PartProcessFlow) 类型定义。
// 阶段一（mock）：仅前端 composable + localStorage 持久化；阶段二切真接口后
// `PartProcessFlow` 字段含义与后端 schema 对齐，`ProcessStep` 字段全部保留。
//
// 业务含义：替代「Part 单值 next_process_id」+「工人扫码口头约定」的混乱状态。
// 每个 Part 维护一个有序工序列表（粗加工 → 精加工 → 品检 → 外协热处理…），
// 每道工序带预计耗时与备注；后续工人扫码后即可按流程卡点推进。

import type { ProcessCategory } from './process'

/** UI 单卡工序行。`uid` 仅用作 sortable.js / Vue v-for 的本地 key，不参与后端。 */
export interface ProcessStep {
  /** 本地 UI key（不参与后端，crypto.randomUUID 生成） */
  uid: string
  /** FK → Process.id（雪花 ID 字符串，禁止 Number() 转换） */
  process_id: string
  /** 冗余：便于 UI 直显，不依赖联表 */
  process_code: string
  /** 冗余 */
  process_name: string
  /** 冗余 */
  category: ProcessCategory
  /** 整数预计耗时（分钟，el-input-number :precision=0） */
  estimated_minutes: number
  /** 备注；空串/null 在持久化时归一化为 null */
  note: string | null
  /** 0-based 排序，与 array.index 同步；写入时由 reorderSteps 重写 */
  sort_order: number
}

/** 零件 → 工序流程表（mock 阶段 version 始终 0；阶段二对齐后端 schema）。 */
export interface PartProcessFlow {
  /** FK → Part.id（雪花 ID 字符串） */
  part_id: string
  /** 乐观锁版本号；mock 阶段始终 0；阶段二与后端 OCC 对齐 */
  version: number
  steps: ProcessStep[]
  /** ISO 字符串；每次 upsert/reorder/delete 时刷新 */
  updated_at: string
}

/** 摘要：用于右栏 toolbar 展示总耗时 / 含外协提示。 */
export interface PartProcessSummary {
  step_count: number
  total_minutes: number
  /** 流程中任一工序 category === 'OUTSOURCE' 且 requires_approval=true 时为 true */
  has_outsource_approval: boolean
}
