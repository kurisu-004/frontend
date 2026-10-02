// src/views/workers/composables/poolItemToCard.ts
//
// 2026-10-02 重构：三个 wire DTO → `BatchCardModel` 的统一适配层。工序池
// （PoolBatchItemDto）、工人持有（HeldBatchItemDto）、待下发（PendingBatchItemDto）
// 三处 DTO 字段集不同（候选池无 planned_delivery_date、待下发无 location /
// shelf_id / has_cnc_program……），卡片组件只认 BatchCardModel，DTO 差异全部收在
// 本文件。三个函数返回同构对象 ⇒ BatchCard.vue 是全看板唯一的批次卡片。
//
// 2026-10-02 起各函数共有的取舍：
//   - `batch_no` 在适配层补 'B' 前缀（DTO 里是裸数字），组件直接渲染不拼串。
//   - `shelf_id` 只在工序池侧填 `PoolBatchItemDto.shelf_id`（batch 真实所在货架，
//     move 的 `from.shelf_id` 数据源，最终经卡片 `:data-shelf-id` 落到 DOM dataset
//     供 PoolDrawer.onDragStart 读）；工人持有 / 待下发恒 null。
//   - `location` 语义按来源区分：工序池 = 货架 code，工人持有 = location enum，
//     待下发 = null（尚未落位）。

import type {
  HeldBatchItemDto,
  PendingBatchItemDto,
  PoolBatchItemDto,
} from '@/api/workerPool.contract';
import type { BatchCardModel } from '@/types/workerPool';

/** 工序池候选批次 → 卡片 model。字段取自 `GET /api/v2/prod/pool/{process_id}`。 */
export function poolItemToCard(it: PoolBatchItemDto): BatchCardModel {
  return {
    batch_id: it.batch_id,
    part_id: it.part_id,
    batch_no: `B${it.batch_no}`,
    part_name: it.name,
    drawing_no: it.drawing_no,
    serial_no: it.serial_no,
    quantity: it.quantity,
    system_delivery_date: it.system_delivery_date,
    // PoolBatchItemDto 不带 planned_delivery_date（候选池只关心系统交期）
    planned_delivery_date: null,
    is_urgent: it.is_urgent,
    has_cnc_program: it.has_cnc_program,
    customer_l1: it.parent_customer_name,
    customer_l2: it.customer_name,
    applicant_name: it.applicant_name,
    note: it.note,
    location: it.shelf_code,
    shelf_id: it.shelf_id,
  };
}

/** 工人持有批次 → 卡片 model。字段取自 `GET /api/v2/prod/pool/state` 的
 *  `held_batches[]`（WorkerStateDto 内联）。 */
export function heldToCard(it: HeldBatchItemDto): BatchCardModel {
  return {
    batch_id: it.batch_id,
    part_id: it.part_id,
    batch_no: `B${it.batch_no}`,
    part_name: it.name,
    drawing_no: it.drawing_no,
    serial_no: it.serial_no,
    quantity: it.quantity,
    system_delivery_date: it.system_delivery_date,
    planned_delivery_date: it.planned_delivery_date,
    is_urgent: it.is_urgent,
    has_cnc_program: it.has_cnc_program,
    customer_l1: it.parent_customer_name,
    customer_l2: it.customer_name,
    applicant_name: it.applicant_name,
    note: it.note,
    // held 侧 location 是 t_part_batch.location enum（'WORKER' 等），非货架 code
    location: it.location,
    // batch 在 worker 手里（current_holder_id = worker_id），没有货架位置
    shelf_id: null,
  };
}

/** 待下发批次 → 卡片 model。字段取自 `GET /api/v2/prod/batches/pending` 的
 *  `items[]`（PendingBatchItemDto）。 */
export function pendingBatchToCard(it: PendingBatchItemDto): BatchCardModel {
  return {
    batch_id: it.batch_id,
    part_id: it.part_id,
    batch_no: `B${it.batch_no}`,
    part_name: it.name,
    drawing_no: it.drawing_no,
    serial_no: it.serial_no,
    quantity: it.quantity,
    system_delivery_date: it.system_delivery_date,
    planned_delivery_date: it.planned_delivery_date,
    is_urgent: it.is_urgent,
    // PendingBatchItemDto 无该字段；后端对非 CNC 链一律派生 = false，恒不渲染 tag
    has_cnc_program: false,
    customer_l1: it.parent_customer_name,
    customer_l2: it.customer_name,
    applicant_name: it.applicant_name,
    note: it.note,
    // 待下发批次尚未落位（未进任何货架）
    location: null,
    shelf_id: null,
  };
}
