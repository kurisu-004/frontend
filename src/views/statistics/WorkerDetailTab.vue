<!--
  WorkerDetailTab.vue

  Tab 3 - 单工人详情。

  顶部：工人选择器（filterable），优先从 tab2 缓存挑；未加载过 tab2 时提示用户
  先到「工人报工总览」加载一次（不发新端点，与任务约束一致）。

  卡片行：领取次数 / 领取件数 / 参与工单数 / 归还次数（el-statistic）。

  图：每日领取趋势折线图。

  表：参与工单一览（serial_no / 名称 / 图号 / 当前状态 / 我的领取次数 / 最近领取时间
     / 操作 → 跳零件详情）。

  workerId 为 null → el-empty「请选择工人」。
-->

<template>
  <div class="worker-detail-tab">
    <!-- 工人选择器 -->
    <el-card shadow="never" class="picker-card">
      <el-form inline @submit.prevent>
        <el-form-item label="选择工人">
          <el-select
            v-model="selectedWorkerId"
            placeholder="请先在「工人报工总览」加载一次后，再在此选择工人"
            filterable
            clearable
            style="width: 320px"
            @change="onPickerChange"
          >
            <el-option
              v-for="r in workerOptions"
              :key="r.worker_id"
              :label="`${r.worker_name}（${r.badge_code}）${r.is_active ? '' : ' · 已停用'}`"
              :value="r.worker_id"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="!hasCache">
          <el-button type="primary" :loading="warmingCache" @click="warmCache">
            加载工人列表
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <template v-if="!workerId">
      <el-empty description="请选择工人" />
    </template>

    <template v-else>
      <div v-loading="loading" element-loading-text="加载中">
        <template v-if="data">
          <!-- 顶部 worker 名 -->
          <el-card shadow="never" class="worker-card">
            <div class="worker-head">
              <span class="worker-name">{{ data.worker.name }}</span>
              <span class="worker-badge">工牌：{{ data.worker.badge_code }}</span>
              <el-tag v-if="data.worker.work_type_name" type="primary" size="small" effect="plain">
                {{ data.worker.work_type_name }}
              </el-tag>
              <el-tag v-if="!data.worker.is_active" type="info" size="small" effect="plain">
                已停用
              </el-tag>
            </div>
          </el-card>

          <!-- KPI 卡片 -->
          <el-row :gutter="12" class="kpi-row">
            <el-col :xs="12" :sm="12" :md="6">
              <el-card shadow="never" class="kpi-card">
                <el-statistic title="领取次数" :value="data.pickup_count">
                  <template #suffix>次</template>
                </el-statistic>
              </el-card>
            </el-col>
            <el-col :xs="12" :sm="12" :md="6">
              <el-card shadow="never" class="kpi-card">
                <el-statistic title="领取件数" :value="data.pickup_quantity">
                  <template #suffix>件</template>
                </el-statistic>
              </el-card>
            </el-col>
            <el-col :xs="12" :sm="12" :md="6">
              <el-card shadow="never" class="kpi-card">
                <el-statistic
                  title="参与工单数"
                  :value="data.participated_part_count"
                >
                  <template #suffix>件</template>
                </el-statistic>
              </el-card>
            </el-col>
            <el-col :xs="12" :sm="12" :md="6">
              <el-card shadow="never" class="kpi-card">
                <el-statistic title="归还次数" :value="data.return_count">
                  <template #suffix>次</template>
                </el-statistic>
              </el-card>
            </el-col>
          </el-row>

          <!-- 趋势图 -->
          <el-card shadow="never">
            <template #header>
              <span class="chart-title">每日领取趋势</span>
            </template>
            <EChart :option="pickupTrendOption" height="280px" />
          </el-card>

          <!-- 参与工单表 -->
          <el-card shadow="never">
            <template #header>
              <span class="chart-title">参与工单一览（共 {{ data.parts.length }} 件）</span>
            </template>
            <!-- 2026-08-27 Task 9：列设置工具条 -->
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
              :data="data.parts"
              row-key="part_id"
              stripe
              border
              size="default"
              empty-text="该工人期内未参与工单"
            >
              <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
                <el-table-column
                  v-if="columnVisibility.isVisible(d.key)"
                  :prop="d.prop ?? d.key"
                  :label="d.label"
                  :width="d.width"
                  :min-width="d.minWidth"
                  :align="d.align"
                  :sortable="d.sortable"
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
              <el-table-column label="操作" min-width="100" fixed="right" align="center">
                <template #default="{ row }">
                  <el-button
                    link
                    type="primary"
                    size="small"
                    @click="goPartDetail(row.part_id)"
                  >详情</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ElMessage, ElTag } from 'element-plus'
import EChart from '@/components/EChart.vue'
import { fetchWorkerDetail, fetchWorkerStats } from '@/api/statistics'
import type { WorkerDetailOut, WorkerStatsItem } from '@/types/statistics'
import type { OrderStatus } from '@/types/parts'
import { STATUS_LABEL, STATUS_TAG_TYPE } from '@/constants/partStatus'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'

type WorkerPartRow = WorkerDetailOut['parts'][number]

interface Props {
  dateFrom: string
  dateTo: string
  workerId: string | null
}
const props = defineProps<Props>()

const router = useRouter()

const selectedWorkerId = ref<string | null>(props.workerId)
const workerOptions = ref<WorkerStatsItem[]>([])
const hasCache = computed(() => workerOptions.value.length > 0)
const warmingCache = ref(false)
const loading = ref(false)
const data = ref<WorkerDetailOut | null>(null)

