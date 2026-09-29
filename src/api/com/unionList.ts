// 2026-09-29 新增：com 域 union-list 端点封装。
//
// 后端 com/union_list 模块（backend-rust src/modules/com/union_list/）三态合并列表：
//   row_type=ALL: t_part UNION t_assembly（带 LIMIT pushdown 修分页 bug）
//   row_type=PART: 仅 t_part WHERE assembly_id IS NULL
//   row_type=ASSEMBLY: 仅 t_assembly
// 老 /api/v2/parts 回退到 PART-only；listParts（@/api/parts）仍存在（processChain.ts 在用），
// 这里仅迁移零件一览页（src/views/parts/list/）到 com 域新端点。
//
// 三态合并 + 分页修复的设计动机（详见 plan: com-get-part-union-all-t-assembly-t-par-graceful-mitten）：
//   - 域边界回归：part 域不再查 t_assembly；跨表合并下沉到 com 域；
//   - 分页 bug 修复：原 ALL 分支用 segment_limit = (limit+offset).clamp(1,200) 把每段
//     硬截到 200 行，线上 total=1477 / offset=1450 / limit=50 时两段最多 200+200≈400
//     行被拉回，skip(1450).take(50) 返回空集。新 UNION ALL + 每段 LIMIT pushdown
//     保证位置 [offset, offset+limit) 内的任何行必然来自某段的前 (offset+limit) 行。

import { api, cleanParams, normalizeListResult } from '@/api/http';
import type { ListPartsParams, PartListResult } from '@/api/parts';

export type UnionListRowType = 'ALL' | 'PART' | 'ASSEMBLY';

/** ListPartsParams 含 row_type 与 include_assemblies 字段，union-list 端点：
 *  - row_type 必填（com 域端点必须明确指定三态之一）；
 *  - include_assemblies 已废弃（合并逻辑下沉到 com 域，part 域仅查本体）。
 *  Omit 排除两者后重新声明 row_type 必填，保证类型显式、字段语义清晰。
 *  其余字段（statuses / keyword / 时间区间 / 多选 holder 等）原样沿用。 */
export interface UnionListParams
  extends Omit<ListPartsParams, 'row_type' | 'include_assemblies'> {
  row_type: UnionListRowType;
}

/** GET /api/v2/com/union-list（com 域跨表合并列表）。
 *  2026-09-29：normalizeListResult 兜底分页字段 string → number（同 listParts 处理）。
 *  返回 PartListResult 是因为响应形态与 part 域 listParts 完全一致（item 内 row_type
 *  字段已存在），前端 store / view / columnDefs 不需任何改造。 */
export async function listUnionItems(params: UnionListParams): Promise<PartListResult> {
  const resp = await api.get<PartListResult>('/com/union-list', { params: cleanParams(params) });
  return normalizeListResult(resp.data);
}