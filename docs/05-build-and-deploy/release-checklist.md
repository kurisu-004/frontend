# 上线 Checklist 与发布流程

> **目标读者**：部署运维 / 后端联调
> **核心价值**：上线前 10 步 checklist + v1→v2 灰度切流流程 + 回滚预案 + 紧急回滚步骤
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 上线前 10 步 Checklist

每一项都对应一个独立失败模式，跳过任一项都可能让发布事故上线后才暴露。

- [ ] **证书文件就绪**：`${SSL_CRT_FILENAME}` + `${SSL_KEY_FILENAME}` 已放到 docker-compose bind mount 路径；过期时间 > 30 天。
- [ ] **docker-compose.yml 配置正确**：环境变量 `NGINX_SERVER_NAME` / `NGINX_REDIRECT_TARGET` / `SSL_CRT_FILENAME` / `SSL_KEY_FILENAME` 都已注入；443 + 80 端口已 expose。
- [ ] **`.env` 凭据正确**：`DOCKER_USERNAME` / `DOCKER_PASSWORD` / `DOCKER_REPO` 都已配置；`scripts/push-frontend.sh` 能正常登录 TCR。
- [ ] **类型检查通过**：`npm run typecheck` 退出码 0（vue-tsc 全量检查）。
- [ ] **单测通过**：`npm run test` 全绿（vitest node 环境，纯函数测试）。
- [ ] **构建成功**：`npm run build` 完成（vue-tsc + vite build）并产出 `dist/`。
- [ ] **镜像 tag 规范**：tag 形如 `myerp-frontend:2026-08-26-abc1234`（日期 + git 短 SHA）；旧 tag 保留最近 5 个。
- [ ] **HEALTHCHECK 配置**：Dockerfile 已配 `wget --spider http://127.0.0.1/`；编排层确认能读到 health 状态。
- [ ] **docs/ 已同步**：修改了架构或域逻辑 → 对应 `02-architecture/` / `03-modules/` / `05-build-and-deploy/` 文档同步更新。
- [ ] **回滚预案准备**：前一版镜像 tag 已记录；前一版 `nginx.conf` 已备份；前一版 docker-compose 已保存到发布分支。

## v1 → v2 切流流程（以 auth 为例）

v1 FastAPI → v2 Rust 主仓是大版本迁移，frontend 已经在 v2 实例（`apiV2`）上写新代码，但老业务还在 v1 上跑。完整切换需要 6 步：

> **2026-08-26 注**：auth 域临时回滚 v1（v1/v2 JWT 不兼容，业务仍依赖 v1）。本节描述的是完整 v2 切换流程，目前只完成了第 1 步（部分业务域在 v2）+ 第 2 步（v2 Rust 主仓已上线）。**切回 v2 的触发条件见 [docs/02-architecture/api-contract.md](../02-architecture/api-contract.md) "v1 临时回滚注意事项"**。

### 1. 前端全量切到 `apiV2`

`src/api/auth.ts` 全量改用 `apiV2` + `refreshClientV2`。所有 v2 实例的 axios 请求走 `http://127.0.0.1:8000/api/v2/auth/*`（或 dev proxy）。

> **当前状态**：auth 域 2026-08-26 已切回 `api` + `refreshClient`；其余业务域（deliveryNote / deliveryGroup / parts/scanInspect）仍在 `apiV2`。不要在 auth 域写新 v2 代码。

### 2. 后端上线 v2 域

`~/Code/hsh-erp-rust` 主仓部署 `/api/v2/auth/*` + Redis session 表。注意 **v1 与 v2 的 JWT 签名密钥 + session 表都不一样**——一旦切到 v2，旧 v1 refresh_token 立即作废。

### 3. 联调：本地 dev proxy 双路由

修改 `vite.config.ts` 的 `server.proxy`，让 `/api/v1/*` 与 `/api/v2/*` 都能代理到对应后端：

```ts
proxy: {
  '/api/v1': { target: 'http://127.0.0.1:8000', changeOrigin: true },
  '/api/v2': { target: 'http://127.0.0.1:3000', changeOrigin: true, ws: true },
}
```

### 4. 灰度：nginx 按用户 ID 切流

在 nginx 层加一个 `map $cookie_user_id $auth_backend`：

```nginx
map $cookie_user_id $auth_backend {
    default "myerp_backend";      # v1 兜底
    "~^[0-9]+$" $auth_target_uid; # 灰度用户走 v2（按 ID 末位 / 区间切）
}
```

配合 `split_clients` 或 `if` 路由 `/api/v2/auth/*` 到不同 upstream。**双写一段时间**，观察 v2 的错误率与 latency。

### 5. 全量：nginx 切到 v2 only

灰度观察 1-2 周后，把所有 `/api/v1/*` 反代注释掉或返回 410 Gone。删除前端 `src/api/http.ts` 里 v1 的兜底逻辑。

