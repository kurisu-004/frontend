<!--
  PrintSplitEditor.vue — 打印行内联拆分编辑器（2026-10-08 新增）。

  打印对话框里点行尾「拆分」→ 在该行下方展开 N 个数字输入 + `Σ` 实时显示 +
  守恒校验（`Σ ≠ 原数量` 时「确定」disabled + 标红）。

  **数量列本身只读** —— 要改数量必须走拆分。原因：送货单是给对方签收的单据，数量列
  直接可编辑会让「拆批」这件事在纸面上消失（后端 `custom_order` 的代表批次口径也是
  每 part 一行一行地给，不允许同一行出现两个数）。

  数量输入的初值：第一个格子放满原数量、其余为 0（用户从第二格开始填要分出去的数量）
  —— 倒过来（最后格子放满）更符合「先想好分几份」的心智，但两种都会被守恒校验拦住，
  这里选前者因为它让「不分（一行）」只需点确定。
-->
<template>
  <div class="split-editor">
    <div class="split-editor__inputs">
      <div v-for="(_, i) in quantities" :key="i" class="split-editor__cell">
        <span class="split-editor__idx">{{ i + 1 }}</span>
        <el-input-number
          :model-value="quantities[i]"
          :min="0"
          :max="row.quantity ?? undefined"
          :precision="0"
          size="small"
          controls-position="right"
          style="width: 110px"
          @update:model-value="(v: number | undefined) => setAt(i, v)"
        />
      </div>
    </div>
    <div :class="['split-editor__sum', { 'split-editor__sum--bad': !valid }]">
      Σ {{ sum }} / {{ row.quantity ?? '—' }}
      <span class="split-editor__err">{{ errorText }}</span>

    </div>
    <div class="split-editor__actions">
      <el-button size="small" @click="addCell">加一份</el-button>
      <el-button size="small" @click="emit('cancel')">取消</el-button>
      <el-button size="small" type="primary" :disabled="!valid" @click="confirm">
        确定
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PrintRow } from '../utils/deliveryNotePrintRows';

const props = defineProps<{
  /** 被拆分的原行。 */
  row: PrintRow;
}>();

const emit = defineEmits<{
  /** 确认：拆出的行（守恒已由 valid 判过）。 */
  done: [rows: PrintRow[]];
  cancel: [];
}>();

/** 复用纯函数做守恒判定 —— 校验口径不许在组件里另写一份。 */
const quantities = ref<number[]>([]);

watch(
  () => props.row.id,
  () => {
    quantities.value = [props.row.quantity ?? 0, 0];
  },
  { immediate: true },
);

const sum = computed(() => quantities.value.reduce((a, b) => a + b, 0));

const valid = computed(
  () =>
    quantities.value.length >= 2 &&
    quantities.value.every((q) => Number.isInteger(q) && q >= 0) &&
    props.row.quantity !== null &&
    sum.value === props.row.quantity,
);

const errorText = computed(() => {
  if (props.row.quantity === null) return '原行数量未知，无法拆分';
  if (sum.value !== props.row.quantity) return `合计 ${sum.value}，原行是 ${props.row.quantity}`;
  if (quantities.value.length < 2) return '至少拆成两份';
  return '';
});

function setAt(i: number, v: number | undefined): void {
  const next = [...quantities.value];
  next[i] = v ?? 0;
  quantities.value = next;
}

function addCell(): void {
  quantities.value = [...quantities.value, 0];
}

/** 确认：把数量数组交给纯函数 splitRow（守恒错误文案也出自它），成功后 emit。 */
function confirm(): void {
  if (!valid.value) return;
  // 局部 import 纯函数（懒加载省首屏体积；这条路径只在用户点「拆分」时才走到）。
  void import('../utils/deliveryNotePrintRows').then(({ splitRow }) => {
    const out = splitRow(props.row, quantities.value);
    if (typeof out === 'string') return;
    emit('done', out);
  });
}
</script>

<style scoped>
.split-editor {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 8px 0;
}
.split-editor__inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.split-editor__cell {
  display: flex;
  align-items: center;
  gap: 4px;
}
.split-editor__idx {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.split-editor__sum {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.split-editor__sum--bad,
.split-editor__err {
  color: var(--el-color-danger);
}
.split-editor__err {
  margin-left: 8px;
}
.split-editor__actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
</style>