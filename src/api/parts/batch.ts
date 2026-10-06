// 后端零件 API 封装 —— 批量 / 批次化端点（批量新建、批次拆分/取消、返修集合读、
// 批量送检 / 批量品检通过）。
// 2026-09-15 Phase 5：业务全切 v2，统一走 `api`（baseURL `/api/v2`）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./batch 子域。
//
// 2026-10-02：批次的**写**端点（split / cancel）与返修集合读、批量送检 /
// 批量品检通过，整体从 part 域迁入 prod 域（`/prod/batches/*`）—— 它们的操作对象是
// 批次（t_part_batch），不是 part。批次集合读 `GET /parts/{part_id}/batches` 留在
// part 域（操作对象是「某个 part 的批次集合」）。
//
// 跨子域类型引用：PartItem / PartCreatePayload 定义在 ./crud；本文件所有批量响应
// （DTO / 失败明细）都涉及单件 DTO 与单件创建 payload，因此仅 type-only 导入，
// 运行时不会产生 ESM 循环。

import { api } from '@/api/http';
import type { FileBinding } from '@/types/part_file';
import type { PartCreatePayload, PartItem } from './crud';

export interface PartBatchFailure {
  index: number;
  message: string;
}

/**
 * 2026-10-04 新增：`batchCreateParts` 成功创建的 part。
 *
 * `sourceIndex` 是**本次请求 `items` 数组的全局下标**（跨 customer 分组累计，
 * 与 `PartBatchFailure.index` 同一坐标系）。后端 `created` 按 items 顺序 push、
 * 失败项不占位，所以这个下标是「建出来的 part ↔ caller 的哪一行」的唯一可靠锚 ——
 * 不带它的话，调用方无法把 part 和本地行对应起来，也就无法做后置补传。
 */
export type CreatedPartItem = PartItem & { sourceIndex: number };

export interface PartBatchResult {
  created: CreatedPartItem[];
  failed: PartBatchFailure[];
  /** 后端 commit 后自清理的 tmp 对象 key 列表，前端忽略。 */
  cleanup_tmp_keys?: string[];
  /**
   * 2026-10-04 新增：按 customer 分组逐组提交时，**该组成败无法确定**的记录。
   * 两种来源：整组请求抛错（网络 / 5xx），或响应能拿到但 `created` / `failed` 缺字段、
   * 形状不对而无法解读。组内没有任何一行的成败信息（`failed` 是 200 响应里的逐行
   * 明细），只能给下标区间。
   */
  groupErrors?: PartBatchGroupError[];
}

export interface PartBatchGroupError {
  /** 该组覆盖的请求 items 全局下标区间（闭区间）。 */
  startIndex: number;
  endIndex: number;
  customer_id: string;
  message: string;
}

export interface PartBatchFilePayload {
  /** 浏览器里的 File 对象（el-upload 的 uploadFile.raw）。 */
  data: Blob;
  /** 原始文件名（含扩展名，后端据此判 PDF 类型）。 */
  filename: string;
  /** 可选 content-type；后端会按文件扩展名兜底。 */
  contentType?: string;
}

/** `POST /parts/batch` 单 item 入参（FE 视图）。
 *
 *  与 rust 后端 `PartBatchCreateItem`（`backend-rust/src/modules/part/dto_crud.rs`
 *  的 batch create 段）对齐：后端契约要求 top-level `customer_id`，item 不带；FE
 *  多带的 `applicant_id` 后端 serde 默认忽略，不影响解析。
 *  2026-09-16 PR-2：`actual_delivery_date` 随 t_part 瘦身从出入参一并移除。
 *
 *  2026-10-05：`unit_price` / `total_price` 后端**真的收**（此前是 FE 白名单漏转发，
 *  表格里填的含税单价在提交时被静默丢弃）。后端侧是 rust `rust_decimal` +
 *  `serde-with-str`，**只认字符串**，且标度固定 2 位（`NUMERIC(12,2)` / `NUMERIC(14,2)`）
 *  ⇒ 这里声明成 string，别用 number（浮点尾数会被 Decimal 如实解析成 13 位小数）。
 *
 *  `drawing_file` / `model3d_file` 是后端契约字段：填了就由后端在建单事务内
 *  head + copy tmp → 正式 CAS key（入参形状见 `types/part_file.ts` 的 `FileBinding`）；
 *  不填则这一步跳过，文件改在建单之后由
 *  `POST /parts/{id}/upload-drawing` / `upload-3d-model` 补传。 */
