<!--
  PartHistoryCard.vue

  历史记录卡（PartDetail 第 2 张卡）：
  - el-timeline 渲染 events
  - 加载逻辑由 usePartDetail.fetchEvents() 提供；本组件 fetch onMounted/watch partId
  - 纯展示，无 dialog / form
-->
<template>
  <el-card shadow="never" class="history-card" v-loading="eventsLoading">
    <template #header>
      <div class="card-header">
        <span class="card-title">历史记录</span>
        <span v-if="events" class="event-count">共 {{ events.length }} 条</span>
      </div>
    </template>

    <div v-if="events && events.length > 0" class="timeline">
      <el-timeline>
        <el-timeline-item
          v-for="evt in events"
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
              <span v-if="evt.quantity != null" class="muted">× {{ evt.quantity }}</span>
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
    <el-empty v-else description="暂无历史记录" />
  </el-card>
</template>

<script setup lang="ts">
import { Right, Setting, User } from '@element-plus/icons-vue'
import type { PartEvent } from '@/api/parts'
import { formatDateTime } from '@/utils/date'

defineProps<{
  partId: string
  events: PartEvent[] | null
  eventsLoading: boolean
  statusLabelOf: (s: string | null | undefined) => string
  eventLabel: (t: string) => string
  eventTagType: (t: string) => 'primary' | 'success' | 'warning' | 'info' | 'danger'
}>()
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
