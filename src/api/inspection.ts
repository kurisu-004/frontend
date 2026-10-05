// 品检域 API —— 扫码查「装配件 → 子零件 → 批次」树（`GET /prod/inspection/scan/{serial_no}`）。
//
// 2026-10-05 新增：待品检页的扫码入口。此前本页扫到序列号后走的是 part 域
// `GET /parts/by-serial/{serial_no}`（单件 VO，无批次），要在前端再靠当前页列表命中 /
// BatchPickerDialog / 状态分流拼出「该扫哪一批」；本端点把「扫到的件 → 它的全部批次」
// 一次返回，前端只负责展示与按批次发写端点。
//
// 两条后端行为是本文件契约的一部分（已实测）：
//   - 扫装配件条码与扫其子件条码返回**同一棵树**，差别只在 `hit_kind` 与各批次的
//     `is_scanned`（扫装配件时全部 false）；
//   - 序列号会先 `trim`，空白串 / 查不到一律 HTTP 404（业务码 20101）—— 与其它
//     端点一样由 `envelopeResponseInterceptor` 抛 `ApiError`，本文件不吞，提示由调用方
//     的 `onError` 给。
//
// 路径**相对**（`api` 实例的 baseURL 是 `/api/v2`），禁写绝对 URL：dev 走 vite proxy、
// 生产走 nginx 同源反代，写死 host 会让两个环境各连各的。

import { api } from '@/api/http';
import { inspectionScanTreeSchema } from '@/composables/queries/schemas';

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
  /** `"ASSEMBLY"` = 扫到装配件条码；`"PART"` = 扫到子件 / 独立件条码。 */
  hit_kind: string;
  scanned_serial_no: string;
  /** 仅 `hit_kind === 'ASSEMBLY'` 时有值；装配件节点本身没有批次。 */
  assembly: ScanAssemblyOut | null;
  /** 顶层子节点：装配件树 = 全部子件；独立件树 = `[被扫中的那个 part]`。 */
  children: ScanPartOut[];
}

/** 扫码查树。`serialNo` 走 `encodeURIComponent`（条码里可能带 `/` 与空格）。
 *  Zod 守门在 api 边界做（与 `listInspectionBatches` 同款），schema 在
 *  `composables/queries/schemas.ts`；两条声明（手写 interface / z.infer）等价，
 *  跨边界时用 `as` 桥接。 */
export async function scanInspection(serialNo: string): Promise<ScanTreeOut> {
  const resp = await api.get<unknown>(`/prod/inspection/scan/${encodeURIComponent(serialNo)}`);
  return inspectionScanTreeSchema.parse(resp.data) as ScanTreeOut;
}
