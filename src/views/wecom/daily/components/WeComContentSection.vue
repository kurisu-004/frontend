<!--
  WeComContentSection.vue — 推送内容（四节开关 + 天数 / 每组条数 / 人数 / 分片上限 +
  条形图口径 + 标题）

  2026-10-17 新建。**纯组件，零 store / 零 api 依赖**。

  2026-10-23 新增第三节的两个细粒度控件：`order_list_limit`（每个交期分组最多列多少条）与
  `include_drawings`（工单行是否挂图纸预览链接），都落在 ③「交期工单」那一组的紧下方。
  ⚠️ `order_list_limit` 的 `:min/:max` 引**域内常量** `WECOM_DAILY_ORDER_LIST_LIMIT_RANGE`
  而不是 `ranges` prop —— `GET /meta` 的契约里**没有**这一段 range（只在 `defaults` 段多了两
  个键），而表单校验的越界判读同一份常量，所以不会出现「UI 放行、schema 却拒」。

  ⚠️ **条形图由后端渲染成 markdown 字符条随消息下发，本组件不引入任何图表组件**：CLAUDE.md
  「图表」一节要求业务组件一律走 `vue-echarts`，而这里是**明确的例外且刻意如此** —— 推送内容
  是一段要原样进企业微信的 markdown 文本，前端渲染出来的图对「群里那条消息」毫无贡献（那才是
  管理员与车间真正会看的东西）。前端这一侧只负责「选口径 / 选人数上限」，条形字符图由后端
  `█` / `░` 直接打进 `chunks[]`，预览弹窗按纯文本展示。

  四组控件全部由 `GET /meta` 驱动，**不在前端硬编码**：
    - `workerMetricOptions` → 条形图的指标口径（按件数 / 按批次数）；
    - `ranges` → 三个数字输入的上下限（后端收窄 / 放宽时前端自动跟随；schema 的越界校验读同
      一份，所以不会出现「UI 放行、校验却拒」）。

  交互约定：
    - 关掉第三节时 `upcoming_days` 输入项**禁用但不清值**：清值会让用户「关 → 开」之后发现天数
      丢了；留着它对后端无影响（该节关着时天数不参与渲染）。
    - 关掉第四节时 `worker_metric` / `worker_top_n` **同样禁用但不清值**（同上）。
    - `subject_template` 留空 = 用后端默认标题（提交时转 `null`，见 store 的 `save()`），所以
      这里不做「必填」标红。
    - ⚠️ 四节全关时**不拦在单个开关上**、而是给出一行汇总提示（schema 的 `sections` issue）：
      「四个开关共同」的责任挂到任何一个框上都会误导（用户会以为自己那个开关有问题）。
