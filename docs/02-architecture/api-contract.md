# API 契约：axios 封装、信封协议、自动 refresh

> **目标读者**：后端联调 / 新增接口的 Agent / 排查 401 异常链路的同学
> **核心价值**：把 axios 封装、信封协议、错误码、自动 refresh 链路完整讲清楚，避免误用 `api` / `apiV2` / refresh client
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

`src/api/http.ts` 把 axios 封装成统一的 HTTP 客户端，承担四件事：baseURL 路由、token 注入、信封解封、自动 refresh。`src/api/auth.ts` 是 v2 auth 域的端点封装，与历史 v1 字段完全一致（仅新增错误码 40105）。本篇把这一层契约完整讲清楚。

## 三个 axios 实例

| 实例 | baseURL | 拦截器 | 何时用 |
|---|---|---|---|
| `api` | `/api/v1` | 有 | v1 FastAPI 业务接口（默认） |
| `apiV2` | `/api/v2` | 有 | v2 Rust 后端业务接口（auth / deliveryNote / scanInspect 等已迁移域） |
| `refreshClient` | `/api/v1` | 无 | 仅 `/auth/refresh`（v1 兼容期） |
| `refreshClientV2` | `/api/v2` | 无 | 仅 `/api/v2/auth/refresh` |

**反例**：`api.post('/v2/...')` 会被 baseURL 拼成 `/api/v1/v2/...`，404 静默失败。**单端点 v2 调用必须 `apiV2.post('/...')`**，路径不带 `/v2` 前缀。

### refresh 客户端为什么独立

`refreshClient` / `refreshClientV2` 没有挂任何拦截器。原因：响应拦截器里有"40102 → 自动 refresh → 重试原请求"链路。如果 `/auth/refresh` 也走 `api`，refresh 自身失败抛 `ApiError` 40102，又会进拦截器再触发 refresh，无限递归。refresh 必须走裸实例隔离。

### refresh 客户端必须与主客户端同版本

切换 v2 时必须保证：**业务走 `apiV2` 则 refresh 走 `refreshClientV2`**。如果业务走 `api` 但 refresh 走 `refreshClientV2`，refresh 端点落在 v2 而原请求重试时仍走 v1，会造成"看似 token 刷新了但后续请求还是 40102"的诡异现象。auth 域切 v2 后，`src/api/auth.ts` 已经把 `refreshTokens` 切到 `refreshClientV2`。

## 信封协议 `{code, message, data}`

所有后端响应统一包成 `{code: number, message: string, data: T}`。拦截器看到 `code === 0` 时把 `response.data` 直接替换成裸 `data`，调用方拿到的就是 `T`。`code !== 0` 抛 `ApiError(code, message)`，调用方用 `try/catch + (e as ApiError).code` 判断业务错误码。

```ts
// 调用方代码形态
try {
  const data = await apiV2.get<MyData>('/some/endpoint')
  // data 已经是裸 MyData，不是 {code, message, data}
} catch (e) {
  if ((e as ApiError).code === 42xxx) {
    // 业务错误码分支
  }
}
```

非标准响应（文件 blob / 文本 / 第三方回调）不经解封，原样透传。

### code 编号约定

| 区间 | 语义 | 备注 |
|---|---|---|
| `0` | 成功 | 拦截器解封 |
| `40101`–`40105` | 鉴权错误 | 见下表，拦截器有特殊处理 |
| `2xxxx` | 业务错误 | 由调用方按 code 分支处理 |
| `4xxxx` | 系统 / 校验错误 | 通常 5xx 对应 server 端异常 |

## 认证错误码表

| code | 常量 | 拦截器行为 |
|---|---|---|
| 40101 | `BIZ_AUTH_INVALID` | 抛错，调用方兜底（通常是路由守卫的 `refreshOrLogout`） |
| 40102 | `TOKEN_EXPIRED` | 自动 refresh + 重试原请求（`refreshPromise` 单例防雪崩） |
| 40103 | `BIZ_AUTH_REFRESH_INVALID` | dispatch `auth:logout`，跳登录 |
| 40104 | `OLD_PASSWORD_MISMATCH` | 抛错，改密 dialog 提示用户 |
| 40105 | `SESSION_REVOKED` | dispatch `auth:logout`（**不走 refresh**：JWT 签名仍有效但 Redis `session:tok:<sha256>` 已被吊销，refresh 也救不回） |

`ApiError` 类暴露 `isAuthError` getter：40101 / 40102 / 40103 / 40105 都返回 true，调用方可一次性判断"是不是 session 出问题了"。

## 40102 自动 refresh 时序

```mermaid
sequenceDiagram
  participant C as 业务组件
  participant I as axios 拦截器
  participant R as refreshClientV2
  participant L as main.ts

  C->>I: apiV2.get('/foo')
  I->>I: 收到 40102<br/>(access 过期)
  I->>I: refreshPromise 是否存在？
  alt 已有 refreshPromise
    I->>I: 复用，等待结果
  else 没有
    I->>R: refreshClientV2.post('/auth/refresh')
    R-->>I: 新一对 token
    I->>I: persistTokens + dispatch<br/>auth:tokens-refreshed
  end
  I->>I: 用新 token 重试原请求<br/>(标记 _isRetryAfterRefresh)
  I-->>C: 返回解封后的 data

  Note over I,R: 如果 refresh 失败
  I->>L: dispatch auth:logout
  L->>L: router.replace('/login')
```

并发撞 40102 时只触发一次 `/auth/refresh`：模块级 `refreshPromise` 单例，第一个请求触发后写入 promise，后续 40102 复用同一个；完成后用 `setTimeout(..., 0)` 让微任务队列里的消费者先看到结果再清空。

## Proactive refresh

