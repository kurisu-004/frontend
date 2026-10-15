<!--
  HrScheduleCalendar.vue — 排班日历页壳

  2026-10-19 新建。职责只有**拼装 + 生命周期**（形态照
  `views/wecom/webhooks/WeComWebhooksTab.vue`）：顶部图例与本月统计 + 作用域提示 + 左月历 +
  右班次栏 + 拖选浮条 + 班次弹窗。全部页面态在
  `composables/useScheduleStore.ts`（Pinia setup store，4 不变量见该文件头）。

  ⚠️ **路由 `name: 'HrScheduleCalendar'` 与本文件名必须逐字一致**：MainLayout 的
  `<keep-alive :include>` 按名字匹配，对不上本页就没被缓存（切走再切回已翻到的月份与
  未提交的编辑全部消失，且没有任何报错）。见 `src/router/index.ts` 的同款注记。

  消费 store **不写 .value**（Pinia 深代理自动解包），统一 `store.切片.字段`。
-->
<template>
  <div v-loading="store.query.loading" class="hr-schedule">
    <el-alert
      v-if="!canView"
      class="page-alert"
      type="warning"
      show-icon
      :closable="false"
      title="没有排班日历的查看权限"
      description="本页需要 hr.view 权限点；请让管理员在「角色权限」里授予后再进入。"
    />

    <el-alert
      v-if="store.query.listErrorText"
      class="page-alert"
      type="error"
      show-icon
      :closable="false"
      :title="store.query.listErrorText"
    />

    <!-- 图例 + 本月统计 -->
    <el-card shadow="never" class="legend-card">
      <div class="legend-row">
        <span class="legend-title">图例</span>
        <span
          v-for="opt in HR_DAY_TYPE_OPTIONS"
          :key="opt.value"
          :class="['legend-item', `dt-${opt.colorKey}`]"
        >
          {{ opt.label }}{{ opt.workday ? '' : '（休）' }}
        </span>
      </div>
      <div class="stats-row">
        <span class="stats-title">本月</span>
        <span class="stats-item"
          >工作日 <b>{{ store.query.stats.workdays }}</b> 天</span
        >
        <span class="stats-item"
          >休息日 <b>{{ store.query.stats.restDays }}</b> 天</span
        >
        <span class="stats-item"
          >覆盖 <b>{{ store.query.stats.overrides }}</b> 天</span
        >
        <span class="stats-item"
          >加班 <b>{{ store.query.stats.makeupWorkdays }}</b> 天</span
        >
      </div>
    </el-card>

    <!-- 作用域提示 + 「清空本月覆盖」。⚠️ 作用域必须显式写在页面上：月历与批量动作的行为
         随它变（全局是「恢复默认」，班次是「恢复继承全局」+ 清空覆盖）。 -->
    <el-card shadow="never" class="scope-card">
      <div class="scope-row">
        <el-tag type="primary" effect="dark">正在编辑：{{ store.query.scopeLabel }}</el-tag>
        <span class="scope-hint">
          {{
            store.query.scopeIsShift
              ? '月历显示该班次的最终日型（覆盖优先），色带取班次色'
              : '月历显示全局日型；拖选一段可批量改，点单格改单日'
          }}
        </span>
        <el-button
          v-if="store.query.scopeIsShift && canEdit"
          size="small"
          type="danger"
          plain
          :loading="store.actions.writing"
          @click="onClearMonthOverrides"
        >
          清空本月覆盖
        </el-button>
      </div>
    </el-card>

    <el-row v-if="canView" :gutter="12">
      <el-col :span="16">
        <el-card shadow="never">
          <ScheduleMonthGrid
            :cells="store.query.cells"
            :calendar-days="store.query.calendarDays"
            :cursor="store.query.cursor"
            :scope-is-shift="store.query.scopeIsShift"
            :scope-label="store.query.scopeLabel"
            :shift-color="scopeColor"
            :can-edit="canEdit"
            :writing="store.actions.writing"
            :selected-range="store.selection.range"
            @update:selected-range="store.selection.setSelectedRange($event)"
            @select-day="store.dialogs.activeIso = $event"
            @day-apply="onDayApply"
            @day-reset="store.actions.resetDay()"
            @goto-month="store.actions.gotoMonth($event)"
            @goto-today="store.actions.gotoThisMonth()"
          />

          <!-- 拖选浮条：只读模式下**不出现**（没得批量可做，给一条死浮条只会让人白点）。 -->
          <ScheduleSelectionBar
            v-if="canEdit"
            :range="store.selection.range"
            :count="store.selection.count"
            :scope-is-shift="store.query.scopeIsShift"
            :busy="store.actions.writing"
            @apply="onBatchApply"
            @clear="store.actions.clearSelected()"
            @cancel="store.selection.clearSelection()"
          />
        </el-card>
      </el-col>

      <el-col :span="8">
        <el-card shadow="never">
          <ShiftSidebar
            :shifts="store.query.shifts"
            :scope="store.query.scope"
            :can-edit="canEdit"
            :deactivating-row-id="store.actions.deactivatingRowId"
            @select="store.actions.selectScope($event)"
            @edit="store.dialogs.openEditShift($event)"
            @deactivate="store.actions.deactivate($event)"
            @create="store.dialogs.openCreateShift()"
          />
        </el-card>
      </el-col>
    </el-row>

    <ShiftEditDialog
      :model-value="store.dialogs.shiftVisible"
      :mode="store.dialogs.shiftMode"
      :form="store.dialogs.shiftForm"
      :errors="store.dialogs.shiftFieldErrors"
      :loading="store.actions.writing"
      :can-edit="canEdit"
      @cancel="store.dialogs.closeShiftDialog()"
      @patch="onShiftFormPatch"
      @confirm="store.actions.submitShift()"
    />
  </div>
