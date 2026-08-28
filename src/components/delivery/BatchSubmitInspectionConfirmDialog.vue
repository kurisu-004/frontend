<!--
  批量一键送检确认对话框（2026-08-25 新增；2026-08-26 合并 INSPECTION 行的处理；
  2026-08-28 切 route B + items 改 batch_id-only）。

  用途：扫码建单页遇到 21421（B 组状态短路）时弹本对话框；dialog 内部按
  failures[].status 拆两批：
  - status ∈ {PENDING, PROGRAMMING, IN_PROCESS} → 第一批调 useBulkScanInspect
    走 batchToInspection（PENDING/PROGRAMMING/IN_PROCESS → INSPECTION）
  - status === 'INSPECTION' → 用户勾选「同时过检此件」后第二批调 useBulkPassInspection
    走 batchToShip（INSPECTION → READY_TO_SHIP）

  用户选一个品检架（共享）+ 调整每件数量 → 一键调 apiV2 批量端点。品检员/
  管理员确认后把生产中的工件搬上品检架，submit-success 时父组件用 originalCode 重扫。

  设计要点：
  - 弹窗结构 + submit-success / submit-partial 两态分流（route B 全失败仅 ElMessage.error，不再 emit）。
  - 顶部加品检架 el-select（共享架，必填；confirm disabled when 没选）。
  - 表格列：serial_no · drawing_no · 状态 chip · 数量（el-input-number）。
    数量默认 = 该件全量（与 batchToShip / batchToInspection 范式一致）。
  - 「同时过检此件」列：仅 status==='INSPECTION' 的行启用；勾选后弹窗
    onConfirm 拆成两批：先送检未送检的，再过检已送检的。
  - 2026-08-28 路线 B 改造：items 字段收敛为 batch_id + quantity + label；
    route B inspection 不支持 FAIL，第一批 items 不再带 decision / shelf_id /
    next_process_id / note。

  申请见 docs/api-requirements/scan-inspect.md。
-->
<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { ElMessage, ElTag } from 'element-plus'
import { Upload } from '@element-plus/icons-vue'

import { useDialogSize } from '@/composables/useDialogSize'
import { useBulkScanInspect } from '@/composables/useBulkScanInspect'
import type { BulkScanFailure, BulkScanItem } from '@/composables/useBulkScanInspect'
import { useBulkPassInspection } from '@/composables/useBulkPassInspection'
import type { BulkPassItem } from '@/composables/useBulkPassInspection'
import { listShelves } from '@/api/shelves'
import type { Shelf } from '@/types/shelf'
import type { BlockedScanItem } from '@/types/deliveryNote'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'

interface Props {
  /** v-model 显隐 */
  modelValue: boolean
  /** 待送检件列表（父组件应已剔除 'on note DN-XXX' 冲突项，且仅保留 status ∈ {PENDING, PROGRAMMING, IN_PROCESS}） */
  failures: BlockedScanItem[]
  /** 后端 message，作为弹窗副标题展示 */
  reason: string
  /** 扫码时缓存的 code，emit submit-success 时父组件用它重扫 */
  originalCode: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 全部送检成功 → 父组件重扫 originalCode */
  (e: 'submit-success'): void
  /** 部分送检 → 父组件 toast + 保留弹窗 */
  (e: 'submit-partial', result: { passed: BlockedScanItem[]; failed: BulkScanFailure[] }): void
  /** 用户点取消 */
  (e: 'cancel'): void
}>()

const dlg = useDialogSize({ desktopWidth: 920 })
const bulk = useBulkScanInspect()
// 2026-08-28 路线 B 改造：第二批「同时过检此件」走 useBulkPassInspection.batchToShip。
const passBulk = useBulkPassInspection()

