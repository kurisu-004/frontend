# 框架陷阱登记（Element Plus / vue-draggable-plus）

> **目标读者**：Agent / 前端开发
> **核心价值**：已踩过并修复的框架级陷阱——不是「依赖有漏洞」，而是「按直觉写就会错」的行为。写相关代码前先扫一眼本文。
> **最后更新**：2026-08-27 · **维护者**：@frontend-team

---

本文档登记 Element Plus / 拖拽库中**反直觉、且已实际造成线上报错**的行为。每条都附现象 / 机制 / 规则 / 出处。与 `dependency-risks.md`（依赖 CVE）、`security-and-ops.md`（安全运维）分工不同：这里记的是**框架语义坑**。

## 1. el-table 列插槽会被「合成空行」额外渲染一次

### 现象

`/parts` 页面控制台报 `[Vue Router warn]: No match found for location with path "/parts/undefined"`，但列表数据里**没有任何 `id` 为空的行**（`PartListItem.id` 是必填 string），接口甚至返回 500、`items` 为空数组时依然报。

### 机制

`ElTableColumn` 自己的渲染函数会用**合成空行** `{ row: {}, column: {}, $index: -1 }` 调用每一列的 `#default` 插槽，并把结果挂进 el-table 内部的 `<div class="hidden-columns">`（视觉上隐藏，但**真的挂载了组件**）。出处：

```
node_modules/element-plus/es/components/table/src/table-column/
  index.vue_vue_type_script_setup_true_lang.mjs:97-115
```

它对插槽返回的子节点做过滤，只排除两类：`patchFlag === 1024` 的、以及 `children` 是字符串的。于是：

- `<template v-else>` 会编译成 **Fragment**（patchFlag 64），进入 `forEach` 逐个检查子节点；
- 其中带**动态绑定**的组件（如 `:to` 动态的 `<router-link>`）patchFlag 是 **1032**（`PROPS | DYNAMIC_SLOTS`），既不等于 1024、children 也不是字符串 → **被放行并真的挂载**；
- `RouterLink` 的 `setup` 里就会跑 `useLink()` → `router.resolve()`，此时 `row.id` 是 `undefined`，拼出 `/parts/undefined`，而路由约束是 `parts/:id(\d+)`（`src/router/index.ts`），匹配不上 → 告警。

### 规则

**在 el-table 列插槽里，任何依赖 `row.xxx` 的动态绑定组件都要加空值守卫。**

```vue
<!-- ✅ 正确 -->
<router-link v-if="row.id" :to="`/parts/${row.id}`" class="name-link">{{ row.name }}</router-link>
<span v-else>{{ row.name }}</span>

<!-- ❌ 会在 .hidden-columns 里以 row={} 挂载一次 -->
<router-link :to="`/parts/${row.id}`" class="name-link">{{ row.name }}</router-link>
```

**不要**用「把 `<template v-else>` 换成 `<span v-else>` 让 EP 的过滤器丢掉整棵子树」这种绕法——那是依赖 EP 内部 patchFlag 判断的实现细节，EP 升级即回归。

### 已修 / 待留意

- 已修：`src/views/parts/components/PartsTable.vue` 名称列（2026-08-27，commit `8447b46`）。
- **待留意**：同文件的**操作列**是同形的 `<template v-else>` Fragment，同样会被合成空行渲染进 `.hidden-columns`。当前无害，因为 ① 按钮只有 `@click`、没有内联读 `row.xxx` 的渲染输出，且 `.hidden-columns` 不可点击；② `canRecallToPending` / `canRecallToProgramming` 对 `{}` 容错；③「下发」按钮的 `v-if` 含 `row.status === 'PENDING'`，空行下直接 false。**今后往该列加 `router-link` 或任何依赖 `row.xxx` 的内联表达式时，必须套用上面的守卫。**
- 同类可疑点（暂未触发，改动时留意）：`src/views/delivery/components/DeliveryNoteLineItemsTable.vue` 的链接在 `v-if="row.is_asm_row"` 下，空行时恰好为 false 才没炸。

## 2. vue-draggable-plus 的 `useDraggable` 会在挂载时对 null 元素建 Sortable

### 现象

进入 `/workers/queue` 控制台连报三条，且「工人列 → 工序池」的回退拖拽**完全失效**：

