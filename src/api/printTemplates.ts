// 后端 print-templates 域（送货单打印模板）API。走 `@/api/http` 统一 axios 客户端。
//
// 2026-10-16 新建。端点表（URL / method / body 冻结，与本文件逐字对齐）：
//   （2026-10-15 删除：POST /print-templates 上传端点 —— 改走直传链路 upload-intents +
//    files/objects/confirm，owner_kind='CUSTOMER'、kind='DELIVERY_TEMPLATE'）
//   GET  /print-templates?customer_id=&limit=&offset= → 列表（**出参只有 `{items, total}`**）
//   GET  /print-templates/resolve?customer_id=      → 打印时按一级客户自动选用（出参**嵌套**）
//   GET  /print-templates/{id}/content              → 取 xlsx 字节（**裸响应体，不是信封**）
//   POST /print-templates/{id}/delete              → 软删（OCC，body 必带 version）
//
// ⚠️ **上面这张表钉的是 URL / method / body，不是出参形状**（2026-10-16 review 第 2 轮 C-1
// 的根因复盘）：第 1 轮加的那份 contract spec 断言的 `ROW` / `RESOLVE_ROW` fixture 是**前端
// 自己手写的**，等于在验「前端代码符不符合前端自己的想象」—— 于是出参形状错了整整两轮没人
// 拦（上传 / 列表 100% 不可用、自动选用 100% 失效）。真正的后端形状（`vo.rs`）是：
//   - 行 VO `PrintTemplateOut`：**12 字段**，含 `kind`（恒 `DELIVERY_TEMPLATE`）/ `file_type`
//     （恒 `XLSX` 短码）/ `content_type`（恒 xlsx MIME）/ `customer_name`（后端本轮新补）；
//   - resolve 出参 `PrintTemplateResolveOut`：**嵌套** `{ template, customer_name }`，
//     **没有 `content_url`**；
//   - 列表出参 `PrintTemplateListOut`：**只有 `{items, total}`**，`limit` / `offset` 只作入参。
// 出参形状的逐字对账由 `views/printTemplates/printTemplateSchema.ts` 承担，本文件只发请求。
//
// ⚠️ **URL 一律不带尾斜杠**（`/print-templates` 而不是 `/print-templates/`）：后端把各域
// router nest 到 `/print-templates` 之下、域内首条路由注册在 `/`，nest 会把它折叠成 prefix
// 本身 —— 带尾斜杠会 404。上面那张端点表里 `POST /print-templates` 的准确读法是「后端源码
// 里注册的是 `.route("/", get(list).post(upload))`，被 nest 折叠后就是 prefix 本身」。
// 本仓同款形态的既有实证见 `api/files/objects.ts` 里各端点的 URL 写法
// （「URL 无尾斜杠：后端 nest 把内层的 `/` 折叠成 prefix 本身，带尾斜杠会 404」）。
//
// ⚠️ **后端不渲染 xlsx**：送货单 xlsx 的生成自 2026-10-08 起完全在前端本地完成（hucre），
// 后端只负责「存模板字节 + 绑一级客户 + 取字节」。本文件因此**没有**任何「渲染 / 转 PDF /
// 生成签名直链」的端点，将来有人要加「让后端出成品」的端点时也不该往这个域里塞。
//
// ⚠️ **同一 L1 二次上传是「替换」而不是新增多条**（后端按 L1 一对一覆盖），前端无需处理：
// 列表里那一个 L1 永远只有一行，重复上传不会堆行。
//
// 权限：列表 / 上传 / 软删三端 **MANAGER 独占**（后端 handler 层 require_role）；
// `resolve` 与 `content` 两端走权限点 `delivery_note.print`（与打印入口同一个码）。
//
// 守门点分工（CLAUDE.md「Zod schema-first」）：
//   - `listPrintTemplates` 只发请求 + 类型标注，**不 parse** —— 守门在 queryFn
//     （`views/printTemplates/composables/usePrintTemplateListQuery.ts`），parse 返回深拷贝，
//     多一层等于每屏数据被校验并克隆两遍；
//   - `resolvePrintTemplate` 走组件单次拉取、**没有 queryFn 承载**，守门留在本层
//     （同 `api/com/deliveryNote.ts::getDeliveryScanTree`）；
//     ⚠️ 2026-10-15：原 `uploadPrintTemplate` 的守门点随 multipart 端点一起下线 ——
//     上传改走直传链路（`utils/directUpload.ts`），登记返回的是通用 `PartFileItem`，
//     打印模板的读侧（列表 / 解析）仍读本域 schema，两者不再共用一个出参。
//   - `deletePrintTemplate` **不 parse**：后端返 `R<()>`，信封 `data` 是 `null`，没有形状可守
//     （`parse(null)` 必抛，而那正是「删除永远失败」的成因）。
//
// 出参类型一律 `import type` 取 schema 的 `z.infer` 派生类型（编译期擦除，不留
// api → views 的**类型**依赖边）；只有 parse 需要运行时引入 schema 模块。

