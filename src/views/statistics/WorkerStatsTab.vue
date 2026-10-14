<!--
  WorkerStatsTab.vue

  Tab 2 - 工人报工总览。

  工具行：
    - 工种筛选（全部 / 各工种 / 未分配）
    - 含已停用 switch

  图：当前工种内所有工人的水平条形图（y 轴姓名，x 轴当前指标）；
     指标可切「领取次数 / 有效工时」，默认「领取次数」；选「全部」时取该指标的前 10 名。
     有效工时由后端的分钟整数在前端换算成小时、保留 1 位小数。

  表：默认按 pickup_count desc；详情按钮 emit 'select-worker'。

  数据：工人贡献度列表经域内 query hook（`composables/useStatisticsWorkersQuery`，Zod
  守门在 queryFn）取，一次性返回所有未软删工人（含 is_active=false）；前端按工种 /
  is_active 客户端筛选。工种下拉另走既有的裸调 `listWorkTypes`，见 script 内注释。
-->

<template>
  <div v-loading="loading" class="worker-stats-tab" element-loading-text="加载中">
    <!-- 工具行 -->
    <el-card shadow="never" class="filter-card">
      <el-form inline @submit.prevent>
        <el-form-item label="工种">
          <el-select
            v-model="workTypeFilter"
            placeholder="全部"
            clearable
            style="width: 180px"
            @change="onWorkTypeChange"
          >
            <el-option label="全部工种" value="__all__" />
            <el-option label="未分配工种" value="__none__" />
            <el-option
              v-for="wt in workTypeOptions"
              :key="wt.id"
              :label="`${wt.code} / ${wt.name}`"
              :value="wt.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="含已停用">
          <el-switch v-model="includeInactive" />
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 图 -->
    <el-card shadow="never" class="chart-card">
      <template #header>
        <div class="chart-head">
          <span class="chart-title">
            {{ chartTitle }}
          </span>
          <el-radio-group v-model="chartMetric" size="small" aria-label="图表指标">
            <el-radio-button
              v-for="opt in chartMetricOptions"
              :key="opt.value"
              :value="opt.value"
              >{{ opt.label }}</el-radio-button
            >
          </el-radio-group>
        </div>
      </template>
      <v-chart
        class="chart"
        :option="barOption"
        :update-options="{ notMerge: true }"
        :init-options="{ renderer: 'canvas' }"
        :style="{ height: '360px', width: '100%' }"
        theme="v5"
        autoresize
      />
    </el-card>

    <!-- 表 -->
    <el-card shadow="never">
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
        :data="sortedRows"
        row-key="worker_id"
        stripe
        border
        size="default"
        empty-text="暂无工人数据"
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
            <el-button link type="primary" size="small" @click="onSelectWorker(row.worker_id)"
              >详情</el-button
            >
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue';
import { ElProgress, ElTag } from 'element-plus';
import { listWorkTypes } from '@/api/workType';
import type { WorkType } from '@/types/workType';
import { useStatisticsWorkersQuery } from './composables/useStatisticsWorkersQuery';
import type { WorkerStatsListOutData } from './composables/statisticsSchema';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';

/** 行类型取自 Zod schema 的推导类型（与 query 的返回类型同源），不用手写镜像。 */
type WorkerStatsRow = WorkerStatsListOutData['items'][number];

interface Props {
  dateFrom: string;
  dateTo: string;
}
const props = defineProps<Props>();

const emit = defineEmits<(e: 'selectWorker', workerId: string) => void>();

// 2026-10-12 数据层迁 query hook：日期区间进 queryKey ⇒ 换日期自动 refetch；
// 日期不齐传 null ⇒ hook 内 enabled=false，零网络请求（替代原 reload 的提前 return）。
const { data, isFetching } = useStatisticsWorkersQuery(() =>
  props.dateFrom && props.dateTo ? { date_from: props.dateFrom, date_to: props.dateTo } : null,
);
const loading = isFetching;
const rows = computed<WorkerStatsRow[]>(() => data.value?.items ?? []);

// 工种筛选：
//   '__all__' = 全部
//   '__none__' = 未分配工种
//   string(雪花 ID) = 指定工种
const workTypeFilter = ref<'__all__' | '__none__' | string>('__all__');
const includeInactive = ref(false);

const workTypes = ref<WorkType[]>([]);
const workTypeOptions = computed(() => workTypes.value);