```
[vue-draggable-plus]: Root element not found
[Vue warn]: Unhandled error during execution of mounted hook at <PoolDrawer pool=null>
Uncaught (in promise) Sortable: `el` must be an HTMLElement, not [object Null]
```

### 机制

`useDraggable` 的 `immediate` 选项**默认 `true`**，内部注册 `onMounted(() => start())`。而 `start()` 解析 el ref 为 null 时，只是先 `console.error("Root element not found")`，**随后照样执行 `new Sortable(null, opts)`** → 抛错。出处（`vue-draggable-plus@0.6.1`）：

```
node_modules/vue-draggable-plus/dist/vue-draggable-plus.js
  :1383       immediate 默认 true
  :1470       el 为 null 时只 console.error，不 return
  :1486       仍然 new Sortable(null, ...) → 抛错
  :1506-1508  onMounted(() => immediate && start())
```

所以只要容器在 `v-if` 内、或是 el-table 的 `tbody`（需查询才拿得到）、或是 `<el-dialog destroy-on-close>` 关闭后重建的节点，挂载瞬间 ref 必为 null → 必抛。

### 规则

| 场景 | 用哪个 |
|---|---|
| 容器在 `v-if` 内 / el-dialog `destroy-on-close` 后重建 / el-table `tbody` 需查询才拿得到 | **`useLazyDraggable`**（`src/composables/useLazyDraggable.ts`） |
| 容器在组件挂载时已无条件存在 | 直接 `useDraggable` |

`useLazyDraggable` 强制 `immediate: false`，改由 `watch(elRef, el => el && start(el), { flush: 'post' })` 在 ref 转为非 null 时绑定；ref 换成新节点时会自动重绑（`start()` 内部先 destroy 再 new，不会泄漏）。**给 ref 赋值就是重绑的触发条件，不需要再手动调 `start()`。**

### 当前 5 个调用点（2026-08-27）

- `useLazyDraggable`：`PoolDrawer.vue`、`usePartBatchPdf.ts`（×2）、`PrintPreviewDialog.vue`
- 裸 `useDraggable`：`WorkerColumn.vue`（容器是 `el-card` 默认插槽的无条件子节点）、`useColumnDrag.ts`（由 `PartListShell.vue` 在 `onMounted` 里传入已解析的 `thead`）

### 历史教训

引入本坑的是 `3bfc122 merge: feature/vue-draggable-plus-migration`——那次把 4 个拖拽点从 sortablejs 迁到 vue-draggable-plus，其中 **3 个都留了「挂载时 ref 为 null」的隐患**，且 `PrintPreviewDialog.vue` 当时的注释还写着「tbodyRef 保持 null，useDraggable 自动忽略」，是**错的**（实际会抛）。修复见 `2dd5848 merge: fix/lazy-draggable-mount`。

## 3. el-splitter-panel 的 `size` 裸数字是像素，不是百分比

### 现象

`WorkerQueueBoard.vue` 写 `:size="30"` / `:size="70"`，页面**看起来**是 30% / 70% 分栏——但那是巧合。

### 机制

`size` / `min` / `max` 都接受「像素或百分比」（官方 API 表述），**裸数字 = px**。原写法之所以看着对：两个面板都显式给了 size，`useSize` 走归一化分支把 `[30/W, 70/W]` 按 `scale = 1/totalPtg` 放大，刚好还原成 `[0.3, 0.7]`。出处：`node_modules/element-plus/es/components/splitter/src/hooks/useSize.mjs:31-33`（裸数字按 px）与 `:39-42`（归一化分支）。

一旦只有一个面板给 size，或改成三栏，这个巧合立刻失效。

### 规则

- 想要比例 → 写成字符串百分比：`size="30%"`（纯属性，**不是** `:size="'30%'"`）。
- 想要固定像素下限 → `min` 用裸数字即可：`:min="240"` 就是 240px。官方基础用法示例正是 `size="30%"` 配 `:min="200"` 这种混写。

已修：`src/views/workers/WorkerQueueBoard.vue`（2026-08-27，commit `f73afd4`）。

## 相关文档

- [`docs/04-ui-and-styling/element-plus-integration.md`](../04-ui-and-styling/element-plus-integration.md) —— EP 按需加载 / 命令式 API CSS / locale / 主题色
- [`docs/02-architecture/state-management.md`](../02-architecture/state-management.md) —— composable 单例模式（`useLazyDraggable` 遵循同一约定）
