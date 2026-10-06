// 品检域 API —— 两条只读端点，都落在 prod::inspection 域下：
//   1. 待品检队列列表（`GET /prod/inspection/queue`，判据 `status='INSPECTION'`）；
//   2. 扫码查「装配件 → 子零件 → 批次」树（`GET /prod/inspection/scan/{serial_no}`）。
//
// 路径**相对**（`api` 实例的 baseURL 是 `/api/v2`），禁写绝对 URL：dev 走 vite proxy、
// 生产走 nginx 同源反代，写死 host 会让两个环境各连各的。

import { api, cleanParams } from '@/api/http';
import type { InspectionSortKey } from '@/types/inspection';
import type { SortDir } from '@/types/parts';
import {
  inspectionScanTreeSchema,
  type InspectionQueueListResultData,
} from '@/views/inspection/composables/inspectionSchema';

/** 待品检队列行（批次级；行 = 批次）—— 服务 `GET /api/v2/prod/inspection/queue`。
 *
 *  **恰 13 个键**，字段严格对齐后端本端点专属 VO：
 *   - 7 个数据列：serial_no / drawing_no / name / batch_no / quantity /
 *     system_delivery_date /（customer_name + l1_customer_name 供客户列派生「父 / 子」）；
 *   - 3 个写端点 / 跳转锚：batch_id（`POST /prod/batches/{batch_id}/…` 路径参数 +
 *     扫码选行标识）、part_id（`/parts/{part_id}`）、version（OCC 锚 t_part_batch）；
 *   - 筛选 / 展示辅助：customer_id（客户表头筛选）、is_urgent（加急红底）。
 *
 *  与返修两条端点的行类型 `RepairBatchListItem`（`@/api/parts`，28 字段）**不可互相
 *  cast**：本 VO 不含 status / location / holder_name / next_process_* / is_repairing /
 *  order_no / planned_delivery_date / delivery_note_* / parent_batch_id /
 *  current_process_step_id / part_version / created_at / updated_at。 */
export interface InspectionQueueItem {
  batch_id: string;
  batch_no: number;
  quantity: number;
  /** OCC 锚 `t_part_batch.version`（**不是** `t_part.version`）。 */
  version: number;
  part_id: string;
  serial_no: string | null;
  drawing_no: string;
  name: string;
  /** 系统交期；DB NULL → null（列表页渲染 '—'）。 */
  system_delivery_date: string | null;
  is_urgent: boolean;
  customer_id: string;
  customer_name: string | null;
  /** L1（一级客户）名；客户列渲染「L1 / L2」两段文本。 */
  l1_customer_name: string | null;
}

// 分页信封不另起一份手写声明：形状 = `InspectionQueueItem[]` + 三个 JSON string 计数，
// 直接取域内 schema 的 z.infer（`InspectionQueueListResultData`，见 listInspectionBatches
// 的返回类型标注）。
// ⚠️ 单点只覆盖**信封**：**行**类型 `InspectionQueueItem`（上方手写声明）与
// `inspectionQueueListItemSchema` 仍是双声明 —— 行被列定义 / 表格 / 扫码选行共用，
// 改行字段须同批改两处。

/** `GET /prod/inspection/queue` 的 Query 入参。
 *
 *  契约：三个 ILIKE 子串参数各自独立（`drawing_no` / `name` / `serial_no`，同时传
 *  ⇒ AND 联合），日期筛**系统交期**，服务端排序白名单见 `InspectionSortKey`
 *  （非法值后端退化为 SYSTEM_DELIVERY_DATE / ASC）。 */
export interface ListInspectionQueueParams {
  /** ILIKE `%kw%` 匹配 `t_part.drawing_no`；含 `%` `_` `\` → 40001。 */
  drawing_no?: string;
  /** ILIKE `%kw%` 匹配 `t_part.name`。 */
  name?: string;
  /** ILIKE `%kw%` 匹配 `t_part.serial_no`。 */
  serial_no?: string;
  /** 雪花 ID 字符串，禁止 Number()（19 位雪花 ID 会丢精度）。后端展开为 L1+L2 ids。 */
  customer_id?: string;
  /** 系统交期区间（含端点；任一端点为空表示半开）。 */
  system_delivery_date_from?: string;
  system_delivery_date_to?: string;
  sort_by?: InspectionSortKey;
  sort_dir?: SortDir;
  limit?: number;
  offset?: number;
}

/** 待品检队列（`GET /api/v2/prod/inspection/queue`）。
 *
 *  Zod 守门在 **queryFn**（`views/inspection/composables/useInspectionQueueQuery`，
 *  schema 同居域内 `views/inspection/composables/inspectionSchema.ts`）：本层只发请求
 *  + 标注返回类型，不 parse（parse 返回深拷贝，多一层等于每屏数据被校验并克隆两遍）。
 *  item schema 用 `.strict()`，后端若误把 `id` 字段加进响应（regression）或漏 part_id
 *  等核心字段，queryFn 的 parse 立刻抛错而非默认 strip 静默丢。
 *
 *  出参是 13 字段精简 VO（`InspectionQueueItem`），入参是 `ListInspectionQueueParams`
 *  （三个 ILIKE 子串 + 系统交期区间 + 服务端排序）。分页信封的 total / limit / offset
 *  是 JSON **string**（后端 serialize_i64），调用方在边界 Number() 转 number 才能塞进
 *  分页组件。
 *
 *  返回类型标注取域内 schema 的 z.infer，与 `InspectionQueueItem`（本文件保留的手写
 *  行类型，被列定义 / 表格 / 扫码选行共用）结构一致，故不需要桥接 cast。 */
