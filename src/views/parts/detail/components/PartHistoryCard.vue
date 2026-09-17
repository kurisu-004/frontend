<!--
  PartHistoryCard.vue

  历史记录卡（PartDetail 第 2 张卡）：
  - el-timeline 渲染 events
  - 加载逻辑由 usePartDetail.fetchEvents() 提供；本组件 fetch onMounted/watch partId
  - 纯展示，无 dialog / form

  2026-09-17 PR-3 联动改造：
  - 新增 selectedBatchId props：PartBatchMonitorCard 行选中时，本卡按
    `event.batch_id === selectedBatchId` 过滤；空态文案按「无选中 / 无事件」
    分支区分。selectedBatchId=null 时显示全部事件（向后兼容）。
-->
<template>
  <el-card v-loading="eventsLoading" shadow="never" class="history-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">历史记录</span>
        <span class="event-count">
          共 {{ displayedEvents?.length ?? 0 }} 条
          <template v-if="selectedBatchId">
            <span class="muted">（已按选中批次过滤）</span>
          </template>
        </span>
      </div>
    </template>

    <div v-if="displayedEvents && displayedEvents.length > 0" class="timeline">
      <el-timeline>
        <el-timeline-item
          v-for="evt in displayedEvents"
          :key="evt.id"
          :timestamp="formatDateTime(evt.created_at)"
          placement="top"
          :type="eventTagType(evt.event_type)"
          :hollow="evt.event_type !== 'CREATED'"
        >
          <div class="event-card">
            <div class="event-line-1">
              <el-tag :type="eventTagType(evt.event_type)" effect="dark" size="small">
                {{ eventLabel(evt.event_type) }}
              </el-tag>
              <el-tag v-if="evt.batch_no" size="small" effect="plain" type="info">
                批次{{ evt.batch_no }}
              </el-tag>
              <span v-if="evt.quantity !== null" class="muted">× {{ evt.quantity }}</span>
              <span v-if="evt.worker_name" class="worker-name">
                <el-icon><User /></el-icon>
                {{ evt.worker_name }}
              </span>
              <!-- 2026-07-17：历史记录中显示操作者姓名（优先 operator_name，username 仅作 fallback） -->
              <span v-if="evt.operator_name || evt.operator_username" class="operator-name">
                <el-icon><Setting /></el-icon>
                {{ evt.operator_name || evt.operator_username }}
              </span>
            </div>
            <div v-if="evt.from_status || evt.to_status" class="event-line-2">
              <span v-if="evt.from_status" class="status-pill">
                {{ statusLabelOf(evt.from_status) }}
              </span>
              <el-icon v-if="evt.from_status && evt.to_status" class="arrow"><Right /></el-icon>
              <span v-if="evt.to_status" class="status-pill">
                {{ statusLabelOf(evt.to_status) }}
              </span>
            </div>
            <div v-if="evt.drawing_code || evt.badge_code" class="event-line-3">
              <span v-if="evt.drawing_code">
                <span class="meta-label">图纸</span>
                <span class="meta-value">{{ evt.drawing_code }}</span>
              </span>
              <span v-if="evt.badge_code">
                <span class="meta-label">工牌</span>
                <span class="meta-value">{{ evt.badge_code }}</span>
              </span>
            </div>
            <div v-if="evt.note" class="event-note">备注：{{ evt.note }}</div>
          </div>
        </el-timeline-item>
      </el-timeline>
    </div>
    <el-empty
      v-else
      :description="
        selectedBatchId ? '当前选中批次暂无历史记录' : eventsLoading ? '加载中…' : '暂无历史记录'
      "
    />
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Right, Setting, User } from '@element-plus/icons-vue';
import type { PartEvent } from '@/api/parts';
import { formatDateTime } from '@/utils/date';

const props = defineProps<{
  partId: string;
  events: PartEvent[] | null;
  eventsLoading: boolean;
  statusLabelOf: (s: string | null | undefined) => string;
  eventLabel: (t: string) => string;
  eventTagType: (t: string) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
  /**
   * 2026-09-17 新增：当前选中批次 id（受控）。
   * 非空时按 `event.batch_id === selectedBatchId` 过滤。
   * 2026-07-29 起事件归属批次（PartEvent.batch_id）；events=null 视为未加载，
   * 不参与过滤。
   */
  selectedBatchId?: string | null;
}>();

/**
 * 2026-09-17 新增：按 selectedBatchId 派生的事件列表。
 * - events=null → null（未加载态，与原逻辑一致）
 * - events=[] → []
 * - selectedBatchId=null → 全部事件
 * - selectedBatchId=非空 → 只显示 batch_id 一致的；事件 batch_id=null 的
 *   工单级事件不过滤掉（避免漏 CREATED 等全局事件）。
 */
const displayedEvents = computed<PartEvent[] | null>(() => {
  if (!props.events) return null;
  if (!props.selectedBatchId) return props.events;
  return props.events.filter((e) => e.batch_id === props.selectedBatchId);
});
</script>

<style lang="scss" scoped>
.history-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
  .timeline {
    padding: 8px 0;
  }
  .event-card {
    background: #fff;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .event-line-1 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .worker-name {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-primary);
    font-size: 13px;
  }
  .operator-name {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .event-line-2 {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-regular);
    font-size: 13px;
  }
  .status-pill {
    padding: 1px 8px;
    border-radius: 10px;
    background: #f0f2f5;
    color: var(--text-primary);
    font-size: 12px;
  }
  .arrow {
    color: var(--text-secondary);
  }
  .event-line-3 {
    display: flex;
    gap: 16px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .meta-label {
    margin-right: 4px;
    color: var(--text-secondary);
  }
  .meta-value {
    font-family: 'SF Mono', Menlo, Consolas, monospace;
    color: var(--text-primary);
  }
  .event-note {
    color: var(--text-regular);
    font-size: 13px;
    margin-top: 4px;
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.event-count {
  color: var(--text-secondary);
  font-size: 13px;
}
</style>
