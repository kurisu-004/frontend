# 状态管理：模块级 composable 单例

> **目标读者**：Agent 接手新模块、新人理解为何不写 Pinia store
> **核心价值**：解释"为什么项目装了 Pinia 却不用"以及如何正确放置共享状态
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 设计决策

`main.ts` 里 `app.use(createPinia())` 是仓库脚手架默认带的依赖。2026-09-15 之前项目从未创建过任何 `defineStore()`，所有跨组件、跨路由共享的状态都以**模块级 `ref` + composable 单例**承载。这是个反共识设计，但符合"跨页全局状态有限"的实际复杂度。

> **2026-09-15 修订**：用户批准 Pinia 3 setup store 用于「页面级复杂状态」（首例 `usePartsListStore`，`src/views/parts/composables/`）。开闸背景：parts 列表页 :ctx prop 模式三痛点：
> 1. 字段膨胀 —— 7 类 composable 切片 + 列定义 + 权限标识，单次 `defineProps<{ ctx: PartsListCtx }>()` 后顶层解构 7-8 个 ref/computed 已逼近 lint 心智负担上限；
> 2. 嵌套 ref 经 props（Vue `shallowReactive`）传递不解包 —— 子组件模板里 `ctx.batch.batchMode` 仍要 .value 解包，否则页面静默不更新；
> 3. IIFE 绕 `vue/no-setup-props-destructure` —— 出现大量 `(() => props.ctx)()` 噪声。
>
> Pinia setup store 返回深 `reactive()` 代理（对比 props 是 shallowReactive），嵌套 ref 自动解包，消费侧统一 `store.切片.字段` 路径访问、不写 `.value`。详见 CLAUDE.md 硬约束 #1 与本文末尾"何时该考虑 Pinia"。

页面级 store 的边界（页面级 vs 全局）见后文「页面级 vs 全局」表。新功能共享状态按以下规则二选一：

- **跨路由全局**（auth / 扫码 session / 扫码总线等）→ composable 模块级单例（详见后文 6 大 singleton 表）
- **页面级复杂状态**（≥ 3 个并列子组件共享同一组 composable 切片）→ Pinia setup store（就近放 `views/<域>/composables/useXxxStore.ts`）

不再"一律禁止 Pinia"。

## 模块级单例模式

模式非常简单——在 composable 文件**顶部**声明模块级 ref（普通工具函数外），导出 `useXxx()` 时返回这些 ref。任何调用方 `import { useXxx } from '@/composables/useXxx'` 后，操作的都是**同一份响应式状态**。

```ts
// src/composables/useScanSession.ts（节选）
import { ref, type Ref } from 'vue';
import type { Worker } from '@/types/worker';

// 模块级 state —— 文件被 import 一次就只有这一份
const worker = ref<Worker | null>(null);
const action = ref<WorkAction | null>(null);

export function useScanSession() {
  function setWorker(w: Worker | null) {
    worker.value = w;
  }
  function setAction(a: WorkAction | null) {
    action.value = a;
  }
  function reset() {
    worker.value = null;
    action.value = null;
  }
  // ...
  return {
    worker: worker as Ref<Worker | null>,
    action: action as Ref<WorkAction | null>,
    setWorker,
    setAction,
    reset,
    // ... 守卫函数
  };
}
```

调用方拿到的是响应式 ref：

```vue
<script setup lang="ts">
import { useScanSession } from '@/composables/useScanSession';
const { worker, action, setWorker } = useScanSession();
// worker 是 Ref<Worker | null>，组件里直接 v-bind 即可
</script>
```

这种写法的几个隐含好处：

- **HMR 友好**：模块级 ref 不依赖组件树，HMR 时如果 composable 文件改动，所有消费者不会丢状态（前提是模块没被 unload）。
- **测试方便**：直接在单测里 import composable，读写模块级 ref 即可断言。
- **零样板**：不用 `defineStore` / `storeToRefs`，不用纠结 Pinia 的 setup vs options 写法。

## 6 大全局 singleton 表

