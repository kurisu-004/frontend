# UI 与样式

> **目标读者**：新人 / Agent
> **核心价值**：本仓库 UI 架构、主题色、组件约定、响应式策略的统一索引
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

本目录聚焦前端「看得到」的部分：设计令牌、Element Plus 集成方式、可复用组件约定、布局与响应式。组件 API 用法以 [Element Plus 官方文档](https://element-plus.org/zh-CN/component/overview) 为准，本目录只描述本仓库的工程化层（按需加载、CSS 变量覆盖、跨页壳）。

## 子文档索引

```
docs/04-ui-and-styling/
├── README.md                  # 本文件，主题入口
├── design-tokens.md           # 主题色 / 中性色 / 字号 / 圆角 / 阴影 + EP CSS 变量覆盖
├── element-plus-integration.md # EP 按需加载工作原理 + 命令式 API CSS + 中文 locale
├── component-patterns.md      # 通用组件约定 + 列表页 / 表单栅格 / dialog 约定
└── responsive-and-layout.md   # MainLayout vs 全屏路由 + 断点 + 长列表滚动
```

| 子文档 | 一句话定位 |
| --- | --- |
| `design-tokens.md` | 项目所有颜色 / 字号 / 圆角 / 阴影在哪、怎么改、对应哪些 EP CSS 变量 |
| `element-plus-integration.md` | 按需自动加载原理、必须手 import 的 CSS、根级 locale |
| `component-patterns.md` | `PagedTable` / `PartListShell` / `FileListCard` 等通用壳怎么用 |
| `responsive-and-layout.md` | 桌面端为主、`/scan/*` 全屏大屏、桌面断点阈值 |

## 主题色一览

| 名称 | hex | 用途 |
| --- | --- | --- |
| 藏青主色 | `#1e4d8b` | 主按钮、链接、激活态、品牌色 |
| 蓝色辅色 | `#2c6cb8` | hover 态、侧栏激活底色 |
| 浅蓝 | `#4a8fd6` | light-3 衍生、图标点缀 |
| 极浅蓝背景 | `#eaf2fb` | light-9，标签底色 / 提示背景 |
| 内容区灰 | `#f5f7fa` | 页面背景 |
| 卡片白 | `#ffffff` | 卡片 / 弹窗 / 表格底 |

## EP 主色覆盖对照

项目主色 `#1e4d8b` 通过 CSS 变量覆盖注入 EP，**不走 `el-config-provider` 的 theme prop**（EP 2.14.x 还没有）。覆盖在 `src/styles/variables.scss` 的 `:root` 块：

| 项目主色 | 对应 EP CSS 变量 |
| --- | --- |
| `#1e4d8b` | `--el-color-primary` |
| `#4a8fd6` | `--el-color-primary-light-3` |
| `#7eb0e3` | `--el-color-primary-light-5` |
| `#b3d0ee` | `--el-color-primary-light-7` |
| `#cce0f4` | `--el-color-primary-light-8` |
| `#eaf2fb` | `--el-color-primary-light-9` |
| `#163b6e` | `--el-color-primary-dark-2` |

EP 所有引用 `var(--el-color-primary*)` 的组件（按钮、switch、checkbox、radio、tag、pagination、排序激活态等）会自动跟随这一套覆盖值。完整令牌清单与改色流程见 `design-tokens.md`。
