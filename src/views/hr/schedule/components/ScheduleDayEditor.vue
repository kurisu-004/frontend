<!--
  ScheduleDayEditor.vue — 点单日改日型的弹层（el-popover 包住整个格子）

  2026-10-19 新建。**纯组件**：表单草稿与提交都是组件内的局部态，提交从 emit 出（壳 / 月历
  接 store），所以本组件既不首调 store 也不发请求。

  为什么用 `el-popover` 包格子而不是另开 `el-dialog`：月历是**密集格子**，逐格开弹窗会让
  「改完一个再改下一个」变成来回点两次按钮；popover 就地展开，改完点别处收起，批量改日型
  的节奏才连得起来（内联用法照 `views/repair/RepairReceive.vue` 的筛选弹层）。

  ⚠️ **顶部必须显式标注当前作用域**：全局日历与班次日历的动作集不同（全局是「恢复默认」、
    班次是「恢复继承全局」+ 停工 / 复工），不标出来用户很容易把「给这个班次放一天假」误读成
    「给全厂放一天假」——两个动作写的是不同的表。
-->
<template>
  <el-popover
    v-model:visible="visible"
    trigger="click"
    placement="bottom"
    :width="300"
    popper-class="schedule-day-editor"
    @show="syncDraft"
  >
    <template #reference>
      <slot />
    </template>

    <!-- ⚠️ 作用域标注（见文件头）：两个作用域的动作不同，不标会误操作。 -->
    <div class="editor-head">
      <span class="editor-date">{{ iso }}</span>
      <span class="editor-scope">正在编辑：{{ scopeIsShift ? scopeLabel : '全局日历' }}</span>
    </div>

    <!-- 只读（CLERK 无 `hr.schedule.manage`）：整层换成只读展示，不给「看着能点其实提交
         会被 403」的动作。 -->
    <template v-if="!canEdit">
      <el-descriptions :column="1" size="small" border>
        <el-descriptions-item label="当前日型">{{ currentTypeLabel }}</el-descriptions-item>
        <el-descriptions-item v-if="scopeIsShift" label="全局日型">
          {{ globalTypeLabel }}
        </el-descriptions-item>
        <el-descriptions-item v-if="scopeIsShift" label="是否覆盖">
          {{ day?.isOverride ? '本班次已覆盖' : '继承全局日历' }}
        </el-descriptions-item>
        <el-descriptions-item v-if="day?.name" label="名称">{{ day.name }}</el-descriptions-item>
      </el-descriptions>
      <div class="editor-hint">只读模式：没有排班管理权限，不能修改日历</div>
    </template>

    <template v-else>
      <el-form label-width="0" @submit.prevent>
        <el-form-item>
          <el-radio-group v-model="draftType" class="day-type-picker">
            <el-radio-button v-for="opt in HR_DAY_TYPE_OPTIONS" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>

        <!-- 名称只在两档要求填时启用：`CUSTOM_LEAVE` 必填（后端 21907），`STATUTORY_HOLIDAY`
             填了有用（国庆 / 春节）。其余档禁用而不是隐藏 —— 保持栅格稳定，用户也不会以为
             「换个日型名称就跟着清掉了」。 -->
        <el-form-item>
          <el-input
            v-model="draftName"
            :disabled="!nameEnabled"
            :placeholder="nameEnabled ? '如「春节」/「设备检修」' : '仅自定义休息日需要名称'"
            maxlength="30"
            show-word-limit
          />
        </el-form-item>

        <template v-if="scopeIsShift">
          <div class="editor-actions">
            <el-button size="small" :disabled="!day?.isOverride" @click="onReset">
              恢复继承全局
            </el-button>
            <el-button size="small" @click="quick('REST_DAY')">本日停工</el-button>
            <el-button size="small" @click="quick('WORKDAY')">本日复工</el-button>
          </div>
          <div class="editor-hint">
            {{
              day?.isOverride
                ? '本班次在这天有覆盖行，「恢复继承全局」会删掉它并落回全局日历那天'
                : '当前继承自全局日历，无需覆盖；要改就在上面直接选日型'
            }}
          </div>
        </template>

        <template v-else>
          <div class="editor-actions">
            <el-button size="small" :disabled="day?.derived === true" @click="onReset">
              恢复默认（清除此行）
            </el-button>
          </div>
          <div class="editor-hint">
            {{
              day?.derived === true
                ? '本就是按星期兜底的，没有显式行可清除'
                : '清除后这天回到「按星期兜底」的默认日型（周一至周五工作日、周六日休息日）'
            }}
          </div>
        </template>

        <div class="editor-footer">
          <el-button size="small" @click="visible = false">取消</el-button>
          <el-button size="small" type="primary" :loading="writing" @click="onApply">
            应用
          </el-button>
        </div>
      </el-form>
    </template>
  </el-popover>
