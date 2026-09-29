<template>
  <div ref="containerRef" class="tags-view-container">
    <!-- 2026-09-28 新增：vue-element-admin 风格的 tagsView tab 栏。
         横排 flex + CSS-only 横向滚动（隐藏滚动条）。
         每个 tab 用 el-dropdown trigger="contextmenu" 包裹，触发 4 项右键菜单。
         2026-09-29：el-dropdown 加 class="tag-dropdown [affix]"——el-dropdown 根
         div（EP 2.14.6 默认根即包裹 trigger 插槽的 div）才是容器的直接子元素，
         Sortable 只对直接子元素排序。原 draggable:'.tag-item' 让 .tag-item 与
         .el-dropdown 嵌套，previousElementSibling 算索引全为 0、拖动失效。 -->
    <el-dropdown
      v-for="view in visitedViews"
      :key="view.path"
      :class="['tag-dropdown', { affix: view.affix === true }]"
      trigger="contextmenu"
      @command="(cmd: MenuCmd) => onContextMenuCmd(cmd, view)"
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
import { computed, onMounted, onBeforeUnmount, ref as vueRef, watch, nextTick as vueNextTick } from 'vue';
import { useRoute, useRouter, type RouteLocationNormalizedLoaded } from 'vue-router';
import { Close, Refresh, CloseBold, FolderDelete } from '@element-plus/icons-vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { useDraggable } from 'vue-draggable-plus';
import type { MoveEvent } from 'sortablejs';
// 2026-09-28 新增：tagsView 全局 store。消费侧不解构：tags.xxx 直访响应式。
import { useTagsViewStore } from '@/stores/tagsView';
import type { TagView } from '@/stores/tagsView';

type MenuCmd = 'refresh' | 'close' | 'close-others' | 'close-all';

const route = useRoute();
const router = useRouter();
const tags = useTagsViewStore();

const visitedViews = computed<TagView[]>({
  get: () => tags.visitedViews,
  // 2026-09-29 修复拖动失效：vue-draggable-plus 的 onUpdate 对 ref 型 list 走
  // `r.value = St([...U(r)], _, x)`（dist/vue-draggable-plus.js:1426-1433）——
  // 整体赋一个新数组。若不带 setter 则 computed 只读，赋值被 Vue 静默吞掉，
  // DOM 回退后拖动视觉回弹。Pinia setup store proxy 写穿到内部 ref，persist 插件
  // 自动落盘 localStorage。
  set: (next) => {
    tags.visitedViews = next;
  },
});

const containerRef = vueRef<HTMLElement | null>(null);

// 2026-09-29 新增：拖动排序。基于 vue-draggable-plus（package.json:33 已依赖 ^0.6.1）。
// visitedViews 是 Pinia 响应式数组，v-dp 整体赋值后 Pinia 自动触发依赖更新 +
// persistedstate 写盘，无需 nextTick + 手动调 reorderViews（该 action 仅为外部代码预留）。
useDraggable(containerRef, visitedViews, {
  direction: 'horizontal',
  animation: 150,
  // 2026-09-29 修复：容器直接子元素是 .el-dropdown（EP 2.14.6 el-dropdown 根 div
  // 包裹 trigger 插槽），不是 .tag-item。Sortable 只对直接子元素排序
  // （previousElementSibling 算索引）—— .tag-item 在 .el-dropdown 内无兄弟 → 索引
  // 全 0、拖动全失效。改选 .tag-dropdown（详见模板 el-dropdown :class）。
  draggable: '.tag-dropdown',
  // 2026-09-29 保留：affix 钉死。Sortable filter 用 closest 上行匹配事件起点，
  // 即使内层 .tag-item.affix 命中也走 drag cancelled；单击 / 右键穿透
  // （preventOnFilter: false）保持原交互。
  filter: '.affix',
  preventOnFilter: false,
  // 2026-09-29 新增：阻止非 affix tab 拖到 affix 之前。affix 始终位于 visitedViews
  // 位置 0（store addView 内 unshift）；Sortable 整体赋值 onUpdate 后 affix 可能
  // 被非 affix 元素挤出。evt.willInsertAfter=true 意为插入到 related 之后（合法），
  // =false 意为插到 related 之前（非法，挡）。related 比对 (Select) 实际是
  // wrapper .tag-dropdown，affix 时 .tag-dropdown.affix 类已挂在 wrapper 上。
  onMove: (evt: MoveEvent): boolean => {
    const related = evt.related as HTMLElement;
    if (related.classList?.contains('affix') && !evt.willInsertAfter) return false;
    return true;
  },
  // 触摸设备上避免单击被误判为拖动起点
  delayOnTouchOnly: true,
});

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

