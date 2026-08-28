# 框架陷阱登记（Element Plus / vue-draggable-plus）

> **目标读者**：Agent / 前端开发
> **核心价值**：已踩过并修复的框架级陷阱——不是「依赖有漏洞」，而是「按直觉写就会错」的行为。写相关代码前先扫一眼本文。
> **最后更新**：2026-08-28（第 6 节 dummy-auth env 化）· **维护者**：@frontend-team

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
- 裸 `useDraggable`：`WorkerColumn.vue`（容器是 `el-card` 默认插槽的无条件子节点）；`useColumnDrag.ts` 内部用 `useDraggable(..., { immediate: false })`，由 composable 自管的 `inner.start(el)` / `inner.destroy()` 在同步栈外的回调里驱动——并非「挂载时 ref 必有值」场景，单独一类

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

## 4. el-table 列拖动：DOM 解析职责收回 composable，consumers 一行 `applyDrag(tableRef)`

### 现象（两轮返工的根因）

2026-08-27 第一轮重写把 `useDraggable` 绑到 `<thead>` → sortablejs 把 `<thead>` 的直接子 `<tr>` 算成 sortable item → 拖的是整行表头。改成绑表头 `<tr>` 后又埋了两个新的失效机制，直到 2026-08-28 第二轮重写才彻底拆掉：

- **机制 A · EP 重建表头**：el-table 数据从「空数组」变「有数据」时，EP 会把表头 DOM 整体重建（旧 `<tr>` 从 DOM 树移除），Sortable 实例仍留在旧节点上 → 拖动完全失效。
- **机制 B · 表头尚未渲染即调用 `applyDrag`**：consumer 写法是 `onMounted(() => drag.applyDrag(findElTableHeaderRow(tableRef.$el)))`。`onMounted` 同步跑时 EP 的表头 `<tr>` 还没渲染出来（EP 是异步 layout），`findElTableHeaderRow` 返回 `null` → consumer 的 null 守卫直接跳过 → **压根没绑定**。实证对照：`WorkerList` / `ApplicantList` 能拖，只因为它们的 `onMounted` 里先 `await fetchList()` 再绑；`ProcessList`（`void fetchList()`）、`UserList` / `OutsourceList`（数据由 `<PagedTable>` 内部异步拉）全部失效。

### 机制（2026-08-28 重写后的最终架构）

DOM 解析职责**完全收回 `useColumnDrag` 内部**，consumer 侧不再需要任何 `findElTableHeaderRow` 调用、null 守卫、派生 `headerRowRef`、手写 watcher。

- **新 `applyDrag` 接受三类 target**（运行时判定顺序）：
  1. 任意 Vue ref（el-table 组件实例 ref / `Ref<HTMLElement | null>` / `ref()` 无参 都行）——**首选**；
  2. 裸组件实例（`tableRef.value`，带 `$el`）；
  3. 裸 HTMLElement（兼容旧一次性签名）。
