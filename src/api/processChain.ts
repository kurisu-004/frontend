// process_chain 域前端 API（v2，baseURL /api/v2，2026-09-15 Phase 5 业务全切 v2）。
//
// 端点（与 backend-rust/src/modules/process_chain/handler.rs 对齐）：
//   GET  /api/v2/prod/process-chains/by-part/{part_id}  ← getProcessChainByPart（保留可用）
//   GET  /api/v2/prod/process-chains/{chain_id}         ← getProcessChainById（2026-09-16 新增）
//   PUT  /api/v2/prod/process-chains/by-part/{part_id}  ← upsertProcessChainByPart
//   GET  /api/v2/prod/processes                         ← listProcesses (转引)
//   GET  /api/v2/prod/parts                             ← listParts (转引)
//
// 业务端点统一走 `api`（baseURL `/api/v2`，2026-09-15 Phase 5 起）。
// 整组 upsert 约束：rust PUT /prod/process-chains/by-part/{part_id} 是整组替换语义——
// 前端必须发完整 steps 数组（包括 service-side 已有的 step），否则会被覆盖。
// 详见 usePartProcessDesign.ts 的 GET-merge-PUT 模式。
//
// 2026-09-25 修正：补齐 /prod/ 前缀；listProcesses / listParts 用
// ProcessListResult / PartListResult 类型替代裸 unknown[]。

import { api, cleanParams } from '@/api/http';
import type { OrderStatus, PartListItem } from '@/types/parts';
import type { Process } from '@/types/process';
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

/** PUT /api/v2/prod/process-chains/by-part/{part_id}
 *  整组 upsert：替换所有 steps。Manager role 守卫（service 端校验）。
 *  失败 → 后端 20104 / 40901 / 40300 等，前端用 ApiError.code 分流。 */
export async function upsertProcessChainByPart(
  partId: string | number,
  body: UpsertProcessChainRequest,
): Promise<ProcessChainByPartDto> {
  const resp = await api.put<ProcessChainByPartDto>(
    `/prod/process-chains/by-part/${encodeURIComponent(String(partId))}`,
    body,
  );
  return resp.data;
}

/** GET /api/v2/prod/processes
 *  走 api（baseURL `/api/v2`）：rust 端 processes 域只在 v2 实现（migration 018），
 *  v1 Python 端无对应。
 *  limit=500 拉全量（默认 50 太少）。
 *  2026-09-25 修正：返回类型由 unknown[] 改为 Process[]（依赖 @/types/process 的
 *  ProcessListResult 派生），调用方不再需要就地强转。 */
export async function listProcesses(
  params: { is_active?: boolean } = {},
): Promise<Process[]> {
  void params; // is_active 在当前 v2 schema 不支持；保留入参兼容未来扩展
  const resp = await api.get<{ items: Process[]; total: number; limit: number; offset: number }>(
    '/prod/processes',
    { params: { limit: 500 } },
  );
  return resp.data.items;
}

/** GET /api/v2/prod/parts
 *  走 api（baseURL `/api/v2`）。
 *  keyword 模糊过滤图号/名称（PartListQuery.keyword，rust 端 2026-08 已支持）。
 *  status 单值过滤（PartListQuery.status）：rust 端 2026-08 已支持；
 *  工序制定页固定传 `PENDING` —— 已经下发编程/车间的工件不应在此页展示
 *  （v2 PartStatus 枚举与 OrderStatus 一致：PENDING / PROGRAMMING / IN_PROCESS / ...）。
 *  limit=200：v2 不支持 include_assemblies（已删除该参数）；工序制定只需零件本体。
 *  2026-09-25 修正：返回类型由 unknown[] 改为 PartListItem[]（来自 @/types/parts）。
 *  2026-09-16 修复：新增 status 入参（与 src/api/parts/crud.ts:statuses 不复用，
 *  那个是 OrderStatus[] 重复 key，给其它列表页用；这里走单值 status，与后端 PartListQuery.status 对齐）。 */
export async function listParts(
  params: { keyword?: string; status?: OrderStatus } = {},
): Promise<PartListItem[]> {
  const resp = await api.get<{
    items: PartListItem[];
    total: number;
    limit: number;
    offset: number;
  }>('/prod/parts', {
    params: cleanParams({ keyword: params.keyword, status: params.status, limit: 200 }),
  });
  return resp.data.items;
}
