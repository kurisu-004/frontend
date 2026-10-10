// 装配体 REST API（走 @/api/http 统一 axios 客户端）。
// 本文件只实现 `/assemblies/*` 与 `/prod/assemblies/*`；文件对象域的 6 条
// `/files/objects/*` 端点实现在 `@/api/files/objects`，这里仅有两个装配件语义上的
// 薄封装（`uploadAssemblyPdf` 转 `uploadFileObject`、`getDownloadUrl` 的 deprecation
// alias）。

import { api, cleanParams } from '@/api/http';
import {
  assemblyCreateResultSchema,
  assemblyDetailFlatSchema,
  assemblyOutSchema,
  type AssemblyChildOutSchema,
  type AssemblyDetailFlatSchema,
  type AssemblyFileRefSchema,
  type AssemblyOutSchema,
} from '@/composables/queries/schemas';
import { uploadFileObject } from '@/api/files/objects';
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
import type { DrawingFileItem, PartFileItem, PartFileListResult } from '@/types/part_file';
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

/**
 * 建装配件（树形端点，`POST /api/v2/assemblies`）：一次请求建出 `t_assembly` 顶层 +
 * 全部 `t_part` 子件（子件的 `assembly_id` 指向顶层）。
 *
 * 2026-10-05：响应走 `assemblyCreateResultSchema.parse` 守门（此前只做类型断言）。
 * 消费方（`usePartBatchPdf` 的建单记账）把 `created_children[i]` 按下标对回本地子件行，
 * 响应形状不对时若无守门，会在**零报错**的情况下把子件图纸挂到错误的行上。
 *
 * 不传文件字段：总装图走 `POST /api/v2/files/objects`（`uploadAssemblyPdf`）单独上传。
 * 2026-10-05 起该端点无条件派装配件序列号、无条件建子件，不传 PDF 也能建出完整装配件。
 */
export async function createAssembly(
  payload: AssemblyCreatePayload,
): Promise<AssemblyCreateResult> {
  const form = new FormData();
  form.append('data', JSON.stringify(payload));
  const resp = await api.post<unknown>('/assemblies', form);
  return assemblyCreateResultSchema.parse(resp.data);
}

// 2026-10-13：删除 `createAssemblyWithFile`。
// 理由：2026-10-05 起即标注「零调用点」，零件批量建单走 `createAssembly`（不传 PDF）
// + `uploadAssemblyPdf` 补总装图这条两段式；2026-10-13 rg 复核**仍为零调用方**
// （唯一的名字提及只在 `types/assembly.ts` 的一句注释里，本轮一并清掉）。且它与
// `createAssembly` 打同一个 `POST /assemblies`，差别只在 multipart 字段名（`files`
// vs 不传）—— 留着等于给「静默丢弃文件」那条 2026-10-05 陷阱留一个后门。
//
// 2026-10-13：删除 `listPartFiles` 与 `deleteFile` alias。
// 理由：两者 rg 核实均为**零调用方**。`listPartFiles` 早在 2026-09-16 T3.5 就被
// `listPartFilesByOwner` 取代并标注 `@deprecated`（其自述「M3-C 完成时统一移除」
// 至今未执行，本 PR 一并结清）；`deleteFile` alias 自 2026-09-16 T3.5 起就只是
// 「兼容未迁移 import」而留，rg 核实全仓已无任何 import 方，兼容期早已结束。
// `getDownloadUrl` alias 反之**仍有活调用方**，见下方。