### 6. 监控：40101 / 40103 / 40105 错误率

上线后 24 小时重点盯：

- `40101`（未登录）—— 正常范围内的登录失败。**回滚 v1 期间，业务域（走 `apiV2`）拿到 v1 JWT 也会 40101**，是预期行为。
- `40103`（refresh 失效）—— v1 → v2 切换后**预期会有一次尖峰**，因为所有存量用户的旧 refresh_token 失效。
- `40105`——当前 v1 不返回该码，监控告警阈值调零或保留为 historical-only。
- `40105`（SESSION_REVOKED）—— v2 Redis session 已被吊销，需要重新登录。

错误率超过 1% 持续 10 分钟触发回滚。

## 回滚预案

### 镜像 tag 保留

`scripts/push-frontend.sh` 默认打 SHA + latest 两个 tag。TCR 上保留最近 5 个 SHA tag 便于回滚（运维负责清理旧 tag，保留策略见 release 时约定的日期窗口）。

### nginx 配置回滚

`nginx.conf` / `nginx.http-only.conf` 每次修改前：

1. 备份当前文件到发布分支 `releases/<日期>/nginx.conf.bak`。
2. 修改 → 推送 → 验证。
3. 失败回滚：`git checkout releases/<上一次成功日期>/ -- nginx.conf nginx.http-only.conf` + 重新 build + push。

### DB 数据

v1 → v2 数据迁移需要**双写一段时间**——v2 写入同时落到 v1 schema，确保 v1 反代路径还能读出。完全切到 v2 only 后才能下线 v1 表。雪花 ID 在前后端都按 string 处理（见 `02-architecture/` 关于雪花 ID 的说明），迁移过程中不会有精度损失。

### v1 refresh_token 失效

**这是已知的可预期现象**，不是 bug：

- 旧 v1 refresh_token 立即作废（不同 JWT 签名 + 不同 session 表）。
- 存量用户首次访问会被强制重登一次（静默 fallback——由 40101 / 40103 兜底）。
- 重登后所有后续请求走 v2 refresh token，不再受影响。

在 release notes 里提前告知用户即可。如果错误率超过 1% 持续 10 分钟则触发紧急回滚。

## 紧急回滚步骤

### 1. 停止当前容器

```bash
docker compose down frontend
```

### 2. 用前一版 tag 启动

```bash
docker run -d \
  --name myerp-frontend \
  -p 80:80 -p 443:443 \
  -v /path/to/ssl:/etc/nginx/ssl:ro \
  -e NGINX_SERVER_NAME=hsh-erp.cloud \
  -e NGINX_REDIRECT_TARGET=https://hsh-erp.cloud \
  -e SSL_CRT_FILENAME=hsh-erp.cloud_bundle.crt \
  -e SSL_KEY_FILENAME=hsh-erp.cloud.key \
  ccr.ccs.tencentyun.com/hsh-erp/prod-frontend:<previous-tag>
```

### 3. 验证 HEALTHCHECK

```bash
docker ps  # 看 STATUS 列 health: healthy
curl -I https://hsh-erp.cloud  # 期望 200
```

### 4. 通知团队

在团队频道报告：回滚原因、当前镜像 tag、预计后续修复时间。

## 常见 release 失败场景

### 502 Bad Gateway

后端服务（`backend:8000` 或 `rust-backend:3000`）未就绪就被 frontend 接管流量。检查：

- `docker ps` 看 backend 容器的 health。
- `docker logs backend` 看启动错误。
- 上线顺序：先起 backend → health 后再起 frontend。

### 401 风暴

切 v1 → v2 后旧 refresh_token 失效，存量用户被强制重登。这是**预期行为**，但如果错误率超阈值：

- 短时：等待重登完成（一般 5-10 分钟）。
- 长时：紧急回滚到 v1 only frontend。

### 静态资源 404

CDN purge 未执行：

- 改了 `/assets/*` 的资源命名规则 → 旧浏览器会 404。
- 用 hashed 文件名就是为了避免这个问题；如果出现 404，多半是 nginx 配置错把 `/assets/` 长缓存改坏了。
- 修复：让用户 `Ctrl+F5` 强刷，或紧急切回旧镜像。

## 监控指标

### 前端错误率

- Sentry 或自建前端监控（window.onerror / unhandledrejection）。
- 阈值：> 0.5% 持续 5 分钟告警。

### API 响应时间

- nginx access log（`$request_time`）+ 后端 APM。
- 阈值：p95 > 1s 持续 5 分钟告警。

### WebSocket 重连率

- `/ws/dashboard` 等端点的重连事件计数。
- 阈值：单用户 5 分钟内 > 3 次重连告警（通常是网络或 backend 异常）。

### Auth 健康度

- `40101` / `40105` 错误率。
- 阈值：> 1% 持续 10 分钟触发回滚评估。
- `40102`（access 过期）是正常自动 refresh 场景，**不应**计入告警。