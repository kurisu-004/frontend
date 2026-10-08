<!--
  ColumnDragHandle.vue

  2026-08-27 新增：表头列拖动的手柄图标。
  仅在被 useColumnDrag 绑到的 <thead> 下生效；
  sortablejs 通过 handle='.col-drag-handle' 抓取本元素，
  filter='.col-no-drag' 让 type=selection/index/expand / fixed 列的手柄不被抓取。

  2026-10-10：字号 14px → 12px（本组件是全站 20+ 张表共用的，改动面 = 每张表的每个可拖列）。
  依据：EP 的 `.cell` 是 `white-space: normal` + `overflow-wrap: break-word`，而表头内容 =
  列名 + 手柄 + 排序箭头(24px) + `.cell` 左右 padding(24px) —— 列宽不足时整串折行（用户报的
  「申请人 / 预估交期 表头换行」就是这个）。手柄每列省 2px 看着不多，但 4 个字的中文列名本身
  就占 ~56px，2px 恰好够把「预估交期」推回不折行的边界。margin-left 保持 4px（点击热区与
  列名之间的间距不变）。
-->
<template>
  <el-icon class="col-drag-handle" :title="title ?? '拖动列'">
    <Rank />
  </el-icon>
</template>

<script setup lang="ts">
import { Rank } from '@element-plus/icons-vue';

withDefaults(defineProps<{ title?: string }>(), { title: '拖动列' });
</script>

<style lang="scss" scoped>
.col-drag-handle {
  cursor: grab;
  margin-left: 4px;
  color: var(--text-secondary);
  vertical-align: middle;
  font-size: 12px;

  &:hover {
    color: var(--el-color-primary);
  }
  &:active {
    cursor: grabbing;
  }
}
</style>