/** 装配件总装图上传（`POST /api/v2/files/objects`，multipart field=`file`，只收 PDF）。
 *
 * 端点是**纯文件入库** —— COS PUT + `INSERT t_part_file`（`owner_kind='ASSEMBLY'`、
 * `kind='ASSEMBLY_MASTER'`），**不拆页、不建子件**。装配件的子件由 `POST /assemblies`
 * 建单时按 `children` 入参一并建出。
 *
 * 2026-10-13：随文件对象域端点合并，本函数改为包 `uploadFileObject`（零件图纸 /
 * 3D 模型 / 装配件总装图同端点，差别只在 owner + kind 两个字段）。响应随之由
 * `AssemblyFileRef[]`（`{id, original_filename, page_count}`）变为**单个
 * `PartFileItem`**（18 字段）：`page_count` 键消失，但上传路径本就恒为 `null`，
 * 无信息损失。
 *
 * 保持 `uploadAssemblyPdf` 这个名字：调用方（装配件详情页补传总装图、零件批量建单
 * 的总装图补传）都是「上传一份总装图」这一个动作，端点合并不改变它们的意图。 */
export async function uploadAssemblyPdf(id: string, file: File): Promise<PartFileItem> {
  return uploadFileObject('ASSEMBLY', id, 'ASSEMBLY_MASTER', file);
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

/**
 * 2026-10-11 新增：装配件「强制完成」—— 系统管理员绕过状态机，把该装配件及其
 * 所有非取消批次置为 COMPLETED（零件对应 `forceCompletePart`）。
 *
 * 端点是 `POST /api/v2/prod/assemblies/{id}/force-complete`，**带 `prod` 前缀**：
 * 后端只把这条写端点挂在 prod 命名空间下，本文件其余装配件端点仍在
 * `/api/v2/assemblies/*`。用 `/assemblies/{id}/force-complete` 会 404。
 *
 * `id` 一律按 string 处理（雪花 ID 超过 `Number.MAX_SAFE_INTEGER`，URL 拼接
 * 严禁经 `Number()`）。响应体不消费 ⇒ 返 `void`，不对未知的出参形状做类型声明。
 *
 * ⚠️ **部署顺序：后端必须先上。** 零件一览的「完成」按钮对装配件行可见，而按钮
 * 的守卫只看角色与行状态、不看端点是否存在 ⇒ 后端未部署本端点时，MANAGER 点
 * 装配件行的「完成」就是一次 404（零件行不受影响，它打的是既有端点）。失败发生在
 * 网络层：现场只看到一句 axios 错误，用户视角是「点了没反应」，不会退回去查部署。
 */
export async function forceCompleteAssembly(id: string, payload?: { note?: string | null }) {
  await api.post(`/prod/assemblies/${id}/force-complete`, payload ?? {});
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

// 装配件文件列表（`GET /assemblies/{id}/files`）。
// 2026-09-16 Phase 5 切 v2 后：返回分页包装 { items, total }（PartFileListResult），
// v2 默认 limit=50 会静默截断，clamp 上限 500，统一按上限取全量。
// ⚠️ 2026-10-13 登记：rg 核实**零调用方**；owner 维度列表已由
// `listPartFilesByOwner`（`@/api/files/objects`，打
// `GET /files/objects?owner_kind=ASSEMBLY&owner_id=X`）承担，本函数等后端下线该端点
// 后删除。
export async function listAssemblyFiles(id: string): Promise<PartFileListResult> {
  const resp = await api.get<PartFileListResult>(`/assemblies/${id}/files`, {
    params: { limit: 500 },
  });
  return resp.data;
}

/**
 * `getPartFileDownloadUrl` 的 deprecation alias。
 *
 * @deprecated 2026-09-16 T3.5：合并到 `getPartFileDownloadUrl(fileId)`。
 * 保留为 alias 以兼容未迁移 import；新代码请用具名导出。
 *
 * ⚠️ **仍有一个活调用方**：`views/production/scan/components/PartDrawingPreviewDialog.vue`
 * （报工台图纸预览的下载按钮）。2026-10-13 清理时 rg 核实过，**不可删** ——
 * 相比之下同批的 `deleteFile` alias（0 调用方）已随之删除。
 */
export { getPartFileDownloadUrl as getDownloadUrl } from '@/api/files/objects';

/** 类型守卫 */
export function isAssemblyItem(v: unknown): v is AssemblyItem {
  return !!v && typeof v === 'object' && 'drawing_no' in v && 'child_count' in v;
}
