<!--
  PickupSkipTab.vue

  Tab 4 - 跳序取件统计。

  顶部：汇总 el-table（按工人聚合 skip_count desc / last_skip_at desc）。
        行点击 → el-drawer（标题「工人跳序明细」），内嵌分页 el-pagination +
        明细 el-table（时间 / 序列号 / 零件名 / 批次号 / 数量 / 所取交期 / 被跳过交期）。

  无日期范围：append-only 历史流。

  Element Plus 合规（CLAUDE.md §Element Plus）：
  - el-table / el-pagination / el-drawer / el-tag / el-empty / v-loading / ElMessage
  - 参见 references/table.md / feedback.md。
-->

<template>
  <div v-loading="summaryLoading" class="pickup-skip-tab" element-loading-text="加载中">
    <!-- 汇总表 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-title">跳序取件汇总（按工人）</span>
          <div class="card-actions">
            <!-- 2026-08-27 Task 9：列设置 -->
            <ColumnVisibilityPopover
              :defs="columnDefs_summary"
              :model-value="columnVisibility_summary.currentMap"
              @update:model-value="columnVisibility_summary.update"
              @reset="columnVisibility_summary.showAll"
              @reset-order="drag_summary.reset"
            />
            <el-button size="small" :loading="summaryLoading" @click="reloadSummary">
              刷新
            </el-button>
          </div>
        </div>
      </template>

      <el-table
        ref="summaryTableRef"
        :data="summaryRows"
        row-key="worker_id"
        stripe
        border
        size="default"
        empty-text="暂无跳序记录"
        @row-click="onRowClick"
      >
        <template v-for="d in drag_summary.orderedDefs.value" :key="columnIdentifier(d)">
          <el-table-column
            v-if="columnVisibility_summary.isVisible(d.key)"
            :prop="d.prop ?? d.key"
            :label="d.label"
            :width="d.width"
            :min-width="d.minWidth"
            :align="d.align"
            :sortable="d.sortable"
            :show-overflow-tooltip="d.showOverflowTooltip"
            :column-key="d.columnKey ?? d.key"
            :label-class-name="drag_summary.dragLabelClass(d)"
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
      </el-table>
    </el-card>

    <!-- 明细抽屉 -->
    <el-drawer
      v-model="drawerVisible"
      direction="rtl"
      size="60%"
      :with-header="true"
      :destroy-on-close="false"
      :append-to-body="true"
    >
      <template #header>
        <div class="drawer-header">
          <span class="drawer-title">工人跳序明细</span>
          <span v-if="currentWorker" class="drawer-sub">
            {{ currentWorker.worker_name }}（{{ currentWorker.badge_code }}）·
            共 {{ detailData?.total ?? 0 }} 条
          </span>
        </div>
      </template>

      <div v-loading="detailLoading" element-loading-text="加载中">
        <!-- 2026-08-27 Task 9：列设置工具条 -->
        <div class="table-toolbar">
          <ColumnVisibilityPopover
            :defs="columnDefs_detail"
            :model-value="columnVisibility_detail.currentMap"
            @update:model-value="columnVisibility_detail.update"
            @reset="columnVisibility_detail.showAll"
            @reset-order="drag_detail.reset"
          />
        </div>
        <el-table
          ref="detailTableRef"
          :data="detailData?.items ?? []"
          row-key="id"
          stripe
          border
          size="default"
          empty-text="该工人暂无跳序记录"
        >
          <template v-for="d in drag_detail.orderedDefs.value" :key="columnIdentifier(d)">
            <el-table-column
              v-if="columnVisibility_detail.isVisible(d.key)"
              :prop="d.prop ?? d.key"
              :label="d.label"
              :width="d.width"
              :min-width="d.minWidth"
              :align="d.align"
              :sortable="d.sortable"
              :show-overflow-tooltip="d.showOverflowTooltip"
              :column-key="d.columnKey ?? d.key"
              :label-class-name="drag_detail.dragLabelClass(d)"
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
        </el-table>

        <el-pagination
          v-if="detailData && detailData.total > 0"
          v-model:current-page="detailPage"
          v-model:page-size="detailPageSize"
          :total="detailData.total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          background
          class="detail-pagination"
          @current-change="reloadDetail"
          @size-change="onPageSizeChange"
        />
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { ElMessage, ElTag } from 'element-plus'
import {
  fetchPickupSkipDetail,
  fetchPickupSkipSummary,
} from '@/api/statistics'
import type {
  PickupSkipDetailOut,
  PickupSkipSummaryItem,
} from '@/types/statistics'
// 2026-08-25 统一日期格式化：原本地函数用正则切 ISO 字符串，
// 改为 utils/date.formatDateTime（toISOString → UTC），对后端 UTC 输出行为一致。
import { formatDateTime } from '@/utils/date'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'

type PickupSkipDetailRow = PickupSkipDetailOut['items'][number]

// ========== 汇总 ==========
const summaryLoading = ref(false)
const summaryRows = ref<PickupSkipSummaryItem[]>([])

