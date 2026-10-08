// src/views/outsource/composables/outsourceItemToCard.ts
//
// 外协看板两个 wire DTO → `BatchCardModel` 的适配层。左列候选卡
// （`OutsourceQueueCandidateDto`）、右列在途卡（`OutsourceQueueHeldBatchDto`）两处
// DTO 字段集不同（候选带 `shelf_*` / 报价三字段、零件名带 `part_` 前缀且可为 null；在途
// 带 `sent_at` / `price` / `receive_next_*` / `chain_resolvable`、零件名已扁平化且非空），
// 卡片组件只认 BatchCardModel，DTO 差异全部收在本文件 ⇒ `BatchCard.vue` 是全仓唯一的
// 批次卡片，且组件零 `api/*` 依赖。
//
// 各域适配层自持（照 `views/production/queue/utils/queueItemToCard.ts` 的分层取舍，
// 不为了两边对称集中到共享目录）。
//
// 两类字段的性质不同，不要混用（见 `src/types/batchCard.ts`）：
//   - `version` 是 `t_part_batch` 的一列、跨域通用（任何写端点的 OCC 锚）⇒ 顶层字段；
//   - `extra` 是**单域语义**的扩展槽（外协公司 / 外协工序 / 单价 / 发出时间 /
//     接收可免填性）⇒ 只进 tooltip，不占卡片 body 的 4 行预算。
//
// 2026-10-09：卡片左侧 4px 竖条改成只看 `has_process_chain`（有链且指针未漂移），
// 两侧取值来源不同：候选卡透传后端派生列；在途卡恒 false（在途 DTO 无该字段，且
// 外协收发阶段本就不判链，详见 `heldBatchToCard` 内注释）。

import type {
  OutsourceQueueCandidateDto,
  OutsourceQueueHeldBatchDto,
} from '@/api/outsource.contract';
import type { BatchCardModel } from '@/types/batchCard';

/** 左列可发送候选卡 → 卡片 model。字段取自
 *  `GET /api/v2/outsource-queue/processes/{id}` 的 `items[]`。
 *
 *  @param dto               候选卡 wire DTO。
 *  @param outsourceProcessName 外协工序名 —— **候选卡 DTO 上没有工序字段**（行粒度是
 *      「批次 × 该外协工序」，同一个批次在不同 tab 各出现一次），所以只能由调用方从
 *      响应根的 `process.process_name` 取了传进来，进 `extra.outsource_process_name`
 *      供 tooltip 展示「这批送到哪家、做什么工序」。 */
export function poolCandidateToCard(
  dto: OutsourceQueueCandidateDto,
  outsourceProcessName: string | null,
): BatchCardModel {
  return {
    batch_id: dto.batch_id,
    part_id: dto.part_id,
    // 适配层补 'B' 前缀（DTO 里是裸数字），组件直接渲染不拼串
    batch_no: `B${dto.batch_no}`,
    // 候选 DTO 的零件名 / 图号可为 null，卡片 model 要求非空 ⇒ 缺值渲染为空串
    // （卡片 header 落空、行高不变），不要用 '—' 之类的占位串 —— 那是文案不是数据。
    part_name: dto.part_name ?? '',
    drawing_no: dto.part_drawing_no ?? '',
    serial_no: dto.part_serial_no,
    quantity: dto.quantity,
    system_delivery_date: dto.system_delivery_date,
    planned_delivery_date: dto.planned_delivery_date,
    is_urgent: dto.is_urgent,
    has_process_chain: dto.has_process_chain,
    has_cnc_program: dto.has_cnc_program,
    customer_l1: dto.parent_customer_name,
    customer_l2: dto.customer_name,
    applicant_name: dto.applicant_name,
    note: dto.note,
    // 候选行的 location 语义是「批次所在货架 code」（与生产队列的工序池同款），不是
    // location 枚举 —— 在途侧才用枚举值。
    location: dto.shelf_code,
    // 发送 `from.shelf_id` 的数据源（批次真实所在货架，候选池跨所有货架，不能拿用户
    // 当前激活货架凑）。⚠️ `PENDING` 且未上架的批次这里是**空串**（不是 null），这类行
    // 拖拽发送会被后端 `from` 守卫拒收 —— UI 据此置灰，不靠这里猜。
    shelf_id: dto.shelf_id,
    version: dto.version,
    extra: {
      // APPROVAL 行有值（报价锁定的公司）；DIRECT 行为 null —— DIRECT 的目标是用户
      // 在拖拽落点上选的，尚未发生，进卡片时本来就没有。
      outsource_company_name: dto.outsource_company_name,
      // APPROVAL 为该报价的 Decimal 字符串；DIRECT 为 null。
      price: dto.price,
      outsource_process_name: outsourceProcessName,
    },
  };
}

/** 右列在途批次卡 → 卡片 model。字段取自
 *  `GET /api/v2/outsource-queue/processes/{id}` 的 `companies[].held_batches[]`
 *  （后端已内联，公司列零请求）。
 *
 *  @param dto               在途卡 wire DTO。
 *  @param outsourceCompanyName 外协公司名 —— 与 `poolCandidateToCard` 同款，在途卡 DTO
 *      上**没有公司字段**（公司 id / name 只挂在列上），由调用方从
 *      `company.name` 取了传进来，进 `extra.outsource_company_name`。 */
export function heldBatchToCard(
  dto: OutsourceQueueHeldBatchDto,
  outsourceCompanyName: string | null,
): BatchCardModel {
  return {
    batch_id: dto.batch_id,
    part_id: dto.part_id,
    batch_no: `B${dto.batch_no}`,
    // 在途 DTO 的零件名 / 图号已扁平化且**非 nullable**，直接取。
    part_name: dto.name,
    drawing_no: dto.drawing_no,
    serial_no: dto.serial_no,
    quantity: dto.quantity,
    system_delivery_date: dto.system_delivery_date,
    planned_delivery_date: dto.planned_delivery_date,
    is_urgent: dto.is_urgent,
    // 在途行的 wire DTO **没有** `has_process_chain`（后端本轮没加），且这里刻意**不推导**：
    // 卡片已经在外协公司手上、链上位置不由本系统决定，判出来的值对收发决策毫无意义。
    // 口径后果：在途卡的绿边框恒不亮 —— 这是口径决定的，不是漏填。
    has_process_chain: false,
    has_cnc_program: dto.has_cnc_program,
    customer_l1: dto.parent_customer_name,
    customer_l2: dto.customer_name,
    applicant_name: dto.applicant_name,
    note: dto.note,
    // 在途侧的 location 是 t_part_batch.location 枚举（恒 'OUTSOURCE_COMPANY'），非货架 code
    location: dto.location,
    // 批次在外协公司手上（current_holder_id = company_id），没有货架位置
    shelf_id: null,
    version: dto.version,
    extra: {
      outsource_company_name: outsourceCompanyName,
      price: dto.price,
      sent_at: dto.sent_at,
      // 接收能否免填下一道工序：false（工序链缺失或指针漂移）时 UI 必须让用户手填
      // 工序 + 货架，否则后端 20706。
      can_auto_receive: dto.chain_resolvable,
    },
  };
}