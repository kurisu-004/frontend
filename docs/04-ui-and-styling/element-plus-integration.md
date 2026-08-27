# Element Plus 集成

> **目标读者**：新人 / Agent
> **核心价值**：EP 按需加载工作原理 + 命令式 API CSS 必 import + 中文 locale + 主题色覆盖的来龙去脉
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

Element Plus 2.7.x 在本仓库走纯按需自动加载（`unplugin-auto-import` + `unplugin-vue-components` + `ElementPlusResolver`），不做 `app.use(ElementPlus)` 全量注册。本文件解释这套机制的实际行为、边界条件、和历史教训。

## 按需加载工作原理

### 三个插件

`vite.config.ts` 注册：

- `unplugin-auto-import` — 扫描源码，自动注入 `ref` / `reactive` / `computed` / EP 命令式 API（`ElMessage` 等）的 import。
- `unplugin-vue-components` — 扫描 `<template>` 出现的标签，自动注册 EP 组件。
- `ElementPlusResolver` — 上面两个插件的 resolver，告诉插件 EP 的 API / 组件路径。

### resolver 只扫 `<template>`

**关键约束**：ElementPlusResolver 扫描的是 `<template>` 区域，**不会**扫描 `<script setup>`。

后果：

- `<el-button>` 在 template 里 → 自动 import 组件 + 自动 inject 该组件 CSS。
- `<script setup>` 里调 `ElMessage.success(...)` → resolver **看不到**，必须：
  - `auto-imports.d.ts` 会自动加 `ElMessage` 的类型声明（运行时也能调，因为 `unplugin-auto-import` 会扫 `<script>` 里的标识符）。
  - 但 **CSS 不会自动 inject**。这是 `src/main.ts` 手动 import 一堆 `el-*.css` 的根因（见下文）。

### 生成文件

两个插件各产一个 `.d.ts`：

- `src/auto-imports.d.ts` —— API 类型声明（`ref` / `ElMessage` 等）。
- `src/components.d.ts` —— 组件类型声明（`ElButton` 等）。

**这两个文件都提交到 git**（`.gitignore` 没排除），CI 类型检查依赖它们。换分支后如果 IDE 类型报错，先确认这两个文件存在 / 已更新。

### 生成时机

每次 `npm run dev` / `npm run build` 启动时基于当前源码全量重生成。新增 EP 组件 / 命令式 API 调用后，如果 IDE 类型没跟上，重启 dev server 或跑一次 `npm run build` 触发重生成。

## 命令式 API CSS 必 import

以下 API 的 CSS 必须**手动** import，路径在 `src/main.ts`：

| 命令式 API | 必须 import 的 CSS |
| --- | --- |
| `ElMessage` | `element-plus/theme-chalk/el-message.css` |
| `ElMessageBox` | `element-plus/theme-chalk/el-message-box.css` |
| `ElNotification` | `element-plus/theme-chalk/el-notification.css` |
| `ElLoading` | `element-plus/theme-chalk/el-loading.css` |
| 弹层遮罩 | `element-plus/theme-chalk/el-overlay.css` |

**不能删**。背景：2026-08-22 一次重构漏了这些 import，全站弹窗样式丢失（消息框落左上角、按钮纵向堆叠、标题被截）。修复方式就是恢复这五行 import + 加注释。

任何新引入的命令式 API（比如新版本可能新增的 `ElGuide` 之类）也要走同样的手动 import 流程，**不要假设 resolver 会自动处理**。

## 中文 locale

### 根级 `<el-config-provider>`

`src/App.vue` 根模板：

```vue
<el-config-provider :locale="zhCn">
  <router-view />
</el-config-provider>
```

`zhCn` 从 `element-plus/es/locale/lang/zh-cn.mjs` 直接 import（`<script setup>` 内的 ESM import）。

### 为什么下沉到 App.vue 而不是 main.ts

main.ts 是 side-effect 入口，下沉 locale 配置会让 locale 变成全局副作用；放在 App.vue 的 setup 里更显式，类型推导也更稳。`<el-config-provider>` 组件本身由 unplugin 自动注册，无需手 import。

## 主题色覆盖（CSS 变量路线）

### 为什么不走 EP theme prop

EP 2.14.x 还没有 `<el-config-provider :theme>` 这个 prop，官方文档（theming 章节）明确说明该特性在更晚版本才落地。本项目锁定的 EP 版本就是 2.14.x 一线（patch 版本浮动），目前**没有** theme prop 可以用。

### 当前做法

`src/styles/variables.scss` 的 `:root` 块直接重定义 EP 的 CSS 变量：

```scss
:root {
  --el-color-primary: #1e4d8b;
  --el-color-primary-light-3: #4a8fd6;
  --el-color-primary-light-5: #7eb0e3;
  --el-color-primary-light-7: #b3d0ee;
  --el-color-primary-light-8: #cce0f4;
  --el-color-primary-light-9: #eaf2fb;
  --el-color-primary-dark-2: #163b6e;
}
```