// 2026-08-27 Task 9：列顺序拖动 + 可见性。
// 2026-08-28 改造：表格在 `v-if="data"` 内（首次加载完成才渲染，workerId 清空后又销毁）
// → 传 el-table 实例 ref，composable 内部 watch(ref) + MutationObserver 自愈（无需
// consumer 侧再 watch(tableRef) 解析 headerRowRef）。
// 「操作」列 fixed=right，不进 defs。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const tableRef = ref()
const columnDefs: ColumnDef[] = [
  {
    key: 'serial_no', label: '流水号', prop: 'serial_no', minWidth: 160, align: 'center',
    cellRender: ({ row }) => {
      const r = row as WorkerPartRow
      return r.serial_no
        ? h(ElTag, { type: 'primary', size: 'small', effect: 'plain' }, () => r.serial_no)
        : h('span', { style: 'color: #c0c4cc' }, '—')
    },
  },
  {
    key: 'name', label: '名称', prop: 'name', minWidth: 200, align: 'center',
    showOverflowTooltip: true,
    cellRender: ({ row }) => {
      const r = row as WorkerPartRow
      // 硬约束 #11：EP 合成空行 { row: {} } 会额外渲染一次 →
      // 没有 part_id 时不能拼 router-link，否则得到 /parts/undefined
      return r.part_id
        ? h(RouterLink, { to: `/parts/${r.part_id}`, class: 'name-link' }, () => r.name)
        : h('span', r.name ?? '')
    },
  },
  { key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 140, align: 'center' },
  {
    key: 'status', label: '当前状态', prop: 'status', minWidth: 100, align: 'center',
    cellRender: ({ row }) => {
      const r = row as WorkerPartRow
      return h(
        ElTag,
        {
          type: STATUS_TAG_TYPE[r.status as OrderStatus] ?? 'info',
          size: 'small',
          effect: 'plain',
        },
        () => STATUS_LABEL[r.status as OrderStatus] ?? r.status,
      )
    },
  },
  {
    key: 'pickup_count', label: '我的领取次数', prop: 'pickup_count',
    minWidth: 110, align: 'center',
  },
  {
    key: 'last_pickup_at', label: '最近领取时间', prop: 'last_pickup_at',
    minWidth: 170, align: 'center',
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'worker_detail' })
const drag = useColumnDrag(columnDefs, { listKey: 'worker_detail' })

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部 watch(ref) + MutationObserver 自愈。
drag.applyDrag(tableRef)

function onPickerChange(v: string | null): void {
  selectedWorkerId.value = v
}

async function warmCache(): Promise<void> {
  warmingCache.value = true
  try {
    const res = await fetchWorkerStats({
      date_from: props.dateFrom,
      date_to: props.dateTo,
    })
    workerOptions.value = res.items
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载工人列表失败')
  } finally {
    warmingCache.value = false
  }
}

async function reload(): Promise<void> {
  if (!selectedWorkerId.value) {
    data.value = null
    return
  }
  if (!props.dateFrom || !props.dateTo) return
  loading.value = true
  try {
    data.value = await fetchWorkerDetail(selectedWorkerId.value, {
      date_from: props.dateFrom,
      date_to: props.dateTo,
    })
    // 顺便把 worker 信息补到 options（即使 tab2 没加载过）
    if (!workerOptions.value.some((w) => w.worker_id === data.value!.worker.id)) {
      // 不强求；picker 只在已有 options 时才能选。
    }
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载工人详情失败')
  } finally {
    loading.value = false
  }
}

// watch external workerId（来自父组件 emit），并 reload
watch(
  () => props.workerId,
  (v) => {
    if (v) {
      selectedWorkerId.value = v
      void reload()
    } else {
      selectedWorkerId.value = null
      data.value = null
    }
  },
)
watch(() => [selectedWorkerId.value, props.dateFrom, props.dateTo], reload)

onMounted(async () => {
  // 如果 props.workerId 有（用户从 tab2 点过来），立即拉数；options 暂为空。
  if (props.workerId) {
    selectedWorkerId.value = props.workerId
    await reload()
  }
})

function goPartDetail(partId: string): void {
  router.push(`/parts/${partId}`)
}

// ============== ECharts options ==============

const pickupTrendOption = computed(() => {
  const days = data.value?.daily_pickups ?? []
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 30, bottom: 30 },
    xAxis: { type: 'category', data: days.map((d) => d.date), boundaryGap: false },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        name: '每日领取次数',
        type: 'line',
        smooth: true,
        data: days.map((d) => d.count),
        itemStyle: { color: '#409eff' },
        areaStyle: { opacity: 0.2 },
      },
    ],
  }
})
</script>

<style lang="scss" scoped>
.worker-detail-tab {
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.picker-card :deep(.el-card__body) {
  padding-bottom: 0;
}

.worker-card :deep(.el-card__body) {
  padding: 12px 16px;
}

.worker-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.worker-name {
  font-size: 18px;
  font-weight: 600;
}

.worker-badge {
  color: var(--text-secondary);
  font-size: 13px;
}

.kpi-row { width: 100%; }

.kpi-card :deep(.el-card__body) {
  padding: 16px;
}

.chart-title {
  font-weight: 600;
  font-size: 14px;
}

.name-link {
  color: var(--el-color-primary);
  text-decoration: none;
}
.name-link:hover {
  text-decoration: underline;
}

/* 2026-08-27 Task 9：列设置工具条 */
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>