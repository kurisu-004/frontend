# 依赖风险登记

> **目标读者**：Agent / 部署运维 / 后端联调
> **核心价值**：当前依赖中已知且明确承担的风险的决策记录与迁移路径。
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

本文档登记 npm 依赖中「明知有风险但当前决策保留」的项目，每条都附事实 / 决策 / 缓解 / 迁移路径。修改前请评估风险是否仍然成立。

## 1. xlsx@0.18.5 高危漏洞

### 事实

- `npm audit` 标记为 high。
- 漏洞类型：原型污染 + ReDoS（正则拒绝服务）。
- npm 官方仓库**无修复版本**。
- SheetJS 新版（修复版）只通过自家 CDN 分发：`https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js`，未发布到 npm。

### 决策（2026-08-21）

**保留当前版本，承担风险。**

理由：业务影响范围可控（详见攻击面评估），而迁移到 SheetJS CDN 版会引入外网依赖稳定性风险，迁移到 `exceljs` 要重写 4 个 parser 工作量显著。

### 攻击面评估

- 仅 4 个 parser 工具函数使用：`bidExcelParser.ts` / `purchaseOrderExcelParser.ts` / `historicalPriceExcelParser.ts` / 共享 `xlsxParseUtils.ts`。
- 3 个视图统一收口：`PartBidImport.vue` 等导入入口。
- 不执行公式 / 宏（仅读取 cell 值）。
- 不解析加密文件（Excel 加密工作簿会直接报错拒绝）。
- 文件来源受信任——用户主动上传内部业务文件，非公开互联网下载。

### 缓解措施

| 措施 | 实施位置 |
|---|---|
| 文件大小限制 | nginx `client_max_body_size 300m` |
| MIME 白名单 | 前端 el-upload `accept=".xlsx,.xls"` |
| 解析器异常捕获 | parser 入口统一 fail-fast，错误向上抛 |
| 禁用宏 / 公式 | parser 仅 `XLSX.read` + `sheet_to_json`，不 eval |

### 迁移路径（未来）

**方案 A：SheetJS CDN 版**

```html
<script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>
```

- 优点：官方修复版，零代码改动。
- 风险：依赖外网 CDN 可用性；CDN 故障会直接瘫痪 Excel 导入。

**方案 B：`exceljs`**

- 优点：纯 npm 依赖，社区活跃。
- 缺点：API 与 `xlsx` 不同，4 个 parser 要重写；单测 + 真实样本 fixture 要全量回归。

**决策待评估**。触发重新评估的条件：

1. SheetJS 上传修复版到 npm。
2. 出现针对内部 Excel 文件的供应链攻击事件。
3. 业务方要求支持加密工作簿（会显著放大攻击面）。

## 2. pdfjs 缓存穿透历史

### 教训

2026-07-17 前生产 nginx 未配 `.mjs` 的 `application/javascript` MIME，pdf worker 以 `application/octet-stream` + `Cache-Control: max-age=31536000, immutable` 下发，导致：

- 浏览器按年缓存 worker。
- worker 文件名是 Vite 内容 hash，nginx 修复 MIME 后文件名不变。
- 缓存中毒被整年复用，控制台报 `Failed to load module script ... octet-stream`，pdfjs 退化到主线程 fake worker。
- 用户反馈：CJK 字符显示异常，刷新不生效。

### 当前机制

- `src/utils/pdfjs.ts` 的 `PDF_WORKER_CACHE_BUST = 'v=20260719'` 版本串，强制浏览器绕过 immutable 缓存重新请求。
- `nginx.conf` `.mjs` location 块显式声明 `application/javascript`。
- 缓存策略：1h expires，不强制 immutable。

详细配置见 [02-architecture/pdf-integration.md](../02-architecture/pdf-integration.md) 与 `src/utils/pdfjs.ts` 注释。

### 何时递增版本串

| 触发条件 | 动作 |
|---|---|
| worker 行为变更（pdfjs 升级） | 同步递增 |
| 缓存中毒再次发生 | 立即递增 |
| nginx MIME 修复后再上线 | 同步递增（确保历史中毒缓存被覆盖） |

递增方式：直接修改 `PDF_WORKER_CACHE_BUST` 常量值，建议日期格式（`v=YYYYMMDD`）。

## 3. vite / rolldown 上游噪音

### 问题

`@vueuse/core` 在 vite 8 的 rolldown 引擎下产生 `INVALID_ANNOTATION` 警告：

- 原因：`@vueuse/core` 的 dist 里含有 rolldown 不识别的 `/* #__PURE__ */` 注解位置。
- 性质：rollup → rolldown 迁移期的已知问题，注释被忽略不影响产出正确性。
- 影响：噪音淹没真正的新警告。

### 当前处理

`vite.config.ts` 的 `build.rollup.onwarn` 过滤该警告：

```ts
onwarn(warning, defaultHandler) {
  if (
    warning.code === 'INVALID_ANNOTATION' &&
    typeof warning.id === 'string' &&
    warning.id.includes('@vueuse/core')
  ) {
    return
  }
  defaultHandler(warning)
}
```

注释已标明「待上游修复后可移除」。

### 移除过滤的时机

- `@vueuse/core` 发布修复版（清理 dist 中错误的 `/* #__PURE__ */` 位置）。
- vite / rolldown 修复上游解析器，兼容该模式。

## 4. 依赖审计建议

| 频率 | 动作 |
|---|---|
| CI（每次 PR） | `npm audit` —— high / critical 立即通知 |
| 每月 | 手动扫一遍新增依赖的 last commit 时间、维护活跃度 |
| 升级前 | 检查目标版本是否仍在维护，CHANGELOG 是否有 breaking change |
| 引入新依赖 | 评估：last commit 是否 < 1y？是否有 npm audit 警告？是否仅维护者个人使用？ |

避免引入：last commit > 2y 无更新的依赖、仅个人维护且无 bus factor 的依赖、未发布到 npm 只能从 CDN 加载的依赖（除非与 SheetJS 类似有充分理由）。