import { api, cleanParams } from '@/api/http';
import type {
  PrintTemplateData,
  PrintTemplateListResultData,
  PrintTemplateResolveData,
} from '@/views/printTemplates/printTemplateSchema';
import {
  PRINT_TEMPLATE_ACCEPT_EXT,
  printTemplateResolveSchema,
} from '@/views/printTemplates/printTemplateSchema';

/** `GET /print-templates` 查询参数。三个键都可选（缺省 = 不过滤 / 后端默认分页）。 */
export interface ListPrintTemplatesParams {
  /** 只看某一个**一级客户**绑定的模板（单个雪花 id 的字符串）。 */
  customer_id?: string;
  limit?: number;
  offset?: number;
}

/** 软删请求体。`version` 是 OCC 锚，**必填**（缺省是 axum 的 HTTP 422 纯文本、拿不到业务码）。 */
export interface DeletePrintTemplatePayload {
  version: number;
}

/**
 * 扩展名闸与 content-type 的关系。
 *
 * 2026-10-16 review 第 1 轮 NIT-1：本文件原先有一个 `normalizeUploadContentType(file)`
 * —— 签名承诺「按扩展名给」，实现却是 `void file; return XLSX_MIME`（本域只允许一种扩展名，
 * 没有分支可写），与同域的 `PRINT_TEMPLATE_ACCEPT_EXT` / `isPrintTemplateXlsxName` 职责重叠：
 * 「是不是合法的 xlsx」已经由扩展名闸判过一次（还兼着「发请求前就拦掉」的职责），再要一个
 * 「按扩展名算 MIME」的函数只会让后人以为这两处可以各改一半。故**删掉函数、直接取契约
 * 常量**，扩展名闸仍是唯一判据。
 *
 * 2026-10-15：上传改走直传链路后，这条注释仍然成立且更重要 —— `content_type` 会被签进
 * SigV4 的 SignedHeaders，PUT 时必须原样回填，所以 MIME 的唯一来源仍是
 * `XLSX_MIME` 契约常量，不是 `file.type`（浏览器对 xlsx 给的值极不稳定）。
 */

/** 扩展名是不是 `.xlsx`（大小写不敏感）。调用方在**发请求之前**用它拦一道：
 *  坏模板不该占一次往返，更不该先落库再报错。
 *
 *  ⚠️ 这也是「合法扩展名」的**唯一**判据：mime 恒取契约常量 `XLSX_MIME`，两者不再
 *  各判一遍。
 *
 *  为什么 MIME 不能用 `file.type`：浏览器给的 `file.type` 对 xlsx 极不稳定（Windows Chrome
 *  常给空串或 `application/octet-stream`，部分环境给 `application/vnd.ms-excel`），签名与
 *  后端 policy 都按 `XLSX_MIME` 比对 ⇒ 照抄 `file.type` 会被拒。 */