interface PartBatchCreateItemFE {
  name: string;
  drawing_no: string;
  applicant_name: string;
  quantity: number;
  request_date: string;
  planned_delivery_date: string;
  is_urgent?: boolean;
  order_no?: string | null;
  system_delivery_date?: string | null;
  note?: string | null;
  applicant_id?: string | null;
  /** 含税单价（2 位小数字符串）。缺省 = 不发该键，后端 SQL 侧 `COALESCE(…, 0::numeric)` 落 0。 */
  unit_price?: string;
  /** 含税总价（2 位小数字符串）。缺省 / null 一律落 0：后端 service 纯透传
   *  （`total_price: item.total_price`）、SQL 侧 `COALESCE(…, 0::numeric)`，
   *  **不**按 `unit_price × quantity` 重算 ⇒ 总额必须前端算好一并发，只发单价会落 0。 */
  total_price?: string | null;
  /** 可选图纸文件绑定（DRAWING kind）。后端在建单事务内 head + copy tmp → 正式 CAS key。 */
  drawing_file?: FileBinding;
  /** 可选 3D 模型绑定（3D_MODEL kind），语义同上。 */
  model3d_file?: FileBinding;
}

interface PartBatchCreateRequestFE {
  customer_id: string;
  items: PartBatchCreateItemFE[];
}

interface PartBatchCreateFailureFE {
  part_id?: string | null;
  code: number;
  message: string;
  /** 后端字段名，组内下标；FE 拼装时换算回全局下标 */
  item_index: number;
}

interface PartBatchCreateOutFE {
  /** 后端 `Vec<PartDetailOut>`，结构上与 `PartItem` 兼容（`PartDetailOut` 是超集） */
  created: unknown[];
  failed: PartBatchCreateFailureFE[];
  /** 2026-09-16 M3：后端 commit 后自清理的失败 tmp 对象 key 列表，前端忽略。 */
  cleanup_tmp_keys?: string[];
}

/** `POST /parts/batch` 单 item 入参（含可选文件绑定）。
 *
 *  `drawing_file` / `model3d_file` 是后端契约字段：填了就由后端在建单事务内
 *  head + copy tmp → 正式 CAS key；不填则建单不挂文件，文件走建单后的
 *  `POST /parts/{id}/upload-drawing` / `upload-3d-model` 补传。 */
export interface PartBatchCreatePayload extends PartCreatePayload {
  /** 选填：图纸文件绑定。 */
  drawing_file?: FileBinding;
  /** 选填：3D 模型文件绑定。 */
  model3d_file?: FileBinding;
}

/**
 * 批量新建零件（JSON）。`POST /parts/batch` 只发 JSON items，**不带文件** ——
 * 图纸 / 3D 走建单之后的 `POST /parts/{id}/upload-drawing` / `upload-3d-model`
 * 后置补传（见 `./file.ts`）；本函数的 `created[].sourceIndex` 就是 caller 把
 * 「建出来的 part」对回「本地哪一行」的锚。
 *
 * 2026-10-04：item 侧两个文件绑定字段的当前分工 —— `drawing_file` 只有 Tab 1
 * 「手工录入」在填（该 Tab 走 `useCosUploader` 前端直传 COS，建单时把 tmp_key +
 * sha 一并绑进来）；Tab 2「PDF 批量上传」是建单后逐 part 后置上传，建单请求里
 * 不带这两个字段。`model3d_file` 目前全仓没有填它的调用点。两者的差别只在文件
 * 到达建单请求之前还是之后，字段本身是后端契约字段，保留。
 *
 * 后端 multipart 端点 `POST /parts/batch-with-pdfs` 的语义是「单 PDF 多页 → 拆成装配件」，
 * 入参里没有 `items` 数组，服务端自己造一个 `装配件-{今天}` 并按 PDF 页数拆子件，
 * **不能**用来承载 Tab 2 的逐行录入。
 *
 * 后端契约（`PartBatchCreateRequest { customer_id, items }`）要求 top-level
 * `customer_id`、item 不带 `customer_id`；本函数按 customer_id 分组提交，
 * 每组共享 top-level customer_id，避免跨客户混合导致的语义错误。
 *
 * 2026-10-04：**逐组捕获、聚合返回**。每组是一次独立的 `POST /parts/batch`，组与组之间
 * 没有事务包裹 —— 第 1 组 commit 之后第 2 组 502，整体 reject 会让 caller 完全看不到
 * 第 1 组已经建出的 part，再发一次就是重复建单。改成整组（请求 + 响应解读）一起
 * try/catch：能解读的组照常进 `created` / `failed`，解读不了的组进 `groupErrors`，
 * caller 拿得到「哪些行已经建出来了」。本函数**不整体 reject**。
 * 取舍：进 `groupErrors` 的组成败仍然未知（响应丢失 / 形状不对时后端可能已 commit），
 * 本函数无法判定，只能把下标区间如实交给 caller。
 */
