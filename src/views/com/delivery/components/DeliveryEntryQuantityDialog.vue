<!--
  DeliveryEntryQuantityDialog.vue — 入单数量输入对话框（2026-10-08 新增）。

  两形态（由 `kind` 决定，不是两个组件）：
    · `PART`     —— 输入**件数**，默认 = `entry_max_quantity`，上界同值；
    · `ASSEMBLY` —— 输入**套数**，默认 = `entry_max_sets`，上界同值、且 ≥1；
                   同时展示 `per_set_parts` 的「每套需 F1001-01 3 件 / F1001-02 2 件」。

  校验：正整数（0 / 负数 / 小数一律拒），并钉住上界 —— 超出可入单量的请求后端一律
  21405 `BIZ_DELIVERY_NOTE_PART_NOT_READY`，前端拦一道省一次往返。

  数据全部由 props 进（不读 store、不发请求），确认后 emit `submit`，由壳组装
  `entries` 交给 `POST /com/delivery/note/scan`。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="520px"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-form label-width="110px" @submit.prevent>
      <el-form-item :label="kind === 'ASSEMBLY' ? '入单套数' : '入单件数'">
        <el-input-number
          :model-value="quantity"
          :min="1"
          :max="maxQuantity"
          :precision="0"
          size="small"
          controls-position="right"
          style="width: 160px"
          @update:model-value="(v: number | undefined) => (quantity = v ?? 1)"
        />
        <span class="unit">{{ kind === 'ASSEMBLY' ? '套' : '件' }}</span>
        <span class="hint">可入单上限 {{ maxQuantity }} {{ kind === 'ASSEMBLY' ? '套' : '件' }}</span>
      </el-form-item>

      <el-form-item v-if="kind === 'ASSEMBLY'" label="每套用量">
        <div v-if="perSetParts.length === 0" class="muted">（该装配件没有子件用量信息）</div>
        <div v-else class="per-set">
          <el-tag
            v-for="p in perSetParts"
            :key="p.part_id"
            size="small"
            effect="plain"
            type="info"
          >
            {{ partSerialOf(p.part_id) }} {{ p.per_set_quantity }} 件
          </el-tag>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!valid" @click="onConfirm">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DeliveryScanPerSetPartData } from '../composables/deliveryScanTreeSchema';

/** 入单对象形态：与后端 `ScanEntry.node_kind` 逐字一致。 */
export type DeliveryEntryKind = 'ASSEMBLY' | 'PART';

const props = defineProps<{
  modelValue: boolean;
  kind: DeliveryEntryKind;
  /** 被入单节点的 id（PART → part.id；ASSEMBLY → assembly.id）。 */
  nodeId: string;
  /** 展示名（零件名 / 装配件名）。 */
  nodeName: string;
  /** PART → entry_max_quantity（件）；ASSEMBLY → entry_max_sets（套）。 */
  maxQuantity: number;
  /** 仅 ASSEMBLY 有值：每套用量。 */
  perSetParts?: DeliveryScanPerSetPartData[];
  /** 仅 PART 有值：子件可读名表（把 per_set_parts 的 part_id 翻成人看的东西，
   *  取值是序列号或零件名，由壳决定 —— 无序列号的子件给的是零件名）。 */
  partSerials?: Record<string, string>;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 确认：量与节点。壳据此组装 entries。 */
  submit: [payload: { kind: DeliveryEntryKind; nodeId: string; quantity: number }];
}>();

const quantity = ref(1);

const title = computed(() =>
  props.kind === 'ASSEMBLY' ? `装配件入单 — ${props.nodeName}` : `零件入单 — ${props.nodeName}`,
);

/** 每次打开都回到「默认 = 可入单上限」（用户多数时候就是要全量入单）。 */
watch(
  () => [props.modelValue, props.nodeId, props.kind] as const,
  () => {
    if (props.modelValue) quantity.value = Math.max(1, props.maxQuantity);
  },
  { immediate: true },
);

const valid = computed(
  () => Number.isInteger(quantity.value) && quantity.value >= 1 && quantity.value <= props.maxQuantity,
);

const perSetParts = computed<DeliveryScanPerSetPartData[]>(() => props.perSetParts ?? []);

/** part_id → 子件可读名（壳给的表）；查不到就退到 part_id 本身（至少可定位）。 */
function partSerialOf(partId: string): string {
  return props.partSerials?.[partId] ?? partId;
}

function onConfirm(): void {
  if (!valid.value) return;
  emit('submit', { kind: props.kind, nodeId: props.nodeId, quantity: quantity.value });
  emit('update:modelValue', false);
}
</script>

<style scoped>
.unit {
  margin-left: 8px;
  color: var(--el-text-color-regular);
}
.hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.per-set {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>