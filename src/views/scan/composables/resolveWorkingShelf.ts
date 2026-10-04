// views/scan/composables/resolveWorkingShelf.ts
//
// 2026-10-04 新增：报工台「当前作业架」的前置守卫，**只服务送检**（/scan/inspect）。
// 取件（/scan/pick）已解绑：后端把 pick-up 的 `shelf_id` 改成可选且缺省不做任何校验，
// 本页不再发它，所以那里没有货架守卫。放回（/scan/return）的 `shelf_id` 来自
// for-return picker 的现场选架，与作业架无关。
//
// 为什么不把守卫留在送检页里：错位报错（品检架当 `shelf_id` 发出去）与空值报错
// （省略 `shelf_id`）各有一处后端依据，集中一处才好让提交确认那条唯一路径复用同一套
// 判定与同一套文案。
//
// 契约依据（backend-rust `docs/api/`，本仓规约：引 docs，不引源码符号）：
// - `docs/api/parts/inspection.md` 的 `POST /api/v2/prod/batches/worker-scan`：
//   `shelf_id` 两个 event_type 同义，均要求 PRODUCTION 区（违反 → `20501`），
//   与 `event_type` 无关；且它在**本账号绑定集内**（违反 → `40301 SHELF_MISMATCH`）
//   ⇒ 这是真事实（落库进 `t_part_batch.current_holder_id`），前端必须尽量取对。
// - ⚠️ `shelf_id` 缺省**不是** `40001`：它是无 `#[serde(default)]` 的必填 `i64`，
//   缺字段由 axum `Json` extractor 在 service 之前直接拒 ⇒ **裸 HTTP 422、响应体不是
//   项目统一 `R` 信封**（inspection.md 明写「非项目统一信封」）⇒ 本仓 `ApiError` 拿不到
//   code。**必须在发请求前拦**。

import { ElMessage } from 'element-plus';
import { useScanShelfStore } from '@/stores/scanShelf';

/**
 * 当前作业架是否可用于提交；不可用时返回给工人看的文案（可用返回 null）。
 *
 * 只覆盖「一定会提交失败 / 会拿错架发出去」的三种状态：多架未选、选中品检架、zone 未解析。
 *
 * **只读不弹提示**，供调用方自选提示级别与时机（提交前用 `resolveWorkingShelfId`；
 * 进页提示用本函数）。
 *
 * 调用前必须已 `await useScanShelfStore().initShelves()`：未加载时 `selectedShelfId`
 * 恒为 null，本函数会把「没加载」误报成「账号没绑货架」。
 */
export function workingShelfProblem(): string | null {
  const scanShelf = useScanShelfStore();
  if (!scanShelf.selectedShelfId) {
    const n = scanShelf.options.length;
    return n >= 2
      ? '本账号绑定了多个货架，请先在「操作选择」页选择当前作业货架'
      : '当前账号未绑定作业货架，请联系管理员在「账号管理」为本账号绑定生产货架';
  }
  if (scanShelf.selectedZone === 'INSPECTION') {
    // 单架账号落在品检区：候选里根本没有生产架可换（选架弹窗只列 PRODUCTION），
    // 文案不能说「请改选生产货架」，只能陈述事实 + 指管理员。
    return '本账号当前绑定的货架在品检区，缺少生产区作业货架，请联系管理员为本账号绑定生产货架';
  }
  if (scanShelf.selectedZone === null) {
    // zone 既不是 PRODUCTION 也不是 INSPECTION：既不能按「品检区」也不能按「生产区」
    // 下结论，更不能乐观放行（放行 = 把一个未验证的架当生产架发出去）。两种成因在
    // `selectedZone` 上不可区分：后端真返了一个未知 zone，或货架端点失败 / 不全导致
    // store 兜底填了 UNKNOWN（见 store 的 initShelves）。单列一条。
    return '无法识别当前货架所属区域，不能作为作业货架，请联系管理员核对本账号的货架绑定';
  }
  return null;
}

/**
 * 取当前作业架 id；不可用时弹错误提示并返回 null（调用点必须 return，不许带空
 * `shelf_id` 发请求）。「这次提交被拦」是逐次事实，所以 error 每次都弹。
 *
 * 调用前必须已 `await useScanShelfStore().initShelves()`（同 `workingShelfProblem`）。
 */
export function resolveWorkingShelfId(): string | null {
  const problem = workingShelfProblem();
  if (problem) {
    ElMessage.error(problem);
    return null;
  }
  const scanShelf = useScanShelfStore();
  return scanShelf.selectedShelfId;
}