export async function batchCreateParts(items: PartBatchCreatePayload[]): Promise<PartBatchResult> {
  if (items.length === 0) {
    return { created: [], failed: [], cleanup_tmp_keys: [], groupErrors: [] };
  }
  // 按 customer_id 分组，每组单独提交一次。**连同请求 items 的全局下标一起存**：
  // 同一个 customer_id 可以出现在数组的多个不连续区段（Tab 2 每行各选分厂时是常态），
  // 所以不能用「前几组长度的累加」反推全局下标，只能原样带着。
  const groups = new Map<string, Array<{ item: PartBatchCreatePayload; sourceIndex: number }>>();
  items.forEach((item, sourceIndex) => {
    const list = groups.get(item.customer_id);
    if (list) {
      list.push({ item, sourceIndex });
    } else {
      groups.set(item.customer_id, [{ item, sourceIndex }]);
    }
  });
  const created: CreatedPartItem[] = [];
  const failed: PartBatchFailure[] = [];
  const groupErrors: PartBatchGroupError[] = [];
  const cleanupTmpKeys: string[] = [];
  for (const [customerId, groupItems] of groups) {
    const body: PartBatchCreateRequestFE = {
      customer_id: customerId,
      items: groupItems.map((g) => toPartBatchCreateItem(g.item)),
    };
    const groupRange = {
      customer_id: customerId,
      startIndex: groupItems[0]!.sourceIndex,
      endIndex: groupItems[groupItems.length - 1]!.sourceIndex,
    };
    try {
      const resp = await api.post<PartBatchCreateOutFE>('/parts/batch', body);
      // 响应后处理与请求同处一个 try：请求已经 commit，**任何**后续步骤抛错都不能
      // 让本函数整体 reject —— 前面几组已建出的 part 会整包丢失，caller 只能退到
      // 「回 idle 让用户重来」，那就把已建出的工单建了第二遍。所以这里只往局部变量
      // 里算，算全了才并入累加器，抛错时该组一条都不进（它的成败按未知上报）。
      const data = assertBatchCreateOut(resp.data);
      const createdInGroup = readCreatedInGroup(data, groupItems);
      const failedInGroup = readFailedInGroup(data, groupItems);
      created.push(...createdInGroup);
      failed.push(...failedInGroup);
      if (resp.data.cleanup_tmp_keys) {
        cleanupTmpKeys.push(...resp.data.cleanup_tmp_keys);
      }
    } catch (e) {
      // 这一组一条成败信息都拿不到（请求抛错，或响应缺 created / failed 无法解读），
      // 只记下标区间 + 原因，交给 caller 如实转达「成功与否未知」。
      groupErrors.push({ ...groupRange, message: (e as Error).message ?? '请求失败' });
    }
  }
  return { created, failed, cleanup_tmp_keys: cleanupTmpKeys, groupErrors };
}

/** 断言响应的 `created` / `failed` 都是数组，否则抛给调用方的 try 记成整组未知。 */
function assertBatchCreateOut(data: PartBatchCreateOutFE | undefined | null): PartBatchCreateOutFE {
  if (!data || typeof data !== 'object') {
    throw new Error('响应不是对象（可能被网关拦截）');
  }
  if (!Array.isArray(data.created)) throw new Error('响应缺少 created 数组');
  if (!Array.isArray(data.failed)) throw new Error('响应缺少 failed 数组');
  return data;
}

/**
 * 响应 `created` → 全局 `sourceIndex`。
 *
 * 后端 created[i] 恒等于组内第 i 个**成功**的 item（按 items 顺序 push、失败项不占位）
 * ⇒ 沿组内 items 顺序走一个游标，跳过 failed[].item_index 命中的项，落到的那个位置
 * 就是该 part 的源下标。
 */