- **归一化路径**：ref → 取 value → 判 `$el` → `closest('.el-table') ?? $el`；元素自身匹配 `.el-table` 用自身，否则 `closest('.el-table')`；mock DOM 没有包装时退化为元素自身。
- **自愈重绑**：在 `.el-table` 根上挂 `MutationObserver`，**只监听 `childList + subtree`，不监听 `attributes`**——EP 频繁改 `<th>` 的 class/style（排序状态、fixed 偏移、hover），监听 attributes 会触发重绑风暴甚至死循环。表头首次出现 / EP 重建 / dialog 重开都会自动 `destroy 旧 + start 新`，不需要 consumer 介入。
- **`useDraggable` 必须在 `applyDrag` 同步栈内创建**：vdp 的 `dist/vue-draggable-plus.js:1357-1362` 把 `onUnmounted` 注册包装成 `dt() && sn(t)`（`dt` = `getCurrentInstance`），无 instance 时**静默丢弃**——不报错，但 Sortable 不会被回收；`onMounted` 那层则降级为 `nextTick`，**也会打「onMounted is called when there is no active component instance」警告**。所以 `useColumnDrag` 用内部占位 ref 作 target + `immediate: false` 创建一次 `useDraggable`，后续 `rAF` / observer 回调里只调 `inner.start(newTr)` / `inner.destroy()`——这两个内部实现都是 `a && X.destroy(); a = new p(v, j())`，不依赖 Vue 生命周期上下文，异步栈里安全。
- **绑的是表头 `<tr>`、限定 `th.col-draggable`**：sortablejs 的可排序子元素得是 `<th>`（绑 `<thead>` 会变成「整行可拖」）。`draggable: 'th.col-draggable'` 把不可拖列（`th.gutter` / `type=selection|index|expand` / `fixed=left|right` / 显式 `draggable:false`）从索引序列里剔掉，`filter: '.col-no-drag'` 双保险。可拖列必须由 `dragLabelClass(d)` 打 `col-draggable` + `col-key-<key>`，落到 `<th>` 的 class（EP 2.14.2 `table-header/style.helper.mjs:42` 把 `column.labelClassName` 拼进 `<th>`）。
- **拖动列表绑子序列、onEnd 合并回全量**：内部 `dragKeys` 只含当前实际渲染的可拖列；onStart 从 DOM `th.col-draggable` 同步 + 快照 `subSet`；onEnd 按槽位合并 `orderedKeys.map(k => subSet.has(k) ? newSub[i++] : k)`（隐藏列 / 不可拖列锚定原槽位）。长度不匹配 → `console.warn` 且不写盘。

### 规则

**Consumer 只需要做四件事**：

```ts
// 1. 创建 useColumnDrag
const drag = useColumnDrag(columnDefs, { listKey: 'parts_list' })

// 2. 把 el-table 组件 ref 传给 applyDrag（其他什么都不用）
const tableRef = ref<InstanceType<typeof ElTable>>()
onMounted(() => drag.applyDrag(tableRef))
```

```vue
<!-- 3. 列 v-for 必须绑 :label-class-name（不打 col-draggable 就不在 sortablejs 索引里） -->
<el-table ref="tableRef" :data="items" v-loading="loading" ...>
  <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
    <el-table-column
      v-if="columnVisibility.isVisible(d.key)"
      :prop="d.prop ?? d.key"
      :label="d.label"
      :column-key="d.columnKey ?? d.key"
      :label-class-name="drag.dragLabelClass(d)"
      ...
    >
      <!-- 4. #header 插槽放 <ColumnDragHandle /> 让 handle 抓得到 -->
      <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
        <span>{{ d.label }}</span>
        <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
      </template>
    </el-table-column>
  </template>
  <!-- fixed="right" 操作列保留为字面量 <el-table-column>：dragLabelClass 会自动打 col-no-drag -->
</el-table>
```

### 常见踩点 / 必须避免的写法

| 反例 | 为什么错 |
|---|---|
| `drag.applyDrag(findElTableHeaderRow(tableRef.$el))` | consumer 自己解析 DOM + 一次性签名。命中机制 B（表头未渲染 → null → 不绑）；后续 EP 重建 → 旧 Sortable 泄漏。 |
| `const headerRowRef = ref<HTMLElement \| null>(null); watch(...) { ... if (tr) headerRowRef.value = tr }; drag.applyDrag(headerRowRef)` | consumer 派生 ref + 手写 watcher。把 composable 该做的 DOM 解析 + 自愈重新发明一遍，且 `headerRowRef.value` 赋值时机对不上 EP layout → 仍是机制 B。 |
| `drag.applyDrag(theadRef)`（直接绑 `<thead>` ref） | 绑错容器：sortablejs 把 `<thead>` 的直接子 `<tr>` 算 sortable item → 拖整行表头。 |
| 列只写 `prop / label`，不写 `:label-class-name="drag.dragLabelClass(d)"` | sortablejs 的 `draggable: 'th.col-draggable'` selector 永远匹配不到 → 拖动完全不工作。这是「列能被拖」的**必要条件**。 |

### 新增列拖动的 Checklist

