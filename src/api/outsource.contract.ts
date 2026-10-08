// 2026-10-08 新建：外协看板（queue）前端 wire 契约（types only，无 runtime）。
//
// 端点（baseURL `/api/v2`，前缀 `/outsource-queue/*`，**无 alias**）：
//   GET  /api/v2/outsource-queue/snapshot                ← fetchOutsourceQueueSnapshot
//   GET  /api/v2/outsource-queue/processes/{process_id}   ← fetchOutsourceQueueProcess
//   POST /api/v2/outsource-queue/move                     ← moveOutsourceBatch
//
// 分层取舍（照 `productionQueue.contract.ts` / `batch.contract.ts` 两级切分的同款形态）：
// 本文件只放 types、零 runtime 依赖；请求发送在 `./outsource.ts`，且**不做 Zod 守门**
// （守门点在有 queryFn / mutationFn 承载的调用方，见 CLAUDE.md「api 层引域内 schema 的
// 口径」）。
//
// ⚠️ **字段名的唯一真源是 Zod schema，本文件是它的镜像**：逐字段声明在
// `src/views/outsource/composables/outsourceQueueSchema.ts`（随视图目录走的域 schema，
// 由 `views/outsource/composables/useOutsourceQueueSnapshotQuery.ts` /
// `useOutsourceQueueProcessQuery.ts` / `useOutsourceQueueMove.ts` 在 queryFn /
// mutationFn 里 parse）。这里**刻意不用 `z.infer<typeof xxxSchema>`** —— 那会让 api 层
// 反向依赖 views 层（CLAUDE.md 明令禁止的层次倒挂）。代价是两份声明要手工对齐，由
// `views/outsource/composables/__tests__/outsourceQueueSchema.spec.ts` 的键集断言 +
// 本文件的字段注释交叉守。
//
// wire 层形态约定（与 `productionQueue.contract.ts` 逐字一致）：
//   - i64 主键 → JSON **字符串**（雪花 ID 防 JS 精度截断）。⚠️ **请求体**里的雪花 ID
//     同样必须发字符串 —— 后端 `deserialize_i64` 只接受字符串，发数字返 40001；
//   - 计数 / version / quantity 是 JSON integer，前端 `number`；
//   - Decimal（`price`）与 datetime（`sent_at` / `ts`）是字符串，前端**不做** Date 解析
//     （避免浏览器时区与服务端错位把「新鲜度」算错）；
//   - 后端 `skip_serializing_if` 的字段在 JSON 里**整个键消失**（不是 null）⇒ 契约按
//     `?: T | null` 标注，Zod 侧必须 `.nullish()`。

import type { OutsourceCompanyOption } from '@/types/outsource';

/** `GET /api/v2/outsource-queue/snapshot` 出参（rust OutsourceQueueSnapshot）。4 字段。
 *
 *  看板 tab 标题双徽标（可发 / 在途）的**唯一数据源**。
 *
 *  **无 `total`**：两个分项总数已给全，后端不再算合计字段；前端也不要自己相加后再当
 *  契约用。 */
export interface OutsourceQueueSnapshotDto {
  /** 只含 `sendable_count + in_flight_count > 0` 的工序，按 `process_id` 升序 ⇒
   *  它是**徽标数据源、不是工序全集**：tab 集合必须与全量 OUTSOURCE 工序列表 join，
   *  否则操作到一半（某工序收发清零）该 tab 会凭空消失。 */
  processes: OutsourceQueueProcessDto[];
  sendable_total: number;
  in_flight_total: number;
  /** 服务端生成快照时刻（RFC3339 带 `+08:00`）。 */
  ts: string;
}

/** `OutsourceQueueSnapshotDto.processes[]` 元素（rust OutsourceQueueProcess）。7 字段。
 *  `color` / `category` 内联在快照里（不必与工序列表 join 就能给工序卡上色、标自产 /
 *  外协）。 */
