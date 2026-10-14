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
// ⚠️ **`.strict()` 的取舍按「读侧 vs 写侧」分**（CLAUDE.md「读侧 vs 写侧 schema 的 strict
// 口径相反」；2026-10-16 review 第 1 轮 NIT-9 订正本文件原先那段把三个 schema 一概按写侧
// 理由解释的注释 —— 那条理由对 `printTemplateSchema` / `printTemplateListResultSchema`
// 成立，对 `printTemplateResolveSchema` **只对一半**成立）：
//   - **写侧口径（`.strict()`）**：`printTemplateSchema`（行 VO）/ `printTemplateListResultSchema`
//     —— 后端给这两个出参加字段时必须在这里显式决策，而不是被 Zod 默认的 strip 静默吞掉：
//     吞掉之后前端「照样通过校验」，那一列整列失效且无人发现（例如后端加了 `file_type` 而这里
//     没跟上，表格那一列恒空）。
//   - **读侧口径（外层**不** `.strict()`）**：`printTemplateResolveSchema` 的**顶层对象**。
//     它的失败模式与上面相反：`.strict()` 一旦抛，`PrintPreviewDialog.vue::resolveBoundTemplate`
//     落进 else 分支 → 一句「自动选用该客户模板失败，请到「模板编辑」页重新上传」
//     ⇒ **全站客户的自动选用集体静默失效**，而失败原因既不弹 toast 也不进错误日志。读侧多一个
//     字段是纯增量信息，strip 掉它零代价。
//   - ⚠️ **嵌套在 resolve 里的那层 `template` 仍是 `.strict()`**（2026-10-16 review 第 2 轮 C-1
//     把 resolve 出参订正成「嵌套」之后新增的第三层判断）：它与列表行是**同一个 VO**（后端
//     `PrintTemplateResolveOut.template` 的类型字面就是 `PrintTemplateOut`），所以两份 schema
//     必须一起长、一起红 —— 后端给 `PrintTemplateOut` 加字段时，列表页与打印对话框**都**该
//     立刻炸出可见错误，而不是一个响一个不响。**外层宽松、内层严格这个不对称是刻意的**：
//     外层是「这一条端点独有的信封」，内层是「与列表共用的行契约」。
//
// ⚠️ **`customer_name` / `content_sha256` 都是可空**：客户被软删后后端给 `null`，而
// sha256 对「库里没算出来」的存量行也是 `null`。所以表格里这两格都必须有降级展示，
// 不能直接 `.min(1)`（那会让整页在一条脏行上抛）。

import { z } from 'zod';

// ============================================================
// 元素：模板行（列表与上传出参共用）
// ============================================================

/**
 * 一条打印模板（后端 `PrintTemplateOut`，**12 个字段逐字对齐**）。
 *
 * ⚠️ **`content` 键刻意不存在**：本域只存字节、从不返回字节，模板内容由
 * `GET /print-templates/{id}/content` 单独取（裸响应体、不是信封）。
 *
 * ⚠️ **`kind` / `file_type` / `content_type` 三个恒定值字段是后端真给的，不是幻觉**
 * （2026-10-16 review 第 2 轮 C-1：`.strict()` 之下漏声明它们 ⇒ **上传 / 列表 100% 不可用**，
 * 而它们的值虽恒定、类型仍是必填 `string`）：
 *   - `kind` 恒 `"DELIVERY_TEMPLATE"`（后端 `dto::TEMPLATE_KIND`，服务端钉死）；
 *   - `file_type` 恒 `"XLSX"` —— ⚠️ **短码、不是 MIME**（后端 `policy::file_type_for_ext`
 *     的返回值表是 `PDF` / `STEP` / `XLSX` … 这种大写短码）；
 *   - `content_type` 恒 xlsx 的规范 MIME（`XLSX_MIME` 那个长串）。**`file_type` 与
 *     `content_type` 是两个不同语义的字段**，值形态不同不是笔误。
 *
 * ⚠️ **`customer_name` 是后端本轮新补的字段**（`t_customer` 只读查询 + 内存 join）：客户被
 * 软删 / 查不到时给 `null`，不是必填、也不是空串。
 */
export const printTemplateSchema = z
  .object({
    /** 模板行 id（雪花 ID ⇒ JSON string）。**不要**用 `z.number()`。 */
    id: z.string(),
    /** 绑定的**一级客户** id（雪花 ⇒ JSON string）。 */
    customer_id: z.string(),
    /** 恒 `"DELIVERY_TEMPLATE"`（后端 `dto::TEMPLATE_KIND`，服务端钉死、请求无法改）。 */
    kind: z.string(),
    /** 恒 `"XLSX"` —— **短码不是 MIME**（后端 `policy::file_type_for_ext` 的返回值形态）。 */
    file_type: z.string(),
    /** 用户上传时的原始文件名（下载时的建议文件名）。 */
    original_filename: z.string(),
    /** 字节数（后端 `file_size` 是裸 i64 number，不是 `serialize_i64` 字符串）。 */
    file_size: z.number(),
    /** 恒为 xlsx 的规范 MIME（上传闸门只收精确值，故出参也只有一个可能值）。 */
    content_type: z.string(),
    /** 内容 SHA-256 十六进制串；「库里没算出来」的存量行为 `null`（故不能 `.min(1)`）。 */
    content_sha256: z.string().nullable(),
    /** OCC 锚。软删端点 `POST /{id}/delete` 的 body **必填**（缺省是 axum 的 HTTP 422 纯文本）。 */
    version: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
    /** 一级客户名；客户已被软删 / 查不到时后端给 `null`（故不能 `.min(1)`）。 */
    customer_name: z.string().nullable(),
  })
  .strict();

