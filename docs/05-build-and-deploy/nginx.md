# nginx 配置详解

> **目标读者**：部署运维 / 后端联调 / Agent
> **核心价值**：把 nginx 两份模板（`nginx.conf` HTTPS 主服务 / `nginx.http-only.conf` 兜底）+ 4 个 envsubst 占位符 + MCP 阻断 + 后端反代 + WebSocket + 缓存策略一次性讲清
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 4 个 envsubst 占位符

容器启动时由 `entrypoint.sh` 用 `envsubst` 渲染到最终配置。**只**白名单这 4 个变量（避免把 `$request_uri` / `$host` 等 nginx 内置变量误替换）：

| 占位符 | 作用 | 生产示例 |
|---|---|---|
| `${NGINX_SERVER_NAME}` | server 块的 `server_name` | `hsh-erp.cloud`（测试服设 `_`） |
| `${NGINX_REDIRECT_TARGET}` | `:80` 301 跳转目标 | `https://hsh-erp.cloud`（测试服留空） |
| `${SSL_CRT_FILENAME}` | `/etc/nginx/ssl/` 下的证书文件名 | `hsh-erp.cloud_bundle.crt` |
| `${SSL_KEY_FILENAME}` | `/etc/nginx/ssl/` 下的私钥文件名 | `hsh-erp.cloud.key` |

变量值由 docker-compose 的 `environment:` 块注入；测试服务器无需域名 / 证书时只需覆盖 `NGINX_SERVER_NAME=_` + `NGINX_REDIRECT_TARGET=` + 不挂证书，entrypoint 会自动走 HTTP-only 分支。

## HTTP / HTTPS 双模板切换

启动时 `entrypoint.sh` 的判断逻辑：

```bash
if [ -f "$SSL_CRT" ] && [ -f "$SSL_KEY" ]; then
    # 用 /etc/nginx/conf.d/default.conf（HTTPS 模板，COPY nginx.conf 进来的）
else
    # 用 /etc/nginx/templates/http-only.conf（HTTP 模板，COPY nginx.http-only.conf 进来的）
    cp /etc/nginx/templates/http-only.conf /etc/nginx/conf.d/default.conf
fi
```

两份模板的关系：`nginx.http-only.conf` 是 `nginx.conf` 去掉 SSL / HSTS 后的纯 HTTP 版本，所有 location / 反代 / SPA fallback 行为一致。**改 HTTPS 模板里的 location 时必须同步 HTTP 模板**，否则两种部署会出现行为漂移（`nginx.http-only.conf` 顶部注释明确警告过）。

## HTTPS 主服务（`nginx.conf`）

### `:80` 跳转

```nginx
server {
    listen 80;
    server_name ${NGINX_SERVER_NAME};
    return 301 ${NGINX_REDIRECT_TARGET}$request_uri;
}
```

备案完成后所有 HTTP 请求 301 到 HTTPS。`$request_uri` 而不是 `$uri$is_args$args`：保证 query string 也一并带过去。

### `:443 ssl http2`

- TLS 协议仅 `TLSv1.2 TLSv1.3`，禁用 TLSv1.0 / 1.1（合规要求）。
- 现代 cipher 套件，禁用 `ssl_prefer_server_ciphers off`（让客户端优先选更安全的）。
- `ssl_session_cache shared:SSL:10m` 跨 worker 复用 TLS session，避免每次握手。
- `http2 on`：单连接多路复用，显著降低首屏延迟。

### 安全 headers

| Header | 值 | 作用 |
|---|---|---|
| `X-Frame-Options` | `SAMEORIGIN` | 防 clickjacking（同源才能 iframe） |
| `X-Content-Type-Options` | `nosniff` | 防 MIME sniffing |
| `Referrer-Policy` | `no-referrer-when-downgrade` | HTTPS→HTTPS 带 Referer，HTTP 不带 |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HSTS 2 年 + 子域 + 预加载列表 |

**HSTS 只在 HTTPS 块加**——HTTP 块如果也带 HSTS，浏览器会被强制锁到 HTTPS，本地未备案环境会彻底打不开。

## `.mjs` location 块（与 pdfjs worker 联动）

```nginx
location ~* \.mjs$ {
    default_type application/javascript;
    expires 1h;
    try_files $uri =404;
}
```

**这是 2026 年那次故障的修复点**。基础镜像的 `mime.types` 历史上缺失 `.mjs` 映射，会把 `pdf.worker.min-*.mjs` 当成 `application/octet-stream`。浏览器启用"Strict MIME type checking for module scripts"后拒绝作为 module 加载，pdf 预览退化到主线程 fake worker（首屏卡 3-5s）。当年 nginx 还顺手设了 immutable cache，结果错的 MIME 被缓存整年。

修复方式：

1. `default_type application/javascript` 显式声明 MIME。
2. `expires 1h` + 不强制 immutable：未来再次 MIME 错配，1 小时内浏览器 revalidate 自动拿到正确响应。

`~*` 正则 location 优先级高于下面的 `^~ /api/v2/` 等前缀 location——但**只有** `.mjs` 后缀会被它拦下，其他路径不受影响。