export interface OutsourceQueueProcessDto {
  process_id: string;
  process_code: string;
  process_name: string;
  /** `t_process.color`，形如 `#RRGGBBAA`（9 字符，含 alpha）；未设置时 null。直接喂 CSS
   *  `border-left-color`，前端不做字符串加工。 */
  color: string | null;
  category: 'INHOUSE' | 'OUTSOURCE';
  sendable_count: number;
  in_flight_count: number;
}

/** `GET /api/v2/outsource-queue/processes/{process_id}` 的 `process`
 *  （rust OutsourceQueueProcessMeta）。4 字段：工序元数据独立成对象（不是顶层平铺）。 */
export interface OutsourceQueueProcessMetaDto {
  process_id: string;
  process_code: string;
  process_name: string;
  /** 同 OutsourceQueueProcessDto.color：9 字符含 alpha，未设置时 null。 */
  color: string | null;
}

/** `GET /api/v2/outsource-queue/processes/{process_id}` 出参
 *  （rust OutsourceQueueProcessDetail）。5 字段，**无分页信封**（一个 tab 一次全量）。
 *
 *  `total` 是候选批次数（`items.length`）；右列的在途批次走 `companies[].held_batches`，
 *  不计入这个 total。 */
export interface OutsourceQueueProcessDetailDto {
  process: OutsourceQueueProcessMetaDto;
  /** 该工序映射的**全部活跃外协公司**（含 `held_count = 0` 的空列 —— 前端要渲染空公司
   *  列当拖拽落点）。 */
  companies: OutsourceQueueCompanyDto[];
  /** 左列：可发送候选批次。 */
  items: OutsourceQueueCandidateDto[];
  total: number;
  ts: string;
}

/** `OutsourceQueueProcessDetailDto.companies[]` 元素（rust OutsourceQueueCompany）。
 *  4 字段。`held_batches` 内联在列上（而不是另开「公司 × 工序」端点）⇒ 打开一个 tab
 *  恒为 1 个请求，N+1 从结构上不存在。 */
export interface OutsourceQueueCompanyDto {
  company_id: string;
  name: string;
  /** `held_batches.length`（后端算好，前端不二次求和）。 */
  held_count: number;
  held_batches: OutsourceQueueHeldBatchDto[];
}

/** `OutsourceQueueProcessDetailDto.items[]` 元素（rust OutsourceQueueCandidate）。
 *  26 字段。行粒度 = 「可发送候选批次 × 该外协工序」，发送侧需要的锚都在这里：`version`
 *  （OCC）、`send_mode`、`outsource_company_id` / `quote_id`（APPROVAL 路径）、
 *  `company_options`（DIRECT 路径的公司下拉源）。
 *
 *  几处容易误判的字段：
 *   - `quantity` 是**可发送数量**（行 = 批次时恒等于批次量）；
 *   - `can_send` 是**后端派生**的可发送判据（APPROVAL，或 DIRECT 且 company_options
 *     非空），前端口径统一读它，不自己再算一遍；
 *   - ⚠️ `shelf_id` 对「`PENDING` 且未上架」的批次是**空串**（不是 null）：这类行没有
 *     holder，后端 `from` 守卫会拒收它们的发送，UI 据此置灰；`shelf_code` 同理可空。 */