// 2026-10-12：工种下拉的数据源仍是既有的裸调 `listWorkTypes`（共享基础数据的独立取数
// 路径，与本轮统计域的 query 化无关，本轮不动）。触发点从「挂载钩子里等一拍」换成 setup
// 期起一次浮空 promise —— 本组件的取数已全部交给 query hook，不再需要「等挂载」这个时机。
// 失败不阻塞主流程（筛选项缺失只是下拉少几个选项）。
void (async () => {
  try {
    const res = await listWorkTypes({ limit: 200 });
    workTypes.value = res.items;
  } catch {
    // 工种筛选下拉缺失不阻塞主流程。
  }
})();

// 2026-08-27 Task 9：列顺序拖动 + 可见性。
// 「操作」列 fixed=right，不进 defs（保持 literal 渲染，永不隐藏/拖动）。
const tableRef = ref();
const columnDefs: ColumnDef[] = [
  {
    key: 'worker_name',
    label: '工人',
    prop: 'worker_name',
    minWidth: 120,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as WorkerStatsRow;
      return h('span', [
        h('span', r.worker_name),
        r.is_active === false
          ? h(
              ElTag,
              { type: 'info', size: 'small', effect: 'plain', style: 'margin-left: 6px' },
              () => '已停用',
            )
          : null,
      ]);
    },
  },
  { key: 'badge_code', label: '工牌', prop: 'badge_code', minWidth: 140, align: 'center' },
  {
    key: 'work_type_name',
    label: '工种',
    prop: 'work_type_name',
    minWidth: 140,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as WorkerStatsRow;
      return r.work_type_name
        ? h(ElTag, { type: 'primary', size: 'small', effect: 'plain' }, () => r.work_type_name)
        : h('span', { style: 'color: #c0c4cc' }, '未分配');
    },
  },
  {
    key: 'participated_part_count',
    label: '参与工单数',
    prop: 'participated_part_count',
    minWidth: 110,
    align: 'center',
    sortable: true,
  },
  {
    key: 'pickup_count',
    label: '领取次数',
    prop: 'pickup_count',
    minWidth: 100,
    align: 'center',
    sortable: true,
  },
  {
    key: 'pickup_quantity',
    label: '领取件数',
    prop: 'pickup_quantity',
    minWidth: 100,
    align: 'center',
    sortable: true,
  },
  {
    // 2026-10-12 新增：有效工时。后端一律给**分钟整数**（f64 累加的 0.1+0.2 类误差
    // 不能留在前端做），换算与四舍五入都在这里、展示 1 位小数。
    // ⚠️ 该口径要求工单配了工序链，没配链的工单恒为 0 —— 大面积 0 是口径的必然结果，
    // 不要在 UI 上为它加特殊分支或「修正」。
    key: 'effective_minutes',
    label: '有效工时（小时）',
    prop: 'effective_minutes',
    minWidth: 120,
    align: 'center',
    sortable: true,
    cellRender: ({ row }) =>
      h('span', minutesToHoursText((row as WorkerStatsRow).effective_minutes)),
  },
  {
    key: 'contribution_pct',
    label: '贡献度',
    minWidth: 200,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as WorkerStatsRow;
      // 硬约束 #11：EP 会用合成空行 { row: {} } 额外渲染一次 → 需空值守卫
      return r.contribution_pct !== null && r.contribution_pct !== undefined
        ? h(ElProgress, {
            percentage: Number(r.contribution_pct.toFixed(1)),
            strokeWidth: 10,
          })
        : h('span', { style: 'color: #c0c4cc' }, '—');
    },
  },
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'worker_stats' });
const drag = useColumnDrag(columnDefs, { listKey: 'worker_stats' });
// 2026-08-28 改造：直接传实例 ref；composable 内部 watch(ref) + MutationObserver 自愈。
drag.applyDrag(tableRef);

// 前端筛过的工人列表
const filteredRows = computed<WorkerStatsRow[]>(() => {
  const wt = workTypeFilter.value;
  return rows.value.filter((r) => {
    if (!includeInactive.value && !r.is_active) return false;
    if (wt === '__all__') return true;
    if (wt === '__none__') return r.work_type_id === null;
    return r.work_type_id === wt;
  });
});

// 默认 sort：领取次数降序（表格排序不受图表指标切换影响，图表切换只动图）。
const sortedRows = computed<WorkerStatsRow[]>(() => {
  return [...filteredRows.value].sort((a, b) => b.pickup_count - a.pickup_count);
});

function onSelectWorker(workerId: string): void {
  emit('selectWorker', workerId);
}

function onWorkTypeChange(): void {
  // 仅触发 computed；无需主动取数。
}

// ============== 有效工时的单位换算 ==============

