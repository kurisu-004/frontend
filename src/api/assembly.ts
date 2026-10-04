// 装配体 REST API（走 @/api/http 统一 axios 客户端）。
// multipart 的文件字段名**按端点不同**：创建端点 `POST /assemblies` 认 `files`
// （复数），详情页补传端点 `POST /assemblies/{id}/files` 认 `file`（单数）。

import { api, cleanParams } from '@/api/http';
import {
  assemblyDetailFlatSchema,
  assemblyFileRefSchemaArray,
  assemblyOutSchema,
  type AssemblyChildOutSchema,
  type AssemblyDetailFlatSchema,
  type AssemblyFileRefSchema,
  type AssemblyOutSchema,
} from '@/composables/queries/schemas';
import type { Customer } from '@/api/customer';
import type {
  AssemblyCreatePayload,
  AssemblyCreateResult,
  AssemblyDetail,
  AssemblyChildItem,
  AssemblyListQuery,
  AssemblyListResult,
  AssemblyItem,
  AssemblyUpdatePayload,
} from '@/types/assembly';
import type { PartFileListResult, DrawingFileItem } from '@/types/part_file';
import type { PartListItem } from '@/types/parts';

/**
 * 2026-09-29 修复：消化 backend-rust `AssemblyDetail` 的 `#[serde(flatten)]` quirk。
 *
 * 后端 wire 形态（backend-rust src/modules/assembly/vo/assembly.rs:113-119）：
 *   { ...AssemblyOut 19 字段, children: [...], files: [...] }
 *   —— 无 `assembly` 嵌套键，AssemblyOut 19 字段被 `#[serde(flatten)]` 平铺到顶层。
 *
 * 前端类型契约保持嵌套 `{assembly, children, files}`（最小爆炸半径），
 * 本函数在 api 边界把平铺转回嵌套 + 字段对齐：
 *   - child_count 由 mapper 注入 = flat.children.length
 *   - customer_name / parent_customer_name / customer_path 暂置 null，
 *     由 useAssemblyDetail composable 在 fetchData 后用 useCustomersQuery 派生补全
 *   - unit_price / total_price nullable 走 null 兜底（review 第 1 轮 m1/m5）：
 *     旧实现用 '0' 伪装 number 与 PartListItem string 桥接的过渡形态；
 *     实际语义「后端未落库」应该是 null，UI 端用 — 占位（el-descriptions 自动处理）。
 *
 * 守门走 Zod parse（assemblyDetailFlatSchema.strict）：后端意外把 assembly 改回嵌套键
 * 会立刻抛 ZodError，避免静默 fail。
 */
export function parseAssemblyDetail(raw: unknown): AssemblyDetail {
  const flat: AssemblyDetailFlatSchema = assemblyDetailFlatSchema.parse(raw);
  return {
    assembly: parseAssemblyOutToItemCore(flat, flat.children.length),
    children: flat.children.map(childToAssemblyChildItem),
    files: flat.files.map(fileToDrawingFileItem),
  };
}

/** 2026-09-29 review 第 1 轮 C1 修复：把后端 AssemblyOut 19 字段（write 接口响应 /
 * list 接口 item）转成前端 AssemblyItem。
 *
 * 后端实际响应形态（已核对 backend-rust/src/modules/assembly/handler.rs:168, 211）：
 *   - POST /api/v2/assemblies/{id}/update → R<AssemblyOut>
 *   - POST /api/v2/assemblies/{id}/cancel → R<AssemblyOut>
 *   - GET /api/v2/assemblies → AssemblyListItem（= AssemblyOut）
 *
 * 字段对齐：
 *   - child_count 派生：write 接口不返 children → 用 caller 传的 count（list 调用传
 *     children.length，update / cancel 调用传 0，由 composable 后续 mutate 校正）
 *   - customer_name / parent_customer_name / customer_path 三字段后端不返，置 null，
 *     由 useAssemblyDetail composable 在 fetchData / 写操作成功后用 useCustomersQuery
 *     派生补全（enrichAssemblyCustomer）。
 *   - unit_price / total_price nullable → Number() 或 null（不再 '0' 伪装）。
 *
 * 走 assemblyOutSchema.parse 守门：后端意外增删字段立刻抛 ZodError。
 */
