<!--
  WeComLogTable.vue — 发送历史表格

  2026-10-17 新建。**纯组件，零 store / 零 api 依赖**（行集由壳传进来，分页在壳里）。

  为什么不做列可见性开关 / 列拖动（照 `MailLogTable.vue` 文件头的同款论证）：这张表只有
  8 列且都是排查失败原因必需的信息（时间 / 来源 / 状态 / 条数 / 推送对象 / 逾期 / 近期交期 /
  错误信息），隐藏掉任何一列都会让「为什么没发出去」这条排查链断掉。账号管理页那套
  `useColumnVisibility` 的适用前提是「列多到放不下、且用户有稳定的使用习惯」，这里不满足。

  ⚠️ **「条数」列的三条渲染规则**（已逐条确认，顺序即判定优先级）：
    | 情形                   | 渲染                  | class      |
    |----------------------|---------------------|------------|
    | `chunk_count === 0`  | `—`                 | `.muted`   |
    | `chunk_sent < chunk_count` | `已发/应发`     | `.error-text` |
    | 其余                    | `已发/应发`       | 默认        |
  `chunk_count === 0` 是**合法值** = 准备阶段就失败（还没渲染出任何一条），此时显示 `0/0`
  会与「发了 0 条且成功」混淆（后者的 `status` 是 SUCCESS，但同样渲染 `0/0`）⇒ 一律显示 `—`
  并挂 title 说明。

  ⚠️ **「条数」列刻意不套 `el-tag`**：失败行已由 `:row-class-name` → `:deep(.el-table__row
  .is-failed > td.el-table__cell)` **整行标红**（`el-table` 的 row-class-name 只能整行上色、
  没法只染一格），再套一枚红 tag 是双重编码且撑宽度。

  ⚠️ **日报的 5 个计数字段（`overview_batch_count` / `overview_quantity` / `note_count` /
  `worker_row_total` / `markdown_bytes`）一律不做列** —— 理由：**邮件**发出去
  就没有了，日志行是唯一的副本，内容口径必须快照下来；**企业微信的日报在群里还看得到**，
  重复存储没意思。且内容口径问题与投递故障混在一张表里会互相干扰排查（一条「逾期数算错了」
  的行看起来像「推送失败了」）。
  2026-10-23：第二节改口径后 `note_count` 承载的是**本期出货单数**（今日送货单里去重后的
  `part` 数）—— 仍不做列，本段只是记下语义归属。

  ⚠️ **同理不建「统计日」列** —— `report_date` 恒等于 `sent_at` 的日期部分（后端同一个
  `now_naive()` 调用取值），是纯冗余列。

  ⚠️ **「N 日内」列的表头由壳传入**：这一列数的是 `upcoming_days` 范围内的工单，而
  `upcoming_days` 是管理员可配的（后端 `meta.upcoming_days_range` 下发 1..60、默认 3）⇒ 表头
  写死「3日内」在改成 7 天之后就成了一句假话，而它恰好是排查「为什么逾期 / 近期数对不上」时
  第一眼看的列。取值与回落见 `utils/upcomingDaysLabel.ts`。

  失败行标红：`:row-class-name` 给 `status === 'FAILED'` 的行加 `is-failed`，由本页 scoped CSS
  的 `:deep()` 上色（EP 把 row-class-name 加在 `<tr>` 上，scoped 选择器带不上 scopeId，必须
  `:deep`）。