// 2026-08-27 Task 9：汇总表列顺序拖动 + 可见性。
// 2026-08-28 改造：传 el-table 实例 ref，composable 内部 watch(ref) + MutationObserver 自愈。
const summaryTableRef = ref()
const columnDefs_summary: ColumnDef[] = [
  {
    key: 'worker_name', label: '工人', prop: 'worker_name', minWidth: 120, align: 'center',
  },
  { key: 'badge_code', label: '工牌', prop: 'badge_code', minWidth: 140, align: 'center' },
  {
    key: 'work_type_name', label: '工种', prop: 'work_type_name', minWidth: 140, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PickupSkipSummaryItem
      return r.work_type_name
        ? h(ElTag, { type: 'primary', size: 'small', effect: 'plain' }, () => r.work_type_name)
        : h('span', { style: 'color: #c0c4cc' }, '—')
    },
  },
  {
    key: 'skip_count', label: '跳序次数', prop: 'skip_count',
    minWidth: 100, align: 'center', sortable: true,
    cellRender: ({ row }) => {
      const r = row as PickupSkipSummaryItem
      return h(
        ElTag,
        {
          type: r.skip_count >= 5 ? 'danger' : r.skip_count >= 2 ? 'warning' : 'info',
          size: 'small',
          effect: 'plain',
        },
        () => String(r.skip_count ?? ''),
      )
    },
  },
  {
    key: 'last_skip_at', label: '最近跳序时间', prop: 'last_skip_at',
    minWidth: 180, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PickupSkipSummaryItem
      return r.last_skip_at
        ? h('span', formatDateTime(r.last_skip_at))
        : h('span', { style: 'color: #c0c4cc' }, '—')
    },
  },
]
const columnVisibility_summary = useColumnVisibility(columnDefs_summary, {
  listKey: 'pickup_skip_summary',
})
const drag_summary = useColumnDrag(columnDefs_summary, { listKey: 'pickup_skip_summary' })
// 2026-08-28 改造：直接传实例 ref。
drag_summary.applyDrag(summaryTableRef)

async function reloadSummary(): Promise<void> {
  summaryLoading.value = true
  try {
    const res = await fetchPickupSkipSummary()
    summaryRows.value = res.items
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载汇总失败')
  } finally {
    summaryLoading.value = false
  }
}

// ========== 抽屉 + 明细 ==========
const drawerVisible = ref(false)
const detailLoading = ref(false)
const currentWorker = ref<PickupSkipSummaryItem | null>(null)
const detailData = ref<PickupSkipDetailOut | null>(null)
const detailPage = ref(1)
const detailPageSize = ref(20)

// 2026-08-27 Task 9：明细表列顺序拖动 + 可见性。
// 2026-08-28 改造：明细表在 el-drawer 内（drawer body 首次打开才渲染 / 开关抽屉会重建），
// 传 el-table 实例 ref，composable 内部 watch(ref) + MutationObserver 自愈——开关抽屉
// 重建表头后无需手动重绑，正是新 observer 覆盖的场景。
const detailTableRef = ref()
const columnDefs_detail: ColumnDef[] = [
  {
    key: 'created_at', label: '时间', prop: 'created_at', minWidth: 170, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PickupSkipDetailRow
      return h('span', r.created_at ? formatDateTime(r.created_at) : '')
    },
  },
  {
    key: 'serial_no', label: '流水号', prop: 'serial_no', minWidth: 160, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PickupSkipDetailRow
      return r.serial_no
        ? h(ElTag, { type: 'primary', size: 'small', effect: 'plain' }, () => r.serial_no)
        : h('span', { style: 'color: #c0c4cc' }, '—')
    },
  },
  {
    key: 'part_name', label: '零件名', prop: 'part_name', minWidth: 200, align: 'center',
    showOverflowTooltip: true,
  },
  { key: 'batch_no', label: '批次号', prop: 'batch_no', minWidth: 80, align: 'center' },
  { key: 'quantity', label: '数量', prop: 'quantity', minWidth: 80, align: 'center' },
  {
    key: 'part_planned_delivery_date', label: '所取交期', prop: 'part_planned_delivery_date',
    minWidth: 120, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PickupSkipDetailRow
      return r.part_planned_delivery_date
        ? h('span', r.part_planned_delivery_date)
        : h('span', { style: 'color: #c0c4cc' }, '—')
    },
  },
  {
    key: 'skipped_earliest_date', label: '被跳过交期', prop: 'skipped_earliest_date',
    minWidth: 120, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PickupSkipDetailRow
      return r.skipped_earliest_date
        ? h(ElTag, { type: 'danger', size: 'small', effect: 'plain' },
          () => r.skipped_earliest_date)
        : h('span', { style: 'color: #c0c4cc' }, '—')
    },
  },
]
const columnVisibility_detail = useColumnVisibility(columnDefs_detail, {
  listKey: 'pickup_skip_detail',
})
const drag_detail = useColumnDrag(columnDefs_detail, { listKey: 'pickup_skip_detail' })

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部 watch(ref) + MutationObserver 自愈
// （开关抽屉重建表头自动重绑，consumer 侧无需再手动重绑）。
drag_detail.applyDrag(detailTableRef)

const detailOffset = computed<number>(() => (detailPage.value - 1) * detailPageSize.value)

async function reloadDetail(): Promise<void> {
  if (!currentWorker.value) return
  detailLoading.value = true
  try {
    detailData.value = await fetchPickupSkipDetail(currentWorker.value.worker_id, {
      limit: detailPageSize.value,
      offset: detailOffset.value,
    })
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载明细失败')
  } finally {
    detailLoading.value = false
  }
}

function onRowClick(row: PickupSkipSummaryItem): void {
  currentWorker.value = row
  detailPage.value = 1
  detailPageSize.value = 20
  drawerVisible.value = true
  void reloadDetail()
}

function onPageSizeChange(size: number): void {
  detailPageSize.value = size
  detailPage.value = 1
  void reloadDetail()
}

onMounted(async () => {
  await reloadSummary()
})
</script>

<style lang="scss" scoped>
.pickup-skip-tab {
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  font-weight: 600;
  font-size: 14px;
}

/* 2026-08-27 Task 9：列设置工具条 */
.card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.drawer-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.drawer-title {
  font-size: 16px;
  font-weight: 600;
}

.drawer-sub {
  color: var(--text-secondary);
  font-size: 13px;
}

.detail-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>