</template>

<script setup lang="ts">
// views/hr/schedule/components/ScheduleDayEditor.vue
//
// 2026-10-19 新建：见文件头。

import { computed, ref } from 'vue';
import type { HrDayType } from '@/types/hr';
import { HR_DAY_TYPE_OPTIONS, dayTypeLabel, dayTypeNeedsName } from '../utils/dayType';
import type { ScheduleDayView } from '../composables/useScheduleStore';

const props = defineProps<{
  /** 这一天的归一化视图对象（`null` = 后端没返这一天）。 */
  day: ScheduleDayView | null;
  /** 这一天的 `'YYYY-MM-DD'`（后端没返数据时也要显示，所以与 `day` 分开给）。 */
  iso: string;
  /** 当前作用域是不是班次（决定动作集与文案）。 */
  scopeIsShift: boolean;
  /** 当前作用域名（班次时显示班次名）。 */
  scopeLabel: string;
  /** 有没有 `hr.schedule.manage`（false = 整层只读）。 */
  canEdit: boolean;
  /** 写端点忙态（透传给「应用」按钮的 loading）。 */
  writing: boolean;
}>();

// emits 用**函数类型**（交叉）而不是类型字面量：仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红。
const emit = defineEmits<
  ((e: 'apply', dayType: HrDayType, name: string | null) => void) &
    ((e: 'open') => void) &
    ((e: 'reset') => void)
>();

const visible = ref(false);
const draftType = ref<HrDayType>('WORKDAY');
const draftName = ref('');

/** 弹层打开时把当前值灌进草稿（不灌的话上一次编辑的草稿会留给下一次），
 *  并通知月历「这一天是当前编辑对象」—— store 的 `activeIso` 由那一侧写。 */
function syncDraft(): void {
  draftType.value = props.day?.dayType ?? 'WORKDAY';
  draftName.value = props.day?.name ?? '';
  emit('open');
}

const currentTypeLabel = computed(() =>
  props.day ? dayTypeLabel(props.day.dayType) : '（无数据）',
);
const globalTypeLabel = computed(() =>
  props.day ? dayTypeLabel(props.day.globalDayType) : '（无数据）',
);
/** 名称输入只在需要它的两档启用（见模板注释）。 */
const nameEnabled = computed(() => dayTypeNeedsName(draftType.value));

function onApply(): void {
  emit('apply', draftType.value, nameEnabled.value ? draftName.value.trim() : null);
  visible.value = false;
}

/** 停工 / 复工快捷语义：直接给一档日型，不经过草稿。 */
function quick(dayType: HrDayType): void {
  emit('apply', dayType, null);
  visible.value = false;
}

function onReset(): void {
  emit('reset');
  visible.value = false;
}
</script>

<style lang="scss" scoped>
.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.editor-date {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.editor-scope {
  padding: 0 6px;
  border-radius: 2px;
  background: var(--primary-bg);
  color: var(--primary-color);
  font-size: 12px;
}

.day-type-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.day-type-picker :deep(.el-radio-button) {
  margin-right: 0;
}

.editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}

.editor-hint {
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.editor-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
