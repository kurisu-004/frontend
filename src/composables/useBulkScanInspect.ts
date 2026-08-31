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
import type { ScanUnresolvedTarget } from '@/types/deliveryNote'

export interface BulkScanItem {
  /** 必填：batchToInspection 入参的 batch id（雪花 ID 字符串）。 */
  batch_id: string
  /** 必填；2026-08-29：t_part_batch.version，caller OCC 锚定。 */
  version: number
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
 * 纯函数：从 ScanUnresolvedTarget[] 与 selectedBatchIds 派生 BulkScanItem[]。
 *
 * 用途（2026-08-31 路线 B 候选批次勾选送检）：
 *   - DeliveryScanCandidateDialog 的 el-table 加 type="selection" 后，用户在
 *     弹窗里勾选要送检的批次；本函数按勾选集合派生 useBulkScanInspect().run()
 *     要的 items[]，剥掉 UI 展示用的标识、保留 batch_id/version/quantity。
 *   - 顺序：targets 外层 for × available_batches 内层 for，保证与 dialog 内
 *     flatBatches（同一派生顺序）的下标一致；与 toBatchScanItems 链路衔接。
 *
 * 复杂度 O(N)（N = targets × batches 总数）；纯函数，无副作用，不依赖 axios。
 *
 * @param targets 路线 B 未送检工单列表（含 available_batches）。
 * @param selectedBatchIds 用户在弹窗里勾选的批次 id 集合；未命中则忽略。
 */
export function buildSelectedScanItems(
  targets: ScanUnresolvedTarget[],
  selectedBatchIds: ReadonlySet<string>,
): BulkScanItem[] {
  const items: BulkScanItem[] = []
  for (const t of targets) {
    for (const b of t.available_batches) {
      if (!selectedBatchIds.has(b.batch_id)) continue
      items.push({
        batch_id: b.batch_id,
        version: b.version,
        quantity: b.quantity,
        label: `${t.serial_no} / 批 ${b.batch_id}`,
      })
    }
  }
  return items
}

/**
 * 纯函数：`BulkScanItem[] → BatchToInspectionItem[]`，剥掉展示用 `label`。
 *
 * route B 不再带 part_id —— 后端 service 按 batch_id 反查 t_part_batch.part_id；
 * 路线 B inspection 不支持 FAIL，decision / shelf_id / next_process_id / note 字段
 * 整体移除（后端不再接受）。
 * 2026-08-29：透传 version（caller OCC 锚 t_part_batch）。
 */
export function toBatchScanItems(items: BulkScanItem[]): BatchToInspectionItem[] {
  return items.map((it) => ({
    batch_id: it.batch_id,
    version: it.version,
    quantity: it.quantity ?? undefined,
  }))
}

/**
 * 纯函数：v2 batch-to-inspection 响应 → composable 契约 BulkScanResult。
 *
 * 规则（2026-08-28 修正为按位置反查）：
 *   - `submitted[]`：后端 `ToXxxOut` **不序列化 batch_id**（只有 `part` + `new_batch_id`，
 *     见 inspection.md「ToXxxOut 字段」表），原先按 `s.batch_id` 反查恒为 undefined。
 *     改按位置对齐：后端顺序处理 items，`submitted[]` 与「请求 items 扣掉 failed[] 之后
 *     的剩余项」逐位一一对应（保留 label，方便父组件 toast 时定位）。
 *   - **不能直接用 `requested[i]`**：有 per-item 失败时 submitted 下标整体前移，
 *     会把失败项误当成送检成功（例：请求 [B1,B2,B3] + B2 失败 → submitted[1] 是 B3 的
 *     结果，而 requested[1] 是 B2）。所以先用 failed[].batch_id 扣掉失败项再逐位取。
 *   - `failed[]`：后端 failed **仍带 batch_id**，按 batch_id 找回原始 item。
 *
 * 复杂度 O(N)（failed 建 Set）；保持纯函数，不依赖 axios 实例。
 */
export function mapScanBatchResult(
  requested: BulkScanItem[],
  result: BatchToInspectionOutFE,
): BulkScanResult {
  const failedIds = new Set(result.failed.map((f) => f.batch_id))
  // 请求里未出现在 failed[] 的项，按原顺序排列 —— 与 submitted[] 逐位对应。
  const candidates = requested.filter((it) => !failedIds.has(it.batch_id))

  const submitted: BulkScanItem[] = []
  for (let i = 0; i < result.submitted.length; i++) {
    const original = candidates[i]
    if (original) {
      submitted.push(original)
    } else {
      // 防御：submitted 比「请求扣掉 failed」还长（后端契约被破坏才会发生）。
      // 拿不到原始 item，退化用 part 投影占位，避免 UI 渲染 undefined；
      // 此处 batch_id 位塞的是 part.id（并非真批次 id），仅为占位不参与后续请求。
      // 2026-08-29：version 也是占位（0），仅满足类型约束。
      const s = result.submitted[i]
      submitted.push({
        batch_id: s.part.id,
        version: 0,
        label: s.part.serial_no ?? undefined,
      })
    }
  }
  const failed: BulkScanFailure[] = result.failed.map(
    (f: BatchToInspectionFailureFE) => {
      const original =
        requested.find((it) => it.batch_id === f.batch_id) ??
        // 2026-08-29：找不到原 item 时退化占位补 version（仅满足类型）。
        { batch_id: f.batch_id, version: 0 }
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