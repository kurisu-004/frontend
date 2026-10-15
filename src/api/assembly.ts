// 装配体 REST API（走 @/api/http 统一 axios 客户端）。
// 本文件只实现 `/assemblies/*` 与 `/prod/assemblies/*`；文件对象域的 6 条
// `/files/objects/*` 端点实现在 `@/api/files/objects`，这里只保留 `getDownloadUrl`
// 这一个 deprecation alias。
//
// 2026-10-15：删掉 `uploadAssemblyPdf`（它只是转调 multipart 代理上传的薄封装）。
// 总装图上传改走直传引擎 `utils/directUpload.ts`（owner=ASSEMBLY +
// kind=ASSEMBLY_MASTER），调用点在 `views/assemblies/composables/useAssemblyDetail.ts` ——
// 端点与 kind 都没变，只是传输从「后端代理」变成「浏览器直传对象存储」。

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
import type { DrawingFileItem } from '@/types/part_file';
import type { PartListItem } from '@/types/parts';

/**
 * 2026-09-29 修复：消化 backend-rust `AssemblyDetail` 的 `#[serde(flatten)]` quirk。
 *
 * 后端 wire 形态（backend-rust src/modules/assembly/vo/assembly.rs 的 `AssemblyDetail`）：
 *   { ...AssemblyOut 20 字段, children: [...], files: [...] }
 *   —— 无 `assembly` 嵌套键，AssemblyOut 20 字段被 `#[serde(flatten)]` 平铺到顶层。
 *
 * 前端类型契约保持嵌套 `{assembly, children, files}`（最小爆炸半径），
 * 本函数在 api 边界把平铺转回嵌套 + 字段对齐：
 *   - child_count 由 mapper 注入 = flat.children.length
 *   - customer_name / parent_customer_name 暂置 null（只含客户行本身与根客户名，
 *     需要整条客户列表才能算），由 useAssemblyDetail composable 在 fetchData 后用
 *     useCustomersQuery 派生补全；`customer_path` **后端已下发**（`AssemblyOut`
 *     的第 20 个字段），mapper 直接透传，不再由本地算
 *   - unit_price / total_price nullable 走 null 兜底（review 第 1 轮 m1/m5）：
 *     旧实现用 '0' 伪装 number 与 PartListItem string 桥接的过渡形态；
 *     实际语义「后端未落库」应该是 null，UI 端用 — 占位（el-descriptions 自动处理）。
 *
 * 守门走 Zod parse（assemblyDetailFlatSchema.strict）：后端意外增删字段（多一个键
 * 触发 `unrecognized_keys`、少一个键触发 `required`）立刻抛 ZodError，避免静默 fail。
 */
export function parseAssemblyDetail(raw: unknown): AssemblyDetail {
  const flat: AssemblyDetailFlatSchema = assemblyDetailFlatSchema.parse(raw);
  return {
    assembly: parseAssemblyOutToItemCore(flat, flat.children.length),
    children: flat.children.map(childToAssemblyChildItem),
    files: flat.files.map(fileToDrawingFileItem),
  };
}

