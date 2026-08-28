// composables/useBulkPassInspection.ts
//
// 批量品检通过 composable（2026-08-23 新增；2026-08-25 切 v2 批量端点；
//   2026-08-28 切 route B 批量端点 + item 改 batch_id-only）。
//
// 用途：
//   - 扫码建单页 / 送货单详情页的「批量通过品检」确认对话框共享本 composable。
//   - 2026-08-28 起：单次调用 apiV2.batchToShip（POST /parts/batch-to-ship），
//     路线 B 把 INSPECTION → READY_TO_SHIP 整批过品；per-item 失败走响应 data.failed[]。
//     后端无批量端点的 fallback 路径已下线（v2 端点是硬依赖）。
//
// 设计：
//   - BulkPassItem 用 batch_id 标识（不再依赖 part_id；后端 service 按 batch_id
//     反查 t_part_batch.part_id，无需前端重复带 part_id）。
//   - 部分失败语义：返回 { passed, failed }，由调用方决定是否继续后续动作
//     （如部分通过 → 调 submitNote 仅包通过的；或保留 dialog 让用户重试）。
//   - progress 字段供 UI 进度条使用；v2 单次调用语义下 done 总是一次跳到 total。

import { reactive, ref, type Ref } from 'vue'
import { ApiError } from '@/api/http'
import {
  batchToShip,
  type BatchToShipFailureFE,
  type BatchToShipItem,
  type BatchToShipOutFE,
} from '@/api/parts'

export interface BulkPassItem {
  /** 必填：batchToShip 入参的 batch id（雪花 ID 字符串）。 */
  batch_id: string
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
  /** 跑一次批量；v2 端点单次 round-trip，不控制并发。 */
  run: (
    items: BulkPassItem[],
    opts?: { concurrency?: number },
  ) => Promise<BulkPassResult>
}

/**
 * 纯函数：`BulkPassItem[] → BatchToShipItem[]`，剥掉展示用 `label`。
 *
 * 导出供单测（composables/useBulkPassInspection.spec.ts）覆盖；保持映射规则
 * 集中在一处，弹窗侧只关心 UI 类型。route B 下不再需要 part_id —— 后端 service
 * 按 batch_id 反查 t_part_batch.part_id。
 */
export function toBatchPassItems(items: BulkPassItem[]): BatchToShipItem[] {
  return items.map((it) => ({
    batch_id: it.batch_id,
    quantity: it.quantity ?? undefined,
  }))
}

/**
 * 纯函数：v2 batch-to-ship 响应 → composable 契约 BulkPassResult。
 *
 * 规则：
 *   - `passed[]`：按响应 submitted[].batch_id（入参 batch_id）反向找回原始 BulkPassItem
 *     （保留 label，方便父组件 toast 时定位）。后端 service 处理顺序与请求 items 一致。
 *   - `failed[]`：后端 failed 按 batch_id 找到原始 item 包成 BulkPassFailure。
 *
 * 复杂度 O(N²)（findIndex / find 在 N≤200 时可忽略）；保持纯函数，不依赖 axios 实例。
 */
export function mapBatchResult(
  requested: BulkPassItem[],
  result: BatchToShipOutFE,
): BulkPassResult {
  const passed: BulkPassItem[] = []
  for (const s of result.submitted) {
    const idx = requested.findIndex((it) => it.batch_id === s.batch_id)
    if (idx >= 0) {
      passed.push(requested[idx])
    } else {
      // 理论上不会发生（后端不会凭空返回不在请求里的 batch_id）；防御：构造一个
      // 无 label 的最小 item，避免 UI 渲染 undefined。
      passed.push({ batch_id: s.batch_id })
    }
  }
  const failed: BulkPassFailure[] = result.failed.map((f: BatchToShipFailureFE) => {
    const original =
      requested.find((it) => it.batch_id === f.batch_id) ?? { batch_id: f.batch_id }
    return {
      item: original,
      code: f.code,
      message: f.message,
    }
  })
  return { passed, failed }
}

export function useBulkPassInspection(): UseBulkPassInspectionReturn {
  const running = ref(false)
  const progress = reactive<BulkPassProgress>({ done: 0, total: 0 })

  async function run(
    items: BulkPassItem[],
    _opts: { concurrency?: number } = {},
  ): Promise<BulkPassResult> {
    // concurrency 参数已无意义（v2 端点 N≤200 顺序处理）；保留入参兼容旧调用方。
    void _opts
    running.value = true
    progress.total = items.length
    progress.done = 0

    try {
      const out = await batchToShip({ items: toBatchPassItems(items) })
      // 单次 round-trip 语义：done 一次跳到 total。保留 progress 字段便于未来
      // 扩展（如后端拆批/流式返回时回填分阶段进度）。
      progress.done = items.length
      return mapBatchResult(items, out)
    } catch (e) {
      // 端点级错误（VALIDATION_ERROR / FORBIDDEN 等）：把请求 items 全部标为
      // 失败抛回，弹窗走 part-partial / 全失败兜底分支。
      const err = e as ApiError
      progress.done = items.length
      return {
        passed: [],
        failed: items.map((item) => ({
          item,
          code: err?.code ?? 0,
          message: err?.message ?? '未知错误',
        })),
      }
    } finally {
      running.value = false
    }
  }

  return { running, progress, run }
}