export function parseAssemblyOutToItem(raw: unknown, childCount: number): AssemblyItem {
  const flat: AssemblyOutSchema = assemblyOutSchema.parse(raw);
  return parseAssemblyOutToItemCore(flat, childCount);
}

/** 内部 helper：AssemblyOut → AssemblyItem 字段映射；childCount 由 caller 决定。 */
function parseAssemblyOutToItemCore(flat: AssemblyOutSchema, childCount: number): AssemblyItem {
  return {
    id: flat.id,
    version: flat.version,
    serial_no: flat.serial_no,
    drawing_no: flat.drawing_no,
    name: flat.name,
    applicant_name: flat.applicant_name,
    customer_id: flat.customer_id,
    customer_name: null,
    parent_customer_name: null,
    customer_path: null,
    request_date: flat.request_date,
    planned_delivery_date: flat.planned_delivery_date,
    is_urgent: flat.is_urgent,
    status: flat.status,
    child_count: childCount,
    quantity: flat.quantity,
    unit_price: flat.unit_price ? Number(flat.unit_price) : null,
    total_price: flat.total_price ? Number(flat.total_price) : null,
    order_no: flat.order_no,
    system_delivery_date: flat.system_delivery_date,
    note: flat.note,
    created_at: flat.created_at,
    updated_at: flat.updated_at,
  };
}

/**
 * 2026-09-29 review 第 2 轮 MAJOR-1 修复：把客户字段 enrich 逻辑提到 api 层作
 * 共享纯函数，让 useAssemblyDetail（详情页）与 usePartDetail（PartDetail 所属
 * 装配件卡 via getAssemblyForPart）都走同一份补全逻辑。
 *
 * 动机：旧实现 enrichAssemblyCustomer 只挂在 useAssemblyDetail composable
 * 内部，PartAssemblyLinkCard 走 usePartDetail.fetchAssembly → getAssemblyForPart
 * → parseAssemblyDetail 直接 set assemblyDetail.value，绕过 enrich，导致
 * 装配件链接卡客户列永远显示 `—`。
 *
 * 语义（与旧 enrichAssemblyCustomer 完全一致）：
 * - customers 中按 item.customer_id 找匹配客户：
 *   - 找到 → customer_name = name, parent_customer_name = parent_name,
 *     customer_path = 「父 / 子」或「name」
 *   - 找不到 → 三字段全置 null（保持 mapper 兜底）
 *
 * 纯函数：返回新对象，不 mutate 输入；调用方负责把返回值赋回
 * `detail.assembly` / `assemblyDetail.assembly`。
 *
 * customers 接受空数组（useCustomersQuery 缓存未到达时），找不到客户时三字段
 * 全置 null——与上游 mapper 默认值一致。
 */
export function enrichAssemblyItem(item: AssemblyItem, customers: Customer[]): AssemblyItem {
  const customer = customers.find((c) => c.id === item.customer_id);
  if (!customer) {
    return {
      ...item,
      customer_name: null,
      parent_customer_name: null,
      customer_path: null,
    };
  }
  return {
    ...item,
    customer_name: customer.name,
    parent_customer_name: customer.parent_name,
    customer_path: customer.parent_name
      ? `${customer.parent_name} / ${customer.name}`
      : customer.name,
  };
}

/** 2026-09-29 修复：AssemblyChildOut → AssemblyChildItem 字段对齐。
 *  PartListItem 必填字段全补齐（applicant_name / quantity / unit_price='0' /
 *  total_price='0' / request_date / planned_delivery_date / status / order_no /
 *  system_delivery_date / note=null / customer_name=null / l1_customer_name=null /
 *  location=null / row_type='PART' / has_children=false），is_urgent 兜底 false。 */
