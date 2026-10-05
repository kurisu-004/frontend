// process_chain 域前端 API（v2，baseURL /api/v2，2026-09-15 Phase 5 业务全切 v2）。
//
// 端点（与 backend-rust/src/modules/process_chain/handler.rs 对齐）：
//   GET  /api/v2/prod/process-chains/by-part/{part_id}  ← getProcessChainByPart（保留可用）
//   GET  /api/v2/prod/process-chains/{chain_id}         ← getProcessChainById（2026-09-16 新增）
//   POST /api/v2/prod/process-chains/by-part/{part_id}  ← upsertProcessChainByPart（2026-09-29 由 PUT 改 POST）
//   GET  /api/v2/prod/process-design/parts              ← listProcessDesignParts（2026-10-05 新增）
//
// 业务端点统一走 `api`（baseURL `/api/v2`，2026-09-15 Phase 5 起）。
// 整组 upsert 约束：rust POST /prod/process-chains/by-part/{part_id} 是整组替换语义——
// 前端必须发完整 steps 数组（包括 service-side 已有的 step），否则会被覆盖。
//
// 2026-09-25 修正：补齐 /prod/ 前缀；出参类型由裸 unknown[] 换成形化类型。
// 2026-09-29 变更：upsertProcessChainByPart 由 PUT 改 POST（统一惯例，整组
// upsert 不是幂等覆盖而是 create-or-replace 语义，更贴 POST）。
//
// 2026-10-05 变更：删除本文件内的 listParts / listProcesses 两个转引函数。
//   - listParts（part 域 `GET /api/v2/parts`）：「制定工序」页此前是它唯一的调用方，
//     本页数据源已切到 `GET /prod/process-design/parts`（见 listProcessDesignParts），
//     删后全仓零调用方。src/api/parts/crud.ts 的同名函数是另一份（零件一览 / 报工台
//     等页的历史调用链），不受影响。
//   - listProcesses（转引 `GET /api/v2/prod/processes`）：本页的工序下拉已改走共享
//     基础数据层 `useProcessesQuery`（src/composables/queries/useProcessesQuery.ts），
//     它自带 Zod 守门 + 30s staleTime 跨页去重，删后全仓零调用方。其它页调的是
//     `src/api/process.ts` 的同名函数（各自的真实数据源），不受影响。

import { api, cleanParams } from '@/api/http';
import {
  processDesignPartListResultSchema,
  type ProcessDesignPartListResultSchema,
} from '@/composables/queries/schemas';
import type { ProcessChainByPartDto, UpsertProcessChainRequest } from './processChain.contract';

/** GET /api/v2/prod/process-chains/by-part/{part_id}
 *  无链 → 后端 20701 BIZ_PROCESS_CHAIN_NOT_FOUND（HTTP 404）；前端用 try/catch 兜底。
 *  partId 接受 string|number：雪花 ID 字符串是前端约定（CLAUDE.md #3），
 *  但部分调用方可能传 number（兼容），最终拼接时 toString() 统一。
 *  2026-09-16：工序制定页 loadFlow 已改走 getProcessChainById（part.process_chain_id
 *  驱动），本端点后端保留可用，前端暂无消费方，保留备查。 */
export async function getProcessChainByPart(
  partId: string | number,
): Promise<ProcessChainByPartDto> {
  const resp = await api.get<ProcessChainByPartDto>(
    `/prod/process-chains/by-part/${encodeURIComponent(String(partId))}`,
  );
  return resp.data;
}

/** GET /api/v2/prod/process-chains/{chain_id}（2026-09-16 新增）
 *  按链 id 加载工艺链；响应 shape 与 by-part 一致（ProcessChainOut，已无 part_id）。
 *  无链 / 链已删 → 后端 20701 BIZ_PROCESS_CHAIN_NOT_FOUND（HTTP 404），前端按空链兜底。 */
export async function getProcessChainById(chainId: string): Promise<ProcessChainByPartDto> {
  const resp = await api.get<ProcessChainByPartDto>(
    `/prod/process-chains/${encodeURIComponent(chainId)}`,
  );
  return resp.data;
}

/** POST /api/v2/prod/process-chains/by-part/{part_id}
 *  整组 upsert：替换所有 steps。Manager role 守卫（service 端校验）。
 *  失败 → 后端 20104 / 40901 / 40300 等，前端用 ApiError.code 分流。
 *  2026-09-29 变更：HTTP 方法由 PUT 改 POST（统一惯例，整组 upsert 实质是
 *  create-or-replace 语义，POST 更贴；PUT 是 HTTP 语义上的幂等覆盖）。
 *  函数名 / 参数 / 返回类型不变，与后端契约保持向后兼容（contract 已同步
 *  注释，见 processChain.contract.ts）。 */
export async function upsertProcessChainByPart(
  partId: string | number,
  body: UpsertProcessChainRequest,
): Promise<ProcessChainByPartDto> {
  const resp = await api.post<ProcessChainByPartDto>(
    `/prod/process-chains/by-part/${encodeURIComponent(String(partId))}`,
    body,
  );
  return resp.data;
}

/** `GET /api/v2/prod/process-design/parts` 入参形态（rust `ListProcessDesignPartsQuery`）。
 *  2026-10-05 新增。**三字段全部可选、无一必填**，后端逐字段 `Option<...>` 接收。
 *   - `sort_dir`：`'DESC'` 生效、其余值（含缺省 / 任意字面量）一律按 `'ASC'` 处理
 *     （大小写不敏感）。排序键**固定** `serial_no`（`varchar(15)` ⇒ 字典序，不是
 *     数值序：`F1001-10` 排在 `F1001-2` 前面），端点**不提供** `sort_by`。
 *   - `limit`：缺省 200，service 层 `clamp(1, 500)`。
 *   - `offset`：缺省 0，service 层 `max(0)`。
 *  刻意**不提供** `status` / `keyword` / `row_type` / `include_assemblies`：
 *   - `status`：`PENDING` 是本页的业务闸门（只有未开工的零件才需要定工序），
 *     写死在后端 SQL 常量里，不开放成旋钮；
 *   - `keyword`：前端本地过滤，后端不接收；
 *   - `row_type` / `include_assemblies`：本端点存在的意义就是**没有**那道
 *     `AND assembly_id IS NULL` 守卫（part 域 `GET /parts` 有，故把装配件子件全排除），
 *     把「要不要子件」做成开关等于把守卫换个地方藏。 */
export interface ListProcessDesignPartsParams {
  sort_dir?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
}

/** `GET /api/v2/prod/process-design/parts` —— 「制定工序」页零件列表。
 *  响应 `{ items, total, limit, offset }` 经 `processDesignPartListResultSchema.parse`
 *  守门（7 个行字段 + 3 个计数字段全部显式声明，见 schemas.ts 的说明）。
 *
 *  Zod 守门**刻意收敛在 api 层**（沿 api/programming.ts::fetchPendingProgramming）：
 *  任何调用方都自动受守门，不必各自记得 parse；调用方（store 的 queryFn）**不要**再
 *  parse 一遍 —— Zod 的 parse 返回**深拷贝**，重复 parse 等于每屏数据被校验 + 克隆两遍。 */
export async function listProcessDesignParts(
  params: ListProcessDesignPartsParams = {},
): Promise<ProcessDesignPartListResultSchema> {
  const resp = await api.get<unknown>('/prod/process-design/parts', {
    params: cleanParams(params),
  });
  return processDesignPartListResultSchema.parse(resp.data);
}
