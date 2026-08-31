<!--
  InspectionPending.vue — 品检待办一览（INSPECTION 状态的零件）

  - 顶部：图号/名称搜索 + 手动刷新 + 自动刷新（每 5min）+ 共 N 条
  - 每行两个动作：「品检通过」「指定工序」
  - 指定工序 → 弹出 el-dialog 选择目标 PRODUCTION 货架（el-radio-group）
  - 加急行整行红底 #fde2e2（与 PartsList 同款）
  - 2026-08-25 T14：filter 卡 + 列可见性 + 表格 + 分页 收口到 <PartListShell>；
    列定义 / 操作列仍在本文件；状态 / fetcher 走 useInspectionList composable。
-->
<template>
  <div class="inspection-pending">
    <PartListShell
      ref="listRef"
      :column-defs="columnDefs"
      :fetcher="fetcher"
      :list-key="'inspection_pending'"
      empty-text="当前无待品检零件"
      :row-class-name="rowClassName"
    >
      <template #filter>
        <el-input
          v-model="search.keyword"
          placeholder="图号 / 名称（前缀搜索）"
          clearable
          style="width: 260px"
          @keyup.enter="onRefresh"
          @clear="onRefresh"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <el-input
          v-model="search.serialNo"
          placeholder="序列号"
          clearable
          style="width: 180px"
          @keyup.enter="onRefresh"
          @clear="onRefresh"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <el-date-picker
          v-model="plannedDateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="~"
          start-placeholder="计划交期起点"
          end-placeholder="计划交期终点"
          unlink-panels
          clearable
          style="width: 280px"
          @change="onRefresh"
        />

        <el-checkbox v-model="autoRefresh" @change="onAutoRefreshToggle">
          自动刷新（5min）
        </el-checkbox>
      </template>

      <!-- 2026-08-27 T15：列定义全部走 columnDefs（PartListShell 自管 v-for 渲染）；
           不再写默认 slot。操作列放在 columnDefs 末尾。 -->
    </PartListShell>

    <!-- 品检通过对话框（2026-07-29：带数量；部分通过后端先拆再过） -->
    <el-dialog
      v-model="passDialogVisible"
      title="品检通过"
      :width="passDlg.width"
      :top="passDlg.top"
      :close-on-click-modal="false"
      @closed="onPassDialogClosed"
    >
      <div v-if="passTarget" class="fail-summary">
        <div><strong>流水号：</strong>{{ passTarget.serial_no || '—' }}</div>
        <div><strong>批次：</strong>{{ passTarget.batch_label || '—' }}</div>
        <div><strong>名称：</strong>{{ passTarget.name }}</div>
      </div>
      <el-form label-width="96px" style="margin-top: 12px">
        <el-form-item label="通过数量" required>
          <el-input-number
            v-model="passQty"
            :min="1"
            :max="passTarget?.quantity"
            :precision="0"
            style="width: 160px"
          />
          <span v-if="passTarget" class="muted" style="margin-left: 8px">
            / {{ passTarget.quantity }}
          </span>
        </el-form-item>
        <el-alert
          v-if="passTarget && passQty && passQty < passTarget.quantity"
          type="info"
          :closable="false"
          :title="`部分通过：剩余 ${passTarget.quantity - passQty} 件将留在品检状态`"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="passDialogVisible = false">取消</el-button>
        <el-button
          type="success"
          :loading="!!passTarget?._passing"
          :disabled="!passQty"
          @click="onPassConfirm"
        >确认通过</el-button>
      </template>
    </el-dialog>

    <!-- 指定工序对话框：先选下一道工序，再选目标生产货架（按 shelf↔process 映射过滤） -->
    <el-dialog
      v-model="failDialogVisible"
      title="指定工序 — 选择下一道工序 + 目标生产货架"
      :width="failDlg.width"
      :top="failDlg.top"
      :close-on-click-modal="false"
      @closed="onFailDialogClosed"
    >
      <div v-if="failTarget" class="fail-summary">
        <div><strong>流水号：</strong>{{ failTarget.serial_no || '—' }}</div>
        <div><strong>批次：</strong>{{ failTarget.batch_label || '—' }}</div>
        <div><strong>图号：</strong>{{ failTarget.drawing_no }}</div>
        <div><strong>名称：</strong>{{ failTarget.name }}</div>
      </div>

      <el-form label-width="96px" style="margin-top: 12px">
        <el-form-item label="数量" required>
          <el-input-number
            v-model="failQty"
            :min="1"
            :max="failTarget?.quantity"
            :precision="0"
            style="width: 160px"
          />
          <span v-if="failTarget" class="muted" style="margin-left: 8px">
            / {{ failTarget.quantity }}
          </span>
        </el-form-item>

        <el-form-item label="下一道工序" required>
          <el-select
            v-model="failProcessId"
            placeholder="请先选择下一道工序"
            filterable
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="p in filteredProcesses"
              :key="p.id"
              :value="String(p.id)"
              :label="`${p.code} — ${p.name}`"
            >
              {{ p.code }} — {{ p.name }}
              <el-tag v-if="p.category === 'OUTSOURCE'" type="warning" size="small" effect="plain" class="opt-tag">
                外协
              </el-tag>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="目标生产货架" required>
          <el-select
            v-model="failShelfId"
            placeholder="先选工序；货架候选按映射过滤"
            filterable
            clearable
            style="width: 100%"
            :disabled="!failProcessId"
          >
            <el-option
              v-for="s in filteredProductionShelves"
              :key="s.id"
              :value="String(s.id)"
              :label="`${s.code} — ${s.name}`"
              :disabled="!s.is_active"
            >
              {{ s.code }} — {{ s.name }}
              <span v-if="!s.is_active" class="muted">（已停用）</span>
            </el-option>
            <template #empty>
              <span class="muted">
                {{
                  failProcessId
                    ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                    : '请先选择下一道工序'
                }}
              </span>
            </template>
          </el-select>
        </el-form-item>

        <el-form-item label="品检备注">
          <el-input
            v-model="failNote"
            type="textarea"
            :rows="3"
            :maxlength="500"
            show-word-limit
            placeholder="不合格原因 / 返修要点（写入事件历史，工人领取时可见）"
          />
        </el-form-item>

        <el-alert
          type="info"
          :closable="false"
          title="指定工序后零件回到「在生产货架上」状态，下一道工序与备注已写入事件历史；工人领取时可在卡片上看到备注。"
          show-icon
        />
      </el-form>

      <template #footer>
        <el-button @click="failDialogVisible = false">取消</el-button>
        <el-button
          type="warning"
          :loading="failSubmitting"
          :disabled="!failProcessId || !failShelfId"
          @click="onFailConfirm"
        >确认指定工序</el-button>
      </template>
    </el-dialog>

    <!-- 2026-08-04：扫码命中 INSPECTION 行的二选一对话框（点按钮复用原 pass/fail dialog） -->
    <el-dialog
      v-model="scanChooserOpen"
      title="扫码命中 - 选择动作"
      width="420"
      :close-on-click-modal="false"
      append-to-body
    >
      <div v-if="scanChooserRow" class="fail-summary">
        <div><strong>流水号：</strong>{{ scanChooserRow.serial_no || '—' }}</div>
        <div><strong>批次：</strong>{{ scanChooserRow.batch_label || '—' }}</div>
        <div><strong>图号：</strong>{{ scanChooserRow.drawing_no }}</div>
        <div><strong>名称：</strong>{{ scanChooserRow.name }}</div>
        <div><strong>数量：</strong>{{ scanChooserRow.quantity }}</div>
      </div>
      <template #footer>
        <el-button @click="scanChooserOpen = false">取消</el-button>
        <el-button type="warning" @click="onScanChooserFail">指定下一工序</el-button>
        <el-button type="success" @click="onScanChooserPass">品检通过</el-button>
      </template>
    </el-dialog>

    <!-- 2026-08-12 PR-I-scan-inspect：扫码快捷品检弹窗（PENDING / PROGRAMMING / IN_PROCESS+ON_SHELF → INSPECTION，仅送检；FAIL 走「待品检」页面指定工序） -->
    <el-dialog
      v-model="scanInspectDialogVisible"
      title="扫码快捷品检 — 送检到品检架"
      :width="scanInspectDlg.width"
      :top="scanInspectDlg.top"
      :close-on-click-modal="false"
      append-to-body
      @closed="onScanInspectDialogClosed"
    >
      <div v-if="scanInspectRow" class="fail-summary">
        <div><strong>流水号：</strong>{{ scanInspectRow.serial_no || '—' }}</div>
        <div><strong>批次：</strong>{{ scanInspectRow.batch_label || '—' }}</div>
        <div><strong>图号：</strong>{{ scanInspectRow.drawing_no }}</div>
        <div><strong>名称：</strong>{{ scanInspectRow.name }}</div>
        <div>
          <strong>当前状态：</strong>
          <el-tag size="small" :type="scanInspectRow.status === 'PENDING' ? 'info' : 'primary'">
            {{ scanInspectRow.status === 'PENDING' ? '待下发' : scanInspectRow.status === 'PROGRAMMING' ? '编程中' : '生产中' }}
          </el-tag>
        </div>
      </div>

      <el-form label-width="96px" style="margin-top: 12px">
        <el-form-item label="品检架" required>
          <el-select
            v-model="scanInspectShelfId"
            placeholder="请选择目标品检架"
            filterable
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="s in inspectionShelves"
              :key="s.id"
              :value="String(s.id)"
              :label="`${s.code} — ${s.name}`"
            >
              {{ s.code }} — {{ s.name }}
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="数量">
          <el-input-number
            v-model="scanInspectQty"
            :min="1"
            :max="scanInspectRow?.quantity"
            :precision="0"
            style="width: 160px"
          />
          <span v-if="scanInspectRow" class="muted" style="margin-left: 8px">
            / {{ scanInspectRow.quantity }}
          </span>
        </el-form-item>

        <el-alert
          type="info"
          :closable="false"
          title="快捷品检将一次性把零件搬到品检架，完成送检。零件送检后可在「待品检」页面选择「品检通过」或「指定工序」完成后续流转。"
          show-icon
        />
      </el-form>

      <template #footer>
        <el-button @click="scanInspectDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="scanInspectSubmitting"
          :disabled="!scanInspectShelfId"
          @click="onScanInspectConfirm"
        >确认送检</el-button>
      </template>
    </el-dialog>

    <!-- 2026-08-31：扫码命中同一 serial 多批次时弹 ScanBatchPickerDialog（v2 by-serial 端点）。 -->
    <!-- part 运行时仅在 openScanBatchPicker 设置后才打开弹窗，type cast 安全。 -->
    <ScanBatchPickerDialog
      v-model="showScanBatchPicker"
      :code="scanBatchPickerCode"
      :part="scanBatchPickerPart as PartScanInfoOut"
      :batches="scanBatchPickerBatches"
      @pick="onScanBatchPicked"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, type VNode } from 'vue'