function childToAssemblyChildItem(c: AssemblyChildOutSchema): AssemblyChildItem {
  return {
    id: c.id,
    version: c.version,
    serial_no: c.serial_no,
    drawing_no: c.drawing_no ?? '',
    name: c.name,
    applicant_name: c.applicant_name,
    quantity: c.quantity,
    unit_price: '0',
    total_price: '0',
    request_date: c.request_date,
    planned_delivery_date: c.planned_delivery_date ?? c.request_date,
    is_urgent: c.is_urgent,
    status: c.status,
    order_no: c.order_no,
    system_delivery_date: c.system_delivery_date,
    note: c.note,
    customer_name: null,
    l1_customer_name: null,
    location: null,
    current_batch_id: c.current_batch_id ?? null,
    row_type: 'PART',
    has_children: false,
    // 2026-09-29 新增：PartListItem 必填 has_cnc_program 字段（沿 chain 派生）。
    // 装配件子件没有 chain 上下文，mapper 一律填 false（语义合理：装配件子件不直接
    // 走「待编程一览」路径，由父装配件的 chain 决定 has_cnc_program）。
    has_cnc_program: false,
    __is_child: true,
  };
}

/** 2026-09-29 修复：AssemblyFileRef → DrawingFileItem 字段对齐。
 *  后端 AssemblyFileRef 只有 id / original_filename / page_count 3 字段，
 *  DrawingFileItem 是 PartFileItem 的 alias（含 owner_id / kind / file_size 等），
 *  mapper 仅填已知字段，page_count 是 AssemblyFileRef 专属字段（master PDF 按页
 *  拆分总页数），不在 PartFileItem 类型里 → 暂存为 object 上一个 extra 字段，
 *  调用方按需读取（实际消费方 masterFiles / childDrawingMap 仅用 kind / owner_id）。
 *  此处构造一个最小可用对象，TypeScript 强转兜底。 */
function fileToDrawingFileItem(f: AssemblyFileRefSchema): DrawingFileItem {
  return {
    id: f.id,
    original_filename: f.original_filename,
    page_count: f.page_count ?? null,
  } as unknown as DrawingFileItem;
}

export async function listAssemblies(q: AssemblyListQuery = {}): Promise<AssemblyListResult> {
  const resp = await api.get<AssemblyListResult>('/assemblies', {
    params: cleanParams(q),
  });
  return resp.data;
}

export async function getAssembly(id: string): Promise<AssemblyDetail> {
  // 2026-09-29 修复：resp.data 类型由 AssemblyDetail 改为 unknown，再走
  // parseAssemblyDetail mapper 把 backend-rust `#[serde(flatten)]` 平铺形态转回
  // 前端嵌套契约。Zod parse 守门（assemblyDetailFlatSchema.strict）：后端意外
  // 把 assembly 改回嵌套键会立刻抛 ZodError。
  const resp = await api.get<unknown>(`/assemblies/${id}`);
  return parseAssemblyDetail(resp.data);
}

/** 按 part_id 反查所属装配体。
 *  2026-09-25 修正：与 backend-rust 新加的 `GET /api/v2/parts/{part_id}/assembly`
 *  端点对齐 —— 后端返 `Option<AssemblyDetail>`（无父装配体时返 null），前端
 *  返回类型由 `AssemblyDetail` 改为 `AssemblyDetail | null`，调用方按 `null`
 *  表示「无父装配体」分支。
 *  2026-09-29 修复：走 parseAssemblyDetail mapper（见 getAssembly 注释）。 */
export async function getAssemblyForPart(partId: string): Promise<AssemblyDetail | null> {
  const resp = await api.get<unknown>(`/parts/${partId}/assembly`);
  if (resp.data === null || resp.data === undefined) return null;
  return parseAssemblyDetail(resp.data);
}

export async function createAssembly(
  payload: AssemblyCreatePayload,
): Promise<AssemblyCreateResult> {
  const form = new FormData();
  form.append('data', JSON.stringify(payload));
  // 不传 file：创建空装配体；详情页再上传 PDF / 添加子件
  const resp = await api.post<AssemblyCreateResult>('/assemblies', form);
  return resp.data;
}