export function isPrintTemplateXlsxName(name: string): boolean {
  return name.toLowerCase().endsWith(PRINT_TEMPLATE_ACCEPT_EXT);
}

// 2026-10-15：删除 `uploadPrintTemplate`（`POST /api/v2/print-templates`，multipart）。
// 模板字节改走直传链路：`views/printTemplates/composables/usePrintTemplatesStore.ts`
// 调 `utils/directUpload.ts`（owner_kind='CUSTOMER' + kind='DELIVERY_TEMPLATE'），
// 校验闸（逐格 + ZIP magic 切片）留在 store 里、位置不变。
// 下面这段错误码表随之失效 —— 直传链路的错误码由 upload-intents / confirm 两个端点
// 各自定义，不再由本域汇总：
// - 40300 非 MANAGER（守卫先于 body 解析）；
// - 40001 空字节 / 缺 `data` / 缺 `file` / 缺文件名 / `customer_id` 非数字；
// - 20104 客户不存在 · 已软删 · **不是一级客户** —— ⚠️ 与 21105「owner 不存在」在后端是
//   两条码，前端文案按「不是一级客户或已不存在」统一表述即可，不必区分；
// - 21102 扩展名非 xlsx / **前 4 字节不是 `PK\x03\x04`**（不是 ZIP）—— ⚠️ 这一条在
//   直传链路里**移到了前端**（store 的 ZIP magic 切片校验，见该文件注释）；
// - 21103 超大小上限；
// - 21105 owner 不存在（`upload_file_for_owner` 内的**兜底**，正常流程走不到）；
// - 21108 撞 `uk_t_part_file_single`（并发双传同一 L1 的极端形态）。

/**
 * 模板列表（`GET /api/v2/print-templates?customer_id=&limit=&offset=`）。
 *
 * `customer_id` 缺省 = 全部模板（不限客户）。⚠️ **该端点 MANAGER 独占**：打印对话框走的是
 * 下面那条 `resolve`，普通送货员打送货单时**不会**发这个请求。
 *
 * 守门在 queryFn，本函数**不 parse**。
 *
 * ⚠️ **`limit` / `offset` 只作入参、不作回显**（2026-10-16 review 第 2 轮 C-1 连带查出的
 * 第 5 处不符）：后端 `PrintTemplateListOut` 只有 `{items, total}`。本函数原先过
 * `normalizeListResult`，它对缺失的 `limit` / `offset` 做 `Number(undefined)` ⇒ 产出 **`NaN`**，
 * 而 zod 4 的 `z.number()` 拒 NaN ⇒ queryFn 的 `parse` 每屏必抛 ⇒ 列表恒空 + 每次弹
 * 「加载失败」。故这里**不再**走 `normalizeListResult`，只对 `total` 保留一次 `Number()` 归一
 * （后端 `total` 是裸 `i64`，当前是恒等；留着是防御层，与其它域 list 端点同款）。
 */
export async function listPrintTemplates(
  params: ListPrintTemplatesParams = {},
): Promise<PrintTemplateListResultData> {
  const resp = await api.get<{
    items: PrintTemplateData[];
    total: string | number;
  }>('/print-templates', {
    params: cleanParams({
      customer_id: params.customer_id,
      limit: params.limit,
      offset: params.offset,
    }),
  });
  return { items: resp.data.items, total: Number(resp.data.total) };
}

