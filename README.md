# myERP Frontend

基于 **Vite + Vue 3 + TypeScript + Element Plus** 的后台管理系统前端。

## 功能

- 左侧菜单栏（可展开/收起）
- 顶栏：面包屑 + 用户头像下拉
- 零件一览：条件查询区可折叠，表格列排序，库存预警，新增/查看/编辑/删除

## 主题色

藏青 `#1e4d8b` · 蓝 `#2c6cb8` · 浅蓝 `#4a8fd6` · 灰 `#f5f7fa` · 白 `#ffffff`

## 启动

```bash
cd frontend
npm install
npm run dev          # 开发 http://localhost:5173（/api + /ws 代理到 Rust :3000）
npm run dev:dummy    # dummy-auth 模式：跳过登录，注入 dev-admin 会话
npm run typecheck    # vue-tsc 类型检查
npm run build        # 构建（vue-tsc --noEmit && vite build）
npm run lint         # ESLint v9 + alloy preset（提交前必过）
npm run lint:fix     # 自动修复
npm run format       # Prettier v3 写入格式化
npm run format:check # Prettier v3 校验（提交前必过）
npm run test         # vitest run（全部单测）
```

## 目录结构

```
src/
├── api/             # 接口 & mock（.ts，按域切分；api / refreshClient 两个 axios 实例）
├── components/      # 跨业务域通用组件（13+ 个）
├── composables/     # 模块级单例 composable（30+ 个）
├── constants/       # 静态映射（partStatus / batch / bid / crud / file）
├── layouts/         # 布局组件（MainLayout 等）
├── router/          # 路由（含 RouteMeta 类型扩展，menuCode 单一权限源）
├── styles/          # 全局样式 & 主题变量
├── types/           # 业务/组件类型
├── utils/           # 工具函数（pdfjs / jwt / date / excel parsers）
├── views/           # 页面（14 业务域）
│   ├── auth/        # 登录（独立全屏路由）
│   ├── parts/       # 零件 + 装配
│   ├── customers/   # 客户
│   ├── applicants/  # 申请人
│   ├── workers/     # 工人 + 生产队列看板
│   ├── users/       # 账号
│   ├── shelves/     # 货架
│   ├── inspection/  # 待品检 + ScanBatchPickerDialog
│   ├── outsource/   # 外协
│   ├── repair/      # 返修
│   ├── scan/        # 工位扫码台（独立全屏路由）
│   ├── delivery/    # 送货单 + 扫码建单
│   ├── delivery-dispatch/  # 司机送货台（独立全屏路由）
│   ├── cnc/         # CNC 待编程
│   ├── statistics/  # 生产统计
│   ├── production/  # 工序制定 + 工序工种
│   ├── assemblies/  # 装配件详情（路由并入 /parts）
│   ├── Dashboard.vue
│   └── WorkerList.vue
├── App.vue
├── env.d.ts
└── main.ts
```

## 后端联调

后端对外是**单入口 Rust（axum，:3000）**，`/api/v2/*` 与 `/ws/*` 全部由它提供：

- `/api/v2/*` —— `api` 与 `refreshClient` 两个 axios 实例消费（`refreshClient` 是 refresh
  端点用的裸实例，不带业务拦截器），dev 由 `vite.config.ts` 代理到 `http://127.0.0.1:3000`。
- `/ws/*` —— dashboard 长连接（`src/api/dashboard.ts` 单例），dev 必须有 `/ws` 反代：
  Vite 的 dev upgrade 监听器只对匹配到的 proxy context 转发，缺了表现为「页面数据正常
  但控制台一直刷 WS 报错」。
- Python 后端只在 compose 内网经 rust 转发触达，浏览器不直连：4 个打印端点（零件图纸
  PDF 单件 / 批量、送货单 PDF、标签 Excel）与 COS STS 临时凭证签发都由 rust 鉴权后转发。
  前端只用 `/api/v2`——dev 的 proxy context 是 `/api`、生产走 nginx，两边都落到 rust，
  nginx 不再有指向 Python 的 `/api/` 反代。
  例外是本地联调：`docker-compose-local.yml` 仍把 Python 的 8000 直连映射到宿主机
  （`${BACKEND_HOST_PORT:-8000}:8000`）方便直调；生产 / staging 不经 nginx 暴露该端口。

生产 / staging 通过 nginx 反代，前端不直接接触后端端口。启动本地全栈见仓库根
`docker-compose-local.yml`（`docker compose -f docker-compose-local.yml up -d --build`）。

## 已知安全风险提示

依赖 `xlsx@0.18.5` 存在原型污染与 ReDoS 高危漏洞（npm audit 标记为 high），npm 官方仓库暂无修复版本（SheetJS 新版只通过自己的 CDN 分发，未发布到 npm）。本系统仅将 `xlsx` 用于**内部上传 Excel 的只读解析**（4 个 parser 工具函数 + 3 个视图统一收口，不执行公式/宏），攻击面可控。经评估决定保留该版本并承担风险；后续若迁移至 SheetJS CDN 版或替代库（如 exceljs），再行升级。
