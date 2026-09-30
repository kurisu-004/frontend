// programming 域前端 API（v2，baseURL /api/v2，2026-10-01 新增）。
//
// 端点（与 backend-rust `src/modules/prod/programming/mod.rs` 路由挂载对齐）：
//   GET /api/v2/prod/programming/pending   ← fetchPendingProgramming
//
// 2026-10-01 端点迁移说明：
//   「待编程一览」页（src/views/cnc/PendingProgrammingList.vue）此前调 part 域
//   `GET /api/v2/parts/pending-programming`（api/parts/crud.ts::listPendingProgramming，
//   2026-10-01 已删除该函数），后端该端点恒返空列表。后端同期在 **prod 域**新增
//   `GET /api/v2/prod/programming/pending` 作为唯一真源，本页数据源切到该端点，
//   出参从 PartListItem 换成 ProgrammingItem（客户字段名为 parent_customer_name /
//   customer_name，与 part 域的 l1_customer_name 不同名，页面列渲染已同步改读）。
//
// i64 字符串约定（后端通用约定，见 backend-rust/docs/api/index.md）：
//   所有雪花 ID 一律以 JSON string 返回（前端禁止 Number() 转换，19 位 ID 在
//   JS Number 下会丢精度）。请求方向则相反：`limit` / `offset` 后端用
//   `deserialize_i64_opt` 解析，数字或字符串都收，但空串会触发 400
//   VALIDATION_ERROR ⇒ 前端一律经 `cleanParams` 剥掉空串 / undefined。
//
// Zod 守门理由：响应经 `pendingProgrammingListResultSchema.parse` 校验 ——
// 沿 CLAUDE.md §M-4（Zod 默认 strip 模式缺字段静默丢弃 = 校验形同虚设），
//   ProgrammingItem 的 13 个字段在 schema 内全部显式声明，后端漏返 / 漂移立即抛
//   ZodError，而不是让表格静默少列显示。
//
// 业务端点统一走 `api`（baseURL `/api/v2`）。

import { api, cleanParams } from '@/api/http';
import {
  pendingProgrammingListResultSchema,
  type PendingProgrammingListResultSchema,
} from '@/composables/queries/schemas';

/** `GET /api/v2/prod/programming/pending` 入参形态（rust ListPendingQuery）。
 *
 *  2026-10-01：全部字段可选（后端 `Option<...>` 逐字段接收）。
 *   - `has_cnc_program`：三态。`true` 仅已上传 G_CODE / `false` 仅未上传 /
 *     **省略 = 全部**。
 *     后端 `deserialize_bool_opt`（backend-rust
 *     src/modules/prod/programming/dto.rs）的实际语义，2026-10-01 review 第 1 轮
 *     M-4 按源码订正（旧注释写「传空串会返 400」是错的）：
 *       · 缺省 / 空串 / 纯空白串 → `Ok(None)` = **不过滤**，不报错；
 *       · `true` / `false`（大小写不敏感）→ 正常过滤；
 *       · 其它字面量（`1` / `yes` / `abc` …）→ 400 VALIDATION_ERROR。
 *     即空串是安全的，但前端仍统一在 buildParams 里只发真 boolean（`cleanParams`
 *     也不会把 `false` 当空值剥掉），不依赖后端的空串兜底。
 *   - `keyword`：模糊匹配 name / drawing_no / serial_no（子串）。
 *   - `serial_no`：精确匹配。
 *   - `sort_by`：后端白名单 `CREATED_AT / UPDATED_AT / PLANNED_DELIVERY_DATE /
 *     REQUEST_DATE / SERIAL_NO / DRAWING_NO / NAME`，非法值由后端退化为
 *     `PLANNED_DELIVERY_DATE`（前端只发白名单内值，不依赖该退化行为）。
 *   - `limit`：1..=500，缺省 50（前端 pageSize 恒落在 EP 默认的 10..=100 内）。
 *   - `offset`：缺省 0。
 */
export interface ListPendingProgrammingParams {
  has_cnc_program?: boolean;
  keyword?: string;
  serial_no?: string;
  sort_by?: string;
  sort_dir?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
}

/** `GET /api/v2/prod/programming/pending` 出参（rust ProgrammingListOut）。
 *  结构 = `{ items: ProgrammingItem[], total, limit, offset }`。
 *  2026-10-01 review 第 1 轮 M-3：原先另导了一个 `PendingProgrammingListDto` 别名，
 *  全仓零引用（同义于下面 fetchPendingProgramming 的返回类型），已删 —— 避免
 *  「同一个出参两种叫法」让后来者猜该用哪个。 */

/** GET /api/v2/prod/programming/pending —— 拉取待编程（/ 已编程）零件列表。
 *  响应经 Zod parse 守门（见文件头「Zod 守门理由」）。
 *
 *  2026-10-01 review 第 1 轮 M-2：守门**刻意收敛在本层**（形态同
 *  api/pendingBatches.ts::dispatchBatches）—— 任何调用方都自动受守门，不必各自
 *  记得 parse；调用方（如 usePendingProgrammingStore 的 queryFn）**不要**再 parse
 *  一遍，Zod 的 parse 返回深拷贝，重复 parse 等于每屏数据被克隆两遍。 */
export async function fetchPendingProgramming(
  params: ListPendingProgrammingParams = {},
): Promise<PendingProgrammingListResultSchema> {
  const resp = await api.get<unknown>('/prod/programming/pending', {
    params: cleanParams(params),
  });
  return pendingProgrammingListResultSchema.parse(resp.data);
}
