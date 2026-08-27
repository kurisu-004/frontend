<!--
  PartBidImport.vue

  /parts/new/bid-import  从「法拉电子应标 Excel」批量导入零件。

  流程：
  1. 顶部：选 L1 根客户（如 法拉电子）+ 请购日期（默认今天） + 上传 .xlsx
  2. 解析 → 预览表（每行自动按「申请人所在一级部门名称」解析到 L2 子客户，
     缺失的标红）+ 每行可手动挂 PDF 图纸
  3. 提交：dedupe 申请人 → bulkGetOr-create → batchCreateParts（multipart）
  4. 成功 → 跳到 /parts?status=PENDING

  设计要点：
  - 解析是纯函数 bidExcelParser，sheets 检验在解析层抛错（致命）。
  - L2 客户解析失败 → 错误行挡住提交。
  - 申请人由后端 bulk-get-or-create 幂等创建，避免前端循环 createApplicant 的 race。
  - 图纸按现有 /parts/batch 模式 multipart 上传，items + files 按下标对齐。

  2026-08-27 T24（B 组 batch 1）：接入列顺序拖动 + ColumnVisibilityPopover。
  - 顶层路由 view，<el-table> v-if="rows.length > 0"，挂载时 rows 可能为空
    → HTMLElement 路径 + optional chaining 兜底。
  - 7 列含 form 控件（el-autocomplete/el-select/el-input/el-input-number/
    el-switch/el-date-picker），全部用 h() cellRender 转换；
    v-model 用 modelValue + onUpdate:modelValue 显式双向。
  - 「序号」index + 「操作」fixed 列保留为字面量 <el-table-column>。
