// 2026-09-14 新增：process_chain 域前端 API（v2，baseURL /api/v2）。
//
// 端点（与 backend-rust/src/modules/process_chain/handler.rs 对齐）：
//   GET  /api/v2/process-chains/by-part/{part_id}  ← getProcessChainByPart
//   PUT  /api/v2/process-chains/by-part/{part_id}  ← upsertProcessChainByPart
//   GET  /api/v2/processes                          ← listProcesses (转引)
//   GET  /api/v2/parts                              ← listParts (转引)
//
// 注意：v2 端点必须用 apiV2（CLAUDE.md #2），禁止 api.post('/v2/...')。
// 整组 upsert 约束：rust PUT /process-chains/by-part/{part_id} 是整组替换语义——
// 前端必须发完整 steps 数组（包括 service-side 已有的 step），否则会被覆盖。
// 详见 usePartProcessDesign.ts 的 GET-merge-PUT 模式。

import { apiV2, cleanParams } from '@/api/http';
import type { ProcessChainByPartDto, UpsertProcessChainRequest } from './processChain.contract';

/** GET /api/v2/process-chains/by-part/{part_id}
 *  无链 → 后端 20701 BIZ_PROCESS_CHAIN_NOT_FOUND（HTTP 404）；前端用 try/catch 兜底。
 *  partId 接受 string|number：雪花 ID 字符串是前端约定（CLAUDE.md #3），
 *  但部分调用方可能传 number（兼容），最终拼接时 toString() 统一。 */
export async function getProcessChainByPart(
  partId: string | number,
): Promise<ProcessChainByPartDto> {
  const resp = await apiV2.get<ProcessChainByPartDto>(
    `/process-chains/by-part/${encodeURIComponent(String(partId))}`,
  );
  return resp.data;
}

/** PUT /api/v2/process-chains/by-part/{part_id}
 *  整组 upsert：替换所有 steps。Manager role 守卫（service 端校验）。
 *  失败 → 后端 20104 / 40901 / 40300 等，前端用 ApiError.code 分流。 */
export async function upsertProcessChainByPart(
  partId: string | number,
  body: UpsertProcessChainRequest,
): Promise<ProcessChainByPartDto> {
  const resp = await apiV2.put<ProcessChainByPartDto>(
    `/process-chains/by-part/${encodeURIComponent(String(partId))}`,
    body,
  );
  return resp.data;
}

/** GET /api/v2/processes
 *  直接走 apiV2（不进 @/api/process.ts 的 v1 路径）：
 *  rust 端 processes 域只在 v2 实现（migration 018），v1 Python 端无对应。
 *  limit=500 拉全量（默认 50 太少）。
 *  返回 unknown[]：consumer 在 composable 内强转为 Process[]。 */
export async function listProcesses(params: { is_active?: boolean } = {}): Promise<unknown[]> {
  void params; // is_active 在当前 v2 schema 不支持；保留入参兼容未来扩展
  const resp = await apiV2.get<{ items: unknown[]; total: number; limit: number; offset: number }>(
    '/processes',
    { params: { limit: 500 } },
  );
  return resp.data.items;
}

/** GET /api/v2/parts
 *  2026-09-14 review 第 1 轮：直接 apiV2.get('/parts')，不再转引 @/api/parts/crud.ts
 *  （后者走 v1 baseURL /api/v1，与本文件 v2 定位冲突）。
 *  keyword 模糊过滤图号/名称（PartListQuery.keyword，rust 端 2026-08 已支持）。
 *  limit=200：v2 不支持 include_assemblies（已删除该参数）；工序制定只需零件本体。
 *  返回 PartListOut.items（rust 端 PartListItem = TPart 28 列 + customer_name / l1_customer_name）。 */
export async function listParts(params: { keyword?: string } = {}): Promise<unknown[]> {
  const resp = await apiV2.get<{
    items: unknown[];
    total: string;
    limit: string;
    offset: string;
  }>('/parts', { params: cleanParams({ keyword: params.keyword, limit: 200 }) });
  return resp.data.items;
}
