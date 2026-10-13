<!--
  DeliveryDriverPickerDialog.vue — 一键送货的确认 + 指定司机对话框（2026-10-16 新增）。

  打印不再强制指定司机（见 PrintPreviewDialog 与本文件对应的 CLAUDE.md 小节），指定司机
  的强制点搬到这里：`POST /com/delivery/note/{id}/pickup` 入参只有 `version`、司机由服务端
  从单据上读，单据没指定司机返 21409，所以「谁去送」必须在这条路上定下来。

  两种口径（由单据上**有没有司机名**决定）：
    · 单据上已有司机名 → 回显「本单已指定：X」，允许**不选直接确认**；此时 emit 空串，
      调用方只发 pickup、不重发 `POST /{id}/driver`（没必要为了同一件事再推进一次 version）；
      选了别人就是「改绑」，下拉 **clearable** 让用户能退回沿用（`emit` 仍回到空串口径）；
    · 单据上没有司机名 → **确认按钮 disabled**，必须选一个（后端没有兜底司机）。

  emit 的 `driverId` 就是上面那个字符串：非空 = 本次要改绑的司机 id，空串 = 沿用本单司机。
  两条 POST 的编排（driver 先、pickup 用 driver 响应里的新 version）在 store 里 ——
  本组件只负责「选不选、选谁」，不碰任何写端点。

  司机候选取域内 `useDeliveryDriversQuery`（常量键，跨弹窗复用同一份缓存）。

  `closed`（el-dialog 关闭过渡**结束后**才有的那一个）转抛给调用方清单据快照：leave 过渡
  期间对话框内容仍在 DOM 里可见，此刻清掉单号 / 条数会让标题闪成「一键送货 — 」。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="520px"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @closed="emit('closed')"
  >
    <div class="deliver-hint">
      一键送货 {{ noteNo }}（{{ partCount }} 条）？批次将全部置为已送货。
    </div>

    <div class="driver-row">
      <span class="driver-label">送货司机</span>
      <!-- clearable（2026-10-16 补）：「沿用本单司机」是本对话框明确提供的模式，误选了
           别人就得有办法退回来。`value-on-clear=""` 把清空值钉成空串（EP 默认发的是
           `undefined`，那不是「沿用」的语义值，见 driverIdModel 的注释）。 -->
      <el-select
        v-model="driverIdModel"
        placeholder="选择司机"
        filterable
        clearable
        value-on-clear=""
        style="width: 220px"
        :loading="driverQuery.isFetching.value"
      >
        <el-option
          v-for="d in driverQuery.drivers.value"
          :key="d.id"
          :value="d.id"
          :label="d.name"
        />
      </el-select>
    </div>

    <!-- ⚠️ **三态都要有文案**（2026-10-16 补）：「单据已有司机 + 用户又选了别人」这一格
         原本命中不到任何分支，渲染成空 div —— 唯一那条「不选则沿用」的指引凭空消失，
         配合当时没有 clearable，用户就再也回不到沿用模式了。 -->
    <div class="driver-note">
      <span v-if="!hasDriverOnNote" class="muted">
        本单尚未指定司机，请先选择后再确认（不指定会被后端以 21409 拒绝）。
      </span>
      <span v-else-if="!driverId" class="muted">
        本单已指定：{{ driverWorkerName }}（不选则沿用该司机）
      </span>
      <span v-else class="muted">
        本次将改绑为 {{ selectedDriverName ?? '所选司机' }}；清空下拉即退回沿用
        {{ driverWorkerName }}。
      </span>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <!-- data-role 供组件级用例定位「确认送货」按钮 -->
      <el-button type="primary" data-role="confirm" :disabled="!canConfirm" @click="onConfirm">
        确认送货
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDeliveryDriversQuery } from '../composables/useDeliveryDriversQuery';

const props = defineProps<{
  modelValue: boolean;
  /** 被送货的单号（对话框标题 / 正文回显）。 */
  noteNo: string;
  /** 行项条数（正文回显「N 条」，与旧的 ElMessageBox 确认文案同口径）。 */
  partCount: number;
  /** 单据上已有的司机名；null = 尚未指定（后端 VO 只给名字，不给 driver_worker_id）。 */
  driverWorkerName: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 关闭过渡**结束**后才发（el-dialog 的 closed）：调用方用它清单据快照 ——
   *  在 leave 过渡期间对话框内容仍在 DOM 里可见，此刻清快照会让标题闪成「一键送货 — 」。 */
  closed: [];
  /** 确认送货：driverId 非空 = 本次要改绑的司机；**空串 = 沿用本单司机**。 */
  confirm: [driverId: string];
}>();

const title = computed(() => `一键送货 — ${props.noteNo}`);

/** 候选只在弹窗开着时拉（常量键 ⇒ 反复开关命中同一份缓存）。 */
const driverQuery = useDeliveryDriversQuery(computed(() => props.modelValue));

/** 仅本地选中态；空串 = 没重选（沿用单据上的司机）。 */
const driverId = ref<string>('');

/** 模板绑的是它而不是 `driverId`：**空串是「沿用」的语义值**，其余一律归一成空串 ——
 *  element-plus 的 clearable 默认 emit 的是 `valueOnClear`（未配时为 `undefined`），
 *  若让 `undefined` 流进来，`canConfirm` 的 `!== ''` 会在「单据本来没司机」时误判成
 *  「选好了」，进而 emit 一个 `undefined` 当司机 id 去发 `POST /{id}/driver`。 */
const driverIdModel = computed({
  get: () => driverId.value,
  set: (v: string | undefined | null) => {
    driverId.value = v ?? '';
  },
});

const hasDriverOnNote = computed(() => Boolean(props.driverWorkerName));

/** 本次选中的司机名；候选未回流 / 列表里查不到时为 null（提示文案退化成「所选司机」）。 */
const selectedDriverName = computed(
  () => driverQuery.drivers.value.find((d) => d.id === driverId.value)?.name ?? null,
);

/** 单据上没有司机名时必须选一个 —— 那条路上后端只吃 version，司机只能在这儿定。 */
const canConfirm = computed(() => driverId.value !== '' || hasDriverOnNote.value);

// 关对话框即放弃本地选择：下次打开回到「沿用单据司机」的干净态，不留一个从未落库的
// 幽灵选中项（与打印对话框的司机下拉同口径）。
watch(
  () => props.modelValue,
  (open) => {
    if (!open) driverId.value = '';
  },
);

function onConfirm(): void {
  if (!canConfirm.value) return;
  emit('confirm', driverId.value);
  emit('update:modelValue', false);
}
</script>

<style scoped>
.deliver-hint {
  margin-bottom: 12px;
  font-size: 14px;
  line-height: 22px;
}
.driver-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.driver-label {
  color: var(--el-text-color-regular);
}
.driver-note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>