## MCP 端点 deny all（3 处匹配细节）

应用层 MCP（`/api/mcp/*` REST 查询 + `/mcp` 协议端点）**没有任何鉴权**——它们是给内网 AI 助手用的免登录只读入口，安全性完全由 nginx + 云安全组保证。这三处 deny 是公网最后一道闸：

```nginx
location ^~ /api/mcp {
    deny all;
}

location = /mcp {
    deny all;
}

location ^~ /mcp/ {
    deny all;
}
```

三个匹配细节，**改这段前必读**（已写在 `nginx.conf` 注释里）：

1. **`^~` 不能省**。普通前缀 location 会被上面的 `~* \.mjs$` 正则抢走——`/api/mcp/x.mjs` 就会绕过 deny 落到 try_files。`^~` 命中后直接停止匹配，不再考虑正则。
2. **`^~ /api/mcp` 不带尾斜杠**。带尾斜杠的话 `/api/mcp`（无斜杠）不匹配，会落到下面的 `location /api/` 被反代出去。
3. **`= /mcp` 精确匹配 + `^~ /mcp/` 前缀**：只挡 MCP 端点本身，不会误伤将来前端加的 `/mcp-xxx` 之类 SPA 路由。纯前缀 `/mcp` 会把它们一起 403。

放开给内网访问时（按需）：

```nginx
location ^~ /api/mcp {
    allow 10.0.0.0/8;
    deny all;
    # 补上与 location /api/ 相同的 proxy_pass
}
```

## 反代配置

### `/api/v2/` → Rust 主仓

```nginx
location ^~ /api/v2/ {
    client_max_body_size    300m;
    client_body_buffer_size 1m;
    client_body_timeout     600s;

    proxy_pass         http://hsh_rust_backend;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        $connection_upgrade;
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering     off;
}
```

upstream `hsh_rust_backend` = `rust-backend:3000`（Rust + axum + sqlx 主服务，部署在另一个容器）。`^~` 不可省——防止 `/api/v2/x.mjs` 被 `~* \.mjs$` 正则抢走落 try_files 返回 404（与 HTTP-only 模板同样原因）。

`/api/v2/` 长 timeout（3600s）和 `proxy_buffering off` 是为 Rust 端慢查询 / 长 streaming 场景留余地。

### `/ws/` WebSocket 中枢

```nginx
location ^~ /ws/ {
    proxy_pass         http://hsh_rust_backend;
    # WebSocket upgrade
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection $connection_upgrade;
    # ...
}
```

`/ws/dashboard` 这类实时通知走这里。WebSocket 升级用文件顶部的 `map $http_upgrade $connection_upgrade` 变量：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

比无脑写死 `Connection "upgrade"` 正确——普通 REST 请求 `$http_upgrade` 是空字符串，nginx 给 upstream 发 `Connection: close`，避免把 upstream 的 keepalive 连接搞坏。

### `/api/` → FastAPI v1（兼容）

```nginx
location /api/ {
    client_max_body_size       300m;
    # ...

    proxy_pass http://myerp_backend;
    proxy_set_header Connection "upgrade";
}
```

upstream `myerp_backend` = `backend:8000`（FastAPI 历史 v1，仅作兼容兜底）。

`client_max_body_size 300m` 是 2026-07-22 新增——批量图纸上传 `POST /parts/batch-with-pdfs` 需要多 PDF multipart，nginx 默认 1m 会被 413 拦截；与后端 `BIZ_REQUEST_TOO_LARGE` 守卫对齐。

## 缓存策略

| 路径 | 策略 | 原因 |
|---|---|---|
| HTML（`/`） | 无缓存（默认） | SPA 入口，版本更新要立即生效 |
| `/assets/*` | `expires 1y` + `Cache-Control: public, immutable` | vite 产出的 hashed 资源，文件名带 hash 即可长期缓存 |
| `.mjs` | `expires 1h`，**不**强制 immutable | 与 worker MIME 历史教训呼应——1h 后 revalidate |
| `/api/`、`/api/v2/`、`/ws/` | no-cache（默认） | API 响应不该被缓存 |

## SPA fallback

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

所有不命中静态资源的请求都回退到 `index.html`，让前端路由（vue-router）接管。这是所有 SPA 部署的标准配置。

## HTTP-only 配置（`nginx.http-only.conf`）

`nginx.http-only.conf` 与 HTTPS 模板去掉 SSL / HSTS 后基本一致——所有 location（`.mjs` / `/api/v2/` / `/ws/` / `/api/` / `/`）、所有反代头、所有缓存策略都相同。**没有**以下 HTTPS-only 项：

- `listen 443 ssl` / `http2 on` / `ssl_certificate` 等 SSL 配置
- `add_header Strict-Transport-Security ...`（HTTP 下带 HSTS 会锁死浏览器到 HTTPS）
- `:80` 301 跳转（HTTP-only 直接服务，不重定向）

用途：本地无证书环境 / 内网部署 / 备案前的测试服。改 HTTPS 模板的 location 时**必须**同步这一份（`nginx.http-only.conf` 顶部注释明确警告过）。