每次成功响应都看一眼 access token 的 `exp`（JWT decode），剩余寿命 < 5 分钟就 fire-and-forget 触发 refresh。30 秒节流，避免短时间连续刷新。

实现关键点：

- `cachedAccessExp` 模块级缓存，避免每次都 decode JWT。
- 失败完全静默（`void getOrCreateRefresh().catch(() => {})`）——reactive 路径（用户触发的新请求收到 40102）会兜底。
- 40102 reactive refresh 已经把新 token 写回 localStorage 并 dispatch `auth:tokens-refreshed`；`useAuthSession` 监听该事件同步 module-level refs，组件下次 `useAuthSession().token.value` 拿到新值。

## query 序列化

`serializeParams(params)` 把 axios params 对象序列化成 query string：

- **白名单 key（`statuses`）**：数组 → CSV 单值 `?statuses=A,B`，与 v2 Rust 后端期望对齐。
- **其它数组 key**：默认重复 `?key=a&key=b`（无 `[]` 后缀），与历史 FastAPI `/api/v1` 兼容。

```ts
// FastAPI 兼容形式（默认）
api.get('/parts', { params: { statuses: ['A', 'B'] } })
// → GET /api/v1/parts?statuses=A&statuses=B

// v2 后端期望形式（statuses 走 CSV）
apiV2.get('/delivery-notes', { params: { statuses: ['DRAFT', 'SHIPPED'] } })
// → GET /api/v2/delivery-notes?statuses=DRAFT,SHIPPED
```

## `cleanParams()`

`cleanParams(obj)` 去掉 `undefined` / `null` / 空字符串 `''` / 空数组 `[]` 的字段，保留数字 `0` 和布尔 `false`。给 list 类接口（GET `/xxx?a=1`）用——后端对 `''` 会做 `LIKE '%%'`（导致全量匹配），axios 默认只 strip `undefined` / `null`。2026-08-25 refactor 把 9 个 list API 的清洗逻辑收到 `http.ts` 这一层。

```ts
apiV2.get('/parts', { params: cleanParams({ name: '', status: 'A', page: 0 }) })
// → GET /api/v2/parts?status=A&page=0
```

## localStorage 键 `auth_session`

```ts
interface StoredSession {
  token: string              // access JWT
  refresh_token: string      // 7d TTL refresh JWT（2026-07-10 新增）
  user: CurrentUser          // 含 menus / roles / shelf_ids
}
```

`localStorage['auth_session'] = JSON.stringify(stored)`。请求拦截器从这里读 token 挂 `Authorization: Bearer <token>`。`useAuthSession` 监听 `auth:tokens-refreshed` 事件同步 module-level refs，避免组件 re-render 拿到旧值。

## session 失效统一出口

refresh 失败 / 40101 / 40103 / 40105 都不直接调 vue-router，而是 `window.dispatchEvent(new CustomEvent('auth:logout'))`。`main.ts` 监听该事件后 `router.replace('/login')`。

```ts
// main.ts（拦截器反向依赖的解耦点）
window.addEventListener('auth:logout', () => {
  router.replace('/login')
})
```

为什么不直接在拦截器 `import router`：会形成循环依赖（router 引 store / composable，composable 引 http，http 又引 router），且不便单测。CustomEvent 是最低耦合的桥。

## 雪花 ID 全程 string

后端 ID 是雪花 ID（19 位），超过 `Number.MAX_SAFE_INTEGER`（2^53）。前端必须当 string 处理：

```ts
// 错误（丢精度）
const id = Number(parts[0].id)
// Number("198362487928651776") → 198362487928651780（实测差 4）

// 正确
const id = parts[0].id  // string
```

后端 Pydantic v2 默认 lax 模式会从 JSON string 自动 coerce 到 int，所以前端发请求时 `"id": "198362487928651776"`（字符串）和 `"id": 198362487928651776`（数字）后端都能正确解析。`useAuthSession.activeShelfId()` 返回 `string | null` 也是出于同一原因。

## v2 迁移注意事项

**auth 域 2026-08-26 已切 v2**（v1 FastAPI 无 Redis，session 不可靠——历史登录反复出错的根因）。切换带来的两个副作用：

1. **旧 v1 refresh_token 立即作废**：v1 / v2 JWT 签名密钥不同、Redis session 表也不同，跨版本 token 互相不认识。
2. **存量用户首次访问会被强制重登一次**：用户本地 `localStorage` 里残留的是 v1 token，请求 v2 接口时拿 v1 token 去鉴权会得到 40101，拦截器 dispatch `auth:logout` 跳登录。UI 表现是"打开页面一瞬间就跳到登录页"，由 40101/40103 兜底，无中间态报错。

迁移检查清单：

- 新增 v2 接口 → `src/api/<domain>.ts` 里 `import { apiV2 } from '@/api/http'`，路径不带 `/v2` 前缀。
- 新增 v2 refresh 端点 → `import { refreshClientV2 }`，不要混用 `refreshClient`。
- 后端契约变更 → 更新 `~/Code/hsh-erp-rust/docs/api/<domain>.md`（不要去翻源码反推）。

## 排错速查

| 现象 | 可能原因 |
|---|---|
| 请求 404，路径看着对 | `baseURL` 错了（用了 `api` 但端点已迁 v2） |
| refresh 后还是 40102 | refresh 客户端与主客户端版本不一致 |
| 收到响应但 `data` 是 `{code, message, data}` 没解封 | 后端没按信封协议返回（或者是非 JSON 文件 blob） |
| `pdf` 上传后端报 500 | 走 v1 上传但后端已切 v2，body 字段不兼容 |
| 40105 频繁出现 | 改密 / 多设备登录 / 管理员停用了账号，导致当前 Redis session 被吊销 |