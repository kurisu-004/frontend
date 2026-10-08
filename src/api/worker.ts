// 后端工人 API（走 @/api/http 统一 axios 客户端）。
//
// 本文件的 `Worker` 对齐后端 `WorkerOut`（账号管理页「工人一览」的列表 / 详情 / 建号 /
//  编辑 / 停启用），字段较全（version / is_active / created_at / updated_at）。
// 报工台的工牌扫码定位**不走本文件**：它随 2026-10-10 的 `prod::scan` 域搬迁迁到
// `src/api/productionScan.ts::findWorkerByBadge`，出参是另一个 VO —— 4 字段的
// `ScanWorkerBriefDto`（扫码 session 的最小投影）。后端 `WorkerOut` 未删，两者并存。

import { api, cleanParams, normalizeListResult } from '@/api/http';
import type {
  Worker,
  WorkerCreatePayload,
  WorkerListResult,
  WorkerUpdatePayload,
} from '@/types/worker';

export interface ListWorkersParams {
  name_like?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}

export async function listWorkers(params: ListWorkersParams = {}): Promise<WorkerListResult> {
  // 2026-09-25 修正：后端路由前缀缺失 /prod/ 段，补齐对齐 v2 backend-rust 实际契约。
  const resp = await api.get<WorkerListResult>('/prod/workers', {
    params: cleanParams(params),
  });
  // 2026-09-25 修正：用 normalizeListResult 包一层，把 total/limit/offset 强制成 number。
  // 后端 WorkerListOut 当前是 i64 number，但 schema 漂移历史里偶有走 serialize_i64
  // 字符串的域，本 helper 兜底。schema 类型保持不变。
  return normalizeListResult(resp.data);
}

export async function getWorker(id: string): Promise<Worker> {
  const resp = await api.get<Worker>(`/prod/workers/${id}`);
  return resp.data;
}

export async function createWorker(payload: WorkerCreatePayload): Promise<Worker> {
  const resp = await api.post<Worker>('/prod/workers', payload);
  return resp.data;
}

export async function updateWorker(id: string, payload: WorkerUpdatePayload): Promise<Worker> {
  const resp = await api.post<Worker>(`/prod/workers/${id}/update`, payload);
  return resp.data;
}

export async function deactivateWorker(id: string): Promise<Worker> {
  const resp = await api.post<Worker>(`/prod/workers/${id}/deactivate`);
  return resp.data;
}

export async function reactivateWorker(id: string): Promise<Worker> {
  const resp = await api.post<Worker>(`/prod/workers/${id}/reactivate`);
  return resp.data;
}
