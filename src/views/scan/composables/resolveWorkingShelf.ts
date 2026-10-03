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
//   ⚠️ service 只校验「存在 + active + zone 相等」三件事，**不**与批次的
//   `current_holder_id` 对账 —— 传一个同区但没有这批件的架，后端照样放行。所以这里的
//   `shelf_id` 只能由前端尽量取对，没有服务端替身兜底。
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
 * 只覆盖「一定会提交失败 / 会拿错架发出去」的三种状态：多架未选、选中品检架、zone 未解析。
 * 「不该拦、但该让工人知道」的状态（多架沿用上次会话的架）走 `workingShelfNotice`。
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
    // 下结论，更不能乐观放行（放行 = 把一个未验证的架当生产架发出去）。两种成因在
    // `selectedZone` 上不可区分：后端真返了一个未知 zone，或货架端点失败 / 不全导致
    // store 兜底填了 UNKNOWN（见 store 的 initShelves）。单列一条。
    return '无法识别当前货架所属区域，不能作为作业货架，请联系管理员核对本账号的货架绑定';
  }
  return null;
}

/**
 * 「不该拦、但该让工人知道」的一条提示；没有则返回 null。
 *
 * 场景：多架账号沿用了 sessionStorage 里上次会话落盘的架。零件列表是**跨架**的，
 * 工人完全可能站在另一个架上作业，而系统无从判断对错（页面上没有选架入口，拦下就是
 * 死路）⇒ 只提示，不拦。单架账号的自动选不产生本提示（那是唯一确定的选择，逐次提示
 * 只会变成噪音）。
 *
 * **只读不弹提示**，与 `workingShelfProblem` 同一约定。
 */
export function workingShelfNotice(): string | null {
  const scanShelf = useScanShelfStore();
  // 有阻断问题时不必再叠提示：那条已经把操作拦住了。
  if (workingShelfProblem()) return null;
  if (!scanShelf.restoredFromSession) return null;
  const code = scanShelf.options.find((o) => o.id === scanShelf.selectedShelfId)?.code;
  return `当前作业货架沿用上次会话的 ${code ?? scanShelf.selectedShelfId}，如需更换请联系管理员`;
}

/**
 * 取当前作业架 id；不可用时弹错误提示并返回 null（调用点必须 return，不许带空
 * `shelf_id` 发请求）。可用但命中 `workingShelfNotice` 的状态弹 warning 后照常返回 id。
 *
 * 两种提示的重复策略不同：error 是「这次提交被拦」⇒ 每次都弹；warning 是「工人该知情」
 * ⇒ 同一份候选集内只弹一次（避免一次提交流程弹两条，见下方 notice 去重注释）。
 *
 * 调用前必须已 `await useScanShelfStore().initShelves()`（同 `workingShelfProblem`）。
 */
export function resolveWorkingShelfId(): string | null {
  const scanShelf = useScanShelfStore();
  const problem = workingShelfProblem();
  if (problem) {
    ElMessage.error(problem);
    return null;
  }
  const notice = workingShelfNotice();
  // 2026-10-04：一条提交流程要过本函数两遍（取件页「扫码选中」+「提交确认」，送检页
  // 「扫码选中」+「提交」），提示不按候选集去重就是同一次操作弹两条一模一样的 warning。
  // 去重状态住在 store 上（`markNoticeShown`），随 markLoaded 复位 ⇒ 换账号 / 换绑定 /
  // 强制重载后会重新提示一次（同一份候选集内只提示一次，不随每件零件刷屏）。
  if (notice && !scanShelf.noticeShown) {
    scanShelf.markNoticeShown();
    ElMessage.warning(notice);
  }
  return scanShelf.selectedShelfId;
}
