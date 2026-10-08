<!-- 2026-10-09 新建：外协回收对话框。
     触发方式是**右键菜单**（不是拖拽）：批次在外协公司手上，回收要用户指定下一道工序。

     2026-10-10 两处收缩：
     - **目标货架不再由用户指定** —— 后端按负载自动选（见 CLAUDE.md「货架自动选择」）。
       本对话框只剩一个输入：下一道工序（链推得出时预填）。
     - **「回收品检」模式整体下线**：`kind='INSPECTION_SHELF'` 这个变体在后端已消失
       （`POST /prod/outsource-queue/move` 的 `to` 只剩 PRODUCTION_SHELF / OUTSOURCE_COMPANY）。
       剩下的 `PRODUCTION_SHELF` 变体需要 `next_process_id`，而品检流转本就没有这个输入 ——
       两个模式会退化成同一个「回收生产」，右键菜单里给两个同名入口没有任何意义。

     ⚠️ **无数量输入**：`POST /outsource-queue/move` 已无 `quantity` 字段（整批语义）。
     部分接收要先拆批（BatchSplitDialog）再接收。

     组件是受控的：只管表单态与校验，提交由 emit 上抛给板级（板级持有
     `useOutsourceQueueMove` 的唯一实例，避免同一个 mutation 挂两个 observer 导致
     双份成功 toast）。 -->
<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    :width="dialogSize.width"
    :top="dialogSize.top"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-form label-width="110px">
      <el-form-item label="外协公司">
        <span>{{ companyName }}</span>
      </el-form-item>
      <el-form-item label="批次">
        <span v-if="batch">
          B{{ batch.batch_no }}（{{ batch.quantity }} 件<span v-if="autoFillHint">
            · {{ autoFillHint }}</span
          >）
        </span>
      </el-form-item>
      <el-form-item label="接收工序" required>
        <el-select v-model="processId" filterable placeholder="选择下一道工序" style="width: 100%">
          <el-option v-for="o in processOptions" :key="o.id" :label="o.label" :value="o.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!canConfirm" @click="onConfirm">
        确认回收
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useDialogSize } from '@/composables/useDialogSize';
import type { OutsourceQueueHeldBatchData } from '../composables/outsourceQueueSchema';
import type { OutsourceReceiveSubmit } from '../outsourceBoardTypes';

const props = defineProps<{
  modelValue: boolean;
  /** 批次所在外协公司名（只展示）。 */
  companyName: string;
  /** 在途卡 DTO —— 数量、下一道工序预填与「可自动带出」提示都来自它。 */
  batch: OutsourceQueueHeldBatchData | null;
  submitting: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [payload: OutsourceReceiveSubmit];
}>();

/** 「无下一道工序」的后端投影值：NULL 被吃成 0 并序列化为字符串 `"0"`（不是 null）。 */
const NO_NEXT_PROCESS = '0';

const dialogSize = useDialogSize({ desktopWidth: 560 });

const processId = ref<string>('');

// 基础数据走共享 query（30s staleTime 全域去重），组件自身不直接调 listProcesses。
// 货架数据源一并删掉：目标架由后端按负载自动选，本对话框不再需要货架列表。
const procsQuery = useProcessesQuery({ limit: 200 });
const allProcesses = computed(() => procsQuery.data.value?.items ?? []);

/** 工序下拉。DTO 的 `receive_next_process_id` 若不在已加载列表里也补进去 —— 工序链
 *  推得出的下一道工序必须能被选中（预填值若在下拉里找不到，用户会以为自己看错了）。
 *  外协工序带「（外协）」后缀区分。 */
const processOptions = computed<{ id: string; label: string }[]>(() => {
  const base = allProcesses.value.map((p) => ({
    id: p.id,
    label: `${p.code} — ${p.name}${p.category === 'OUTSOURCE' ? '（外协）' : ''}`,
  }));
  const nextId = props.batch?.receive_next_process_id;
  if (nextId && nextId !== NO_NEXT_PROCESS && !base.some((o) => o.id === nextId)) {
    base.unshift({ id: nextId, label: props.batch?.receive_next_process_name ?? nextId });
  }
  return base;
});

const title = '从外协公司回收至生产';

/** 「可自动带出工序」的提示（对应卡片 tooltip 的同一判据 `chain_resolvable`）。 */
const autoFillHint = computed(() =>
  props.batch?.chain_resolvable ? '可自动带出工序' : '需手填工序',
);

const canConfirm = computed(() => !!processId.value);

/** 打开时预填：工序链可解析（`chain_resolvable` 且非 `'0'`）⇒ 带出下一道工序。
 *  每次打开都复位，避免上一次的选择被误继承。 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    const b = props.batch;
    const nextId = b?.receive_next_process_id;
    processId.value = b?.chain_resolvable && nextId !== NO_NEXT_PROCESS ? (nextId ?? '') : '';
  },
);

function onConfirm(): void {
  if (!canConfirm.value) return;
  emit('confirm', { nextProcessId: processId.value });
}
</script>
