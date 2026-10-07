<!-- 2026-10-09 新建：外协回收对话框（回收生产 / 回收品检共用一个组件，两种模式）。
     触发方式是**右键菜单**（不是拖拽）：批次在外协公司手上，回收要用户指定目标货架
     （+ 下一道工序），拖拽表达不了「送到哪个货架」。

     两种模式：
       - production（回收生产）：目标 = PRODUCTION 区货架 + 下一道工序。工序是**必填**：
         `receive_next_process_id` 为 `'0'`（工序链推不出）时后端返 20706；能推出时
         用 DTO 上的值预填（省一次点击），用户可改。
       - inspection（回收品检）：目标 = INSPECTION 区货架，**不带工序**（品检流转没有
         next_process）。

     ⚠️ **无数量输入**：`POST /outsource-queue/move` 已无 `quantity` 字段（整批语义）。
     部分接收要先拆批（BatchSplitDialog）再接收。

     货架下拉走 `useShelfProcessFilter` 的**双向收窄**：选了工序就只列映射该工序的
     PRODUCTION 区货架；选了不兼容的货架则反向清空工序。品检模式不涉及工序，下拉直接
     取 INSPECTION 区全量（processId 恒空 ⇒ 该 composable 不做任何收窄）。

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
      <el-form-item v-if="mode === 'production'" label="接收工序" required>
        <el-select v-model="processId" filterable placeholder="选择下一道工序" style="width: 100%">
          <el-option v-for="o in processOptions" :key="o.id" :label="o.label" :value="o.id" />
        </el-select>
      </el-form-item>
      <el-form-item :label="mode === 'production' ? '生产货架' : '品检货架'" required>
        <el-select
          v-model="shelfId"
          filterable
          :placeholder="mode === 'production' ? '选择映射该工序的生产货架' : '选择品检区货架'"
          style="width: 100%"
        >
          <el-option
            v-for="s in shelfOptions"
            :key="s.id"
            :label="`${s.code} — ${s.name}`"
            :value="s.id"
          />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!canConfirm" @click="onConfirm">
        确认回收（{{ mode === 'production' ? '回收生产' : '回收品检' }}）
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useProductionShelvesQuery } from '@/composables/queries/useProductionShelvesQuery';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import { useDialogSize } from '@/composables/useDialogSize';
import type { OutsourceQueueHeldBatchData } from '../composables/outsourceQueueSchema';
import type { OutsourceReceiveMode, OutsourceReceiveSubmit } from '../outsourceBoardTypes';

const props = defineProps<{
  modelValue: boolean;
  mode: OutsourceReceiveMode;
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

const shelfId = ref<string>('');
const processId = ref<string>('');

// 基础数据走共享 query（30s staleTime 全域去重），组件自身不直接调 listShelves /
// listProcesses。货架一次拉全量（不分 zone），按 mode 在 computed 里分区取用。
// limit 取后端 clamp 上限 500：`useShelfProcessFilter` 的双向收窄要拿全量货架算
// 映射，取小了会先截断再算 —— 货架列表按 display_order 排序、不按 zone 分组，
// 总数一超 limit，被截掉的品检架会让「回收到品检」的目标货架下拉直接空掉。
const shelvesQuery = useProductionShelvesQuery({ limit: 500 });
const procsQuery = useProcessesQuery({ limit: 200 });
const allShelves = computed(() => shelvesQuery.data.value?.items ?? []);
const allProcesses = computed(() => procsQuery.data.value?.items ?? []);

// 双向收窄：processId 非空时货架下拉只剩映射该工序的；选了不兼容货架则反向清空工序。
const { filteredShelves } = useShelfProcessFilter(allShelves, allProcesses, shelfId, processId);

/** 目标货架下拉：回收生产取 PRODUCTION 区且受工序收窄；回收品检取 INSPECTION 区全量
 *  （品检模式 processId 恒空，filteredShelves 原样返回全部货架）。 */
const shelfOptions = computed(() => {
  const zone = props.mode === 'production' ? 'PRODUCTION' : 'INSPECTION';
  return filteredShelves.value.filter((s) => s.zone === zone && s.is_active);
});

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

const title = computed(() =>
  props.mode === 'production' ? '从外协公司回收至生产' : '从外协公司回收至品检',
);

/** 「可自动带出工序/货架」的提示（对应卡片 tooltip 的同一判据 `chain_resolvable`）。 */
const autoFillHint = computed(() => {
  if (props.mode !== 'production') return '';
  return props.batch?.chain_resolvable ? '可自动带出工序' : '需手填工序';
});

const canConfirm = computed(
  () => !!shelfId.value && (props.mode !== 'production' || !!processId.value),
);

/** 打开时预填：工序链可解析（`chain_resolvable` 且非 `'0'`）⇒ 带出下一道工序。
 *  货架一律留空（无可靠默认值：候选货架按工序收窄，预填一个不同工序的货架会被
 *  `useShelfProcessFilter` 反向清空）。每次打开都复位，避免上一次的选择被误继承。 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    shelfId.value = '';
    const b = props.batch;
    const nextId = b?.receive_next_process_id;
    processId.value =
      props.mode === 'production' && b?.chain_resolvable && nextId !== NO_NEXT_PROCESS
        ? (nextId ?? '')
        : '';
  },
);

function onConfirm(): void {
  if (!canConfirm.value) return;
  emit('confirm', {
    toShelfId: shelfId.value,
    nextProcessId: props.mode === 'production' ? processId.value : null,
  });
}
</script>