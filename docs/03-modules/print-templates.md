# 表格编辑器

> **目标读者**：前端开发 / MANAGER 角色用户（维护 / 使用表格编辑器）
> **核心价值**：通用的 in-memory 表格编辑器（X-spreadsheet），用户可即时编辑二维表内容；本期不做持久化、不接后端
> **最后更新**：2026-09-16 · **维护者**：@frontend-team

---

## 一、入口与路由

| 路径               | 路由名                  | 守卫                                      |
| ------------------ | ----------------------- | ----------------------------------------- |
| `/print-templates` | `PrintTemplateDesigner` | `requireAuth` + `allowRoles: ['MANAGER']` |

- `menuCode` 当前**留空**：未在 `t_menu` 表配置菜单项，路由通过 `allowRoles` 短路放行（参考 [`docs/02-architecture/routing-and-permissions.md`](../02-architecture/routing-and-permissions.md) 「SHELF_ACCOUNT 进 `/scan/*`」的真实例子）。
- 组件：`src/views/print-templates/PrintTemplateDesigner.vue`
- 侧栏路径：暂未接入菜单（仅有顶层 router entry），prod 暂不上线；dev:dummy 模式下登录后可在浏览器地址栏直接访问。

## 二、关键页面

| 文件                                                  | 职责                                                |
| ----------------------------------------------------- | --------------------------------------------------- |
| `src/views/print-templates/PrintTemplateDesigner.vue` | 单页应用：顶部说明栏 + X-spreadsheet 表格编辑器主区 |

页面布局：

- **顶部 bar**：左侧标题「表格编辑器」+ 一行说明文字「基于 X-spreadsheet，编辑内容仅在本会话保留（刷新清空）」；右侧「重置示例」按钮（把当前 sheet 数据回退到初始 5×5 样本）
- **主区域**：一个全宽的 X-spreadsheet 容器，启用 `showToolbar / showGrid / showContextmenu`，固定高度 600px，宽度自适应容器 `clientWidth`

不再使用：

- `src/composables/useAmdPrintTemplates.ts` —— 2026-09-16 已删除。原 `@amdosion/vue3-print` 配套的 localStorage 存储 + 模块级单例 composable 一并下线。

## 四、依赖与基础设施

### 4.1 `x-data-spreadsheet ^1.1.9`

2026-09-16 新增依赖，替换原 `@amdosion/vue3-print ^1.0.40`。

要点：

- 包名为 `x-data-spreadsheet`（npm 上发行名），`import` 时用 `x-data-spreadsheet`。
- 类型文件 `src/index.d.ts` 较简陋，本 view 用 `// @ts-expect-error` 兜底静态 import 与 zh-cn locale 的解析问题。
- CSS 走**路由级 import**：仅在 `PrintTemplateDesigner.vue` 顶部 `import 'x-data-spreadsheet/dist/xspreadsheet.css'`；**不要**塞到 `src/main.ts` 全局（避免污染其它页面 + 让 index chunk 多载一份无用样式）。
- 包本身是 CommonJS（`main: src/index.js`），运行时仅依赖 DOM API（`window` / `document` 等），**仅客户端**可用。当前项目无 SSR，无需额外 guards。
- 中文 locale 通过 `Spreadsheet.locale('zh-cn', zhCn)`（静态方法）注册；locale 文件从 `x-data-spreadsheet/src/locale/zh-cn.js` 导入（CommonJS 子路径未声明类型，需要 ts-expect-error）。

### 4.2 数据持久化策略

**完全 in-memory**：

- 不写 `localStorage` / `sessionStorage` / IndexedDB
- 不做导入 / 导出 / 保存 / 加载按钮
- 不接任何后端 API（v1 / v2 都无）
- 用户离开路由 / 刷新页面后**所有编辑内容清空**，下次进入只看到初始 5×5 示例

未来若需要持久化，按以下顺序迭代：

