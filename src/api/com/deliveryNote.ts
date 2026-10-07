// 送货单管理 API 封装（`src/api/com/deliveryNote.ts`）。
//
// 2026-10-08：随视图目录搬进 `views/com/delivery/` 一并搬到 `api/com/`，URL 硬切到
// `/api/v2/com/delivery/*`（**无 alias**，旧路径 404）。
//
// 端点清单（全部走 `api`，baseURL `/api/v2`）：
//   /com/delivery/note   —— 送货单
//     GET    /                       - listNotes
//     GET    /{id}                   - getNote
//     GET    /batch-detail?ids=      - batchGetNotes
//     GET    /scan/{serial_no}       - getDeliveryScanTree    ★ 三层树（纯读，不建单）
//     POST   /scan                   - submitDeliveryEntries  ★ 入单（find-or-create DRAFT）
//     POST   /{id}/update            - updateNote
//     POST   /{id}/driver            - setNoteDriver          ★ 指定司机（打印前置）
//     POST   /{id}/remove-batches    - removeBatches
//     POST   /{id}/submit            - submitNote
//     POST   /{id}/recall            - recallNote
//     POST   /{id}/pickup            - pickup                 ★ 入参只剩 version
//     POST   /{id}/soft-delete       - softDeleteNote
//   /com/delivery/group  —— 送货分组（api 层见 src/api/com/deliveryGroup.ts）
//   /com/delivery/drivers —— 送货司机候选
//     GET    /                       - listDeliveryDrivers
//
// ⚠️ **过渡态**：后端两条打印端点（`/com/delivery/note/{id}/print` 与 `/print-labels`）
//   已在本次重构中下线（打印改为前端本地渲染），但前端的 PrintPreviewDialog 要到
//   打印对话框重写那一版才切走 ⇒ 这两个函数与它们的调用暂时原样保留（路径已硬切到
//   `/com/delivery/note/*`）。**打印对话框改本地渲染时必须同批删除本节**。
//
// 已下线（2026-10-08，本次一并删除前端调用与类型）：手动建单 `POST /`、候选零件
// `GET /candidate-parts`、加件 `POST /{id}/add-parts`、attach `POST /{id}/attach-batches`、
// 事件流 `GET /{id}/events`、待领 `GET /pickup-pending`、司机累扫 `POST /{id}/pickup-scan`、
// 打印 `POST /{id}/print` 与 `POST /{id}/print-labels`（打印改为前端 hucre 本地生成）。
//
// 权限一律 Mgr+Clerk+Inspector；错误码按 `ApiError.code` 分流（见各函数注释）。
// 全部雪花 ID 入参为 string（CLAUDE.md 硬约束：JS Number 丢精度）。

import { api } from '@/api/http';
import type { DeliveryNoteStatus, DeliveryNoteSortDir, DeliveryNoteSortKey } from '@/types/deliveryNote';
import type {
  DeliveryNoteBatchDetailResultData,
  DeliveryNoteDetailData,
  DeliveryNoteDriverRequest,
  DeliveryNoteItemData,
  DeliveryNoteListResultData,
  DeliveryNoteRemoveBatchesPayload,
  DeliveryNoteUpdatePayload,
  DeliveryNoteVersionPayload,
  DeliveryScanEntryRequest,
  DeliveryDriverListResultData,
} from '@/views/com/delivery/composables/deliveryNoteSchema';
import type { DeliveryScanTreeData } from '@/views/com/delivery/composables/deliveryScanTreeSchema';
// 守门 parse 留在本层：扫码取树走 useMutation（用户触发的单次拉取），没有 queryFn 承载。
import { deliveryScanTreeSchema } from '@/views/com/delivery/composables/deliveryScanTreeSchema';

// ============ 入参 / 出参载荷 ============

/** `GET /com/delivery/note` 查询参数。
 *  - `statuses` 走 CSV 白名单（`api` 实例的 serializeParamsV2 负责编码），数组会被
 *    编码成逗号分隔单值，后端 `Option<List<String>>` / `Option<String>` 双形态都接；
 *  - `customer_id` 必须是单值 string，绝不能传数组（会被展成重复 query key）。 */
export interface ListNotesParams {
  statuses?: DeliveryNoteStatus[];
  customer_id?: string;
  keyword?: string;
  sort_by?: DeliveryNoteSortKey;
  sort_dir?: DeliveryNoteSortDir;
  limit?: number;
  offset?: number;
}

// ============ 送货单：读 ============

/** 送货单一览（分页信封）。 */
export async function listNotes(params: ListNotesParams = {}): Promise<DeliveryNoteListResultData> {
  const query: Record<string, unknown> = {};
  if (params.statuses?.length) query.statuses = params.statuses;
  if (params.customer_id) query.customer_id = params.customer_id;
  if (params.keyword) query.keyword = params.keyword;
  if (params.sort_by) query.sort_by = params.sort_by;
  if (params.sort_dir) query.sort_dir = params.sort_dir;
  if (params.limit !== undefined) query.limit = params.limit;
  if (params.offset !== undefined) query.offset = params.offset;
  const resp = await api.get<DeliveryNoteListResultData>('/com/delivery/note', { params: query });
  return resp.data;
}

