# CI 静态闸接入说明（format / lint / typecheck）

> 2026-10-20 新增。本文件登记 **frontend 仓内已完成**、但 **根仓 CI 仍需补** 的改动。
> 根仓的 `.github/workflows/ci-cd.yml` 不在 frontend 仓内，故本文件给出**可直接 apply 的完整片段**，
> 由合并阶段代为落到根仓。**本仓不要去改那个文件**（根仓另有未提交改动）。

## 背景

在此之前，根仓 `ci-cd.yml` 的 `test` job 对 frontend **只跑 `npm run test`（vitest）**，
`lint` / `typecheck` / `format:check` 三道闸一道都没接。结果就是格式持续漂移无人拦截：
本轮收口前 `npm run format:check` 已积压 **155 个文件**（125 个 `.ts` + 30 个 `.vue`）。
155 个文件的格式化已在 frontend 仓落地（`npm run format:check` 退出码 0），但**闸必须同时接进 CI**，
否则下一个提交就会重新开始漂移。

## 需要根仓补的改动

**文件**：根仓 `.github/workflows/ci-cd.yml`
**位置**：`jobs.test.steps` 里，`- name: frontend —— vitest` 这一步**之后**、`- name: 上传 junit-frontend` **之前**。

插入以下三个 step（原样 apply）：

```yaml
# 2026-10-20 新增：三道静态闸（format / lint / typecheck）。此前本 job 对 frontend
# 只跑 vitest，格式漂移 / lint / 类型报错全部无人拦截（format:check 曾积压 155 个文件）。
# 放在 vitest 之后：npm ci 写在 vitest 步骤里，若另起一步排在它前面就得再 npm ci 一遍
# （清空重装 node_modules，多花约 1 分钟），故按「同一 job 内、npm ci 之后」取后置位。
# 三步按「便宜 → 贵」排序：format:check(~10s) → lint(~20s) → typecheck(~30s)。
# 既有的 vitest 步骤与 junit 上传（双 fallback 逻辑、--reporter=junit 参数、
# junit-frontend.xml 路径）一字未改。
- name: frontend —— prettier format:check
  working-directory: frontend
  run: npm run format:check

- name: frontend —— eslint
  working-directory: frontend
  run: npm run lint

- name: frontend —— vue-tsc typecheck
  working-directory: frontend
  run: npm run typecheck
```

### 为什么放在 vitest 之后而不是之前

- **不重复 `npm ci`**：现有 `- name: frontend —— vitest` 步骤的 `run` 块里第一行就是 `npm ci`。
  要把闸插到它前面，就必须让新步骤自己再跑一遍 `npm ci`，等于清空重装一次 `node_modules`。
- **junit 产物不受影响**：`上传 junit-frontend` 带 `if: always()`，闸红时它照旧执行，产物不会丢。
- **既有步骤语义完全不变**：vitest 那一步（含双 fallback 与 `TODO(2026-Q4)` 注释）与上传步骤均未触碰。

### 一个需要知道的行为变化

三个子模块（frontend / backend-python / backend-rust）在 `test` job 里是**串行**的，
所以**任一 frontend 闸失败都会跳过后续两个后端测试步骤**（既有的 frontend 测试失败已经如此，
本次只是把失败点多加了三个）。这是该 job 单体串行结构的固有性质，不是本次引入的；
若将来要让静态闸只对 frontend 生效、不牵连后端，需把三者拆成独立 job —— 那是结构改动，本次不做。

## format:check 在 CI 里能过的前置事实（别改坏）

⚠️ **2026-10-21 更新**：本节原先登记的「`npm ci` 触发 postinstall 把 `public/occt-wasm.js`
与 `public/occt-wasm.wasm` 复制进 `public/`」这条链路**已整条下线**（wasm 改由
`src/three/OcctStepLoader.ts` 的 `?url` import 走资源图，见
[`occt-wasm-asset-pipeline.md`](occt-wasm-asset-pipeline.md)）—— `npm ci` 现在不再往仓库里
放任何生成物。下面那段保留作**判据的由来**（过去确实存在过这样两条被忽略的生成物），
描述的是当时的状态，不是当前存在的生成物。

<details>
<summary>历史判据：当时 <code>public/occt-wasm.js</code> / <code>.wasm</code> 为何不会被 prettier 校验</summary>

`npm ci` **曾经**会触发 `postinstall`（`scripts/copy-occt-wasm.mjs`），把 **125KB 的压缩产物
`public/occt-wasm.js` 与 22MB 的 `public/occt-wasm.wasm`** 复制进 `public/`。
两者当时都在 `.gitignore` 里，而 **Prettier 3.x 默认遵守 `.gitignore`**，故不会进校验：

```
$ npx prettier --file-info public/occt-wasm.js
{ "ignored": true, "inferredParser": null }
```

</details>

`src/auto-imports.d.ts` / `src/components.d.ts` 是当前**仍然成立**的同类（`.gitignore` 里，
`.prettierignore` 也列了）。

⚠️ **若将来新增「未进 `.gitignore` 的生成物」（尤其是压缩过的 `.js`）到仓库里，`format:check` 会立刻红** ——
那不是代码写错了，是生成物混进了校验范围。处置是把该路径补进 `.gitignore`（首选，prettier 会自动跳过）
或 `.prettierignore`（其次）。**不要**为了让它变绿去格式化生成物。

`.prettierignore` 现有条目（`CLAUDE.md` 排除等）本次**未改动**：CLAUDE.md 的三张宽表不做列对齐，
`README.md` 仍要过 prettier 校验。

## 本仓已完成的收口

| 命令                                                | 结果                                           |
| --------------------------------------------------- | ---------------------------------------------- |
| `npm run format`                                    | 155 个文件格式化（125 `.ts` + 30 `.vue`）      |
| `npm run format:check`                              | 退出码 0                                       |
| `npm run lint`（`--max-warnings=0`）                | 退出码 0                                       |
| `npm run typecheck`（`vue-tsc --noEmit`）           | 退出码 0                                       |
| `npm run test`                                      | 292 文件 / 3635 用例全绿（与格式化前逐项一致） |
| `npm run build`（`vue-tsc --noEmit && vite build`） | 构建成功                                       |

### 格式化是否动了语义：已验证，不是「应该没有」

仓内有 **51 个 spec 用 `readFileSync` 读 `.vue` / `.ts` 源文件文本**做源码契约断言
（任务书点了其中 10 个，实际有 51 个）。验证结论：

- 这 51 个 spec 全部单跑通过（630 个用例）；`ScanReturnChainFlow.spec.ts` 这类
  「拦页面 inline `borderLeftColor`」的源码契约用例也未受影响。
- 另用 TypeScript 编译器把改动前后的 155 个文件**各自重新规范化打印并逐字比对**：
  **忽略 `ParenthesizedExpression` 后 0 处 AST 差异**（prettier 会删冗余括号，
  `return (A && B)` → `return A && B`，TS 把它建成真实节点故会误报，语义等价）。
- `.vue` 的 `<template>` 块里出现的那几处差异全是 prettier **有意**的空白敏感处理
  （把 `>` 挪到独立行、把 `</tag` 单独起行），渲染结果逐字不变；`<style>` 块仅压缩空白后一致。

⇒ **没有任何 spec 需要为了迁就格式化而改断言，也没有扩大 `.prettierignore`。**
