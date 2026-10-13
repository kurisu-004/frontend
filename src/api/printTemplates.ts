// 后端 print-templates 域（送货单打印模板）API。走 `@/api/http` 统一 axios 客户端。
//
// 2026-10-16 新建。后端契约（冻结版，与本文件逐字对齐）：
//   POST /print-templates/                    → 上传 xlsx 并绑定一级客户（成功返 HTTP 201）
//   GET  /print-templates?customer_id=&limit=&offset= → 列表（分页信封）
//   GET  /print-templates/resolve?customer_id=      → 打印时按一级客户自动选用
//   GET  /print-templates/{id}/content              → 取 xlsx 字节（**裸响应体，不是信封**）
//   POST /print-templates/{id}/delete              → 软删（OCC，body 必带 version）
//
// ⚠️ **URL 一律不带尾斜杠**（`/print-templates` 而不是 `/print-templates/`）：后端把各域
// router nest 到 `/print-templates` 之下、域内首条路由注册在 `/`，nest 会把它折叠成 prefix
// 本身 —— 带尾斜杠会 404。本仓同款形态的既有实证见 `api/files/objects.ts` 的
// `uploadFileObject`（「URL 无尾斜杠：后端 nest 把内层的 `/` 折叠成 prefix 本身，带尾斜杠会
// 404」）。**不要**给上传端点补一个尾斜杠。
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
//   - `uploadPrintTemplate` / `resolvePrintTemplate` 走 useMutation / 组件单次拉取、**没有
//     queryFn 承载**，守门留在本层（同 `api/com/deliveryNote.ts::getDeliveryScanTree`）；
//   - `deletePrintTemplate` **不 parse**：后端返 `R<()>`，信封 `data` 是 `null`，没有形状可守
//     （`parse(null)` 必抛，而那正是「删除永远失败」的成因）。
//
// 出参类型一律 `import type` 取 schema 的 `z.infer` 派生类型（编译期擦除，不留
// api → views 的**类型**依赖边）；只有 parse 需要运行时引入 schema 模块。

import { api, cleanParams, normalizeListResult } from '@/api/http';
import type {
  PrintTemplateData,
  PrintTemplateListResultData,
  PrintTemplateResolveData,
} from '@/views/printTemplates/printTemplateSchema';
import {
  PRINT_TEMPLATE_ACCEPT_EXT,
  printTemplateResolveSchema,
  printTemplateSchema,
} from '@/views/printTemplates/printTemplateSchema';
// 模板文件的 MIME 的唯一来源：送货单打印模板契约（不在本文件另抄一份字面量 —— 那就是第二
// 真源，后端改判据时它不会报错、只会静默让上传被 21102 挡回）。
import { XLSX_MIME } from '@/views/com/delivery/utils/deliveryNoteTemplateContract';

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

/** 上传的 content type 归一：按**扩展名**给，绝不用 `file.type`。
 *
 *  浏览器给的 `file.type` 对 xlsx 极不稳定（Windows Chrome 常给空串或
 *  `application/octet-stream`，部分环境给 `application/vnd.ms-excel`），后端按
 *  「扩展名 → 允许的 content_type」比对 ⇒ 直传会被 21102 挡回。本域只允许一种扩展名，
 *  所以归一函数没有分支：**不是 `.xlsx` 就是错误**（由调用方在发请求前拦掉，见
 *  `PRINT_TEMPLATE_ACCEPT_EXT`）。
 *
 *  口径同 `api/files/objects.ts::normalizeUploadContentType`：重包一个 `File` 而不是在
 *  FormData 上设 content-type，是因为 multipart 的每段 content type 是跟着段走的，
 *  改 form 的 header 改不到已经 append 进去的那一段。 */
function normalizeUploadContentType(file: File): string {
  void file;
  return XLSX_MIME;
}

/** 扩展名是不是 `.xlsx`（大小写不敏感）。调用方在**发请求之前**用它拦一道：
 *  坏模板不该占一次往返，更不该先落库再报错。 */
export function isPrintTemplateXlsxName(name: string): boolean {
  return name.toLowerCase().endsWith(PRINT_TEMPLATE_ACCEPT_EXT);
}

/**
 * 上传 xlsx 模板并绑定一级客户（`POST /api/v2/print-templates`）。
 *
 * multipart body **恰好两个字段**（多 append 一个、缺字段或换个字段名后端都返 40001）：
 *   - `data`：`JSON.stringify({ customer_id })` —— 雪花 id 是 **JSON 字符串**，不是数字；
 *   - `file`：二进制。
 *
 * 同一 L1 二次上传 = 替换那一行（不是新增），前端不用做任何去重。
 *
 * 守门在本层（没有 queryFn 承载）。
 *
 * 失败抛 `ApiError`：
 * - 40001 空字节 / 字段非法；
 * - 20104 客户不存在**或不是一级客户**（`parent_id != null`）—— ⚠️ 与 21105「客户不存在」
 *   在后端是两条码，前端文案按「不是一级客户或已不存在」统一表述即可，不必区分；
 * - 21102 扩展名非 xlsx 或文件不是 ZIP；
 * - 21103 超大小上限；
 * - 40300 非 MANAGER。
 */
export async function uploadPrintTemplate(
  customerId: string,
  file: File,
): Promise<PrintTemplateData> {
  const form = new FormData();
  form.append('data', JSON.stringify({ customer_id: customerId }));
  form.append('file', new File([file], file.name, { type: normalizeUploadContentType(file) }));
  const resp = await api.post<PrintTemplateData>('/print-templates', form);
  return printTemplateSchema.parse(resp.data);
}

/**
 * 模板列表（`GET /api/v2/print-templates?customer_id=&limit=&offset=`）。
 *
 * `customer_id` 缺省 = 全部模板（不限客户）。⚠️ **该端点 MANAGER 独占**：打印对话框走的是
 * 下面那条 `resolve`，普通送货员打送货单时**不会**发这个请求。
 *
 * 守门在 queryFn，本函数**不 parse**。三个分页计数过 `normalizeListResult` 归一（后端各域
 * list 端点的计数类型不统一，见该函数的 doc）。
 */
export async function listPrintTemplates(
  params: ListPrintTemplatesParams = {},
): Promise<PrintTemplateListResultData> {
  const resp = await api.get<{
    items: PrintTemplateData[];
    total: string | number;
    limit: string | number;
    offset: string | number;
  }>('/print-templates', {
    params: cleanParams({
      customer_id: params.customer_id,
      limit: params.limit,
      offset: params.offset,
    }),
  });
  return normalizeListResult(resp.data);
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
 * 出参里的 `content_url` 是**相对路径**（不含 `/api/v2`、不带 Authorization 头）⇒ 只能当
 * 展示信息，取字节一律走 `fetchPrintTemplateContent(id)`。
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
 * 权限点 `delivery_note.print` 判定 ⇒ 直接 401。同理 `resolve` 出参里那条 `content_url`
 * 也不能塞进 `<a href>`（见该函数的 doc）。
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
 * 失败抛 `ApiError`：21109 模板已不存在或已软删 / 40901 OCC 版本冲突 / 40300 非 MANAGER。
 */
export async function deletePrintTemplate(
  templateId: string,
  payload: DeletePrintTemplatePayload,
): Promise<void> {
  await api.post<null>(`/print-templates/${encodeURIComponent(templateId)}/delete`, payload);
}
