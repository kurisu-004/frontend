# 代码质量规范

> 2026-09-13 接入。统一 ESLint + Prettier 配置，所有 `.ts` / `.vue` / `.scss` / `.md` 文件遵循本文档。

## 1. 规范选型

- **ESLint**：v9 flat config（`eslint.config.mjs`），基于腾讯 AlloyTeam 官方 [`eslint-config-alloy`](https://alloyteam.github.io/eslint-config-alloy/) v5.x（vue + typescript preset）
- **桥接方式**：`alloy@5.x` 仅导出 legacy `.eslintrc` 预设，通过 `@eslint/eslintrc` 的 `FlatCompat` 转换为 flat config 数组
- **Prettier**：v3 大厂主流风格（`printWidth:100 / semi:true / singleQuote:true / trailingComma:"all"`）
- **不接**：Stylelint（保留 SCSS 不动）、husky / lint-staged（仅 `npm run` 命令入口，不强制 commit 流程）

## 2. 配置文件位置

| 文件                | 角色                                             |
| ------------------- | ------------------------------------------------ |
| `eslint.config.mjs` | ESLint flat config（alloy presets + 自定义豁免） |
| `.prettierrc.json`  | Prettier 风格参数                                |
| `.prettierignore`   | Prettier 排除项                                  |
| `.editorconfig`     | 编辑器基础规范（缩进 / 行尾 / 文件末尾空行）     |

## 3. npm 脚本用法

```bash
# 全量检查（CI / pre-merge 入口）
npm run lint          # eslint . --max-warnings=0
npm run format:check  # prettier --check .

# 本地修复
npm run lint:fix      # eslint . --fix
npm run format        # prettier --write .
```

**`npm run build` 不包含 lint**（Docker 镜像构建路径只跑 `npx vite build`，加 lint 会因格式问题阻断镜像产出）。

## 4. CLAUDE.md 硬约束豁免清单

`eslint.config.mjs` 已显式配置以下豁免，对应 `frontend/CLAUDE.md` 原硬约束：

| CLAUDE.md | 豁免内容                                                                              | 配置位置                                                                                                           |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| #4        | EP 命令式 API CSS（`element-plus/theme-chalk/*.css`）在 `src/main.ts` 必须手动 import | 不限制 `element-plus/theme-chalk/*` 路径                                                                           |
| #5        | `vite.config.ts` 的 `optimizeDeps.include` 不能删/改                                  | 配置文件独立分块（`vite.config.ts` / `vitest.config.ts` / `eslint.config.mjs`），node globals + 关 `no-console`    |
| #6        | pdfjs 必须从 `@/utils/pdfjs` 统一导入，禁止裸 `pdfjs-dist`                            | `no-restricted-imports` 限制；worker 子路径 `pdfjs-dist/build/pdf.worker.min.mjs` 仅在 `@/utils/pdfjs.ts` 内部允许 |
| #10       | `useLazyDraggable` 模式（容器可能为 null）放行                                        | 不限制 `vue-draggable-plus` import                                                                                 |
| #13       | `h()` 函数 children 形态（回归守卫单测）必须保留                                      | 不加 `vue/no-restricted-syntax` 对 `h()` 形态的限制                                                                |
| 新 #14    | `src/auto-imports.d.ts` / `src/components.d.ts` 不得手动 lint                         | `ignores` 字段直接排除（unplugin 生成）                                                                            |

## 5. 大厂共识

- **禁止文件级 `/* eslint-disable */`**（防批量绕过）→ 配置层优先解决；行级 `// eslint-disable-next-line` 必须注释说明原因
- **`reportUnusedDisableDirectives: 'error'`** → CI 检测「防患于未然」式禁用（即写了 disable 但对应规则已不触发）
- **`--max-warnings=0`** → warning 也阻断 lint exit code（lint-staged 等 hook 必备）
- **新增文件必须 0 warning**（CLAUDE.md #14 硬约束）→ 存量文件保留 baseline（见 `lint-baseline.log`），新增同类违规需修复

## 6. 本地与 CI 验证顺序

```bash
# 本地
npm run format && npm run format:check   # 格式化
npm run lint:fix                         # 自动修复
npm run lint                             # 验证
npm run typecheck                        # vue-tsc
npm run build                            # vite build（镜像路径）
npm run test                             # vitest

# CI（建议顺序）
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run test
```
