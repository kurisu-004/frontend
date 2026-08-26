# 组件模式

> **目标读者**：新人 / Agent
> **核心价值**：通用壳组件约定 + 列表页标准结构 + 表单栅格 + dialog 约定
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

本文件聚焦「跨页面复用」的工程化约定。通用壳组件集中在 `src/components/`（业务专属组件在 `src/modules/<domain>/components/` 下，本文件不涉及）。新增页面**优先复用现有壳**而不是从零搭表格 + 分页。

## 通用组件约定

下表所有组件都在 `src/components/` 下，按一行用途 + props 关键约束列出。

### PagedTable.vue

「分页 + 表格」通用壳。内部封装 `usePagedListQuery`，view 通过 ref 拿 fetch / reset。

| 项 | 说明 |
| --- | --- |
| 用途 | 任意「列表 + 分页 + 单查询」的轻量页面 |
| 关键约束 | 列定义由父组件传入（slot）；fetch 是 async 函数；不支持列筛选 / 行类型色（用 `PartListShell`） |
| 不适用 | 列可见性切换、行级加急 / 送货单状态色 —— 改用 `PartListShell` |

### PartListShell.vue

「filter 卡 + 列可见性 + 表格 + 分页 + 加急红底」壳。

| 项 | 说明 |
| --- | --- |
| 用途 | 部件列表场景，目前 InspectionPending / PendingProgramming 共用 |
| 关键约束 | 内置 `ColumnVisibilityPopover` + 加急行（`row-urgent`）红底；fetch 接口签名固定 `{ page, pageSize, filters }` |
| 不适用 | 非部件域列表（用 `PagedTable`） |

### FileListCard.vue

文件列表 + 上传 / 删除 / 预览通用卡。

| 项 | 说明 |
| --- | --- |
| 用途 | 装配 / 部件 / 工艺卡任意文件管理场景 |
| 关键约束 | 按 `kind` 区分：DRAWING / 3D_MODEL / G_CODE / SETUP_SHEET / ASSEMBLY_MASTER / CAD_2D，不同 kind 走不同预览器与图标 |
| 复用 | `kind` 是 enum，新业务加新 kind 必须先扩 enum 再用 |

### Barcode.vue

`jsbarcode` 渲染 SVG 条形码。

| 项 | 说明 |
| --- | --- |
| 用途 | 工位扫码台打印 / 显示部件号 |
| 关键约束 | 默认 CODE39（适配车间喷码机），其他类型通过 `format` prop 覆盖 |
| 依赖 | `jsbarcode`，体积小，按需引入 |

### EChart.vue

ECharts 6 封装。

| 项 | 说明 |
| --- | --- |
| 用途 | dashboard / 报表页 |
| 关键约束 | v5 主题锁定；`ResizeObserver` 自适应父容器；unmount 时 `dispose()` 防内存泄漏 |
| 主题 | 通过 `option` 传入，主题色用本项目 `--primary-color` / `--primary-light` / `--primary-lighter` 三色梯度 |

### PdfViewer.vue

`pdfjs-dist` 内嵌预览（翻页 / 缩放 / 下载）。

| 项 | 说明 |
| --- | --- |
| 用途 | 图纸 / 工艺卡 PDF 预览 |
| 关键约束 | worker 配置从 `src/utils/pdfjs.ts` 统一拿，**不要**自己 import `pdfjs-dist` |
| CMap | 解析 CJK PDF 时需 cMap（已在 `pdfjs.ts` 配好），遇到乱码先确认 PDF_CMAP_OPTIONS 已传 |

### BeianFooter.vue

公安网安备 + ICP 备案号 footer。

| 项 | 说明 |
| --- | --- |
| 用途 | 全站底部合规备案信息 |
| 关键约束 | 部署环境变量决定展示的备案号，不要硬编码 |

### HmiPickerCard.vue

HMI 触摸友好大卡片（kind=`process` \| `shelf`）。

| 项 | 说明 |
| --- | --- |
| 用途 | 工位 HMI 大屏选工序 / 选货架 |
| 关键约束 | 最小点击区 48px；大字号；不带 hover 态（触摸屏无意义） |
| 复用 | 同结构不同 kind 用 prop 切换样式 |

### NotificationBanner.vue

大屏实时事件横幅。

| 项 | 说明 |
| --- | --- |
| 用途 | 工位 / 看板顶部实时事件流 |
| 关键约束 | 从 dashboard WS event 通道消费 PICKED_UP / RETURNED / INSPECTED 事件；自动滚动 + 自动消失 |
| 挂载点 | MainLayout 顶部统一挂一份 |