这一层覆盖 7 个 CSS 变量，覆盖范围：

- 主按钮、链接、激活态（`--el-color-primary`）
- 复选框 / radio / switch 选中色
- tag / 分页 / 排序激活
- 弹窗主按钮
- `el-table` 选中行（默认 light-9，本项目 light-8，见 `index.scss` 的 `.el-table__row.current-row` 显式覆盖）

### 历史教训：`@forward` 改主题色是死代码

2026-08-22 之前的 `src/styles/index.scss` 顶部有一段 `@forward 'element-plus/theme-chalk/...'` 试图覆盖 EP 主题色。**全仓 0 个文件 `@use '@/styles/index.scss'`**（EP 编译时不会主动消费 SCSS），那段覆盖是死代码 —— 浏览器根本不会拿到。最终改为 CSS 变量覆盖方案。

**新功能想调主题色，直接改 `:root` 块的 `--el-color-primary*` 系列，不要再写 `@forward`。** 这是历史教训，已形成约束。

## 全量注册移除历史

2026-08-21 commit `e26b7e4` 移除 EP 全量注册：

- 删除 `import 'element-plus/dist/index.css'`（全量 CSS）。
- 删除 `app.use(ElementPlus, ...)`（全量组件注册）。
- 删除 `main.ts` 里循环注册图标的 forEach（`@element-plus/icons-vue` 改为按需）。

切换到按需加载后，index chunk 从 1.1MB 降到 500kB 以下，首屏 JS 体积下降约 30%。改动背景详见 commit message。

## 常用组件速查

完整 API 以 [Element Plus 官方文档](https://element-plus.org/zh-CN/component/overview) 为准。下表只列本项目用过的关键 props / 注意事项。

### el-table

| 项 | 说明 |
| --- | --- |
| 列固定 | `:fixed="left\|right"`，左右可同时固定多个 |
| 排序 | `:default-sort` + `@sort-change`，server-side 模式自己处理 |
| 列筛选 | 列内 `column.filterDropdown` + `filters` / `filter-method` |
| 行选择 | `@selection-change` 拿 `selection[]` |
| 树形 | `:tree-props="{ children: 'children' }"` + `row-key` |
| 选中行色 | 全局已在 `index.scss` 提到 `#cce0f4`，带状态的行（`row-urgent` 等）由组件 `:deep()` 继续覆盖 |
| 大数据 | 默认不开虚拟滚动；> 1000 行考虑 `:virtual-scroll="true"`（见 `responsive-and-layout.md`） |
| ⚠️ 列插槽守卫 | EP 会用**合成空行** `{ row: {}, $index: -1 }` 额外渲染每列 `#default` 一次并挂进 `.hidden-columns`。插槽里依赖 `row.xxx` 的动态绑定组件（如 `:to` 动态的 `router-link`）**会真的挂载**，必须加 `v-if="row.id"` 之类的守卫。详见 [`08-known-risks/framework-pitfalls.md`](../08-known-risks/framework-pitfalls.md) |

### el-form

| 项 | 说明 |
| --- | --- |
| 校验 | `rules` + `formRef.value.validate()`，异步校验返回 Promise |
| 重置 | `formRef.value.resetFields()`，前提 `:model` 必须有初始值 |
| 嵌套 | 多组字段用 `<el-form-item :prop="\`list.\${i}.field\`">` |
| label-width | 统一 100px，跨行字段用 `label-position="top"` 改竖排 |

### el-dialog

| 项 | 说明 |
| --- | --- |
| v-model | 必传，控制显隐；关闭前可 `before-close` 拦截 |
| 拖拽 | `draggable` prop，EP 默认开启 |
| 全屏 | 业务统一用 `useDialogSize()` 静态桌面尺寸（避免响应式 dialog 抖动），不再用 `fullscreen` |
| 嵌套 | 弹窗里再开弹窗，append-to-body 慎用，常见于 picker 二级 |

### el-pagination

| 项 | 说明 |
| --- | --- |
| layout | 常用 `"total, sizes, prev, pager, next, jumper"`，按场景砍 |
| page-sizes | 默认 `[10, 20, 50, 100]` |
| server-side | `:current-page.sync` + `:page-size.sync`，触发 list 接口 |

### el-date-picker

| 项 | 说明 |
| --- | --- |
| value-format | 必传（`'YYYY-MM-DD HH:mm:ss'` 或 `'YYYY-MM-DD'`），不传拿 ISO 串 |
| daterange | `type="daterange"` + `range-separator="至"`，`value` 是 `[start, end]` 二元组 |
| shortcuts | 配置 `shortcuts: [{ text, value }]`，value 是函数返回 Date |

### el-tree

| 项 | 说明 |
| --- | --- |
| data | 直接传树结构 |
| props | `:props="{ label: 'name', children: 'children' }"` |
| node-click | `@node-click(node, data, ...)` |
| lazy | `:load="loadNode"` + `:lazy="true"`，按需加载子树 |
| 默认展开 | `:default-expanded-keys="[...]"` |
