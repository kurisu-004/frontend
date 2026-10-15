// src/composables/useIsActive.ts
//
// 2026-10-22 新增：宿主组件当前是否**活跃**（用户正看着它）的响应式标志。
//
// 为什么需要它：`MainLayout.vue` 的 `<keep-alive :include="tags.cachedViewNames">`
// 把路由组件缓存下来，切标签页走的是 deactivate 而不是 unmount ⇒ **组件实例还在、
// 它的 watcher / 定时器 / document 级监听全都还在跑**，只有 `onDeactivated` 会来。
// 于是「离开页面就不该做的事」必须有办法判出来 —— 否则它会在用户看着别的标签页时
// 继续发请求、继续抢键盘。
//
// 两个典型消费点（都是本文件建立的原因，不要在别处就地造第二份判据）：
//   1. `refetchInterval`（列表页自动刷新）：`refetchIntervalInBackground: true` 管的是
//      **浏览器窗口**失焦，与 Vue 的 keep-alive 状态**毫无关系** ⇒ 被缓存的后台页照样
//      每 5 分钟打一次请求；
//   2. `document` 级 keydown（行内编辑的 Enter 存盘 / Esc 取消）：编辑到一半切走，
//      `editingId` 仍非空、监听仍在，在别的标签页敲 Enter 会把那一行存了。
//
// 判据取**生命周期**（`onActivated` / `onDeactivated`）而不是 `route.name !== 'X'`：
// 后者一改路由名就静默失效（`tagsView.ts` 已经为路由改名踩过一次迁移，见 CLAUDE.md
// 「tagsView per-user 持久化」），而本 hook 与路由命名解耦。
//
// ⚠️ **初值必须是 `true`**：不在 `<KeepAlive>` 下的组件两个钩子都不触发，标志恒为
// `true` ⇒ 非缓存页与「从不调用本 hook」的行为完全一致，调用方无需区分。

import { onActivated, onDeactivated, ref, type Ref } from 'vue';

/**
 * 宿主组件是否活跃。必须在 setup 作用域调用。
 *
 * 只读：由本 composable 通过 `onActivated` / `onDeactivated` 维护，调用方只消费。
 */
export function useIsActive(): Readonly<Ref<boolean>> {
  const isActive = ref(true);
  onActivated(() => {
    isActive.value = true;
  });
  onDeactivated(() => {
    isActive.value = false;
  });
  return isActive;
}
