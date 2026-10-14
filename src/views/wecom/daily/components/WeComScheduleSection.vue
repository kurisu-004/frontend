<!--
  WeComScheduleSection.vue — 调度与通道（总开关 + 频率 + 配套字段 + 推送通道）

  2026-10-17 新建。**纯组件，零 store / 零 api 依赖**：表单模型从 `modelValue` 进、补丁从
  `update:modelValue` 出（见 `composables/useWeComDailyStore.ts` 文件头为什么本页的 section 不
  首调 store）。

  四条渲染分支由 `frequencyOptions`（= `GET /meta` 的 `frequencies[]`）的三个 `needs_*` 决定，
  **不在本组件硬编码**：
    - needs_time          → 时 / 分 两个下拉
    - needs_weekday       → 星期下拉（ISO 1=周一 … 7=周日）
    - needs_day_of_month  → 每月几号（1..28）
    - MANUAL_ONLY（三个 needs_* 全 false）→ 全部隐藏，只留一条提示

  为什么时/分用两个 `el-select` 而不是 `el-time-picker`：契约的 wire 形态就是
  `send_hour: number|null` + `send_minute: number|null` 两个独立字段，而 `el-time-picker` 的值
  是一个 `Date`（要 `value-format` 才能变成字符串）—— 用它就得在存取两端各做一次
  `Date ⇄ (h, m)` 转换，而这份转换的出错方向是**静默**的（时区 / 跨天）。两个下拉的值域固定
  （0..23 / 0..59），与 wire 逐字同形、零转换。

  切频率时把「当前频率用不到」的配套字段置 null（`onFrequencyChange`）：留着上一次切频率前的
  值会构成「频率与配套字段组合非法」。
  ⚠️ **后端对「多填」不是报错而是清空 / 忽略**（口径与邮件域同款），前端在这里先归一是
  **为了让表单自洽 + 让校验红字落在可见字段上**（多填的 issue 挂 `send_time` / `weekday` /
  `day_of_month`，而 MANUAL_ONLY 下那一整行连同红字都不渲染 ⇒ 不归一就是一条看不见的死路）。
  store 的 `applyConfigToForm` 对服务端配置做同一套归一。

  2026-10-17：新增「推送通道」一行（`webhooks` prop + `webhook_id` 字段）—— 推哪条通道由**用户
  在本页选**。选项取自 **query**（壳传下来的 `webhooks`），**不在本组件硬编码**、也不 props 传
  一堆预设文案 —— 通道列表是会变的运行时数据，props 硬编码等于把「有什么通道」写在模板里。