function readCreatedInGroup(
  data: PartBatchCreateOutFE,
  groupItems: Array<{ item: PartBatchCreatePayload; sourceIndex: number }>,
): CreatedPartItem[] {
  const failedInGroup = new Set(data.failed.map((f) => f?.item_index));
  let groupCursor = 0;
  return data.created.map((raw) => {
    while (failedInGroup.has(groupCursor)) groupCursor += 1;
    const sourceIndex = groupItems[groupCursor]?.sourceIndex ?? groupCursor;
    groupCursor += 1;
    return { ...(raw as PartItem), sourceIndex };
  });
}

/**
 * 响应 `failed` → 请求 items 的全局下标（便于 caller 显示「第 X 行」）。
 *
 * `item_index` 不是有限数时按「解读不了」抛错（整组记未知），不用 0 / NaN 硬凑 ——
 * 凑出来的 sourceIndex 会把 part 绑到错误的本地行上。
 */
function readFailedInGroup(
  data: PartBatchCreateOutFE,
  groupItems: Array<{ item: PartBatchCreatePayload; sourceIndex: number }>,
): PartBatchFailure[] {
  return data.failed.map((f) => {
    if (typeof f?.item_index !== 'number' || !Number.isFinite(f.item_index)) {
      throw new Error('响应 failed 缺少合法的 item_index');
    }
    return {
      index: groupItems[f.item_index]?.sourceIndex ?? f.item_index,
      message: f.message,
    };
  });
}

function toPartBatchCreateItem(it: PartBatchCreatePayload): PartBatchCreateItemFE {
  return {
    name: it.name,
    drawing_no: it.drawing_no,
    applicant_name: it.applicant_name ?? '',
    quantity: it.quantity ?? 1,
    request_date: it.request_date,
    planned_delivery_date: it.planned_delivery_date,
    is_urgent: it.is_urgent,
    order_no: it.order_no,
    system_delivery_date: it.system_delivery_date,
    note: it.note,
    applicant_id: it.applicant_id,
    unit_price: it.unit_price,
    total_price: it.total_price,
    drawing_file: it.drawing_file,
    model3d_file: it.model3d_file,
  };
}

// `POST /parts/batch-with-pdfs` 是「单 PDF 多页 → 拆装配件」的树形创建端点：入参没有
// `items` 数组、服务端自己造一个 `装配件-{今天}` 并按页数拆子件，承载不了 Tab 2 的
// 逐行录入。逐行建单一律走上面的 `batchCreateParts` + 后置上传。

// ============================================================
// 批次（2026-07-29 批次化）
// ============================================================

/** 批次监控条目（详情页批次卡片）
 *
 * 2026-09-16 PR-3 字段下线/替换（后端 `t_part_batch` 同步瘦身）：
 * - 删 `next_process_id`：原意为「下一道工序 id」，PR-3 重命名为
 *   `current_process_step_id`（FK → t_process_chain_step.id），
 *   与工艺链步骤强绑定，语义不再等价于「下一道工序」。
 * - 删 `placed_at`：t_part_batch 列下线（前端展示改用 created_at / 事件历史，
 *   「上架积压」语义让位给 dashboard snapshot）。
 * - `has_been_repaired` 已于 PR-2 删除，本次确认零残留。
 * - 保留 `next_process_name`：后端 JOIN step.process 后展示名仍按此名吐出
 *   （process-chain step.process → process.name），字段名不变，前端展示
 *   「下一工序」列继续工作。
 * - 新增 `current_process_step_id`：可选（部分老接口可能未带；新接口必带）。
 *   UI 取 `step.process` 派生展示名，与 `next_process_name` 互补。
 */
