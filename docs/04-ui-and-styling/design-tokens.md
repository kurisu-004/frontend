# 设计令牌

> **目标读者**：新人 / Agent
> **核心价值**：项目所有颜色 / 字号 / 圆角 / 阴影在哪、怎么改、对应哪些 EP CSS 变量
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

所有令牌都集中在 `src/styles/variables.scss` 的 `:root` 块，以 CSS 自定义属性形式存在。组件中用 `var(--primary-color)` 引用，禁止写死 hex。本文件按用途分类列清单 + EP CSS 变量覆盖关系。

## 主题色

| 令牌 | hex | 用途 |
| --- | --- | --- |
| `--primary-color` | `#1e4d8b` | 主按钮、链接、激活态、品牌色（藏青） |
| `--primary-light` | `#2c6cb8` | hover 态、侧栏激活底色 |
| `--primary-lighter` | `#4a8fd6` | 浅蓝点缀 |
| `--primary-bg` | `#eaf2fb` | 极浅蓝背景（提示 / tag） |
| `--sidebar-bg` | `#1a3a6b` | 侧边栏背景（深藏青） |
| `--sidebar-hover` | `#234a82` | 侧栏 hover 底 |
| `--sidebar-active-bg` | `#2c6cb8` | 侧栏激活底 |

## 中性色

| 令牌 | hex | 用途 |
| --- | --- | --- |
| `--white` | `#ffffff` | 卡片、表格底、弹窗 |
| `--header-bg` | `#ffffff` | 顶栏 / 表头底 |
| `--content-bg` | `#f5f7fa` | 页面级灰底 |
| `--border-color` | `#e4e7ed` | EP 默认边框 |
| `--text-primary` | `#1f2d3d` | 标题 / 主文 |
| `--text-regular` | `#4a5568` | 正文 |
| `--text-secondary` | `#909399` | 辅助说明 |
| `--sidebar-text` | `#cfdcef` | 侧栏文字 |
| `--sidebar-text-active` | `#ffffff` | 侧栏激活文字 |

## 功能色

EP 的 success / warning / danger / info **不重写**，沿用 EP 默认（绿 / 黄 / 红 / 灰）。涉及功能色的场景：

- 成功：EP 默认 `--el-color-success`（`#67c23a`）
- 警告：EP 默认 `--el-color-warning`（`#e6a23c`）
- 危险：EP 默认 `--el-color-danger`（`#f56c6c`）
- 信息：EP 默认 `--el-color-info`（`#909399`）

不要在项目里自己造一套红 / 黄 / 绿，全部走 EP。

## 字号

| 用途 | px |
| --- | --- |
| 辅助说明 / tag | 12 |
| 正文 / 表格 / 表单 | 14 |
| 次级标题 | 16 |
| 卡片标题 / 主按钮 | 18 |
| 页面小标题 | 20 |
| 页面主标题 | 24 |
| 大屏 HMI 标题 | 32 |

字号直接写 px（不抽 CSS 变量），与 EP 默认对齐。需要新增档位时按上表递增 +2px / +4px 的节奏，避免碎档。

## 圆角

| 令牌 / 用法 | px |
| --- | --- |
| 输入框 / 按钮 / tag | 4 |
| 卡片 / 弹窗 | 8 |
| HMI 大卡片 | 12 |

EP 默认圆角变量 `--el-border-radius-base` = 4px，全局生效；卡片圆角在 `index.scss` 用 8px 覆盖。

## 阴影

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--shadow-sm` | `0 2px 4px rgba(0, 0, 0, 0.04)` | 卡片轻浮起 |
| `--shadow-md` | `0 2px 8px rgba(30, 77, 139, 0.08)` | 弹窗 / 抽屉 |

弹窗默认阴影走 EP 自己的 `--el-box-shadow`，只在需要更轻的自定义卡片里用上面这俩。

## EP CSS 变量覆盖清单

这是项目色注入 EP 的关键映射。修改主色必须**同步**更新 `--primary-color` 和 `--el-color-primary` 两个，否则 EP 组件仍走默认蓝。

| 项目令牌 | EP CSS 变量 | hex | 作用 |
| --- | --- | --- | --- |
| `--primary-color` | `--el-color-primary` | `#1e4d8b` | 主按钮、激活态、复选框 |
| `--primary-lighter` | `--el-color-primary-light-3` | `#4a8fd6` | hover / focus 浅一档 |
| — | `--el-color-primary-light-5` | `#7eb0e3` | 中间档（disable 接近） |
| — | `--el-color-primary-light-7` | `#b3d0ee` | 浅背景底色 |
| — | `--el-color-primary-light-8` | `#cce0f4` | 选中行底（`index.scss` 显式用 `#cce0f4` 覆盖 el-table） |
| `--primary-bg` | `--el-color-primary-light-9` | `#eaf2fb` | 最浅提示底 |
| — | `--el-color-primary-dark-2` | `#163b6e` | active 按下 / 激活态更深 |

改色流程：

1. 打开 `src/styles/variables.scss` 的 `:root` 块。
2. 同时更新 `--primary-color` 和 `--el-color-primary`（以及 light-3 / dark-2 的衍生）。
3. 跑 `npm run dev` 看主按钮、tag、复选框、选中行是否全部跟随。
4. 不要再去碰 `src/styles/index.scss` 顶部的 `@forward` —— 那是死代码（无 `@use` 消费者，已删）。

## 字族栈

`src/styles/index.scss` 顶部定义：

```scss
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
  'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
```

栈顺序：

1. `-apple-system` / `BlinkMacSystemFont` —— macOS 原生
2. `'Segoe UI'` —— Windows
3. `'PingFang SC'` / `'Hiragino Sans GB'` —— macOS 中文
4. `'Microsoft YaHei'` —— Windows 中文
5. `sans-serif` —— 兜底

不要在组件内覆盖 font-family，除非该组件是 HMI 大屏标题（用 32px + 加粗）。