export type PrintTemplateData = z.infer<typeof printTemplateSchema>;

// ============================================================
// GET /api/v2/print-templates（分页信封）
// ============================================================

/**
 * 列表出参（后端 `PrintTemplateListOut`）：**只有 `{items, total}` 两个字段**。
 *
 * ⚠️ **是信封对象、不是裸数组**：把它写成 `z.array(...)` 时 queryFn 会在每一屏抛
 * ZodError ⇒ 表格恒空、且页面上没有任何报错线索。
 *
 * ⚠️ **`limit` / `offset` 刻意不在这里**（2026-10-16 review 第 2 轮 C-1 连带查出的第 5 处
 * 不符，前两轮都没抓到）：本域原先照抄其它域的分页信封形状写成
 * `{items, total, limit, offset}` 且 `.strict()`，而后端 `vo.rs` 的 `PrintTemplateListOut`
 * **只渲染 `items` 与 `total`** —— `limit` / `offset` 只作为**入参**（`ListQuery`）被收下，
 * 从不回显。于是 `api/printTemplates.ts::listPrintTemplates` 那层 `normalizeListResult`
 * 把两个 `undefined` 归一成 **`NaN`**，而 zod 4 的 `z.number()` **拒 NaN** ⇒ queryFn 的
 * `parse` 每屏必抛 ⇒ **列表恒空 + 每次弹「加载失败」**，与行 VO 的错叠加在一起。
 * 消费侧（store / 页面）本来也只用 `items` 与 `total`，`limit` / `offset` 零引用。
 *
 * `total` 声明为 `number`：api 层对它做过一次 `Number()` 归一（后端 `total` 是裸 `i64`，
 * 归一当前是恒等，留着是防御层，理由同其它域 list 端点）。
 */
export const printTemplateListResultSchema = z
  .object({
    items: z.array(printTemplateSchema),
    total: z.number(),
  })
  .strict();

export type PrintTemplateListResultData = z.infer<typeof printTemplateListResultSchema>;

// ============================================================
// GET /api/v2/print-templates/resolve（打印时自动选用）
// ============================================================

/**
 * `GET /print-templates/resolve?customer_id=<L1>` 的出参（后端 `PrintTemplateResolveOut`）。
 *
 * ⚠️ **是「一个信封套一行」，不是平铺**（2026-10-16 review 第 2 轮 C-1，本域唯一的阻断项）：
 * 后端 `vo.rs` 里 `PrintTemplateResolveOut { template: PrintTemplateOut, customer_name }`。
 * 前端原先把它写成平铺的 `id` / `customer_id` / … / `content_url`，`parse` 每一屏都抛
 * ⇒ **对每个已绑模板的客户，自动选用 100% 失效，而打印页没有上传入口可退回** —— 用户只能自己
 * 去「模板编辑」页把这份模板重传一遍（换句话说：故障现场表现为「这台机器打不出送货单」）。
 * ⇒ 消费方取字段一律走 `hit.template.id` / `hit.template.original_filename`。
 *
 * ⚠️ **`content_url` 这个字段后端从头到尾没有**（`vo.rs` 里查无此名）：前端原先那条
 * 「相对路径仅供展示、不能塞 `<a href>`」的长注释描述的是一个不存在的字段，已随本轮删除。
 * 取字节只有一条路：`api/printTemplates.ts::fetchPrintTemplateContent(template.id)`
 * （走 axios 实例，`baseURL=/api/v2` 且请求拦截器注入 Authorization）。
 *
 * ⚠️ **`customer_name` 在顶层而不是 `template` 里**（后端两条不同的来源：行本身来自
 * `t_part_file`，客户名来自本域自己的一条 `t_customer` 只读查询）。同名字段在两层各有一份
 * 且取值相同，是因为 resolve 端点的调用方（打印对话框）只关心「这个客户叫什么」，而列表页
 * 的行 VO 需要在每行上自带客户名（列表走的是另一条 SQL，没有那个内存 join）。
 *
 * ⚠️ **顶层刻意不 `.strict()`**（2026-10-16 review 第 1 轮 MINOR-6，理由见文件头「读侧 vs
 * 写侧」一节）：本 schema 顶层是**纯读侧**出参，`.strict()` 抛出来的失败模式是「静默降级」——
 * 后端加一个字段就抛 ZodError → `PrintPreviewDialog.vue::resolveBoundTemplate` 落进 else
 * 分支 → **全站客户的自动选型集体失效**，只剩一行 12px 黄色小字、零 toast、零错误日志。
 * 那是本域最难被发现的一类故障：现象是「管理员配了模板也要每次手动选」，而没人会去翻那句提示。
 * 配套的可观测性补强（同轮）见 `PrintPreviewDialog.vue` 里 else 分支的 `console.warn`。
 * ⚠️ **嵌套的 `template` 那层是 `.strict()` 的**（与列表行同一个 VO）—— 见文件头第三条。
 */
export const printTemplateResolveSchema = z.object({
  /** 模板本体：与列表行是**同一个** `PrintTemplateOut`（`.strict()`）。 */
  template: printTemplateSchema,
  /** 一级客户名；查不到（不存在 / 已软删）时为 `null`。 */
  customer_name: z.string().nullable(),
  // ⚠️ 顶层不 `.strict()`：多出来的键被 strip（默认行为）而不是抛 —— 见上面那段 doc。
});

export type PrintTemplateResolveData = z.infer<typeof printTemplateResolveSchema>;

// ============================================================
// 展示常量
// ============================================================

/**
 * 本域唯一允许的扩展名。后端 `POST /print-templates`（后端源码注册在 `.route("/")`、被 nest
 * 折叠成 prefix 本身，**不带尾斜杠**）对非 xlsx / 非 ZIP 返 21102；前端在
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