/**
 * 打印时按一级客户自动选用模板（`GET /api/v2/print-templates/resolve?customer_id=`）。
 *
 * 权限点 `delivery_note.print`（与打印入口同一个码）⇒ 送货员打送货单走的就是这条。
 *
 * ⚠️ **未绑定不是 HTTP 错误，而是业务码 `21109`**：响应拦截器会把 `code !== 0` 的信封
 * 抛成 `ApiError(21109, …)`，调用方按 `e.code === 21109` 分流成「让用户手动选一份」，而不是
 * 当失败弹错。
 *
 * ⚠️ **出参是「信封套一行」而不是平铺**（2026-10-16 review 第 2 轮 C-1）：后端返
 * `{ template: PrintTemplateOut, customer_name }`，调用方取字段一律走 `hit.template.id` /
 * `hit.template.original_filename`。⚠️ **后端没有 `content_url` 这个字段**（原先那条关于
 * 「相对路径不能塞 `<a href>`」的注释描述的是不存在的字段，已随本轮删除）：取字节只有
 * `fetchPrintTemplateContent(template.id)` 这一条路。
 *
 * 守门在本层（没有 queryFn 承载：它是打印对话框打开时的一次性拉取）。
 */
export async function resolvePrintTemplate(customerId: string): Promise<PrintTemplateResolveData> {
  const resp = await api.get<PrintTemplateResolveData>('/print-templates/resolve', {
    params: { customer_id: customerId },
  });
  return printTemplateResolveSchema.parse(resp.data);
}

/**
 * 取模板字节（`GET /api/v2/print-templates/{id}/content`）。
 *
 * ⚠️ **本端点返回裸字节、不是 `R<T>` 信封** —— 与本域其它四条端点不同。响应拦截器对没有
 * 业务信封的响应是直接放行的（只有信封 `code !== 0` 才抛），所以这里拿到的就是字节本身。
 *
 * ⚠️ **必须走 `api` 实例，不能用裸 `fetch`**：裸 fetch 不会带 Authorization 头，后端按
 * 权限点 `delivery_note.print` 判定 ⇒ 直接 401。这也是本域**没有**任何「拼一条相对路径塞进
 * `<a href>`」的写法的原因（2026-10-16 review 第 2 轮 C-1：后端 resolve 出参里压根没有
 * `content_url` 字段，此前那段相关注释描述的是幻觉）。
 *
 * @returns hucre `openXlsx` / `renderDeliveryNoteWorkbook` 吃的那份字节。
 */
export async function fetchPrintTemplateContent(templateId: string): Promise<Uint8Array> {
  const resp = await api.get<ArrayBuffer>(
    `/print-templates/${encodeURIComponent(templateId)}/content`,
    { responseType: 'arraybuffer' },
  );
  return new Uint8Array(resp.data);
}

/**
 * 软删模板（`POST /api/v2/print-templates/{id}/delete`）。
 *
 * @param payload `version` **必填**（OCC 锚，取目标行当前的 `version`；漏传是 axum 的
 *   HTTP 422 纯文本，连业务码都拿不到）。
 *
 * ⚠️ **本函数不做 Zod 守门**：后端返 `R<()>`，信封 `data` 是 `null`，`parse(null)` 必抛。
 * 成功与否由 HTTP 状态码 / 业务码表达。
 *
 * 失败抛 `ApiError`（2026-10-16 review 第 1 轮 NIT-2 订正错误码）：
 * - 21101 模板不存在 / 已软删 —— ⚠️ **不是 21109**：软删走 `files::part_file::service
 *   ::soft_delete_file`（后端 `print_template::service::delete_template` 直接转调它），
 *   该方法对「查不到活行」返的是 `BIZ_PART_FILE_NOT_FOUND` = **21101**。21109 是
 *   `GET /resolve`「该 L1 未绑定」的码，与软删不是同一条路径；
 * - 40901 OCC 版本冲突；
 * - 40300 非 MANAGER；
 * - 21102 `kind` 不在可软删白名单内（本域写死的 `DELIVERY_TEMPLATE` 恒在白名单内，属兜底）。
 */
export async function deletePrintTemplate(
  templateId: string,
  payload: DeletePrintTemplatePayload,
): Promise<void> {
  await api.post<null>(`/print-templates/${encodeURIComponent(templateId)}/delete`, payload);
}