### ColumnFilterPopover.vue / ColumnVisibilityPopover.vue

列头 popover。

| 项 | 说明 |
| --- | --- |
| 用途 | 列筛选（按值多选）+ 列显隐切换 |
| 关键约束 | 通过 popover 挂在 `el-table` 列头；`PartListShell` 内置 `ColumnVisibilityPopover` |

## 列表页标准结构

业务列表页统一采用下面的五段式。新页面直接照搬，不要从零搭。

### 1. 搜索区

- 顶部一个 `el-card` 或裸 `<div>` 容器。
- 内部 `<el-form>` + `.form-grid`（见下文）。
- 关键筛选条件（3-5 个）默认展示；多余条件进「高级筛选」折叠。
- 「搜索」「重置」按钮放搜索区底部右侧。

### 2. 表格

- `el-table` + `:data`。
- 列显隐：`PartListShell` 内置 / 其它场景自接 `ColumnVisibilityPopover`。
- 行类型色：加急（`row-urgent`）、在送货单（`row-on-delivery-note`）等通过 `row-class-name` 配 `:deep()` 规则覆盖。
- 滚动：横向列多时固定首尾两列；纵向默认不开虚拟滚动。

### 3. 分页

- `el-pagination` + `layout="total, sizes, prev, pager, next, jumper"`。
- `:page-sizes="[10, 20, 50, 100]"`。
- 触发 server-side fetch，`:current-page.sync` + `:page-size.sync`。

### 4. 详情弹窗

- `el-dialog` + `v-model`。
- 静态桌面尺寸走 `useDialogSize()`（见下文）。

### 5. 推荐复用

- 默认用 `PartListShell`（部件域）或 `PagedTable`（其它轻量列表）—— 二者已经把上面 1-3 段都封装好。
- 不要每个页面自己重写「搜索区 + 表格 + 分页」三件套。

## 表单栅格 `.form-grid`

`src/styles/index.scss` 里定义了 `.form-grid` 工具类，**替代**静态 `<el-row>` + `<el-col :span>` 写法。

### 行为

- 默认 1 列（手机 / 窄屏）。
- `>= 768px`（sm）：2 列。
- `>= 992px`（md）：3 列。
- `>= 1200px`（lg）：4 列。

### 用法

```html
<el-form :model="form" class="form-grid">
  <el-form-item label="部件号">
    <el-input v-model="form.code" />
  </el-form-item>
  <el-form-item label="名称">
    <el-input v-model="form.name" />
  </el-form-item>
  <el-form-item label="备注" class="form-grid__full">
    <el-input v-model="form.note" type="textarea" />
  </el-form-item>
</el-form>
```

### 关键约束

- 工具类已经让 `el-select` / `el-cascader` / `el-date-editor` / `el-autocomplete` / `el-input-number` 默认 `width: 100%`，组件内不要再写 width。
- `.form-grid__full` 让单元格跨整行（备注 / 长描述场景）。
- 用的是**裸 `@media (min-width: ...)`**（EP 默认 sm 768 / md 992 / lg 1200 阈值）。SCSS breakpoints mixin 已在 T1 重构（commit 8168b2b）删除，不要在组件内 `@include from(...)`，找不到 mixin。

### 触发表单一行几列的依据

栅格是自动响应式的，不需要人工决定每行几列。设计层面只关心：

- 字段长短比例：短字段（4-6 字）适合 4 列；中字段（8-12 字）3 列；长字段 / 备注 1-2 列。
- 屏幕宽度：1280×800 起就是 lg（4 列），桌面端走齐 4 列；HMI 大屏 1920×1080 也是 4 列（卡片内组件有自己宽度）。

## dialog 约定

### 静态桌面尺寸

所有业务弹窗**统一**用 `useDialogSize()` 拿到静态宽高，不再做响应式 dialog。

原因：响应式 dialog 在窗口 resize 时会抖动（dialog 内容 reflow），HMI 大屏固定 1920×1080 不需要响应式，桌面端 1280×800 起也不需要响应式。统一静态尺寸视觉更稳。

```ts
import { useDialogSize } from '@/composables/useDialogSize'

const { width, height } = useDialogSize()
// width / height 直接绑到 el-dialog 的 :width / 自定义 max-height
```

### `fullscreenOnMobile` 已废弃

`useDialogSize` 历史上的 `fullscreenOnMobile` 选项在 T1 重构删除（mobile 清理一并做掉）。现在项目明确不做 mobile-first，所有 dialog 都是桌面尺寸，不要再传这个 prop。
