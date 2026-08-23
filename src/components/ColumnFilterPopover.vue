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
        <!--
          2026-08-23 改：触发器对齐 EP 原生 .el-table__column-filter-trigger：
          用 ArrowDown/ArrowUp 替代原先的 Filter 漏斗；激活态不再画蓝圆点，
          整格 is-active 变 primary 色（图标 color 继承父级）。
        -->
        <button
          type="button"
          class="cfp-trigger el-table__column-filter-trigger"
          :aria-label="visible ? '收起筛选' : '展开筛选'"
        >
          <el-icon>
            <ArrowUp v-if="visible" />
            <ArrowDown v-else />
          </el-icon>
        </button>
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
import { ArrowDown, ArrowUp } from '@element-plus/icons-vue'

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

// 2026-08-23：触发器对齐 EP 原生样式（ArrowDown/ArrowUp + .el-table__column-filter-trigger 全局 button 重置）。
// 大部分 button reset + focus-visible 轮廓由 EP theme-chalk 的 .el-table__column-filter-trigger 全局规则提供，
// scoped 这层只需保证图标 color 继承父级（激活态由 .cfp-header.is-active 把整格变 primary）。
.cfp-trigger {
  color: inherit;
  font-size: 14px;
  line-height: 1;
  vertical-align: middle;
  // 防止 scoped 默认 [data-v-xxx] 选择器把 EP 全局 .el-table__column-filter-trigger 的 padding/margin reset 覆盖
  :deep(.el-icon) {
    color: inherit;
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
