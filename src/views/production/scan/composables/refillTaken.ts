// 2026-10-05 新增：worker-scan 响应的 `refill` 段 → 补料弹窗要吃的 `taken[]`。
//
// `POST /prod/scan/worker-scan` 与扫码写入同事务跑一次 `WorkerPoolService::refill_for_worker`，抢到几批
// 由工种 `max_held_batches` 与池深决定，工人无从预判 ⇒ 抢到非空时必须主动告知
// （见 `RefillTakenDialog.vue`）。
//
// 为什么单独收一个函数而不是两页各写 `res?.refill?.taken`：
//   - `taken` 为空是**正常形态**（池空 / 已持满），不是异常，空数组即「不弹窗」；
//   - 单测里该端点是 `vi.fn()` 且不少用例 resolve `undefined`（页面测试的桩不带
//     返回体），把「响应可能整个不存在」这一层收在这里，两页只判 `length`，
//     不用各自写一遍可选链。

import type { TakenItemDto } from '@/api/productionQueue.contract';
import type { ScanWorkerResultDto } from '@/api/productionScan.contract';

/** 取 refill 抢到的批次；响应缺 `refill` / `taken` 一律归一成空数组。 */
export function refillTakenOf(res: ScanWorkerResultDto | null | undefined): TakenItemDto[] {
  return res?.refill?.taken ?? [];
}
