// src/views/production/queue/utils/queueItemToCard.ts
//
// 生产队列域三个 wire DTO → `BatchCardModel` 的统一适配层。工序候选池
// （`QueuePoolItemDto`）、工人持有（`QueueHeldBatchDto`）、待下发
// （`QueuePendingBatchDto`）三处 DTO 字段集不同（候选池有货架三字段、无计划交期；
// 持有有计划交期与 location、无货架；待下发有计划交期、无货架与编程标记……），
// 卡片组件只认 BatchCardModel，DTO 差异全部收在本文件 ⇒ BatchCard.vue 是全站
// 唯一的批次卡片，且组件零 `api/*` 依赖。
//
// 2026-10-02 起各函数共有的取舍：
//   - `batch_no` 在适配层补 'B' 前缀（DTO 里是裸数字），组件直接渲染不拼串；
//   - `shelf_id` 只在工序池侧填 `QueuePoolItemDto.shelf_id`（批次真实所在货架，
//     move 的 `from.shelf_id` 数据源，最终经卡片 `:data-shelf-id` 落到 DOM dataset
//     供 PoolDrawer.onDragStart 读）；工人持有 / 待下发恒 null；
//   - `location` 语义按来源区分：工序池 = 货架 code，工人持有 = location 枚举值，
//     待下发 = null（尚未落位）；
//   - `version` 三个 DTO 都带（OCC 乐观锁锚），统一直填；卡片不渲染它，
//     召回 / move 的请求体要拿它做版本校验。

import type {
  QueueHeldBatchDto,
  QueuePendingBatchDto,
  QueuePoolItemDto,
} from '@/api/productionQueue.contract';
import type { BatchCardModel } from '@/types/batchCard';

/** 工序候选池批次 → 卡片 model。字段取自 `GET /api/v2/prod/queue/processes/{id}`
 *  的 `items[]`。 */
export function poolItemToCard(it: QueuePoolItemDto): BatchCardModel {
  return {
    batch_id: it.batch_id,
    part_id: it.part_id,
    batch_no: `B${it.batch_no}`,
    part_name: it.name,
    drawing_no: it.drawing_no,
    serial_no: it.serial_no,
    quantity: it.quantity,
    system_delivery_date: it.system_delivery_date,
    // 候选池行不带 planned_delivery_date（候选池只关心系统交期）
    planned_delivery_date: null,
    is_urgent: it.is_urgent,
    has_process_chain: it.has_process_chain,
    has_cnc_program: it.has_cnc_program,
    customer_l1: it.parent_customer_name,
    customer_l2: it.customer_name,
    applicant_name: it.applicant_name,
    note: it.note,
    location: it.shelf_code,
    shelf_id: it.shelf_id,
    version: it.version,
  };
}

/** 工人持有批次 → 卡片 model。字段取自
 *  `GET /api/v2/prod/queue/processes/{id}` 的 `workers[].held_batches[]`
 *  （后端已内联，工人列零请求）。 */
export function heldToCard(it: QueueHeldBatchDto): BatchCardModel {
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
    has_process_chain: it.has_process_chain,
    has_cnc_program: it.has_cnc_program,
    customer_l1: it.parent_customer_name,
    customer_l2: it.customer_name,
    applicant_name: it.applicant_name,
    note: it.note,
    // held 侧 location 是 t_part_batch.location 枚举（'WORKER' 等），非货架 code
    location: it.location,
    // 批次在工人手里（current_holder_id = worker_id），没有货架位置
    shelf_id: null,
    version: it.version,
  };
}

/** 待下发批次 → 卡片 model。字段取自 `GET /api/v2/prod/queue/pending` 的
 *  `items[]`。 */
export function pendingBatchToCard(it: QueuePendingBatchDto): BatchCardModel {
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
    // ⚠️ 本行**不走**后端派生列（`GET /prod/queue/pending` 的行 VO 没有
    // `has_process_chain`），改为按「是否已制定工序链」推导，且**只有这一处**这么推导。
    // 为什么不能照抄派生列口径：待下发批次按定义还没 dispatch 过，
    // `current_process_step_id` 恒为 NULL ⇒ 派生列的「未定位」分支会去看链里有无未软删
    // step，而 pending 端点的驱动 SQL 根本不 join 链，判出来只会恒 false。
    // 这里的分界是「有没有制定链」：后端 `process_chain_id` 是非 Option i64 + unwrap_or(0)，
    // 未制定时投影成字符串 `"0"`（不是 null / 缺键），故判据必须是 `!== '0'`。
    has_process_chain: it.process_chain_id !== '0',
    // 待下发行不带 has_cnc_program：批次尚未下发到工序，谈不上编程；卡片上恒不渲染
    // 「已编程」tag（等价于 false，省掉一个分支）。
    has_cnc_program: false,
    customer_l1: it.parent_customer_name,
    customer_l2: it.customer_name,
    applicant_name: it.applicant_name,
    note: it.note,
    // 待下发批次尚未落位（未进任何货架）
    location: null,
    shelf_id: null,
    version: it.version,
  };
}