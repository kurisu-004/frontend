<!--
  WorkerDetailTab.vue

  Tab 3 - 单工人详情。

  顶部：工人选择器（filterable）。候选集来自域内 query hook `useStatisticsWorkersQuery`
  （与 tab2 工人表共用同一条 queryKey，切到本 tab 时通常直接命中缓存，不另发请求）。

  卡片行：领取次数 / 领取件数 / 参与工单数 / 归还次数 / 有效工时（el-statistic）。

  图：每日领取趋势折线图。

  表：参与工单一览（serial_no / 名称 / 图号 / 当前状态 / 我的领取次数 / 最近领取时间
     / 操作 → 跳零件详情）。

  表：按工序工时（工序 / 完成次数 / 有效工时（小时）），消费 process_breakdown。
     ⚠️ 两种「无名」用不同文案：process_id 为 null = 这条作业事件没记工序 → 「未记工序」；
     process_name 为 '(已删除)' = 记了工序 id 但工序行取不到 → 原样展示。

  未选工人 → el-empty「请选择工人」。
-->

<template>
  <div class="worker-detail-tab">
    <!-- 工人选择器 -->
    <el-card shadow="never" class="picker-card">
      <el-form inline @submit.prevent>
        <el-form-item label="选择工人">
          <el-select
            v-model="selectedWorkerId"
            placeholder="请选择工人"
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
      </el-form>
    </el-card>

    <template v-if="!selectedWorkerId">
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
                <el-statistic title="参与工单数" :value="data.participated_part_count">
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
            <!-- 2026-10-12 新增：有效工时。后端给分钟整数，换算成小时、展示 1 位小数。
                 口径要求工单配了工序链，没配链的工单恒为 0 —— 大面积 0 是口径的必然结果，
                 不在 UI 上为它加特殊分支。 -->
            <el-col :xs="12" :sm="12" :md="6">
              <el-card shadow="never" class="kpi-card">
                <el-statistic title="有效工时" :value="effectiveHours" :precision="1">
                  <template #suffix>小时</template>
                </el-statistic>
              </el-card>
            </el-col>
          </el-row>

          <!-- 趋势图 -->
          <el-card shadow="never">
            <template #header>
              <span class="chart-title">每日领取趋势</span>
            </template>
            <v-chart
              class="chart"
              :option="pickupTrendOption"
              :update-options="{ notMerge: true }"
              :init-options="{ renderer: 'canvas' }"
              :style="{ height: '280px', width: '100%' }"
              theme="v5"
              autoresize
            />
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
                @resetOrder="drag.reset"
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
                  <el-button link type="primary" size="small" @click="goPartDetail(row.part_id)"
                    >详情</el-button
                  >
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <!-- 2026-10-12 新增：按工序工时表（消费 process_breakdown，服务端已排好序，前端不重排） -->
          <el-card shadow="never">
            <template #header>
              <span class="chart-title">
                按工序工时（共 {{ data.process_breakdown.length }} 道工序）
              </span>
            </template>
            <div class="table-toolbar">
              <ColumnVisibilityPopover
                :defs="breakdownColumnDefs"
                :model-value="breakdownColumnVisibility.currentMap"
                @update:model-value="breakdownColumnVisibility.update"
                @reset="breakdownColumnVisibility.showAll"
                @resetOrder="breakdownDrag.reset"
              />
            </div>
            <el-table
              ref="breakdownTableRef"
              :data="data.process_breakdown"
              :row-key="breakdownRowKey"
              stripe
              border
              size="default"
              empty-text="该工人期内没有完成工序的作业记录"
            >
              <template v-for="d in breakdownDrag.orderedDefs.value" :key="columnIdentifier(d)">
                <el-table-column
                  v-if="breakdownColumnVisibility.isVisible(d.key)"
                  :prop="d.prop ?? d.key"
                  :label="d.label"
                  :width="d.width"
                  :min-width="d.minWidth"
                  :align="d.align"
                  :sortable="d.sortable"
                  :show-overflow-tooltip="d.showOverflowTooltip"
                  :column-key="d.columnKey ?? d.key"
                  :label-class-name="breakdownDrag.dragLabelClass(d)"
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
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { ElTag } from 'element-plus';
import { useStatisticsWorkersQuery } from './composables/useStatisticsWorkersQuery';
import { useStatisticsWorkerDetailQuery } from './composables/useStatisticsWorkerDetailQuery';
import type { WorkerDetailOutData, WorkerStatsListOutData } from './composables/statisticsSchema';
import type { StatisticsQuery } from '@/types/statistics';
import type { OrderStatus } from '@/types/parts';
import { STATUS_LABEL, STATUS_TAG_TYPE } from '@/constants/partStatus';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';