- [ ] `useColumnDrag(columnDefs, { listKey: '..._columnOrder' })` 创建实例（`listKey` 拼到 localStorage key 上，含 user.id 后缀，多账号隔离）
- [ ] `drag.applyDrag(tableRef)` —— **直接传 el-table 组件 ref**，**不要**自己解析表头 DOM
- [ ] 列 `v-for` 绑 `:label-class-name="drag.dragLabelClass(d)"`（必要条件）
- [ ] 列的 `#header` 插槽里放 `<ColumnDragHandle />`（提供 handle；不放也能拖但抓取区只有单元格文字）
- [ ] 不可拖列（`type=selection|index|expand` / `fixed=left|right` / 显式 `draggable:false`）会被 `dragLabelClass` 自动打 `col-no-drag`，**不用**手写
- [ ] 不要自己写 `findElTableHeaderRow` / 派生 `headerRowRef` / 手写 watcher / 二次 `findElTableHeaderRow` 重绑

### 与硬约束 #10 / 第 2 节的关系

- 第 2 节 / 硬约束 #10 解决「setup 期 ref 为 null 崩溃」（通用拖拽点用 `useLazyDraggable`）。
- 本节专门处理「**列拖动的特殊载体 = 表头 `<tr>`**」：DOM 必须由 composable 解析（机制 A/B），**消费者一行 `applyDrag(tableRef)` 即可**——不要把第 2 节的 `useLazyDraggable` 套到列拖动上（`useLazyDraggable` 只覆盖 setup 期 null，不覆盖机制 A 的 EP 重建）。
- `useColumnDrag` 内部仍用 `useDraggable(..., { immediate: false })`，由 composable 自管的 `inner.start(el)` / `inner.destroy()` 在同步栈外的回调里驱动——单独一类使用方式，但目的完全不同（vdp 的 lifecycle 注册需要 currentInstance；构造时一次创建、运行时只调 start/destroy 规避无 instance 时的静默丢弃）。

### 待办（已知 trade-off，本次未动）

- `dragLabelClass` 只对拼接结果整体 `.trim()`，自定义 `labelClassName` 带内部多余空格时 class 串会留多余空格（不影响功能）。后续可换成「先 split → filter(Boolean) → 再 join」的健壮实现。
- `applyDrag` 的 ref 路径当前走 `flush: 'post'` watch + observer 双重保险。理论上单一路径（只 observer）也能覆盖，但实测 `ProcessList` 这类「setup 期拿到实例、实例 $el 已挂、表头尚未 layout」的过渡态需要 post-flush watch 兜底——保留双重不简化。

## 5. `h()` 给原生元素 / 字符串 type 传 children 的两种坏写法

### 现象（独立 bug，与列拖动无关，同批修复）

2026-08-27 全仓修复 127 处（20+ 文件，`cellRender` / `headerRender` 都有）。表现是**表格数据列整片空白**——表头与字面量列（`type=selection|index`）正常渲染，所以特别容易漏看（看上去「行渲染了，列也在，就是单元格内容没出来」）。`v-if` 命中分支也会静默失效。

### 机制：两种独立坏法

#### A. `h('<原生小写标签>', props, () => X)` —— 函数 children 被当 slots

```ts
// ❌ 坏：h('span', props, () => X)
function cellRender({ row }: { row: Part }) {
  return h('span', { class: 'name' }, () => row.name)   // 渲染为空
}
```

Vue 3 的 `normalizeChildren` 看见第三参是函数，会把它打成 **`SLOTS_CHILDREN`** 标记；`mountElement` 派发时**只处理 `TEXT_CHILDREN` / `ARRAY_CHILDREN`**，命中 `SLOTS_CHILDREN` 的分支什么都不做——元素本身被 patch 出来但里面是空的，console 也不告警。

- ✅ 正确：第三参直接传值（字符串 / 数组 / VNode）：
  ```ts
  return h('span', { class: 'name' }, row.name)
  ```
- ✅ 正确：组件用法 `h(ElTag, props, () => X)` 是**对的**——函数 children 走的是组件 slot 分发路径，不经过 `mountElement`。
- ⚠️ 多行 / 数组写法务必先提取局部变量再传入：
  ```ts
  const children = [h('span', null, row.name), h('em', null, row.unit)]
  return h('div', { class: 'cell' }, children)   // 别写 h('div', { class: 'cell' }, () => [...])
  ```

#### B. `h('router-link', ...)` —— 字符串 type 不做组件解析

