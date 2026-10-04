<!--
  WorkingShelfDialog.vue

  报工台「选当前作业货架」弹窗（2026-10-04 新增）。唯一消费方是 /scan/action 顶部的
  「当前作业货架」区与「送检」按钮的前置拦截。

  为什么要有这个组件：送检的 `shelf_id` 是真事实 —— worker-scan 把它写进
  `t_part_batch.current_holder_id`，并对它做「PRODUCTION 区」硬校验（违反 → 20501）
  与「在本账号绑定集内」scope 校验（违反 → 40301 SHELF_MISMATCH）。而账号可绑**多个**
  架，系统判不出工人此刻站在哪一架上，只能问。取件（/scan/pick）已解绑（pick-up 的
  shelf_id 后端改成可选、缺省不校验），所以这个弹窗只服务送检。

  候选只列 zone === 'PRODUCTION'：送检的 `shelf_id` 必须是生产架，把品检架列出来只会
  让工人选一个必然被后端 20501 打回的架。`ShelfOption` 没有 name / location 字段，
  副标题用 zone 派生（生产区 / 品检区 / 区域未知）。

  视觉与交互对齐 ShelfPickerDialog（kind='shelf'，同一个 HmiPickerCard + 底部
  取消/完成），但**自己不发请求** —— 候选由调用方从 useScanShelfStore 拿，不重复 fetch。

  props:
    modelValue: boolean              // 弹窗可见
    options: ShelfOption[]          // 候选（内部只留 PRODUCTION 区）
  emits:
    update:modelValue(v: boolean)
    confirm(shelfId: string)        // 确认选中（写 store 由调用方做）
    cancel()                         // 放弃；调用方应中止后续跳转
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="选择当前作业货架"
    width="800px"
    :close-on-click-modal="false"
    :close-on-press-esc="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-if="productionOptions.length === 0" class="empty-state">
      <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
      <p class="empty-text">
        本账号当前绑定的货架在品检区，缺少生产区作业货架，请联系管理员为本账号绑定生产货架
      </p>
    </div>
    <div v-else class="card-grid">
      <HmiPickerCard
        v-for="o in productionOptions"
        :key="o.id"
        kind="shelf"
        :code="o.code"
        :name="zoneLabel(o.zone)"
        :is-selected="o.id === selectedId"
        @select="onSelect(o.id)"
      />
    </div>
    <template #footer>
      <el-button size="large" @click="onCancel">取消</el-button>
      <el-button
        type="primary"
        size="large"
        :disabled="!selectedId"
        class="confirm-btn"
        @click="onConfirm"
      >
        <el-icon><Select /></el-icon>
        <span>完成</span>
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Box, Select } from '@element-plus/icons-vue';
import HmiPickerCard from './HmiPickerCard.vue';
import type { ShelfOption } from '@/stores/scanShelf';

const props = defineProps<{
  modelValue: boolean;
  /** 候选（本账号绑定的全部架，含品检架）。组件内部只留 PRODUCTION 区。 */
  options: ShelfOption[];
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  confirm: [shelfId: string];
  cancel: [];
}>();

const selectedId = ref<string | null>(null);

/** 只列生产架：送检的 `shelf_id` 必须是 PRODUCTION 区，品检架是必然被 20501 打回的错选。 */
const productionOptions = computed<ShelfOption[]>(() =>
  props.options.filter((o) => o.zone === 'PRODUCTION'),
);

/** ShelfOption 只有 code / zone，没有货架名与位置；副标题用 zone 派生成中文区名。 */
function zoneLabel(zone: string): string {
  if (zone === 'PRODUCTION') return '生产区';
  if (zone === 'INSPECTION') return '品检区';
  return '区域未知';
}

// 每次打开都重置选中：上一次的选择可能已被解绑（候选集随之变化），沿用它等于替工人
// 做了一个决定。不预选「第一个」—— 多架账号里没有哪个是天然正确的默认项。
watch(
  () => props.modelValue,
  (v) => {
    if (v) selectedId.value = null;
  },
);

function onSelect(shelfId: string): void {
  selectedId.value = shelfId;
}

function onConfirm(): void {
  if (!selectedId.value) return;
  emit('confirm', selectedId.value);
}

function onCancel(): void {
  emit('cancel');
  emit('update:modelValue', false);
}
</script>

<style lang="scss" scoped>
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  gap: 12px;
  color: #606266;
  .empty-text {
    margin: 0;
    max-width: 420px;
    text-align: center;
    font-size: 15px;
    line-height: 1.6;
  }
}
.confirm-btn {
  min-width: 180px;
  font-size: 16px;
  font-weight: 600;
}
</style>