| composable                | 关键 state                                                             | 持久化                                           | 谁用                                        |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `useAuthSession`          | `user`, `token`, `refresh_token`                                       | localStorage `auth_session`                      | router 守卫、MainLayout、所有登录态判断     |
| `useScanSession`          | `worker`（工牌扫出的工人）、`action`（PICK_UP/RETURN/INSPECT/DELIVER） | 无（跨路由内存态）                               | `/scan/*` 5 个页面、`/delivery-dispatch/*`  |
| `useBarcodeScanner`       | `scanBuffer`、`lastScan`、`enabled`                                    | 无（监听器跟随模块单例）                         | 任何页面都能 `onScan(cb)` 订阅              |
| `useScanBus`              | `heldVersion`（自增信号）、`listeners` Set                             | 无（轻量事件总线）                               | HeldPartsBadge 等"持有件变化需重渲染"的组件 |
| `useActiveShelfSelection` | `selectedShelfId`、`options`、`selectedZone`                           | sessionStorage `active_shelf_selection:<userId>` | `/scan/*` 多架 SHELF_ACCOUNT                |
| `useDeliveryScanState`    | `l1CustomerId`                                                         | localStorage `delivery_scan_l1_v1`               | `DeliveryNoteScan.vue`（扫码建单页）        |

> 这 6 个 composable 是项目里**唯一**应该新增 / 修改全局状态的入口。其他看起来像状态但其实是组件级 prop 的（如 `currentDeliveryNoteId`），应该留在 `setup()` 内。

## 模块级 vs 组件级边界

判断一个 ref 应该放哪里的口诀：

- **跨组件 / 跨路由共享** → 模块级 ref（在 composable 文件顶部）
- **只在当前组件用** → setup 内 `ref()`（组件卸载即销毁）
- **父子组件单向流** → props / emit / `v-model`，别再开第三个口子

### 反例：不要用模块级 ref 当地方 store

```ts
// src/composables/useFooFilter.ts —— 反例
const filter = ref({ status: '', keyword: '' }); // 模块级，但只在一个页面用
export function useFooFilter() {
  return { filter };
}
```

这就是该用 setup 内 `ref` 却误用模块级单例的典型场景。组件卸载后这份状态还在，下次打开页面看到上次遗留的过滤值——大概率是 bug。

### 正例：跨页面 + 需要持久化 → composable + storage

```ts
// src/composables/useDeliveryScanState.ts（节选）
const KEY = 'delivery_scan_l1_v1';
const _l1CustomerId: Ref<string> = ref('');

export function useDeliveryScanState() {
  function init() {
    // 从 localStorage 读，覆盖初始空值
    const raw = localStorage.getItem(KEY);
    if (raw) _l1CustomerId.value = JSON.parse(raw).l1CustomerId;
  }
  function setL1CustomerId(id: string) {
    _l1CustomerId.value = id;
    localStorage.setItem(KEY, JSON.stringify({ l1CustomerId: id }));
  }
  return { l1CustomerId: _l1CustomerId, setL1CustomerId, init };
}
```

这种"模块级 + 持久化"的组合是项目里允许的——它有明确的"跨页面共享 + 退出页面仍要保留"的语义。

### 何时该考虑 Pinia

页面级 setup store 必须**同时满足三条**才考虑引入（与 CLAUDE.md 硬约束 #1 同源）：

1. **页面级**：状态只服务单个页面/路由，不跨页共享 —— 跨页用 composable 单例更简单。
2. **≥ 3 个并列子组件共享同一组 composable 切片**：列定义 / 行内编辑 / 批量选中 / 下发 / 打印等 ≥ 3 个切片被 ≥ 3 个子组件消费；:ctx prop 穿透 / IIFE 解构绕 lint 即为强烈信号。
3. **setup store 返回嵌套切片对象**：消费侧统一 `store.切片.字段` 访问、禁止解构 store、不写 `.value`。

只要任一条不满足，回到 composable 单例（页面级）或 props/emits（父子单向流）。

#### 页面级 vs 全局边界

