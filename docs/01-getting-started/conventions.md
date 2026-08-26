# 代码规范与约定

> **目标读者**：新人前端 / 外部贡献者
> **核心价值**：代码风格、注释、commit、命名、路径别名、主题色 — 一次性把约定写清
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 语言

- **注释、commit message、文档**：一律中文
- **代码标识符**（变量名 / 函数名 / 类型名）：英文
- **日志字符串 / 用户可见文案**：中文
- 专有名词（Element Plus / Vite / Pinia / WebSocket 等）保留英文

## 注释风格

> 注释解释"**为什么**"，不是"**是什么**"。代码本身已经表达了"是什么"。

```ts
// 反例：注释复述代码
// 设置 count 为 0
count.value = 0

// 正例：注释解释为什么
// 2026-08-22 新增：v1 session 无 Redis，重置避免 40102 死循环
count.value = 0
```

### 日期戳约定

关键决策 / 重构点必须在注释里留日期戳，便于后人追溯：

```
// 2026-08-22 新增：xxx 缘由
// 2026-08-22 删除：yyy 因为 zzz
// 2026-08-22 重构：把 A 改为 B（commit 1234）
```

格式：`<YYYY-MM-DD> <动作>：<一句话缘由>`。本仓库通行做法，CLAUDE.md "架构要点" 段大量使用。

## commit message 规范

格式：`<前缀>(<scope>): <中文一句话>`

| 前缀 | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 重构（不改行为） |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建 / 依赖 / 杂项 |
| `perf` | 性能优化 |

示例：

```
feat(parts): 新增批量 PDF 上传（v2 端点）
fix(auth): 40105 不走 refresh，直接 dispatch auth:logout
refactor(parts): api/parts.ts 拆为 4 子文件 + index 聚合
docs(architecture): 新增状态管理决策文档
```

commit body 可选；多人协作的 PR 推荐写清楚"为什么"和"取舍"。结尾不带 Co-Authored-By（项目未启用 CLA 工具）。

## 目录命名

- **业务域目录**：小写复数，kebab-case：`views/parts/`、`views/delivery-notes/`（实际 `delivery-notes` 已合并到 `delivery/`）
- **功能性子目录**：kebab-case：`views/parts/components/`、`utils/__tests__/`
- **避免**：下划线命名目录（与文件命名混用会造成 git diff 噪音）

## 文件命名

| 类型 | 命名 | 示例 |
|---|---|---|
| Vue 组件 | PascalCase | `PartsList.vue`、`PartDetail.vue` |
| composable | camelCase + `use` 前缀 | `useAuthSession.ts`、`useBarcodeScanner.ts` |
| API 模块 | camelCase + `.ts` | `auth.ts`、`parts.ts`、`deliveryNote.ts` |
| 业务类型 | camelCase + `.ts` | `parts.ts`、`deliveryNote.ts` |
| 工具函数 | camelCase + `.ts` | `pdfjs.ts`、`mergePdfs.ts` |
| 单测 | 与源文件同名 + `.spec.ts` | `useBulkPassInspection.spec.ts` |

> 一个例外：`src/api/parts.ts` 是历史兼容 shim，re-export 自 `./parts/index.ts`。**新增域不要再造这种 shim**，直接在 `src/api/<domain>.ts` 写代码。

## 路径别名

```ts
// vite.config.ts + tsconfig.json 双侧配置
'@' → 'src'
```

引用方式：

```ts
import { useAuthSession } from '@/composables/useAuthSession'
import PartInfoCard from '@/views/parts/components/PartInfoCard.vue'
import type { Part } from '@/types/parts'
```

**不要**用相对路径 `../../../composables/useAuthSession` 跨目录引用，可读性差且重构时易碎。

## 主题色

| 色名 | 十六进制 | 用途 |
|---|---|---|
| 藏青（主色） | `#1e4d8b` | EP `--el-color-primary` 覆盖（`src/styles/variables.scss`） |
| 蓝 | `#2c6cb8` | 次主色 |
| 浅蓝 | `#4a8fd6` | 高亮 / hover |
| 灰 | `#f5f7fa` | 背景 |
| 白 | `#ffffff` | 卡片底色 |

主题色通过 CSS 变量覆盖（不走 EP 2.14.x 尚未支持的 `theme` prop），详见 [02-architecture/build-and-tooling.md](../02-architecture/build-and-tooling.md)。

## 表单与弹窗约定

- 弹窗用 `el-dialog` + `:close-on-click-modal="false"`（避免误触关闭）
- 大表单拆分为 `el-form-item` 子组，配 `el-collapse` 折叠
- 必填项：`<el-form-item label="..." required>`（注意 `required` 不会触发校验，仍需 `prop` + `rules`）
- 提交按钮：loading 态用 `:loading="submitting"`
- 删除 / 不可恢复操作：必须 `ElMessageBox.confirm`，二次确认

## 错误处理约定

- **业务错误**：后端抛非 0 code → axios 拦截器抛 `ApiError(code, message)` → 调用方 `try/catch` 后用 `(e as ApiError).code` 判断业务分支。
- **认证错误**：`40101` 未登录 / `40102` access 过期 / `40103` refresh 失效 / `40105` session 吊销（v2 专属，救不回）。
- **用户提示**：`ElMessage.error(message)` 用后端 `message`；自定义文案用 `ElMessageBox.alert`。
- 不要用 `console.error` 替代用户提示（生产环境日志收集不替代 UI 反馈）。

## 硬约束（速查）

完整版见仓库根 [CLAUDE.md](../../CLAUDE.md) "硬约束" 段。这里只列最常踩的几条：

- **不要新建 Pinia store** — 共享状态沿用 composable 模块级单例
- **不要直接 `import 'pdfjs-dist'`** — 必须从 `@/utils/pdfjs` 引入
- **不要给 EP 写 `theme` prop** — 主题色走 CSS 变量
- **不要把雪花 ID 转 `Number()`** — 会丢精度，全用 `string`
- **不要新增 `src/modules/`** — 业务模块目录是 `src/views/<domain>/`
- **不要全量注册 EP** — 走按需加载（见 `main.ts` 注释）
- **不要写 emoji / "待补充" / 引用具体行号**
- **不要忽略 `optimizeDeps.include`** — dev 模式会触发整页 full-reload

## 提交前自检清单

- [ ] `npm run typecheck` 通过
- [ ] `npm run test` 通过（新增 / 改动的相关单测）
- [ ] `auto-imports.d.ts` / `components.d.ts` 如有 diff 已 review（unplugin 偶发重生成）
- [ ] 关键决策已写注释（带日期戳）
- [ ] commit message 格式正确（`前缀(scope): 中文一句话`）
- [ ] 涉及 v1 → v2 迁移，新接口在 `apiV2` 上加
