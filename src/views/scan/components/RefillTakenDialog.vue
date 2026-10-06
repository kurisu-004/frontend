<!--
  RefillTakenDialog.vue

  报工台「送检 / 放回」提交成功后，告知工人系统已经**自动给他接了批**的弹窗。

  为什么需要它：`POST /prod/batches/worker-scan` 与扫码写入**同事务**跑一次
  `WorkerPoolService::refill_for_worker`，抢到多少批不由工人决定（抢满工种
  `max_held_batches` 或池空为止）。若只在列表里体现，工人看到「刚放回的那件消失了、
  多了一件新的」根本分不清是自己刚加工完的活还是系统补的料 —— 现场最典型的后果是
  把补的料当成加工完的活再放回一次。所以这里把 `refill.taken[]` 逐条摊开：序列号 +
  数量 + 系统交期（复用卡片同款 `DeliveryDateChip`，交期紧迫度口径不分叉）。

  组件**零 `api/*` 依赖**、不 import 任何 store：`taken` 由父组件从 worker-scan 响应里
  取出来传入，本组件只负责展示 + 抛一个「知道了」的关闭事件。

  `leadText` 承载**本次扫码动作本身的成功文案**（「已送检：F2117」/「已放回：F2117 →
  下料」）。父组件在本弹窗打开时**不发** `ElMessage.success` —— Element Plus 的
  z-index 是单一全局计数器，后开的 dialog 遮罩必然盖在先发的 toast 上（同
  `ProcessPickerDialog` 的 hint 结论），成功提示会变成遮罩下一坨压暗的字。把它
  挪进弹窗正文，成功与补料两个信息一起看，也不必靠改动 z-index 的时序赌运气。

  视觉与交互照 `ReturnConfirmDialog.vue` 的 HMI 骨架（大按钮 + 禁遮罩 / 禁 ESC +
  禁右上角 ×）：本弹窗是**告知**而非决策，唯一出口是 worker 亲手确认已读，
  不给「扫过去就消失」的静默路径。

  props:
    modelValue: boolean           // 弹窗可见
    items: TakenItemDto[]         // refill.taken 原样传入（父组件保证非空才开窗）
    leadText?: string             // 本次扫码动作的成功文案（与补料信息合并展示）
  emits:
    update:modelValue(v: boolean)
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="已自动接取批次"
    width="800px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="refill-body">
      <p v-if="leadText" class="lead-text">
        <el-icon :size="22" color="#67c23a"><CircleCheckFilled /></el-icon>
        <span>{{ leadText }}</span>
      </p>
      <p class="refill-text">
        {{
          items.length === 1
            ? '系统已自动为您接取以下批次：'
            : `系统已自动为您接取以下 ${items.length} 个批次：`
        }}
      </p>
      <ul class="taken-list">
        <li v-for="it in items" :key="it.batch_id" class="taken-row">
          <div class="taken-main">
            <span class="serial-no">{{ it.serial_no || it.drawing_no }}</span>
            <el-tag v-if="it.is_urgent" type="danger" size="small" effect="dark" class="urgent-tag"
              >加急</el-tag
            >
          </div>
          <div class="taken-meta">
            <span class="qty">× {{ it.quantity }}</span>
            <DeliveryDateChip :system-delivery-date="it.system_delivery_date" />
          </div>
        </li>
      </ul>
      <p class="refill-hint">这些批次已记在您名下，请按系统交期安排加工顺序。</p>
    </div>
    <template #footer>
      <el-button type="primary" size="large" class="ack-btn" @click="onAck">知道了</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { CircleCheckFilled } from '@element-plus/icons-vue';
import DeliveryDateChip from '@/views/scan/components/DeliveryDateChip.vue';
import type { TakenItemDto } from '@/api/productionQueue.contract';

defineProps<{
  modelValue: boolean;
  /** refill.taken 原样传入；父组件保证只在非空时开窗 */
  items: TakenItemDto[];
  /** 本次扫码动作的成功文案（送检 / 放回），与补料信息合并展示 */
  leadText?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
}>();

function onAck(): void {
  emit('update:modelValue', false);
}
</script>

<style lang="scss" scoped>
.refill-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px;
}
/* 扫码动作成功行：与放回页确认栏的绿色 CircleCheckFilled 同款语气 */
.lead-text {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: #67c23a;
}
.refill-text {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: #303133;
}
.refill-hint {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}
.taken-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 45vh;
  overflow: auto;
}
.taken-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 18px;
  border: 1px solid #e4e7ed;
  border-left: 4px solid var(--primary-color);
  border-radius: 8px;
  background: #fff;
}
.taken-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.serial-no {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 22px;
  font-weight: 700;
  color: #303133;
  letter-spacing: 0.5px;
}
.urgent-tag {
  flex-shrink: 0;
}
.taken-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}
.qty {
  color: #e6a23c;
  font-weight: 700;
  font-size: 18px;
}
.ack-btn {
  min-width: 200px;
  font-size: 16px;
  font-weight: 600;
}
</style>
