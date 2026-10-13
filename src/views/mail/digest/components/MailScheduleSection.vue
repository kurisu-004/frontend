<!--
  MailScheduleSection.vue — 定时设置（总开关 + 频率 + 配套字段）

  2026-10-13 新建。**纯组件，零 store / 零 api 依赖**：表单模型从 `modelValue` 进、
  补丁从 `update:modelValue` 出（见 `composables/useMailDigestStore.ts` 文件头为什么
  本页的 section 不首调 store）。

  三条渲染分支由 `frequencyOptions`（= `GET /meta` 的 `frequencies[]`）的三个 `needs_*`
  决定，**不在本组件硬编码**：
    - needs_time          → 时 / 分 两个下拉
    - needs_weekday       → 星期下拉（ISO 1=周一 … 7=周日）
    - needs_day_of_month  → 每月几号（1..28）
    - MANUAL_ONLY（三个 needs_* 全 false）→ 全部隐藏，只留一条提示

  为什么时/分用两个 `el-select` 而不是 `el-time-picker`：契约的 wire 形态就是
  `send_hour: number|null` + `send_minute: number|null` 两个独立字段，而
  `el-time-picker` 的值是一个 `Date`（要 `value-format` 才能变成字符串）—— 用它就得在
  存取两端各做一次 `Date ⇄ (h, m)` 转换，而这份转换的出错方向是**静默**的（时区 / 跨天）。
  两个下拉的值域固定（0..23 / 0..59），与 wire 逐字同形、零转换。

  切频率时把「当前频率用不到」的配套字段置 null（`onFrequencyChange`）：留着上一次切
  频率前的值会构成「频率与配套字段组合非法」。
  ⚠️ 2026-10-14（review 第 1 轮 M-2）订正：**后端对「多填」不是报错而是清空 / 忽略**
  —— `validate_save_request` 里 `weekday` / `day_of_month` 在非专属频率下被**清成 NULL**，
  `MANUAL_ONLY` 的时刻字段则是**既不清空也不校验、原样存回**（`validate_time` 在
  `!needs_time` 时直接 Ok）。前端在这里先归一是**为了让表单自洽 + 让校验红字落在可见
  字段上**（多填的 issue 挂 `send_time` / `weekday` / `day_of_month`，而 MANUAL_ONLY 下
  那一整行连同红字都不渲染 ⇒ 不归一就是一条看不见的死路）。store 的 `applyConfigToForm`
  对服务端配置做同一套归一（`GET /config` 也会返 MANUAL_ONLY + 非空时刻的行）。

  2026-10-16 新增「发信邮箱」一行（`senderAccounts` prop + `sender_account_id` 字段）：
  SMTP 不再是部署级环境变量，而是页面内可维护的邮箱账号实体（`views/mail/accounts/`，后端
  `/api/v2/mail/accounts`），发信用哪一条由**用户在本页选**。选项取自 **query**（壳传下来
  的 `senderAccounts`），**不在本组件硬编码**、也不 props 传一堆预设文案 —— 邮箱列表是
  会变的运行时数据，props 硬编码等于把「有什么邮箱」写在模板里。
-->
<template>
  <div class="mail-schedule">
    <!-- 2026-10-16：发信邮箱。放最前面是因为它是「能不能发出去」的前置条件，
         比「什么时候发」更该先看见。空值 = 未选（保存合法，但**发不出去**：后端
         `resolve_sender` 对 null 直接 21701，没有回落默认邮箱的分支 —— 见页面顶部告警）。 -->
    <div :class="['field-row', rowClass('sender_account_id')]">
      <span class="field-label">发信邮箱</span>
      <el-select
        :model-value="modelValue.sender_account_id"
        class="sender-select"
        clearable
        placeholder="未选（发送会失败）"
        aria-label="发信邮箱"
        @update:model-value="patch({ sender_account_id: toNullableString($event) })"
      >
        <el-option v-for="acc in senderAccounts" :key="acc.id" :label="acc.name" :value="acc.id" />
      </el-select>
      <span v-if="senderAccounts.length === 0" class="field-hint">
        还没有可用邮箱，请先到「邮箱设置」里新增一条
      </span>
      <span v-if="errors?.sender_account_id" class="field-error">{{
        errors.sender_account_id
      }}</span>
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

    <!-- el-radio-group 根元素非 labelable，外层已给 for=""（见壳的 form-item） -->
    <div :class="['field-row', rowClass('frequency')]">
      <span class="field-label">频率</span>
      <el-radio-group
        :model-value="modelValue.frequency"
        aria-label="发送频率"
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
      title="仅手动发送，不注册定时任务"
      description="「预览」与「立即发送」仍可用；需要准点自动发出时把频率改成每天 / 每周 / 每月。"
    />
  </div>
