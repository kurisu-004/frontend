// PartBatchNew 共享工具（纯函数 + 无状态）。
//
// 2026-08-25 拆分：把两个 Tab 共用的小工具（uid / URL revoke / 日期 / 客户查找 / 文件名 / 页 uid）
// 从 PartBatchNew.vue 抽到独立模块。**不是** composable —— 不暴露 ref / return shape。
//
// 调用方：`usePartBatchManual` / `usePartBatchPdf` 都按需 import。

import type { Ref } from 'vue';
import type { Customer } from '@/api/customer';

/** 生成一条记录的本地 uid（条目级 snowflake 不存在，用 crypto.randomUUID 兜底）。 */
export function makeUid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `uid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 释放一条 staged entry 的 blob URL（防止内存泄漏）。 */
export function revokeEntryUrls(entry: { drawingUrl?: string | null }): void {
  if (entry.drawingUrl) {
    try {
      URL.revokeObjectURL(entry.drawingUrl);
    } catch {
      /* ignore */
    }
  }
}

/** 把「今天」格式化成 YYYY-MM-DD 字符串。 */
export function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 把客户 id（雪花 ID 字符串）解析成「parent_name / name」可读 label。 */
export function findCustomerLabel(customers: Ref<Customer[]>, id: string | null): string {
  if (id === null) return '';
  const c = customers.value.find((x) => x.id === id);
  if (!c) return '';
  return c.parent_name ? `${c.parent_name} / ${c.name}` : c.name;
}

/** 把 cascader 选中的客户 id（可能是叶子）解析到所属的一级客户 id。 */
export function resolveRootCustomerId(
  customers: Ref<Customer[]>,
  pickedId: string | null,
): string | null {
  if (pickedId === null || pickedId === undefined || pickedId === '') return null;
  const picked = customers.value.find((c) => c.id === pickedId);
  if (!picked) return null;
  if (picked.parent_id === null) return picked.id;
  return picked.parent_id;
}

/** 去掉文件名的 .pdf 扩展名（用于合成 PDF 重命名）。 */
export function stripExt(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/** 生成 PDF 页 UID（用于 selectedPages Set 的 key）。 */
export function pageUid(pdfUid: string, pageIndex: number): string {
  return `${pdfUid}:${pageIndex}`;
}

/** 解析 Set 里的 key → pdfUid / pageIndex。 */
export function parsePageUid(key: string): { pdfUid: string; pageIndex: number } {
  const last = key.lastIndexOf(':');
  return { pdfUid: key.slice(0, last), pageIndex: Number(key.slice(last + 1)) };
}

/**
 * 含税单价 / 总价 → 后端 `Decimal` 契约字符串（固定 2 位小数）。
 *
 * 2026-10-05 新增：建单入参的 `unit_price` / `total_price` 是 rust `rust_decimal`
 * + `serde-with-str`，**只认字符串**，且列精度是 `NUMERIC(12,2)` / `NUMERIC(14,2)`。
 *
 * 为什么必须 `toFixed(2)` 而不是 `String(n)`：表格里的总价是裸浮点乘算出来的
 * （`unit_price * quantity`），`0.1 * 3` 在 IEEE 754 下是 `0.30000000000000004`。
 * `String()` 会把它原样发出去，后端 `Decimal` 如实解析成 13 位小数，超出 2 位标度
 * 的入参要么被拒、要么落库出一堆无意义尾数。`toFixed(2)` 同时解决「浮点尾数」和
 * 「不足 2 位补零」两件事，输出恒为 `d+` 或 `-d+.dd`。
 *
 * `null` / `undefined` / `NaN` → `undefined`：调用方据此**不发该键**，后端落默认 0。
 * 不能折成 `'0'` —— 那会把「用户没填价」和「用户明确填了 0 元」混成同一个语义。
 *
 * 已知舍入边界：`toFixed(2)` 走 IEEE 754 的 double，半值在两个量级上舍向相反
 * （`(1.005).toFixed(2) === '1.00'` 而 `(0.005).toFixed(2) === '0.01'`）。UI 录入路径
 * 上 `ElInputNumber` 的 `precision: 2` 先舍一遍，所以只影响 Excel 回填这类未经
 * `ElInputNumber` 的值，误差 ≤ 0.01 元，可接受。`(-0).toFixed(2)` 是 `'0.00'`，不产
 * 出 `-0.00`。
 */
export function toMoneyString(n: number | null | undefined): string | undefined {
  if (n == null || !Number.isFinite(n)) return undefined;
  return n.toFixed(2);
}