-->
<template>
  <div class="bid-import">
    <p class="hint">
      上传「应标 Excel」（主 sheet 名 = <code>招标项目-标的</code>），系统自动按
      「申请人所在一级部门」解析到分厂（L2 子客户）。列表每一格都可手动修改，
      也可点「新增一行」手工补单；缺分厂 / 申请人 / 图纸编号 / 名称 / 数量 / 计划交期
      的行会标红并挡住提交。图纸 PDF 按行手动上传。
    </p>

    <el-card shadow="never" class="control-card">
      <el-form :model="form" inline label-width="92px">
        <el-form-item label="L1 客户" required>
          <el-select
            v-model="form.rootCustomerId"
            placeholder="选一级客户（如 法拉电子）"
            filterable
            clearable
            style="width: 240px"
            @change="onRootCustomerChange"
          >
            <el-option
              v-for="root in rootCustomers"
              :key="root.id"
              :label="root.name + (root.serial_prefix ? ` [${root.serial_prefix}]` : '')"
              :value="root.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="请购日期" required>
          <el-date-picker
            v-model="form.requestDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选请购日期"
            style="width: 180px"
          />
        </el-form-item>
        <!-- 2026-08-22 a11y：加 name 给隐藏 file input；同时 :for="" 防止 el-form-item 误绑 -->
        <el-form-item label="应标 Excel" :for="''">
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            name="bid_excel"
            accept=".xlsx,.xls"
            :on-change="onExcelChange"
          >
            <el-button :loading="parsing" :disabled="!form.rootCustomerId">
              <el-icon><Upload /></el-icon>
              <span>选择 Excel 文件</span>
            </el-button>
          </el-upload>
        </el-form-item>
      </el-form>
    </el-card>

    <el-alert
      v-if="deptVariety > 1"
      :title="`Excel 中检测到 ${deptVariety} 个不同分厂（一级部门名称），已按行自动归类到子客户。`"
      type="warning"
      :closable="false"
      show-icon
      class="variety-banner"
    />

    <el-card shadow="never" class="preview-card">
      <div class="preview-header">
        <h3>预览（{{ rows.length }} 条）</h3>
        <div>
          <el-button @click="onAddBlankRow" :disabled="submitting">
            <el-icon><Plus /></el-icon>
            <span>新增一行</span>
          </el-button>
          <el-button @click="onClearAll" :disabled="rows.length === 0 || submitting">
            清空
          </el-button>
          <el-button
            type="primary"
            :loading="submitting"
            :disabled="rows.length === 0 || errorRowCount > 0 || !form.rootCustomerId || !form.requestDate"
            @click="onSubmit"
          >
            提交 {{ rows.length }} 条
          </el-button>
        </div>
      </div>

      <el-table
        v-if="rows.length > 0"
        ref="tableRef"
        :data="rows"
        :row-key="(row: ImportRow) => row.uid"
        border
        size="small"
        :row-class-name="rowClassName"
      >
        <el-table-column type="index" label="序号" width="56" />
        <!--
          2026-08-27 T24：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
          用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
          form 控件列（autocomplete/select/input/input-number/switch/date-picker）
          通过 cellRender 用 h() 重建，v-model 走 modelValue + onUpdate:modelValue。
          操作列 fixed="right" 保留为字面量 <el-table-column>。
        -->
        <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
          <el-table-column
            v-if="columnVisibility.isVisible(d.key)"
            :prop="d.prop ?? d.key"
            :label="d.label"
            :width="d.width"
            :min-width="d.minWidth"
            :sortable="d.sortable"
            :align="d.align"
            :header-align="d.headerAlign"
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
        <el-table-column label="操作" min-width="240" align="center" fixed="right">
          <template #default="{ row }">
            <div class="row-ops">
              <el-upload
                :show-file-list="false"
                :auto-upload="false"
                accept=".pdf"
                :on-change="(f: UploadFile) => onRowDrawingChange(row as ImportRow, f)"
              >
                <el-button link type="primary" size="small">
                  <el-icon><Paperclip /></el-icon>
                  <span>{{ (row as ImportRow).drawingName ? '替换图纸' : '添加图纸' }}</span>
                </el-button>
              </el-upload>
              <el-button
                link
                type="primary"
                size="small"
                :disabled="!(row as ImportRow).drawingUrl"
                @click="openDrawingPreview(row as ImportRow)"
              >
                <el-icon><View /></el-icon>
                <span>预览图纸</span>
              </el-button>
              <el-button
                v-if="(row as ImportRow).drawingUrl"
                link
                type="info"
                size="small"
                title="移除图纸"
                @click="onRowDrawingRemove(row as ImportRow)"
              >
                <el-icon><Close /></el-icon>
              </el-button>
              <el-button link type="danger" size="small" @click="onRemoveRow(row as ImportRow)">
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="empty-zone">
        <el-icon :size="48" color="#c0c4cc"><DocumentAdd /></el-icon>
        <p class="empty-primary">尚未上传 Excel</p>
        <p class="empty-sub">选好 L1 客户后点击「选择 Excel 文件」开始</p>
      </div>

      <!-- 2026-08-27 T24：列设置按钮（仅列表态展示；空态无表可设） -->
      <div v-if="rows.length > 0" class="table-toolbar">
        <ColumnVisibilityPopover
          :defs="columnDefs"
          :model-value="columnVisibility.currentMap"
          @update:model-value="columnVisibility.update"
          @reset="columnVisibility.showAll"
          @reset-order="drag.reset"
        />
      </div>
    </el-card>

    <!-- 图纸预览弹窗（仅本地 File，blob URL） -->
    <el-dialog
      v-model="drawingPreviewVisible"
      :title="drawingPreviewTitle"
      fullscreen
      :close-on-click-modal="false"
      :destroy-on-close="true"
      append-to-body
    >
      <div v-if="drawingPreviewUrl" class="preview-frame-wrap">
        <PdfViewer :url="drawingPreviewUrl" />
      </div>
      <p v-else class="muted">无可预览内容</p>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import * as XLSX from 'xlsx'
import {
  ElAutocomplete,
  ElDatePicker,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElSelect,
  ElSwitch,
  ElOption,
  type UploadFile,
} from 'element-plus'

