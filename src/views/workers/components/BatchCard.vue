<!-- src/views/workers/components/BatchCard.vue
     2026-10-02 新增：生产队列看板**唯一**批次卡片组件，工序池（PoolDrawer）、工人列
     （WorkerColumn）、待下发池（PendingBatchesPanel）三处共用。三个 wire DTO 经
     views/workers/composables/poolItemToCard.ts 统一适配成 BatchCardModel，组件只认
     该类型、不感知 DTO 差异。

     - 固定 200×96：生产队列是「一屏看尽可能多批次」的密集看板，卡片尺寸必须恒定，
       否则批次一多就出现参差瀑布流、扫视时无法建立行对齐的视觉预期。四个必备字段
       （零件名 / 序列号 / 数量+交期 / 批次号）竖排 4 行恰好塞进 96px（4×18 行高 +
       3×2 gap + 上下各 8 padding = 86px，余量 10px 吸收字体行高波动）。
     - body 只放 4 个字段：header 是批次对应的 part 名称（识别批次的主线索），body
       给「这批是什么 / 有多少 / 什么时候要 / 哪一批」；图号、客户、申请人、计划交期、
       所在位置、备注都是低频查阅项，全部进 tooltip —— hover 才展开，不占常态可视面积。
       body 的交期只取 system_delivery_date（系统交期是唯一有承诺口径的日期），
       planned_delivery_date 只进 tooltip。
     - 根元素用普通 div 而非 el-card：el-card 自带 `--el-card-padding: 20px` 与
       header 底边框，96px 固定高度放不下；且根元素要同时当 Sortable 的可拖项（需要
       干净的 DOM 根 + `data-*` dataset 供 PoolDrawer/WorkerColumn 读 batch_id /
       shelf_id）、承父级透传的 `data-*`（故 `inheritAttrs: false` + `v-bind="$attrs"`）、
       以及手写 hover 抬升 box-shadow。 -->
<template>
  <el-tooltip placement="top" :show-after="200" :disabled="!hasDetails">
    <template #content>
      <div class="card-tooltip">
        <div v-if="batch.drawing_no">
          <span class="tt-label">图号</span><span>{{ batch.drawing_no }}</span>
        </div>
        <!-- 序列号 / 批次号在 200px 宽的 body 里会被截断，tooltip 里必须再列一遍完整值。 -->
        <div v-if="batch.serial_no">
          <span class="tt-label">序列号</span><span>{{ batch.serial_no }}</span>
        </div>
        <div v-if="batch.batch_no">
          <span class="tt-label">批次号</span><span>{{ batch.batch_no }}</span>
        </div>
        <div v-if="batch.customer_l1">
          <span class="tt-label">客户(L1)</span><span>{{ batch.customer_l1 }}</span>
        </div>
        <div v-if="batch.customer_l2">
          <span class="tt-label">客户(L2)</span><span>{{ batch.customer_l2 }}</span>
        </div>
        <div v-if="batch.applicant_name">
          <span class="tt-label">申请人</span><span>{{ batch.applicant_name }}</span>
        </div>
        <div v-if="batch.planned_delivery_date">
          <span class="tt-label">计划交期</span><span>{{ batch.planned_delivery_date }}</span>
        </div>
        <div v-if="batch.location">
          <span class="tt-label">所在位置</span><span>{{ batch.location }}</span>
        </div>
        <div v-if="batch.note">
          <span class="tt-label">备注</span><span>{{ batch.note }}</span>
        </div>
      </div>
    </template>
    <div
      v-bind="$attrs"
      :class="[
        'batch-card',
        { 'is-selectable': selectable, 'is-selected': selectable && selected },
      ]"
      :data-batch-id="batch.batch_id"
    >
      <!-- 勾选角标：只有待下发池需要多选下发，故由 selectable 开关控制显隐。
           绝对定位在卡片左上角（left 4px / top 4px），第 1 行让位 20px。 -->
      <el-checkbox
        v-if="selectable"
        class="card-check"
        size="small"
        :model-value="selected"
        @change="onToggleSelect"
        @click.stop
      />
      <div :class="['row', { 'row--shifted': selectable }]">
        <span class="part-name" :title="batch.part_name">{{ batch.part_name }}</span>
      </div>
      <div class="row">
        <span class="serial-no">{{ batch.serial_no ?? '—' }}</span>
        <span class="tags">
          <span v-if="batch.is_urgent" class="tag tag--urgent">加急</span>
          <span v-if="batch.has_cnc_program" class="tag tag--cnc">已编程</span>
        </span>
      </div>
      <div class="row">
        <span class="qty">×{{ batch.quantity }}</span>
        <span class="dot">·</span>
        <span class="due">{{ batch.system_delivery_date ?? '—' }}</span>
      </div>
      <div class="row">
        <span class="batch-no">{{ batch.batch_no }}</span>
      </div>
    </div>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { BatchCardModel } from '@/types/workerPool';

