<!-- src/components/BatchCard.vue
     2026-10-02 新增：生产队列看板**唯一**批次卡片组件，工序池（PoolDrawer）、工人列
     （WorkerColumn）、待下发池（PendingBatchesPanel）三处共用。三个 wire DTO 经
     views/production/composables/poolItemToCard.ts 统一适配成 BatchCardModel，组件只认
     该类型、不感知 DTO 差异。

     2026-10-03 升为**全仓共享组件**（原 views/workers/components/BatchCard.vue）：
     外协看板复用同一张卡。新增两处扩展，**都不动 body**：
     - `version`（OCC 锚）：卡片不渲染它，消费侧（外协收发的两个写端点）从 model 读；
     - `extra`（领域扩展槽）：只进 tooltip，逐行 `v-if`，任何域不填就当没这行。

     - 固定 200×96：生产队列是「一屏看尽可能多批次」的密集看板，卡片尺寸必须恒定，
       否则批次一多就出现参差瀑布流、扫视时无法建立行对齐的视觉预期。四个必备字段
       （零件名 / 序列号 / 数量+交期 / 批次号）竖排 4 行恰好塞进 96px（4×18 行高 +
       3×2 gap + 上下各 8 padding + 上下各 1px 边框 = 96px，正好塞满）。
     - body 只放 4 个字段，**高度是硬预算**（见下方 .row 的行高注释）：新增信息一律进
       tooltip，加第 5 行会直接撑破 96px 固定高。header 是批次对应的 part 名称（识别
       批次的主线索），body 给「这批是什么 / 有多少 / 什么时候要 / 哪一批」；图号、客户、
       申请人、计划交期、所在位置、备注都是低频查阅项，全部进 tooltip —— hover 才展开，
       不占常态可视面积。body 的交期只取 system_delivery_date（系统交期是唯一有承诺口径
       的日期），planned_delivery_date 只进 tooltip。
     - 根元素用普通 div 而非 el-card：el-card 自带 `--el-card-padding: 20px` 与
       header 底边框，96px 固定高度放不下；且根元素要同时当 Sortable 的可拖项（需要
       干净的 DOM 根 + `data-*` dataset 供 PoolDrawer/WorkerColumn 读 batch_id /
       shelf_id）、承父级透传的 `data-*`（故 `inheritAttrs: false` + `v-bind="$attrs"`）、
       以及手写 hover 抬升 box-shadow。
     - 2026-10-04 硬不变式：**根必须是单个元素**，且该元素就是 vnode 的全部 DOM
       footprint。Sortable 搬的是 `evt.item` 这一个节点，Vue 卸载时也只认
       `vnode.el`：根一旦是多根 vnode（Fragment），Vue 会在两侧插锚点，锚点跟着留在
       容器里而卡片元素被搬走，投放后按原下标放回会落到锚点范围之外，卸载走
       `removeFragment()` 够不到卡片 ⇒ 每次投放残留一个幻影节点。el-tooltip 因此只包
       根内部的触发区 `.card-body`；已知取舍是鼠标停在左上角勾选框那一小块
       （20×18px）不弹 tooltip。守卫：src/components/__tests__/BatchCardDndFootprint.spec.ts。 -->
<template>
  <div
    v-bind="$attrs"
    :class="['batch-card', { 'is-selectable': selectable, 'is-selected': selectable && selected }]"
    :data-batch-id="batch.batch_id"
  >
    <!-- 2026-10-04：上面这个 div 是**唯一**根节点，也是本 vnode 的全部 DOM footprint
         —— Sortable 搬的就是它、Vue 卸载时删的也是它。两条约束：
         ① 根不能是 Fragment（多根 vnode 会在两侧插锚点，锚点留在容器里而卡片元素被搬走，
            投放后按原下标放回会落到锚点范围之外，卸载走 removeFragment() 够不到卡片
            ⇒ 每次投放残留一个幻影卡片，卡片停在原位、刷新浏览器才恢复）；
         ② 根上方的 template 里**不许有任何注释或元素** —— dev 构建保留注释，一个顶层注释
            就会让本组件变成多根、同样踩 ①。
         故 el-tooltip 只包根内部的触发区 .card-body，不包根。
         守卫见 src/components/__tests__/BatchCardDndFootprint.spec.ts。 -->
    <!-- 勾选角标：只有待下发池需要多选下发，故由 selectable 开关控制显隐。
         绝对定位在卡片左上角（left 4px / top 4px），第 1 行让位 20px。
         它在触发区（.card-body）之外 ⇒ 鼠标停在这一小块（20×18px）不弹 tooltip。 -->
    <el-checkbox
      v-if="selectable"
      class="card-check"
      size="small"
      :model-value="selected"
      @change="onToggleSelect"
      @click.stop
    />
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
          <!-- 2026-10-03：领域扩展槽（外协看板在用）逐行渲染，每行独立 v-if ——
               槽内字段全部可选且 nullable，不填就当没这行，tooltip 与生产队列
               域下逐行一致。can_auto_receive 用显式 === false / === true 判定：
               它是「接收能否免填工序/货架」的**否定语义**，只渲染 false 一侧会让
               「可自动」与「未知」无法区分。 -->
          <div v-if="batch.extra?.outsource_company_name">
            <span class="tt-label">外协公司</span
            ><span>{{ batch.extra.outsource_company_name }}</span>
          </div>
          <div v-if="batch.extra?.outsource_process_name">
            <span class="tt-label">外协工序</span
            ><span>{{ batch.extra.outsource_process_name }}</span>
          </div>
          <div v-if="batch.extra?.price">
            <span class="tt-label">单价</span><span>{{ batch.extra.price }}</span>
          </div>
          <div v-if="batch.extra?.sent_at">
            <span class="tt-label">发出时间</span><span>{{ batch.extra.sent_at }}</span>
          </div>
          <div v-if="batch.extra?.can_auto_receive === false">
            <span class="tt-label">接收</span><span>需手填工序 / 货架</span>
          </div>
          <div v-else-if="batch.extra?.can_auto_receive === true">
            <span class="tt-label">接收</span><span>可自动带出工序 / 货架</span>
          </div>
        </div>
      </template>
      <!-- tooltip 触发区 = 整块卡面。它是 el-tooltip 默认 slot 里**唯一**的合法子节点
           （ElOnlyChild 多个合法子节点会 debugWarn），且必须吃满根的可用高度。 -->
      <div class="card-body">
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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { BatchCardModel } from '@/types/batchCard';