| 维度 | 页面级 Pinia setup store | 全局 composable 单例 |
|---|---|---|
| 作用范围 | 单路由 / 单页面（离开 `$dispose` 重建） | 跨路由 |
| 典型场景 | 多子组件共享同一组业务 composable（列定义 + 行内编辑 + 批量等） | auth session、扫码 session、扫码总线 |
| 路径 | `src/views/<域>/composables/useXxxStore.ts` | `src/composables/useXxx.ts` |
| 生命周期 | `onBeforeUnmount` 必 `store.$dispose()` | 模块级单例，无 dispose |
| 实例化时点 | 组件 setup 顶部首调（让切片内 lifecycle hook 绑到组件） | import 一次即生效 |
| Vue Router 依赖 | 不 import（store 单测需要无 router） | 按需 |
| 持久化 | 子切片可独立 localStorage（如 `useColumnVisibility`） | 通常模块级 + storage |

跨路由全局状态（auth / 扫码 session / 扫码总线等）**仍一律** composable 单例模式，不得建全局 store。

## 拦截器 ↔ composable 解耦

`src/api/http.ts` 的 axios 拦截器需要在新 token 刷新后通知 `useAuthSession` 更新 module-level refs。如果直接 `import { useAuthSession } from '@/composables/useAuthSession'`，会引入循环依赖（http.ts 被 auth.ts 引，auth.ts 又被 useAuthSession 引）。解法是 **CustomEvent**：

```ts
// src/api/http.ts —— 拦截器侧
function persistTokens(pair: LoginResponse): void {
  // ... 写 localStorage ...
  window.dispatchEvent(new CustomEvent('auth:tokens-refreshed', { detail: pair }));
}
```

```ts
// src/composables/useAuthSession.ts —— composable 侧
if (typeof window !== 'undefined') {
  window.addEventListener('auth:tokens-refreshed', ((e: Event) => {
    const pair = (e as CustomEvent<LoginResponse>).detail;
    if (pair?.token) {
      token.value = pair.token;
      refreshTokenValue = pair.refresh_token ?? null;
      user.value = pair.user;
    }
  }) as EventListener);
}
```

同样套路用在 session 失效的统一出口：拦截器 dispatch `'auth:logout'`，`main.ts` 监听后 `router.replace('/login')`。拦截器不直接依赖 vue-router，避免反向依赖。

> 这条模式**只用在"跨模块边界"的通信**。同模块内（composable ↔ 组件）直接调函数即可，不要为了"解耦"全部绕到 CustomEvent。

## 新增全局状态 checklist

按顺序回答这 3 个问题，全答否才新建 composable 单例：

1. **是否真的有 ≥ 2 个组件 / 路由需要共享？**
   - 否 → 留在 setup 内 `ref()`
   - 是 → 进入下一步

2. **能否用 props / emit / `v-model` 替代？**
   - 是 → 用 props（父子单向流最简单）
   - 否 → 进入下一步

3. **能否放进已有的 6 个 composable 之一？**
   - 是 → 在对应 composable 里加字段（避免单例爆炸）
   - 否 → 新建 composable 单例，参考上面"模块级单例模式"模板

4. **是否页面级 ≥ 3 个子组件共享同一组 composable 切片？**
   - 是 → 新建 Pinia setup store（参见「何时该考虑 Pinia」三条判据），就近放 `views/<域>/composables/useXxxStore.ts`，壳组件 `onBeforeUnmount` 必 `store.$dispose()`，消费侧统一 `store.切片.字段`、禁止解构、不写 `.value`。参考首例 `usePartsListStore`（`src/views/parts/composables/`）
   - 否 → 维持 composable 单例（回到上面三问的最后一问）或 props/emits

新建的 composable 文件路径：`src/composables/useXxx.ts`，命名沿用 `use` 前缀 + PascalCase 主题名。如果该状态需要跨页面持久化，参考 `useDeliveryScanState` 的 localStorage / `useActiveShelfSelection` 的 sessionStorage 模板。