// 2026-08-27 Task 8：列顺序拖动 + 可见性。
// 「送检数量」(el-input-number + 受控 v-model) 和「同时过检」(条件 ElCheckbox + v-if)
// 不进 defs，保留为字面量列。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const tableRef = ref()
const columnDefs: ColumnDef[] = [
  { key: 'serial_no', label: '序列号', prop: 'serial_no', minWidth: 100, align: 'center' },
  {
    key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 100, align: 'center',
    cellRender: ({ row }) => h('span',
      { class: { muted: !(row as BlockedScanItem).drawing_no } },
      (row as BlockedScanItem).drawing_no || '—'),
  },
  { key: 'name', label: '名称', prop: 'name', minWidth: 110, showOverflowTooltip: true, align: 'center' },
  {
    key: 'status', label: '状态', width: 100, align: 'center',
    cellRender: ({ row }) => {
      const r = row as BlockedScanItem
      // cellRender 必须返回单个 VNode；空状态回落 —。
      if (!r.status) return h('span', { class: 'muted' }, '—')
      return h(ElTag,
        { type: r.status === 'INSPECTION' ? 'warning' : 'primary', effect: 'light', size: 'small' },
        () => r.status as string)
    },
  },
  {
    key: 'reason', label: '原因', minWidth: 120, showOverflowTooltip: true,
    cellRender: ({ row }) => {
      const reason = (row as BlockedScanItem).reason ?? ''
      return h('span', { title: reason },
        reason.length > 24 ? `${reason.slice(0, 24)}…` : reason)
    },
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'batch_submit_inspection_confirm' })
const drag = useColumnDrag(columnDefs, { listKey: 'batch_submit_inspection_confirm' })

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
drag.applyDrag(tableRef)

// ============ 品检架候选 ============
// 扫码建单角色（CLERK / MANAGER / INSPECTOR）没有 SHELF_ACCOUNT 货架绑定，
// 因此本对话框直接拉全场 INSPECTION active 货架让用户选一个。
const shelves = ref<Shelf[]>([])
const selectedShelfId = ref<string | null>(null)
const shelvesLoading = ref(false)
const shelvesError = ref<string | null>(null)

async function loadShelves(): Promise<void> {
  shelvesLoading.value = true
  shelvesError.value = null
  try {
    const result = await listShelves({ zone: 'INSPECTION', is_active: true })
    shelves.value = result.items
  } catch (e) {
    shelvesError.value = (e as Error)?.message ?? '加载品检架失败'
    shelves.value = []
  } finally {
    shelvesLoading.value = false
  }
}

onMounted(() => {
  void loadShelves()
})

// ============ 副标题：去掉"失败明细：..."之后的部分（明细已在表格）============
const shortReason = computed(() => {
  const r = props.reason ?? ''
  const cut = r.split(/失败明细[:：]/)[0].trim()
  return cut || r
})

// ============ per-row 数量（默认 = 该件 quantity）============
const rowQuantities = ref<Record<string, number | null>>({})
// 返回该行用户调过的数量；未调过返回 null（提交时 fallback 到 row.quantity 全量）。
// 防御：part_id 可能为 undefined（21405 散件），返回 null 不参与索引。
function getQuantity(row: BlockedScanItem): number | null {
  if (!row.part_id) return null
  return row.part_id in rowQuantities.value
    ? rowQuantities.value[row.part_id] ?? null
    : null
}
function setQuantity(row: BlockedScanItem, val: number | null): void {
  if (!row.part_id) return
  rowQuantities.value = { ...rowQuantities.value, [row.part_id]: val }
}

// ============ 兼过检勾选（仅 status==='INSPECTION' 的行启用）============
// 设计说明：扫码建单 21418 失败明细里可能同时含 IN_PROCESS 子件 + 已 INSPECTION 子件
// （典型场景：装配件混合状态）。本对话框默认只处理 status ∈ {PENDING/PROGRAMMING/IN_PROCESS}
// 的"未送检"行；用户在表格里勾选"同时帮它过检"，则确认时拆成两批调用。
const checkedAlsoPass = ref<Set<string>>(new Set())
function toggleAlsoPass(partId: string): void {
  const next = new Set(checkedAlsoPass.value)
  if (next.has(partId)) next.delete(partId)
  else next.add(partId)
  checkedAlsoPass.value = next
}

const inspectableFailures = computed(() =>
  props.failures.filter(
    (f) =>
      f.status === 'PENDING' ||
      f.status === 'PROGRAMMING' ||
      f.status === 'IN_PROCESS',
  ),
)
const passableFailures = computed(() =>
  props.failures.filter((f) => f.status === 'INSPECTION'),
)

