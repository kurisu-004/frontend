<!--
  HrScheduleCalendar.vue — 排班日历页壳

  2026-10-19 新建。职责只有**拼装 + 生命周期**（形态照
  `views/wecom/webhooks/WeComWebhooksTab.vue`）：左月历 + 右班次栏 + 拖选浮条 + 班次弹窗。
  全部页面态在 `composables/useScheduleStore.ts`（Pinia setup store，4 不变量见该文件头）。

  ⚠️ **路由 `name: 'HrScheduleCalendar'` 与本文件名必须逐字一致**：MainLayout 的
  `<keep-alive :include>` 按名字匹配，对不上本页就没被缓存（切走再切回已翻到的月份与
  未提交的编辑全部消失，且没有任何报错）。见 `src/router/index.ts` 的同款注记。

  消费 store **不写 .value**（Pinia 深代理自动解包），统一 `store.切片.字段`。

  2026-10-16 改：
    - **删掉「图例 + 本月统计」卡与「正在编辑：X」作用域卡**。作用域标注不会全丢 ——
      点单日弹层（`components/ScheduleDayEditor.vue`）的头部仍写着「正在编辑：X」，那条防误
      操作的护栏保留；删的只是页面级的重复提示与没人消费的本月统计。
    - 「清空本月覆盖」搬进月历工具栏（它是端点 10 在页面上唯一的入口，删卡就等于删功能）。
    - 整块内容**占满 view 高度**：`.main-content`（MainLayout）是 flex 定高 + `overflow: auto`，
      本页逐层放行高度（`.hr-schedule` → `el-row` → 列内 `.schedule-col-inner` → `el-card__body`
      → 月历 / 班次栏），少一层整页就退回 auto 高度、月历只占上半屏。**高度链的 flex 容器放在
      列内那层 div 上而不是 `el-col` 本身**（`el-col` 自带的 `display` 规则与本页 scoped 规则
      特异性打平，靠注入顺序取胜的写法会静默失效，理由见该 div 的样式注释）。
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

    <el-row v-if="canView" :gutter="12" class="schedule-row">
      <el-col :span="16" class="schedule-col">
        <div class="schedule-col-inner">
          <el-card shadow="never" class="schedule-card">
            <ScheduleMonthGrid
              :cells="store.query.cells"
              :calendar-days="store.query.calendarDays"
              :cursor="store.query.cursor"
              :scope-is-shift="store.query.scopeIsShift"
              :scope-label="store.query.scopeLabel"
              :can-edit="canEdit"
              :writing="store.actions.writing"
              :selected-range="store.selection.range"
              @update:selected-range="store.selection.setSelectedRange($event)"
              @select-day="store.dialogs.activeIso = $event"
              @day-apply="onDayApply"
              @day-reset="store.actions.resetDay()"
              @goto-month="store.actions.gotoMonth($event)"
              @goto-today="store.actions.gotoThisMonth()"
              @clear-month-overrides="onClearMonthOverrides"
            />

            <!-- 拖选浮条：只读模式下**不出现**（没得批量可做，给一条死浮条只会让人白点）。
                 草稿（日型 / 名称）也走 store：选区的 owner 在 store 那边，「换选区即复位
                 草稿」这条不变式才写在同一个 owner 里。 -->
            <ScheduleSelectionBar
              v-if="canEdit"
              :range="store.selection.range"
              :count="store.selection.count"
              :scope-is-shift="store.query.scopeIsShift"
              :draft-day-type="store.selection.draftDayType"
              :draft-name="store.selection.draftName"
              :busy="store.actions.writing"
              @draft-day-type="store.selection.setDraftDayType($event)"
              @draft-name="store.selection.setDraftName($event)"
              @apply="onBatchApply"
              @clear="store.actions.clearSelected()"
              @cancel="store.selection.clearSelection()"
            />
          </el-card>
        </div>
      </el-col>

      <el-col :span="8" class="schedule-col">
        <div class="schedule-col-inner">
          <el-card shadow="never" class="schedule-card">
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
        </div>
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