/** 一次性创建：上传总装 PDF + 子件一并生成。
 *
 *  2026-10-05：multipart 的文件字段名由 `file` 改为 `files`。后端 `POST /assemblies`
 *  的 multipart 解析只认 `files`；传 `file` **不报错**，文件被静默丢弃（建出一个没有
 *  总装图的装配件），所以这个字段名必须与后端一致。
 *
 *  当前全仓零调用点（装配件建单链路尚未接入 Tab 2），改动零风险。
 */
export async function createAssemblyWithFile(
  payload: AssemblyCreatePayload,
  pdfFile: File,
): Promise<AssemblyCreateResult> {
  const form = new FormData();
  form.append('data', JSON.stringify(payload));
  form.append('files', pdfFile);
  const resp = await api.post<AssemblyCreateResult>('/assemblies', form);
  return resp.data;
}

/** 详情页上传总装 PDF：拆页 → 自动创建子件。
 *  2026-09-25 修正：v2 后端把 upload-pdf 合并到 `/files` 端点（multipart, field=file），
 *  不再走 `/upload-pdf`。
 *  2026-09-29 review 第 1 轮 C2 修复：后端实际响应是 `R<Vec<AssemblyFileRef>>`
 *  （handler.rs:244-302），不是 `R<AssemblyDetail>`。旧实现走 parseAssemblyDetail
 *  把数组塞进 z.object → ZodError，上传功能全废。新实现返 AssemblyFileRef[]，
 *  call 方（useAssemblyDetail.uploadPdfFn）调 fetchData() 重拉详情用，
 *  files 列表是中间信号。 */
export async function uploadAssemblyPdf(id: string, file: File): Promise<AssemblyFileRefSchema[]> {
  const form = new FormData();
  form.append('file', file);
  const resp = await api.post<unknown>(`/assemblies/${id}/files`, form);
  return assemblyFileRefSchemaArray.parse(resp.data);
}

/** 详情页添加单个子件（无 PDF；如需 PDF 走 uploadPartFile）。
 *  2026-09-25 修正：与 backend-rust 新加的 `POST /api/v2/assemblies/{id}/children`
 *  端点对齐 —— 后端接收 `{ drawing_no, name, quantity }` 入参，返回 `PartListItem`。 */
export async function addAssemblyChild(
  id: string,
  payload: { drawing_no: string; name: string; quantity: number },
): Promise<PartListItem> {
  const resp = await api.post<PartListItem>(`/assemblies/${id}/children`, payload);
  return resp.data;
}

/** 2026-09-28 契约修复：软删入参 `{ "version": i32 }` 为 OCC 必填（backend-rust
 *  `assembly/dto.rs` / `service/crud.rs::soft_delete_assembly_inner`），此前本函数
 *  不发 body → 必 422。@param version `AssemblyItem.version`；不匹配 → 40901。 */
export async function softDeleteAssembly(id: string, version: number): Promise<void> {
  await api.post(`/assemblies/${id}/soft-delete`, { version });
}

/** 取消装配体（CLERK+）。级联取消所有非终态子件。
 *  2026-09-29 review 第 1 轮 C1 修复：后端实际响应是 `R<AssemblyOut>`（19 字段平铺，
 *  无 children/files），不是 `R<AssemblyDetail>`。旧实现走 parseAssemblyDetail
 *  必抛 ZodError。返 AssemblyItem（= AssemblyOut），child_count 由 caller 提供。 */
export async function cancelAssembly(id: string): Promise<AssemblyItem> {
  const resp = await api.post<unknown>(`/assemblies/${id}/cancel`);
  // 取消操作保留子件列表（不在响应里），child_count 由 composable 用现有 detail.children.length。
  return parseAssemblyOutToItem(resp.data, 0);
}

/** 编辑装配体元数据（MANAGER + CLERK；仅 PENDING 可编辑）。
 *  2026-09-29 review 第 1 轮 C1 修复：后端实际响应是 `R<AssemblyOut>`（19 字段平铺），
 *  不是 `R<AssemblyDetail>`。返 AssemblyItem，child_count 由 caller 提供。 */
