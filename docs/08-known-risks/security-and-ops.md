# 安全与运维风险登记

> **目标读者**：部署运维 / Agent
> **核心价值**：安全 + 运维中已知风险的记录、决策与缓解。
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

本文档登记安全 / 运维相关的「明知有风险但接受」的项目，每条都附背景、决策依据与缓解措施。

## 1. MCP 端点 nginx 层 deny all

### 事实

`nginx.conf` 中三处 MCP 端点匹配：

```nginx
location ^~ /api/mcp { deny all; }
location = /mcp { deny all; }
location ^~ /mcp/ { deny all; }
```

应用层**完全无鉴权**——MCP 是后台 AI agent 协议端点，前端路由根本不知道它的存在。安全完全靠 nginx + 云安全组两层把关。

### 风险

| 风险 | 后果 |
|---|---|
| nginx 配置错误（`^~` 漏写） | 被 `/api` 反代截走，请求落到后端 |
| 云安全组配置错误（端口暴露） | 攻击者直接访问 MCP 端点 |
| 应用层不感知 | 拦截在 nginx，业务方无任何日志可查 |

### 匹配细节（必读）

`nginx.conf` 注释里已经标得很清楚：

1. `^~` 不能省。普通前缀 location 会被正则 `~* \.mjs$` 抢走优先级——`/api/mcp/x.mjs` 就会绕过 deny 落到 `try_files`。
2. `^~ /api/mcp` **不带**尾斜杠：带尾斜杠的话 `/api/mcp`（无尾斜杠）不匹配，会落到 `location /api/` 被反代出去。
3. `= /mcp` 精确匹配 + `^~ /mcp/` 前缀：只挡 MCP 端点本身，不会误伤将来前端加的 `/mcp-xxx` 之类 SPA 路由。

### 缓解

- nginx 配置 review checklist（PR review 时强制核对匹配细节）。
- 云安全组强制 80 / 443 only，关闭其它入站。
- 定期渗透测试（季度），覆盖 `/api/mcp` / `/mcp` / `/mcp/` 三条路径。

## 2. SSL / HTTPS 启用条件

### 必须条件（缺一不可）

1. 证书文件存在（docker-compose bind mount 路径正确）。
2. `entrypoint.sh` 容器启动时检测证书，切换 nginx 模板：
   - 证书存在 → `nginx.conf`（HTTP 301 + HTTPS 主服务）
   - 不存在 → `nginx.http-only.conf`
3. 4 个 envsubst 占位符正确注入：`NGINX_SERVER_NAME` / `NGINX_REDIRECT_TARGET` / `SSL_CRT_FILENAME` / `SSL_KEY_FILENAME`，值由 docker-compose 注入。

### 风险

| 场景 | 后果 |
|---|---|
| 证书过期 | 用户访问报证书错误，业务中断 |
| 证书路径错 | nginx 启动失败，容器持续重启 |
| 占位符未替换 | nginx 配置语法错误，容器无法启动 |

### 缓解

- 证书过期监控（30 天 / 7 天 / 1 天三次告警）。
- `entrypoint.sh` 启动失败时打印详细错误，方便 docker logs 排查。
- docker-compose 健康检查 `/healthz` 端点。

## 3. session 吊销：40105 SESSION_REVOKED

### 状态（2026-08-26 起）

**dormant**。40105 是 v2 Rust 后端专属错误码，v2 auth 域 2026-08-26 临时回滚到 v1（详见 [docs/02-architecture/api-contract.md](../02-architecture/api-contract.md) "v1 临时回滚注意事项"），v1 FastAPI 永远不会返回 40105。`src/api/http.ts` 拦截器对该码的处理分支保留为 dead code（按 plan 决策）——保持文件结构完整，便于未来切回 v2 时快速恢复。

### 历史行为（v2 启用期间参考）

`src/api/http.ts` 响应拦截器对 `code === 40105` 的处理：

- **不走 refresh**（refresh 救不回，因为 JWT 签名仍有效但 session 已被吊销）。
- 直接 `window.dispatchEvent(new CustomEvent('auth:logout'))`。
- `main.ts` 监听 `auth:logout` 事件后 `router.replace('/login')`。

### 历史触发场景（v2 启用期间）

