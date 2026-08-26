# 响应式与布局

> **目标读者**：新人 / Agent
> **核心价值**：MainLayout vs 全屏路由划分 + 桌面断点阈值 + 长列表滚动策略
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

本文件聚焦「页面怎么摆」：哪些页面走 MainLayout、哪些走全屏独立路由、断点在哪、长列表怎么滚。组件级响应式（form-grid、dialog 静态尺寸）见 `component-patterns.md` 和 `design-tokens.md`。

## 布局结构

### MainLayout（默认）

`src/layouts/MainLayout.vue` 包裹绝大多数页面。结构：

- 左侧栏：logo + 折叠按钮 + 递归菜单（`MenuTreeItem`）。
- 顶栏：面包屑 + 用户下拉 + 修改密码。
- 顶栏下方挂全局 `NotificationBanner`。
- 内容区：`<router-view />`。

### 全屏独立路由

以下路由**不在** MainLayout 内：

| 路由 | 原因 |
| --- | --- |
| `/login` | 登录页独立视觉 |
| `/scan/*` | 工位扫码台是 1080p 大屏触摸 HMI，需要全屏布局 |
| `/delivery-dispatch/*` | 司机送货台同理，全屏触摸 |

路由配置上这些页面直接挂 `<router-view />` 的根路由 / 独立的 path tree，不被 `MainLayout` 包。`router/index.ts` 里看 meta.layout 之类的字段可识别。

### 为什么全屏

工位 / 司机 / 看板都是固定分辨率触摸大屏，没有侧栏 / 面包屑 / 用户菜单的存在意义（操作员不切换账号）。把侧栏顶栏让出来给业务内容，是触摸友好设计的核心约束。

## 侧栏（MainLayout）

### 结构

- 顶部 logo + 系统名（折叠后只显示 logo）。
- 折叠按钮（`<el-icon>`）控制侧栏收起 / 展开，状态写 localStorage 持久化。
- 菜单由后端下发的 `user.menus` 递归渲染（`MenuTreeItem` 组件）。
- 折叠态：只显示图标；展开态：图标 + 文字。

### 顶栏

- 左侧：面包屑（由 route.matched 推）。
- 右侧：用户下拉（账号 / 修改密码 / 退出）。
- 中间靠左：全局 `NotificationBanner` 挂载点（大屏实时事件横幅，见 `component-patterns.md`）。

### 颜色

- 侧栏背景 `--sidebar-bg`（深藏青 `#1a3a6b`）。
- 侧栏文字 `--sidebar-text`（`#cfdcef`），激活 `--sidebar-text-active`（白）。
- 侧栏 hover 底 `--sidebar-hover`（`#234a82`），激活底 `--sidebar-active-bg`（`#2c6cb8`）。

## 响应式断点

### EP 默认断点（沿用）

| 断点 | px |
| --- | --- |
| sm | 768 |
| md | 992 |
| lg | 1200 |
| xl | 1920 |

`.form-grid` / 各组件的 `@media` 直接用这四个阈值。

### 裸 `@media`，无 mixin

```scss
@media (min-width: 768px) { ... }
@media (min-width: 992px) { ... }
@media (min-width: 1200px) { ... }
```

SCSS breakpoints mixin 在 T1 重构（commit 8168b2b）删除，**不要**在组件内 `@include from(...) / until(...)`，找不到 mixin 会编译失败。新增断点时直接写裸 `@media`，沿用 EP 阈值。

### 项目以桌面端为主

- 设计目标：1280×800 起，到 1920×1080 大屏。
- 移动端不主动适配，不引入 mobile-first 设计。
- 工位 / 看板 / 司机台走全屏路由 + 触摸友好组件（见 `component-patterns.md` 的 `HmiPickerCard`）。

## 大屏触摸优化

### 最小点击区

所有触摸场景组件（HmiPickerCard / 工位按钮 / 看板卡片）保证 **48px 最小点击区**。这是 Material Design / iOS HIG 的通用下限，手指肚直径约 40-50px。

### `useHoldToScroll.ts`

长按按钮持续滚动（报工台场景：长按「+」「-」按钮连续调整数量）。

```ts
import { useHoldToScroll } from '@/composables/useHoldToScroll'

const { start, stop } = useHoldToScroll({
  onTick: () => value.value++,
  initialDelay: 300,
  interval: 80,
})
// @mousedown="start" / @mouseup="stop" / @mouseleave="stop"
```

避免在 HMI 页面引入 vueuse 的复杂滚动工具 —— 业务只需要长按连续 + / -，`useHoldToScroll` 够用。

### 不引入 vueuse 复杂组件

工位 / 看板 / 司机台是项目自己用 composable 实现的，不要为了省事引 `useScroll` / `useDraggable` / `useResizeObserver` 之类的全量工具（依赖膨胀明显）。已有的 `useHoldToScroll` 是允许的唯一触摸相关 composable。

## 长列表滚动

### el-table 默认不开虚拟滚动

`el-table` 默认无脑全量渲染 DOM，**单页 200-500 行**以内无明显性能问题。绝大多数业务列表分页 20 / 50 行 / 页，远低于这个值。

### 超过 1000 行

启用虚拟滚动：

```html
<el-table :virtual-scroll="true" :data="rows" height="600" />
```

注意：`height` 必须固定才能触发虚拟滚动；动态 height 退化成普通滚动。

### 分页优于无限滚动

业务列表统一走分页（`el-pagination`），不引入无限滚动。理由：

- 业务上需要「一共多少条」「跳到第 N 页」的分页信息。
- 后端接口固定返回分页结果，前端不用维护滚动加载状态。
- 无限滚动引入 IntersectionObserver / sentinel 节点 + 边界去重，工程成本不划算。

## mobile 清理（T1 重构历史）

2026-08-22 完成的 mobile 清理，背景和产出：

- 14 个文件清 mobile 残留（包括 `ResponsiveList.vue` 等移动端专用组件删除）。
- `useDialogSize` 的 `fullscreenOnMobile` 选项废弃 / 删除。
- `src/styles/index.scss` 顶部 `@forward` 改 EP 主题色代码同步删除（无 `@use` 消费者，已是死代码，详见 `element-plus-integration.md`）。
- 现在项目明确不做 mobile-first，移动端用户访问看到桌面布局（带横向滚动），这是已知取舍。

未来如果产品决定要支持移动端，要做的是重新设计一套 mobile-first 页面树，而不是在现有桌面组件上加补丁 —— 当前的桌面布局假设 1280×800 起步，强行缩到手机会很难用。