</template>

<script setup lang="ts">
// views/mail/digest/components/MailScheduleSection.vue
//
// 2026-10-13 新建：见文件头。0 业务状态 —— 表单模型是 prop、补丁是 emit。

import { computed } from 'vue';
import {
  DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS,
  type MailDigestFormField,
  type MailDigestFormFieldErrors,
  type MailDigestFormModel,
  type MailDigestFrequencyOptionData,
} from '../mailDigestSchema';
import type { MailDigestFrequency } from '@/types/mailDigest';
// 2026-10-16：只用 `import type` 引邮箱那一行的 wire 类型 —— 本组件不碰守门
// schema（它在 `views/mail/accounts/mailAccountSchema.ts`，由 accounts 域自己的
// query hook 守门），也不碰 api 层。digest 域与 accounts 域之间只共享一条 query 缓存。
import type { MailAccountData } from '@/views/mail/accounts/mailAccountSchema';

const props = defineProps<{
  /** 整个表单模型（本组件只碰自己那几个键）。 */
  modelValue: MailDigestFormModel;
  /** 频率选项，取自 `GET /meta` 的 `frequencies[]`；meta 未到达时壳传兜底表。 */
  frequencyOptions: readonly MailDigestFrequencyOptionData[];
  /** 2026-10-16：可选的发信邮箱（`GET /mail/accounts` 的行）。选项 label 用管理员
   *  起的自定义名称（同名登录账号靠它区分）。空数组 = 还没建任何邮箱。 */
  senderAccounts?: readonly MailAccountData[];
  /** 字段红字（Zod / 后端 21703·21704）。 */
  errors?: MailDigestFormFieldErrors;
  /** 需要高亮的字段（store 的 `focusField`）。 */
  focusField?: MailDigestFormField | null;
}>();

// emits 用**函数类型**而不是 `{ (e, v): void }` 的类型字面量（仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红；两者语义等价，Vue 3.3+ 均支持）。
const emit = defineEmits<(e: 'update:modelValue', value: MailDigestFormModel) => void>();

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

/** 当前频率的三个 needs_*：优先读 meta 下发的选项，读不到（meta 未到达 / 选项缺项）时
 *  回落到内置兜底表，保证频率一选出来配套字段就跟着显隐。 */
const flags = computed(() => {
  const opt = props.frequencyOptions.find((f) => f.value === props.modelValue.frequency);
  return opt ?? DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS[props.modelValue.frequency];
});

/** 可选的发信邮箱。缺省 prop 给空数组（模板里 v-for 空数组天然不渲染 option）。 */
const senderAccounts = computed<readonly MailAccountData[]>(() => props.senderAccounts ?? []);

function patch(patchValue: Partial<MailDigestFormModel>): void {
  emit('update:modelValue', { ...props.modelValue, ...patchValue });
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** el-select 的清空给出的是 `''`（emptyValues 默认值），统一归一成 null
 *  （= 没填），免得把空串塞进 `send_hour` 变成 `''` 上 wire。 */
function toNullableInt(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 发信邮箱 id 同款归一：空串 / undefined ⇒ `null`（= 未选）。雪花 ID 是 JSON string，
 *  `el-option :value` 给的就是字符串，**不要**过一遍 `Number()`（19 位 ID 会丢精度）。 */
function toNullableString(v: unknown): string | null {
  if (v === '' || v === null || v === undefined) return null;
  return String(v);
}

function onFrequencyChange(value: unknown): void {
  const frequency = String(value) as MailDigestFrequency;
  const next = props.frequencyOptions.find((f) => f.value === frequency);
  const judge = next ?? DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS[frequency];
  patch({
    frequency,
    send_hour: judge.needs_time ? props.modelValue.send_hour : null,
    send_minute: judge.needs_time ? props.modelValue.send_minute : null,
    weekday: judge.needs_weekday ? props.modelValue.weekday : null,
    day_of_month: judge.needs_day_of_month ? props.modelValue.day_of_month : null,
  });
}

/** 字段行样式：出错的行标红、被 focusField 指到的行加高亮边框（字段聚焦的视觉层）。 */
function rowClass(field: MailDigestFormField): Record<string, boolean> {
  return {
    'is-error': !!props.errors?.[field],
    'is-focus': props.focusField === field,
  };
}
</script>

<style lang="scss" scoped>
.mail-schedule {
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

.time-select {
  width: 96px;
}

.time-colon {
  color: var(--text-secondary);
}

.weekday-select {
  width: 160px;
}

.sender-select {
  width: 240px;
}

.day-input {
  width: 140px;
}

.manual-hint {
  margin-left: 96px;
}
</style>
