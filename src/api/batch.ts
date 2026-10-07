// 2026-10-08 新建：批次（t_part_batch）**跨域共用**的写端点入口（baseURL `/api/v2`，
// 前缀 `/batches/*`），照 `productionQueue.ts` / `productionQueue.contract.ts` 的两级
// 切分：契约 types 在 `./batch.contract.ts`（零 runtime），本文件只发请求。
//
// 为什么独立成文件：批次拆分既不属于 part 域（操作对象是批次而非工单）、也不属于
// prod::queue 域（下发 / 召回那条链），而是被多个消费面共用（零件详情页的拆批、
// 外协看板的拆批发）。放在 `api/parts/batch.ts` 里会让「part 域的批次集合读」与
// 「全模块共用的批次写」混在一个模块，调用方 import 时说不清自己在用哪一侧。
//
// 分层取舍：本文件**不做 Zod 守门** —— 拆批没有对应的 Zod schema，调用方
// （`usePartDetail.onSplitBatch`）拿到的出参只有 5 个字段且只判成败，不做逐字段校验；
// 要加守门时把 schema 放到调用方所在的域目录，由它在 mutationFn 里 parse。

import { api } from '@/api/http';
import type { BatchSplitDto, SplitBatchByBodyRequest } from './batch.contract';

/** POST /api/v2/batches/split —— 全模块共用的批次拆分（`batch_id` 入 body 而非路径）。
 *  角色 Manager + Clerk。⚠️ 无 `version` 时返 HTTP 422 **纯文本**（后端 serde 无
 *  `#[serde(default)]`），不是业务信封 —— 调用方拿到的是 `SyntaxError` 而不是带 code
 *  的 ApiError，错误文案要能兜住这种情况。
 *  业务错：20121（批次不存在）/ 20120（状态不允许拆）/ 40901（OCC 冲突，HTTP 409）。 */
export async function splitBatch(payload: SplitBatchByBodyRequest): Promise<BatchSplitDto> {
  const resp = await api.post<BatchSplitDto>('/batches/split', payload);
  return resp.data;
}
