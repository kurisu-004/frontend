// composables/useBulkScanInspect.ts
//
// 批量一键送检 composable（2026-08-25 新增；与 useBulkPassInspection 形态对称）。
//
// 用途：
//   - 扫码建单页「批量一键送检」确认对话框（BatchSubmitInspectionConfirmDialog）共享本 composable。
//   - 单次调用 apiV2.batchScanInspect（POST /parts/batch-scan-inspect），共享品检架 +
//     per-item decision（缺省 PASS）+ per-item 数量。
//   - 1 次 round-trip，per-item 失败走响应 data.failed[]。
//
// 设计：
//   - 镜像 useBulkPassInspection 的契约与字段命名（BulkScanItem / BulkScanFailure /
//     BulkScanResult / BulkScanProgress），让两个弹窗的 onConfirm 形态对称。
//   - 部分失败语义：返回 { submitted, failed }，由调用方决定后续动作
//     （如 submit-success / submit-partial 事件分流）。
//   - progress 字段供 UI 进度条使用；v2 单次调用语义下 done 一次跳到 total。
//   - 申请见 docs/api-requirements/scan-inspect.md

import { reactive, ref, type Ref } from 'vue'
import { ApiError } from '@/api/http'
import {
  batchScanInspect,
  type BatchScanInspectFailureFE,
  type BatchScanInspectItemFE,
  type BatchScanInspectOutFE,
} from '@/api/parts'

export interface BulkScanItem {
  /** 必填：batchScanInspect 入参的 part id（雪花 ID 字符串）。 */
  part_id: string
  /** 可选；PASS / FAIL，缺省 PASS。前端 UI 默认全 PASS（送检 = 搬上 INSPECTION + 一次性通过）。 */
  decision?: 'PASS' | 'FAIL' | null
  /** FAIL 必填；目标生产货架 id（PRODUCTION zone active）。 */
  shelf_id?: string | null
  /** FAIL 必填；下一道工序 id。 */
  next_process_id?: string | null
  /** 可选；≤ 500 字符。 */
  note?: string | null
  /** 可选；目标批次 id；缺省按状态唯一批次解析。 */
  batch_id?: string | null
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
 * 纯函数：`BulkScanItem[] → BatchScanInspectItemFE[]`，剥掉展示用 `label`。
 *
 * `shelf_id` / `next_process_id` / `note` 维持原 null/undefined 语义（FAIL 路径才会用到，
 * 前端 UI 默认全 PASS 时这三个字段都是 null/undefined；后端 model_validator 拦截 FAIL 缺字段）。
 */
export function toBatchScanItems(items: BulkScanItem[]): BatchScanInspectItemFE[] {
  return items.map((it) => ({
    part_id: it.part_id,
    decision: it.decision ?? null,
    shelf_id: it.shelf_id ?? null,
    next_process_id: it.next_process_id ?? null,
    note: it.note ?? null,
    batch_id: it.batch_id ?? null,
    quantity: it.quantity ?? null,
  }))
}

/**
 * 纯函数：v2 端点响应 → composable 契约 BulkScanResult。
 *
 * 规则：
 *   - `submitted[]`：按 part_id 反向找回原始 BulkScanItem（保留 label，方便父组件
 *     toast 时定位）；后端 submitted 顺序与请求 items 顺序一致，用 indexOf 重新对齐。
 *   - `failed[]`：按 part_id 找到原始 item 包成 BulkScanFailure。
 *
 * 复杂度 O(N²)（indexOf 在 N≤200 时可忽略）；保持纯函数，不依赖 axios 实例。
 */
export function mapScanBatchResult(
  requested: BulkScanItem[],
  result: BatchScanInspectOutFE,
): BulkScanResult {
  const submitted: BulkScanItem[] = []
  for (const part of result.submitted) {
    const idx = requested.findIndex((it) => it.part_id === part.id)
    if (idx >= 0) {
      submitted.push(requested[idx])
    } else {
      // 理论上不会发生（后端不会凭空返回不在请求里的 part）；防御：构造无 label 最小 item
      submitted.push({ part_id: part.id })
    }
  }
  const failed: BulkScanFailure[] = result.failed.map(
    (f: BatchScanInspectFailureFE) => {
      const original =
        requested.find((it) => it.part_id === f.part_id) ?? { part_id: f.part_id }
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
      const out = await batchScanInspect({
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