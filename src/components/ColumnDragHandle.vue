<!--
  ColumnDragHandle.vue

  2026-08-27 新增：表头列拖动的手柄图标。
  仅在被 useColumnDrag 绑到的 <thead> 下生效；
  sortablejs 通过 handle='.col-drag-handle' 抓取本元素，
  filter='.col-no-drag' 让 type=selection/index/expand / fixed 列的手柄不被抓取。

  2026-10-10：字号 14px → 12px（本组件是全站 20+ 张表共用的，改动面 = 每张表的每个可拖列）。
  依据：EP 的 `.cell` 是 `white-space: normal` + `overflow-wrap: break-word`，而表头内容 =
  列名 + 手柄 + 排序箭头(24px) + `.cell` 左右 padding(24px) —— 列宽不足时整串折行（用户报的
  「申请人 / 预估交期 表头换行」就是这个）。margin-left 保持 4px（点击热区与列名之间的间距不变）。
  ⚠️ 缩小字号**不是**让那两列不折行的原因：按上式，「申请人」需 42+16+24+24 = 106px、
  「预估交期」需 56+16+24+24 = 120px，两条都超出原宽度（100 / 110），缩 2px 依然超。真正修好
  的是**把那两列加宽**（打印表 100→120 / 110→130，见 views/com/delivery/
  deliveryNotePrintColumnDefs.ts）并给打印表加 nowrap 兜底；缩小字号只是每列再省 2px 的余量。
  代价：点击热区 14px→12px（可接受，表头行高不变）。
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