// ============ 可用条件 ============
// - 至少一个"待送检"行（inspectableFailures 非空）
// - 所有 failure 都有 part_id（21405 散件 message 解析出的占位 item 没有 part_id）
// - 已选品检架
const canBulkSubmit = computed(
  () =>
    inspectableFailures.value.length > 0 &&
    selectedShelfId.value !== null &&
    selectedShelfId.value.length > 0 &&
    props.failures.every(
      (f) => typeof f.part_id === 'string' && f.part_id.length > 0,
    ),
)

const disabledTooltip = computed(() => {
  if (shelvesError.value) return `品检架加载失败：${shelvesError.value}`
  if (!selectedShelfId.value) return '请先选择品检架'
  if (inspectableFailures.value.length === 0) {
    return '列表中没有可送检的件（status ∉ {PENDING, PROGRAMMING, IN_PROCESS}）'
  }
  return ''
})

// ============ actions ============

function onCancel(): void {
  emit('update:modelValue', false)
  emit('cancel')
}

// 关闭弹窗的统一入口（submit-success / partial 都用）
function closeDialog(): void {
  emit('update:modelValue', false)
}

// BlockedScanItem[] → BulkScanItem[]
// 2026-08-28 路线 B 改造：仅含 batch_id + quantity + label，移除 part_id / decision /
// shelf_id / next_process_id / note（route B inspection 不支持 FAIL）。
// 缺少 batch_id 的行（21405 散件 message 解析出的占位 item）直接过滤，避免
// 后端 INVALID_VALUE 兜底分支；UI 层仍显示这些行，由用户用其他途径处理。
function toBulkScanItems(rows: BlockedScanItem[]): BulkScanItem[] {
  return rows.flatMap((f) => {
    if (!f.batch_id) return []
    const q = getQuantity(f)
    return [{
      batch_id: f.batch_id,
      quantity: q ?? null,
      label: `${f.serial_no} · ${f.name}`,
    }]
  })
}

// 2026-08-28 路线 B 改造：第二批走 useBulkPassInspection（batchToShip），
// 同样只带 batch_id + quantity + label。
function toBulkPassItems(rows: BlockedScanItem[]): BulkPassItem[] {
  return rows.flatMap((f) => {
    if (!f.batch_id) return []
    const q = getQuantity(f)
    return [{
      batch_id: f.batch_id,
      quantity: q ?? null,
      label: `${f.serial_no} · ${f.name}`,
    }]
  })
}