import PdfViewer from '@/components/PdfViewer.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import { listCustomers, type Customer } from '@/api/customer'
import {
  batchCreateParts,
  type PartBatchFilePayload,
  type PartCreatePayload,
} from '@/api/parts'
import { bulkGetOrCreateApplicants } from '@/api/applicant'
import { useApplicantSearch } from '@/composables/useApplicantSearch'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import { findElTableThead } from '@/utils/elTable'
import type { Applicant } from '@/types/applicant'
import { parseBidExcel, type BidRow } from '@/utils/bidExcelParser'

// ============================================================
// 顶层表单
// ============================================================

interface FormState {
  rootCustomerId: string | null
  requestDate: string
}
const form = reactive<FormState>({
  rootCustomerId: null,
  requestDate: todayIso(),
})
function todayIso(): string {
  const d = new Date()
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}

// ============================================================
// 客户树
// ============================================================

const customers = ref<Customer[]>([])
const rootCustomers = computed(() =>
  customers.value.filter((c) => c.parent_id === null),
)

/** 当前 L1 根客户下的二级分厂，供「分厂名」下拉用。 */
const subFactories = computed(() =>
  form.rootCustomerId
    ? customers.value.filter((c) => c.parent_id === form.rootCustomerId)
    : [],
)

/** 客户 id → 所属一级客户 id（一级 → 自己；二级 → parent）。 */
function resolveRootCustomerId(pickedId: string | null): string | null {
  if (!pickedId) return null
  const found = customers.value.find((c) => c.id === pickedId)
  if (!found) return null
  return found.parent_id ?? found.id
}

// 申请人自动补全：全表共享（L1 根客户在顶部统一选择，切换时载入一次）。
const { loadForCustomer: loadApplicantsForCustomer, querySearch } =
  useApplicantSearch({ resolveRootCustomerId })

async function loadCustomers(): Promise<void> {
  try {
    customers.value = await listCustomers()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '客户列表加载失败')
  }
}

function findL2UnderRoot(rootId: string, deptName: string): Customer | null {
  const trimmed = deptName.trim()
  if (!trimmed) return null
  // 精确匹配优先；同根下同名的二级客户存在多个时取第一个（少见）
  return (
    customers.value.find(
      (c) => c.parent_id === rootId && c.name.trim() === trimmed,
    ) ?? null
  )
}

// ============================================================
// 行模型（解析结果 + 解析后再补的字段）
// ============================================================

interface ImportRow extends BidRow {
  uid: string
  // 解析期错误（缺申请人/缺图号/缺名称/数量异常等），从 parser.errors 取
  parserErrors: string[]
  // 解析后由 page 补的字段
  customerId: string | null
  customerLabel: string
  rootCustomerId: string | null  // 由 customerId 上溯
  drawingFile: File | null
  drawingName: string | null
  drawingUrl: string | null
  // 提交时由 bulkGetOrCreate 返回的 applicant_id 字符串
  applicantId: string | null
}

const rows = ref<ImportRow[]>([])
const parsing = ref(false)
let _uidCounter = 0

