// 工序 (Process) API 封装。

import { api, cleanParams } from '@/api/http'
import type {
  Process,
  ProcessCategory,
  ProcessCreatePayload,
  ProcessListResult,
  ProcessUpdatePayload,
} from '@/types/process'

export async function listProcesses(
  params: {
    code_like?: string
    category?: ProcessCategory
    limit?: number
    offset?: number
  } = {},
): Promise<ProcessListResult> {
  const resp = await api.get<ProcessListResult>('/processes', {
    params: cleanParams(params),
  })
  return resp.data
}

export async function getProcess(id: string): Promise<Process> {
  const resp = await api.get<Process>(`/processes/${id}`)
  return resp.data
}

export async function createProcess(
  payload: ProcessCreatePayload,
): Promise<Process> {
  const resp = await api.post<Process>('/processes', payload)
  return resp.data
}

export async function updateProcess(
  id: string,
  payload: ProcessUpdatePayload,
): Promise<Process> {
  const resp = await api.post<Process>(`/processes/${id}/update`, payload)
  return resp.data
}

export async function softDeleteProcess(id: string): Promise<void> {
  await api.post(`/processes/${id}/soft-delete`)
}