/** 2026-09-29 review 第 1 轮 C1 修复：把后端 AssemblyOut 20 字段（write 接口响应 /
 * list 接口 item）转成前端 AssemblyItem。
 *
 * 后端实际响应形态（已核对 backend-rust/src/modules/assembly/handler.rs 的写端点）：
 *   - POST /api/v2/assemblies/{id}/update → R<AssemblyOut>
 *   - POST /api/v2/assemblies/{id}/cancel → R<AssemblyOut>
 *   - GET /api/v2/assemblies → AssemblyListItem（= AssemblyOut 平铺 + 两个客户名字段）
 *
 * 字段对齐：
 *   - child_count 派生：write 接口不返 children → 用 caller 传的 count（list 调用传
 *     children.length，update / cancel 调用传 0，由 composable 后续 mutate 校正）
 *   - customer_name / parent_customer_name 两个后端**不返**的字段置 null，由
 *     useAssemblyDetail composable 在 fetchData / 写操作成功后用 useCustomersQuery
 *     派生补全（enrichAssemblyCustomer）；`customer_path` 是后端下发的必填键，
 *     这里直接透传（见下方 `enrichAssemblyItem` 的取值优先级）
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
    // 后端下发的必填键（第 20 字段）：直接透传。空串是合法值（客户已软删 / 父链成环），
    // enrichAssemblyItem 用 `||` 把它兜成本地算出的路径。
    customer_path: flat.customer_path,
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
 * 语义：
 * - customers 中按 item.customer_id 找匹配客户：
 *   - 找到 → customer_name = name, parent_customer_name = 客户行的 parent_name
 *     （⚠️ 无限层级后该字段的**语义**由后端改成「根 L1 名」，见 `types/assembly.ts`；
 *     本函数仍按客户行自身的直接父名填，装配件 VO 不返根名，需要时由调用方换源）,
 *     customer_path = 后端 VO 的值优先，其次本地 customers 算出的路径
 *   - 找不到 → **两个名字字段**置 null，`customer_path` 原样保留（见下面那一节）
 *
 * 2026-10-17 客户无限层级：`customer_path` 改成「**优先取后端 VO 的值，其次用本地
 * customers 列表里那份 `Customer.customer_path` 算**」。后端 `AssemblyOut` 已把这个
 * 列为必填键（`vo/assembly.rs` 的第 20 个字段，详情 / 建单回读 / 更新 / 取消 /
 * start / force-complete 六个调用点都填），mapper 已在 `parseAssemblyOutToItemCore`
 * 里透传 ⇒ 本地分支只兜两种场景：**客户列表还没到达**（`useCustomersQuery` 未 settle
 * 时 `customers = []`，此时两条本地字段名算不出来）与**客户已软删**（本地列表查不到
 * 这一行，后端却仍带着路径）。
 *
 * ⚠️ 由此推出一条容易被忽略的事实：查不到客户的那一支**只覆盖两个名字字段、不碰
 * `customer_path`** —— 早期实现在这里把三个字段一起置 null，于是 `await getAssembly()`
 * 之后立刻 enrich 的首帧（customers 还没回来）会把后端下发的那条必填路径抹成 null，
 * 靠 `watchEffect` 二次补回来；客户软删时那一列就永久为 null。现在 not-found 分支保留
 * mapper 透传下来的 `customer_path`，首帧即完整。
 *
 * ⚠️ **部署顺序：后端必须先上** —— 旧版本不返 `customer_path` ⇒
 * `assemblyOutSchema` / `assemblyDetailFlatSchema` 的 `required` 抛 ZodError，
 * 装配件详情页 / PartAssemblyLinkCard 空白（不是降级，是白屏）。
 *
 * 为什么用 `customer.customer_path` 而不是自己拼：客户已是任意深度（集团 / 分厂 / 车间 /
 * 班组…），「父 / 子」拼法必然缺层（第 3 层往下的中间节点整片消失）。拼接的真源在后端
 * （`Customer.customer_path` 是本仓已在用的必填字段，见 `api/customer.ts`）。
 *
 * 纯函数：返回新对象，不 mutate 输入；调用方负责把返回值赋回
 * `detail.assembly` / `assemblyDetail.assembly`。
 *
 * customers 接受空数组（useCustomersQuery 缓存未到达时），找不到客户时**两个名字字段**
 * 置 null（与上游 mapper 默认值一致），`customer_path` 保留后端下发的值 —— 见文件头
 * 那一节的「首帧」说明。
 */
export function enrichAssemblyItem(item: AssemblyItem, customers: Customer[]): AssemblyItem {
  const customer = customers.find((c) => c.id === item.customer_id);
  if (!customer) {
    return {
      ...item,
      customer_name: null,
      parent_customer_name: null,
      // `customer_path` **原样保留** mapper 透传下来的后端值（见文件头那一节）：这条分支
      // 在首帧（customers 未到达）与「客户已软删」两种场景都会命中，把必填路径抹成 null
      // 等于让展示层退回单段名且当场查不出原因。
    };
  }
  return {
    ...item,
    customer_name: customer.name,
    parent_customer_name: customer.parent_name,
    // `||` 而不是 `??`：要兜后端该列落**空串**的情形（客户软删 / 父链成环）—— 那一行
    // 用本地 customers 算出的串仍是一条完整可读路径，比显示空白好。与三个批次卡片适配层
    // 及 utils/elTableCell.ts 的规则 1 同口径。
    customer_path: item.customer_path || customer.customer_path,
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
 * 不传文件字段：总装图走直传链路单独上传（`utils/directUpload.ts`，owner=ASSEMBLY +
 * kind=ASSEMBLY_MASTER）。
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
// + 建单后补总装图这条两段式；2026-10-13 rg 复核**仍为零调用方**
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

// 2026-10-15：删除 `uploadAssemblyPdf`（multipart 代理上传下线后它失去存在意义）。
// 装配件总装图改走直传引擎 `utils/directUpload.ts`（owner=ASSEMBLY +
// kind=ASSEMBLY_MASTER），调用点 `views/assemblies/composables/useAssemblyDetail.ts`
// 的一行 `directUpload({...})` 就够了，不值得再包一层只做参数转发的薄函数。

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

// 2026-10-13：删除 `listAssemblyFiles`。
// 理由：它打的 `GET /api/v2/assemblies/{id}/files` 已随 files 域端点收编下线（后端
// assembly router 整段移除该路由、无 alias），留着就是一个「以为还能用、实际必 404」
// 且 export 在公共聚合口上的陷阱；rg 核实零调用方（`useAssemblyDetail` 的 `files[]`
// 来自 `GET /assemblies/{id}` 详情响应，不打这个端点）。

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
