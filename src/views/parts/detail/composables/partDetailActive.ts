// views/parts/detail/composables/partDetailActive.ts
//
// 2026-10-10 新增：零件详情页「本页是否活跃」的唯一判据，供两处共用：
//   ① `PartDetail.vue` 的 route watcher —— 本页被 keep-alive 缓存后（路由名
//      `PartDetail` = 组件文件名，MainLayout 的 `<keep-alive :include>` 按名字匹配），
//      `useRoute()` 注入的是 vue-router 的**全局** currentRoute，切到别的页面时
//      `route.params.id` 照样变 ⇒ watcher 会把 partId 改成别的页面的 id。
//   ② 两条 query hook（`usePartDetailQuery` / `usePartEventsQuery`）的 `enabled`
//      闸门 —— reactive queryKey 跟着全局路由变就会去拉别人的数据；那条数据流是
//      computed → queryKey，没有 watcher 可挂守卫，只能在 `enabled` 侧收。
//
// 这两处判据**必须逐字一致**，否则会出现「切走后 watcher 已经不写 partId、但 enabled
//  还开着，queryKey 仍随全局路由变」的半开状态 —— 那正好是要治的 bug 的缩小版。
// 故抽成共享纯函数，不在两个文件里各写一遍 `route.name !== 'PartDetail'`。
//
// 参数只收 `routeName`（不收整个 RouteLocationNormalizedLoaded、也不 import
// vue-router）：判据是常量比较，调用方传 `route.name` 即可，保持本文件零依赖
// （composable / 域内工具不 import vue-router 是 CLAUDE.md 的不变量）。

/** 零件详情页的路由名。必须与 `views/parts/detail/PartDetail.vue` 的组件文件名一致 ——
 *  MainLayout 的 keep-alive `:include="tags.cachedViewNames"` 按**组件名**匹配，
 *  两边不一致会让本页根本不被缓存（那本页就不会有「切走后乱发请求」这个病）。 */
export const PART_DETAIL_ROUTE_NAME = 'PartDetail';

/** 本页是否仍是当前路由。入参取 `useRoute().name`（可为 null / symbol / undefined）。 */
export function isPartDetailActive(routeName: unknown): boolean {
  return routeName === PART_DETAIL_ROUTE_NAME;
}