export async function updateAssembly(
  id: string,
  payload: AssemblyUpdatePayload,
): Promise<AssemblyItem> {
  const resp = await api.post<unknown>(`/assemblies/${id}/update`, payload);
  return parseAssemblyOutToItem(resp.data, 0);
}

// ---- 文件相关 ----
// 2026-07-10 起：装配体文件由 create_assembly / upload_total_pdf 流创建，
// uploadPdf 在 2026-09-25 合入 GET /assemblies/{id}/files 端点（POST multipart）。
// list 仍可调用。

// 2026-09-16 Phase 5 切 v2 后：列表端点返回分页包装 { items, total }（PartFileListResult），
// v2 默认 limit=50 会静默截断，clamp 上限 500，统一按上限取全量。
// 2026-09-25 修正：与 backend-rust 新加的 `GET /api/v2/assemblies/{id}/files` 端点对齐。
export async function listAssemblyFiles(id: string): Promise<PartFileListResult> {
  const resp = await api.get<PartFileListResult>(`/assemblies/${id}/files`, {
    params: { limit: 500 },
  });
  return resp.data;
}

/**
 * 列出某 part 关联的所有文件。
 *
 * @deprecated 2026-09-16 T3.5：v2 后端无 `/parts/{id}/files` 端点；保留此函数作为
 * `listPartFilesByOwner` 的 deprecation alias，转发到 `/part-files?owner_id=...`。
 * 下游调用点已在 T3.5 一次切换到 listPartFilesByOwner；M3-C 完成时统一移除。
 * 2026-09-25 显式补 `@deprecated` JSDoc tag。
 */
export async function listPartFiles(
  partId: string,
  kind?: 'DRAWING' | '3D_MODEL' | 'G_CODE' | 'SETUP_SHEET' | 'ASSEMBLY_MASTER' | 'CAD_2D',
): Promise<PartFileListResult> {
  return listPartFilesByOwner(partId, kind);
}

/**
 * 2026-09-16 M3 新增：owner 维度列出文件（`GET /api/v2/part-files?owner_id=...&kind=...`）。
 *
 * 替代 `listPartFiles` 的 `/parts/{part_id}/files` 旧路径——v2 rust 后端已经
 *  把列表端点统一到 `/part-files`（按 owner_id 多态查询）。kind 缺省 = 不过滤。
 *
 *  与 `listPartFiles` 区别：
 *  - 路径：`/part-files?owner_id=...&kind=...`（owner 多态）
 *  - 参数：limit 上限 500（v2 默认 50 会静默截断）
 *
 *  旧函数保留为 deprecation alias，下游调用点改在 M3-C 一次到位。
 */
export async function listPartFilesByOwner(
  partId: string,
  kind?: 'DRAWING' | '3D_MODEL' | 'G_CODE' | 'SETUP_SHEET' | 'ASSEMBLY_MASTER' | 'CAD_2D',
): Promise<PartFileListResult> {
  const resp = await api.get<PartFileListResult>('/part-files', {
    params: kind ? { owner_id: partId, kind, limit: 500 } : { owner_id: partId, limit: 500 },
  });
  return resp.data;
}

// 2026-09-25 清理：uploadPartDrawing / uploadPart3DModel / uploadPartCadFile
// 已迁回 `@/api/parts/file.ts`（更符合子域归属）；本文件不再 re-export。

/**
 * @deprecated 2026-09-16 T3.5：合并到 `deletePartFile(fileId, version)`。
 * 保留为 alias 以兼容未迁移 import；新代码请用具名导出。
 */
export { deletePartFile as deleteFile } from '@/api/parts/file';

/**
 * @deprecated 2026-09-16 T3.5：合并到 `getPartFileDownloadUrl(fileId)`。
 * 保留为 alias 以兼容未迁移 import；新代码请用具名导出。
 */
export { getPartFileDownloadUrl as getDownloadUrl } from '@/api/parts/file';

/** 类型守卫 */
export function isAssemblyItem(v: unknown): v is AssemblyItem {
  return !!v && typeof v === 'object' && 'drawing_no' in v && 'child_count' in v;
}