export async function listInspectionBatches(
  params: ListInspectionQueueParams = {},
): Promise<InspectionQueueListResultData> {
  const resp = await api.get<InspectionQueueListResultData>('/prod/inspection/queue', {
    params: cleanParams(params),
  });
  return resp.data;
}

// ============================================================
// 扫码查树（`GET /prod/inspection/scan/{serial_no}`）。
//
// 2026-10-05 新增：待品检页的扫码入口 —— 把「扫到的件 → 它的全部批次」一次返回，
// 前端只负责展示与按批次发写端点。
//
// 两条后端行为是本端点契约的一部分（已实测）：
//   - 扫装配件条码与扫其子件条码返回**同一棵树**，差别只在 `hit_kind` 与各批次的
//     `is_scanned`，三档分别是：扫独立件 = 该件全部批次 true；扫**装配件子件**
//     （hit_kind 'PART' + assembly 非空）= 只有被扫中那个子件的批次 true、兄弟子件
//     全 false；扫装配件条码（hit_kind 'ASSEMBLY'）= 全部 false。渲染层的高亮一律
//     照抄这个 flag，不要在前端按 hit_kind 反推；
//   - 序列号会先 `trim`，空白串 / 查不到一律 HTTP 404（业务码 20101）—— 与其它
//     端点一样由 `envelopeResponseInterceptor` 抛 `ApiError`，本文件不吞，提示由调用方
//     的 `onError` 给。
// ============================================================

/** 树里的装配件节点（`ScanAssemblyOut`）。装配件本身**没有批次**，只有子零件有。 */
export interface ScanAssemblyOut {
  /** `t_assembly.id`（`serialize_i64` → JSON string）。禁 `Number()`：19 位 ID 丢精度。 */
  id: string;
  serial_no: string | null;
  name: string;
  drawing_no: string;
  /** 装配件自身的派生状态（后端自 `t_assembly` 投影，与批次状态是两套计数器）。 */
  status: string;
  quantity: number;
  is_urgent: boolean;
  /** `YYYY-MM-DD`；DB NULL → JSON null。 */
  system_delivery_date: string | null;
  customer_name: string | null;
}

/** 树里的零件节点（`ScanPartOut`）：装配件的子件，或独立件本身。 */
export interface ScanPartOut {
  /** `t_part.id`（JSON string）。 */
  id: string;
  serial_no: string | null;
  name: string;
  drawing_no: string;
  status: string;
  quantity: number;
  is_urgent: boolean;
  system_delivery_date: string | null;
  customer_name: string | null;
  /** `t_part.version` —— **不是**批次版本，只作展示；三个写端点的 OCC 锚是批次的 version。 */
  version: number;
  children: ScanBatchOut[];
}

/** 树里的批次节点（`ScanBatchOut`）：该零件的**全部**批次（含终态）。 */
export interface ScanBatchOut {
  /** `t_part_batch.id`（JSON string）—— 三个写端点的路径参数。 */
  id: string;
  batch_no: number;
  quantity: number;
  /** 批次 `status` 原文（8 态枚举字符串）。 */
  status: string;
  /** `t_part_batch.version` —— 写端点的 OCC 锚。与父级 `ScanPartOut.version` 是两个计数器。 */
  version: number;
  /** 返修标记（后端 2026-10-01 起不再产生 REPAIRING 状态，返修语义由该布尔列承载）。 */
  is_repairing: boolean;
  /** `t_part_batch.location` 枚举原文（`PRODUCTION_SHELF` / `INSPECTION_SHELF` / `WORKER` …）。 */
  location: string | null;
  /** 派生持有人名（货架编码 / 工人姓名），无则 null。 */
  current_holder_display: string | null;
  /** 当前工序名；INSPECTION 批次恒 null（出池时后端清 `current_process_id`）。 */
  process_name: string | null;
  /** 该批次所属零件就是本次扫中的那个 → 前端据此高亮。 */
  is_scanned: boolean;
}

/** 扫码响应（`ScanTreeOut`）。 */
export interface ScanTreeOut {
  /** `"ASSEMBLY"` = 扫到装配件条码；`"PART"` = 扫到子件 / 独立件条码。
   *  后端只有这两个字面量，`views/inspection/composables/inspectionSchema.ts` 侧按 `z.enum` 守门，这里同步收窄。 */
  hit_kind: 'ASSEMBLY' | 'PART';
  scanned_serial_no: string;
  /** 装配件节点；**扫装配件条码、或扫中的零件是某个装配件的子件时**都有值
   *  （后端只保证 hit_kind='ASSEMBLY' ⇔ 非空，反过来不成立），独立件 / 父装配件已软删
   *  时为 null。装配件节点本身没有批次。 */
  assembly: ScanAssemblyOut | null;
  /** 顶层子节点：装配件树（含「扫子件」那一档）= 全部子件；独立件树 = `[被扫中的那个 part]`。 */
  children: ScanPartOut[];
}

/** 扫码查树。`serialNo` 走 `encodeURIComponent`（条码里可能带 `/` 与空格）。
 *  Zod 守门在 api 边界做（schema 在域内 `views/inspection/composables/inspectionSchema.ts`，
 *  与手写 `ScanTreeOut` 等价，跨边界用 `as` 桥接）。守门留在本层而不是 queryFn：
 * 扫码是用户触发的单次拉取（store 内走 useMutation，没有承载它的 queryFn）。 */
export async function scanInspection(serialNo: string): Promise<ScanTreeOut> {
  const resp = await api.get<unknown>(`/prod/inspection/scan/${encodeURIComponent(serialNo)}`);
  return inspectionScanTreeSchema.parse(resp.data) as ScanTreeOut;
}