/** 行类型取自 Zod schema 的推导类型（与 query 的返回类型同源），不用手写镜像。 */
type WorkerPartRow = WorkerDetailOutData['parts'][number];
type ProcessBreakdownRow = WorkerDetailOutData['process_breakdown'][number];
type WorkerOptionsRow = WorkerStatsListOutData['items'][number];

interface Props {
  dateFrom: string;
  dateTo: string;
  workerId: string | null;
}
const props = defineProps<Props>();

const router = useRouter();

// 2026-09-13 PR-2：vue/no-setup-props-destructure 禁止在 setup 顶层读 props.x。
// 包一层 IIFE 把 props.workerId 读取放进函数体。
const selectedWorkerId = ref<string | null>((() => props.workerId)());

/** 日期区间 → 两条 query 的 params；日期不齐时传 null ⇒ hook 内 enabled=false。 */
const statsParams = computed<StatisticsQuery | null>(() =>
  props.dateFrom && props.dateTo ? { date_from: props.dateFrom, date_to: props.dateTo } : null,
);

// 2026-10-12：工人下拉的候选集改由 query hook 提供。它与 tab2 工人表共用同一条
// qk.statisticsWorkers 键 ⇒ 同一个日期区间下切到本 tab 直接命中 tab2 那份缓存，
// 不再需要原先「二次拉一次列表来预热下拉」的那个按钮。
const workersQuery = useStatisticsWorkersQuery(statsParams);
const workerOptions = computed<WorkerOptionsRow[]>(() => workersQuery.data.value?.items ?? []);

const { data, isFetching } = useStatisticsWorkerDetailQuery(selectedWorkerId, statsParams);
const loading = isFetching;

// 2026-08-27 Task 9：列顺序拖动 + 可见性。
// 2026-08-28 改造：表格在 `v-if="data"` 内（首次加载完成才渲染，workerId 清空后又销毁）
// → 传 el-table 实例 ref，composable 内部 watch(ref) + MutationObserver 自愈（无需
// consumer 侧再 watch(tableRef) 解析 headerRowRef）。
// 「操作」列 fixed=right，不进 defs。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const tableRef = ref();
const columnDefs: ColumnDef[] = [
  {
    key: 'serial_no',
    label: '流水号',
    prop: 'serial_no',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as WorkerPartRow;
      return r.serial_no
        ? h(ElTag, { type: 'primary', size: 'small', effect: 'plain' }, () => r.serial_no)
        : h('span', { style: 'color: #c0c4cc' }, '—');
    },
  },
  {
    key: 'name',
    label: '名称',
    prop: 'name',
    minWidth: 200,
    align: 'center',
    showOverflowTooltip: true,
    cellRender: ({ row }) => {
      const r = row as WorkerPartRow;
      // 硬约束 #11：EP 合成空行 { row: {} } 会额外渲染一次 →
      // 没有 part_id 时不能拼 router-link，否则得到 /parts/undefined
      return r.part_id
        ? h(RouterLink, { to: `/parts/${r.part_id}`, class: 'name-link' }, () => r.name)
        : h('span', r.name ?? '');
    },
  },
  { key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 140, align: 'center' },
  {
    key: 'status',
    label: '当前状态',
    prop: 'status',
    minWidth: 100,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as WorkerPartRow;
      return h(
        ElTag,
        {
          type: STATUS_TAG_TYPE[r.status as OrderStatus] ?? 'info',
          size: 'small',
          effect: 'plain',
        },
        () => STATUS_LABEL[r.status as OrderStatus] ?? r.status,
      );
    },
  },
  {
    key: 'pickup_count',
    label: '我的领取次数',
    prop: 'pickup_count',
    minWidth: 110,
    align: 'center',
  },
  {
    key: 'last_pickup_at',
    label: '最近领取时间',
    prop: 'last_pickup_at',
    minWidth: 170,
    align: 'center',
  },
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'worker_detail' });
const drag = useColumnDrag(columnDefs, { listKey: 'worker_detail' });

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部 watch(ref) + MutationObserver 自愈。
drag.applyDrag(tableRef);

// ============== 有效工时：KPI 卡 + 按工序工时表（2026-10-12 新增） ==============

/** 小时数值 → 1 位小数；值不可用时给占位符「—」（绝不吐 NaN / Infinity）。 */
function formatHours(hours: unknown): string {
  const v = Number(hours);
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}

