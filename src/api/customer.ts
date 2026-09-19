// 客户 API（走 @/api/http 统一 axios 客户端）。
// Excel 批量导入零件时用 listCustomers() 拉全量客户，
// 客户端按 `parent_name / name` 唯一定位叶子客户的 id。

import { api } from '@/api/http';

export interface Customer {
  id: string;
  name: string;
  parent_id: string | null;
  /** 仅叶子节点的二级客户有 parent_name；一级节点为 null。 */
  parent_name: string | null;
  /**
   * 一级客户的序列号前缀（A-Z 单字符）；叶子客户继承父，本字段恒为 null。
   * 后端 schema 端为 `str | None`，前端保持 `string | null` 与 schema 一致。
   */
  serial_prefix: string | null;
}

export interface CustomerCreatePayload {
  name: string;
  /** null = 一级客户；非空 = 挂在某个一级客户下的二级客户。 */
  parent_id: string | null;
  /**
   * 一级客户必填（A-Z 单字符）；叶子客户忽略本字段（永远继承父）。
   * 传 null = 不传（后端会拒）。
   */
  serial_prefix: string | null;
}

export interface CustomerUpdatePayload {
  name?: string;
  parent_id?: string | null;
  /**
   * 一级客户的序列号前缀（A-Z 单字符）。后端 schema 无 "传 null = 清空"
   * 语义，所以本字段 None 即"不改"；想改时直接传新字母。
   * 叶子客户忽略本字段。
   */
  serial_prefix?: string | null;
}

/**
 * 分页客户列表结果（v2 backend-rust 的 `/api/v2/com/customers` 返回结构）。
 * 2026-09-15 新增：Phase 5 切到 v2 后后端返回分页结构，前端用 `.items` 取数组。
 * 2026-09-19 com 模块归位：customer/applicant 域聚合到 com（Customer Order Management）下，
 *   URL 从 `/api/v2/customers` 迁到 `/api/v2/com/customers`。
 */
export interface CustomerListResult {
  items: Customer[];
  total: number;
  limit: number;
  offset: number;
}

export async function listCustomers(): Promise<CustomerListResult> {
  const resp = await api.get<CustomerListResult>('/com/customers');
  return resp.data;
}

export async function getCustomer(id: string): Promise<Customer> {
  const resp = await api.get<Customer>(`/com/customers/${id}`);
  return resp.data;
}

export async function createCustomer(payload: CustomerCreatePayload): Promise<Customer> {
  const resp = await api.post<Customer>('/com/customers', payload);
  return resp.data;
}

export async function updateCustomer(
  id: string,
  payload: CustomerUpdatePayload,
): Promise<Customer> {
  const resp = await api.post<Customer>(`/com/customers/${id}/update`, payload);
  return resp.data;
}

export async function softDeleteCustomer(id: string): Promise<void> {
  await api.post(`/com/customers/${id}/soft-delete`);
}