async function onConfirm(): Promise<void> {
  if (!canBulkSubmit.value || !selectedShelfId.value) return

  // 第一批：送检 inspectableFailures
  const firstResult = await bulk.run({
    target_inspection_shelf_id: selectedShelfId.value,
    items: toBulkScanItems(inspectableFailures.value),
  })

  // 第二批（可选）：勾选的 INSPECTION 行 → READY_TO_SHIP（route B batchToShip）
  const alsoPassRows = passableFailures.value.filter(
    (f) => f.batch_id && f.part_id && checkedAlsoPass.value.has(f.part_id),
  )
  let secondResult: { passed: BlockedScanItem[]; failed: BulkScanFailure[] } | null = null
  if (alsoPassRows.length > 0) {
    const passResult = await passBulk.run(toBulkPassItems(alsoPassRows))
    // useBulkPassInspection 返回 BulkPassFailure（item: BulkPassItem，batch_id 必填）；
    // emit 签名要 BulkScanFailure，这里仅用 .passed.length / .failed.length 做汇总，
    // 把 BulkPassFailure 透过类型断言塞进 BulkScanFailure[]（同形同 .code / .message）。
    secondResult = {
      passed: passResult.passed as unknown as BlockedScanItem[],
      failed: passResult.failed as unknown as BulkScanFailure[],
    }
  }

  // 汇总两批结果
  const totalPassed = firstResult.submitted.length + (secondResult?.passed.length ?? 0)
  const totalFailed = firstResult.failed.length + (secondResult?.failed.length ?? 0)

  if (totalFailed === 0) {
    ElMessage.success(`已送检 ${totalPassed} 项`)
    closeDialog()
    emit('submit-success')
  } else if (totalPassed > 0) {
    ElMessage.warning(
      `部分送检：${totalPassed} 项成功 / ${totalFailed} 项失败`,
    )
    // 保留弹窗让用户看到（按需重试）；合并 failed 给父组件（toast）
    emit('submit-partial', {
      // firstResult.submitted 是 BulkScanItem[]，emit 签名要 BlockedScanItem[]；
      // 父组件 onSubmitPartial 只读 .passed.length / .failed.length，强转安全。
      passed: firstResult.submitted as unknown as BlockedScanItem[],
      failed: [...firstResult.failed, ...(secondResult?.failed ?? [])],
    })
  } else {
    const firstMsg = firstResult.failed[0]?.message ?? '未知错误'
    ElMessage.error(`全部失败：${firstMsg}`)
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`一键送检：${shortReason}`"
    :width="dlg.width"
    :top="dlg.top"
    :fullscreen="dlg.fullscreen"
    append-to-body
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-alert
      type="info"
      :closable="false"
      :title="`下列 ${inspectableFailures.length} 项零件尚未送检；选择品检架并确认后一键搬上 INSPECTION 架`"
      class="submit-alert"
    />

    <!-- 共享品检架选择器 -->
    <div class="shelf-picker">
      <span class="picker-label">目标品检架（共享）</span>
      <el-select
        v-model="selectedShelfId"
        :loading="shelvesLoading"
        placeholder="请选择 INSPECTION 区 active 货架"
        filterable
        style="width: 360px"
        :disabled="shelvesLoading"
      >
        <el-option
          v-for="s in shelves"
          :key="s.id"
          :value="s.id"
          :label="`${s.code} · ${s.name}`"
        />
      </el-select>
      <span v-if="shelvesError" class="muted">{{ shelvesError }}</span>
      <span v-else-if="shelves.length === 0 && !shelvesLoading" class="muted">
        （无 active 的 INSPECTION 货架）
      </span>
    </div>

    <!-- 2026-08-27 Task 8：列设置工具条 -->
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>
    <el-table
      ref="tableRef"
      :data="failures"
      stripe
      border
      max-height="380"
      empty-text="无阻塞项"
      class="submit-table"
    >
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :align="d.align"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :column-key="d.columnKey ?? d.key"
          :label-class-name="drag.dragLabelClass(d)"
        >
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
          <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
        </el-table-column>
      </template>
      <!-- 「送检数量」列（受控 el-input-number + getQuantity/setQuantity；不进 defs） -->
      <el-table-column label="送检数量" width="130" align="center">
        <template #default="{ row }">
          <el-input-number
            :model-value="getQuantity(row as BlockedScanItem) ?? row.quantity ?? 1"
            :min="1"
            :max="row.quantity ?? 9999"
            size="small"
            :controls="false"
            :disabled="!row.part_id || (row.status !== 'PENDING' && row.status !== 'PROGRAMMING' && row.status !== 'IN_PROCESS')"
            @update:model-value="(v) => setQuantity(row as BlockedScanItem, v as number | null)"
          />
        </template>
      </el-table-column>
      <!-- 「同时过检」列（条件 v-if + ElCheckbox；不进 defs） -->
      <el-table-column
        v-if="passableFailures.length > 0"
        label="同时过检"
        width="100"
        align="center"
      >
        <template #default="{ row }">
          <el-checkbox
            v-if="row.status === 'INSPECTION' && row.part_id"
            :model-value="checkedAlsoPass.has(row.part_id)"
            @change="() => row.part_id && toggleAlsoPass(row.part_id)"
          />
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <div class="submit-footer">
        <span v-if="bulk.running.value" class="submit-progress">
          进度 {{ bulk.progress.done }} / {{ bulk.progress.total }}
        </span>
        <div class="submit-actions">
          <el-button @click="onCancel">取消</el-button>
          <el-tooltip
            :content="disabledTooltip"
            :disabled="canBulkSubmit && !disabledTooltip"
            placement="top"
          >
            <el-button
              type="primary"
              :loading="bulk.running.value"
              :disabled="!canBulkSubmit"
              @click="onConfirm"
            >
              <el-icon><Upload /></el-icon>
              <span>一键送检</span>
            </el-button>
          </el-tooltip>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.submit-alert {
  margin-bottom: 12px;
}

/* 2026-08-27 Task 8：列设置工具条 */
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.shelf-picker {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.picker-label {
  font-size: 14px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
}
.submit-table {
  margin-top: 4px;
}
.submit-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.submit-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.submit-progress {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>