/** 关闭全部非 affix tab。保留 affix。
 *
 *  2026-09-28 修复（review 第 2 轮 Major #1）：仿 vue-element-admin closeAllTags——
 *  removeAllViews 后若当前 route 对应的 tab 被清（含「只剩 affix 而当前是非 affix」
 *  这一支），导航到 last remaining tab；全清则跳回 '/'（路由会重定向到 dashboard）。
 *  不再回填「触发右键的 view」——避免「用户当前在 /a，右键非激活 /b 把 B 替换成 a」
 *  的语义偏差；store 保持纯粹（仅按字段判定，不感知 route），UI 兜底落到 view 层，
 *  符合分层不变量。导航（router.push）只放在 view 层（沿 hard约束 #8）。 */
function closeAll(view: TagView): void {
  // 形参 view 当前不再被消费，但保留签名以与 onContextMenuCmd 对齐（其它分支
  // 仍需要 view）。标记为有意未使用：void view 让 lint 工具闭嘴。
  void view;
  tags.removeAllViews();
  const remaining = visitedViews.value;
  if (remaining.length === 0) {
    // 全清（无 affix 也清掉）：跳回 '/'（路由会重定向到 dashboard）
    router.push('/');
  } else if (!remaining.some((v) => v.path === route.path)) {
    // 当前 route 对应的 tab 被清（含「只剩 affix 而当前是非 affix」）：跳到 last
    const last = remaining[remaining.length - 1];
    if (last) router.push(last.fullPath);
  }
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
  // 2026-09-29 新增：路由切换时把激活 tab 滚入可视区，避免被溢出滚动条隐到容器外。
  watch(
    () => route.path,
    () => {
      void vueNextTick(() => {
        const el = containerRef.value?.querySelector('.tag-item.active');
        el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    },
  );
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
/* 2026-09-29 重构：Chrome 风格标签条。40px 高容器 + 32px tab 顶部圆角 + 激活态
   坐在容器底边之上 + 关闭按钮 hover 才显 + affix 钉死 40px。z-index: 5 防被 main
   内容穿透。

   2026-09-29 嵌入 header-middle 后改：
   - 去 border-bottom（MainLayout .header 已提供，避免重复线导致 2px）
   - width: 100% → flex: 1 1 0; min-width: 0（作为 header-middle 的 flex item
     撑满剩余宽度） */
.tags-view-container {
  position: relative;
  z-index: 5;
  height: 40px;
  flex: 1 1 0;
  min-width: 0;
  background-color: var(--header-bg);
  display: flex;
  align-items: flex-end;   /* tab 贴着底边，「坐在」容器底部边框之上 */
  padding: 0 8px;
  gap: 4px;
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
  height: 32px;
  min-width: 80px;          /* 新增：宽度下限，过短则禁用 */
  max-width: 200px;         /* 新增：长标题 truncate */
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-top-left-radius: 8px;
  border-top-right-radius: 8px;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  background-color: #fafbfc;
  font-size: 13px;
  color: var(--text-regular);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  position: relative;
  transition: color 0.18s, border-color 0.18s, background-color 0.18s;

  .tag-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1;
  }

  .tag-close {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-secondary);
    margin-left: 0;          /* 原 2px 取消，避免压缩 tag-text 空间 */
    padding: 2px;
    border-radius: 50%;       /* 圆形 hover 区 */
    opacity: 0;              /* 默认隐藏，hover 才显 */
    transition: opacity 0.18s, background-color 0.18s, color 0.18s;

    &:hover {
      background-color: rgba(0, 0, 0, 0.08);
      color: var(--primary-color);
    }
  }

  &:hover {
    color: var(--primary-color);
    border-color: var(--primary-light);
    .tag-close { opacity: 1; }
  }

  &.active {
    background-color: var(--primary-color);
    color: #fff;
    border-color: var(--primary-color);
    margin-bottom: -1px;          /* 坐在容器底边之上，盖住底部 1px 边框（Chrome 效果） */
    box-shadow: 0 -2px 6px rgba(30, 77, 139, 0.18);  /* 轻微抬升阴影 */

    .tag-close {
      color: rgba(255, 255, 255, 0.85);
      opacity: 0.6;              /* 激活态关闭按钮半透，hover 才全显 */

      &:hover {
        background-color: rgba(255, 255, 255, 0.18);
        color: #fff;
      }
    }

    &:hover .tag-close { opacity: 1; }
  }

  &.affix {
    min-width: 0;
    width: 40px;                 /* 钉死图标宽度（pinned tab 视觉） */
    padding: 0;
    justify-content: center;
    /* affix 当前版本没有文本，CSS 层防御 */
    .tag-text { display: none; }
  }
}
</style>