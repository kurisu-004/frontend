# Docker 镜像构建

> **目标读者**：部署运维 / Agent
> **核心价值**：把 Dockerfile 两阶段（node 构建 → nginx 托管）的每一步解读清楚，含构建命令、推送、容器启动流程与运行时注意事项
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 多阶段镜像概览

整个前端产物是一个 Docker 镜像 `myerp-frontend`，分两个阶段构建：

| 阶段 | 基础镜像 | 作用 | 产物 |
|---|---|---|---|
| builder | `node:24-alpine` | 安装依赖 + vite build | `dist/` 静态文件 |
| runtime | `nginx:1.30-alpine` | 托管 `dist/` + 反代后端 | 可运行的容器 |

最终镜像只包含 `nginx + dist + nginx.conf + entrypoint.sh`，node 工具链在 builder 阶段结束后被丢弃。镜像体积比单阶段小一个数量级（典型 ~50MB vs ~600MB）。

## 阶段 1：构建（builder）

基础镜像 `node:24-alpine`：`alpine` 是 musl libc 的极简发行版，体积 ~80MB；node 24 是当前 LTS。

工作目录 `/app`，先把 `package.json` + `package-lock.json` 单独 COPY 出来再 `npm ci`——这样源码改动不会让依赖层失效，配合 `--mount=type=cache,target=/root/.npm` 让 npm 缓存跨构建复用。

依赖安装命令：

```dockerfile
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
```

- `npm ci`：严格按 `package-lock.json` 安装，**保证**可复现构建；CI/部署必须用 ci，不要 `npm install`。
- `--no-audit --no-fund`：跳过 npm audit 提示与 funding 信息，减少构建日志噪音。
- `--mount=type=cache`：BuildKit 层缓存，缓存命中时这层几乎瞬时返回。

### 只跑 `npx vite build`（不做类型检查）

```dockerfile
COPY . .
RUN npx vite build
```

`Dockerfile` 注释里写明了理由：CI 负责类型检查（lint 流程），Docker 只负责产物体积。vite 用 esbuild 转译时会自动剥除 TS 类型注解，所以 build 本身不需要类型正确。**把类型检查失败挡在更上游（CI）的设计**：Docker 镜像只是产物的搬运工，类型错误的代码根本不该进入构建队列。

如果改了 Dockerfile 注释想加 `vue-tsc`，需要权衡：构建时间 +15s（项目当前约 600 个 `.vue` + 2000 个 `.ts` 文件），换来"Docker 也能拒类型错代码"——但 CI 已经挡了，重复检查没收益。

## 阶段 2：托管（runtime）

基础镜像 `nginx:1.30-alpine`，保留体积优势。

```dockerfile
RUN rm -f /etc/nginx/conf.d/default.conf \
    && apk add --no-cache wget bash gettext \
    && mkdir -p /etc/nginx/ssl

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx.http-only.conf /etc/nginx/templates/http-only.conf
COPY entrypoint.sh /docker-entrypoint.d/40-nginx-ssl-gate.sh
COPY --from=builder /app/dist /usr/share/nginx/html
```

每一步的作用：

- `rm -f default.conf`：清掉官方镜像自带的 default server，避免与我们的 80/443 server 块冲突。
- `apk add --no-cache wget bash gettext`：`wget` 给 HEALTHCHECK 用；`bash` / `gettext` 给 `entrypoint.sh` 用（envsubst 来自 gettext）。
- `mkdir /etc/nginx/ssl`：docker-compose 把证书 bind mount 到这个目录。
- `COPY nginx.conf` → `/etc/nginx/conf.d/default.conf`：HTTPS 版模板；`COPY nginx.http-only.conf` → `/etc/nginx/templates/http-only.conf`：HTTP-only 兜底模板。
- `COPY entrypoint.sh` → `/docker-entrypoint.d/40-nginx-ssl-gate.sh`：nginx:alpine 默认 entrypoint 会在 `exec nginx` 之前自动跑 `/docker-entrypoint.d/*.sh`（按字典序），这里利用这个机制把 SSL 切换放到 nginx 启动之前。
- `COPY --from=builder`：从 builder 阶段取 `dist/`，不携带 node 工具链。

