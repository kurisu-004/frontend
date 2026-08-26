# Excel 导入与解析

> **目标读者**：新人 / Agent（写新 parser / 改 Excel 导入流程）
> **核心价值**：3 个 Excel parser 的全景图、共享工具、测试约定、新增 parser 的 checklist。
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

前端目前有 3 个 Excel parser，全部位于 `src/utils/`，纯函数实现：依赖 `xlsx`（必要时 `dayjs`），不触网、不碰 DOM，可直接 vitest 跑。

## 1. Parser 总览

| parser | 输入 | 输出 | 调用入口 |
|---|---|---|---|
| `bidExcelParser.ts` | 法拉电子应标 Excel `招标项目-标的` sheet | `BidRow[]` + 错误/警告 | `src/views/parts/PartBidImport.vue` |
| `purchaseOrderExcelParser.ts` | 采购订单 Excel（`基本资料` + `采购订单明细` sheet） | `ParsedPurchaseOrder` | 内部调用 |
| `historicalPriceExcelParser.ts` | 历史价确认单 Excel `历史价确认单明细` sheet | `BidRow[]`（复用 BidRow 契约） | 外协对账流程 |

要点：

- `historicalPriceExcelParser.ts` 不另起炉灶，直接复用 `bidExcelParser.ts` 导出的 `BidRow` / `ParseError` / `ParseResult` 类型——下游 `applyExcelToAll` 等消费方代码无需按文件类型分叉。
- 历史价确认单缺「紧急状态 / 申请人所在一级部门代码 / 方案设计图纸 / 加工类型 / 备注」几列，对应字段全部按 null / false / 空串兜底。
- 采购订单 parser 用 `dayjs` 处理日期，因为其原表是 `YYYY-MM-DD HH:mm:ss` 字符串；其他两个 parser 直接用 `addDays` 走 UTC 算术。

## 2. 共享工具 `xlsxParseUtils.ts`

`src/utils/xlsxParseUtils.ts` 提供 3 个 parser 共用的纯函数——任何新 parser 必须优先复用这些 helper，禁止在 parser 内重复实现等价逻辑。

| helper | 行为 | fallback |
|---|---|---|
| `cleanText(value)` | null / undefined / falsy 安全 trim，非字符串先转字符串 | 空串 |
| `parseIntSafe(value, fallback?)` | 千分位逗号 / 货币符号先剥离再 Number；非整数回退 | null（默认） |
| `parseDecimal(value)` | 兼容千分位 / 货币符号的十进制解析 | 0 |
| `parseDecimalOrNull(value)` | 同上但保留 null 语义（与 `parseDecimal` 的差异） | null |
| `addDays(yyyy_mm_dd, days)` | 基于 `Date.UTC` 做日期加减，规避夏令时踩坑 | — |

这些 helper 原本都是 `bidExcelParser.ts` 的私有函数，2026-07-24 新增历史价 parser 时为复用而抽出。

## 3. 典型调用入口 `PartBidImport.vue`

路径：`src/views/parts/PartBidImport.vue`。

完整流程：

1. 用户上传 Excel（`el-upload`，手动模式 `auto-upload="false"`，前端自己读 ArrayBuffer）。
2. `XLSX.read(arrayBuffer)` 解出 workbook，调对应 parser 得到 `BidRow[]` + `errors` + `warnings`。
3. el-table 预览解析结果，errors 行高亮阻断提交，warnings 标记但允许继续。
4. 用户调整加急 / 单价 / 交期后点确认，前端批量匹配已有 Part，写回订单号 / 系统交期。

`PartBidImport.vue` 自身只负责 UI 编排和提交逻辑，不持有任何 Excel 解析代码——这是 parser 抽出来的根本目的。

## 4. 测试约定

每个 parser 配套两类测试：

| 文件类型 | 用途 | 特点 |
|---|---|---|
| `*.spec.ts` | mock 数据（人造 sample，可控） | 跑在 vitest node 环境，无 IO |
| `*.real.spec.ts` | 真实样本（脱敏后的供应商原文件） | 同样 node 环境，但依赖 fixture 目录 |

真实样本 fixtures 统一放在 `src/utils/__tests__/__fixtures__/`，当前规模：

- `供应商招标项目应标 (9).xlsx` — 1.1M（投标 parser）
- `历史价确认单 (1).xlsx` — 12K（历史价 parser）

新增 parser 时强烈建议遵循同一约定：先写 mock 测试覆盖边界（空表 / 缺列 / 异常字符），再用真实样本兜底。

## 5. xlsx 风险指针

`xlsx@0.18.5` 在 npm audit 中标 high（原型污染 + ReDoS），npm 官方仓库至今无修复版本（SheetJS 新版只通过自家 CDN 分发）。

本仓库对攻击面做过评估：

- 仅在内部 Excel 只读解析中使用，4 个 parser 工具函数 + 3 个视图统一收口。
- 不执行公式 / 宏。
- 不解析加密文件。
- 文件来源受信任（用户主动上传内部业务文件）。

2026-08-21 决策保留当前版本并承担风险。详细评估 + 未来迁移路径见 [08-known-risks/dependency-risks.md](../08-known-risks/dependency-risks.md)。

## 6. 写新 parser 的 checklist

1. 在 `src/utils/` 加 `xxxExcelParser.ts`，导出 `parseXxxExcel(workbook, ...)` 纯函数与对应 TS 类型。
2. 复用 `xlsxParseUtils.ts` 的 `cleanText` / `parseIntSafe` / `parseDecimal*` / `addDays`，不要重写等价逻辑。
3. 加 `xxxExcelParser.spec.ts`（mock 数据），覆盖空表 / 缺列 / 异常字符 / 整行空跳过等分支。
4. 加 `xxxExcelParser.real.spec.ts`（真实样本），fixture 落到 `src/utils/__tests__/__fixtures__/`。
5. 在调用入口 view 中 import 并接好 upload → preview → submit 流程。
6. 在本文档「Parser 总览」表格补一行。

遵循上述顺序能保证 parser 的纯函数性质、可测性、与下游消费方的契约对齐。