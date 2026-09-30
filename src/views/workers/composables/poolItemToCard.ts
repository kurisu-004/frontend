// src/views/workers/composables/poolItemToCard.ts
//
// 2026-09-30 新增：从 useWorkerQueue.ts 拆出 poolItemToCard + heldToCard 函数（DTO
// → WorkOrderCard view-model 适配层）。UI 全部走 WorkOrderCard 渲染，所以两个
// 组件（WorkerPoolTab 的 PoolDrawer / WorkerColumn）都经此适配。
//
// 2026-09-30 变更：
//   - `poolItemToCard` 透传 `shelf_id`（`PoolBatchItemDto.shelf_id` = batch 当前
//     所在货架）—— `POST /prod/pool/move` 的 `from: {kind:'POOL', shelf_id}` 必须
//     取这个真实值（候选池跨所有货架，batch 货架未必 = 用户激活货架，填错后端
//     返 20122）。值最终经 WorkOrderCard 的 `:data-shelf-id` 落到 DOM dataset，
//     由 PoolDrawer.onDragStart 读出（见 utils/dndSourceTracker.ts）。
//   - `heldToCard` 的 `shelf_id` 恒为 null —— batch 在 worker 手里，无货架位置。
//   - useWorkerQueue 的 `workerHeld` 模块级 ref 已删除（WorkerColumn 自管
//     useWorkerStateByWorkerQuery 拉 held_batches），故本文件不再是「loadBoard
//     数据流」的一部分，纯粹是 view-model 适配。

import type { HeldBatchItemDto, PoolBatchItemDto } from '@/api/workerPool.contract';
import type { WorkOrderCard } from '@/types/workerPool';

/** 2026-09-30 拆出：把 PoolBatchItemDto 适配成 UI WorkOrderCard（字段映射）。
 *  2026-09-29：透传 PoolBatchItemDto 新增 has_cnc_program 字段，WorkOrderCard
 *  卡片 header 渲染「已编程」tag。
 *  2026-09-30：透传 shelf_id（move 的 `from.shelf_id` 数据源）。 */
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
    shelf_id: it.shelf_id,
  };
}

/** 2026-09-30 拆出：把 HeldBatchItemDto 适配成 UI WorkOrderCard（沿 2026-09-14 follow-up
 *  round-2 全字段映射，消除字段降级）。
 *  2026-09-29 review 第 1 轮：透传 HeldBatchItemDto 新增 has_cnc_program 字段，
 *  WorkOrderCard 卡片 header 渲染「已编程」tag（与 pool 列同视觉）。
 *  - `location`：直接取 HeldBatchItemDto.location（enum string，如 'WORKER'），
 *    与 poolItemToCard 不同（pool 用 shelf_code 表示货架 code）；语义清晰区分
 *    「持有方」与「货架 code」，UI tooltip「所在位置」按 enum 显示。
 *  - `shelf_id`：恒 null —— batch 当前 holder 是 worker（current_holder_id =
 *    worker_id），没有货架位置；move 的 `from` 走 `WORKER` 分支用 worker_id。 */
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
    shelf_id: null,
  };
}
