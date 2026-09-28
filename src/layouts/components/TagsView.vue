<template>
  <div class="tags-view-container">
    <!-- 2026-09-28 新增：vue-element-admin 风格的 tagsView tab 栏。
         横排 flex + CSS-only 横向滚动（隐藏滚动条）。
         每个 tab 用 el-dropdown trigger="contextmenu" 包裹，触发 4 项右键菜单。 -->
    <el-dropdown
      v-for="view in visitedViews"
      :key="view.path"
      trigger="contextmenu"
        :disabled="view.affix === true"
      @command="(cmd: MenuCmd) => onContextMenuCmd(cmd, view)"
      @visible-change="(v: boolean) => onMenuVisibleChange(view, v)"
    >
      <!-- 自定义 tab 视觉壳（不用 el-tag：22px 最小高度 + 内置色彩与本设计相冲） -->
      <div
        :class="[
          'tag-item',
          {
            active: isActiveView(view),
            affix: view.affix === true,
          },
        ]"
        @click="onTagClick(view)"
      >
        <span class="tag-text">{{ view.title }}</span>
        <!-- affix 不显示关闭按钮（vue-element-admin 行为） -->
        <el-icon
          v-if="!view.affix"
          class="tag-close"
          @click.stop="onCloseClick(view)"
        >
          <Close />
        </el-icon>
      </div>
      <!-- 右键菜单：按需 disabled -->
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="refresh" :disabled="!isActiveView(view)">
            <el-icon><Refresh /></el-icon>刷新
          </el-dropdown-item>
          <el-dropdown-item command="close" :disabled="view.affix === true">
            <el-icon><Close /></el-icon>关闭
          </el-dropdown-item>
          <el-dropdown-item
            command="close-others"
            :disabled="isOnlyView(view)"
          >
            <el-icon><CloseBold /></el-icon>关闭其他
          </el-dropdown-item>
          <el-dropdown-item
            command="close-all"
            :disabled="isOnlyAffix(view)"
          >
            <el-icon><FolderDelete /></el-icon>关闭全部
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter, type RouteLocationNormalizedLoaded } from 'vue-router';
import { Close, Refresh, CloseBold, FolderDelete } from '@element-plus/icons-vue';
import { tryOnScopeDispose } from '@vueuse/core';
// 2026-09-28 新增：tagsView 全局 store。消费侧不解构：tags.xxx 直访响应式。
import { useTagsViewStore } from '@/stores/tagsView';
import type { TagView } from '@/stores/tagsView';

type MenuCmd = 'refresh' | 'close' | 'close-others' | 'close-all';

const route = useRoute();
const router = useRouter();
const tags = useTagsViewStore();

const visitedViews = computed<TagView[]>(() => tags.visitedViews);

/** 当前激活 tab 判定：path 比对，不看 fullPath（保留 query 重复打开）。 */
function isActiveView(view: TagView): boolean {
  return view.path === route.path;
}

/** 「关闭其他」disable：仅剩当前 + 全部 affix 即可视为「没有可关的」。 */
function isOnlyView(view: TagView): boolean {
  if (visitedViews.value.length <= 1) return true;
  return visitedViews.value.every((v) => v.affix || v.path === view.path);
}

/** 「关闭全部」disable：关闭全部 non-affix 后已无可关。 */
function isOnlyAffix(view: TagView): boolean {
  if (view.affix === true) return false;
  return visitedViews.value.every((v) => v.affix);
}

/** route → TagView 私有 mapper。RouteRecordName 是 string | symbol | null | undefined，
 *  在 addView 内 narrow 为 string；此处保留原值传入，由 addView 统一处理。 */
function routeToView(r: RouteLocationNormalizedLoaded): TagView {
  const nameRaw = r.name as string | symbol | null | undefined;
  const name = typeof nameRaw === 'string' ? nameRaw : '';
  return {
    path: r.path,
    fullPath: r.fullPath,
    name,
    title: (r.meta?.title as string | undefined) ?? '',
    icon: r.meta?.icon as string | undefined,
    affix: r.meta?.affix === true,
  };
}

/** 单击 tab：复用 router.push(fullPath) 保留 query/hash；若已是当前则 no-op。 */
function onTagClick(view: TagView): void {
  if (view.path === route.path) return;
  router.push(view.fullPath).catch(() => {
    /* 同 path 不同 query 重复 push 时 vue-router 会 reject，吞掉避免 console 噪声 */
  });
}

/** 单击 × 按钮：触发关闭。 */
function onCloseClick(view: TagView): void {
  closeView(view);
}

