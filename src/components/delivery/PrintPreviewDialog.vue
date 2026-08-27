<!--
  送货单打印预览对话框（2026-08-02 新增；2026-08-04 装配件合并；2026-08-07 拆双模式）。

  设计要点：
  - 列：勾选（仅 label 模式）/ 序号（拖动 handle + 数字）/ 订单号 / 分厂 / 申请人 / 图号 / 名称 / 数量
  - 初始顺序 = 详情页当前 ``note.line_items`` 的内存顺序（含用户列头排序的结果）
  - 行可拖动：vue-draggable-plus（包 Sortable.js）绑到 el-table 渲染出的 tbody
  - 用户拖动只影响预览副本；详情页 ``note.line_items`` 不变
  - 2026-08-04：单上有装配件子件时显示「合并为一套 / 分开打印所有子件」radio；
    合并模式预览折叠子件为父行；导出时把父行 round-trip 展开为组内 batch id 连续。
  - 2026-08-07：新增 ``mode`` prop：
      · 'note'  = 只导送货单（不串联标签下载，旧 PR-C5 行为已剥离）
      · 'label' = 只导标签，支持勾选部分行；列首加 el-table 原生 selection 列
  - 取消 → 关闭对话框
-->
<script setup lang="ts">
import {
  computed,
  h,
  nextTick,
  ref,
  watch,
} from 'vue'
import { ElMessage, ElTag } from 'element-plus'
import { Rank } from '@element-plus/icons-vue'
import { useLazyDraggable } from '@/composables/useLazyDraggable'

import {
  printNote,
  printNoteLabels,
} from '@/api/deliveryNote'
import { useDialogSize } from '@/composables/useDialogSize'
import { triggerBrowserDownload } from '@/utils/download'
import type {
  DeliveryNoteDetailOut,
  DeliveryNoteLineItem,
} from '@/types/deliveryNote'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import { findElTableThead } from '@/utils/elTable'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    note: DeliveryNoteDetailOut | null
    /** 2026-08-07：'note' = 只导送货单；'label' = 只导标签（可勾选行） */
    mode?: 'note' | 'label'
  }>(),
  { mode: 'note' },
)

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
}>()

const dlg = useDialogSize({ desktopWidth: 1100 })

const previewTableRef = ref()
const rows = ref<PreviewRow[]>([])
const tbodyRef = ref<HTMLElement | null>(null)
const loading = ref(false)

// 2026-08-07：标签模式的勾选状态
const selectedRows = ref<PreviewRow[]>([])

// 2026-08-04：单上是否含有装配件子件
const hasAssemblies = computed(
  () => props.note?.line_items.some((li) => li.assembly_id) ?? false,
)
// 2026-08-07 改默认：单上含装配件子件时直接合并为一套打印（与后端 merge_assemblies 默认一致）
const mergeMode = ref<'separate' | 'merge'>('merge')

// 2026-08-07：是否为标签导出模式
const isLabelMode = computed(() => props.mode === 'label')

interface PreviewAssemblyRow {
  id: string
  is_asm_row: true
  assembly_id: string
  order_no: string
  customer_name: string
  applicant_name: string
  drawing_no: string
  name: string
  quantity: number
  unit: string
}
type PreviewRow = DeliveryNoteLineItem | PreviewAssemblyRow

// 2026-08-07：同 part 多批次折叠（_split 产生同 part 同送货单）。
// 永远开启，先于装配体折叠：每 part 仅产出一行，quantity 求和；
// 行 id = 首个出现的 batch id（= 后端代表批次 id 约定）。
// 与 DeliveryNoteLineItem 1:1 → DeliveryNoteLineItem（保留原 part_id 用于 asm 折叠判断）。
function foldSamePart(items: DeliveryNoteLineItem[]): DeliveryNoteLineItem[] {
  const qty = new Map<string, number>()
  const rep = new Map<string, DeliveryNoteLineItem>()
  const order: string[] = []
  for (const li of items) {
    const pid = String(li.part_id)
    if (qty.has(pid)) {
      qty.set(pid, qty.get(pid)! + li.quantity)
      continue
    }
    qty.set(pid, li.quantity)
    rep.set(pid, li)
    order.push(pid)
  }
  return order.map((pid) => ({ ...rep.get(pid)!, quantity: qty.get(pid)! }))
}

