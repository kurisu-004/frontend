<!--
  PartRowCard.vue

  报工台列表行（`.part-row`）的**唯一渲染实现**，2026-10-11 从 ScanPickParts /
  ScanReturnParts / ScanInspectParts 三页抽出。
  抽取动因是本轮要同时改三页的卡片（列数 / 容器宽度 / 预览按钮 / 预览弹窗），
  而三页此前是「模板 + CSS + 预览按钮」逐字三份复制 —— 改一处就得改三处，
  漏一处就出现两套外观。

  内容：序列号 + 加急 tag + 系统交期 chip + 名称 + `× 数量` + 预览按钮。

  ⚠️ **左边框只承载链语义**（`has-chain`，绿）：流程区分由顶栏标题 + 路由承担，与
  `BatchCard.vue` 同一口径。规则走**类绑定**（`chainRowClass()`）而不是模板 inline
  `:style`：inline 优先于任何非 `!important` 规则，会盖住下面 `.is-selected` /
  `.is-urgent` 的 `border-color` 简写，表现为选中态左边框退成中性色。故
  `.part-row.has-chain` 必须排在全部状态类**之后**（同档 0,2,0 靠源码顺序取胜）——
  守卫见 `__tests__/ScanReturnChainFlow.spec.ts` 的源码契约用例。

  ⚠️ **根是单个 `el-card` 元素、上方不留任何模板注释**：卡片类组件的 DOM footprint
  等于它的 vnode footprint，多根（Fragment）会让「按位置搬运节点」的投放逻辑把卡片
  落在自己那对锚点之外（CLAUDE.md「拖拽投放」一节）。

  2026-10-11 随抽取统一的两处色值：`:hover` 阴影色与 `.qty` 颜色此前按流程各给一份
  （蓝 / 琥珀 / 琥珀）。流程区分归顶栏与路由，卡片上不再留第二套流程配色。

  纯展示：**不碰 query、不发请求**，数据由调用方从 `useScanXxxQuery` 传进来。
  「选中」与「预览中」由调用方算好传进来（选中态有三页各自的判定口径，预览中的
  行号由页面自己的竞态令牌决定），组件只负责渲染与抛事件。
-->

<template>
  <el-card
    :data-batch-id="String(row.batch_id || row.id)"
    shadow="hover"
    :class="[
      'part-row',
      {
        'is-selected': selected,
        'is-urgent': row.is_urgent,
      },
      chainRowClass(row.has_process_chain),
    ]"
    @click="emit('select', row)"
  >
    <div class="part-row-main">
      <!-- 右上角预览按钮（@click.stop 阻止冒泡触发选中） -->
      <el-button
        text
        size="small"
        type="info"
        class="preview-btn"
        :loading="previewing"
        @click.stop="emit('preview', row)"
      >
        <el-icon><View /></el-icon>
        <span>预览</span>
      </el-button>

      <!-- 1) 序列号 + 交期 高优行 -->
      <div class="part-line-top">
        <span class="serial-no" :title="row.serial_no || row.drawing_no">
          {{ row.serial_no || row.drawing_no }}
        </span>
        <el-tag v-if="row.is_urgent" type="danger" size="small" effect="dark" class="urgent-pulse"
          >加急</el-tag
        >
        <!-- 2026-10-04：chip 只显示系统交期，无值显示 '-'（恒渲染，不加 v-if）。
             两个交期字段不是一回事：`planned_delivery_date` 是 `t_part` 上的真实
             计划交期，`system_delivery_date` 是后端系统推算的交付日、未推算时为
             null（两者口径见 composables/scanSchema.ts）。本卡片只用系统交期，
             取不到就显示 '-'，不拿计划交期顶替；计划交期上屏在持有件列表
             （components/HeldPartsList.vue），排序里用到本键的那一支见
             composables/useScanPartsSort.ts。 -->
        <DeliveryDateChip :system-delivery-date="row.system_delivery_date" />
      </div>

      <!-- 2) 名称 -->
      <div class="part-line-name">
        <span class="part-name" :title="row.name">{{ row.name }}</span>
      </div>

      <!-- 3) 数量（批次全量；本页实际流转的数量由 QuantityDialog 选） -->
      <div class="part-line-bottom">
        <span class="qty">× {{ row.quantity }}</span>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { View } from '@element-plus/icons-vue';
import DeliveryDateChip from './DeliveryDateChip.vue';
import { chainRowClass } from '@/views/production/scan/chainAccent';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';

withDefaults(
  defineProps<{
    /** 一行列表行（queryFn 守门后的 `ScanPartRowSchema`）。 */
    row: ScanPartRowSchema;
    /** 选中态。各页判定口径不同（批次锚点比较 / 只读页恒 false），由调用方算好传入。 */
    selected?: boolean;
    /** 该行的图纸预览正在加载（按钮转圈）。 */
    previewing?: boolean;
  }>(),
  { selected: false, previewing: false },
);

const emit = defineEmits<{
  select: [row: ScanPartRowSchema];
  preview: [row: ScanPartRowSchema];
}>();
</script>

<style lang="scss" scoped>
.part-row {
  display: flex !important;
  align-items: stretch;
  padding: 14px 18px !important;
  border: 1px solid #e4e7ed;
  /* 左边框底色与另外三边同色；链语义绿由下面的 `.part-row.has-chain` 覆盖，
     状态类（.is-selected / .is-urgent）不动左边框。 */
  border-left: 4px solid #e4e7ed;
  border-radius: 8px;
  cursor: pointer;
  position: relative;
  background: #fff;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s;
}
.part-row:hover {
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.08);
}

/* 非加急选中 → 加深绿底 */
.part-row.is-selected {
  background: #e1f3d8;
  border-color: #67c23a;
}
/* 加急未选中 → 原红底（左边框不参与加急：它归链语义，加急由红底 + 「加急」tag 表达） */
.part-row.is-urgent {
  background: #fef0f0;
  border-color: #f56c6c;
}
/* 加急选中 → 保持红底，绿色边框 + inset 阴影表示选中 */
.part-row.is-urgent.is-selected {
  background: #fef0f0;
  border-color: #67c23a;
  box-shadow: 0 0 0 2px #67c23a inset;
}
/* 左边框 = 链语义（有制定工序链且链指针未漂移），EP 语义绿的字面值。
   必须排在全部状态类之后：与它们同为 0,2,0，靠源码顺序取胜，这样
   `border-color` 简写染过的四边里左边框仍归链语义。 */
.part-row.has-chain {
  border-left-color: #67c23a;
}

.part-row-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.preview-btn {
  position: absolute !important;
  top: 8px;
  right: 10px;
  z-index: 1;
}

.part-line-top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-right: 64px;
  flex-wrap: wrap;
}
/* 2026-10-11：卡片收窄到三列后，长序列号 / 长名称必须截断而不是折行 —— 折行会把一张
   卡撑成两行高，整列卡片高度参差，网格看着是坏的。`.part-line-top` 有 flex-wrap，
   序列号那行一旦折行最先被顶开。`min-width: 0` 是 flex 子项能触发 ellipsis 的前提。 */
.serial-no {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 22px;
  font-weight: 700;
  color: #303133;
  letter-spacing: 0.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.part-line-name {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  color: #303133;
  min-width: 0;
}
.part-name {
  font-weight: 500;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.part-line-bottom {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 14px;
  color: #606266;
  flex-wrap: wrap;
}
.qty {
  color: #409eff;
  font-weight: 700;
  font-size: 15px;
}

@keyframes urgentPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}
.urgent-pulse {
  animation: urgentPulse 1.2s ease-in-out infinite;
}
</style>
