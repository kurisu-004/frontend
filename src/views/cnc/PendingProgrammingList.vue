<!--
  PendingProgrammingList.vue — 待编程一览（status=PROGRAMMING 的零件）

  业务背景（2026-07-14 / 2026-07-20）
  ====================
  - 菜单侧：CNC 编程员专属入口；侧栏只挂「待编程一览」（顶层菜单）。
  - 数据侧：调 GET /parts/pending-programming（status=PROGRAMMING 已硬编码于后端）。
  - 两个动作（2026-07-20 移除「文件」按钮 + el-drawer，理由：「df6b4d8 引入的过度设计」）
    * 「详情」 → 跳 /parts/{id}（PartDetail 页内有图纸下载 / G 代码上传 / 设定单上传）
    * 「下发到生产」 → 弹 el-dialog 同时选下一道工序 + 目标 PRODUCTION 货架，
      调 POST /parts/{id}/release-from-programming（PROGRAMMING → IN_PROCESS）。
  - 加急行整行红底 #fde2e2（与 PartsList / InspectionPending 同款）。
  - 自动刷新（5min）按需勾选。
  - 2026-08-25 T14：filter 卡 + 列可见性 + 表格 + 分页 收口到 <PartListShell>；
    列定义 / 操作列仍在本文件；状态 / fetcher 走 usePendingProgrammingList composable。
-->
<template>
  <div class="pending-programming">
    <PartListShell
      ref="listRef"
      :column-defs="columnDefs"
      :fetcher="fetcher"
      :list-key="'pending_programming'"
      empty-text="当前无待编程零件"
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

        <el-checkbox v-model="autoRefresh" @change="onAutoRefreshToggle">
          自动刷新（5min）
        </el-checkbox>
      </template>

      <!-- 2026-08-27 T15：列定义全部走 columnDefs（PartListShell 自管 v-for 渲染）；
           不再写默认 slot。操作列放在 columnDefs 末尾。 -->
    </PartListShell>

    <!-- 下发到 CNC 货架 对话框（PROGRAMMING → IN_PROCESS） —— 与 PartDetail 同款 -->
    <el-dialog
      v-model="releaseDialogVisible"
      title="下发到 CNC 货架"
      :width="releaseDlg.width"
      :top="releaseDlg.top"
      @closed="onReleaseDialogClosed"
    >
      <el-form label-width="96px">
        <el-form-item label="下一道工序" required>
          <el-select
            v-model="releaseProcessId"
            placeholder="请先选择下一道工序"
            style="width: 100%"
            filterable
            clearable
          >
            <el-option
              v-for="p in filteredInhouseProcesses"
              :key="p.id"
              :label="`${p.code} / ${p.name}`"
              :value="p.id"
            />
            <template #empty>
              <span class="muted">没有可用的工序</span>
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="目标生产货架" required>
          <el-select
            v-model="releaseShelfId"
            placeholder="先选工序；货架候选按映射过滤"
            style="width: 100%"
            filterable
            clearable
            :disabled="!releaseProcessId"
          >
            <el-option
              v-for="s in filteredProductionShelves"
              :key="s.id"
              :label="`${s.code} — ${s.name}`"
              :value="s.id"
              :disabled="!s.is_active"
            >
              <span>{{ s.code }} — {{ s.name }}</span>
              <span v-if="!s.is_active" class="muted">（已停用）</span>
            </el-option>
            <template #empty>
              <span class="muted">
                {{
                  releaseProcessId
                    ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                    : '请先选择下一道工序'
                }}
              </span>
            </template>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="releaseDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="releaseSubmitting"
          :disabled="!releaseShelfId || !releaseProcessId"
          @click="onReleaseConfirm"
        >确认下发</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, type VNode } from 'vue'