// 预览表格行：合并模式构造父行 + 散件；非合并模式 = line_items 拷贝
const previewRows = computed<PreviewRow[]>(() => {
  if (!props.note) return []
  // 2026-08-07：先做同 part 折叠，再做装配体折叠。装配体折叠对折叠后的 part 唯一行生效。
  const flat = foldSamePart(props.note.line_items)
  if (!mergeMode.value || mergeMode.value === 'separate') {
    return [...flat]
  }
  const result: PreviewRow[] = []
  const insertedAsm = new Set<string>()
  flat.forEach((li) => {
    if (!li.assembly_id) {
      result.push(li)
      return
    }
    if (insertedAsm.has(li.assembly_id)) return
    const siblings = flat.filter((x) => x.assembly_id === li.assembly_id)
    result.push({
      id: `ASM_${li.assembly_id}`,
      is_asm_row: true,
      assembly_id: li.assembly_id,
      order_no: siblings[0]?.assembly_order_no ?? '',
      customer_name: siblings[0]?.customer_name ?? '',
      applicant_name: siblings[0]?.applicant_name ?? '',
      drawing_no: li.assembly_drawing_no ?? '',
      name: li.assembly_name ?? '',
      quantity: 1,
      unit: '套',
    })
    insertedAsm.add(li.assembly_id)
  })
  return result
})

// 2026-08-27 fix：tbodyRef 在 setup 时为 null（弹窗未打开），且 <el-dialog destroy-on-close>
// 关闭时销毁 slot、reopen 时 <tbody> 是新元素。此前用 useDraggable 会在挂载时
// new Sortable(null) 抛错（旧注释里「useDraggable 自动忽略」的说法是错的）。
// 改用 useLazyDraggable：refreshTbodyRef() 写 ref 即自动重绑，无需手动 start()。
useLazyDraggable(tbodyRef, rows, {
  handle: '.drag-handle',
  draggable: 'tr',
  animation: 150,
  ghostClass: 'sortable-ghost',
  onEnd(evt: { oldIndex?: number; newIndex?: number }) {
    const { oldIndex, newIndex } = evt
    if (oldIndex == null || newIndex == null || oldIndex === newIndex) return
    const next = rows.value.slice()
    const [moved] = next.splice(oldIndex, 1)
    if (moved) next.splice(newIndex, 0, moved)
    rows.value = next
  },
})

// 2026-08-27 Task 8：列顺序拖动 + 可见性。
// el-dialog destroy-on-close → Ref 路径：watch(previewTableRef) 重建 thead 后自愈。
// 与既有 useLazyDraggable 行拖（绑 tbody）独立 —— 列拖挂 thead，DOM 容器完全分离。
// label 模式首列 selection 勾选列不进 defs（type='selection' 自动不可拖 + v-if 条件）。
const columnDefs: ColumnDef[] = [
  {
    // 序号列：保留行拖手柄 .drag-handle（vue-draggable-plus 行拖的 handle 选择器）。
    // cellRender 必须返回单个 VNode；行内多根包 <div>。
    key: 'index', label: '序号', width: 72, align: 'center',
    cellRender: ({ $index }) => h('div', null, () => [
      h('span', { class: 'drag-handle', title: '拖动排序' }, () => h(Rank)),
      h('span', { class: 'row-index' }, () => $index + 1),
    ]),
  },
  {
    key: 'order_no', label: '订单号', prop: 'order_no', minWidth: 120,
    showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as PreviewRow).order_no || '—'),
  },
  {
    key: 'customer_name', label: '分厂', prop: 'customer_name', minWidth: 160,
    showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as PreviewRow).customer_name || '—'),
  },
  {
    key: 'applicant_name', label: '申请人', prop: 'applicant_name', minWidth: 100, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as PreviewRow).applicant_name || '—'),
  },
  { key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 140, align: 'center' },
  {
    key: 'name', label: '名称', minWidth: 180, showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PreviewRow
      if (isAsmRow(r)) {
        return h('div', null, () => [
          h(ElTag, { type: 'warning', size: 'small', class: 'asm-tag' }, () => '装配件'),
          h('span', null, () => r.name),
        ])
      }
      return h('span', null, () => r.name)
    },
  },
]
// 「数量」列不进 defs：el-input-number 受控 v-model=r.quantity（asm 行） + 文本回退（普通行），
// 不便走 cellRender（多分支 + EP 组件 + 受控 modelValue）。
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'print_preview_dialog' })
const drag = useColumnDrag(columnDefs, { listKey: 'print_preview_dialog' })