1. 在 view 顶部加「保存到 localStorage」按钮（单页 demo 级）
2. 接后端 `api.post('/print-templates/sheets')` 系列端点
3. 落 v2 后端（参考 `~/Code/hsh-erp-rust/docs/api/` 当前域）

## 五、为什么从 `@amdosion/vue3-print` 改造过来

历史脉络：

- 2026-09-14：上线 `@amdosion/vue3-print` 包版设计器（包版可视化编辑器，含元素层 / 数据绑定 / 打印预览）
- 2026-09-16：调整为 `x-data-spreadsheet` 通用表格编辑器

本期变更原因：

- 业务方调整方向，从「打印模板设计器」过渡到「通用表格编辑器」临时方案
- X-spreadsheet 是更轻量的表格交互控件（公式 / 多 sheet / 单元格格式 / 拖拽选区等）
- 依赖收敛：原 80KB gzip 的 `@amdosion/vue3-print` 包退出，X-spreadsheet 体积更小、无 peerDependencies
- 不再做模板 JSON 序列化 / 打印预览 / 数据绑定，复杂度大幅下降

约束保持：

- 路由 / `menuCode` / `allowRoles` 不动（与原一致）
- 路由级 CSS 隔离策略不变

## 六、route-level CSS 导入约定

- 表格编辑器专属样式（`x-data-spreadsheet` 的覆盖样式 + view 自身 scoped style）在 `PrintTemplateDesigner.vue` 顶部 + `<style scoped>` 内集中维护
- **不要**塞到 `src/styles/index.scss` 全局（避免污染其它页面）

## 七、开发态访问入口

```bash
npm run dev:dummy    # dummy-auth 模式，登录后注入 MANAGER + SHELF_ACCOUNT 会话
```

在浏览器地址栏输入 `http://localhost:5173/print-templates` 直接进入编辑器。dummy 模式下 `useAuthSession` 已注入 admin session（含 22 个 menuCode 全菜单），`allowRoles: ['MANAGER']` 短路放行通过。

> 注意：dummy 模式下此路由**可见但 menuCode 留空**，守卫第 3 步 menuCode DFS 校验会失败，因此**必须**靠 `allowRoles` 短路兜底，**不要**给该路由加 menuCode（prod 上线时才需要）。

## 八、关键约束与陷阱

- **X-spreadsheet CommonJS import**：TS 类型不完整，静态 import 用 `// @ts-expect-error`（不要改 tsconfig，也不要扔进 skipLibCheck 之外）
- **运行仅客户端**：包初始化会访问 `window` / `document`，禁止在 SSR / Node 环境直接 import（当前项目无 SSR，但留意未来迁移）
- **`destroy()` API 不可靠**：X-spreadsheet 实例未暴露稳定的销毁入口，view 在 `onUnmounted` 里只清空容器 `innerHTML` 即可（不强调 `sheet.destroy()`）
- **route-level CSS 隔离**：编辑器样式只在 view 顶部 import，污染全局会让其它页面的 Element Plus 组件样式漂移
- **`allowRoles` 与 menuCode 的取舍**：本路由是典型的「菜单树缺位但业务上必须能进」场景，参考 `routing-and-permissions.md` 「SHELF_ACCOUNT 进 `/scan/*`」决策树
- **不做持久化的强约束**：本期明确无 localStorage / 后端保存入口，UI 上**不要**加「保存」「导出」按钮误导用户

## 九、未来扩展位

- 接后端持久化（v2 端点）：把 in-memory 的 sheet data 通过 `api.post('/sheets')` 落库 + 通过 `api.get('/sheets/:id')` 还原
- 多 sheet：X-spreadsheet 原生支持多 sheet（默认 data 数组可传多个 sheet 对象），后续可加「新建 sheet」「重命名 sheet」入口
- 导入 / 导出 CSV：直接复用 `sheet.getData()` / `sheet.loadData()` 即可，避免引入额外依赖
- 模板化预置：把常用「报价单」「清单」做成示例模板，用户一键载入