/** 右键菜单事件分发。 */
function onMenuVisibleChange(_view: TagView, _visible: boolean): void {
  /* 占位：el-dropdown 可见性回调；当前无需同步状态，留接口备将来扩展。 */
}

function onContextMenuCmd(cmd: MenuCmd, view: TagView): void {
  switch (cmd) {
    case 'refresh':
      tags.refreshSelectedView(view);
      break;
    case 'close':
      closeView(view);
      break;
    case 'close-others':
      closeOthers(view);
      break;
    case 'close-all':
      closeAll(view);
      break;
  }
}

/** 关闭一个 tab。affix 不删；若关闭的是当前 tab，需要导航到下一个邻居。 */
function closeView(view: TagView): void {
  const removedFullPath = tags.removeView(view);
  if (removedFullPath === null) return;
  // 若关闭的是激活 tab，找 visitedViews 第一个非 affix 邻居或首个 affix
  if (isActiveView(view)) {
    const next = pickNextView();
    if (next) router.push(next.fullPath);
    else if (visitedViews.value.length > 0) router.push(visitedViews.value[0].fullPath);
  }
}

/** 关闭除当前 + 所有 affix 外的 tab。 */
function closeOthers(view: TagView): void {
  tags.removeOtherViews(view);
}

/** 关闭全部非 affix tab。保留 affix。 */
function closeAll(_view: TagView): void {
  tags.removeAllViews();
}

/** 关闭当前 tab 后挑下一个 fallback 邻居。removeView 已经把被关 view 从
 *  visitedViews 移除，所以 list 剩下的任何一项都是合法候选；优先取末尾（视觉上
 *  与用户「关闭当前往右看」的直觉一致）。 */
function pickNextView(): TagView | null {
  const list = visitedViews.value;
  if (list.length === 0) return null;
  return list[list.length - 1];
}

/** router.afterEach 钩子：导航完成后自动登记访问。 */
function registerAfterEach(): () => void {
  const off = router.afterEach((to) => {
    if (to.meta?.noTagsView === true) return;
    tags.addView(routeToView(to));
  });
  return off;
}

let unregister: (() => void) | null = null;

onMounted(() => {
  // 2026-09-28：首屏兜底。MainLayout mount 时 route 已经 resolve，afterEach
  // 不一定触发（直接打开 /dashboard 时路由已完成），所以先补一次登记。
  if (route.meta?.noTagsView !== true) {
    tags.addView(routeToView(route));
  }
  unregister = registerAfterEach();
});

onBeforeUnmount(() => {
  if (unregister) {
    unregister();
    unregister = null;
  }
});

// 2026-09-28 安全网：若组件 scope 异常提前销毁（例如被 v-if 销毁），仍清理 afterEach。
tryOnScopeDispose(() => {
  if (unregister) {
    unregister();
    unregister = null;
  }
});
</script>

<style lang="scss" scoped>
/* 2026-09-28 新增：tagsView tab 栏样式。36px 高横排 flex，CSS-only 隐藏滚动条。 */
.tags-view-container {
  height: 36px;
  width: 100%;
  background-color: var(--header-bg);
  border-bottom: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
  display: flex;
  align-items: center;
  padding: 0 8px;
  gap: 6px;
  overflow-x: auto;
  overflow-y: hidden;
  /* Firefox 隐藏滚动条 */
  scrollbar-width: none;
  /* WebKit / Blink 隐藏滚动条 */
  &::-webkit-scrollbar {
    display: none;
  }
}

.tag-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background-color: #fafbfc;
  font-size: 12px;
  color: var(--text-regular);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: background-color 0.18s, color 0.18s, border-color 0.18s;

  &:hover {
    color: var(--primary-color);
    border-color: var(--primary-light);
  }

  .tag-text {
    line-height: 1;
  }

  .tag-close {
    font-size: 12px;
    color: var(--text-secondary);
    margin-left: 2px;
    padding: 2px;
    border-radius: 2px;
    transition: background-color 0.18s, color 0.18s;

    &:hover {
      background-color: rgba(0, 0, 0, 0.08);
      color: var(--primary-color);
    }
  }

  &.active {
    background-color: var(--primary-color);
    color: #fff;
    border-color: var(--primary-color);

    .tag-close {
      color: rgba(255, 255, 255, 0.85);

      &:hover {
        background-color: rgba(255, 255, 255, 0.18);
        color: #fff;
      }
    }
  }

  &.affix {
    /* affix 与 active 视觉一致 —— 用户视角常驻首页；区别仅在「关闭按钮缺席」 */
    /* 保留 affix class 便于将来扩展（hover 不显示 close icon 已通过 v-if 处理） */
  }
}
</style>