<!-- 2026-10-09 新建：批次拆分对话框（**共享组件**）。五个区域都能开：生产队列的待下发
     池 / 工序候选池 / 工人列，外协的可发送候选池 / 外协公司列。

     场景：`POST /prod/queue/move` 与 `POST /outsource-queue/move` 都是**整批**语义
     （没有 quantity 字段），部分下发 / 部分发送都要先拆批。`POST /batches/split` 的
     `version` 是必填 OCC 锚（缺它返 HTTP 422 纯文本），所以源批次的 version 由打开
     对话框的卡片带进来。

     ⚠️ **组件保持 dumb：失效编排不在这里**。源批次留在原处（量变小）、新批次继承
     状态 / 位置 ⇒ 至少两个 query 域要刷，但**是哪两个域取决于调用方在哪个看板上**：
     生产队列要刷「待下发 + 工序看板 + 快照」，外协看板要刷「单工序看板 + 快照」。
     对话框只要 import 任一方的失效函数就会锁死单域消费方。故成功后统一 `done`
     事件，板级各自编排自己的失效链（对齐 queue 域「mutation 持有失效编排、组件
     dumb」的约定）。

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
        <!-- batch_no 直接取卡片 model 的值 —— 它已经带 'B' 前缀（各域适配层
             poolItemToCard / heldBatchToCard / pendingBatchToCard 统一加的），
             这里不要再拼一个 B。 -->
        源批次 <b>{{ source.batch_no }}</b> {{ source.part_name }}（当前 {{ source.quantity }} 件）
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
import { useMutation } from '@tanstack/vue-query';
import { useDialogSize } from '@/composables/useDialogSize';
import { splitBatch } from '@/api/batch';
import type { SplitBatchByBodyRequest } from '@/api/batch.contract';
import type { BatchSplitSource } from '@/types/batchSplit';

const props = defineProps<{
  modelValue: boolean;
  source: BatchSplitSource | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  /** 拆分成功、对话框即将关闭 —— 板级在这里编排本域的 query 失效链。 */
  done: [];
}>();

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
  if (!ok) return;
  emit('done');
  emit('update:modelValue', false);
}

/** `POST /batches/split`。⚠️ 入参侧有**不是业务信封**的失败面：缺 version，或
 *  `batch_id` / `quantity` 的 wire 形态发反（前者必须字符串、后者必须裸数字，方向相反）
 *  ，都返 HTTP 422 纯文本，错误文案因此走 `(e as Error).message ?? …` 的双兜底。
 *
 *  这里**没有**失效链：见文件头「组件保持 dumb」，成功后派 `done` 由板级编排。 */
const splitMutation = useMutation({
  mutationKey: ['batches', 'split'],
  // 不写 retry（信任 main.ts 全局 mutations.retry: 0）。
  mutationFn: (payload: SplitBatchByBodyRequest) => splitBatch(payload),
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
    // 2026-10-09：`res.quantity` 是**实际拆走量**（= 新批次数量），不是源批次余量 ——
    // 源批次余量不在出参里，用请求锚的源数量减出来。余量取服务端确认的拆走量回算，
    // 而不是复读输入框，避免提示里的两个数与库里对不上。
    ElMessage.success(
      `拆分成功：新批次 ${res.quantity} 件，源批次剩 ${src.quantity - res.quantity} 件（继承当前状态/位置）`,
    );
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
