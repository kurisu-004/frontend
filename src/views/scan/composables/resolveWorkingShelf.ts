// views/scan/composables/resolveWorkingShelf.ts
//
// 2026-10-04 新增：报工台「当前作业架」的前置守卫，供取件（/scan/pick）与送检
// （/scan/inspect）两页共用。两页的 `shelf_id` 都是**工人当前所在的补料生产架**
// （PRODUCTION 区），取自 `useScanShelfStore`；拿不到就不该发请求。
//
// 为什么不把守卫留在各页里：错位报错（送检把品检架当 `shelf_id` 发出去得 20501）与
// 空值报错（省略 `shelf_id` 得 422）在两个后端契约里各有一处依据，放在一起才好让
// 两页共用同一段判定与同一套文案。
//
// 依据（backend-rust）：
// - `POST /prod/batches/pick-up`：`validate_shelf_zone(..., "PRODUCTION")`；
// - `POST /prod/batches/worker-scan`：开头无条件 `get_by_id_zone(shelf_id, "PRODUCTION")`
//   —— 与 `event_type` 无关，两个分支都要求 PRODUCTION；
// - `shelf_id` 是无 default 的必填 `i64`，省略 → 40001 VALIDATION_ERROR（HTTP 422）。

import { ElMessage } from 'element-plus';
import { useScanShelfStore } from '@/stores/scanShelf';

/**
 * 取当前作业架 id；不可用时弹错误提示并返回 null（调用点必须 return，不许带空
 * `shelf_id` 发请求）。
 *
 * 调用前必须已 `await useScanShelfStore().initShelves()`：未加载时 `selectedShelfId`
 * 恒为 null，本函数会把「没加载」误报成「账号没绑货架」。
 */
export function resolveWorkingShelfId(): string | null {
  const scanShelf = useScanShelfStore();
  const id = scanShelf.selectedShelfId;
  if (!id) {
    ElMessage.error(missingHint(scanShelf.options.length));
    return null;
  }
  // 选中的架在品检区：它只能是送检的**目标**架，当作业架发出去后端必返 20501。
  if (scanShelf.selectedZone !== 'PRODUCTION') {
    ElMessage.error('当前选中的货架在品检区，不能作为作业货架，请改选生产货架');
    return null;
  }
  return id;
}

/** 没选出作业架时按成因给不同文案（两种成因的下一步动作不同）。 */
function missingHint(candidateCount: number): string {
  if (candidateCount >= 2) {
    return '本账号绑定了多个货架，无法确定当前作业货架，请联系管理员为本账号指定唯一作业货架';
  }
  return '当前账号未绑定作业货架，请联系管理员在「账号管理」为本账号绑定生产货架';
}
