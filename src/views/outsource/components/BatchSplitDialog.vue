<!-- 2026-10-09 新建：批次拆分对话框（外协看板右键「拆分批次」与零件详情页共用同款形态）。

     场景：`POST /outsource-queue/move` 是**整批**语义（无 quantity 字段），部分接收 /
     部分发送都要先拆批。`POST /batches/split` 的 `version` 是必填 OCC 锚（缺它返 HTTP
     422 纯文本），所以源批次的 version 由打开对话框的卡片带进来。

     形态照 `views/parts/detail/components/PartBatchMonitorCard.vue` 的既有实现：
       - `useDialogSize({ desktopWidth: 420 })` + el-input-number `:min=1`
         `:max=quantity-1` `:precision=0`（拆光没有意义）；
       - **resolve(ok) 把关闭时机下沉到 API 成功之后**：失败时对话框保持打开、用户改
         数量重试即可，不该「先关了再报错」。 -->
<template>
  <el-dialog
    :model-value="modelValue"
    title="拆分批次"
    :width="dialogSize.width"
    :fullscreen="dialogSize.fullscreen"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-if="source" class="split-body">
      <p>
        <!-- batch_no 直接取卡片 model 的值 —— 它已经带 'B' 前缀（适配层 poolCandidateToCard
             / heldBatchToCard 统一加的），这里不要再拼一个 B。 -->
        源批次 <b>{{ source.batch_no }}</b> {{ source.part_name }}（当前
        {{ source.quantity }} 件）
      </p>
      <el-form label-width="90px">
        <el-form-item label="拆出数量" required>
          <el-input-number
            v-model="quantity"
            :min="1"
            :max="source.quantity - 1"
            :precision="0"
            style="width: 160px"
          />
        </el-form-item>
      </el-form>
      <p class="muted">
        拆出后：源批次剩 {{ source.quantity - (quantity ?? 0) }} 件，新批次
        {{ quantity ?? 0 }} 件（继承当前状态/位置）。
      </p>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="onConfirm">
        确认拆分
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { useDialogSize } from '@/composables/useDialogSize';
import { splitBatch } from '@/api/batch';
import { invalidateOutsourceQueueProcessAll } from '../composables/useOutsourceQueueProcessQuery';
import { invalidateOutsourceQueueSnapshotAll } from '../composables/useOutsourceQueueSnapshotQuery';
import type { OutsourceSplitTarget } from '../outsourceBoardTypes';

const props = defineProps<{
  modelValue: boolean;
  source: OutsourceSplitTarget | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const qc = useQueryClient();
const dialogSize = useDialogSize({ desktopWidth: 420 });

const quantity = ref<number | undefined>(undefined);
const submitting = ref(false);

const canSubmit = computed(
  () =>
    !!props.source &&
    typeof quantity.value === 'number' &&
    quantity.value >= 1 &&
    quantity.value <= props.source.quantity - 1,
);

/** 关闭时机下沉到 API 成功之后：`ok=true` 才关，失败保持打开让用户改数量重试。 */
function resolve(ok: boolean): void {
  if (ok) emit('update:modelValue', false);
}

/** `POST /batches/split`。⚠️ 缺 version 时后端返 HTTP 422 纯文本（不是业务信封），
 *  错误文案因此走 `(e as Error).message ?? …` 的双兜底。
 *
 *  失效：源批次留在原处（量变小）、新批次继承状态/位置 ⇒ 外协看板的**两个域**都要刷
 *  （tab 徽标 + 单工序详情）。 */
const splitMutation = useMutation({
  mutationKey: ['batches', 'split'],
  // 不写 retry（信任 main.ts 全局 mutations.retry: 0）。
  mutationFn: (payload: { batch_id: string; version: number; quantity: number }) =>
    splitBatch(payload),
});

/** 每次打开复位（不继承上一次的拆出数量）。 */
watch(
  () => props.modelValue,
  (open) => {
    if (open) quantity.value = undefined;
  },
);

async function onConfirm(): Promise<void> {
  const src = props.source;
  if (!src || !canSubmit.value || typeof quantity.value !== 'number') return;
  submitting.value = true;
  try {
    const res = await splitMutation.mutateAsync({
      batch_id: src.batch_id,
      version: src.version,
      quantity: quantity.value,
    });
    ElMessage.success(
      `拆分成功：源批次剩 ${res.quantity} 件，新批次 ${quantity.value} 件（继承当前状态/位置）`,
    );
    await invalidateOutsourceQueueSnapshotAll(qc);
    await invalidateOutsourceQueueProcessAll(qc);
    resolve(true);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '拆分批次失败');
    resolve(false);
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.split-body p {
  margin: 0 0 12px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>