/** 送货单详情（含拆批后的完整 `line_items`）。 */
export async function getNote(noteId: string): Promise<DeliveryNoteDetailData> {
  const resp = await api.get<DeliveryNoteDetailData>(
    `/com/delivery/note/${encodeURIComponent(noteId)}`,
  );
  return resp.data;
}

/** `GET /com/delivery/note/batch-detail?ids=...` —— 一次往返拉 N 张草稿详情。
 *  items 按入参 ids 顺序装配、缺失 id 静默跳过；入参限制 1..=200 项
 *  （超出或非 i64 后端返 400 / BIZ_INVALID_VALUE 20104）。 */
export async function batchGetNotes(ids: readonly string[]): Promise<DeliveryNoteDetailData[]> {
  if (ids.length === 0) return [];
  const resp = await api.get<DeliveryNoteBatchDetailResultData>(
    '/com/delivery/note/batch-detail',
    { params: { ids: ids.join(',') } },
  );
  return resp.data.items;
}

/** `GET /com/delivery/note/scan/{serial_no}` —— 扫码命中的三层树（装配件 → 子件 → 批次）。
 *
 *  - **纯读端点，绝不建单**：该 L1 下还没有 DRAFT 时返回 `draft: null`；建单发生在
 *    `submitDeliveryEntries`；
 *  - `serial_no` 是 varchar（可能含 `-`），前端必须 encodeURIComponent；
 *  - 批次层**不过滤状态**（含终态）—— 弹窗要回答「这批货总共分了几批、现在什么状态」，
 *    状态闸门在前端；
 *  - 未命中抛 404 / `20101 BIZ_PART_NOT_FOUND`。
 *
 *  ⚠️ 守门 parse 在本层：调用方是 useMutation（用户触发的单次拉取），没有 queryFn 承载。 */
export async function getDeliveryScanTree(serialNo: string): Promise<DeliveryScanTreeData> {
  const resp = await api.get<unknown>(`/com/delivery/note/scan/${encodeURIComponent(serialNo)}`);
  return deliveryScanTreeSchema.parse(resp.data);
}

// ============ 送货单：写 ============

/** 部分更新（详情页改送货日期 / 备注）：字段不传 = 不改。 */
export async function updateNote(
  noteId: string,
  payload: DeliveryNoteUpdatePayload,
): Promise<DeliveryNoteItemData> {
  const resp = await api.post<DeliveryNoteItemData>(
    `/com/delivery/note/${encodeURIComponent(noteId)}/update`,
    payload,
  );
  return resp.data;
}

/** 指定送货司机。打印前必须先指定司机（打印对话框的「导出」按钮按此判空）。
 *  后端校验 version + `validate_driver`（在职 + 工种 code == '送货司机'），不通过
 *  返 21409 `BIZ_DELIVERY_NOTE_DRIVER_INVALID`。 */
export async function setNoteDriver(noteId: string, payload: DeliveryNoteDriverRequest) {
  const resp = await api.post<DeliveryNoteItemData>(
    `/com/delivery/note/${encodeURIComponent(noteId)}/driver`,
    payload,
  );
  return resp.data;
}

/** 移除批次（由旧 `remove-parts` 改名；返回刷新后的详情）。 */
export async function removeBatches(
  noteId: string,
  payload: DeliveryNoteRemoveBatchesPayload,
): Promise<DeliveryNoteDetailData> {
  const resp = await api.post<DeliveryNoteDetailData>(
    `/com/delivery/note/${encodeURIComponent(noteId)}/remove-batches`,
    payload,
  );
  return resp.data;
}

/** 提交（`DRAFT → SUBMITTED`）。
 *
 *  响应只回送货单 id（`R<String>`）：入单前的状态闸门收敛在服务端，前端拿到 2xx 就是
 *  提交成功；OCC / 批次状态问题一律抛错（21403 note 版本冲突 / 40901 批次版本冲突 /
 *  21405 `BIZ_DELIVERY_NOTE_PART_NOT_READY` / 21406 `..._PART_ALREADY_ASSIGNED`）。 */
export async function submitNote(
  noteId: string,
  payload: DeliveryNoteVersionPayload,
): Promise<string> {
  const resp = await api.post<string>(
    `/com/delivery/note/${encodeURIComponent(noteId)}/submit`,
    payload,
  );
  return resp.data;
}

/** 撤回（`SUBMITTED → DRAFT`）。 */
export async function recallNote(noteId: string, payload: DeliveryNoteVersionPayload) {
  const resp = await api.post<DeliveryNoteItemData>(
    `/com/delivery/note/${encodeURIComponent(noteId)}/recall`,
    payload,
  );
  return resp.data;
}

/** 一键送货（`SUBMITTED → PICKED_UP`）。
 *
 *  ⚠️ 入参**只剩 version**：司机改由 `POST /{id}/driver` 预先指定，服务端从单据上读
 *  `driver_worker_id`；为 None 返 21409，并**重跑 `validate_driver`**（司机可能在
 *  打印到送货之间被停用 / 改工种）。 */
