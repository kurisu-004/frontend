<!--
  FactoryRealtimeStrip.vue
  2026-09-29 新增：dashboard 底部「工厂实时态」chip strip。
  2026-09-30 Phase 2 followup #2：worker groups 按 PAGE_SIZE=4 一组切片成 pages，
  groups.length > 4 时套 <el-carousel>（8s 翻页 + hover 暂停 + 箭头手动切页）；
  groups.length ≤ 4 时退化为 flex-wrap 排（占满 20% 高度，无需轮播）。
  el-carousel CSS 由 main.ts 手动 import theme-chalk（unplugin resolver 只扫
  <template>，carousel-item CSS 由 carousel.css 携带）。

  数据来源：snapshot.in_process（dashboard 大屏快照的 in_process 切片，原
  DashboardView.vue:139-151 已有 workerGroups computed 派生逻辑，本组件下沉到
  内部 computed）。

  视觉：
    - 按 current_holder_id / worker_name 分组
    - 每组「工人姓名 + 该工人持有的流水号 chips」
    - 紧急 chip 底色 #fde2e2 + 红字（沿旧 .worker-chip.urgent 约定）
    - 非 SHELF_ACCOUNT 账号可点 chip 跳详情；emit item-click(partId)
-->
<template>
  <div class="strip-card">
    <div class="strip-head">
      <span class="strip-title">
        <el-icon><Tools /></el-icon>
        <span>正在加工</span>
      </span>
      <span class="strip-count">{{ items.length }} 件</span>
    </div>
    <div class="strip-body">
      <div v-if="groups.length === 0" class="strip-empty">暂无正在加工的零件</div>
      <el-carousel
        v-else-if="groups.length > PAGE_SIZE"
        class="strip-carousel"
        height="100%"
        :interval="8000"
        arrow="always"
        :autoplay="true"
        :pause-on-hover="true"
        indicator-position="none"
      >
        <el-carousel-item v-for="(page, idx) in pagedGroups" :key="idx">
          <div class="strip-page">
            <div v-for="g in page" :key="g.key" class="worker-group">
              <span class="worker-name">{{ g.worker_name ?? '—' }}</span>
              <div class="worker-chips">
                <span
                  v-for="it in g.items"
                  :key="it.id"
                  :class="['worker-chip', { urgent: it.is_urgent, clickable: canOpenDetail }]"
                  :title="canOpenDetail ? '查看详情' : ''"
                  @click="canOpenDetail && emit('itemClick', it.id)"
                >
                  {{ it.serial_no ?? '—' }}
                </span>
              </div>
            </div>
          </div>
        </el-carousel-item>
      </el-carousel>
      <!-- 退化：worker group ≤ 4 个时不轮播，直接 flex-wrap 排 -->
      <div v-else class="strip-wrap">
        <div v-for="g in groups" :key="g.key" class="worker-group">
          <span class="worker-name">{{ g.worker_name ?? '—' }}</span>
          <div class="worker-chips">
            <span
              v-for="it in g.items"
              :key="it.id"
              :class="['worker-chip', { urgent: it.is_urgent, clickable: canOpenDetail }]"
              :title="canOpenDetail ? '查看详情' : ''"
              @click="canOpenDetail && emit('itemClick', it.id)"
            >
              {{ it.serial_no ?? '—' }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 2026-09-29 新增 + 2026-09-30 Phase 2 followup #2：dashboard「工厂实时态」chip strip
// 展示壳。worker groups 按 PAGE_SIZE=4 一组切片成 pages，>4 套 <el-carousel>，
// ≤4 退化为 flex-wrap。
//
// 沿旧 DashboardView.vue:139-151 的 workerGroups computed 派生逻辑（按
// current_holder_id / worker_name 分组），下沉到组件内部 computed。
//
// emit item-click(partId) 给父组件跳详情；权限守门（canOpenDetail）由父组件
// 计算并通过 props 传入；本组件自身不 import usePermissions（沿 §composition
// 边界 —— 权限判断走 usePermissions 已集中暴露 computed 模式）。

import { computed } from 'vue';
import { Tools } from '@element-plus/icons-vue';
import type { DashboardItemData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

interface WorkerGroup {
  key: string;
  worker_name: string | null;
  items: DashboardItemData[];
}

const props = defineProps<{
  items: DashboardItemData[];
  /** 是否允许点 chip 跳详情（SHELF_ACCOUNT 默认 false） */
  canOpenDetail: boolean;
}>();

const emit = defineEmits<(e: 'itemClick', partId: string) => void>();

/** 2026-09-29 新增：按 current_holder_id / worker_name 分组。 */
const groups = computed<WorkerGroup[]>(() => {
  const map = new Map<string, WorkerGroup>();
  for (const p of props.items) {
    const key = String(p.current_holder_id ?? p.worker_name ?? 'unknown');
    const existing = map.get(key);
    if (existing) {
      existing.items.push(p);
    } else {
      map.set(key, { key, worker_name: p.worker_name ?? null, items: [p] });
    }
  }
  return Array.from(map.values());
});

/** 2026-09-30 Phase 2 followup #2：worker groups 按 PAGE_SIZE=4 一组切片成 pages；
 *  groups.length ≤ 4 时退化为直接 flex-wrap 排，不进 carousel。 */
const PAGE_SIZE = 4;
const pagedGroups = computed<WorkerGroup[][]>(() => {
  const out: WorkerGroup[][] = [];
  for (let i = 0; i < groups.value.length; i += PAGE_SIZE) {
    out.push(groups.value.slice(i, i + PAGE_SIZE));
  }
  return out;
});
</script>

<style lang="scss" scoped>
.strip-card {
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  // 2026-09-30 Phase 2 followup #2：display:flex + flex-direction:column 让 strip-head /
  // strip-body 高度可被外层 flex chain 切割；min-height: 0 阻止 flex item 默认
  // min-content 撑破父容器；overflow: hidden 兜底 carousel 内容溢出。
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.strip-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid #eee;
  background: #fafbfc;
  flex-shrink: 0;
}
.strip-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}
.strip-count {
  font-size: 12px;
  color: var(--primary-color);
  background: var(--el-color-primary-light-9);
  padding: 1px 8px;
  border-radius: 10px;
}
// 2026-09-30 Phase 2 followup #2：strip-body 取消自身 flex-wrap，改为 carousel / wrap
// 内层布局；padding: 0 让 carousel 自行控制内容 padding（carousel-item 默认带 2px）。
.strip-body {
  flex: 1;
  min-height: 0;
  padding: 0;
}
.strip-carousel {
  width: 100%;
  height: 100%;
}
.strip-page {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
  padding: 10px 14px;
  box-sizing: border-box;
  height: 100%;
}
.strip-wrap {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
  padding: 10px 14px;
}
.strip-empty {
  width: 100%;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 20px 0;
}
.worker-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #f5f7fa;
  border-radius: 6px;
}
.worker-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  white-space: nowrap;
}
.worker-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.worker-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  background: #fff;
  border-radius: 4px;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  &.urgent {
    background: #fde2e2;
    color: #f56c6c;
  }
  &.clickable {
    cursor: pointer;
  }
  &.clickable:hover {
    text-decoration: underline;
  }
}
</style>
