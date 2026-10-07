// 送货单的**枚举与文案表**（`src/types/deliveryNote.ts`）。
//
// 2026-10-08：VO 镜像整体迁到 `src/views/com/delivery/composables/deliveryNoteSchema.ts`
// （Zod 守门 schema，`z.infer` 派生 `*Data` 类型）。本文件此后**只留 wire 契约之外的东西**：
// 状态枚举、状态中文标签 / 标签色、排序键、扫码阻塞错误码 —— 它们不是后端 VO 的一部分，
// 是前端自己的展示口径与判据。

import type { OrderStatus } from './parts';

export type DeliveryNoteStatus = 'DRAFT' | 'SUBMITTED' | 'PICKED_UP' | 'ARCHIVED';

export const DELIVERY_NOTE_STATUS_LABEL: Record<DeliveryNoteStatus, string> = {
  DRAFT: '草稿',
  SUBMITTED: '待送货',
  PICKED_UP: '已送货',
  ARCHIVED: '已归档',
};

// Element Plus el-tag type 映射：未配置则降级为 plain info。
export const DELIVERY_NOTE_STATUS_TAG: Record<
  DeliveryNoteStatus,
  'info' | 'warning' | 'success' | 'danger' | ''
> = {
  DRAFT: 'info',
  SUBMITTED: 'warning',
  PICKED_UP: 'success',
  ARCHIVED: '',
};

/** 一览排序键（`sort_by` 的取值集合）。 */
export type DeliveryNoteSortKey =
  | 'CREATED_AT'
  | 'SUBMITTED_AT'
  | 'PICKED_UP_AT'
  | 'DELIVERY_NOTE_NO';

export type DeliveryNoteSortDir = 'ASC' | 'DESC';

/** 行项的批次状态标签复用零件一览的 OrderStatus 口径（同一批 `t_part_batch.status`）。 */
export type { OrderStatus };

/**
 * 扫码入单会抛「批次状态不允许」的阻塞错误码集合。
 * 后端把 DELIVERED / OUTSOURCE / IN_PROCESS 工人持有 / COMPLETED / CANCELLED
 * 这类批次的状态统一收敛成 21421 `BIZ_DELIVERY_BATCH_STATE_INVALID`，前端按 code 分流。
 */
export const BLOCK_SCAN_CODES = [21421] as const;

/** 触发「扫码阻塞」提示的 ApiError.code 取值类型。 */
export type BlockScanCode = (typeof BLOCK_SCAN_CODES)[number];