## 健康检查

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-check-certificate -q --spider http://127.0.0.1/ || exit 1
```

`--no-check-certificate` 是为了支持自签证书场景；`--spider` 不下载 body，只验证响应码。`docker ps` 看到的 health 状态由此命令决定，编排（docker-compose / k8s）也读这个状态决定容器是否就绪。

## 构建命令

```bash
docker build -t myerp-frontend .
```

构建上下文是 `.`（项目根，Dockerfile 在根）。Mac Apple Silicon 本地构建默认出 arm64，线上 amd64 CVM 跑不动，需要显式指定 platform：

```bash
docker build --platform linux/amd64 -t myerp-frontend .
```

或者直接用仓库自带的推送脚本 `scripts/push-frontend.sh`（已内置 `--platform linux/amd64`）。

## entrypoint.sh 启动流程

容器 `docker run` 起来后实际执行顺序：

1. **nginx:alpine 的 `/docker-entrypoint.sh` 启动**——它会先 `run-parts /docker-entrypoint.d/`，再 `exec CMD ["nginx", "-g", "daemon off;"]`。
2. **`/docker-entrypoint.d/40-nginx-ssl-gate.sh` 执行**（也就是我们 COPY 进去的 `entrypoint.sh`）：
   - 检查 `${SSL_CRT_FILENAME}` + `${SSL_KEY_FILENAME}` 是否真实存在于 `/etc/nginx/ssl/`（docker-compose bind mount 进来的）。
   - 存在 → 用 `/etc/nginx/conf.d/default.conf`（HTTPS 模板）；不存在 → `cp /etc/nginx/templates/http-only.conf` 覆盖（HTTP 兜底）。
   - 用 `envsubst '${NGINX_SERVER_NAME} ${NGINX_REDIRECT_TARGET} ${SSL_CRT_FILENAME} ${SSL_KEY_FILENAME}'` 渲染占位符到最终配置。
3. **`exec CMD nginx -g 'daemon off;'`**——前台跑 nginx，主进程接管 PID 1。

**为什么不在 entrypoint.sh 里直接 `nginx`**：那样会绕过 nginx:alpine 镜像本身的初始化（log dir、pidfile 等），与升级镜像时遇到的默认行为漂移。我们利用它现有的 hook 机制把 SSL 切换"插队"到 nginx 启动前即可。

## 推送镜像到 TCR

`scripts/push-frontend.sh` 一键脚本：

```bash
./scripts/push-frontend.sh                       # 默认：TAG_PREFIX=prod，打 SHA + latest 两个 tag
TAG_PREFIX=staging ./scripts/push-frontend.sh    # 推 staging
DOCKER_REPO=ccr.ccs.tencentyun.com/foo ./scripts/push-frontend.sh
VERSION=0.2.10 ./scripts/push-frontend.sh        # 发布版：只打 VERSION tag（不打 SHA / latest）
```

凭据从 `frontend/.env` 或 fallback 到 `~/Code/.env` 读取 `DOCKER_USERNAME` / `DOCKER_PASSWORD` / `DOCKER_REPO`。脚本自动 `docker login`、build（带 `--platform linux/amd64`）、push、logout。

镜像标签规范：`<DOCKER_REPO>/<TAG_PREFIX>-frontend:<tag>`。生产默认 `TAG_PREFIX=prod-frontend`，运维按 tag 切换。

## 常见构建问题

### `npm ci` 失败

报错 `EUSAGE` / `MISSING` / 锁文件与 package.json 不一致：

- 先 `npm install` 让 lock 与 package.json 同步，再 `git commit package-lock.json`。
- 不要在 CI / 部署里用 `npm install` 绕过，会引入不可复现构建。

### 构建慢

- 检查 `optimizeDeps.include` 是否漏列了新加的重依赖。
- 用 `--mount=type=cache,target=/root/.npm`（已配）保持 npm 缓存跨构建；CI runner 重启后第一次会冷启。

### 镜像体积异常大

`dist/` 被打入无关文件——检查 `.dockerignore` 是否存在。当前仓库根目录 `.dockerignore` 应排除 `node_modules/` / `dist/` / `.git/` 等。

## 运行时注意事项

- 容器监听 80（HTTP 兜底或 HTTPS 跳转）+ 443（HTTPS 主服务）；编排需要暴露这两个端口。
- SSL 证书由 docker-compose bind mount 进来（不是 COPY 进镜像）——这样证书轮换不需要重建镜像。
- `client_max_body_size 300m` 已在 nginx `location /api/` 配（批量 PDF 上传场景）；前端 axios 默认 body 限制远小于此，按需调整。
- nginx 重启用 `nginx -s reload` 不需要重启容器；配置变更走 `docker compose restart frontend` 或 reload 信号。
- HEALTHCHECK 命令基于 `127.0.0.1/` 自检（首页 HTML），反映 nginx 自身存活，不反映后端健康——后端监控要单独看 backend 容器的 health。