import { ElButton, ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { RouterLink, useRouter } from 'vue-router'
import PartListShell from '@/components/PartListShell.vue'
import type { ColumnDef } from '@/composables/useColumnVisibility'
import { useConfirm } from '@/composables/useConfirm'
import { useDialogSize } from '@/composables/useDialogSize'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import {
  findAllByCode,
  findPartBySerialAndPrompt,
} from '@/utils/scanHelpers'
import {
  failInspection,
  getPartBySerial,
  toInspection,
  toShip,
  type PartItem,
} from '@/api/parts'
import { listShelves } from '@/api/shelves'
import { listProcesses } from '@/api/process'
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter'
import type { Shelf } from '@/types/shelf'
import type { Process } from '@/types/process'
// 2026-08-31 改：扫码多批次命中改走 v2 by-serial 端点 + ScanBatchPickerDialog（路线 B）。
import ScanBatchPickerDialog from './components/ScanBatchPickerDialog.vue'
import { getPartBatchesBySerial } from '@/api/parts/batch'
import type { PartBatchScanOut, PartScanInfoOut } from '@/types/parts'
import { useInspectionList } from './composables/useInspectionList'

// ============ 状态 ============
interface RowState extends PartItem {
  _passing?: boolean
}

// ============ T14：列表状态（filter / fetcher）+ 列可见性 ============
// 2026-08-27 T15：列定义全部走 columnDefs 配置数组（之前写在 template 默认 slot 的内联列已迁出）。
// 列可见性由 PartListShell 内部 useColumnVisibility 持有；PartListShell 自管 v-for 渲染，
// 自定义单元格通过 cellRender(scope) 注入。操作列也放进 defs，draggable=false 防误拖。
const router = useRouter()

// ---------- 自定义单元格渲染 ----------
// 参数 row 在 ColumnDef 接口里是 unknown；cast 到 PartItem / RowState 以访问业务字段。
// 保留旧实现的全部行为：muted 灰底占位、router-link、conditional render、按钮组。
function renderSerialNo({ row }: { row: unknown }): VNode {
  const r = row as PartItem
  return h('span', { class: { muted: !r.serial_no } }, r.serial_no || '—')
}

function renderName({ row }: { row: unknown }): VNode {
  const r = row as PartItem
  return h(
    RouterLink,
    { to: `/parts/${r.id}`, class: 'name-link' },
    () => r.name,
  )
}

function renderBatchLabel({ row }: { row: unknown }): VNode {
  const r = row as PartItem
  return h('span', { class: 'batch-label' }, r.batch_label || '—')
}

function renderSystemDeliveryDate({ row }: { row: unknown }): VNode {
  const r = row as PartItem
  return h(
    'span',
    { class: { muted: !r.system_delivery_date } },
    r.system_delivery_date || '—',
  )
}

function renderCustomer({ row }: { row: unknown }): VNode {
  const r = row as PartItem
  if (r.customer_path) return h('span', r.customer_path)
  if (r.customer_name) return h('span', { class: 'muted' }, r.customer_name)
  return h('span', { class: 'muted' }, '—')
}

function renderShelfCode({ row }: { row: unknown }): VNode {
  const r = row as PartItem
  if (r.shelf_code) return h('span', `品检 ${r.shelf_code}`)
  return h('span', { class: 'muted' }, '—')
}

function renderActions({ row }: { row: unknown }): VNode {
  const r = row as RowState
  return h('div', null, [
    h(
      ElButton,
      {
        link: true,
        type: 'success',
        size: 'small',
        loading: r._passing,
        onClick: () => onPass(r),
      },
      () => '品检通过',
    ),
    h(
      ElButton,
      {
        link: true,
        type: 'warning',
        size: 'small',
        onClick: () => openFailDialog(r),
      },
      () => '指定工序',
    ),
    h(
      ElButton,
      {
        link: true,
        type: 'primary',
        size: 'small',
        onClick: () => router.push(`/parts/${r.id}`),
      },
      () => '详情',
    ),
  ])
}

// ---------- 列定义 ----------
// 字段顺序 = 初始渲染顺序。fixed / type=expand 不参与拖动；操作列 draggable: false 防误拖。
// 行为与原内联 <el-table-column> 完全一致：min-width / fixed / show-overflow-tooltip / align / cellRender。
const columnDefs: ColumnDef[] = [
  {
    key: 'serial_no',
    label: '序列号',
    columnKey: 'serial_no',
    prop: 'serial_no',
    minWidth: 110,
    fixed: 'left',
    showOverflowTooltip: true,
    align: 'center',
    cellRender: renderSerialNo,
  },
  {
    key: 'drawing_no',
    label: '图号',
    columnKey: 'drawing_no',
    prop: 'drawing_no',
    minWidth: 130,
    fixed: 'left',
    showOverflowTooltip: true,
    align: 'center',
  },
  {
    key: 'name',
    label: '名称',
    columnKey: 'name',
    prop: 'name',
    minWidth: 200,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: renderName,
  },
  {
    key: 'batch_label',
    label: '批次',
    columnKey: 'batch_label',
    minWidth: 100,
    align: 'center',
    cellRender: renderBatchLabel,
  },
  {
    key: 'quantity',
    label: '批次量',
    columnKey: 'quantity',
    prop: 'quantity',
    minWidth: 80,
    align: 'right',
  },
  {
    key: 'planned_delivery_date',
    label: '计划交期',
    columnKey: 'planned_delivery_date',
    prop: 'planned_delivery_date',
    minWidth: 120,
    align: 'center',
  },
  {
    key: 'system_delivery_date',
    label: '系统交期',
    columnKey: 'system_delivery_date',
    prop: 'system_delivery_date',
    minWidth: 120,
    align: 'center',
    cellRender: renderSystemDeliveryDate,
  },
  {
    key: 'customer',
    label: '客户',
    columnKey: 'customer',
    minWidth: 180,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: renderCustomer,
  },
  {
    key: 'shelf_code',
    label: '品检货架',
    columnKey: 'shelf_code',
    minWidth: 150,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: renderShelfCode,
  },
  {
    key: 'actions',
    label: '操作',
    columnKey: 'actions',
    minWidth: 220,
    fixed: 'right',
    align: 'center',
    draggable: false,
    cellRender: renderActions,
  },
]

const {
  search,
  plannedDateRange,
  autoRefresh,
  fetcher,
  restoreFilter,
} = useInspectionList()

// PartListShell 的 ref；扫码匹配遍历当前页 items 用 listRef.value.items.value。
const listRef = ref()

function rowClassName({ row }: { row: PartItem; rowIndex: number }): string {
  return row.is_urgent ? 'row-urgent' : ''
}

// 「刷新」按钮 = 列表回到第 1 页再拉（PartListShell.onRefresh = reset()）
async function onRefresh(): Promise<void> {
  await listRef.value?.onRefresh()
}

// 其它地方仍调 fetchList() 触发刷新（包装 listRef.fetch()，保持当前页码）
async function fetchList(): Promise<void> {
  await listRef.value?.fetch()
}

// ============ 自动刷新 ============
let autoRefreshTimer: number | null = null

function onAutoRefreshToggle(val: string | number | boolean): void {
  if (autoRefreshTimer !== null) {
    window.clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  if (val) {
    autoRefreshTimer = window.setInterval(() => {
      fetchList()
    }, 300_000)
  }
}

onBeforeUnmount(() => {
  if (autoRefreshTimer !== null) {
    window.clearInterval(autoRefreshTimer)
  }
  // 2026-08-04：扫码订阅退订
  unsubInspectionScan()
})

// ============ 2026-08-04：扫码枪扫描序列号 → 二选一弹框 / 报工台风格位置提示 ============
//
// 扫码命中 INSPECTION 行（serial_no || drawing_no 在当前列表里匹配且状态=INSPECTION）：
//   - 1 条命中 → 弹「品检通过 / 指定下一工序」二选一对话框
//   - 多条命中（同 serial 不同 batch）→ 弹 BatchPickerDialog 选具体批次再走二选一
//   - 0 命中（零件不在 INSPECTION 状态或根本不存在）→ 走 findPartBySerialAndPrompt
//     显示当前位置 / 持有人 / 状态 / 下一工序，提示「该零件不在本工序」。
// 已有 dialog 显示时不抢流程。
const scanChooserOpen = ref(false)
const scanChooserRow = ref<RowState | null>(null)
// 2026-08-31 改：扫码多批次命中改走 v2 by-serial 端点弹 ScanBatchPickerDialog；以下 5 个 ref 替代旧 BatchPickerDialog 三件套。
const showScanBatchPicker = ref(false)
const scanBatchPickerCode = ref('')
const scanBatchPickerPart = ref<PartScanInfoOut | null>(null)
const scanBatchPickerBatches = ref<PartBatchScanOut[]>([])
const scanBatchPickerLoading = ref(false)

async function onInspectionScan(rawCode: string): Promise<void> {
  const code = rawCode.trim()
  if (!code) return
  // 已有 dialog 在显示时不抢流程
  if (
    passDialogVisible.value ||
    failDialogVisible.value ||
    scanChooserOpen.value ||
    scanInspectDialogVisible.value ||
    showScanBatchPicker.value
  ) {
    return
  }
  // 快速路径：在当前已加载列表里按 serial_no || drawing_no 匹配（不限状态，按命中的状态分流）
  const matches = findAllByCode(
    (listRef.value?.items.value ?? []) as unknown as PartItem[],
    code,
  )
  if (matches.length === 0) {
    // 0 命中 — PENDING / PROGRAMMING / IN_PROCESS+ON_SHELF 永远不会出现在 inspection 一览；
    // 调 getPartBySerial 按 serial_no 查任意状态零件，再按状态路由。
    try {
      const part = await getPartBySerial(code)
      routeScannedPart(part)
    } catch {
      // 404 / 网络错误 → 走 helper 显示「未找到」warning + 位置提示
      await findPartBySerialAndPrompt(code)
    }
    return
  }
  if (matches.length > 1) {
    // 2026-08-31 改：调 v2 by-serial 端点拿所有批次，弹 ScanBatchPickerDialog（路线 B 配套组件）。
    await openScanBatchPicker(code)
    return
  }
  // 单条命中 — 按状态路由
  routeScannedPart(matches[0])
}

// 2026-08-31 改：v2 by-serial 弹窗拉批次入口。
// - 0 批次 → 走 findPartBySerialAndPrompt 显示「未找到」提示
// - 1 批次 → 跳过对话框，直接合成 PartItem 路由（用户决策：单批次免打扰）
// - 多批次 → 设 part/batches 后 showScanBatchPicker = true
// - 异常（端点失败 / 404 等）→ 走 getPartBySerial / findPartBySerialAndPrompt 兜底
async function openScanBatchPicker(code: string): Promise<void> {
  scanBatchPickerLoading.value = true
  scanBatchPickerCode.value = code
  try {
    const ctx = await getPartBatchesBySerial(code)
    if (ctx.batches.length === 0) {
      await findPartBySerialAndPrompt(code)
      return
    }
    // 2026-08-31 用户决策：1 批次跳过对话框，直接合成 PartItem 路由
    if (ctx.batches.length === 1) {
      routeScannedPart(toPickedPartItem(ctx.part, ctx.batches[0]!))
      return
    }
    // 多批次弹新对话框
    scanBatchPickerPart.value = ctx.part
    scanBatchPickerBatches.value = ctx.batches
    showScanBatchPicker.value = true
  } catch {
    await findPartBySerialAndPrompt(code)
  } finally {
    scanBatchPickerLoading.value = false
  }
}

// 2026-08-31：把 v2 响应顶层 part + 单条 batch 合成为 routeScannedPart 用的最小 PartItem。
// routeScannedPart 仅依赖 status / location / id / version / batch_id / worker_name；其它字段允许默认值，
// 下游弹窗不强制校验。location=null 不会误判为 PRODUCTION_SHELF（实际由 status 决定路由分支）。
function toPickedPartItem(p: PartScanInfoOut, b: PartBatchScanOut): PartItem {
  return {
    id: p.id,
    version: b.version,
    serial_no: null,
    name: p.name,
    drawing_no: p.drawing_no,
    quantity: b.quantity,
    planned_delivery_date: '',
    actual_delivery_date: null,
    is_urgent: p.is_urgent,
    status: b.status,
    order_no: p.order_no,
    system_delivery_date: p.system_delivery_date,
    note: p.note,
    customer_name: null,
    parent_customer_name: null,
    customer_path: null,
    delivery_note_id: null,
    delivery_note_no: null,
    delivery_note_status: null,
    assembly_id: null,
    current_holder_id: null,
    current_holder_kind: null,
    shelf_code: null,
    worker_name: b.holder_name,
    outsource_company_name: null,
    location: null,
    current_holder_display: b.holder_name ?? null,
    placed_at: null,
    next_process_id: null,
    next_process_name: null,
    last_inspection_fail_note: null,
    batch_id: b.id,
    // v2 响应没有 batch_no；字段为 optional，undefined 即可。
    batch_no: undefined,
    batch_label: null,
    has_been_repaired: false,
  }
}

// 统一扫码路由：列表命中 / getPartBySerial fallback / BatchPicker 三处共用
// - INSPECTION → 原有二选一弹窗（点按钮复用原 pass/fail dialog）
// - PENDING / PROGRAMMING / IN_PROCESS+PRODUCTION_SHELF → 扫码快捷品检（新弹窗）
// - 其他（IN_PROCESS+WORKER / READY_TO_SHIP / DELIVERED / REPAIRING / OUTSOURCE）→ 降级提示
function routeScannedPart(part: PartItem): void {
  const row = part as unknown as RowState
  if (part.status === 'INSPECTION') {
    scanChooserRow.value = row
    scanChooserOpen.value = true
  } else if (
    part.status === 'PENDING' ||
    part.status === 'PROGRAMMING' ||
    (part.status === 'IN_PROCESS' && part.location === 'PRODUCTION_SHELF')
  ) {
    openScanInspectDialog(row)
  } else {
    void findPartBySerialAndPrompt(part.serial_no ?? part.drawing_no ?? '')
  }
}

function onScanChooserPass(): void {
  const row = scanChooserRow.value
  scanChooserOpen.value = false
  scanChooserRow.value = null
  if (row) onPass(row)  // 复用现有 onPass：弹原 pass dialog
}

function onScanChooserFail(): void {
  const row = scanChooserRow.value
  scanChooserOpen.value = false
  scanChooserRow.value = null
  if (row) void openFailDialog(row)  // 复用现有 openFailDialog
}

// 2026-08-31 改：ScanBatchPickerDialog.pick 回调用 —— 合成 PartItem 后走统一扫码路由。
function onScanBatchPicked(payload: { batch: PartBatchScanOut; part: PartScanInfoOut }): void {
  const item = toPickedPartItem(payload.part, payload.batch)
  routeScannedPart(item)
}

const { onScan } = useBarcodeScanner()
const unsubInspectionScan = onScan((code) => { void onInspectionScan(code) })

// ============ 品检通过（2026-07-29：带数量，部分通过先拆再过）============
const passDlg = useDialogSize({ desktopWidth: 420 })
const passDialogVisible = ref(false)
const passTarget = ref<RowState | null>(null)
const passQty = ref<number | undefined>(undefined)

function onPass(row: RowState): void {
  passTarget.value = row
  passQty.value = row.quantity
  passDialogVisible.value = true
}

function onPassDialogClosed(): void {
  passTarget.value = null
  passQty.value = undefined
}

async function onPassConfirm(): Promise<void> {
  const row = passTarget.value
  if (!row || !passQty.value) return
  // 2026-08-29：caller OCC 锚 t_part_batch —— row.version 已是 batch version（list 行对齐）。
  // row.batch_id / row.version 来自 listInspectionBatches 的行（雪花 ID 字符串 + batch version）。
  if (!row.batch_id || row.version === undefined) {
    ElMessage.error('该行缺少批次信息，无法送检。请刷新列表后重试')
    return
  }
  row._passing = true
  try {
    const out = await toShip(row.id, {
      batch_id: row.batch_id,
      version: row.version,
      quantity: passQty.value,
    })
    ElMessage.success(
      `零件 ${out.part.serial_no || out.part.drawing_no} 品检通过 × ${passQty.value}`,
    )
    passDialogVisible.value = false
    await fetchList()
  } catch (e) {
    // 40901：批次 version 不匹配
    if ((e as { code?: number }).code === 40901) {
      ElMessage.warning('该批次已被他人修改，请刷新后重试')
      void fetchList()
    } else {
      ElMessage.error(`品检通过失败：${(e as Error).message}`)
    }
  } finally {
    row._passing = false
  }
}

// ============ 指定工序对话框 ============
// 2026-07-21 改：先选下一道工序，再选目标生产货架（按 shelf↔process 映射过滤）。
// 同时支持可选「品检备注」，写入 t_part_event.note，事件历史与工人领取卡片均可见。
const failDlg = useDialogSize({ desktopWidth: 520 })
const failDialogVisible = ref(false)
const failTarget = ref<RowState | null>(null)
const failProcessId = ref<string>('')
const failShelfId = ref<string>('')
const failNote = ref<string>('')
const failQty = ref<number | undefined>(undefined)
const failSubmitting = ref(false)
const productionShelves = ref<Shelf[]>([])

const { dangerous: confirmDangerous } = useConfirm()
const processes = ref<Process[]>([])
const inspectionShelves = ref<Shelf[]>([])  // 2026-08-12 PR-I-scan-inspect：扫码快捷品检品检架选项
// 指定工序默认走 INHOUSE 工序（外协工序走 send_to_outsource 路径）；
// 不强制过滤 category，避免业务上「品检后直接外协返修」分支被锁死。
const {
  filteredShelves: filteredProductionShelves,
  filteredProcesses,
  load: loadShelfProcessMap,
} = useShelfProcessFilter(
  productionShelves,
  processes,
  computed({
    get: () => failShelfId.value || null,
    set: (v) => { failShelfId.value = v ?? '' },
  }),
  computed({
    get: () => failProcessId.value || null,
    set: (v) => { failProcessId.value = v ?? '' },
  }),
)

async function loadProductionShelves(): Promise<void> {
  try {
    const resp = await listShelves({ zone: 'PRODUCTION', is_active: true, limit: 200 })
    productionShelves.value = resp.items
  } catch (e) {
    ElMessage.error(`加载生产货架失败：${(e as Error).message}`)
    productionShelves.value = []
  }
}

async function loadProcesses(): Promise<void> {
  try {
    const resp = await listProcesses({ limit: 200 })
    processes.value = resp.items
  } catch (e) {
    ElMessage.error(`加载工序失败：${(e as Error).message}`)
    processes.value = []
  }
}

// ============ 2026-08-12 PR-I-scan-inspect：扫码快捷品检 ============
// 命中 PENDING / PROGRAMMING / IN_PROCESS+PRODUCTION_SHELF 时弹本对话框，
// 一步完成：搬到品检架（路线 B inspection 不支持 FAIL 直接打回，FAIL 路径需到「待品检」页面走「指定工序」）。
const scanInspectDlg = useDialogSize({ desktopWidth: 520 })
const scanInspectDialogVisible = ref(false)
const scanInspectRow = ref<RowState | null>(null)
const scanInspectShelfId = ref<string>('')         // 目标品检架
const scanInspectQty = ref<number | undefined>(undefined)
const scanInspectSubmitting = ref(false)

async function loadInspectionShelves(): Promise<void> {
  try {
    const resp = await listShelves({ zone: 'INSPECTION', is_active: true, limit: 200 })
    inspectionShelves.value = resp.items
  } catch (e) {
    ElMessage.error(`加载品检货架失败：${(e as Error).message}`)
    inspectionShelves.value = []
  }
}

async function openScanInspectDialog(row: RowState): Promise<void> {
  scanInspectRow.value = row
  scanInspectShelfId.value = ''
  scanInspectQty.value = row.quantity
  scanInspectDialogVisible.value = true
  // 只加载品检架候选；FAIL 分支已移除，不再需要 productionShelves / processes。
  if (inspectionShelves.value.length === 0) {
    await loadInspectionShelves()
  }
}

function onScanInspectDialogClosed(): void {
  scanInspectRow.value = null
  scanInspectShelfId.value = ''
  scanInspectQty.value = undefined
}

async function onScanInspectConfirm(): Promise<void> {
  const row = scanInspectRow.value
  if (!row) return
  if (!scanInspectShelfId.value) {
    ElMessage.warning('请选择品检架')
    return
  }
  // 2026-08-29：caller OCC 锚 t_part_batch —— row.version 已是 batch version（list 行对齐）。
  if (!row.batch_id || row.version === undefined) {
    ElMessage.error('该行缺少批次信息，无法送检。请刷新列表后重试')
    return
  }
  scanInspectSubmitting.value = true
  try {
    // 2026-08-28 路线 B inspection 重构：scan-inspect 只送检到品检架，
    // FAIL 直接打回不支持——送检后到「待品检」页面走「指定工序」（failInspection）。
    const out = await toInspection(row.id, {
      target_inspection_shelf_id: scanInspectShelfId.value,
      batch_id: row.batch_id,
      version: row.version,
      quantity: scanInspectQty.value ?? null,
    })
    const shelfCode =
      inspectionShelves.value.find((s) => String(s.id) === scanInspectShelfId.value)?.code ?? ''
    ElMessage.success(
      `零件 ${out.part.serial_no || out.part.drawing_no} 已快捷送检${shelfCode ? `到 ${shelfCode}` : ''}`,
    )
    scanInspectDialogVisible.value = false
    await fetchList()
  } catch (e) {
    // 40901：批次 version 不匹配
    if ((e as { code?: number }).code === 40901) {
      ElMessage.warning('该批次已被他人修改，请刷新后重试')
      void fetchList()
    } else {
      ElMessage.error(`快捷品检失败：${(e as Error).message}`)
    }
  } finally {
    scanInspectSubmitting.value = false
  }
}

async function openFailDialog(row: RowState): Promise<void> {
  failTarget.value = row
  failProcessId.value = ''
  failShelfId.value = ''
  failNote.value = ''
  failQty.value = row.quantity
  failDialogVisible.value = true
  await Promise.all([
    productionShelves.value.length === 0 ? loadProductionShelves() : Promise.resolve(),
    processes.value.length === 0 ? loadProcesses() : Promise.resolve(),
  ])
  // shelves/processes 加载完后异步拉映射；映射未到位前 filteredXxx 走兜底全量
  void loadShelfProcessMap()
}

function onFailDialogClosed(): void {
  failTarget.value = null
  failProcessId.value = ''
  failShelfId.value = ''
  failNote.value = ''
  failQty.value = undefined
}

async function onFailConfirm(): Promise<void> {
  if (!failTarget.value || !failProcessId.value || !failShelfId.value) return
  const row = failTarget.value
  const shelfCode =
    productionShelves.value.find((s) => String(s.id) === failShelfId.value)?.code ?? ''
  const processCode =
    processes.value.find((p) => String(p.id) === failProcessId.value)?.code ?? ''
  if (!await confirmDangerous(
    '指定工序',
    `确认指定工序「${row.name}」（${row.serial_no || row.drawing_no}）到生产货架 ${shelfCode}，下一道工序 ${processCode}？`,
    { type: 'warning', confirmText: '确认指定工序', cancelText: '取消' },
  )) return  // 用户取消
  failSubmitting.value = true
  try {
    // 2026-08-29：回退到 v1 fail-inspection（v2 to-process 不在 Rust 上线范围）。
    const out = await failInspection(row.id, {
      shelf_id: failShelfId.value,
      next_process_id: failProcessId.value,
      note: failNote.value.trim() || null,
      batch_id: row.batch_id ?? null,
      quantity: failQty.value ?? null,
    })
    ElMessage.success(
      `零件 ${out.serial_no || out.drawing_no} 已指定下一道工序 ${processCode}，放到生产货架 ${shelfCode}`,
    )
    failDialogVisible.value = false
    await fetchList()
  } catch (e) {
    ElMessage.error(`指定工序失败：${(e as Error).message}`)
  } finally {
    failSubmitting.value = false
  }
}

onMounted(() => {
  // 先尝试恢复 localStorage 中的搜索条件 / 自动刷新（pageSize 由 PartListShell 自行恢复）
  restoreFilter()
  if (autoRefresh.value) {
    // 重新挂载定时器
    onAutoRefreshToggle(true)
  }
  fetchList()
})
</script>

<style lang="scss" scoped>
.inspection-pending {
  padding: 0;
}
.name-link {
  color: var(--el-color-primary);
  text-decoration: none;
}
.name-link:hover {
  text-decoration: underline;
}
.muted {
  color: var(--text-secondary);
}
.fail-summary {
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 4px;
  padding: 10px 14px;
  line-height: 1.8;
  font-size: 13px;
}
.opt-tag {
  margin-left: 6px;
}

.batch-label {
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
  font-weight: 600;
}
</style>