export interface OutsourceQueueCandidateDto {
  /** `t_part_batch.version` —— 发送时的 OCC 锚，写端点必传。 */
  version: number;
  /** `APPROVAL` = 该外协工序 `requires_approval = true` 且已命中已批准报价（走
   *  `quote_id` 路径）；`DIRECT` = 免审批直发（走 `direct = true` 路径）。 */
  send_mode: 'APPROVAL' | 'DIRECT';
  part_id: string;
  part_serial_no: string | null;
  part_drawing_no: string | null;
  part_name: string | null;
  quantity: number;
  batch_id: string;
  batch_no: number;
  planned_delivery_date: string | null;
  is_urgent: boolean;
  /** 2026-10-09 后端新增的派生列：这条批次**有制定工序链且链指针未漂移**，批次卡片的
   *  左侧 4px 竖条只看它（语义见 `src/types/batchCard.ts`）。右列在途行
   *  （`OutsourceQueueHeldBatchDto`）**没有**对应字段：外协收发阶段不判链。 */
  has_process_chain: boolean;
  /** `customer_name` = L2 客户名（叶子），`parent_customer_name` = L1 客户名（集团）。 */
  customer_name: string | null;
  parent_customer_name: string | null;
  /** `t_shelf.code`；批次未上架时 null。 */
  shelf_code: string | null;
  /** `t_part_batch.current_holder_id`（批次所在货架 id）—— 判「该行能否发送」的数据源；
   *  `PENDING` 且未上架的批次是**空串**（不是 null）。 */
  shelf_id: string;
  /** APPROVAL 单值；DIRECT 为 null（用 company_options）。 */
  outsource_company_id: string | null;
  outsource_company_name: string | null;
  /** APPROVAL 必传；DIRECT 必须 null（两个报价字段都不传或同时传 → 20104）。 */
  quote_id: string | null;
  /** DIRECT 时为该批次可用的全部公司；APPROVAL 时为空数组（后端已按 send_mode 填好，
   *  前端不要跨模式借用）。 */
  company_options: OutsourceCompanyOption[];
  /** APPROVAL 为该报价的 Decimal 字符串；DIRECT 为 null。 */
  price: string | null;
  has_cnc_program: boolean;
  applicant_name: string | null;
  note: string | null;
  system_delivery_date: string | null;
  /** 后端派生的可发送判据。 */
  can_send: boolean;
}

/** `OutsourceQueueCompanyDto.held_batches[]` 元素（rust OutsourceQueueHeldBatch）。
 *  22 字段。
 *
 *  `location` 锁成字面量：在途批次必然在外协公司手上（恒 `"OUTSOURCE_COMPANY"`）。 */
export interface OutsourceQueueHeldBatchDto {
  batch_id: string;
  part_id: string;
  batch_no: number;
  /** **当前余量**（`t_part_batch.quantity`），不是 shipment.quantity。 */
  quantity: number;
  serial_no: string | null;
  /** `t_part.drawing_no`。 */
  drawing_no: string;
  /** `t_part.name`。 */
  name: string;
  system_delivery_date: string | null;
  planned_delivery_date: string | null;
  is_urgent: boolean;
  customer_name: string | null;
  parent_customer_name: string | null;
  applicant_name: string | null;
  location: 'OUTSOURCE_COMPANY';
  note: string | null;
  /** `t_part_batch.version` —— 回收时的 OCC 锚。 */
  version: number;
  /** `t_outsource_shipment.sent_at`（naive datetime 字符串）；驱动 SQL 按契约用
   *  `LEFT JOIN`，故历史脏数据下可能为 null。 */
  sent_at: string | null;
  /** `t_outsource_shipment.unit_price` 的 Decimal 字符串；同上，可能为 null。 */
  price: string | null;
  /** 接收后批次的下一道工序 id；无下一 step 时为字符串 `"0"`（**不是 null** —— 后端
   *  投影层已把 NULL 吃成 0）。 */
  receive_next_process_id: string;
  receive_next_process_name: string | null;
  /** true = 工序链已知且指针未漂移（接收可免填工序）；false = 必须手填工序 + 货架。 */
  chain_resolvable: boolean;
  has_cnc_program: boolean;
}

/** `POST /api/v2/outsource-queue/move` 的 `from` / `to` tagged enum
 *  （rust OutsourceMoveLocation）。`kind` 的取值与后端 `t_part_batch.location` 枚举
 *  **逐字对齐**，不要按前端习惯另起名：
 *    {"kind":"PRODUCTION_SHELF","next_process_id":"200"}
 *    {"kind":"OUTSOURCE_COMPANY","company_id":"900"}
 *
 *  2026-10-10：`INSPECTION_SHELF`（回收品检）这个变体**整体消失**，「回收品检」功能
 *  一并下线；`PRODUCTION_SHELF` 上的 `shelf_id` 也删除 —— 目标货架改由后端按负载
 *  自动选择（见 CLAUDE.md「货架自动选择」）。
 *
 *  `next_process_id` 只在 `PRODUCTION_SHELF`（**回收生产**）分支上，且**可省略** ——
 *  省略时后端从工序链推导；链推不出（`receive_next_process_id === "0"` 且用户没选
 *  工序）返 20706。 */
