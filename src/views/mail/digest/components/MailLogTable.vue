<!--
  MailLogTable.vue — 发送历史表格

  2026-10-13 新建。**纯组件，零 store / 零 api 依赖**（行集由壳传进来，分页在壳里）。

  为什么不做列可见性开关 / 列拖动：这张表只有 8 列且都是排查失败原因必需的信息
  （时间 / 来源 / 状态 / 收件人 / 逾期数 / 未来数 / 主题 / 错误信息），隐藏掉任何一列
  都会让「为什么没发出去」这条排查链断掉。账号管理页那套 `useColumnVisibility` 的
  适用前提是「列多到放不下、且用户有稳定的使用习惯」，这里不满足。

  失败行标红：`:row-class-name` 给 `status === 'FAILED'` 的行加 `is-failed`，由本页
  scoped CSS 的 `:deep()` 上色（EP 把 row-class-name 加在 `<tr>` 上，scoped 选择器
  带不上 scopeId，必须 `:deep`）。
-->
<template>
  <div class="mail-log-table">
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
          <span :class="row.sent_at ? '' : 'muted'">{{ formatNaiveDateTime(row.sent_at) }}</span>
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

      <el-table-column label="收件人" min-width="220" align="left">
        <template #default="{ row }">
          <span :title="allRecipientsText(row as MailDigestLogData)">{{
            allRecipientsText(row as MailDigestLogData)
          }}</span>
        </template>
      </el-table-column>

      <el-table-column prop="overdue_count" label="逾期" min-width="80" align="center" />
      <el-table-column prop="upcoming_count" label="未来" min-width="80" align="center" />

      <el-table-column prop="subject" label="主题" min-width="220" show-overflow-tooltip />
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
// views/mail/digest/components/MailLogTable.vue
//
// 2026-10-13 新建：见文件头。0 业务状态 —— 行集是 prop。

import type { MailDigestLogData } from '../mailDigestSchema';
import type { MailDigestTriggerSource } from '@/types/mailDigest';

// `loading` 走 withDefaults 而不是裸 `loading?: boolean`：EP 的 `v-loading` 指令值类型是
// `LoadingBinding`（不接受 undefined），可空 prop 直接绑会被 vue-tsc 判 TS2322。
withDefaults(
  defineProps<{
    /** 行集（已解析出 `MailDigestLogData[]`，queryFn 里 Zod 守门过）。 */
    items: MailDigestLogData[];
    loading?: boolean;
  }>(),
  { loading: false },
);

/** 触发来源的中文名。字面量与后端 `LogItem.trigger_source` 的两个取值逐字对齐。
 *  槽里的 `row` 是 EP 注入的 `any`，所以走函数 + 收窄，不在模板里直接索引映射表。 */
const TRIGGER_LABEL: Record<MailDigestTriggerSource, string> = {
  SCHEDULED: '定时',
  MANUAL: '手动',
};

function triggerLabel(source: unknown): string {
  return TRIGGER_LABEL[source as MailDigestTriggerSource] ?? String(source ?? '');
}

function triggerTagType(source: unknown): 'primary' | 'warning' {
  return source === 'SCHEDULED' ? 'primary' : 'warning';
}

/** 后端 `sent_at` 是 **naive** timestamp（无时区后缀，Asia/Shanghai 墙钟）。
 *  不能走 `utils/date.ts::formatDateTime` —— 那个函数 `new Date()` 后按 UTC 输出，会把
 *  墙钟时间整体平移 8 小时。这里只做字符串切片（照 usersColumnDefs.ts 的同款做法）。 */
function formatNaiveDateTime(raw: string | null): string {
  if (!raw) return '-';
  const normalized = raw.replace('T', ' ');
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized;
}

/** TO + CC 合并成一格显示（CC 非空时补 `（抄送: …）`）。整串进 `title`，
 *  长地址列表不必换行。 */
function allRecipientsText(row: MailDigestLogData): string {
  const to = row.to_recipients.join(', ');
  if (row.cc_recipients.length === 0) return to;
  return `${to}（抄送: ${row.cc_recipients.join(', ')}）`;
}

function rowClassName({ row }: { row: MailDigestLogData }): string {
  return row.status === 'FAILED' ? 'is-failed' : '';
}
</script>

<style lang="scss" scoped>
.mail-log-table {
  width: 100%;
}

/* EP 把 row-class-name 加在 <tr> 上（不在本组件模板里渲染）⇒ scoped 选择器带不上
   scopeId，必须 :deep 才命中。 */
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