-->
<template>
  <div class="wecom-content">
    <div class="field-row">
      <span class="field-label">① 全厂报工总览</span>
      <el-switch
        :model-value="modelValue.include_overview"
        aria-label="全厂报工总览"
        @update:model-value="patch({ include_overview: Boolean($event) })"
      />
      <span class="field-hint">报工批次 / 件数、送检批次、在制单数（在制为当前快照）</span>
    </div>

    <div class="field-row">
      <span class="field-label">② 今日出货</span>
      <el-switch
        :model-value="modelValue.include_delivery"
        aria-label="今日出货"
        @update:model-value="patch({ include_delivery: Boolean($event) })"
      />
      <span class="field-hint">本期出货的去重工单数（同一工单只算一次）</span>
    </div>

    <div :class="['field-row', rowClass('upcoming_days')]">
      <span class="field-label">③ 交期工单</span>
      <el-switch
        :model-value="modelValue.include_orders"
        aria-label="交期工单"
        @update:model-value="patch({ include_orders: Boolean($event) })"
      />
      <el-input-number
        :model-value="modelValue.upcoming_days"
        class="days-input"
        :min="ranges.upcoming_days.min"
        :max="ranges.upcoming_days.max"
        :step="1"
        :precision="0"
        controls-position="right"
        :disabled="!modelValue.include_orders"
        :placeholder="`${ranges.upcoming_days.min}..${ranges.upcoming_days.max}`"
        aria-label="交期工单天数"
        @update:model-value="onUpcomingDaysChange"
      />
      <span class="field-hint">
        逾期未交 + 未来 {{ ranges.upcoming_days.min }}..{{ ranges.upcoming_days.max }} 天内到期
      </span>
      <span v-if="errors?.upcoming_days" class="field-error">{{ errors.upcoming_days }}</span>
    </div>

    <!-- 2026-10-23 新增：第三节工单清单的两个细粒度控件，都只在第三节开着时生效。
         放 ③ 这一行的紧下方（而不是「单次最多条数」那块）：这两个字段管的是**第三节的清单
         本身**，跟第四节工人、跟整份日报的发几条都不是一回事。关掉第三节时同样禁用但不清值
         （与天数那条同款理由：关 → 开之后不该发现设置丢了）。 -->
    <div :class="['field-row', rowClass('order_list_limit')]">
      <span class="field-label field-label--wide">交期清单每组最多列出</span>
      <el-input-number
        :model-value="modelValue.order_list_limit"
        class="limit-input"
        :min="ORDER_LIST_LIMIT_RANGE.min"
        :max="ORDER_LIST_LIMIT_RANGE.max"
        :step="1"
        :precision="0"
        controls-position="right"
        :disabled="!modelValue.include_orders"
        :placeholder="`${ORDER_LIST_LIMIT_RANGE.min}..${ORDER_LIST_LIMIT_RANGE.max}`"
        aria-label="交期清单每组最多列出"
        @update:model-value="onOrderListLimitChange"
      />
      <span class="field-hint">0 = 不限；超出部分只出「另有 N 条未列出」脚注，不会静默截断</span>
      <span v-if="errors?.order_list_limit" class="field-error">{{ errors.order_list_limit }}</span>
    </div>

    <div class="field-row">
      <span class="field-label field-label--wide">附带图纸预览链接</span>
      <el-switch
        :model-value="modelValue.include_drawings"
        aria-label="附带图纸预览链接"
        :disabled="!modelValue.include_orders"
        @update:model-value="patch({ include_drawings: Boolean($event) })"
      />
      <span class="field-hint">关闭后不触发图片转码，只出纯文字清单</span>
    </div>

    <div :class="['field-row', rowClass('worker_metric')]">
      <span class="field-label">④ 工人报工</span>
      <el-switch
        :model-value="modelValue.include_workers"
        aria-label="工人报工"
        @update:model-value="patch({ include_workers: Boolean($event) })"
      />
      <el-radio-group
        :model-value="modelValue.worker_metric"
        :disabled="!modelValue.include_workers"
        aria-label="条形图指标口径"
        @update:model-value="onWorkerMetricChange"
      >
        <el-radio-button v-for="opt in workerMetricOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </el-radio-button>
      </el-radio-group>
      <el-input-number
        :model-value="modelValue.worker_top_n"
        class="topn-input"
        :min="ranges.worker_top_n.min"
        :max="ranges.worker_top_n.max"
        :step="1"
        :precision="0"
        controls-position="right"
        :disabled="!modelValue.include_workers"
        :placeholder="`${ranges.worker_top_n.min}..${ranges.worker_top_n.max}`"
        aria-label="工人人数上限"
        @update:model-value="onWorkerTopNChange"
      />
      <span class="field-hint">按{{ currentMetricLabel }}排条形图，最多列多少人</span>
      <span v-if="errors?.worker_metric" class="field-error">{{ errors.worker_metric }}</span>
      <span v-if="errors?.worker_top_n" class="field-error">{{ errors.worker_top_n }}</span>
    </div>

    <div :class="['field-row', rowClass('max_chunks')]">
      <span class="field-label">单次最多条数</span>
      <el-input-number
        :model-value="modelValue.max_chunks"
        class="chunks-input"
        :min="ranges.max_chunks.min"
        :max="ranges.max_chunks.max"
        :step="1"
        :precision="0"
        controls-position="right"
        aria-label="单次最多条数"
        @update:model-value="onMaxChunksChange"
      />
      <span class="field-hint">
        内容超长会拆成多条发出（不截断）；这里限制一次触发最多发几条，实际片数超出它则整份日报
        发送失败（错误码 21804），不会静默截断
      </span>
      <span v-if="errors?.max_chunks" class="field-error">{{ errors.max_chunks }}</span>
    </div>

    <!-- ⚠️ 四节全关的提示挂在虚拟字段 `sections` 上：它是四个开关**共同**的责任，挂到任何
         一个框上都会误导用户。 -->
    <div v-if="errors?.sections" :class="['field-row', rowClass('sections')]">
      <span class="field-error">{{ errors.sections }}</span>
    </div>

    <div :class="['field-row', rowClass('subject_template')]">
      <span class="field-label">标题模板</span>
      <el-input
        :model-value="modelValue.subject_template"
        class="subject-input"
        maxlength="200"
        placeholder="留空则用后端默认标题（如「生产日报 2026-10-17」）"
        @update:model-value="patch({ subject_template: String($event ?? '') })"
      />
      <span v-if="errors?.subject_template" class="field-error">{{ errors.subject_template }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// views/wecom/daily/components/WeComContentSection.vue
//
// 2026-10-17 新建：见文件头。0 业务状态 —— 表单模型是 prop、补丁是 emit。

import { computed } from 'vue';
import {
  DEFAULT_WECOM_DAILY_RANGES,
  WECOM_DAILY_ORDER_LIST_LIMIT_RANGE as ORDER_LIST_LIMIT_RANGE,
  type WeComDailyFormField,
  type WeComDailyFormFieldErrors,
  type WeComDailyFormModel,
  type WeComDailyRanges,
  type WeComDailyWorkerMetricOptionData,
} from '../weComDailySchema';
import type { WeComDailyWorkerMetric } from '@/types/wecom';

const props = withDefaults(
  defineProps<{
    modelValue: WeComDailyFormModel;
    /** 条形图指标候选（`GET /meta` 的 `worker_metrics[]`）。meta 未到达时壳传兜底表。 */
    workerMetricOptions: readonly WeComDailyWorkerMetricOptionData[];
    /** 三段取值范围（`GET /meta` 的三个 `*_range`）。⚠️ 与 schema 的越界校验同源。 */
    ranges: WeComDailyRanges;
    errors?: WeComDailyFormFieldErrors;
    focusField?: WeComDailyFormField | null;
  }>(),
  {
    // 兜底值与 `weComDailySchema.ts::DEFAULT_WECOM_DAILY_RANGES` 逐字一致 —— 两者都是「meta
    // 还没回来」这一瞬的兜底，meta 到达后以 meta 为准（不是第二真源）。
    ranges: () => ({
      upcoming_days: { ...DEFAULT_WECOM_DAILY_RANGES.upcoming_days },
      worker_top_n: { ...DEFAULT_WECOM_DAILY_RANGES.worker_top_n },
      max_chunks: { ...DEFAULT_WECOM_DAILY_RANGES.max_chunks },
    }),
  },
);

// emits 用**函数类型**而不是 `{ (e, v): void }` 的类型字面量（仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红；两者语义等价，Vue 3.3+ 均支持）。
const emit = defineEmits<(e: 'update:modelValue', value: WeComDailyFormModel) => void>();

/** 当前口径的中文名（提示文案里用；找不到时回落到枚举字面量而不是空白）。 */
const currentMetricLabel = computed(
  () =>
    props.workerMetricOptions.find((o) => o.value === props.modelValue.worker_metric)?.label ??
    props.modelValue.worker_metric,
);

function patch(patchValue: Partial<WeComDailyFormModel>): void {
  emit('update:modelValue', { ...props.modelValue, ...patchValue });
}

/** 三个 el-input-number 清空给出 undefined/null；原样传给表单态，由 schema 的 requiredInt
 *  （空值 → NaN）判错，不在这里兜成 0（那会让「清空」看起来像「0 天 / 0 人 / 0 条」）。 */
function onUpcomingDaysChange(v: unknown): void {
  patch({ upcoming_days: v === '' ? undefined : (v as number | undefined) });
}

/** 2026-10-23 新增：与上面三个数字输入同款处理（清空交 undefined，不兜 0 —— 0 在这一项上
 *  是有意义的值「不限」，兜成 0 会把「没填」说成「不限」）。 */
function onOrderListLimitChange(v: unknown): void {
  patch({ order_list_limit: v === '' ? undefined : (v as number | undefined) });
}

function onWorkerTopNChange(v: unknown): void {
  patch({ worker_top_n: v === '' ? undefined : (v as number | undefined) });
}

function onMaxChunksChange(v: unknown): void {
  patch({ max_chunks: v === '' ? undefined : (v as number | undefined) });
}

function onWorkerMetricChange(v: unknown): void {
  patch({ worker_metric: String(v ?? 'QUANTITY') as WeComDailyWorkerMetric });
}

function rowClass(field: WeComDailyFormField): Record<string, boolean> {
  return {
    'is-error': !!props.errors?.[field],
    'is-focus': props.focusField === field,
  };
}
</script>

<style lang="scss" scoped>
.wecom-content {
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
  width: 96px;
  flex-shrink: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

/* 2026-10-23 新增：两个新控件的 label 比 96px 长（「交期清单每组最多列出」10 个字），硬塞进
   窄列会折成两行。给它们一个加宽档，其余行保持原样、不动既有视觉。 */
.field-label--wide {
  width: 140px;
}

.days-input,
.topn-input,
.limit-input,
.chunks-input {
  width: 140px;
}

.field-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
}

.subject-input {
  width: 420px;
}
</style>