export type OutsourceMoveLocationDto =
  | { kind: 'PRODUCTION_SHELF'; next_process_id?: string }
  | { kind: 'OUTSOURCE_COMPANY'; company_id: string };

/** `POST /api/v2/outsource-queue/move` 请求（rust OutsourceMoveRequest）。收发合一的
 *  单端点，两个方向（2026-10-10「回收品检」方向下线）：
 *  | from            | to                | 说明                          |
 *  |-----------------|-------------------|-------------------------------|
 *  | PRODUCTION_SHELF| OUTSOURCE_COMPANY | 发送（免审批直发 / 走已批报价）|
 *  | OUTSOURCE_COMPANY | PRODUCTION_SHELF| 回收生产                     |
 *
 *  不变量（前端必须遵守，否则 409 / 422）：
 *   - `version` **必填**（OCC 乐观锁锚，`t_part_batch.version`）：后端 serde 无
 *     `#[serde(default)]` ⇒ 缺字段返 HTTP 422 **纯文本**，不是业务信封，别指望从错误
 *     响应里解析 code；
 *   - `from` 必与批次当前 `(location, current_holder_id)` 严格一致，否则 40901 / 位置
 *     不符类错误；
 *   - `quote_id` 与 `direct` **必传其一**，都不传或同时传 → 20104。发送方向恒满足
 *     「APPROVAL 传 quote_id + direct=null / DIRECT 传 direct=true + quote_id=null」；
 *     **回收方向两者都必须是 null**（不涉及报价）。
 *
 *  **无 `quantity` 字段**：整批语义。部分收发先拆批（`POST /batches/split`）。 */
export interface OutsourceMoveRequestDto {
  batch_id: string;
  /** OCC 锚：源批次 `t_part_batch.version`。 */
  version: number;
  from: OutsourceMoveLocationDto;
  to: OutsourceMoveLocationDto;
  /** APPROVAL 路径必传（指向已批准报价）；DIRECT 与回收方向必须 null。 */
  quote_id: string | null;
  /** DIRECT 路径传 `true`（免审批直发）；APPROVAL 与回收方向必须 null。 */
  direct: boolean | null;
  /** 可选，写入事件 note。 */
  note?: string | null;
}

/** `POST /api/v2/outsource-queue/move` 出参（rust OutsourceMoveResult）。
 *
 *  ⚠️ `shipment_id` / `new_process_id` 在 rust 侧带 `skip_serializing_if` ⇒ 方向不满足
 *  时**整个键从 JSON 消失**（不是 null）⇒ 契约按 `?: T | null` 标注，Zod 侧必须
 *  `.nullish()`，用 `.nullable()` 会在真实响应上抛错。 */
export interface OutsourceMoveResultDto {
  batch_id: string;
  part_id: string;
  /** 入参 `from.kind` 的字面回显。 */
  from_kind: 'PRODUCTION_SHELF' | 'OUTSOURCE_COMPANY';
  /** 入参 `to.kind` 的字面回显。 */
  to_kind: 'PRODUCTION_SHELF' | 'OUTSOURCE_COMPANY';
  /** 移动后 `batch.current_holder_id`（外协公司 id；回收方向是后端自动选出的货架 id）。 */
  new_holder_id: string;
  /** 移动后 `batch.location` —— `t_part_batch.location` 的**完整枚举**，比 `to_kind`
   *  的三个取值宽（PENDING / WORKER 等也在这里），故声明为 `string` 而不是收窄的
   *  字面量联合。 */
  new_location: string;
  /** `batch.version + 1`。 */
  version: number;
  /** 仅发送方向填：新建的 `t_outsource_shipment.id`；回收方向**整个键缺失**。 */
  shipment_id?: string | null;
  /** 回收生产时后端实际推进到的工序 id；发送方向**整个键缺失**。 */
  new_process_id?: string | null;
}
