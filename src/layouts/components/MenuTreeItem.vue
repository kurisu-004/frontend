<template>
  <!-- 叶子节点：有 path 且无 children → <el-menu-item> -->
  <el-menu-item v-if="isLeaf" :index="menu.path!">
    <el-icon v-if="iconComp"><component :is="iconComp" /></el-icon>
    <template #title>{{ menu.title }}</template>
  </el-menu-item>

  <!-- 分组节点：path 为 NULL 或有 children → <el-sub-menu> -->
  <el-sub-menu v-else :index="menu.code">
    <template #title>
      <el-icon v-if="iconComp"><component :is="iconComp" /></el-icon>
      <span>{{ menu.title }}</span>
    </template>
    <MenuTreeItem
      v-for="child in menu.children"
      :key="child.id"
      :menu="child"
    />
  </el-sub-menu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  House,
  Box,
  CircleCheck,
  Tools,
  Cpu,
  OfficeBuilding,
  Document,
  Promotion,
  User,
  Key,
  Platform,
  DataAnalysis,
  Connection,
  // 2026-08-22：补全侧栏 6 个缺失图标（订单管理/新建零件/送货/
  // 账号管理/设置/工序管理）。命名导入保持显式，tree-shaking 不退。
  Tickets,
  Plus,
  Van,
  Setting,
  Operation,
  // 2026-08-26：新增 users_list 用的 List；移除生产 DB 不再用的 9 个
  // （Lock / Money / CollectionTag / UserFilled / Postcard / Search /
  //  PriceTag / TakeawayBox / Avatar）—— 见 adminMenus fixture 同步提交。
  List,
} from '@element-plus/icons-vue'
import type { MenuNode } from '@/types/menu'

// Vue 3 <script setup> 不会自动注册自身用于递归模板。
// 这里显式按文件路径自引用，让模板里能用 <MenuTreeItem />。
import MenuTreeItem from '@/layouts/components/MenuTreeItem.vue'

const props = defineProps<{ menu: MenuNode }>()

const hasChildren = computed(() => props.menu.children.length > 0)
// 叶子节点：必须有 path 且没有 children。
const isLeaf = computed(() => !!props.menu.path && !hasChildren.value)

// 2026-08-21：图标命名空间 import * as ElIcons 会把全部 ~300 个图标拉进 bundle，
// 改为显式地图（tree-shaking 只保留下列图标）。覆盖 router meta.icon 与后端菜单树
// t_menu.icon 的全部取值；新增菜单图标时必须在此补充命名导入，否则侧栏该图标静默不显示。
const ICON_MAP: Record<string, unknown> = {
  House,
  Box,
  CircleCheck,
  Tools,
  Cpu,
  OfficeBuilding,
  Document,
  Promotion,
  User,
  Key,
  Platform,
  DataAnalysis,
  Connection,
  // 2026-08-22：补全侧栏 6 个缺失图标
  Tickets,
  Plus,
  Van,
  Setting,
  Operation,
  // 2026-08-26：新增 List（users_list 账号管理），与生产 t_menu.icon 对齐
  List,
}

// 按名字查图标；查不到返回 undefined → 模板里 v-if 隐藏图标（不报错）。
const iconComp = computed(() => {
  const name = props.menu.icon
  if (!name) return undefined
  return ICON_MAP[name] as never
})
</script>