import { ElButton, ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { RouterLink, useRouter } from 'vue-router'
import PartListShell from '@/components/PartListShell.vue'
import type { ColumnDef } from '@/composables/useColumnVisibility'
import { useDialogSize } from '@/composables/useDialogSize'
import { releaseFromProgramming } from '@/api/parts'
import { listShelves } from '@/api/shelves'
import { listProcesses } from '@/api/process'
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter'
import type { PartListItem } from '@/types/parts'
import type { Shelf } from '@/types/shelf'
import type { Process } from '@/types/process'
import { usePendingProgrammingList } from './composables/usePendingProgrammingList'

// ============ 列表状态 ============
interface RowState extends PartListItem {
  _releasing?: boolean
}

// ============ T14：列表状态（filter / fetcher）+ 列可见性 ============
// 2026-08-27 T15：列定义全部走 columnDefs 配置数组（之前写在 template 默认 slot 的内联列已迁出）。
// 列可见性由 PartListShell 内部 useColumnVisibility 持有；PartListShell 自管 v-for 渲染，
// 自定义单元格通过 cellRender(scope) 注入。操作列也放进 defs，draggable=false 防误拖。
const router = useRouter()

// ---------- 自定义单元格渲染 ----------
// 参数 row 在 ColumnDef 接口里是 unknown；cast 到 PartListItem / RowState 以访问业务字段。
// 保留旧实现的全部行为：muted 灰底占位、router-link、conditional render、按钮组。
function renderSerialNo({ row }: { row: unknown }): VNode {
  const r = row as PartListItem
  return h('span', { class: { muted: !r.serial_no } }, r.serial_no || '—')
}

function renderName({ row }: { row: unknown }): VNode {
  const r = row as PartListItem
  return h(
    RouterLink,
    { to: `/parts/${r.id}`, class: 'name-link' },
    () => r.name,
  )
}

function renderCustomer({ row }: { row: unknown }): VNode {
  const r = row as PartListItem
  if (r.customer_path) return h('span', r.customer_path)
  if (r.customer_name) return h('span', { class: 'muted' }, r.customer_name)
  return h('span', { class: 'muted' }, '—')
}

function renderActions({ row }: { row: unknown }): VNode {
  const r = row as RowState
  return h('div', null, [
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
    h(
      ElButton,
      {
        link: true,
        type: 'success',
        size: 'small',
        loading: r._releasing,
        onClick: () => openReleaseDialog(r),
      },
      () => '下发',
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
    key: 'quantity',
    label: '数量',
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
    key: 'customer',
    label: '客户',
    columnKey: 'customer',
    minWidth: 180,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: renderCustomer,
  },
  {
    key: 'actions',
    label: '操作',
    columnKey: 'actions',
    minWidth: 160,
    fixed: 'right',
    align: 'center',
    draggable: false,
    cellRender: renderActions,
  },
]

const {
  search,
  autoRefresh,
  fetcher,
  restoreFilter,
} = usePendingProgrammingList()

// PartListShell 的 ref；后续可按需读 items.value / total.value。
const listRef = ref()

function rowClassName({ row }: { row: PartListItem; rowIndex: number }): string {
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
})

// ============ 下发到 CNC 货架 对话框 ============
const releaseDlg = useDialogSize({ desktopWidth: 440 })
const releaseDialogVisible = ref(false)
const releaseTarget = ref<RowState | null>(null)
const releaseShelfId = ref<string | null>(null)
const releaseProcessId = ref<string | null>(null)
const releaseSubmitting = ref(false)
const productionShelves = ref<Shelf[]>([])
const processes = ref<Process[]>([])
// 2026-07-17：CNC 下发只允许 INHOUSE 工序（外协工序走 send_to_outsource）
const inhouseProcesses = computed(() =>
  processes.value.filter((p) => p.category === 'INHOUSE'),
)

// 2026-07-17：useShelfProcessFilter 双向收窄（CNC 下发对话框）
const {
  filteredShelves: filteredProductionShelves,
  filteredProcesses: filteredInhouseProcesses,
  load: loadReleaseMap,
} = useShelfProcessFilter(
  productionShelves,
  inhouseProcesses,
  releaseShelfId,
  releaseProcessId,
)

async function openReleaseDialog(row: RowState): Promise<void> {
  releaseTarget.value = row
  releaseShelfId.value = null
  releaseProcessId.value = null
  try {
    const [shelfResp, procResp] = await Promise.all([
      productionShelves.value.length === 0
        ? listShelves({ zone: 'PRODUCTION', is_active: true, limit: 200 })
        : Promise.resolve(null),
      processes.value.length === 0
        ? listProcesses({ limit: 200 })
        : Promise.resolve(null),
    ])
    if (shelfResp) productionShelves.value = shelfResp.items
    if (procResp) processes.value = procResp.items
    void loadReleaseMap()
  } catch (e) {
    ElMessage.error(`加载失败：${(e as Error).message}`)
  }
  releaseDialogVisible.value = true
}

function onReleaseDialogClosed(): void {
  releaseTarget.value = null
  releaseShelfId.value = null
  releaseProcessId.value = null
}

async function onReleaseConfirm(): Promise<void> {
  if (!releaseTarget.value || !releaseShelfId.value || !releaseProcessId.value) return
  const row = releaseTarget.value
  const shelfCode =
    productionShelves.value.find((s) => s.id === releaseShelfId.value)?.code ?? ''
  const processCode =
    processes.value.find((p) => p.id === releaseProcessId.value)?.code ?? ''
  row._releasing = true
  releaseSubmitting.value = true
  try {
    await releaseFromProgramming(row.id, releaseShelfId.value, releaseProcessId.value)
    ElMessage.success(
      `零件 ${row.serial_no || row.drawing_no} 已下发到生产货架 ${shelfCode}`,
    )
    releaseDialogVisible.value = false
    await fetchList()
  } catch (e) {
    ElMessage.error(`下发失败：${(e as Error).message}`)
  } finally {
    row._releasing = false
    releaseSubmitting.value = false
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
.pending-programming {
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
</style>
