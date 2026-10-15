<!--
  ShiftSidebar.vue — 右侧班次栏（第一项固定「全局日历」）

  2026-10-19 新建。**纯组件**：选中 / 编辑 / 停用都 emit 出去由壳接 store。

  ⚠️ **第一项是「全局日历」且不可删不可停用**：它是作用域 0（端点 1/2/3 那组），不是一个班次
    行 —— 把它混在班次列表里用同一套行内按钮，用户会给它点「停用」然后撞上一个根本不存在的
    行。所以它用锁图标 + 恒可点（不可停用 / 不可编辑），且**恒排第一**（作用域切换是最频繁的
    操作，不该夹在一堆班次中间找）。

  ⚠️ **跨天标注用后端给的 `overflow_minutes`**（不自己按段值算）：它是与 `cross_day` 同源的
    派生值，夜班收在次日 02:00 是「跨天 +2h」，写「+0天」等于没标。口径见
    `utils/dayType.ts::crossDayText`。
-->
<template>
  <div class="shift-sidebar">
    <div class="sidebar-head">
      <span class="sidebar-title">班次</span>
      <el-button v-if="canEdit" type="primary" size="small" @click="emit('create')">
        新建班次
      </el-button>
    </div>

    <!-- 作用域 0：全局日历（恒可点，无行内动作） -->
    <div
      :class="['shift-item', 'is-global', { 'is-active': scope === 'global' }]"
      data-scope-global
      @click="emit('select', 'global')"
    >
      <el-icon class="item-lock"><Lock /></el-icon>
      <div class="item-body">
        <div class="item-name">全局日历</div>
        <div class="item-meta">工作日 / 法定节假日 / 调休</div>
      </div>
    </div>

    <el-empty v-if="shifts.length === 0" description="还没有配置班次" :image-size="60" />

    <div
      v-for="row in shifts"
      :key="row.id"
      :class="['shift-item', { 'is-active': isSelected(row), 'is-inactive': !row.is_active }]"
      @click="emit('select', scopeOf(row))"
    >
      <span
        class="item-color"
        :style="{ backgroundColor: row.color ?? 'var(--primary-lighter)' }"
      />
      <div class="item-body">
        <div class="item-name">
          {{ row.name }}
          <span v-if="!row.is_active" class="item-tag">已停用</span>
        </div>
        <div class="item-meta">
          {{ row.code }}
          <span v-if="crossText(row)" class="item-tag">{{ crossText(row) }}</span>
          <span v-if="dailyText(row)" class="item-tag">{{ dailyText(row) }}</span>
        </div>
      </div>

      <!-- 行内动作：点它们时必须 `stop`，否则冒泡到整行 = 顺手切了作用域。 -->
      <div v-if="canEdit" class="item-actions" @click.stop>
        <el-button link type="primary" size="small" @click="emit('edit', row)">编辑</el-button>
        <el-button
          v-if="row.is_active"
          link
          type="danger"
          size="small"
          :loading="deactivatingRowId === row.id"
          @click="onDeactivate(row)"
        >
          停用
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// views/hr/schedule/components/ShiftSidebar.vue
//
// 2026-10-19 新建：见文件头。

import { Lock } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import type { HrShiftData } from '../hrScheduleSchema';
import type { ScheduleScope } from '../composables/useScheduleQueries';
import { crossDayText, dailyMinutesText } from '../utils/dayType';

const props = defineProps<{
  shifts: HrShiftData[];
  scope: ScheduleScope;
  canEdit: boolean;
  /** 正在停用的行 id（`null` = 无）。 */
  deactivatingRowId: string | null;
}>();

const emit = defineEmits<
  ((e: 'select', scope: ScheduleScope) => void) &
    ((e: 'edit', row: HrShiftData) => void) &
    ((e: 'deactivate', row: HrShiftData) => void) &
    ((e: 'create') => void)
>();

function isSelected(row: HrShiftData): boolean {
  return props.scope !== 'global' && props.scope.id === row.id;
}

function scopeOf(row: HrShiftData): ScheduleScope {
  return { kind: 'shift', id: row.id, name: row.name, color: row.color };
}

function crossText(row: HrShiftData): string {
  return crossDayText(row.overflow_minutes);
}

function dailyText(row: HrShiftData): string {
  return dailyMinutesText(row.daily_minutes);
}

/** 停用走二次确认。⚠️ 停用是**软删**（行还在库里、只是不再被考勤选中），但它会让这个班次
 *  从所有选择项里消失，用户要改回来得先知道它叫什么 —— 所以确认框里把班次名写清楚，
 *  而不是一句「确认删除？」。 */
async function onDeactivate(row: HrShiftData): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `停用班次「${row.name}」后，它将不再出现在新建考勤的选择项里（班次与日历数据仍保留）。确认停用？`,
      '确认停用班次',
      {
        type: 'warning',
        confirmButtonText: '确认停用',
        cancelButtonText: '取消',
      },
    );
  } catch {
    return; // 用户取消
  }
  emit('deactivate', row);
}
</script>

<style lang="scss" scoped>
.shift-sidebar {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.shift-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--white);
  cursor: pointer;
}

.shift-item:hover {
  border-color: var(--primary-lighter);
}

.shift-item.is-active {
  border-color: var(--primary-color);
  background: var(--primary-bg);
}

.shift-item.is-inactive {
  opacity: 0.55;
}

.item-lock {
  color: var(--text-secondary);
}

.item-color {
  flex: 0 0 auto;
  width: 10px;
  height: 28px;
  border-radius: 2px;
}

.item-body {
  flex: 1 1 auto;
  min-width: 0;
}

.item-name {
  font-size: 13px;
  color: var(--text-primary);
}

.item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.item-tag {
  padding: 0 4px;
  border-radius: 2px;
  background: #f0f2f5;
  font-size: 11px;
  line-height: 16px;
}

.item-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}
</style>