```ts
// ❌ 坏：h('router-link', props, X)
return h('router-link', { to: `/parts/${row.id}` }, row.name)
// 渲染为 <router-link> 字面自定义元素 —— 没 props 分发、没 router 行为，
// 看起来「标签出来了但点击不跳转 / 样式没生效」。
```

`h()` 第一个参数传字符串时 **不做组件解析**——它把 `router-link` 当成字面自定义元素渲染。Vue 模板编译器对 `<router-link>` 这种 kebab-case 标签会自动 resolve 成 `RouterLink` 组件，但 `h()` 走的是纯 createVNode 路径，没有这层映射。

- ✅ 正确：传导入的组件本身：
  ```ts
  import { RouterLink } from 'vue-router'
  return h(RouterLink, { to: `/parts/${row.id}` }, () => row.name)  // 函数 children 在组件 slot 里合法
  ```
- 同理：`h('el-button', ...)` 也是坏的，必须 `h(ElButton, ...)`。
- ⚠️ 反过来：组件用法 `h(RouterLink, ..., () => row.name)` 里的函数 children **是合法的**（与 A 的「原生元素」区别开）——守卫单测只针对原生小写标签，不误伤组件写法。

### 规则

| 写法 | 状态 |
|---|---|
| `h('span' / 'div' / 'td' / ..., props, value)` | OK（值 / 数组） |
| `h('span' / ..., props, () => X)` | **坏**：原生元素函数 children → 渲染为空 |
| `h(ElXxx / RouterLink / ..., props, value 或 () => X)` | OK（组件的 slots 走分发路径） |
| `h('router-link' / 'el-button' / ...)`（任何 kebab-case 字符串） | **坏**：字符串 type 不做组件解析 |

### 回归守卫

`src/composables/__tests__/nativeVnodeChildren.spec.ts` —— 单测扫 `src/**/*.{vue,ts}`，断言不存在 `h('<原生小写标签>', <props>, () => ...)` 形态，命中即失败。算法关键点：

- 只挑「单段小写字母 + 数字」的 tag（`/^[a-z][a-z0-9]*$/`）——含 `.` 的命名空间组件、含 `-` 的 kebab-case 自定义元素**放过**（后者不是 B 的检测目标，但与 A 的「传函数 children 是合法 slot」区分开）；
- 跟踪 `h(...)` 这一层的括号 / 方括号 / 大括号配平，定位「顶层逗号」位置，再判断其后第一个非空白 token 是不是 `() => ...`；
- props 里出现的 `() =>`（事件处理器、computed）是大括号内的，不算 children 位置。

> 注意：本守卫**只覆盖 A**。B（`h('router-link', ...)`）目前在仓里已修干净，但**没有自动守卫**——新增 cellRender 时如果第一参是字符串且不是单段小写 HTML 标签，自查一下是不是该传组件对象。

### 已修清单（2026-08-27 当天合并）

全仓 127 处修复，覆盖 20+ 文件（parts / delivery / outsource / repair / settings / shelves / workers / statistics / parts-list 域的 `cellRender` + `headerRender`）。

## 6. Vite 8 下裸全局 `define` 在 dev client 不替换，dev-only 开关要走 `import.meta.env` + mode/env 文件

### 现象

`npm run dev:dummy`（旧实现：`vite -- --dummy-auth`，靠 `define: { __DUMMY_AUTH__: 'true' }` 注入）起来后浏览器**卡登录页**——但 `curl http://localhost:5173/src/main.ts` 拿到的源码里 `if (__DUMMY_AUTH__)` 这一行**仍是裸标识符**，运行时是 `ReferenceError`。prod build 正常（define 替换发生在 bundle 阶段）。

### 机制

Vite 8.0.16 的 define 插件（`node_modules/vite/dist/node/chunks/node.js:23052` 附近）在 transform handler 开头就 `if (this.environment.config.consumer === "client") return`——dev client 不走 bundled 路径，**裸全局 define 在 dev 下彻底不替换**。只有 `import.meta.env` 在 dev 下由运行时（Vite dev server 注入到 `window` / 模块顶）正常提供，是可靠面。