// ============================================================
// 列顺序拖动 + 可见性
// 2026-08-27 T24：form 控件列（autocomplete/select/input/input-number/switch/date-picker）
// 全部用 h() cellRender 重建，v-model 走 modelValue + onUpdate:modelValue。
// 「序号」index + 「操作」fixed 列不进 defs。
// ============================================================
const columnDefs: ColumnDef[] = [
  {
    key: 'applicantName', label: '申请人', minWidth: 150, align: 'center',
    cellRender: ({ row }) => {
      const r = row as ImportRow
      return h(ElAutocomplete, {
        modelValue: r.applicantName,
        'onUpdate:modelValue': (v: string | number) => { r.applicantName = String(v) },
        'value-key': 'name',
        'fetch-suggestions': querySearch,
        'trigger-on-focus': true,
        debounce: 0,
        clearable: true,
        size: 'small',
        style: 'width: 100%',
        placeholder: '申请人',
        onSelect: (item: Record<string, unknown>) => onApplicantSelect(r, item as unknown as Applicant),
      })
    },
  },
  {
    key: 'customerId', label: '分厂名', minWidth: 180, align: 'center',
    cellRender: ({ row }) => {
      const r = row as ImportRow
      return h(ElSelect, {
        modelValue: r.customerId,
        'onUpdate:modelValue': (v: unknown) => { r.customerId = v as string | null },
        filterable: true,
        clearable: true,
        size: 'small',
        style: 'width: 100%',
        placeholder: '选所属分厂',
        disabled: !form.rootCustomerId,
        onChange: () => onRowFactoryChange(r),
      }, () => subFactories.value.map((f) =>
        h(ElOption, { key: f.id, label: f.name, value: f.id })))
    },
  },
  {
    key: 'drawingNo', label: '图纸编号', minWidth: 150, align: 'center',
    cellRender: ({ row }) => {
      const r = row as ImportRow
      return h(ElInput, {
        modelValue: r.drawingNo,
        'onUpdate:modelValue': (v: string) => { r.drawingNo = v },
        size: 'small',
        placeholder: '图纸编号',
      })
    },
  },
  {
    key: 'partName', label: '名称', minWidth: 180, align: 'center',
    cellRender: ({ row }) => {
      const r = row as ImportRow
      return h(ElInput, {
        modelValue: r.partName,
        'onUpdate:modelValue': (v: string) => { r.partName = v },
        size: 'small',
        placeholder: '名称',
      })
    },
  },
  {
    key: 'quantity', label: '数量', minWidth: 130, align: 'center',
    cellRender: ({ row }) => {
      const r = row as ImportRow
      return h(ElInputNumber, {
        modelValue: r.quantity,
        'onUpdate:modelValue': (v: number | undefined) => { r.quantity = v ?? 1 },
        min: 1,
        step: 1,
        'step-strictly': true,
        size: 'small',
        'controls-position': 'right',
        style: 'width: 110px',
      })
    },
  },
  {
    key: 'isUrgent', label: '是否加急', minWidth: 90, align: 'center',
    cellRender: ({ row }) => {
      const r = row as ImportRow
      return h(ElSwitch, {
        modelValue: r.isUrgent,
        'onUpdate:modelValue': (v: string | number | boolean) => { r.isUrgent = Boolean(v) },
      })
    },
  },
  {
    key: 'plannedDeliveryDate', label: '计划交期', minWidth: 170, align: 'center',
    cellRender: ({ row }) => {
      const r = row as ImportRow
      return h(ElDatePicker, {
        modelValue: r.plannedDeliveryDate,
        'onUpdate:modelValue': (v: string) => { r.plannedDeliveryDate = v },
        type: 'date',
        'value-format': 'YYYY-MM-DD',
        placeholder: '计划交期',
        size: 'small',
        style: 'width: 150px',
      })
    },
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'part_bid_import' })
const drag = useColumnDrag(columnDefs, { listKey: 'part_bid_import' })

// 2026-08-27 T24：HTMLElement 路径。路由进入时 rows 为 0 → el-table 未渲染
// → tableRef undefined；onMounted 用 optional chaining 兜底（HTMLElement 路径标准 trade-off，
// 用户上传 Excel 解析后才看到表，下次路由进入 / 刷新才能恢复拖动）。
const tableRef = ref()
onMounted(() => {
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (!root) return
  const thead = findElTableThead(root)
  if (thead) drag.applyDrag(thead)
})

function makeUid(): string {
  _uidCounter += 1
  return `bid-${Date.now()}-${_uidCounter}`
}

function revokeDrawingUrl(row: ImportRow): void {
  if (row.drawingUrl) {
    try { URL.revokeObjectURL(row.drawingUrl) } catch { /* ignore */ }
  }
}

/**
 * 一行是否阻塞提交。全部走「当前字段值」实时判断（不看解析期 parserErrors），
 * 这样用户逐格改完后标红会立即消失，符合「防止读取发生错误」。
 */
function rowHasError(r: ImportRow): boolean {
  return (
    !r.customerId ||
    !r.applicantName.trim() ||
    !r.drawingNo.trim() ||
    !r.partName.trim() ||
    !r.quantity ||
    r.quantity < 1 ||
    !r.plannedDeliveryDate
  )
}

const errorRowCount = computed(
  () => rows.value.filter(rowHasError).length,
)

