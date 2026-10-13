// 客户 API（走 @/api/http 统一 axios 客户端）。
//
// 2026-10-17 重写文件头：旧注释说「Excel 批量导入零件时用 listCustomers() 拉全量客户，
// 客户端按 `parent_name / name` 唯一定位叶子客户的 id」—— **该描述已不成立**：
//   - Excel 导入链路（usePartBatchManual / usePartBatchPdf）的 customers 由
//     `PartBatchNew.vue` 从 `useCustomersQuery` 派生后按 props 传入，且按行里的
//     customerId 定位客户，不再按 `parent_name / name` 反查；
//   - `listCustomers()` 今天的唯一调用点是 `useCustomersQuery` 的 queryFn
//     （守门 schema 在那里 parse），其余读点都从 query 缓存派生。
// 保留的是「刻意不传参」这条约定：客户树拼装需要全量，而**不传 limit 才是全量**。
// 跨版本口径（2026-10-17 核对后端 `service/crud.rs`）：
//   - 2026-10-17 起的后端：`None` = 不限（旧的 `DEFAULT_LIMIT = 50` 已删除），不传参
//     拿到的就是全量；
//   - **更早的**后端：缺省 limit 是 50、上限 500 ⇒ 客户数一旦超过就会**缺层**
//     （第 3 层往下的节点从树上消失，且不报错）。
// ⇒ `listCustomers()` 不传参在**新旧两个版本下都返回全量**，本仓不需要为跨版本部署
// 加任何分支；上面第二条只在「后端尚未升级就发前端」的那段窗口里成立，见
// CLAUDE.md「客户无限层级（2026-10-17）」一节的部署顺序登记。

import { api, normalizeListResult } from '@/api/http';

export interface Customer {
  id: string;
  name: string;
  parent_id: string | null;
  /** 直接父节点的单段名；一级节点（parent_id = null）为 null。 */
  parent_name: string | null;
  /**
   * 一级客户的序列号前缀（A-Z 单字符）；非一级客户继承父，本字段恒为 null。
   * 后端 schema 端为 `str | None`，前端保持 `string | null` 与 schema 一致。
   */
  serial_prefix: string | null;
  /**
   * 2026-10-17 新增（客户无限层级改造）：**第 2 层到叶子**的名称用 ` / ` 拼接，
   * **不含 L1**。例：树 `华强 / 终端BG / 手机部 / 影像组`，L4 叶子的
   * `customer_path` = `"终端BG / 手机部 / 影像组"`；根节点（自身即 L1）则等于自己的
   * `name`。`name` / `parent_name` 仍是「本节点单段名」/「直接父名」，三者并存。
   * 展示层（列表页客户单元格主行）读本字段；筛选器选中任意层级后由后端展开成纯子树。
   */
  customer_path: string;
  /**
   * 乐观锁版本号；每次写操作 +1。前端走 OCC 时透传给 update payload（暂未启用，
   * 仅预留字段）。字段契约对齐 backend-rust `CustomerOut`
   * （`backend-rust/src/modules/com/customer/vo/customer.rs`）。
   */
  version: number;
  /** Asia/Shanghai naive datetime；前端按 string 处理（与项目 Zod 约定一致）。 */
  created_at: string;
  /** Asia/Shanghai naive datetime；前端按 string 处理（与项目 Zod 约定一致）。 */
  updated_at: string;
}

export interface CustomerCreatePayload {
  name: string;
  /** null = 一级客户（根）；非空 = 挂在任意父节点下（不限层级）。 */
  parent_id: string | null;
  /**
   * 一级客户必填（A-Z 单字符）；非一级客户忽略本字段（永远继承父）。
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
   * 非一级客户忽略本字段。
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
  // 2026-10-17：刻意不传任何 query 参数 —— 客户树拼装要全量，「不传 limit = 全量」
  // 是无限层级改造锁定的后端口径（详见文件头）。筛选（选中节点 → 纯子树）由后端在
  // 各业务列表端点上做，不在客户列表端点。
  const resp = await api.get<CustomerListResult>('/com/customers');
  // 2026-09-25 修正：用 normalizeListResult 包一层，把 total/limit/offset 强制成 number。
  // 后端 CustomerListOut 当前是 i64 number，但本 helper 兜底未来漂移到 serialize_i64 字符串的
  // 场景。schema 类型保持不变。
  return normalizeListResult(resp.data);
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