const props = withDefaults(
  defineProps<{
    /** 卡片数据（DTO 已在适配层转成本类型，组件零 DTO 依赖）。 */
    batch: BatchCardModel;
    /** 是否渲染左上角勾选角标 —— 仅待下发池（多选下发）传 true。 */
    selectable?: boolean;
    /** 勾选态（父级持有的已选集合决定，组件自身不存勾选状态）。 */
    selected?: boolean;
    /** 左侧 4px 竖条颜色（CSS 颜色值，含 '#RRGGBBAA'）。null/undefined = 回落到
     *  is_urgent 橙色，不着色时透明。
     *  全仓暂无调用方传这个 prop，当前生效的只有「is_urgent 回落」这一级；带工序色
     *  左边框的 PendingPoolCard 是另一个组件、自己用 inline :style 着色，两者不共用
     *  机制。本 prop 保留作为统一卡片的公开 API。 */
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
const accentVar = computed(
  () => props.accentColor ?? (props.batch.is_urgent ? 'var(--el-color-warning)' : 'transparent'),
);

/** tooltip 是否有可展示的详情：body 只放 4 个字段，其余全靠 tooltip，
 *  一个详情都没有时干脆不弹（避免空浮层）。`extra` 单独探测：槽对象本身存在
 *  不代表有内容（`{}` / 全 null），故按字段逐个判空；`can_auto_receive` 是三态
 *  布尔，只认 true / false 两侧，null 与 undefined 视作「没有这条信息」。 */
const hasDetails = computed<boolean>(() => {
  const batch = props.batch;
  const extra = batch.extra;
  return (
    !!batch.drawing_no ||
    !!batch.serial_no ||
    !!batch.batch_no ||
    !!batch.customer_l1 ||
    !!batch.customer_l2 ||
    !!batch.applicant_name ||
    !!batch.planned_delivery_date ||
    !!batch.location ||
    !!batch.note ||
    !!extra?.outsource_company_name ||
    !!extra?.outsource_process_name ||
    !!extra?.price ||
    !!extra?.sent_at ||
    extra?.can_auto_receive === true ||
    extra?.can_auto_receive === false
  );
});

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
/* 勾选态（仅 selectable 场景 —— 工序池 / 工人列的卡片没有勾选语义）：主色描边 + 浅主色
   底 + 外发光。`border-color` 简写只重置四边的**颜色**，不碰 border-style / border-width，
   故左边框仍是 4px、只是染上主色 —— 四边描边粗细一致、读起来才是同一个框。
   加急语义由 body 内的橙色「加急」tag 承载，不依赖左边框着色。
   回归守卫见 src/components/__tests__/BatchCard.spec.ts 的源码契约用例。 */
.batch-card.is-selected {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  box-shadow: 0 0 0 1px var(--el-color-primary);
}
/* 2026-10-04：tooltip 触发区 = 整块卡面（el-tooltip 的默认 slot，只包这一层）。
   行高 / gap 的 96px 算式不变，只是承载 4 行的那层从根挪到这里：
   4×18 + 3×2 gap + 上下各 8 padding + 上下各 1px 边框 = 96px。flex:1 保证它吃满
   根的可用高度（触发区塌成 0 高度 tooltip 就永不出现）。 */
.card-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* 2026-10-02：勾选角标绝对定位在 left/top 4px，而 EP 2.14.6 的 .el-checkbox--small
   直接把 height 钉死成 24px（不吃 --el-checkbox-height 变量，基类 .el-checkbox 的
   var 兜底形同虚设），y 4..28 会探进第 2 行（y 8..26）2px。
   选择器必须挂到父级 .batch-card 上：scoped 编译后是
   `.batch-card .card-check[data-v-*]` = (0,3,0)，确定性压过 EP 的
   `.el-checkbox.el-checkbox--small` = (0,2,0)，与样式表注入顺序无关。
   只写 `.card-check`（编译后 (0,2,0)）与 EP 是平局，胜负取决于打包产物的注入顺序、
   不可靠；也不用 !important。 */
.batch-card .card-check {
  position: absolute;
  left: 4px;
  top: 4px;
  height: 18px;
}
.row {
  display: flex;
  align-items: center;
  min-width: 0;
  /* 4 行统一 18px 行高：4×18 + 3×2 gap + 上下各 8 padding + 上下各 1px 边框 = 96px，
     与固定高持平、无余量 —— 行高就是硬预算，长零件名被 .part-name 的 ellipsis 截断
     （不会换行撑高），保证 4 行始终塞得下。 */
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
