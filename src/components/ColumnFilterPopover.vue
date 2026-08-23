<!--
  ColumnFilterPopover.vue

  2026-08-22 从 PartsList.vue 抽出：表头 popover 通用外壳。
  替代 PartsList 中 10 份复制粘贴的 popover 头部结构（header + Filter 图标 + 弹层 + 重置/确定行）。

  用法（表头）：
    <ColumnFilterPopover
      :label="'序列号'"
      :active="serialNoFilter.active.value"
      :visible="serialNoFilter.visible.value"
      @update:visible="serialNoFilter.visible.value = $event"
      @show="serialNoFilter.sync()"
      @confirm="serialNoFilter.confirm()"
      @reset="serialNoFilter.reset()"
    >
      <el-input v-model="serialNoFilter.draft.value" ... />
    </ColumnFilterPopover>

  Props:
    - label       string              表头文本
    - active      boolean?            是否激活（默认 false；激活态变蓝加粗）
    - count       number?             选中数（默认 0；>0 时显示为 `${label}(${count})`）
    - width       number?             popover 宽度（默认 280）
    - hint        string?             弹层顶部灰色提示（可选）
    - placement   string?             popover 位置（默认 'bottom-start'）
    - visible     boolean?            v-model:visible；外部可程序化打开/关闭

  Emits:
    - update:visible
    - show        popover 打开时触发（外部同步 draft）
    - confirm     点「确定」时触发
    - reset       点「重置」时触发
-->
<template>
  <span class="cfp-header" :class="{ 'is-active': active }">
    <span>{{ headerText }}</span>
    <el-popover
      :width="width"
      :placement="placement"
      trigger="click"
      :show-arrow="false"
      :visible="visible"
      @update:visible="emit('update:visible', $event)"
      @show="emit('show')"
    >
      <template #reference>
        <el-icon class="cfp-icon" :class="{ active }">
          <Filter />
        </el-icon>
      </template>
      <div v-if="hint" class="cfp-hint">{{ hint }}</div>
      <slot />
      <div class="cfp-actions">
        <el-button size="small" link @click="emit('reset')">重置</el-button>
        <el-button size="small" type="primary" @click="emit('confirm')">确定</el-button>
      </div>
    </el-popover>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Filter } from '@element-plus/icons-vue'

type PopoverPlacement =
  | 'top'
  | 'top-start'
  | 'top-end'
  | 'bottom'
  | 'bottom-start'
  | 'bottom-end'
  | 'left'
  | 'left-start'
  | 'left-end'
  | 'right'
  | 'right-start'
  | 'right-end'

interface Props {
  label: string
  active?: boolean
  count?: number
  width?: number
  hint?: string
  placement?: PopoverPlacement
  visible?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  active: false,
  count: 0,
  width: 280,
  hint: '',
  placement: 'bottom-start',
  visible: undefined,
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  show: []
  confirm: []
  reset: []
}>()

const headerText = computed(() =>
  props.count > 0 ? `${props.label}(${props.count})` : props.label,
)
</script>

<style lang="scss" scoped>
// 2026-08-22：从 PartsList.vue 的 .header-cell 抽出，类名改为 .cfp-header
// 激活态与 .cfp-icon.active / .cfp-icon.active::after 共享视觉信号
// （蓝字加粗 + 蓝图标 + 右上角蓝点）
.cfp-header {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  justify-content: center;
  // 2026-07-31：激活态列标题同步变蓝加粗（与 cfp-icon.active 共享视觉信号）
  &.is-active {
    color: var(--primary-color);
    font-weight: 600;
  }
}

// 2026-08-22：从 PartsList.vue 的 .filter-icon 抽出，类名改为 .cfp-icon
// 右上角 ::after 圆点用作「已激活筛选」第三重视觉信号
.cfp-icon {
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
  position: relative; // 为 ::after 圆点做定位锚点
  &.active {
    color: var(--primary-color);
  }
  // 2026-07-31：激活态右上角加蓝圆点（与图标颜色、文字加粗三重信号）
  &.active::after {
    content: '';
    position: absolute;
    top: -2px;
    right: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--primary-color);
  }
}

// 2026-08-22：从 PartsList.vue 的 .filter-actions 抽出，类名改为 .cfp-actions
// 重置/确定按钮行；border-top 与弹层内容分隔
.cfp-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border-color-lighter);
  padding-top: 8px;
}

// 2026-08-22：弹层顶部灰色提示文案；与 PartList 原 inline style 一致（12px / 6px margin / 二级文字色）
.cfp-hint {
  margin-bottom: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
