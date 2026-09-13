---
created: 2026-09-14
scope: pinia ^2 → ^3 升级决策与排查
status: tracking
related-branch: feat/print-template-v2
related-worktree: frontend/.claude/worktrees/print-template-v2
related-comments:
  - src/composables/useAmdPrintTemplates.ts（重命名 + 与包版适配的 storage 层）
  - src/views/print-templates/PrintTemplateDesigner.vue（包版编辑器）
---

# 2026-09-14 Pinia ^2 → ^3 升级登记

> **目标读者**：Agent / 前端 reviewer
> **核心价值**：解释为什么 print-template-v2 工作流要顺带把 `pinia` 从 `^2.1.7` 升到 `^3.0.4`，登记改动范围、验证结果与后续观察点。
> **最后更新**：2026-09-14 · **维护者**：@frontend-team

---

## Context

`feat/print-template-v2` worktree 的核心动作是用 `@amdosion/vue3-print` 包替换自研打印模板编辑器（探针期已合并的 786eddf / 62db727 旧实现）。

观察包内 dts（`node_modules/@amdosion/vue3-print/dist/hiprint/compat/print-template.d.ts`）：

```ts
/**
 * Each PrintTemplate owns a private Pinia instance so multiple templates can
 * coexist on the same page (the established behavior used implicit global singletons).
 */
import { type Pinia } from 'pinia';
```

且 `build-designer.d.ts` 注释也明确：

> Create an internal `PrintTemplate` (owns its own Pinia) so the same store set powers both the controller's getJson/update AND the mounted SFC.

也就是说包会**自建一份 Pinia 实例**通过 `createPinia()` 注入运行时（每个 PrintTemplate 一个私有 Pinia + 共享 store schema），而不再像 vue-admin-main 的旧 jQuery 时代那样挂在 window.hiprint 上做隐式全局单例。

虽然包自带的 Pinia 是私有实例，但**它运行时从 `pinia` 包导入 `createPinia` / `setActivePinia` / `defineStore` 等 API**。如果宿主项目锁在 Pinia 2.x 而包依赖 Pinia 3 的 runtime 类型或行为（比如 `setActivePinia` 在 Pinia 3 中的 typed `null` 收紧、`acceptMutations` 的内部 cleanup 变化），会出现：

- 嵌入运行时报 `defineStore is not a function`（极少见，多版本并行时 hoist 错乱）；
- TypeScript 编译期报 `Cannot find name 'Pinia'`（Pinia 3 调整了部分类型的导出位置）；
- 包内 `assertNotDestroyed` / `setActivePinia` 调用与宿主 `createPinia()` 注入的实例在 HMR 场景下出现 "active pinia is undefined"。

为消除这一类隐性问题（用户决策：探针确认后立刻升，避免遗留混合版本），同步升级到 `pinia ^3.0.4`，与包所依赖的 runtime 对齐。

---

## 调研结果：Pinia 在我们代码中的使用面

`grep -rn "defineStore\|createPinia\|useStore\|from 'pinia'" src --include="*.ts" --include="*.vue"`：

```
src/main.ts:2:  import { createPinia } from 'pinia';
src/main.ts:34: app.use(createPinia());
```

**结论：仓库当前没有 Pinia store**（CLAUDE.md #1 硬约束：不要新建 Pinia store），唯一引用是 `main.ts` 的 `createPinia()` 实例化与 `app.use(...)`。

升级影响面：

| API                        | 状态       | 备注                                 |
| -------------------------- | ---------- | ------------------------------------ |
| `createPinia()`            | 不变       | Pinia 3 仍导出同名函数，参数语义一致 |
| `app.use(createPinia())`   | 不变       | Vue plugin 协议兼容                  |
| `defineStore` / `useStore` | **未使用** | 升级无影响                           |

升级过程中**没有改任何业务代码**（除了 print-templates 路由 / view 的重构，与 Pinia 升级本身无关）。

---

## 变更清单

| 文件                                                              | 改动                                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                    | `pinia: ^2.1.7` → `pinia: ^3.0.4`（dependencies）                                                                     |
| `package-lock.json`                                               | `npm install` 自动同步 lockfile（pinia 3.0.4 entry）                                                                  |
| `src/main.ts`                                                     | 移除 `@amdosion/vue3-print/dist/{vue3-print.css,print-lock.css}` 两条全量 import（注释保留说明改路由级 import）       |
| `src/views/print-templates/PrintTemplateDesigner.vue`             | 顶部 `<script setup>` 加这两条路由级 import                                                                           |
| `src/router/index.ts`                                             | 删除旧 `/print-templates` + `/print-templates-designer` 双路由，合并为单 `/print-templates` → `PrintTemplateDesigner` |
| `src/composables/useAmdPrintTemplates.ts`                         | 新增（替换被删除的 `usePrintTemplates.ts`）                                                                           |
| `src/views/print-templates/PrintTemplateEditor.vue` 等 8 个旧文件 | `git rm`（自研三栏编辑器已下线）                                                                                      |

---

## 已验证

| 检查                                                | 结果                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `npm install`                                       | OK（无 ERESOLVE，无 breaking peer dep 警告）                       |
| `npm run typecheck`                                 | OK（vue-tsc --noEmit）                                             |
| `npm run lint`                                      | OK（0 errors / 0 warnings）                                        |
| `npm run format`                                    | OK（prettier --write 自动修正格式）                                |
| `npm run build`                                     | OK（vue-tsc + vite build 全部 chunk 生成成功）                     |
| `npm run dev:dummy` + 浏览器访问 `/print-templates` | OK（设计器 UI、bar、mock 数据、localStorage 写入均正常）           |
| 首屏 CSS 隔离                                       | OK（访问 `/dashboard` 不下载 `vue3-print.css` / `print-lock.css`） |

---

## 后续观察

1. **Vue 3 / EP 升级窗口**：下次升 Vue 3 大版本（如 3.6+）时再回头确认 Pinia 3 是否仍是目标版本上游推荐（目前 Pinia 3 主线与 Vue 3.5+ 同步）。
2. **vite 8 / rolldown**：包版运行时依赖 `@vueuse/core`（见 `dependency-risks.md` 第 3 节 rolldown 噪音），Pinia 3 升级本身不引入新噪音，但若后续 vite/rolldown 升级触及 Pinia 内部 store 创建路径，需回头验。
3. **嵌入运行时切换**：未来若换包（如 `vue-print-next` 等），同样按"包依赖的 Pinia 版本 ≥ 宿主 Pinia 版本"对齐即可。
4. **不要回退**：本仓库一旦在 dev / prod 同时跑包版 + 旧版组件，包内部 Pinia 与宿主 Pinia 版本不一致会引发运行时隐性问题。不要回退到 2.x。
5. **CLAUDE.md #1**（不建新 Pinia store）保持不变——本升级仅 bump 版本号，不引入新 store。

---

## 相关文档

- [`docs/08-known-risks/dependency-risks.md`](./dependency-risks.md) —— 全仓依赖风险登记总入口（本节为新增条目）
- [`docs/08-known-risks/lint-fix-2026-09-13.md`](./lint-fix-2026-09-13.md) —— 最近的 lint fix 决策参考格式
- `frontend/CLAUDE.md` 硬约束 #1（不建 Pinia store） / #4（EP CSS 手动 import）/ #14（lint + format 强制）