watch(previewTableRef, (instance) => {
  if (!instance) return
  void nextTick(() => {
    const root = (instance as { $el?: HTMLElement }).$el
    if (!root) return
    const thead = findElTableThead(root)
    if (thead) drag.applyDrag(thead)
  })
}, { flush: 'post' })

watch(
  () => [props.modelValue, mergeMode.value],
  async ([open]) => {
    if (open && props.note) {
      // 拷贝当前内存顺序作为预览初始顺序（不污染详情页）
      rows.value = previewRows.value
      await nextTick()
      refreshTbodyRef()
      // 2026-08-07：label 模式默认全选
      if (isLabelMode.value) {
        await selectAll()
      }
    }
  },
  // 2026-08-24 bugfix：扫码建单页用 v-if 挂载本组件，首次进入时 modelValue
  // 已经是 true（无 false→true 的「变化」），watch 默认不立即触发会导致
  // rows 永远是空数组。详情页始终挂载的调用方不受影响（mount 时 open=false，
  // 不进 if 分支，tbodyRef 保持 null，useLazyDraggable 不会绑定）。
  { immediate: true },
)

watch(previewRows, async (next) => {
  rows.value = next
  await nextTick()
  refreshTbodyRef()
  // 2026-08-07：合并模式切换后重置全选
  if (isLabelMode.value) {
    await selectAll()
  }
})

function isAsmRow(r: unknown): r is PreviewAssemblyRow {
  return typeof r === 'object' && r !== null
    && (r as PreviewAssemblyRow).is_asm_row === true
}

// 2026-08-07：标签模式全选 / 反选
async function selectAll(): Promise<void> {
  await nextTick()
  const t = previewTableRef.value
  if (!t) return
  // 逐行 toggle true（不用 toggleAllSelection：toggle 语义会全消）
  rows.value.forEach((r) => t.toggleRowSelection(r, true))
}
function invertSelection(): void {
  const t = previewTableRef.value
  if (!t) return
  const chosen = new Set(selectedRows.value)
  rows.value.forEach((r) => t.toggleRowSelection(r, !chosen.has(r)))
}

/** 找到 el-table 渲染出的 tbody 并写到 tbodyRef；useLazyDraggable 内部 watcher 看到 ref 变化即重绑。 */
function refreshTbodyRef(): void {
  const root = previewTableRef.value?.$el
  if (!root) {
    tbodyRef.value = null
    return
  }
  tbodyRef.value = root.querySelector(
    '.el-table__body-wrapper .el-table__body > tbody',
  ) as HTMLElement | null
}

function onCancel(): void {
  emit('update:modelValue', false)
}