-->
<template>
  <div class="wecom-schedule">
    <!-- 推送通道。放最前面是因为它是「能不能发出去」的前置条件，比「什么时候发」更该先看见。
         空值 = 未选（保存合法，但**发不出去**：后端对 null 直接 21801，没有回落默认通道的
         分支 —— 见页面顶部告警）。 -->
    <div :class="['field-row', rowClass('webhook_id')]">
      <span class="field-label">推送通道</span>
      <el-select
        :model-value="modelValue.webhook_id"
        class="webhook-select"
        clearable
        placeholder="未选（发送会失败）"
        aria-label="推送通道"
        @update:model-value="patch({ webhook_id: toNullableString($event) })"
      >
        <el-option
          v-for="w in webhooks"
          :key="w.id"
          :label="w.name"
          :value="w.id"
        >
          <span>{{ w.name }}</span>
          <span class="option-masked">{{ w.url_masked }}</span>
        </el-option>
      </el-select>
      <span v-if="webhooks.length === 0" class="field-hint">
        还没有可用通道，请先到「Webhook 配置」里新增一条
      </span>
      <span v-if="errors?.webhook_id" class="field-error">{{ errors.webhook_id }}</span>
    </div>

    <div class="field-row">
      <span class="field-label">启用定时</span>
      <el-switch
        :model-value="modelValue.enabled"
        aria-label="启用定时"
        @update:model-value="patch({ enabled: Boolean($event) })"
      />
      <span class="field-hint"> 关闭后不注册定时任务，但「预览」与「立即发送」仍可用 </span>
    </div>

    <div :class="['field-row', rowClass('frequency')]">
      <span class="field-label">频率</span>
      <el-radio-group
        :model-value="modelValue.frequency"
        aria-label="推送频率"
        @update:model-value="onFrequencyChange"
      >
        <el-radio-button v-for="opt in frequencyOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </el-radio-button>
      </el-radio-group>
      <span v-if="errors?.frequency" class="field-error">{{ errors.frequency }}</span>
    </div>

    <template v-if="flags.needs_time">
      <div :class="['field-row', rowClass('send_time')]">
        <span class="field-label">触发时刻</span>
        <el-select
          :model-value="modelValue.send_hour"
          class="time-select"
          placeholder="时"
          aria-label="触发小时"
          @update:model-value="patch({ send_hour: toNullableInt($event) })"
        >
          <el-option v-for="h in HOUR_OPTIONS" :key="h" :label="pad2(h)" :value="h" />
        </el-select>
        <span class="time-colon">:</span>
        <el-select
          :model-value="modelValue.send_minute"
          class="time-select"
          placeholder="分"
          aria-label="触发分钟"
          @update:model-value="patch({ send_minute: toNullableInt($event) })"
        >
          <el-option v-for="m in MINUTE_OPTIONS" :key="m" :label="pad2(m)" :value="m" />
        </el-select>
        <span v-if="errors?.send_time" class="field-error">{{ errors.send_time }}</span>
      </div>
    </template>

    <template v-if="flags.needs_weekday">
      <div :class="['field-row', rowClass('weekday')]">
        <span class="field-label">星期</span>
        <el-select
          :model-value="modelValue.weekday"
          class="weekday-select"
          placeholder="选择星期几"
          aria-label="星期几"
          @update:model-value="patch({ weekday: toNullableInt($event) })"
        >
          <el-option
            v-for="d in WEEKDAY_OPTIONS"
            :key="d.value"
            :label="d.label"
            :value="d.value"
          />
        </el-select>
        <span v-if="errors?.weekday" class="field-error">{{ errors.weekday }}</span>
      </div>
    </template>

    <template v-if="flags.needs_day_of_month">
      <div :class="['field-row', rowClass('day_of_month')]">
        <span class="field-label">每月几号</span>
        <el-input-number
          :model-value="modelValue.day_of_month"
          class="day-input"
          :min="1"
          :max="28"
          :step="1"
          :precision="0"
          controls-position="right"
          placeholder="1..28"
          @update:model-value="patch({ day_of_month: toNullableInt($event) })"
        />
        <span class="field-hint">上限 28，避开 2 月等短月</span>
        <span v-if="errors?.day_of_month" class="field-error">{{ errors.day_of_month }}</span>
      </div>
    </template>

    <el-alert
      v-if="!flags.needs_time"
      class="manual-hint"
      type="info"
      show-icon
      :closable="false"
      title="仅手动推送，不注册定时任务"
      description="「预览」与「立即发送」仍可用；需要准点自动发出时把频率改成每天 / 每周 / 每月。"
    />
  </div>
</template>

<script setup lang="ts">
// views/wecom/daily/components/WeComScheduleSection.vue
//
// 2026-10-17 新建：见文件头。0 业务状态 —— 表单模型是 prop、补丁是 emit。

import { computed } from 'vue';
import {
  DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS,
  type WeComDailyFormField,
  type WeComDailyFormFieldErrors,
  type WeComDailyFormModel,
  type WeComDailyFrequencyOptionData,
} from '../weComDailySchema';
import type { WeComDailyFrequency } from '@/types/wecom';
// 只用 `import type` 引 webhook 那一行的 wire 类型 —— 本组件不碰守门 schema（它在
// `views/wecom/webhooks/weComWebhookSchema.ts`，由那个子域自己的 query hook 守门），也不碰
// api 层。两个子域之间只共享一条 query 缓存。
import type { WeComWebhookData } from '@/views/wecom/webhooks/weComWebhookSchema';