/** 小时数值 → 1 位小数文案；值不可用时给占位符「—」（绝不吐 NaN / Infinity）。 */
function formatHours(hours: unknown): string {
  const v = Number(hours);
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}

/** 后端分钟整数 → 小时文案。换算在前端做，展示保留 1 位小数。 */
function minutesToHoursText(minutes: unknown): string {
  return formatHours(Number(minutes) / 60);
}

// ============== ECharts options ==============

// 2026-10-14 新增：图走全局 <v-chart>（vue-echarts，模块化注册在 src/plugins/echarts.ts）。
// 四处传参各有理由：
//
//   - :update-options="{ notMerge: true }"：option 是 computed 每次重算的整份新对象，
//     更新语义显式钉死成「整份替换」。不传 update-options 时 vue-echarts 走结构签名
//     planner（它比对前后 option 的结构签名，结构变了自己会翻成 notMerge，只有纯数值
//     变化才合并）—— 那是库的启发式、随版本漂移 ⇒ 显式钉死，不依赖 planner 判断。
//     切指标只改 series.data 与 xAxis.minInterval（xAxis.type 两支恒为 'value'）。
//   - autoresize：vue-echarts 内建 ResizeObserver（默认 100ms 节流，尺寸未变时跳过 resize）。
//   - theme="v5"：锁定配色 / legend 默认位置（v5 主题在 src/plugins/echarts.ts 注册）。
//   - :init-options="{ renderer: 'canvas' }"：渲染器不交给缺省值，显式钉 canvas。

/** 2026-10-12 新增：图表指标可切「领取次数 / 有效工时」。默认仍是「领取次数」
 *  （与本轮之前一致）；两档的数据来源是同一份 rows，只是取的字段与单位不同。 */
type ChartMetric = 'pickup' | 'effective';
const chartMetric = ref<ChartMetric>('pickup');
const chartMetricOptions: Array<{ value: ChartMetric; label: string }> = [
  { value: 'pickup', label: '领取次数' },
  { value: 'effective', label: '有效工时' },
];

/** 当前指标的展示名（进图表标题与提示）。 */
const chartMetricLabel = computed<string>(() =>
  chartMetric.value === 'pickup' ? '领取次数' : '有效工时（小时）',
);

/** 当前指标下单个工人的取值：次数直接取数；有效工时由分钟换算成小时。 */
function metricValue(r: WorkerStatsRow): number {
  return chartMetric.value === 'pickup' ? r.pickup_count : r.effective_minutes / 60;
}

const chartTitle = computed<string>(() => {
  const wt = workTypeFilter.value;
  const metric = chartMetricLabel.value;
  if (wt === '__all__') return `${metric} Top 10`;
  if (wt === '__none__') return `未分配工种 - ${metric}`;
  const w = workTypes.value.find((x) => x.id === wt);
  return w ? `${w.name} - ${metric}` : metric;
});

const barOption = computed(() => {
  const list = filteredRows.value;
  // 全部 → 当前指标前 10；指定工种 → 全量。
  const byMetric = [...list].sort((a, b) => metricValue(b) - metricValue(a));
  const show = workTypeFilter.value === '__all__' ? byMetric.slice(0, 10) : byMetric;
  // 倒序让 bar 从上到下递增（yAxis 默认下小上大）
  const sorted = show.slice().reverse();
  const names = sorted.map((r) => r.worker_name);
  const values = sorted.map((r) => metricValue(r));
  const isPickup = chartMetric.value === 'pickup';
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 100, right: 30, top: 20, bottom: 30 },
    // 次数是整数（minInterval: 1）；小时是小数，不设整数刻度。
    xAxis: isPickup ? { type: 'value', minInterval: 1 } : { type: 'value' },
    yAxis: { type: 'category', data: names, axisLabel: { fontSize: 12 } },
    series: [
      {
        type: 'bar',
        data: values,
        itemStyle: { color: '#409eff' },
        label: {
          show: true,
          position: 'right',
          formatter: (p: { value: number }) =>
            isPickup ? `${p.value}` : formatHours(Number(p.value)),
        },
      },
    ],
  };
});
</script>

<style lang="scss" scoped>
.worker-stats-tab {
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.filter-card :deep(.el-card__body) {
  padding-bottom: 0;
}

.chart-title {
  font-weight: 600;
  font-size: 14px;
}

/* 图表容器：宽跟随卡片，高由模板里的 style 绑定给（360px）。min-width: 0 防 flex
   子项被内容顶开。 */
.chart {
  width: 100%;
  min-width: 0;
}

/* 2026-10-12：图表标题 + 指标切换控件同行 */
.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* 2026-08-27 Task 9：列设置工具条 */
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>
