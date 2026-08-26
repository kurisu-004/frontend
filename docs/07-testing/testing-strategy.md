# 测试策略

> **目标读者**：Agent / 新人前端
> **核心价值**：明确测什么/不测什么，列出全部 spec 索引，约束维护成本
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、项目反共识：不做组件测试

本仓库**不引入** `@vue/test-utils` / `@testing-library/vue` / 任何组件渲染测试框架。

理由（一次写明，不再讨论）：

- **业务价值低**：组件本质是 Element Plus 组合 + 表单/表格状态，把 EP 组件再测一遍无收益。
- **维护成本高**：组件频繁重构（最近 17 项 refactor），单测跟进永远滞后于代码；改一行 template 就红一片。
- **测试环境与运行时不一致**：vitest 跑在 node 环境，没 DOM、不挂 EP（EP 2.7 强依赖 DOM），真要测就得配 jsdom + EP mock + 路由 stub，得不偿失。
- **手动验证更准**：复杂交互（弹窗、表格分页、上传）开发期在浏览器手测 30 秒，比写 200 行测试代码再调试值。

**结论**：测试资源集中在**纯函数 + 模块级单例 composable**，组件靠手测 + 浏览器 DevTools 兜底。

## 二、测试范围

明确列出，覆盖以下四类：

1. **纯格式化函数**：`src/utils/date.ts`、`src/utils/format.ts` 等（日期、字符串、金额）。
2. **解析 / 生成函数**：Excel 解析（`bidExcelParser` / `historicalPriceExcelParser`）、JWT 解码、PDF 合并（`mergePdfs`）。
3. **API 层纯函数**：`src/api/http.ts` 的 `serializeParams` / `cleanParams` —— axios 实例与拦截器依赖太重，仅测纯逻辑切片。
4. **模块级单例 composable**：见 `src/composables/*.spec.ts`（`useBulkPassInspection` / `useBulkScanInspect` / `useDeliveryNoteDetailCache` / `usePooledDetail` 等），因为它们是**模块级 ref 单例**，状态在测试间会残留，测试必须显式 reset。

**不测**：

- 组件渲染 / props / events / slots
- 路由导航 / 权限守卫（前端守卫逻辑 10 行内可直接读）
- Pinia store（本项目实际不用，状态都在 composable 模块级 ref）
- E2E（无 Playwright/Cypress，按需再评估）

## 三、测试运行器

**vitest**（node 环境，`vitest.config.ts`）：

```ts
test: {
  include: ['src/**/*.spec.ts'],
  environment: 'node',
}
```

`@` 别名在 vitest 侧也配了（指向 `./src`）。

### 命令

```bash
npm run test                       # 全部单测（CI 入口）
npx vitest run <file>.spec.ts      # 单文件
npx vitest run -t "测试名"         # 按名称跑单个用例
npx vitest --watch                 # watch 模式（开发期）
```

## 四、测试文件索引

| 文件 | 覆盖目标 |
|---|---|
| `src/api/http.spec.ts` | `serializeParams` / `cleanParams` 纯函数（query 序列化、白名单 CSV） |
| `src/api/dashboard.spec.ts` | 大屏 snapshot 序列化与 event handler 映射 |
| `src/utils/__tests__/date.spec.ts` | 日期格式化（年月日 / 时分秒 / ISO） |
| `src/utils/__tests__/mergePdfs.spec.ts` | pdf-lib 多 PDF 合并（pdf-lib 是 node 库，干净） |
| `src/utils/__tests__/bidExcelParser.spec.ts` | 投标 Excel 解析（mock 数据，含 80+ 用例） |
| `src/utils/__tests__/bidExcelParser.real.spec.ts` | 投标 Excel 解析（真实 fixture） |
| `src/utils/__tests__/historicalPriceExcelParser.spec.ts` | 历史价 Excel 解析（mock） |
| `src/utils/__tests__/historicalPriceExcelParser.real.spec.ts` | 历史价 Excel 解析（真实 fixture） |
| `src/composables/useBulkPassInspection.spec.ts` | 批量通过品检 composable（init / 状态 / cleanup） |
| `src/composables/useBulkScanInspect.spec.ts` | 批量扫码送检 composable |
| `src/composables/useDeliveryNoteDetailCache.spec.ts` | 送货单详情 N+1 缓存 |
| `src/composables/usePooledDetail.spec.ts` | 通用并发限流 composable |

## 五、命名约定

- `*.spec.ts`：**mock 数据**，人造样本（构造可控、可断言具体值）。
- `*.real.spec.ts`：**真实样本**，依赖 `__fixtures__/` 下的真实文件（脱敏过的 Excel 等）。真实样本覆盖率低但能抓到 mock 漏掉的格式细节。
- **fixtures 目录**：`src/utils/__tests__/__fixtures__/`（gitignore 不忽略，真实样本需要随仓库走；体积上限单文件 5MB，超过则裁剪到代表性行）。
- **测试目录结构**：`src/<domain>/__tests__/X.spec.ts`（util 域）或 `src/<domain>/X.spec.ts`（紧邻源码，api/composables 域用这种）。

## 六、写测试的 checklist

按业务函数类型给具体建议：

**纯格式化函数**（日期、字符串、金额）

- 正常值（含中文、含特殊字符）
- 边界值：空字符串 / `null` / `undefined` / 超长字符串 / 负数
- 时区：明确 UTC 还是本地，不混

**解析函数**（Excel / JWT / 二进制）

- 正常样本（来自 fixture）
- 异常样本：缺字段 / 字段类型错 / 多余列
- 空文件 / 仅表头 / 仅数据无表头

**模块级单例 composable**

- init：默认值是否符合预期
- 状态变化：调用方法后 `ref` 是否同步
- cleanup：测试间必须 reset（`vi.resetModules()` 或显式调用 dispose 方法），否则状态泄漏到下一个用例
- 并发：promise 链是否正确串联（防雪崩 / 防 race）

**API wrapper 纯函数切片**

- mock axios 响应（无需真起 mock server）
- 信封解构：`code === 0` 透传 `data`，非 0 抛 `ApiError(code, message)`
- 边界：`code === 40102` 是否触发 refresh（用 spy 断言）

## 七、CI 接入建议

```
PR 流水线（建议）
├── npm run typecheck     # vue-tsc --noEmit，类型契约
├── npm run test          # vitest run，全部单测
└── (可选) npm run build  # 完整构建（仅合 main 前跑）
```

**Docker 镜像层不跑测试**：`Dockerfile` 只跑 `npx vite build`（见仓库 CLAUDE.md），体积与构建速度优先；类型检查 + 单测靠 CI/本地 `npm run typecheck` + `npm run test`。

**PR 模板建议**勾选框：

- [ ] 是否新增/修改 `*.spec.ts`？（强制 review 关注测试覆盖）
- [ ] 是否新增 fixture 文件？（确认体积 ≤ 5MB、已脱敏）

## 八、不要做的事

- **不要**引入 `@vue/test-utils` / `@testing-library/vue` / `@vue/test-utils`。本项目立场：组件测试 ROI 为负。
- **不要**为简单 getter / 单行映射函数写测试（噪声大于信号）。
- **不要**依赖网络：mock 所有 axios / `new WebSocket()` / `EventSource`。CI 在受限网络环境跑。
- **不要**依赖系统时间：用 `vi.useFakeTimers()` / `vi.setSystemTime()`。
- **不要**在 composable 测试里复用模块状态而不 reset；模块级单例是**最容易踩的坑**。
- **不要**追求 100% 行覆盖率：本项目无覆盖率门禁，以**关键路径 + 易回归处**为重。