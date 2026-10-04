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
    currentShelfId?: string | null  // 调用方当前已生效的作业架；打开时预选它（见 preselectedOnOpen）
    emptyText?: string               // 无可选生产架时的说明；不传则用下面的兜底文案
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
      <p class="empty-text">{{ emptyText ?? DEFAULT_EMPTY_TEXT }}</p>
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
  /**
   * 2026-10-04 review 第 1 轮新增：调用方当前**已生效**的作业架。横条上写着
   * 「当前：SH-P01」+「更换」，弹窗打开后那张卡却不是选中态，等于要工人把自己刚选过的
   * 架再指一次。传进来即可预选。判据走 `productionOptions`（而不是 `options`）：store 里
   * 的值已过 `id ∈ options` 校验，但还可能是品检架（单架品检账号 / sessionStorage 恢复出
   * 品检架）—— 那不是能选的那一张，不预选。
   */
  currentShelfId?: string | null;
  /**
   * 2026-10-04 review 第 2 轮新增：无可选生产架时的说明文案，**由调用方给**。
   *
   * 为什么不留在组件里猜：`productionOptions` 为空有**两个**成因 —— 全绑品检架（全绑
   * 品检区），以及全绑「区域未知」架（`listShelves` 失败时 `useScanShelfStore` 兜底填
   * UNKNOWN，见该 store 的 initShelves 兜底分支）。这两种成因要说的是不同的话，而调用方
   * 手里正好有判别所需的 `workingShelfProblem()`（它逐条区分了「在品检区」与「无法识别
   * 所属区域」）—— 组件自己只能看到 zone 字符串，猜错就会在同一屏上给出与横条矛盾的
   * 成因。沿本仓「差异在调用侧消化」的取向，文案随数据一起传进来。
   *
   * 不传时用下面的 `DEFAULT_EMPTY_TEXT` 兜底（= 全品检这一支的既有文案，保留是为了
   * 单测与将来第二个消费方不必先关心这件事）。
   */
  emptyText?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  confirm: [shelfId: string];
  cancel: [];
}>();

/**
 * `emptyText` 未传时的兜底文案。
 *
 * 2026-10-04 review 第 2 轮：这是**兜底**，不是权威 —— 组件自己判不出「无可选生产架」的成因
 * （至少两个：都在品检区 / 所属区域暂未识别，即调用方 store 兜底填的 UNKNOWN），所以真相由
 * 调用方的 `emptyText` 带来。这句兜底只覆盖「都在品检区」这一支，保留是为了让本组件的
 * 单测、以及将来第二个消费方不必先关心这件事。
 */
const DEFAULT_EMPTY_TEXT =
  '本账号当前绑定的货架在品检区，缺少生产区作业货架，请联系管理员为本账号绑定生产货架';

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

/** 打开时该预选哪一张：调用方已生效的那张（须在本弹窗的可选集内），否则不预选。 */
function preselectedOnOpen(): string | null {
  const id = props.currentShelfId;
  if (!id) return null;
  return productionOptions.value.some((o) => o.id === id) ? id : null;
}

/**
 * 每次打开都重算预选，而不是沿用弹窗上一轮的临时选择。
 *
 * 2026-10-04 review 第 1 轮：原先这里无脑置 null，理由是「上一次的选择可能已被解绑」——
 * 但那是**弹窗自己上一轮**的临时选择，而 `currentShelfId` 是 store 里已过 `id ∈ options`
 * 校验的生效值。两者性质不同，后者值得预选（不预选只是让工人多点一次，前者会让人以为
 * 系统没记住）。仍不预选「第一个」—— 多架账号里没有哪个是天然正确的默认项。
 */
watch(
  () => props.modelValue,
  (v) => {
    if (v) selectedId.value = preselectedOnOpen();
  },
  // immediate：弹窗也可能一挂载就是打开态（调用方先置 true 再渲染），那种情况下
  // 不会先经历一次 false，watch 也就不会触发 ⇒ 首帧就漏了预选。
  { immediate: true },
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
  min-width: 200px;
  font-size: 16px;
  font-weight: 600;
}
</style>
