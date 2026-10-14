// 工序制定链的 UI 类型：单个工序卡（`ProcessStep`）——有序工序列表里的一道，
// 带预计耗时与备注，工序制定页（ProcessDesignView）拿它渲染 / 拖拽 / 排序。
// 消费方是 `views/production/composables/useProcessDesignStore.ts`（未保存的草稿与
// 已保存的链都落这个形态）；落库形态是 `api/processChain.contract.ts` 的 DTO。

import type { ProcessCategory } from './process';

/** UI 单卡工序行。`uid` 仅用作 sortable.js / Vue v-for 的本地 key，不参与后端。 */
export interface ProcessStep {
  /** 本地 UI key（不参与后端，crypto.randomUUID 生成） */
  uid: string;
  /** FK → Process.id（雪花 ID 字符串，禁止 Number() 转换） */
  process_id: string;
  /** 冗余：便于 UI 直显，不依赖联表 */
  process_code: string;
  /** 冗余 */
  process_name: string;
  /** 冗余 */
  category: ProcessCategory;
  /** 整数预计耗时（分钟，el-input-number :precision=0） */
  estimated_minutes: number;
  /** 备注；空串/null 在持久化时归一化为 null */
  note: string | null;
  /** 0-based 排序，与 array.index 同步；写入时由 reorderSteps 重写 */
  sort_order: number;
  /** 2026-09-12 新增：从 process.color 透传（卡片左侧 4px 竖条），null 时回退到 category 默认色 */
  color?: string | null;
}
