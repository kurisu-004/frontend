<template>
  <el-container class="main-layout">
    <!-- 左侧菜单栏（始终显示；可折叠到 64px） -->
    <el-aside :width="isCollapse ? '64px' : '165px'" class="sidebar">
      <!-- 2026-10-01 换品牌标识：EP <Box> 图标 + myERP 文案 → 正式 logo 图形标
           （public/logo-mark.svg，母版 public/logo.svg 去掉黑色字标后的纯图形）。
           用图形标而非完整 lockup 的原因：字标只占整体高度约 9.7%，在 48px 的
           logo 条内渲染后 cap height 约 4px，任何尺寸下都不可读；且原字标是黑色
           #010102，落在 #142d54 深底上完全看不见（已用 rsvg-convert 渲染核对）。
           折叠态 v-show 会把文字移出无障碍树，所以 img 的 alt 不能留空。 -->
      <div class="logo">
        <img class="logo-mark" src="/logo-mark.svg" alt="洪升宏" />
        <span v-show="!isCollapse" class="logo-text">洪升宏</span>
      </div>

      <el-menu
        :default-active="activeMenu"
        :collapse="isCollapse"
        :collapse-transition="false"
        :unique-opened="true"
        background-color="var(--sidebar-bg)"
        text-color="var(--sidebar-text)"
        active-text-color="var(--sidebar-text-active)"
        class="sidebar-menu"
        router
        @select="onMenuSelect"
      >
        <!-- 菜单来自后端 t_menu + t_role_menu（登录时拉回，存 localStorage）。
             菜单项定义见 MainLayout.vue 之外的 @/layouts/components/MenuTreeItem.vue
             —— 它递归渲染 <el-sub-menu> 与 <el-menu-item>。 -->
        <template v-if="menuList.length > 0">
          <MenuTreeItem v-for="m in menuList" :key="m.id" :menu="m" />
        </template>
        <div v-else class="sidebar-empty">暂无可用菜单</div>
      </el-menu>
    </el-aside>

    <el-container>
      <!-- 2026-09-29 重构：el-header 改为三段式（left / middle / right）。
           header-left 留折叠按钮；header-middle 嵌入 TagsView（40px 容器贴
           header 下边缘，active tab margin-bottom: -1px 盖住 header border）；
           header-right 仅放 UserDropdown。面包屑与刷新按钮已移除。 -->
      <el-header class="header">
        <div class="header-left">
          <el-button link class="collapse-btn" @click="onNavToggle">
            <el-icon :size="20">
              <Fold v-if="!isCollapse" />
              <Expand v-else />
            </el-icon>
          </el-button>
        </div>

        <div class="header-middle">
          <TagsView />
        </div>

        <div class="header-right">
          <UserDropdown />
        </div>
      </el-header>

      <!-- 主要内容区 -->
      <el-main class="main-content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <!-- 2026-09-28 新增：keep-alive 套在 router-view 上，由 tagsView 的
                 cachedViewNames 控制缓存范围，切换 tab 时保留滚动位置 / 筛选 /
                 未提交表单。Component 解包由 :is 自动处理；refreshSelectedView 通过
                 临时摘 cachedViewNames → nextTick 重新 push 触发重挂载，比 :key 切
                 换整 router-view 更轻（不破坏 transition）。 -->
            <keep-alive :include="tags.cachedViewNames">
              <component :is="Component" />
            </keep-alive>
          </transition>
        </router-view>
      </el-main>
    </el-container>

    <!-- 全局业务事件横幅：Teleport 到 body，右上角浮层 -->
    <NotificationBanner />
  </el-container>
</template>

<script setup lang="ts">
// 2026-09-29 精简：移除面包屑、刷新按钮、用户下拉、改密弹窗、currentUser onMounted
// 全部逻辑，迁出到 UserDropdown.vue + useUserActions.ts。本文件只保留 layout 装配
// —— 折叠 / 侧栏菜单 / 顶栏三段式 / keep-alive / NotificationBanner。
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Fold, Expand } from '@element-plus/icons-vue';
// 2026-09-26：迁移到 Pinia store useAuthStore（替代原 useAuthSession 模块级单例）。
// 标量 getter 去掉括号：menus() → auth.menus；isDummyAuthActive() → auth.isDummyAuthActive。
import { useAuthStore } from '@/stores/auth';
// 2026-09-28 新增：tagsView 全局 store + 展示组件。MainLayout 把 TagsView 挂到
// el-header 与 el-main 之间，并通过 keep-alive :include 把缓存范围展开到 visitedViews。
import { useTagsViewStore } from '@/stores/tagsView';
import MenuTreeItem from '@/layouts/components/MenuTreeItem.vue';
import TagsView from '@/layouts/components/TagsView.vue';
import UserDropdown from '@/layouts/components/UserDropdown.vue';

const route = useRoute();
const router = useRouter();

const isCollapse = ref(false);
const auth = useAuthStore();
// 2026-09-28 新增：tagsView store 单一实例（消费侧不解构，沿 auth store 不变量）。
const tags = useTagsViewStore();

