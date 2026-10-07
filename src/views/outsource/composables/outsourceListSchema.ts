// 2026-10-09 新建：外协公司一览 / 外协对账 / 报价一览三页的 Zod 守门 schema，
// 与三个 query hook（`useOutsourceCompaniesQuery` / `useOutsourceSentPartsQuery` /
// `useOutsourceQuotesQuery`）同居 `views/outsource/composables/`。
//
// 为什么归位到域内（而不是留在全局 `composables/queries/schemas.ts`）：
//   这三个端点的守门 schema 只被本域自己的 query hook 消费，全局 schemas.ts 是
//   「跨域共享基础数据」的 schema 集。api 层**不 import 本文件**（api → views 是反向
//   依赖），守门由 queryFn 里的 `xxxSchema.parse(await xxxAPI())` 完成 —— 三个端点都有
//   queryFn 承载，故 api 层不发请求就完事，不再 parse（parse 返回深拷贝，多一层等于
//   每屏数据被校验并克隆两遍）。
//
// 契约来源：backend-rust `src/modules/outsource/{vo,dto}.rs`（该分支尚未 push，
// 别在 master 上找不到就以为契约不存在）。三页的端点覆盖情况：
//   - GET  /outsource-companies                      → outsourceCompanyListResultSchema
//   - GET  /outsource-companies/{id}                  → outsourceCompanyWithProcessesSchema
//   - GET  /outsource-companies/by-process/{process} → outsourceCompanyOptionSchema
//   - GET  /outsource-companies/{id}/sent-parts       → outsourceSentPartListResultSchema
//   - GET  /outsource-quotes                         → outsourceQuoteListResultSchema
//   - POST /outsource-companies/{id}/update          → 出参同上（编辑对话框回填工序勾选）
// ⚠️ 三处**未声明**守门的点（如实登记，不要按「每个端点都有 schema」去推断覆盖面）：
//   - `GET /outsource-quotes/quotable-parts` 的守门留在 api 层（`listQuotableParts`）——
//     它由 shell 的 `loadLookups()` 裸调，没有 queryFn 承载；
//   - 三条写端点的出参（create / update / submit / approve / reject）不进任何 query
//     缓存，出参形状只影响 mutation 成功后的重拉，parse 的边际收益为零；
//   - `/outsource-queue/*` 看板三件套的守门在同目录 `outsourceQueueSchema.ts`。
//
// 关键约束（沿仓内 queryFn Zod 守门 + Zod schema-first 两条约定）：
//   - 所有字段**显式声明**。Zod 默认 `z.object()` 是 strip 模式，漏声明的字段会被
//     **静默丢弃**且 parse 不报错 —— 守门形同虚设。本仓已因此出过两类事故：
//     「schema 声明了后端没有的字段 ⇒ parse 永远失败 ⇒ 页面永久加载失败」与反向的
//     「漏声明 ⇒ 字段被静默吞掉 ⇒ 模板里出现 undefined」；
//   - 雪花 ID 一律 `z.string()`（后端 `serialize_i64`），绝不能声明 number；
//   - 计数 / version 一律 `z.number()`；
//   - Decimal 一律 `z.string()`（后端序列化成字符串，`Number()` 会丢末位精度）；
//   - 可空字段一律 `.nullable()` 且**不给默认值**：后端显式返 null 与「字段缺失」是两种
//     状态，混起来会让下游的 `?? '—'` 把缺字段也渲染成「无值」而不是暴露漂移；
//   - 不强制长度 / 范围（DDL 边界是表单 schema 的职责）。

import { z } from 'zod';

/** `GET /outsource-companies` 单行（后端 `OutsourceCompanyOut`）—— **7 字段**。
 *
 *  2026-10-09 删 `created_at` / `updated_at`：公司一览是外协看板 / 报价 / 对账三处的
 *  公司下拉数据源，页面只渲染「名称 + 联系人 + 启停用」，两列时间戳零消费方，而每次写
 *  端点都会让它们变化 ⇒ 纯粹的缓存抖动。
 *  `version` 是 OCC 锚：`POST /{id}/update` 与 `POST /{id}/soft-delete` **必传**，
 *  漏传是后端 HTTP 422 纯文本（不是业务信封）⇒ 编辑 / 删除功能直接失败。 */