/** 后端分钟整数 → 小时数值（换算在前端做，展示 1 位小数）。 */
function minutesToHours(minutes: unknown): number {
  return Number(minutes) / 60;
}

/** KPI 卡取值：el-statistic 只收 number，小数位交给 :precision。 */
const effectiveHours = computed<number>(() => {
  const hours = minutesToHours(data.value?.effective_minutes);
  return Number.isFinite(hours) ? hours : 0;
});

/** process_id 可空 ⇒ row-key 不能直接用它，给「无工序」那一组一个稳定占位键。 */
function breakdownRowKey(row: unknown): string {
  const r = row as ProcessBreakdownRow;
  return r?.process_id ?? '__no_process__';
}

const breakdownTableRef = ref();
const breakdownColumnDefs: ColumnDef[] = [
  {
    key: 'process_name',
    label: '工序',
    prop: 'process_name',
    minWidth: 180,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as ProcessBreakdownRow;
      // ⚠️ **两种「无名」的文案不能混用**：
      //   process_id === null      = 这条作业事件没记工序（对工时总额贡献恒为 0）
      //   process_name '(已删除)'  = 记了工序 id 但工序行取不到，后端给的兜底字符串
      // 后者原样展示，只用一个中性 tag 标出它不是真名。
      if (r?.process_id === null) {
        return h('span', { style: 'color: #c0c4cc' }, '未记工序');
      }
      return r?.process_name === '(已删除)'
        ? h(ElTag, { type: 'info', size: 'small', effect: 'plain' }, () => r.process_name)
        : h('span', r?.process_name ?? '');
    },
  },
  {
    key: 'step_count',
    label: '完成次数',
    prop: 'step_count',
    minWidth: 110,
    align: 'center',
    sortable: true,
    // 硬约束 #11：EP 会用合成空行 { row: {} } 额外渲染一次 → 需空值守卫。
    cellRender: ({ row }) => h('span', String((row as ProcessBreakdownRow)?.step_count ?? '—')),
  },
  {
    key: 'effective_minutes',
    label: '有效工时（小时）',
    prop: 'effective_minutes',
    minWidth: 130,
    align: 'center',
    sortable: true,
    cellRender: ({ row }) =>
      h('span', formatHours(minutesToHours((row as ProcessBreakdownRow)?.effective_minutes))),
  },
];
const breakdownColumnVisibility = useColumnVisibility(breakdownColumnDefs, {
  listKey: 'worker_detail_process',
});
const breakdownDrag = useColumnDrag(breakdownColumnDefs, { listKey: 'worker_detail_process' });
breakdownDrag.applyDrag(breakdownTableRef);

function onPickerChange(v: string | null): void {
  selectedWorkerId.value = v;
}

// 父组件切工人（tab2 点「详情」emit 上来）时同步选中态；取数由 queryKey 跟随
// selectedWorkerId 自动发生，不需要再手动 reload。
watch(
  () => props.workerId,
  (v) => {
    selectedWorkerId.value = v || null;
  },
);

function goPartDetail(partId: string): void {
  router.push(`/parts/${partId}`);
}

// ============== ECharts options ==============

// 2026-10-14 新增：图走全局 <v-chart>（vue-echarts，模块化注册在 src/plugins/echarts.ts）。
// 四处传参各有理由：
//
//   - :update-options="{ notMerge: true }"：option 是 computed 每次重算的整份新对象，
//     更新语义显式钉死成「整份替换」。不传 update-options 时 vue-echarts 走结构签名
//     planner（它比对前后 option 的结构签名，结构变了自己会翻成 notMerge，只有纯数值
//     变化才合并）—— 那是库的启发式、随版本漂移 ⇒ 显式钉死，不依赖 planner 判断。
//   - autoresize：vue-echarts 内建 ResizeObserver（默认 100ms 节流，尺寸未变时跳过 resize）。
//   - theme="v5"：锁定配色 / legend 默认位置（v5 主题在 src/plugins/echarts.ts 注册）。
//   - :init-options="{ renderer: 'canvas' }"：渲染器不交给缺省值，显式钉 canvas。

const pickupTrendOption = computed(() => {
  const days = data.value?.daily_pickups ?? [];
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
  };
});
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

.kpi-row {
  width: 100%;
}

.kpi-card :deep(.el-card__body) {
  padding: 16px;
}

.chart-title {
  font-weight: 600;
  font-size: 14px;
}

/* 图表容器：宽跟随卡片，高由模板里的 style 绑定给（280px）。min-width: 0 防 flex
   子项被内容顶开。 */
.chart {
  width: 100%;
  min-width: 0;
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
