<!--
  ColumnDragHandle.vue

  2026-08-27 新增：表头列拖动的手柄图标。
  仅在被 useColumnDrag 绑到的 <thead> 下生效；
  sortablejs 通过 handle='.col-drag-handle' 抓取本元素，
  filter='.col-no-drag' 让 type=selection/index/expand / fixed 列的手柄不被抓取。
-->
<template>
  <el-icon class="col-drag-handle" :title="title ?? '拖动列'">
    <Rank />
  </el-icon>
</template>

<script setup lang="ts">
import { Rank } from '@element-plus/icons-vue'

withDefaults(defineProps<{ title?: string }>(), { title: '拖动列' })
</script>

<style lang="scss" scoped>
.col-drag-handle {
  cursor: grab;
  margin-left: 4px;
  color: var(--text-secondary);
  vertical-align: middle;
  font-size: 14px;

  &:hover { color: var(--el-color-primary); }
  &:active { cursor: grabbing; }
}
</style>