附加问题：旧 `vite.config.ts` 把配置写成静态 `export default defineConfig(config)`、`config()` 无参，配置求值期拿不到 vite 传入的 `mode` / `command`，只能靠 `process.env.NODE_ENV` 判定——这把「build 期硬 throw」那道保护也变成不可靠：build 阶段 `NODE_ENV` 通常是 `production`、dev 下又是 `development`，但被外部脚本 / 包装层改写后就失效。

### 规则

dev-only 开关**必须**走 Vite 官方 env 机制：

1. 加 `.env.dummy`（提交进仓），内容 `VITE_DUMMY_AUTH=true`。Vite 默认只忽略根 `.env`，`.env.dummy` 不会被忽略。
2. `package.json`：`"dev:dummy": "vite --mode dummy"`（干净的 mode 机制；不要 `vite -- --dummy-auth`，cac 拒绝未知 flag：`CACError: Unknown option --dummyAuth`）。
3. `vite.config.ts` 改函数形式拿 `{ command, mode }`，用 `loadEnv(mode, process.cwd(), '')` 读出 `VITE_DUMMY_AUTH`；`command === 'build' && env.VITE_DUMMY_AUTH === 'true'` 主动 throw（防住「`.env.production` 误设」「`--mode dummy build`」两种场景）。
4. 客户端代码读 `import.meta.env.DEV && import.meta.env.VITE_DUMMY_AUTH === 'true'`——`import.meta.env.DEV` 是第二道 prod 保险（prod build 永远是 false，整段 tree-shake），`=== 'true'` 防住空字符串 / `'false'` / 数字字面量。
5. 判定逻辑收敛到 `useAuthSession.isDummyAuthRequested()` 一个模块级函数，main.ts / router / useAuthSession 内部共享，避免漂移。
6. 成功注入后 `console.info('[dummy-auth] ...')` 一行作为浏览器侧确认标记（仅 dev，prod tree-shake）。

### 已修 / 当前机制（2026-08-28）

- `.env.dummy` 新增；`package.json` `dev:dummy` 改 `vite --mode dummy`；`vite.config.ts` 改函数形式 + `loadEnv` 判定；`src/env.d.ts` 加 `VITE_DUMMY_AUTH?: string`；`useAuthSession.ts` / `main.ts` 收敛到 `isDummyAuthRequested()`。
- 三层 prod 保护：build + `VITE_DUMMY_AUTH=true` 硬 throw / `import.meta.env.DEV` guard + `VITE_DUMMY_AUTH === 'true'` 双判定 / 不写 localStorage。
- 回归单测：`src/composables/__tests__/useAuthSession.dummy.spec.ts` 用 `vi.stubEnv('VITE_DUMMY_AUTH', 'true')` 走通注入路径 + 两条不注入路径（未设 / 显式 `'false'`）。
- 第一道 throw 的 curl 验证：`npx vite build --mode dummy` 必须 throw，正常 `npm run build` 通过。

**2026-08-28 补记：路由守卫短路 ≠ 全链路短路。** dummy 模式下 `router/index.ts` 的
`beforeEach` 已用 `isDummyAuthActive()` 跳过 `refreshOrLogout`，但
`MainLayout.vue` 的 `onMounted` 仍自行调 `apiMe()` 刷新顶栏用户——dummy token
被后端拒（40101）后 catch 分支 `router.replace('/login')`，把守卫已放行的会话
踢回登录页。修复：组件侧同样先判 `isDummyAuthActive()`，短路时直接复用
session 里的假用户。回归守卫：`src/layouts/__tests__/dummyAuthMeGuard.spec.ts`。
教训：dummy/ mock 会话的短路要覆盖**所有**独立发起 `/auth/me` 的调用点
（守卫、布局、页面级 onMounted），不止路由守卫一处。

## 相关文档

- [`docs/04-ui-and-styling/element-plus-integration.md`](../04-ui-and-styling/element-plus-integration.md) —— EP 按需加载 / 命令式 API CSS / locale / 主题色
- [`docs/02-architecture/state-management.md`](../02-architecture/state-management.md) —— composable 单例模式（`useLazyDraggable` 遵循同一约定）
- [`docs/02-architecture/routing-and-permissions.md`](../02-architecture/routing-and-permissions.md) Dev Dummy Auth 段 —— dummy-auth 启用方式与三层保护说明