async function onConfirm(): Promise<void> {
  if (!props.note) return
  loading.value = true
  try {
    // 2026-08-24 bugfix：custom_order / line_item_ids 都必须覆盖 line_items[*].id
    // 全部批次（后端 rep-id 校验 21113）。rows 经过 foldSamePart 折叠后每个 part 仅产
    // 出代表 batch id，会漏掉同 part 多批次 / 装配件子件多批次——这里查全量必须用原始
    // line_items，不能用折叠后的 flat。
    const allItems = props.note.line_items
    let custom_order: string[]
    let mergeFlag = false
    let merge_quantities: Record<string, number> | undefined
    if (mergeMode.value === 'merge') {
      // 合并模式：父行 → 组内 batch id 连续；散件行原样
      custom_order = []
      merge_quantities = {}
      rows.value.forEach((r) => {
        if (isAsmRow(r)) {
          merge_quantities![r.assembly_id] = r.quantity
          allItems
            .filter((li) => li.assembly_id === r.assembly_id)
            .forEach((c) => custom_order.push(String(c.id)))
        } else {
          allItems
            .filter((li) => li.part_id === (r as DeliveryNoteLineItem).part_id)
            .forEach((c) => custom_order.push(String(c.id)))
        }
      })
      mergeFlag = true
    } else {
      custom_order = []
      rows.value.forEach((r) => {
        allItems
          .filter((li) => li.part_id === (r as DeliveryNoteLineItem).part_id)
          .forEach((c) => custom_order.push(String(c.id)))
      })
    }

    if (isLabelMode.value) {
      // 2026-08-07：label 模式 → 展开勾选行成子件 batch id（与 custom_order 同一口径）
      // 2026-08-24：同上面 custom_order 一样改用 allItems，否则 line_item_ids 也漏批次。
      const line_item_ids: string[] = []
      selectedRows.value.forEach((r) => {
        if (isAsmRow(r)) {
          allItems
            .filter((li) => li.assembly_id === r.assembly_id)
            .forEach((c) => line_item_ids.push(String(c.id)))
        } else {
          allItems
            .filter((li) => li.part_id === (r as DeliveryNoteLineItem).part_id)
            .forEach((c) => line_item_ids.push(String(c.id)))
        }
      })
      const { blob, filename } = await printNoteLabels(props.note.id, {
        custom_order,
        merge_assemblies: mergeFlag,
        merge_quantities,
        line_item_ids,
      })
      triggerBrowserDownload(blob, filename)
    } else {
      // 2026-08-07：note 模式 → 仅导送货单，不再串联标签下载
      const { blob, filename } = await printNote(
        props.note.id,
        { custom_order, merge_assemblies: mergeFlag, merge_quantities },
      )
      triggerBrowserDownload(blob, filename)
    }
    ElMessage.success('已导出')
    emit('update:modelValue', false)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '导出失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <!-- 2026-08-27 fix：destroy-on-close 会重建 slot 内的 <tbody>；watcher 在 reopen 时
       refreshTbodyRef() 写 tbodyRef，useLazyDraggable 内部 watcher 自动重绑新 tbody。 -->
  <el-dialog
    :model-value="modelValue"
    :title="isLabelMode
      ? '标签打印预览（勾选要打印的行，拖动可调顺序）'
      : '打印预览（拖动行可调整顺序）'"
    :width="dlg.width"
    :top="dlg.top"
    :fullscreen="dlg.fullscreen"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="preview-tip">
      <span v-if="!isLabelMode">预览共 {{ rows.length }} 行；导出顺序 = 当前预览顺序。</span>
      <el-space v-if="isLabelMode" size="small">
        <span>已选 {{ selectedRows.length }} / {{ rows.length }} 行</span>
        <el-button size="small" @click="selectAll">全选</el-button>
        <el-button size="small" @click="invertSelection">反选</el-button>
      </el-space>
      <!-- 2026-08-04：仅当单上含装配件子件时显示（el-radio-button 更醒目） -->
      <el-radio-group
        v-if="hasAssemblies"
        v-model="mergeMode"
        size="small"
        class="merge-toggle"
      >
        <el-radio-button value="separate">分开打子件</el-radio-button>
        <el-radio-button value="merge">合并一套</el-radio-button>
      </el-radio-group>
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
    <!-- 2026-08-22 a11y：selection 列所在的 table 加 aria-label -->
    <el-table
      ref="previewTableRef"
      :data="rows"
      row-key="id"
      aria-label="打印预览列表"
      stripe
      border
      height="500"
      @selection-change="(v: PreviewRow[]) => (selectedRows = v)"
    >
      <!-- 2026-08-07：label 模式首列加 el-table 原生 selection 勾选列（不进 defs：type='selection' 不可拖） -->
      <el-table-column v-if="isLabelMode" type="selection" width="48" />
      <!-- 2026-08-27 Task 8：列顺序拖动接入 -->
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
      <!-- 「数量」列不进 defs：asm 行 el-input-number + 普通行文本 双分支不便走 cellRender -->
      <el-table-column
        label="数量" min-width="120" align="right">
        <template #default="{ row }">
          <el-input-number
            v-if="isAsmRow(row)"
            v-model="row.quantity"
            :min="1" :max="999" :precision="0"
            size="small" controls-position="right"
            style="width: 110px"
          />
          <span v-else>{{ row.quantity }}</span>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
      <el-button
        type="primary" :loading="loading"
        :disabled="!rows.length || (isLabelMode && !selectedRows.length)"
        @click="onConfirm">
        {{ isLabelMode ? '导出标签' : '导出送货单' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 2026-08-27 Task 8：列设置工具条 */
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.drag-handle {
  cursor: grab;
  color: var(--primary-color);
  margin-right: 4px;
}
.drag-handle:active {
  cursor: grabbing;
}
.row-index {
  color: var(--text-secondary);
  font-size: 12px;
}
:deep(.sortable-ghost) {
  opacity: 0.4;
  background: #eaf2fb !important;
}
:deep(.sortable-chosen) {
  background: #cce0f4 !important;
}
.preview-tip {
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.merge-toggle {
  color: var(--text-primary);
}
.asm-tag { margin-right: 4px; }
</style>