export interface PartBatch {
  id: string;
  version: number;
  part_id: string;
  batch_no: number;
  batch_label: string;
  quantity: number;
  status: string;
  /** 是否返修中。「返修中」的唯一表达：本字段来自 `t_part_batch.is_repairing` 标记列，
   *  返修中批次的 `status` 恒为 `IN_PROCESS`（`GET /api/v2/parts/{id}/batches` 返回）。
   *  与 `InspectionBatchListItemOut.is_repairing` 同源同语义。 */
  is_repairing: boolean;
  location: string | null;
  current_holder_id: string | null;
  current_holder_display: string | null;
  /** 2026-09-16 PR-3 新增：当前所在工艺链步骤 id（雪花 ID 字符串；null = 未绑定步骤）。
   *  逻辑 FK → t_process_chain_step.id；展示名由后端 JOIN 派生为 next_process_name。 */
  current_process_step_id?: string | null;
  /** 下一道工序展示名（后端 JOIN step.process 后由 service 输出）。
   *  PR-3 之前字段名 next_process_name 继续沿用，避免前端展示层回退。 */
  next_process_name: string | null;
  delivery_note_id: string | null;
  delivery_note_no: string | null;
  parent_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 2026-10-02：批次**写**端点整体迁 prod 域并锚定批次 ——
 *  `POST /parts/{part_id}/batches/split` → `POST /prod/batches/{batch_id}/split`、
 *  `POST /parts/{part_id}/batches/{batch_id}/cancel` → `POST /prod/batches/{batch_id}/cancel`。
 *  `batch_id` 从 body 删除（已是路径参数），`version` 必填（OCC 锚 t_part_batch）。
 *  批次**读**（`GET /parts/{part_id}/batches`）留在 part 域不动 —— 它的操作对象是
 *  「某个 part 的批次集合」而不是单个批次，判据同 `POST /parts/{id}/cancel`。 */
export async function listPartBatches(partId: string): Promise<PartBatch[]> {
  const resp = await api.get<PartBatch[]>(`/parts/${partId}/batches`);
  return resp.data;
}

/** 拆批：后端 `SplitBatchRequest { version, quantity, note? }`（batch_id 已是路径）。 */
export async function splitPartBatch(
  batchId: string,
  payload: { quantity: number; version: number; note?: string | null },
): Promise<PartBatch[]> {
  const resp = await api.post<PartBatch[]>(
    `/prod/batches/${encodeURIComponent(batchId)}/split`,
    payload,
  );
  return resp.data;
}

/** 取消批次：后端 `CancelBatchRequest { version, reason? }`（batch_id 已是路径）。 */
export async function cancelPartBatch(
  batchId: string,
  version: number,
  reason?: string | null,
): Promise<PartBatch[]> {
  const resp = await api.post<PartBatch[]>(`/prod/batches/${encodeURIComponent(batchId)}/cancel`, {
    version,
    reason,
  });
  return resp.data;
}

/** 返修集合读行（批次级；行 = 批次）—— 服务 `GET /api/v2/prod/batches/repair`（已送货）
 *  与 `GET /api/v2/prod/batches/repairing`（返修中）两条端点。
 *
 *  名字**不含** "Inspection"：本 VO 与待品检队列行（13 字段精简 VO，见
 *  `api/inspection.ts::InspectionQueueItem`）是两个独立 VO，品检端点不归它。
 *
 *  行内无 `id` 字段：详情跳转锚是 `part_id`（`/parts/{part_id}`）。 */
export interface RepairBatchListItem {
  // 批次字段段
  batch_id: string;
  batch_no: number;
  quantity: number;
  status: string;
  /** 是否返修中。「返修中」的唯一表达 —— 返修中批次的 `status` 恒为 `IN_PROCESS`，
   *  判定必须读本字段而不是 status。恒定输出（无 Option / 无 serde(default) /
   *  无 skip_serializing_if）。 */
  is_repairing: boolean;
  location: string | null;
  version: number;
  current_process_step_id?: string | null;
  parent_batch_id: string | null;
  // holder 解析段
  current_holder_id: string | null;
  holder_name: string | null;
  next_process_id: string | null;
  next_process_name: string | null;
  // delivery_note 解析段
  delivery_note_id: string | null;
  delivery_note_no: string | null;
  // 工单字段段（t_part）
  part_id: string;
  serial_no: string | null;
  drawing_no: string;
  name: string;
  order_no: string | null;
  planned_delivery_date: string;
  is_urgent: boolean;
  part_version: number;
  created_at: string;
  updated_at: string;
  // 客户解析段
  customer_id: string;
  customer_name: string | null;
  l1_customer_name: string | null;
}

export interface RepairBatchListResult {
  items: RepairBatchListItem[];
  // 后端 total/limit/offset 用 serialize_i64 序列化为 JSON string（与雪花 ID 一致的
  // 设计），与 partListResultSchema 不同。
  // 下游 RepairReceive 在边界 Number(resp.total) 转 number 才能塞进分页组件的 total。
  total: string;
  limit: string;
  offset: string;
}

// ============ inspection to-XXX 体系批量（2026-08-28 后端路线 B 重构）==============

/** `POST /prod/batches/to-inspection` 入参项（2026-10-02 由 /parts/batch-to-inspection 迁入）。
 *
 * 字段名 / 可选性与后端 `BatchToInspectionItem` 对齐；`batch_id` 必填，雪花 ID 字符串。
 * `part_id` **不再需要** —— 后端 service 按 `batch_id` 反查 `t_part_batch.part_id`。
 * 2026-08-29：新增 `version` 必填，caller OCC 锚 t_part_batch。 */
export interface BatchToInspectionItem {
  /** 必填；雪花 ID 字符串（CLAUDE.md §3）。 */
  batch_id: string;
  /** 必填；2026-08-29：t_part_batch.version。 */
  version: number;
  /** 可选；部分数量。缺省 = 批次全量；小于批次量时后端拆批（源批次原地减量、留在源状态，
   *  被流转的那部分另立一个数量 = 操作量的新批次，语义见下方 new_batch_id）。 */
  quantity?: number | null;
}

export interface BatchToInspectionRequest {
  /** 共享品检架 id（雪花 ID 字符串；必填，zone=INSPECTION active）。 */
  target_inspection_shelf_id: string;
  /** 1..=200 项；超出后端返回 40001 VALIDATION_ERROR。 */
  items: BatchToInspectionItem[];
}

export interface BatchToInspectionFailureFE {
  /** 雪花 ID 字符串；与请求 items[].batch_id 一一对应。 */
  batch_id: string;
  /** 业务错误码（20103 INVALID_TRANSITION / 20109 / 20111 / 20511 / 20512 等）。 */
  code: number;
  /** 后端 message 原样透传。 */
  message: string;
}

export interface BatchToInspectionOutFE {
  /** 成功项，与请求 items 同序（后端顺序处理）；失败项落在 failed[]，
   *  故 submitted.length = items.length - failed.length，**下标不与 items 对齐**。
   *  注意后端 `ToXxxOut` 只序列化 `part` + `new_batch_id`，**不含 batch_id**
   *  （2026-08-28 修正，见 inspection.md「ToXxxOut 字段」表）——响应 → 请求的反查
   *  只能靠「位置 + 用 failed[].batch_id 扣除失败项」，不能指望 submitted[].batch_id。 */
  submitted: Array<{
    part: PartItem;
    /** 拆批语义（后端 `_split_for_partial_op`）：
     *  - 整批操作（quantity 缺省 / >= 批次量）→ `null`，未拆批；
     *  - 部分操作（quantity < 批次量）→ `Some(remainder_id)`，而 remainder **就是入参
     *    batch_id 本身**：源批次原地减量、状态留在源状态、id 不变；被流转的那 quantity 件
     *    另立一个**新批次**（数量 = 操作量、状态翻到目标态），其 id 全程不返回。
     *  前端拿到非 null 应刷新批次列表（会多出一行**数量 = 操作量**的新批次）。 */
    new_batch_id: string | null;
  }>;
  failed: BatchToInspectionFailureFE[];
}

export async function batchToInspection(
  payload: BatchToInspectionRequest,
): Promise<BatchToInspectionOutFE> {
  const resp = await api.post<BatchToInspectionOutFE>('/prod/batches/to-inspection', payload);
  return resp.data;
}

/** `POST /prod/batches/to-ship` 入参项（2026-10-02 由 /parts/batch-to-ship 迁入；
 *  与 BatchToInspectionItem 同形）。
 * 2026-08-29：新增 `version` 必填，caller OCC 锚 t_part_batch。 */
export interface BatchToShipItem {
  batch_id: string;
  /** 必填；2026-08-29：t_part_batch.version。 */
  version: number;
  quantity?: number | null;
}

export interface BatchToShipRequest {
  items: BatchToShipItem[];
}

export interface BatchToShipFailureFE {
  batch_id: string;
  code: number;
  message: string;
}

export interface BatchToShipOutFE {
  /** 与 BatchToInspectionOutFE.submitted 同形同语义（后端 `ToXxxOut` 单 / 批端点共用）：
   *  与请求 items 同序、**不含 batch_id**、失败项不占位。 */
  submitted: Array<{
    part: PartItem;
    /** 拆批语义与 `BatchToInspectionOutFE.submitted[].new_batch_id` 逐条一致
     *  （源批次原地减量、remainder 就是入参 batch_id、另立一个数量 = 操作量且 id
     *  不返回的新批次）。 */
    new_batch_id: string | null;
  }>;
  failed: BatchToShipFailureFE[];
}

export async function batchToShip(payload: BatchToShipRequest): Promise<BatchToShipOutFE> {
  const resp = await api.post<BatchToShipOutFE>('/prod/batches/to-ship', payload);
  return resp.data;
}