const deptVariety = computed(
  () => new Set(rows.value.map((r) => r.deptName).filter(Boolean)).size,
)

function rowClassName({ row }: { row: unknown }): string {
  const r = row as ImportRow
  if (rowHasError(r)) return 'row-error'
  if (r.isUrgent) return 'row-urgent'
  return ''
}

function buildImportRow(bid: BidRow, errors: string[]): ImportRow {
  return {
    ...bid,
    uid: makeUid(),
    parserErrors: errors,
    customerId: null,
    customerLabel: '',
    rootCustomerId: null,
    drawingFile: null,
    drawingName: null,
    drawingUrl: null,
    applicantId: null,
  }
}

function resolveAllCustomers(): void {
  if (!form.rootCustomerId) return
  const rootId = form.rootCustomerId
  for (const r of rows.value) {
    if (!r.deptName) {
      r.customerId = null
      r.customerLabel = ''
      r.rootCustomerId = null
      continue
    }
    const l2 = findL2UnderRoot(rootId, r.deptName)
    if (l2) {
      r.customerId = l2.id
      r.rootCustomerId = rootId
      r.customerLabel = `${l2.parent_name ?? ''}${l2.parent_name ? ' / ' : ''}${l2.name}`
    } else {
      r.customerId = null
      r.rootCustomerId = null
      r.customerLabel = ''
    }
  }
}

async function onRootCustomerChange(): Promise<void> {
  // 清掉不属于新根的已选分厂（避免残留跨客户的 customerId）
  const validIds = new Set(subFactories.value.map((c) => c.id))
  for (const r of rows.value) {
    if (r.customerId && !validIds.has(r.customerId)) {
      r.customerId = null
      r.rootCustomerId = null
      r.customerLabel = ''
    }
  }
  resolveAllCustomers()
  await loadApplicantsForCustomer(form.rootCustomerId)
}

/** 分厂下拉变更：同步 rootCustomerId + customerLabel。 */
function onRowFactoryChange(row: ImportRow): void {
  if (!row.customerId) {
    row.rootCustomerId = null
    row.customerLabel = ''
    return
  }
  const sub = subFactories.value.find((c) => c.id === row.customerId)
  row.rootCustomerId = form.rootCustomerId
  row.customerLabel = sub
    ? `${sub.parent_name ? sub.parent_name + ' / ' : ''}${sub.name}`
    : ''
}

/** 申请人 autocomplete 选中：回填姓名。 */
function onApplicantSelect(row: ImportRow, item: Applicant): void {
  if (item?.name) row.applicantName = item.name
}

/** 构造一条空白可编辑行（手工补单用）。 */
function makeBlankRow(): ImportRow {
  return {
    rowNumber: 0,
    applicantName: '',
    drawingNo: '',
    partName: '',
    quantity: 1,
    unitPrice: 0,
    totalPrice: 0,
    isUrgent: false,
    deliveryDays: 0,
    plannedDeliveryDate: '',
    deptCode: '',
    deptName: '',
    designDrawingLabel: null,
    processTypeLabel: null,
    remarkText: null,
    warnings: [],
    uid: makeUid(),
    parserErrors: [],
    customerId: null,
    customerLabel: '',
    rootCustomerId: null,
    drawingFile: null,
    drawingName: null,
    drawingUrl: null,
    applicantId: null,
  }
}

function onAddBlankRow(): void {
  rows.value.push(makeBlankRow())
}

// ============================================================
// Excel 上传
// ============================================================