const props = defineProps<{
  /** 整个表单模型（本组件只碰自己那几个键）。 */
  modelValue: WeComDailyFormModel;
  /** 频率选项，取自 `GET /meta` 的 `frequencies[]`；meta 未到达时壳传兜底表。 */
  frequencyOptions: readonly WeComDailyFrequencyOptionData[];
  /** 可选的推送通道（`GET /cron/wecom/webhooks` 的行）。选项 label 用管理员起的自定义名称
   *  （同名通道靠它区分），右侧补一行掩码便于辨认是哪一群。空数组 = 还没建任何通道。 */
  webhooks?: readonly WeComWebhookData[];
  /** 字段红字（Zod / 后端 21804）。 */
  errors?: WeComDailyFormFieldErrors;
  /** 需要高亮的字段（store 的 `focusField`）。 */
  focusField?: WeComDailyFormField | null;
}>();

// emits 用**函数类型**而不是 `{ (e, v): void }` 的类型字面量（仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红；两者语义等价，Vue 3.3+ 均支持）。
const emit = defineEmits<(e: 'update:modelValue', value: WeComDailyFormModel) => void>();

/** 小时候选 0..23（wire 上是 `send_hour: number|null`，与下拉的 value 逐字同形）。 */
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => i);
/** 星期候选：ISO 1=周一 … 7=周日（与后端 `weekday` 的取值逐字对齐，不是 JS 的 0=周日）。 */
const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

/** 当前频率的三个 needs_*：优先读 meta 下发的选项，读不到（meta 未到达 / 选项缺项）时回落到
 *  内置兜底表，保证频率一选出来配套字段就跟着显隐。 */
const flags = computed(() => {
  const opt = props.frequencyOptions.find((f) => f.value === props.modelValue.frequency);
  return opt ?? DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS[props.modelValue.frequency];
});

/** 可选的推送通道。缺省 prop 给空数组（模板里 v-for 空数组天然不渲染 option）。 */
const webhooks = computed<readonly WeComWebhookData[]>(() => props.webhooks ?? []);

function patch(patchValue: Partial<WeComDailyFormModel>): void {
  emit('update:modelValue', { ...props.modelValue, ...patchValue });
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** el-select 的清空给出的是 `''`（emptyValues 默认值），统一归一成 null（= 没填），免得把
 * 空串塞进 `send_hour` 变成 `''` 上 wire。 */
function toNullableInt(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 通道 id 同款归一：空串 / undefined ⇒ `null`（= 未选）。雪花 ID 是 JSON string，
 * `el-option :value` 给的就是字符串，**不要**过一遍 `Number()`（19 位 ID 会丢精度）。 */
function toNullableString(v: unknown): string | null {
  if (v === '' || v === null || v === undefined) return null;
  return String(v);
}

function onFrequencyChange(value: unknown): void {
  const frequency = String(value) as WeComDailyFrequency;
  const next = props.frequencyOptions.find((f) => f.value === frequency);
  const judge = next ?? DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS[frequency];
  patch({
    frequency,
    send_hour: judge.needs_time ? props.modelValue.send_hour : null,
    send_minute: judge.needs_time ? props.modelValue.send_minute : null,
    weekday: judge.needs_weekday ? props.modelValue.weekday : null,
    day_of_month: judge.needs_day_of_month ? props.modelValue.day_of_month : null,
  });
}

/** 字段行样式：出错的行标红、被 focusField 指到的行加高亮边框（字段聚焦的视觉层）。 */
function rowClass(field: WeComDailyFormField): Record<string, boolean> {
  return {
    'is-error': !!props.errors?.[field],
    'is-focus': props.focusField === field,
  };
}
</script>

<style lang="scss" scoped>
.wecom-schedule {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
}

.field-row.is-error {
  border-color: var(--el-color-danger-light-7);
}

.field-row.is-focus {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}

.field-label {
  width: 84px;
  flex-shrink: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.field-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
}

.option-masked {
  float: right;
  margin-left: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

.time-select {
  width: 96px;
}

.time-colon {
  color: var(--text-secondary);
}

.weekday-select {
  width: 160px;
}

.webhook-select {
  width: 340px;
}

.day-input {
  width: 140px;
}

.manual-hint {
  margin-left: 96px;
}
</style>