const props = withDefaults(
  defineProps<{
    /** 卡片数据（DTO 已在适配层转成本类型，组件零 DTO 依赖）。 */
    batch: BatchCardModel;
    /** 是否渲染左上角勾选角标 —— 仅待下发池（多选下发）传 true。 */
    selectable?: boolean;
    /** 勾选态（父级持有的已选集合决定，组件自身不存勾选状态）。 */
    selected?: boolean;
    /** 左侧 4px 竖条颜色（CSS 颜色值，含 '#RRGGBBAA'）。null/undefined = 回落到
     *  is_urgent 橙色，不着色时透明。 */
    accentColor?: string | null;
  }>(),
  {
    selectable: false,
    selected: false,
    accentColor: null,
  },
);

const emit = defineEmits<(e: 'toggleSelect') => void>();

defineOptions({ name: 'BatchCard', inheritAttrs: false });

/** 左侧竖条色：显式 accentColor 优先，其次加急橙色（沿用旧卡片的 #e6a23c，
 *  即 --el-color-warning），都不满足则透明。 */
const accentVar = computed<string>(
  () => props.accentColor ?? (props.batch.is_urgent ? 'var(--el-color-warning)' : 'transparent'),
);

/** tooltip 是否有可展示的详情：body 只放 4 个字段，其余全靠 tooltip，
 *  一个详情都没有时干脆不弹（避免空浮层）。 */
const hasDetails = computed<boolean>(
  () =>
    !!props.batch.drawing_no ||
    !!props.batch.serial_no ||
    !!props.batch.batch_no ||
    !!props.batch.customer_l1 ||
    !!props.batch.customer_l2 ||
    !!props.batch.applicant_name ||
    !!props.batch.planned_delivery_date ||
    !!props.batch.location ||
    !!props.batch.note,
);

// 勾选态翻转：不带 payload，batch_id 由消费侧从 `batch.batch_id` 读。
function onToggleSelect(): void {
  emit('toggleSelect');
}
</script>

<style scoped>
.batch-card {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 200px;
  height: 96px;
  padding: 8px 10px;
  overflow: hidden;
  /* 200px 含 4px 左边框（border-box），四周圆角裁掉竖条与边框的直角 */
  border: 1px solid var(--el-border-color-lighter);
  border-left: 4px solid transparent;
  border-radius: 8px;
  background: var(--el-bg-color);
  border-left-color: v-bind(accentVar);
  transition:
    border-color 0.2s,
    background 0.2s,
    box-shadow 0.2s;
}
/* 代替 el-card 的 shadow="hover"：抬升量克制，密集看板里多卡同时 hover 不刺眼。 */
.batch-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.batch-card.is-selectable {
  cursor: grab;
}
/* 2026-10-02：沿用旧卡片的选中态规则（主色描边 + 浅主色底 + 外发光），仅在
   selectable 场景启用 —— 工序池 / 工人列的卡片没有勾选语义。
   只覆盖上/右/下三边：左边框是加急橙（accentVar）的语义位，勾选态不能吃掉它。 */
.batch-card.is-selected {
  border-top-color: var(--el-color-primary);
  border-right-color: var(--el-color-primary);
  border-bottom-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  box-shadow: 0 0 0 1px var(--el-color-primary);
}
.card-check {
  position: absolute;
  left: 4px;
  top: 4px;
}
.row {
  display: flex;
  align-items: center;
  min-width: 0;
  /* 4 行统一 18px 行高：4×18 + 3×2 gap + 上下各 8 padding = 86px ≤ 96px 固定高，
     余量 10px 吸收字体渲染的行高波动，保证长零件名也不会把 4 行撑破。 */
  line-height: 18px;
  font-size: 12px;
}
/* 勾选角标占据左上角 20px，第 1 行让位避免文字压住勾选框。 */
.row--shifted {
  padding-left: 20px;
}
.part-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.serial-no,
.batch-no {
  font-family: var(--el-font-family-monospace, monospace);
}
.serial-no {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tags {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}
/* tag 用裸 span 代替 el-tag：el-tag 的最小高度 24px 在 96px 卡片的 18px 行里放不下。 */
.tag {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
  color: #fff;
  white-space: nowrap;
}
.tag--urgent {
  background: var(--el-color-warning);
}
.tag--cnc {
  background: var(--el-color-success);
}
.qty {
  font-weight: 600;
  color: var(--el-color-primary);
}
.dot {
  margin: 0 4px;
  color: var(--el-text-color-placeholder);
}
.due {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.batch-no {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.card-tooltip .tt-label {
  display: inline-block;
  min-width: 5em;
  color: rgba(255, 255, 255, 0.65);
}
.card-tooltip > div {
  display: flex;
  gap: 8px;
  line-height: 1.6;
}
</style>
