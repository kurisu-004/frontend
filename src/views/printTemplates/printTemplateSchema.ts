// src/views/printTemplates/printTemplateSchema.ts
//
// 2026-10-16 新建：送货单打印模板域（后端 `/api/v2/print-templates`，5 个端点）的 Zod 守门
// schema，与本域的 query hook / store 同居（CLAUDE.md「域 schema 与 query hook 同居」）。
//
// 两条 wire 序列化约定（本域三条 wire 类型全部适用）：
//   - **雪花 ID 一律 JSON string**：`id` / `customer_id` 是 `z.string()`，禁 `z.number()`
//     （19 位 ID 在 JS Number 下丢精度）。前端所有「客户 id」都是 string。
//   - **计数 / 版本号一律 JSON number**：`file_size` / `version`。
//
// ⚠️ **`.strict()` 的取舍**（与 mail 域同款）：后端给本域加字段时必须在这里显式决策，
// 而不是被 Zod 默认的 strip 静默吞掉 —— 吞掉之后前端「照样通过校验」，那一列整列失效且
// 无人发现（例如后端加了 `file_type` 而这里没跟上，表格那一列恒空）。
//
// ⚠️ **`customer_name` / `content_sha256` 都是可空**：客户被软删后后端给 `null`，而
// sha256 对「库里没算出来」的存量行也是 `null`。所以表格里这两格都必须有降级展示，
// 不能直接 `.min(1)`（那会让整页在一条脏行上抛）。

import { z } from 'zod';

// ============================================================
// 元素：模板行（列表与上传出参共用）
// ============================================================

/**
 * 一条打印模板（后端 `PrintTemplateOut`，**10 个字段逐字对齐**）。
 *
 * ⚠️ **`content` 键刻意不存在**：本域只存字节、从不返回字节，模板内容由
 * `GET /print-templates/{id}/content` 单独取（裸响应体、不是信封）。
 */
export const printTemplateSchema = z
  .object({
    /** 模板行 id（雪花 ID ⇒ JSON string）。**不要**用 `z.number()`。 */
    id: z.string(),
    /** 绑定的**一级客户** id（雪花 ⇒ JSON string）。 */
    customer_id: z.string(),
    /** 一级客户名；客户已被软删时后端给 `null`（故不能 `.min(1)`）。 */
    customer_name: z.string().nullable(),
    /** 用户上传时的原始文件名（下载时的建议文件名）。 */
    original_filename: z.string(),
    /** 字节数（后端 `file_size` 是裸 i64 number，不是 `serialize_i64` 字符串）。 */
    file_size: z.number(),
    /** 后端按扩展名归一后的 MIME（当前只有 xlsx 一种取值，出参侧**不守枚举**）。 */
    file_type: z.string(),
    /** 内容 SHA-256 十六进制串；「库里没算出来」的存量行为 `null`（故不能 `.min(1)`）。 */
    content_sha256: z.string().nullable(),
    /** OCC 锚。软删端点 `POST /{id}/delete` 的 body **必填**（缺省是 axum 的 HTTP 422 纯文本）。 */
    version: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type PrintTemplateData = z.infer<typeof printTemplateSchema>;

// ============================================================
// GET /api/v2/print-templates（分页信封）
// ============================================================

/**
 * 列表出参（后端 `PrintTemplateListOut`）：`{items, total, limit, offset}`。
 *
 * ⚠️ **是信封对象、不是裸数组**：把它写成 `z.array(...)` 时 queryFn 会在每一屏抛
 * ZodError ⇒ 表格恒空、且页面上没有任何报错线索。
 *
 * `total` / `limit` / `offset` 在这里声明为 `number`：api 层已经用 `normalizeListResult`
 * 把三者归一（见 `api/printTemplates.ts::listPrintTemplates` 的注释 —— 后端各域 list 端点
 * 的分页字段类型不统一，这个域将来若改成 `serialize_i64`，前端不用改一行）。
 */
export const printTemplateListResultSchema = z
  .object({
    items: z.array(printTemplateSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .strict();

export type PrintTemplateListResultData = z.infer<typeof printTemplateListResultSchema>;

// ============================================================
// GET /api/v2/print-templates/resolve（打印时自动选用）
// ============================================================

/**
 * `GET /print-templates/resolve?customer_id=<L1>` 的出参（后端 `PrintTemplateResolveOut`）。
 *
 * ⚠️ **与 `PrintTemplateOut` 不是同一个 VO**：这一条不带 `version` 之外的 OCC 语义、不带
 * `file_type` / `created_at`，只回答「这个一级客户当前该用哪份模板」。
 *
 * ⚠️ **`content_url` 是相对路径**（形如 `/print-templates/<id>/content`，**不含** `/api/v2`
 * 前缀、也**不带** Authorization 头）⇒ 它只能当展示信息，**不能**直接塞进 `<a href>` /
 * `<img src>`：`api` 实例的 `baseURL` 是 `/api/v2`，且 token 由请求拦截器注入。前端取字节
 * 一律走 `api/printTemplates.ts::fetchPrintTemplateContent(id)`（走 axios），不拼这条 URL。
 */
export const printTemplateResolveSchema = z
  .object({
    id: z.string(),
    customer_id: z.string(),
    customer_name: z.string().nullable(),
    original_filename: z.string(),
    file_size: z.number(),
    content_sha256: z.string().nullable(),
    version: z.number(),
    updated_at: z.string(),
    /** 相对路径，**仅供展示**（理由见本 schema 的 doc）。 */
    content_url: z.string(),
  })
  .strict();

export type PrintTemplateResolveData = z.infer<typeof printTemplateResolveSchema>;

// ============================================================
// 展示常量
// ============================================================

/**
 * 本域唯一允许的扩展名。后端 `POST /print-templates/` 对非 xlsx 返 21102；前端在
 * **发请求之前**就用它拦一道 —— 坏模板不该占一次往返，更不该先落库再报错。
 *
 * ⚠️ **本域没有自己的一份 MIME 常量**：模板文件就是送货单打印模板，MIME 的唯一来源是
 * `views/com/delivery/utils/deliveryNoteTemplateContract.ts::XLSX_MIME`（api 层与本页都从
 * 那里取）。在这里再抄一份字面量就是第二真源 —— 后端哪天改判据时它不会报错，只会静默让
 * 上传被 21102 挡回。
 */
export const PRINT_TEMPLATE_ACCEPT_EXT = '.xlsx';

/** `el-upload` 的 `accept` 属性值。 */
export const PRINT_TEMPLATE_ACCEPT = PRINT_TEMPLATE_ACCEPT_EXT;