export const outsourceCompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  contact_name: z.string().nullable(),
  contact_phone: z.string().nullable(),
  address: z.string().nullable(),
  is_active: z.boolean(),
  version: z.number(),
});

export type OutsourceCompanySchema = z.infer<typeof outsourceCompanySchema>;

/** `OutsourceCompanyWithProcessesOut.processes[]` 元素
 *  （后端 `OutsourceCompanyProcessLinkOut`）—— **3 字段**。
 *
 *  2026-10-09 删 `category`（与勾选框候选集 `GET /proc/processes?category=OUTSOURCE`
 *  恒等，冗余）与 `sort_order`（只被写侧赋值、被看板 SQL 的 ORDER BY 读，从不经本 VO）。
 *
 *  仍然保留 `process_code` / `process_name` 是承重的：编辑对话框的勾选框要显示
 *  `code — name`，而勾选候选全集来自共享工序列表（只提供 `process_id` 与 code / name），
 *  已映射项的 code / name 由本 VO 直接给。 */
export const outsourceCompanyProcessLinkSchema = z.object({
  process_id: z.string(),
  process_code: z.string(),
  process_name: z.string(),
});

export type OutsourceCompanyProcessLinkSchema = z.infer<typeof outsourceCompanyProcessLinkSchema>;

/** `GET /outsource-companies/{id}` 与 `POST /{id}/update` 的出参
 *  （后端 `OutsourceCompanyWithProcessesOut`）—— **8 字段**
 *  （公司七项 + `processes[]`）。 */
export const outsourceCompanyWithProcessesSchema = outsourceCompanySchema.extend({
  processes: z.array(outsourceCompanyProcessLinkSchema),
});

export type OutsourceCompanyWithProcessesSchema = z.infer<
  typeof outsourceCompanyWithProcessesSchema
>;

/** `GET /outsource-companies/by-process/{process_id}` 的**单行**
 *  （后端 `OutsourceCompanyOptionOut`）—— **2 字段**，裸数组元素（非分页信封）。
 *
 *  2026-10-09 从 `OutsourceCompanyOut` 收窄：`is_active` 是**结构性冗余** ——
 *  service 层已在 Rust 里 `filter(|c| c.is_active)` 掉停用公司，能出现在本列表里的行恒为
 *  启用，再返一列等于把「已被后端消掉的事实」重新交给前端判断。 */
export const outsourceCompanyOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type OutsourceCompanyOptionSchema = z.infer<typeof outsourceCompanyOptionSchema>;

/** `GET /outsource-companies` 顶层（后端 `OutsourceCompanyListOut`）—— 4 字段。
 *  `total` 是匹配总数、**不受 items 截断影响** —— 分页器用它，用 items.length 会在
 *  触顶（默认 limit 100）时谎报。 */
