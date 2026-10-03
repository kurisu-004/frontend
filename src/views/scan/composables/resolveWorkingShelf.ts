// views/scan/composables/resolveWorkingShelf.ts
//
// 2026-10-04 新增：报工台「当前作业架」的前置守卫，供取件（/scan/pick）与送检
// （/scan/inspect）两页共用。两页的 `shelf_id` 都是**工人当前所在的补料生产架**
// （PRODUCTION 区），取自 `useScanShelfStore`；拿不到就不该发请求。
//
// 为什么不把守卫留在各页里：错位报错（品检架当 `shelf_id` 发出去）与空值报错
// （省略 `shelf_id`）在两个后端契约里各有一处依据，放在一起才好让两页共用同一段
// 判定与同一套文案。
//
// 契约依据（backend-rust `docs/api/`，本仓规约：引 docs，不引源码符号）：
// - `docs/api/parts/lifecycle.md` 的 `POST /api/v2/prod/batches/{batch_id}/pick-up`：
//   `shelf_id` 必填，且要求「当前批次所在货架（zone=PRODUCTION 且 active）」；
// - `docs/api/parts/inspection.md` 的 `POST /api/v2/prod/batches/worker-scan`：
//   `shelf_id` 两个 event_type 同义，均要求 PRODUCTION 区（违反 → `20501`），
//   与 `event_type` 无关；
// - ⚠️ 两处的 `shelf_id` 缺省都**不是** `40001`：它是无 `#[serde(default)]` 的必填
//   `i64`，缺字段由 axum `Json` extractor 在 service 之前直接拒 ⇒ **裸 HTTP 422、
//   响应体不是项目统一 `R` 信封**（inspection.md 明写「非项目统一信封」）⇒ 本仓
//   `ApiError` 拿不到 code。**必须在发请求前拦**。

import { ElMessage } from 'element-plus';
import { useScanShelfStore } from '@/stores/scanShelf';

/**
 * 当前作业架是否可用于提交；不可用时返回给工人看的文案（可用返回 null）。
 *
 * **只读不弹提示**，供调用方自选提示级别与时机（提交前用
 * `resolveWorkingShelfId`；进页提示用本函数）。
 *
 * 调用前必须已 `await useScanShelfStore().initShelves()`：未加载时 `selectedShelfId`
 * 恒为 null，本函数会把「没加载」误报成「账号没绑货架」。
 */
export function workingShelfProblem(): string | null {
  const scanShelf = useScanShelfStore();
  if (!scanShelf.selectedShelfId) {
    const n = scanShelf.options.length;
    return n >= 2
      ? '本账号绑定了多个货架，无法确定当前作业货架，请联系管理员为本账号指定唯一作业货架'
      : '当前账号未绑定作业货架，请联系管理员在「账号管理」为本账号绑定生产货架';
  }
  if (scanShelf.selectedZone === 'INSPECTION') {
    // 文案不能说「请改选生产货架」：页面上没有选架入口，工人无处可改。只能陈述事实 +
    // 指管理员 —— 这也是 store 头注释里写明「多架 / 错绑都没有 UI 出路」的原因。
    return '本账号当前绑定的货架在品检区，缺少生产区作业货架，请联系管理员为本账号绑定生产货架';
  }
  if (scanShelf.selectedZone === null) {
    // zone 既不是 PRODUCTION 也不是 INSPECTION：既不能按「品检区」也不能按「生产区」
    // 下结论，更不能乐观放行（放行 = 把一个未验证的架当生产架发出去）。单列一条。
    return '无法识别当前货架所属区域，不能作为作业货架，请联系管理员核对本账号的货架绑定';
  }
  return null;
}

/**
 * 取当前作业架 id；不可用时弹错误提示并返回 null（调用点必须 return，不许带空
 * `shelf_id` 发请求）。
 *
 * 调用前必须已 `await useScanShelfStore().initShelves()`（同 `workingShelfProblem`）。
 */
export function resolveWorkingShelfId(): string | null {
  const problem = workingShelfProblem();
  if (problem) {
    ElMessage.error(problem);
    return null;
  }
  return useScanShelfStore().selectedShelfId;
}
