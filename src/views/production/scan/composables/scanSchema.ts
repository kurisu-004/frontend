// src/views/production/scan/composables/scanSchema.ts
//
// 报工台（工人扫码台）两条 list 的 Zod 守门 schema。**2026-10-10 从
// `src/composables/queries/schemas.ts` 搬进域内** —— 理由见那个文件里留下的指针注释：
// 本 schema 只服务报工台一个域，且守门点跟着报工台的 query hook 走（域内 queryFn），
// 留在跨域共用的基础数据层文件里既不归属、也让「域内依赖全局共享文件」成为常态。
//
// 与 query hook 同居本目录（CLAUDE.md「Zod schema-first」的「域 schema 与 query hook 同居」
// 条目）：`useScanPickableQuery` / `useScanHeldQuery` 的 queryFn 直接
// `scanPartListResultSchema.parse(await fetchScanXxx())`。
//
// 派生类型沿用 `*Data` / `*Schema` 的既有命名：`ScanPartRowSchema` /
// `ScanPartListResultSchema` 供报工台的视图与 spec import；api 层用 contract 里的
// `ScanListItemDto` / `ScanListResultDto` 标自己的返回类型（`import type`，编译期擦除）。

import { z } from 'zod';

// ============================================================
// 报工台三页（取件 / 放回 / 送检）列表行的 Zod 守门 schema。
//
// 端点是 `GET /api/v2/prod/scan/pickable` 与 `GET /api/v2/prod/scan/held`（后端
// `prod::scan` 域，wire 契约见 `src/api/productionScan.contract.ts`），返回的是
// **分页信封**（`items` / `total` / `limit` / `offset`），**不是裸数组**。
// 把信封当数组消费（`parts.value = await fetchX()` 然后 `parts.length`）会连锁炸三处：
//   1. `parts.value` 变成对象，`{{ parts.length }}` 渲染成 undefined（计数恒空）；
//   2. `src/views/production/scan/composables/useScanPartsSort.ts` 里的 `[...list].sort()`
//      抛 `TypeError: list is not iterable` —— 抛点在 computed 内，模板
//      `v-for="p in sortedParts"` 随之渲染失败，**取件 / 放回 / 送检三页同时白屏**；
//   3. `HeldPartsBadge.vue` 的 `v-for="p in parts"` 迭代对象值，同样坏。
// 本 schema 存在的理由就是把这个形状钉死：形状不符立即抛 ZodError，而不是静默空屏。
//
// 行 VO = `ScanListItem`（**不是** `PartItem` / `PartListItem`）：后端为报工台专设的
// 窄投影，**17 字段**，行单位是批次。相对上一版（复用 `PartListItem` 的 39 字段）砍掉
// 22 个键（`applicant_name` / `request_date` / `customer_id` / `assembly_id` / `status` /
// `order_no` / `note` / `unit_price` / `total_price` / `version` / `created_at` /
// `created_by` / `updated_at` / `updated_by` / `deleted_at` / `customer_name` /
// `l1_customer_name` / `holder_name` / `row_type` / `has_children` / `child_count` /
// `has_cnc_program`）—— 那两个端点的取行 SQL 从来不投影它们，取出来的是 service 层
// 写死的占位值，留在契约里只会诱导消费方去读假值。
//
// 声明口径：
//   - 除链四件套外全部**必填**，可空的一律 `.nullable()`。Zod 默认 strip 会静默丢弃
//     未声明的键，所以必填字段必须显式声明，否则「后端漏发」会一路静默流到视图层。
//   - 后端多发那 22 个已砍的键 ⇒ **被 strip 且不抛错**（灰度期新旧后端并存时这是
//     想要的行为；反向断言见 `src/api/__tests__/productionScan.contract.spec.ts` 的 E8）。
//   - 雪花 id 一律 `z.string()`（后端 `serialize_i64` / `serialize_i64_opt` → JSON
//     string），禁止 `z.number()` / `Number()`（会丢精度）。
//   - `total` / `limit` / `offset` 是裸 i64 ⇒ JSON **number**（与雪花 ID 字段方向相反）。
//
// ⚠️ 与同文件 `partSchema` 的分工：`partSchema` 服务 `GET /com/union-list` 等 part 级行
// （后端刻意不填批次锚点）；本 schema 服务报工台两条 list，两者的行单位都是批次、
// `batch_id` / `batch_version` 都有值。两者不可互换。
// ============================================================

