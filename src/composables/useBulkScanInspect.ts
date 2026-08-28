// composables/useBulkScanInspect.ts
//
// 批量一键送检 composable（2026-08-25 新增；2026-08-28 切 route B + item 改 batch_id-only）。
//
// 用途：
//   - 扫码建单页「批量一键送检」确认对话框（BatchSubmitInspectionConfirmDialog）共享本 composable。
//   - 单次调用 apiV2.batchToInspection（POST /parts/batch-to-inspection），共享品检架 +
//     per-item 数量；route B 把 PENDING/PROGRAMMING/IN_PROCESS → INSPECTION。
//   - 1 次 round-trip，per-item 失败走响应 data.failed[]。
//
// 设计：
//   - 镜像 useBulkPassInspection 的契约与字段命名（BulkScanItem / BulkScanFailure /
//     BulkScanResult / BulkScanProgress），让两个弹窗的 onConfirm 形态对称。
//   - route B inspection 不支持 FAIL 分支：BulkScanItem 移除 decision / shelf_id /
//         next_process_id / note（前端 UI 默认全 PASS，后端 route B 不接受 FAIL 入参）。
//   - 部分失败语义：返回 { submitted, failed }，由调用方决定后续动作
//     （如 submit-success / submit-partial 事件分流）。
//   - progress 字段供 UI 进度条使用；v2 单次调用语义下 done 一次跳到 total。

import { reactive, ref, type Ref } from 'vue'
import { ApiError } from '@/api/http'
import {
  batchToInspection,
  type BatchToInspectionFailureFE,
  type BatchToInspectionItem,
  type BatchToInspectionOutFE,
} from '@/api/parts'

export interface BulkScanItem {
  /** 必填：batchToInspection 入参的 batch id（雪花 ID 字符串）。 */
  batch_id: string
  /** 可选；部分数量；缺省 = 批次全量。 */
  quantity?: number | null
  /** 展示用（不影响 API 调用）：如 serial_no + name，方便失败 toast 时定位。 */
  label?: string
}

export interface BulkScanFailure {
  item: BulkScanItem
  code: number
  message: string
}

export interface BulkScanResult {
  submitted: BulkScanItem[]
  failed: BulkScanFailure[]
}

export interface BulkScanProgress {
  done: number
  total: number
}

export interface UseBulkScanInspectReturn {
  running: Ref<boolean>
  progress: BulkScanProgress
  /** 跑一次批量；v2 端点单次 round-trip，不控制并发。 */
  run: (
    req: { target_inspection_shelf_id: string; items: BulkScanItem[] },
  ) => Promise<BulkScanResult>
}

/**
 * 纯函数：`BulkScanItem[] → BatchToInspectionItem[]`，剥掉展示用 `label`。
 *
 * route B 不再带 part_id —— 后端 service 按 batch_id 反查 t_part_batch.part_id；
 * 路线 B inspection 不支持 FAIL，decision / shelf_id / next_process_id / note 字段
 * 整体移除（后端不再接受）。
 */
export function toBatchScanItems(items: BulkScanItem[]): BatchToInspectionItem[] {
  return items.map((it) => ({
    batch_id: it.batch_id,
    quantity: it.quantity ?? undefined,
  }))
}

/**
 * 纯函数：v2 batch-to-inspection 响应 → composable 契约 BulkScanResult。
 *
 * 规则：
 *   - `submitted[]`：按响应 submitted[].batch_id（入参 batch_id）反向找回原始 BulkScanItem
 *     （保留 label，方便父组件 toast 时定位）。后端 service 处理顺序与请求 items 一致。
 *   - `failed[]`：后端 failed 按 batch_id 找到原始 item 包成 BulkScanFailure。
 *
 * 复杂度 O(N²)（findIndex / find 在 N≤200 时可忽略）；保持纯函数，不依赖 axios 实例。
 */
export function mapScanBatchResult(
  requested: BulkScanItem[],
  result: BatchToInspectionOutFE,
): BulkScanResult {
  const submitted: BulkScanItem[] = []
  for (const s of result.submitted) {
    const idx = requested.findIndex((it) => it.batch_id === s.batch_id)
    if (idx >= 0) {
      submitted.push(requested[idx])
    } else {
      // 理论上不会发生（后端不会凭空返回不在请求里的 batch_id）；防御：构造无 label 最小 item
      submitted.push({ batch_id: s.batch_id })
    }
  }
  const failed: BulkScanFailure[] = result.failed.map(
    (f: BatchToInspectionFailureFE) => {
      const original =
        requested.find((it) => it.batch_id === f.batch_id) ?? { batch_id: f.batch_id }
      return {
        item: original,
        code: f.code,
        message: f.message,
      }
    },
  )
  return { submitted, failed }
}

export function useBulkScanInspect(): UseBulkScanInspectReturn {
  const running = ref(false)
  const progress = reactive<BulkScanProgress>({ done: 0, total: 0 })

  async function run(
    req: { target_inspection_shelf_id: string; items: BulkScanItem[] },
  ): Promise<BulkScanResult> {
    running.value = true
    progress.total = req.items.length
    progress.done = 0

    try {
      const out = await batchToInspection({
        target_inspection_shelf_id: req.target_inspection_shelf_id,
        items: toBatchScanItems(req.items),
      })
      // 单次 round-trip 语义：done 一次跳到 total
      progress.done = req.items.length
      return mapScanBatchResult(req.items, out)
    } catch (e) {
      // 端点级错误（VALIDATION_ERROR / FORBIDDEN 等）：把请求 items 全部标为失败
      // 抛回，弹窗走 submit-partial / 全失败兜底分支
      const err = e as ApiError
      progress.done = req.items.length
      return {
        submitted: [],
        failed: req.items.map((item) => ({
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