// composables/useBulkPassInspection.ts
//
// 批量品检通过 composable（2026-08-23 新增）。
//
// 用途：
//   - 扫码建单页 / 送货单详情页的「批量通过品检」确认对话框共享本 composable。
//   - 复用 src/api/parts.ts 的 passInspection（单件），前端并发 worker pool
//     聚合结果。后端无批量端点时这是唯一可行路径。
//
// 设计：
//   - concurrency 默认 4（避免压垮后端）；调用方可传更高 / 更低。
//   - 部分失败语义：返回 { passed, failed }，由调用方决定是否继续后续动作
//     （如部分通过 → 调 submitNote 仅包通过的；或保留 dialog 让用户重试）。
//   - progress 字段供 UI 进度条使用。

import { reactive, ref, type Ref } from 'vue'
import { ApiError } from '@/api/http'
import { passInspection } from '@/api/parts'

export interface BulkPassItem {
  /** 必填：passInspection 入参的 part id（雪花 ID 字符串；与 BatchActionPayload.batch_id 同源）。 */
  part_id: string
  /** 可选：passInspection 的 BatchActionPayload.batch_id（雪花 ID 字符串）。 */
  batch_id?: string | null
  /** 可选：部分通过数量；缺省 = 全量。 */
  quantity?: number | null
  /** 展示用（不影响 API 调用）：如 serial_no + name，方便失败 toast 时定位。 */
  label?: string
}

export interface BulkPassFailure {
  item: BulkPassItem
  code: number
  message: string
}

export interface BulkPassResult {
  passed: BulkPassItem[]
  failed: BulkPassFailure[]
}

export interface BulkPassProgress {
  done: number
  total: number
}

export interface UseBulkPassInspectionReturn {
  running: Ref<boolean>
  progress: BulkPassProgress
  /** 跑一次批量；并发由内部 worker pool 控制。 */
  run: (
    items: BulkPassItem[],
    opts?: { concurrency?: number },
  ) => Promise<BulkPassResult>
}

export function useBulkPassInspection(): UseBulkPassInspectionReturn {
  const running = ref(false)
  const progress = reactive<BulkPassProgress>({ done: 0, total: 0 })

  async function run(
    items: BulkPassItem[],
    opts: { concurrency?: number } = {},
  ): Promise<BulkPassResult> {
    const concurrency = Math.max(1, opts.concurrency ?? 4)
    running.value = true
    progress.total = items.length
    progress.done = 0

    const passed: BulkPassItem[] = []
    const failed: BulkPassFailure[] = []
    const queue = [...items]

    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()!
        try {
          await passInspection(item.part_id, {
            batch_id: item.batch_id,
            quantity: item.quantity,
          })
          passed.push(item)
        } catch (e) {
          const err = e as ApiError
          failed.push({
            item,
            code: err?.code ?? 0,
            message: err?.message ?? '未知错误',
          })
        } finally {
          progress.done += 1
        }
      }
    })
    await Promise.all(workers)

    running.value = false
    return { passed, failed }
  }

  return { running, progress, run }
}