async function onExcelChange(uploadFile: UploadFile): Promise<void> {
  const raw = uploadFile.raw
  if (!raw) return
  // 替换文件 → 撤销旧 URL
  rows.value.forEach(revokeDrawingUrl)
  rows.value = []
  parsing.value = true
  try {
    const buf = await raw.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const result = parseBidExcel(wb, form.requestDate || todayIso())
    if (result.rows.length === 0) {
      ElMessage.warning('Excel 没有可识别的数据行')
      return
    }
    // 收集 parse 期错误（按 rowNumber 索引）
    const errByRow = new Map<number, string>()
    for (const e of result.errors) errByRow.set(e.rowNumber, e.message)
    rows.value = result.rows.map((bid) =>
      buildImportRow(bid, errByRow.get(bid.rowNumber) ? [errByRow.get(bid.rowNumber)!] : []),
    )
    resolveAllCustomers()
    await loadApplicantsForCustomer(form.rootCustomerId)
    const blocking = errorRowCount.value
    if (blocking > 0) {
      ElMessage.warning(
        `解析完成，共 ${rows.value.length} 行；其中 ${blocking} 行有错误，请修正后再提交`,
      )
    } else {
      ElMessage.success(`解析完成，共 ${rows.value.length} 行可提交`)
    }
  } catch (e) {
    ElMessage.error(`Excel 解析失败：${(e as Error).message}`)
    rows.value = []
  } finally {
    parsing.value = false
  }
}

// ============================================================
// 行操作
// ============================================================

function onRemoveRow(row: ImportRow): void {
  revokeDrawingUrl(row)
  rows.value = rows.value.filter((r) => r.uid !== row.uid)
}

function onClearAll(): void {
  if (rows.value.length === 0) return
  ElMessageBox.confirm(`确认清空 ${rows.value.length} 条预览记录？`, '提示', {
    confirmButtonText: '清空',
    cancelButtonText: '取消',
    type: 'warning',
  })
    .then(() => {
      rows.value.forEach(revokeDrawingUrl)
      rows.value = []
    })
    .catch(() => undefined)
}

function onRowDrawingChange(row: ImportRow, uploadFile: UploadFile): void {
  const raw = uploadFile.raw
  if (!raw) return
  if (row.drawingUrl) {
    try { URL.revokeObjectURL(row.drawingUrl) } catch { /* ignore */ }
  }
  row.drawingFile = raw
  row.drawingName = uploadFile.name
  row.drawingUrl = URL.createObjectURL(raw)
}
function onRowDrawingRemove(row: ImportRow): void {
  if (row.drawingUrl) {
    try { URL.revokeObjectURL(row.drawingUrl) } catch { /* ignore */ }
  }
  row.drawingFile = null
  row.drawingName = null
  row.drawingUrl = null
}

// ============================================================
// 图纸预览（弹窗内嵌 iframe，PDF 由浏览器原生渲染）
// ============================================================

const drawingPreviewVisible = ref(false)
const drawingPreviewUrl = ref<string | null>(null)
const drawingPreviewTitle = ref('图纸预览')

function openDrawingPreview(row: ImportRow): void {
  if (!row.drawingUrl || !row.drawingName) return
  drawingPreviewUrl.value = row.drawingUrl
  drawingPreviewTitle.value = `图纸预览 — ${row.drawingNo} / ${row.drawingName}`
  drawingPreviewVisible.value = true
}

// ============================================================
// 提交
// ============================================================

const submitting = ref(false)
const router = useRouter()