import { onBeforeUnmount, onMounted } from 'vue';
import { ElMessageBox } from 'element-plus';
import ScheduleMonthGrid from './components/ScheduleMonthGrid.vue';
import ScheduleSelectionBar from './components/ScheduleSelectionBar.vue';
import ShiftSidebar from './components/ShiftSidebar.vue';
import ShiftEditDialog from './components/ShiftEditDialog.vue';
import { useScheduleStore } from './composables/useScheduleStore';
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

function onDayApply(dayType: HrDayType, name: string | null): void {
  void store.actions.setDay(dayType, name);
}

function onBatchApply(dayType: HrDayType, name: string | null): void {
  void store.actions.applySelection(dayType, name);
}

/** 「清空本月覆盖」二次确认：它是**按区间批量删**一整个月的覆盖行，手一抖就擦掉一整月。
 *  按钮搬进月历工具栏后本函数原样不动（壳仍是这条写端点的唯一入口）。 */
async function onClearMonthOverrides(): Promise<void> {
  const { year, month } = store.query.cursor;
  try {
    await ElMessageBox.confirm(
      `将清空班次「${store.query.scopeLabel}」在 ${year} 年 ${month} 月的全部覆盖行，之后这些天一律继承全局日历。确认继续？`,
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
/* 2026-10-16 新增 `height: 100%`：`.main-content`（MainLayout）是 flex 定高 + `overflow: auto`
   + `padding: 16px`，所以这里能解析出确定高度，月历才有「把剩余空间铺满」的基准。 */
.hr-schedule {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

.page-alert {
  margin-bottom: 0;
}

/* ⚠️ **逐层放行高度，少一层整页就退回 auto 高度**（月历只占上半屏）：
     `el-row` 拿剩余空间 → 列内这层 div 是 flex 容器 → 卡片与卡片体撑满。
   - `min-height: 0` 不能省：flex 项默认 `min-height: auto`，内容一高就不肯收缩；
   - `el-card__body` 是 Element Plus 的内部结构，**必须 `:deep`** 才能改。 */
.schedule-row {
  flex: 1;
  min-height: 0;
}

/* `el-col` 只是宽度与 gutter 的载体（还要 `min-height: 0`，否则作为 flex 项不肯收缩）。 */
.schedule-col {
  min-height: 0;
}

/* ⚠️ **高度链的 flex 容器是这一层，而不是 `el-col` 本身**：`el-col` 是 Element Plus 的内部
   结构，它自带一条 `display` 规则（gutter 版为 `block`），与本页 scoped 的
   `.schedule-col[data-v-x]` 特异性打平（都是 0,2,0），谁生效纯看样式注入顺序 —— 靠注入
   顺序取胜的写法一旦 Element Plus 改一次默认值就静默失效（月历退回 auto 高度、只占上半屏，
   且不报任何错）。卡片的高度改成从**本页自己的**这层 div 起算：卡片的父级就是它，无条件 flex。 */
.schedule-col-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.schedule-card {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  /* EP 默认 `--el-card-padding: 20px`。42 格月历的纵向预算很紧（见
     `ScheduleDayCell` 的 `.day-badges` 注释），收到 12px 把这点空间还给格子。 */
  --el-card-padding: 12px;
}

.schedule-card :deep(.el-card__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  /* ⚠️ **必须压掉 EP 默认的 `overflow: auto`**：卡片已被钉到视口高，内容一超出格内预算
     （窄视口 + 拖选浮条展开）时，`auto` 会让卡片**内部**长出一条滚动条 —— 与「月历占满
     view 高度、格内裁切」的目标互相打架，页面级滚动由 `.main-content` 的 `overflow: auto`
     与班次栏的 `overflow-y: auto` 承担。 */
  overflow: hidden;
}

/* 批量浮条在月历下方：高度按内容，不许被压扁（月历把剩余空间吃掉即可）。 */
.schedule-card :deep(.selection-bar) {
  flex: 0 0 auto;
}
</style>