/**
 * 报工台两条 list 的行（后端 `ScanListItem`，17 字段）。
 *
 * 它是**分页信封里的 items 元素**（外层见 `scanPartListResultSchema`），不是裸数组。
 */
export const scanPartRowSchema = z.object({
  /** part id（行单位是批次但本键仍指 part）。批次锚另走 `batch_id`。 */
  id: z.string(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  quantity: z.number(),
  is_urgent: z.boolean(),
  /**
   * 2026-10-10 起是**真实投影值**（两条端点都投影 `t_part.planned_delivery_date`），
   * 不再是 `1970-01-01` 占位符 ⇒ 声明成非 null string，且**不再做占位符归一**
   * （归一逻辑随 `request_date` 整键删除时一并移除：键都不存在了，留着 transform
   * 只会把真实日期误判成占位、把交期 chip 显示成「01/01」）。
   *
   * 前端只把它当 `useScanPartsSort` 的排序键，**不上屏**；上屏走 `system_delivery_date`。
   */
  planned_delivery_date: z.string(),
  /** 系统推算交付日，nullable（未推算时 null）。`DeliveryDateChip` 的唯一数据源。 */
  system_delivery_date: z.string().nullable(),
  /** `t_part.process_chain_id`；未制定工序链时 null。**pickable 恒 null**（取件候选按
   *  工种↔工序映射取，不按链），**held 填真值**。本字段只回答「这个件有没有链」，不回答
   *  「链上的下一步是谁」—— 后者一律读下面四件套。 */
  process_chain_id: z.string().nullable(),
  /**
   * 2026-10-09 后端新增的派生列：该批次**有制定工序链且链指针未漂移**。报工台三页列表卡
   * 的左边框专供这个语义（规则见 `views/production/scan/chainAccent.ts`）。
   *
   * 必填 + **不给默认值**：后端恒发，缺键就是契约漂移，parse 该抛。这与同组
   * `chain_state` 四件套的「带默认值降级」取舍相反 —— 那四个键可能被后端单方面新增 /
   * 漏发，缺了只是 UX 降级；本键直接决定边框着色，缺键时降级成灰色边框与「真无链」
   * 不可区分，不如在边界炸出来。
   */
  has_process_chain: z.boolean(),
  /**
   * 工序链派生四件套，**pickable 恒为降级值**（`"NONE"` / `"0"` / null / null），
   * **held 填真值**。放回页据此分流：`NEXT` 免去工序选择、直接单确认放回，`TAIL` 在工序
   * 选择弹窗内常驻提示「加工完成后请送检」再让工人手选，`NONE` 走手选工序路径。
   *
   * ⚠️ **四件套一律声明成「带默认值的必输出键」，缺键降级而不抛**。取舍理由是
   * **失败模式的严重性不对称**：
   *   · 声明成必填（`z.enum` / 非空 `z.string`）时，后端漏发就是
   *     `scanPartListResultSchema.parse()` 抛错 ⇒ 两条 list 全部 reject ⇒ 取件 / 放回 /
   *     送检三页列表空 + `HeldPartsBadge` 抽屉空 = **报工台整体停工**；而后端将来新增第四个
   *     chain_state 取值是**纯后端单方面改动**就能触发的同类事故。
   *   · 降级后的失败只是「链提示不弹，工人多点两下选工序」—— NONE 旧路径依然正确，仅 UX
   *     降级。HMI 场景必须选后者。
   *
   * `chain_state` 声明成 `z.string().nullish()`（不是 `z.enum`、也不是 `.default('NONE')`）：
   *   · 不锁枚举 ⇒ 后端加取值只是降级，不会让报工台停工；
   *   · 不用 `.default('NONE')` ⇒ 保留「键缺失 ⇒ undefined」这个信号。若用 default，
   *     「后端漏发」与「后端真返 NONE」被抹平成同一个值，缺可观测性（放回页一次性
   *     `console.warn` 就再也发不出来）。消费侧（放回页 `enterReturnFlow`）统一窄化：
   *     `'NEXT'` / `'TAIL'` 走链分支，其余（含 undefined / null / 未知字面量）一律按
   *     `'NONE'` 处理并 `console.warn` 一次。
   * 另外三个键的默认值对齐后端的兜底口径（`'0'` / null），让消费侧的「不是真 id 就短路」
   * 判据在漏发时同样成立。
   */
  chain_state: z.string().nullish(),
  chain_next_process_id: z.string().default('0'),
  chain_next_process_name: z.string().nullable().default(null),
  chain_current_process_name: z.string().nullable().default(null),
  /**
   * 批次雪花 id（`serialize_i64_opt` → JSON string）。**两条端点都填**：
   * 取件用它拼 `POST /prod/scan/batches/{batch_id}/pick-up` 的路径参数；
   * 放回 / 送检用它做 worker-scan 的 `batch_id` 入参。
   *
   * 声明成**必填 + 非空**：两条端点都填它，取件 / 放回 / 送检三条路径全靠它定位批次。
   * 写成可空会让「锚点缺失」与「真值为空」混成同一个 undefined，掩盖数据缺口。
   */
  batch_id: z.string(),
  /**
   * 批次乐观锁版本号（`t_part_batch.version`），作 pick-up 的 `version` 入参。
   * **唯一**的批次 OCC 锚 —— 行 VO 上原来的 part 级 `version` 已随本次收敛删除，
   * 且两条取行 SQL 从来不投影 `t_part.version`（恒 0），拿它当批次版本会 OCC 误判。
   */
  batch_version: z.number().nullable(),
  /**
   * 位置。**值恒为 null，但键必须在**（不是 `.optional()`）：`BatchPickerDialog.holderText`
   * 用 `'location' in p` 判「这个 VO 带不带 holder 信息」，键被 strip 掉会让报工台卡片
   * 静默少掉「未知位置」那一行，且仓内没有测试能提前发现（测试 fixture 自己显式带上了
   * 该键）。写成 `.optional()` 同样会让上面那条 `in` 判据在漏发时翻面。
   */
  location: z.string().nullable(),
});

export type ScanPartRowSchema = z.infer<typeof scanPartRowSchema>;

/**
 * 报工台两条 list 的出参 —— **分页信封，不是裸数组**（`envelopeResponseInterceptor`
 * 之后 `resp.data` 就是这个对象）。
 *
 * 消费形态：调用方必须取 `.items` 当数组用。把信封当数组用的症状是
 * `parts.length` 恒 undefined（计数恒空）+ `useScanPartsSort` 的 `[...list]` 抛
 * `TypeError: list is not iterable` ⇒ 报工台三页（取件 / 放回 / 送检）渲染全崩。
 *
 * ⚠️ `total` / `limit` / `offset` 是裸 i64 ⇒ JSON **number**（字符串形态会被守门拒收）。
 *
 * 两个端点都是 `limit.unwrap_or(50).clamp(1, 200)`：不传 limit 时**默认只返 50 条**，
 * 而调用方若把它当「全部」就会静默截断。报工台三页 + HeldPartsBadge 统一显式传
 * `limit: 200`（clamp 上限）取全。
 */
export const scanPartListResultSchema = z.object({
  items: z.array(scanPartRowSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type ScanPartListResultSchema = z.infer<typeof scanPartListResultSchema>;