-->
<template>
  <div class="wecom-log-table">
    <el-table
      v-loading="loading"
      :data="items"
      row-key="log_id"
      stripe
      border
      size="small"
      style="width: 100%"
      :row-class-name="rowClassName"
      empty-text="暂无发送记录"
    >
      <el-table-column prop="sent_at" label="时间" min-width="160" align="center">
        <template #default="{ row }">
          <span>{{ formatNaiveDateTime(row.sent_at) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="触发来源" min-width="100" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain" :type="triggerTagType(row.trigger_source)">
            {{ triggerLabel(row.trigger_source) }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="状态" min-width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'SUCCESS' ? 'success' : 'danger'">
            {{ row.status === 'SUCCESS' ? '成功' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="条数" min-width="90" align="center">
        <template #default="{ row }">
          <!-- ⚠️ 槽里的 `row` 是 EP 注入的 `DefaultRow`，要传给带类型的函数得收窄一次
               （照 `MailLogTable.vue` 里 `row as MailDigestLogData` 的同款做法）。 -->
          <span v-if="row.chunk_count === 0" class="muted" title="发送前准备失败，未进入分片渲染"
            >—</span
          >
          <span v-else-if="row.chunk_sent < row.chunk_count" class="error-text">{{
            chunkText(row as WeComDailyLogData)
          }}</span>
          <span v-else>{{ chunkText(row as WeComDailyLogData) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="推送对象" min-width="180" align="left">
        <template #default="{ row }">
          <span :title="row.webhook_masked">{{ row.webhook_name }}</span>
        </template>
      </el-table-column>

      <el-table-column prop="overdue_count" label="逾期" min-width="80" align="center" />
      <!-- ⚠️ label 由壳传入（`upcoming_days`），**不许**写死「3日内」：这一列的语义由配置项
           `upcoming_days` 决定（后端 `meta.upcoming_days_range` 下发 1..60，默认 3），管理员
           把它改成 7 天之后表头还在说「3日内」—— 而这正是排查「为什么逾期 / 近期数对不上」时
           第一眼看的列。回落值与后端默认 3 一致（见 `upcomingDaysLabel`）。 -->
      <el-table-column :label="upcomingLabel" prop="upcoming_count" min-width="80" align="center" />

      <el-table-column label="错误信息" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="row.error_message ? 'error-text' : 'muted'">
            {{ row.error_message || '—' }}
          </span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
// views/wecom/daily/components/WeComLogTable.vue
//
// 2026-10-17 新建：见文件头。0 业务状态 —— 行集是 prop。

import { computed } from 'vue';
import { formatNaiveDateTime } from '@/utils/naiveDateTime';
import type { WeComDailyLogData } from '../weComDailySchema';
import type { WeComDailyTriggerSource } from '@/types/wecom';
import { upcomingDaysLabel } from '../utils/upcomingDaysLabel';

// `loading` 走 withDefaults 而不是裸 `loading?: boolean`：EP 的 `v-loading` 指令值类型是
// `LoadingBinding`（不接受 undefined），可空 prop 直接绑会被 vue-tsc 判 TS2322。
const props = withDefaults(
  defineProps<{
    /** 行集（已解析出 `WeComDailyLogData[]`，queryFn 里 Zod 守门过）。 */
    items: WeComDailyLogData[];
    loading?: boolean;
    /** 「近期交期」列的天数（壳传 `store.query.form.upcoming_days`）。`el-input-number` 被清空
     *  时给的是 `undefined`，所以这个 prop 允许非数字，由 `upcomingDaysLabel` 回落。 */
    upcomingDays?: number | string;
  }>(),
  { loading: false },
);

/** 「N 日内」列的表头。天数由配置项决定 ⇒ 表头必须跟着配置走，不能写死 3。
 *  **非数字（`undefined` / `null` / 空串 / 脏值）一律回落成后端默认的 3** —— 表头宁可给一个
 *  合法值，也不能给用户看一个「日内」而前面没有数字的空标签。 */
const upcomingLabel = computed(() => upcomingDaysLabel(props.upcomingDays));

/** 触发来源的中文名。字面量与后端 `LogRow.trigger_source` 的两个取值逐字对齐。槽里的 `row`
 *  是 EP 注入的 `any`，所以走函数 + 收窄，不在模板里直接索引映射表。 */
const TRIGGER_LABEL: Record<WeComDailyTriggerSource, string> = {
  SCHEDULED: '定时',
  MANUAL: '手动',
};

function triggerLabel(source: unknown): string {
  return TRIGGER_LABEL[source as WeComDailyTriggerSource] ?? String(source ?? '');
}

function triggerTagType(source: unknown): 'primary' | 'warning' {
  return source === 'SCHEDULED' ? 'primary' : 'warning';
}

/** 「已发几条 / 本来要发几条」。后端在发完最后一条才把 `chunk_sent` 补齐，中途失败时它停在
 * 已发出的那一条上 ⇒ 这个比值是「这次推送断在第几条」的唯一信号。 */
function chunkText(row: WeComDailyLogData): string {
  return `${row.chunk_sent}/${row.chunk_count}`;
}

function rowClassName({ row }: { row: WeComDailyLogData }): string {
  return row.status === 'FAILED' ? 'is-failed' : '';
}
</script>

<style lang="scss" scoped>
.wecom-log-table {
  width: 100%;
}

/* EP 把 row-class-name 加在 <tr> 上（不在本组件模板里渲染）⇒ scoped 选择器带不上 scopeId，
   必须 :deep 才命中。 */
:deep(.el-table__row.is-failed > td.el-table__cell) {
  background: var(--el-color-danger-light-9) !important;
}

:deep(.muted) {
  color: var(--text-secondary);
}

:deep(.error-text) {
  color: var(--el-color-danger);
}
</style>
