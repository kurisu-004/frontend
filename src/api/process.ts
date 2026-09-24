// 工序 (Process) API 封装。

import { api, cleanParams } from '@/api/http';
import type {
  Process,
  ProcessCategory,
  ProcessCreatePayload,
  ProcessListResult,
  ProcessUpdatePayload,
} from '@/types/process';

export async function listProcesses(
  params: {
    code_like?: string;
    category?: ProcessCategory;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ProcessListResult> {
  // 2026-09-25 修正：后端路由前缀缺失 /prod/ 段，补齐对齐 v2 backend-rust 实际契约。
  const resp = await api.get<ProcessListResult>('/prod/processes', {
    params: cleanParams(params),
  });
  return resp.data;
}

export async function getProcess(id: string): Promise<Process> {
  const resp = await api.get<Process>(`/prod/processes/${id}`);
  return resp.data;
}

export async function createProcess(payload: ProcessCreatePayload): Promise<Process> {
  const resp = await api.post<Process>('/prod/processes', payload);
  return resp.data;
}

export async function updateProcess(id: string, payload: ProcessUpdatePayload): Promise<Process> {
  const resp = await api.post<Process>(`/prod/processes/${id}/update`, payload);
  return resp.data;
}

export async function softDeleteProcess(id: string): Promise<void> {
  await api.post(`/prod/processes/${id}/soft-delete`);
}