| 场景 | 说明 |
|---|---|
| 管理员在后台强制踢人 | 后端写 Redis session 黑名单 |
| Redis session 被清 | 集群重启 / 主动 flush |
| 设备异地登录挤下线 | 同一账号多设备登录，旧设备被挤 |

### 历史背景：为什么 refresh 救不回（v2 架构）

v2 auth 用 Redis session 校验 token 有效性，refresh 只是换新 access，本质上 session 已被吊销时再换 access 仍会被同样拒绝。40102 才是 refresh 救得回的（access 过期但 session 仍有效）。

## 4. localStorage 中 token 的 XSS 暴露面

### 接受

- access / refresh token 存在 `localStorage`（key：`auth_session`）。
- XSS 攻击者可读 token → 拿到短期 access（5min）+ 长期 refresh（7d）。

### 决策依据

token 本身**不是高敏信息**：

- 它是 OAuth 风格的 bearer 凭证，不是长期密钥（refresh 7d 后自动失效）。
- 没有用户敏感数据绑定（业务数据都在后端）。
- 系统遵循「前端无 secret」原则——所有业务数据按权限从后端实时拉取。

相比把 token 放 cookie（虽然能 httponly 防 XSS 读取），localStorage 方案在前端工程上更简单，且配套的短期 access 窗口大幅缩短了暴露半径。

### 缓解

- CSP（Content Security Policy）——禁止 inline script、限制 script-src。
- `X-Content-Type-Options: nosniff`——已在 nginx 默认头。
- 不在 localStorage 存任何敏感业务数据（订单详情 / 用户隐私等）。
- access 有效期严格 5min，refresh 7d 后强制重新登录。

### 重新评估的触发条件

- 业务方要求 token 内嵌敏感数据。
- 出现利用 localStorage token 的实际安全事件。
- 监管要求调整（如等保 2.0 修订）。

## 5. nginx `.mjs` MIME 配置失误教训

### 历史

`nginx.conf` 错配 `.mjs` MIME 导致 pdf worker 被缓存整年——详细背景与缓解见 [dependency-risks.md](./dependency-risks.md) 的「pdfjs 缓存穿透历史」节。

### 当前机制

```nginx
location ~* \.mjs$ {
    types { application/javascript mjs; }
    ...
}
```

- 显式声明 `application/javascript`。
- 1h 缓存，不强制 immutable。
- workerSrc URL 带 `?v=YYYYMMDD` 版本串穿透历史中毒缓存。

### 修改 `.mjs` 配置前的 checklist

1. 确认 `types { application/javascript mjs; }` 仍在。
2. 确认 `expires 1h` 而非 `immutable`。
3. `pdfjs.ts` 的 `PDF_WORKER_CACHE_BUST` 同步递增版本串。
4. 灰度上线后监控 PDF 渲染成功率。

## 6. /api/v2 反代尚未完全启用

### 状态

仅 auth + delivery 部分端点切到 v2（Rust 主仓 `~/Code/hsh-erp-rust`），其余业务域仍走 v1（FastAPI 历史仓）。

迁移进度见 `docs/api/index.md` 的「未上线域」表。

### 风险

| 触发条件 | 后果 |
|---|---|
| 切 v2 时旧 v1 refresh_token 立即作废 | 存量用户首次访问会被强制重登一次 |
| v1 后端 session 不可靠 | 历史登录反复出错的根因（v1 FastAPI auth 域无 Redis） |

### 缓解

- 灰度切流：按用户 ID 段切 v1 / v2，避免一次性全量。
- 监控 40101（未登录）/ 40103（refresh 失效）错误率：突然飙升说明存量 token 失效过快。
- 静默 fallback：拦截器对 40101 / 40103 已统一处理为 dispatch `auth:logout` 跳登录，用户体验是「重新登录一次」，不是功能报错。

### 完全切完前的兼容性

- `src/api/http.ts` 同时挂载 v1（`api`）和 v2（`apiV2`）两个 axios 实例，baseURL 分别为 `/api/v1` 和 `/api/v2`。
- 新功能统一走 `apiV2`，v1 仅作为业务兼容兜底。
- 前端不要写「v1 token → v2 token 自动迁移」逻辑——不同 JWT 签名 + 不同 session 表，根本无法迁移，必须重登。