export const outsourceCompanyListResultSchema = z.object({
  items: z.array(outsourceCompanySchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type OutsourceCompanyListResultSchema = z.infer<typeof outsourceCompanyListResultSchema>;

/** `GET /outsource-companies/{id}/sent-parts` 单行（后端 `OutsourceSentPartOut`）
 *  —— **16 字段**。
 *
 *  ⚠️ 主键是 `shipment_id`（不是 `id`）：行编辑端点
 *  `POST /outsource-shipments/{shipment_id}/reconcile-update` 以它为锚。
 *  ⚠️ 2026-10-09 删 `quote_id` / `part_id` 两个字段：前端对账页两列都不存在（行编辑
 *  端点按 `shipment_id` 取锚，零件列展示 `part_drawing_no` / `part_name` 两个可读字段），
 *  留着等于把同一份零件标识序列化两次且分叉。
 *  ⚠️ `status` 收成**两值枚举**：DB CHECK 允许的第三值 `CANCELLED` **无任何代码路径写入**
 *  （后端 SQL 硬编码只返 `OUTSOURCING` / `RECEIVED`），声明第三个枚举值是死代码。 */
export const outsourceSentPartItemSchema = z.object({
  shipment_id: z.string(),
  /** shipment.version（对账行编辑的 OCC 锚） */
  version: z.number(),
  part_drawing_no: z.string().nullable(),
  part_name: z.string().nullable(),
  /** 客户路径：有 L1 拼 `L1 / L2`，否则仅 L2 名，缺客户为 null。 */
  customer_path: z.string().nullable(),
  /** 历史 shipment 可能无批次（后端 left join 落空） */
  batch_no: z.number().nullable(),
  process_id: z.string(),
  process_name: z.string().nullable(),
  quantity: z.number(),
  /** Decimal 字符串；DIRECT 直发自动建的占位报价为 "0" */
  unit_price: z.string(),
  /** Decimal 字符串；`unit_price × quantity`，总价列的**单一真源**（后端算好）。 */
  total_price: z.string(),
  sent_at: z.string(),
  received_at: z.string().nullable(),
  status: z.enum(['OUTSOURCING', 'RECEIVED']),
  is_billed: z.boolean(),
  is_urgent: z.boolean(),
});

export type OutsourceSentPartItemSchema = z.infer<typeof outsourceSentPartItemSchema>;

/** `GET /outsource-companies/{id}/sent-parts` 顶层（后端 `OutsourceSentPartListOut`）
 *  —— **6 字段**：2026-10-09 加两个公司字段（页头公司名改读这里，不必再单独发
 *  `GET /outsource-companies/{id}`）+ 分页信封四字段。
 *
 *  `outsource_company_name` **公司不存在 / 已软删时为 `null`** —— 端点本身不因公司缺失
 *  而 404，页头标题位要能显示「未知公司」。 */
export const outsourceSentPartListResultSchema = z.object({
  outsource_company_id: z.string(),
  outsource_company_name: z.string().nullable(),
  items: z.array(outsourceSentPartItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type OutsourceSentPartListResultSchema = z.infer<typeof outsourceSentPartListResultSchema>;

/** `GET /outsource-quotes` 单行（后端 `OutsourceQuoteOut`）—— **22 字段**。
 *
 *  后 9 个是 service 层拼装的展示用补全字段（part / company / process / customer 的可读名），
 *  缺任意一个会让对应列渲染成 `—` 而不是暴露漂移。
 *  `status` 按 `z.string()` 收而不锁字面量：DB 里存着 legacy 值（`OUTSOURCING` /
 *  `RECEIVED` / `BILLED` / `USED`，见 `types/outsource.ts` 的 `OutsourceQuoteStatus`），
 *  前端只对 `ACTIVE_QUOTE_STATUSES` 四值提供操作按钮，锁死枚举会让历史行整页 parse 失败。 */
export const outsourceQuoteSchema = z.object({
  id: z.string(),
  version: z.number(),
  part_id: z.string(),
  outsource_company_id: z.string(),
  process_id: z.string(),
  /** Decimal 字符串 */
  price: z.string(),
  note: z.string().nullable(),
  status: z.string(),
  submitted_at: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  review_note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // 展示用补全字段（service 拼装）
  part_serial_no: z.string().nullable(),
  part_drawing_no: z.string().nullable(),
  part_name: z.string().nullable(),
  outsource_company_name: z.string().nullable(),
  process_code: z.string().nullable(),
  process_name: z.string().nullable(),
  customer_path: z.string().nullable(),
  /** 所属零件的客户下单单价（CNY；与 price 对比谈判空间），Decimal 字符串 */
  part_unit_price: z.string().nullable(),
  is_urgent: z.boolean(),
});

export type OutsourceQuoteSchema = z.infer<typeof outsourceQuoteSchema>;

/** `GET /outsource-quotes` 顶层（后端 `OutsourceQuoteListOut`）—— 4 字段。 */
export const outsourceQuoteListResultSchema = z.object({
  items: z.array(outsourceQuoteSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type OutsourceQuoteListResultSchema = z.infer<typeof outsourceQuoteListResultSchema>;