const menuList = computed(() => auth.menus);
const activeMenu = computed<string>(() => route.path);

// 顶栏折叠按钮：切换侧栏宽度
const onNavToggle = (): void => {
  isCollapse.value = !isCollapse.value;
};

// 侧栏菜单项选中：路由跳转（<el-menu router> 已自动路由，这里冗余兜底，确保 router 实例可用）
function onMenuSelect(index: string): void {
  router.push(index);
}
</script>

<style lang="scss" scoped>
.main-layout {
  height: 100vh;
}

.sidebar {
  background-color: var(--sidebar-bg);
  transition: width 0.3s;
  overflow: hidden;
  box-shadow: 2px 0 6px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
}

.logo {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #fff;
  font-size: 20px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background-color: #142d54;

  /* 2026-10-01：.logo-icon（EP <Box> 的 font-size: 24px + color: #7eb0e3）随
     图标下线一并删除——<img> 不吃 font-size / currentColor，两条规则都是死的。
     换成图形标：viewBox 2003.13×1326.84，宽高比 1.51:1，48px 宽 → 32px 高，
     折叠态 64px 侧栏两侧各余 8px。object-fit: contain 兜住 SVG 根节点
     width="91.852mm" 解析出的固有尺寸（~347×230px），避免宽高比微差导致拉伸。 */
  .logo-mark {
    display: block;
    width: 48px;
    height: 32px;
    object-fit: contain;
  }

  .logo-text {
    letter-spacing: 1px;
  }
}

.sidebar-menu {
  flex: 1;
  min-height: 0; /* 让 flex 项可收缩至内容尺寸以下,否则溢出时不会触发滚动 */
  overflow-y: auto; /* 菜单项超出可视高度时纵向滚动 */
  border-right: none;
  background-color: var(--sidebar-bg);
}

.sidebar-menu::-webkit-scrollbar {
  width: 6px;
}

.sidebar-menu::-webkit-scrollbar-thumb {
  background-color: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.sidebar-menu::-webkit-scrollbar-thumb:hover {
  background-color: rgba(255, 255, 255, 0.35);
}

.sidebar-menu::-webkit-scrollbar-track {
  background-color: transparent;
}

.sidebar-empty {
  color: var(--sidebar-text);
  opacity: 0.6;
  text-align: center;
  padding: 24px 8px;
  font-size: 13px;
}

:deep(.el-menu-item:hover),
:deep(.el-sub-menu__title:hover) {
  background-color: var(--sidebar-hover) !important;
}

:deep(.el-menu-item.is-active) {
  background-color: var(--sidebar-active-bg) !important;
  color: #fff !important;
  border-left: 3px solid var(--primary-lighter);
}

:deep(.el-sub-menu .el-menu-item) {
  background-color: #142d54 !important;
  /* 2026-09-29 收窄：220 → 165（侧栏缩小25%）。子菜单弹出与父侧栏同宽即可，
     不必比父侧栏宽；原 220 是配合旧父侧栏宽度。 */
  min-width: 165px;
  /* 2026-09-29 二级水平偏移：EP 默认二级 .el-menu-item padding-left = 40px
     (calc(20px + level * 20px))，一级 0。改为 20px 与一级对称（图标起点对齐到
     一级 + 20px，二级内容起点比一级缩 20px，呈现「同父缩进」而非「嵌套缩进」）。 */
  padding-left: 20px !important;
}

/* 2026-09-29 重构：align-items: stretch 让 header-middle / header-right 撑满
   60px 高度各自 align 内容。border-bottom 由 header 提供，TagsView 内部去掉
   重复 border 以保持视觉单一线条（active tab margin-bottom: -1px 盖住）。 */
.header {
  background-color: var(--header-bg);
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid var(--border-color);
  /* 2026-09-29 收窄：60 → 48px。tags 容器仍 40px，header-middle flex-end 嵌到底；
     上方留 8px 呼吸空间（不挤 logo 视觉），active tab margin-bottom: -1px 盖
     border 数学不变（box-sizing border-box，content 47px + 1px border）。 */
  height: 48px;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
}

.collapse-btn {
  font-size: 20px;
  color: var(--text-regular);
  padding: 4px;

  &:hover {
    color: var(--primary-color);
  }
}

/* 2026-09-29 新增：flex: 1 让 tags 占据折叠按钮与用户组件之间的全部剩余空间；
   min-width: 0 容许内部 overflow-x 滚动；align-items: flex-end 把 40px 的
   TagsView 容器贴到 header 下边缘（与原独立行视觉一致）。 */
.header-middle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
}

.header-right {
  display: flex;
  align-items: center;
}

.main-content {
  background-color: var(--content-bg);
  padding: 16px;
  overflow: auto;
  /* 2026-09-29 新增：建立独立 stacking context，防止页面内 position: fixed /
     阴影元素穿透到标签条之上（标签条 z-index: 5，main z-index: 1）。 */
  position: relative;
  z-index: 1;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