export async function pickup(noteId: string, payload: DeliveryNoteVersionPayload) {
  const resp = await api.post<DeliveryNoteItemData>(
    `/com/delivery/note/${encodeURIComponent(noteId)}/pickup`,
    payload,
  );
  return resp.data;
}

/** 软删（带 version 乐观锁）。 */
export async function softDeleteNote(
  noteId: string,
  payload: DeliveryNoteVersionPayload,
): Promise<void> {
  await api.post(`/com/delivery/note/${encodeURIComponent(noteId)}/soft-delete`, payload);
}

/** `POST /com/delivery/note/scan` —— **入单的唯一入口**（手动建单已下线）。
 *
 *  响应含拆批后的完整 `DeliveryNoteDetailOut` ⇒ 前端可就地替换草稿看板那张卡，
 *  不用重新扫码。校验闸门（21405 `BIZ_DELIVERY_NOTE_PART_NOT_READY`）：批次状态
 *  ≠ READY_TO_SHIP、DP 分配凑不出、sets > entry_max_sets；批次已挂在别的单上返
 *  21406，零件 L1 ≠ 单据 L1 返 21416，命中既有 DRAFT 而 `note_version` 不匹配返 40901。 */
export async function submitDeliveryEntries(
  payload: DeliveryScanEntryRequest,
): Promise<DeliveryNoteDetailData> {
  const resp = await api.post<DeliveryNoteDetailData>('/com/delivery/note/scan', payload);
  return resp.data;
}

/** `GET /com/delivery/drivers` —— 送货司机候选（在职 + 工种 code == '送货司机'）。 */
export async function listDeliveryDrivers(): Promise<DeliveryDriverListResultData> {
  const resp = await api.get<DeliveryDriverListResultData>('/com/delivery/drivers');
  return resp.data;
}

// ============================================================
// 打印（**过渡态**，见文件头：打印对话框改本地渲染时整节删除）
// ============================================================

export interface PrintNoteProgress {
  loaded: number;
  total: number;
}

export interface PrintNoteResult {
  blob: Blob;
  filename: string;
}

export interface PrintNotePayload {
  /** 批次 id 顺序（与预览组件产出对齐；空 = 走默认 DB 顺序）。 */
  custom_order?: string[];
  /** 装配件子件合并为一行（单位套）；false = 散件逐行（默认）。 */
  merge_assemblies?: boolean;
}

export interface PrintLabelsPayload extends PrintNotePayload {
  /** 只打这些批次行；省略 = 全部。 */
  line_item_ids?: string[];
}

export async function printNote(
  noteId: string,
  payload: PrintNotePayload = {},
  onProgress?: (p: PrintNoteProgress) => void,
): Promise<PrintNoteResult> {
  const resp = await api.post<Blob>(
    `/com/delivery/note/${encodeURIComponent(noteId)}/print`,
    payload,
    {
      responseType: 'blob',
      onDownloadProgress: (event) => {
        onProgress?.({ loaded: event.loaded, total: event.total ?? 0 });
      },
    },
  );
  return {
    blob: resp.data,
    filename: parseFilename(resp.headers['content-disposition']) ?? `note-${noteId}.xlsx`,
  };
}

export async function printNoteLabels(
  noteId: string,
  payload: PrintLabelsPayload = {},
  onProgress?: (p: PrintNoteProgress) => void,
): Promise<PrintNoteResult> {
  const resp = await api.post<Blob>(
    `/com/delivery/note/${encodeURIComponent(noteId)}/print-labels`,
    payload,
    {
      responseType: 'blob',
      onDownloadProgress: (event) => {
        onProgress?.({ loaded: event.loaded, total: event.total ?? 0 });
      },
    },
  );
  return {
    blob: resp.data,
    filename: parseFilename(resp.headers['content-disposition']) ?? `label-${noteId}.xlsx`,
  };
}

/** 解析 `attachment; filename="delivery_note_F_123.xlsx"`。 */
function parseFilename(header: string | undefined): string | null {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(header);
  return m ? decodeURIComponent(m[1].trim()) : null;
}

// ============ wire 契约类型再导出 ============
// 调用方统一从 api 层取类型，不必跨目录 import 域内 schema 文件。
export type {
  DeliveryNoteBatchDetailResultData,
  DeliveryNoteDetailData,
  DeliveryNoteDriverRequest,
  DeliveryNoteItemData,
  DeliveryNoteLineItemData,
  DeliveryNoteListResultData,
  DeliveryNoteRemoveBatchesPayload,
  DeliveryNoteUpdatePayload,
  DeliveryNoteVersionPayload,
  DeliveryScanEntry,
  DeliveryScanEntryRequest,
  DeliveryDriverData,
  DeliveryDriverListResultData,
} from '@/views/com/delivery/composables/deliveryNoteSchema';
export type { DeliveryScanTreeData } from '@/views/com/delivery/composables/deliveryScanTreeSchema';