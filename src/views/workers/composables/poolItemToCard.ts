// src/views/workers/composables/poolItemToCard.ts
//
// 2026-09-30 新增：从 useWorkerQueue.ts 拆出 poolItemToCard + heldToCard 函数（共享给
// WorkerPoolTab 和 PendingPoolCard）。原先两个函数只服务 useWorkerQueue 模块级 ref
// 数据流；本 commit 起，WorkerPoolTab 和 PendingPoolCard 都通过 useWorkerPoolByProcessQuery
// 拉数据，但 UI 仍走 WorkOrderCard 渲染，所以适配层（DTO → WorkOrderCard view-model）
// 必须可被两个组件复用。
//
// 沿 useWorkerQueue.ts:62-112 既有函数体，逐字搬迁 + 加日期戳注释。

import type { HeldBatchItemDto, PoolBatchItemDto } from '@/api/workerPool.contract';
import type { WorkOrderCard } from '@/types/workerPool';

/** 2026-09-30 拆出：把 PoolBatchItemDto 适配成 UI WorkOrderCard（字段映射）。
 *  2026-09-29：透传 PoolBatchItemDto 新增 has_cnc_program 字段，WorkOrderCard
 *  卡片 header 渲染「已编程」tag。*/
export function poolItemToCard(it: PoolBatchItemDto): WorkOrderCard {
  return {
    batch_id: it.batch_id,
    batch_no: `B${it.batch_no}`,
    part_id: it.part_id,
    drawing_no: it.drawing_no,
    part_name: it.name,
    quantity: it.quantity,
    serial_no: it.serial_no,
    system_delivery_date: it.system_delivery_date,
    planned_delivery_date: null, // PoolBatchItem 不带 planned_delivery_date
    is_urgent: it.is_urgent,
    version: it.version,
    customer: it.customer_name ?? null,
    applicant: it.applicant_name ?? null,
    location: it.shelf_code ?? null,
    has_cnc_program: it.has_cnc_program,
  };
}

/** 2026-09-30 拆出：把 HeldBatchItemDto 适配成 UI WorkOrderCard（沿 2026-09-14 follow-up round-2
 *  全字段映射，消除字段降级）。
 *  2026-09-29 review 第 1 轮：透传 HeldBatchItemDto 新增 has_cnc_program 字段，
 *  WorkOrderCard 卡片 header 渲染「已编程」tag（与 pool 列同视觉）。
 *  - `location`：直接取 HeldBatchItemDto.location（enum string，如 'WORKER'），
 *    与 poolItemToCard 不同（pool 用 shelf_code 表示货架 code）；语义清晰区分
 *    「持有方」与「货架 code」，UI tooltip「所在位置」按 enum 显示。 */
export function heldToCard(it: HeldBatchItemDto): WorkOrderCard {
  return {
    batch_id: it.batch_id,
    batch_no: `B${it.batch_no}`,
    part_id: it.part_id,
    drawing_no: it.drawing_no,
    part_name: it.name,
    quantity: it.quantity,
    serial_no: it.serial_no,
    system_delivery_date: it.system_delivery_date,
    planned_delivery_date: it.planned_delivery_date,
    is_urgent: it.is_urgent,
    version: it.version,
    customer: it.customer_name,
    applicant: it.applicant_name,
    location: it.location,
    // 2026-09-29 review 第 1 轮：与 poolItemToCard 同源处理，透传 has_cnc_program
    has_cnc_program: it.has_cnc_program,
  };
}
