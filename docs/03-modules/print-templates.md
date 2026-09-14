# 打印模板

> **目标读者**：MANAGER / 前端开发（维护打印模板编辑器）
> **核心价值**：送货单 / 工单标签的打印模板可视化编辑器，让运营 / 仓管自行调整字段布局、字体、二维码位置，不再依赖前端改代码
> **最后更新**：2026-09-14 · **维护者**：@frontend-team

---

## 一、入口与路由

| 路径               | 路由名                  | 守卫                            |
| ------------------ | ----------------------- | ------------------------------- |
| `/print-templates` | `PrintTemplateDesigner` | `requireAuth` + `allowRoles: ['MANAGER']` |

- `menuCode` 当前**留空**：未在 `t_menu` 表配置菜单项，路由通过 `allowRoles` 短路放行（参考 [`docs/02-architecture/routing-and-permissions.md`](../02-architecture/routing-and-permissions.md) 「SHELF_ACCOUNT 进 `/scan/*`」的真实例子）。
- 组件：`src/views/print-templates/PrintTemplateDesigner.vue`
- 侧栏路径：暂未接入菜单（仅有顶层 router entry），prod 暂不上线；dev:dummy 模式下登录后可在浏览器地址栏直接访问。

## 二、关键页面

| 文件                                                | 职责                                                      |
| --------------------------------------------------- | --------------------------------------------------------- |
| `src/views/print-templates/PrintTemplateDesigner.vue` | 单页应用：左侧模板列表 + 中间画布 + 右侧属性面板         |
| `src/composables/useAmdPrintTemplates.ts`           | 模板存储层（pinia 适配 + localStorage 兜底 + 打印实例化） |

页面布局：

- **左**：模板列表（按类型 / 业务域分组），顶部「新建模板」按钮（仅 MANAGER 可见）
- **中**：画布，基于 `@amdosion/vue3-print` 的可拖拽元素层（文本 / 图片 / 二维码 / 条形码 / 形状）
- **右**：选中元素的属性面板（位置 / 尺寸 / 字体 / 数据绑定字段名）

## 三、依赖与基础设施

### 3.1 `@amdosion/vue3-print ^1.0.40`

2026-09-14 新增依赖。底层拖拽 / 缩放 / 打印预览逻辑全部由该包提供，前端不再自建。详见 [`docs/08-known-risks/dependency-risks.md`](../08-known-risks/dependency-risks.md) 第 5.1 节。

### 3.2 `useAmdPrintTemplates` composable

模块级单例 composable（pinia `^3.0.4` 升级后 2026-09-14 落地）：

- `templates` — 当前所有模板 ref<Record<string, Template>>
- `saveTemplate(id, payload)` — 落盘到后端 + localStorage 兜底
- `render(templateId, data)` — 实例化打印对象（供 `deliveryNote.printNote` 调用）

## 四、为什么替换原 `usePrintTemplates` + 8 个自建文件

原方案（2026-08 之前）：

- 自建 8 个 .ts/.vue 文件实现元素选区 / 拖拽 / 缩放 / 打印预览
- 单文件平均 300+ 行，跨文件传递选中状态用模块级 ref 漏单易出现
- 修改「打印坐标 → 实际打印位置」映射每次都是手算

新方案（2026-09-14 起）：

- 依赖收敛到一个活跃维护的 npm 包（详细决策见 `dependency-risks.md` §5.1）
- 维护成本：原 8 个文件压缩到 1 个 composable + 1 个页面
- 「打印坐标 → 实际打印位置」由包提供 mm/pt 转换
- pinia `^3.0.4` 同步升级（2026-09-14 commit `092fcc2`），包要求 pinia v3+

## 五、route-level CSS 导入约定

pinia `^3.0.4` 升级后，路由级组件 CSS 导入位置有调整：

- 编辑器专属样式（`@amdosion/vue3-print` 的覆盖样式）放在 `src/views/print-templates/styles/` 下
- 由 `PrintTemplateDesigner.vue` 在 `<script setup>` 顶部 `import './styles/editor.scss'` 显式导入
- **不要**塞到 `src/styles/index.scss` 全局（避免污染其它页面）

## 六、开发态访问入口

```bash
npm run dev:dummy    # dummy-auth 模式，登录后注入 MANAGER + SHELF_ACCOUNT 会话
```

在浏览器地址栏输入 `http://localhost:5173/print-templates` 直接进入编辑器。dummy 模式下 `useAuthSession` 已注入 admin session（含 22 个 menuCode 全菜单），`allowRoles: ['MANAGER']` 短路放行通过。

> 注意：dummy 模式下此路由**可见但 menuCode 留空**，守卫第 3 步 menuCode DFS 校验会失败，因此**必须**靠 `allowRoles` 短路兜底，**不要**给该路由加 menuCode（prod 上线时才需要）。

## 七、后端契约

- 模板存储：`POST /api/v1/print-templates`（v1 FastAPI 暂存端点，待 v2 迁回时统一更新）
- 模板渲染：`POST /api/v1/print-templates/{id}/render`（返回打印实例化后的 base64 / blob）
- 数据契约详见 `~/Code/hsh-erp-rust/docs/api/print-templates.md`（待补）

## 八、关键约束与陷阱

- **雪_ID 必须 string**：模板引用的 `part_id` / `customer_id` 全部按 string 传
- **编辑器懒加载**：`PrintTemplateDesigner.vue` 必须用 `() => import('@/views/print-templates/PrintTemplateDesigner.vue')` 异步加载，**不要**直接 `import` —— `@amdosion/vue3-print` 体积约 80KB gzip
- **route-level CSS 隔离**：编辑器样式只能 `./styles/...` 局部导入，污染全局会让其它页面的 el-table 列宽/字号漂移
- **打印模板数据绑定**：右侧属性面板的「数据字段」下拉必须从后端 `/print-templates/fields` 拉白名单，**不要**让用户在编辑器里随便写字段名
- **`allowRoles` 与 menuCode 的取舍**：本路由是典型的「菜单树缺位但业务上必须能进」场景，参考 `routing-and-permissions.md` 「SHELF_ACCOUNT 进 `/scan/*`」决策树

## 九、未来扩展位

- 模板版本对比：编辑模板时保留最近 3 版快照，支持 diff 与回滚
- 模板导出：把模板导出为独立 JSON / 让运营跨实例搬运
- 字段联动校验：拖入「二维码」元素时自动检查是否选了「字符串类型字段」，避免运行时错误