async function onSubmit(): Promise<void> {
  if (rows.value.length === 0) {
    ElMessage.warning('没有可提交的行')
    return
  }
  if (errorRowCount.value > 0) {
    ElMessage.error(`仍有 ${errorRowCount.value} 行错误，请先修正`)
    return
  }
  if (!form.rootCustomerId || !form.requestDate) {
    ElMessage.error('请先选择 L1 客户 + 请购日期')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将向服务端提交 ${rows.value.length} 条新零件，提交后系统按客户自动分配序列号。是否继续？`,
      '确认提交',
      { confirmButtonText: '提交', cancelButtonText: '取消', type: 'info' },
    )
  } catch {
    return
  }
  submitting.value = true
  try {
    // 1) dedupe (applicantName, customerId[L2]) → bulk get-or-create
    const uniqPairs = new Map<string, { name: string; customer_id: string }>()
    for (const r of rows.value) {
      if (!r.customerId) continue
      const key = `${r.applicantName}::${r.customerId}`
      if (!uniqPairs.has(key)) {
        uniqPairs.set(key, { name: r.applicantName, customer_id: r.customerId })
      }
    }
    const applicantItems = Array.from(uniqPairs.values())
    if (applicantItems.length === 0) {
      throw new Error('没有可用的申请人条目（所有行都缺申请人）')
    }
    const applicantsOut = await bulkGetOrCreateApplicants(applicantItems)
    // 索引：applicant_id by (applicantName, l1RootId)
    const applicantIdByKey = new Map<string, string>()
    for (const a of applicantsOut) {
      applicantIdByKey.set(`${a.name}::${a.customer_id}`, a.applicant_id)
    }

    // 2) 校验每行都能拿到 applicant_id
    for (const r of rows.value) {
      if (!r.customerId) continue
      const key = `${r.applicantName}::${r.rootCustomerId}`
      const aid = applicantIdByKey.get(key)
      if (!aid) {
        throw new Error(
          `无法为「${r.applicantName}」（${r.customerLabel}）解析 applicant_id`,
        )
      }
      r.applicantId = aid
    }

    // 3) 构造 PartCreatePayload[] + files
    const items: PartCreatePayload[] = rows.value.map((r) => ({
      name: r.partName,
      drawing_no: r.drawingNo,
      applicant_name: r.applicantName,
      applicant_id: r.applicantId,
      quantity: r.quantity,
      unit_price: r.unitPrice,
      total_price: r.totalPrice,
      request_date: form.requestDate,
      planned_delivery_date: r.plannedDeliveryDate,
      is_urgent: r.isUrgent,
      customer_id: r.customerId!,
    }))
    const files: (PartBatchFilePayload | null)[] = rows.value.map((r) =>
      r.drawingFile
        ? {
            data: r.drawingFile,
            filename: r.drawingName ?? 'drawing.pdf',
            contentType: 'application/pdf',
          }
        : null,
    )

    const res = await batchCreateParts(items, files)
    if (res.failed.length > 0) {
      const sample = res.failed
        .slice(0, 5)
        .map((f) => `第 ${f.index + 1} 行：${f.message}`)
        .join('\n')
      const more = res.failed.length > 5 ? `\n...还有 ${res.failed.length - 5} 行失败` : ''
      ElMessageBox.alert(
        `服务端拒绝了 ${res.failed.length} 行：\n${sample}${more}`,
        '部分行未通过',
        { type: 'warning' },
      )
      return
    }

    // 4) 释放所有 blob URL + 清空 + 跳转
    rows.value.forEach(revokeDrawingUrl)
    rows.value = []
    ElMessage.success(`成功新建 ${res.created.length} 条零件`)
    router.push({ path: '/parts', query: { status: 'PENDING' } })
  } catch (e) {
    ElMessage.error((e as Error).message ?? '提交失败')
  } finally {
    submitting.value = false
  }
}

// ============================================================
// 生命周期
// ============================================================

onBeforeUnmount(() => {
  rows.value.forEach(revokeDrawingUrl)
})

// 进页时拉客户列表
loadCustomers()
</script>

<style lang="scss" scoped>
.bid-import {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hint {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
  padding: 0 4px;
  code {
    background: #f5f7fa;
    padding: 1px 6px;
    border-radius: 3px;
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 12px;
  }
}

.control-card,
.preview-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}

.variety-banner {
  margin: 0;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
}

.empty-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
  color: var(--text-secondary);
  gap: 4px;
  .empty-primary {
    font-size: 14px;
    margin: 4px 0 0;
    color: var(--text-regular);
  }
  .empty-sub {
    font-size: 12px;
    margin: 0;
  }
}

.mono {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.muted {
  color: var(--text-secondary);
}

// 2026-08-27 T24：列设置工具条（与 PartListShell 同款）
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.row-error-text {
  color: var(--el-color-danger);
}

.warn-tag {
  margin-right: 4px;
  margin-bottom: 2px;
}

.row-ops {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 2px 6px;
}

.drawing-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  .drawing-name {
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
  }
}

.preview-frame-wrap {
  width: 100%;
  height: 100%;
  background: #f5f7fa;
}

:deep(.row-error) {
  background: #fde2e2 !important;
}
:deep(.row-urgent) {
  background: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
</style>