</template>

<script setup lang="ts">
// views/hr/schedule/HrScheduleCalendar.vue
//
// 2026-10-19 新建：见文件头。

import { computed, onBeforeUnmount, onMounted } from 'vue';
import { ElMessageBox } from 'element-plus';
import ScheduleMonthGrid from './components/ScheduleMonthGrid.vue';
import ScheduleSelectionBar from './components/ScheduleSelectionBar.vue';
import ShiftSidebar from './components/ShiftSidebar.vue';
import ShiftEditDialog from './components/ShiftEditDialog.vue';
import { useScheduleStore } from './composables/useScheduleStore';
import { HR_DAY_TYPE_OPTIONS } from './utils/dayType';
import { canEditSchedule, canViewSchedule } from '@/utils/hrPermissions';
import type { HrDayType } from '@/types/hr';
import type { ShiftFormModel } from './hrScheduleSchema';

// 不变量 #1：壳 setup 顶部首调 store（$dispose 绑到首个创建它的组件）。
const store = useScheduleStore();

/** 按钮级闸门：MANAGER 写、CLERK 只读（判据是权限点，见 `utils/hrPermissions.ts`）。
 *  ⚠️ 两条闸门各调一次：`canViewSchedule()` 为假说明用户连数据都不该看到（路由守卫本该
 *  拦住，这里再兜一层：不渲染月历与班次栏）。 */
const canEdit = canEditSchedule();
const canView = canViewSchedule();

/** 当前班次作用域的色带颜色（全局作用域无班次色，给 null 走默认）。 */
const scopeColor = computed(() =>
  store.query.scope === 'global' ? null : store.query.scope.color,
);

function onDayApply(dayType: HrDayType, name: string | null): void {
  void store.actions.setDay(dayType, name);
}

function onBatchApply(dayType: HrDayType, name: string | null): void {
  void store.actions.applySelection(dayType, name);
}

/** 「清空本月覆盖」二次确认：它是**按区间批量删**一整个月的覆盖行，手一抖就擦掉一整月。 */
async function onClearMonthOverrides(): Promise<void> {
  const { year, month } = store.query.cursor;
  try {
    await ElMessageBox.confirm(
      `将清空班次「${store.query.scopeLabel}」在 ${year} 年 ${month} 月的**全部覆盖行**，之后这些天一律继承全局日历。确认继续？`,
      '确认清空本月覆盖',
      { type: 'warning', confirmButtonText: '确认清空', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  void store.actions.clearMonthOverrides();
}

/** 弹窗里某个字段变了 → 写回 store 的同一个 reactive 表单对象（整体 Object.assign，不能换
 *  引用：store 的 `validateShiftForm` 闭包持有的是那一个）。 */
function onShiftFormPatch(next: Partial<ShiftFormModel>): void {
  Object.assign(store.dialogs.shiftForm, next);
}

onMounted(() => {
  // 开 enabled 闸门 → 两条 query 首屏 fetch（班次栏 + 当月日历）。
  store.query.openGate();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开本页时销毁，下次进入重建 fresh 状态（否则翻到的月份、
  // 选中的作用域、填了一半的班次弹窗会泄漏到下次进入）。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.hr-schedule {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.page-alert {
  margin-bottom: 0;
}

.legend-row,
.stats-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.stats-row {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
  font-size: 13px;
  color: var(--text-regular);
}

.legend-title,
.stats-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

/* 图例色板：与 `ScheduleDayCell.vue` 的 `.dt-*` 同六个键，两处必须同改。 */
.legend-item {
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 12px;
  line-height: 18px;
}

.dt-workday {
  background: rgba(30, 77, 139, 0.12);
  color: #1e4d8b;
}

.dt-makeup-work {
  background: rgba(42, 108, 184, 0.14);
  color: #2c6cb8;
}

.dt-rest {
  background: #f0f2f5;
  color: #6b7280;
}

.dt-holiday {
  background: rgba(214, 122, 26, 0.16);
  color: #b45309;
}

.dt-makeup-rest {
  background: rgba(120, 113, 108, 0.16);
  color: #78716c;
}

.dt-custom {
  background: rgba(103, 58, 183, 0.14);
  color: #673ab7;
}

.scope-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.scope-hint {
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
