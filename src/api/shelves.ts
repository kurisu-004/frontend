// 货架 API（走 @/api/http 统一 axios 客户端）。
//
// 2026-10-02 新增：货架↔工序映射 3 个端点已迁 prod 域，本文件的「为什么它们还在这」
//
//   后端把 `t_shelf_process` 从 `src/modules/shelf/process_mapping/` 搬到
//   `src/modules/prod/shelf_process/`（新模块），3 个端点 URL **硬切**到
//   `/api/v2/prod/shelf-processes/*`（**无 alias**，旧路由已从
//   `src/modules/shelf/handler.rs` 彻底删除）：
//     GET  /shelves/processes        → GET  /prod/shelf-processes
//     GET  /shelves/{id}/processes   → GET  /prod/shelf-processes/{shelf_id}
//     POST /shelves/{id}/processes   → POST /prod/shelf-processes/{shelf_id}
//   映射端点的请求 / 响应契约**逐字不变**，所以本次只改 URL 字符串前缀。
//
//   这 3 个函数（`getAllShelfProcessMappings` / `getShelfProcesses` /
//   `setShelfProcesses`）**刻意留在本文件**、不新建 `api/prod/` 子目录：本仓
//   `src/api/` 的组织约定是**按前端实体扁平放置**，不按后端模块分层。反证有两组：
//   ① `/prod` 命名空间已被**6 个扁平文件**瓜分（`process.ts` / `worker.ts` /
//      `workType.ts` / `productionQueue.ts` / `processChain.ts` / `programming.ts`）。
//      其中 `programming.ts` → `/prod/programming/pending` 与本文件的
//      `/prod/shelf-processes` **完全同构**（文件名 ≠ URL 段）—— 可见
//      「文件名 = URL 段」在本仓**从来不是**规则。建 `api/prod/` 只会把 1 个资源
//      塞进第 7 处，或引发搬这 6 个文件的巨量 diff。
//   ② 现有 3 个子目录 `com/` / `files/` / `parts/` 则**全部镜像独占 URL 命名
//      空间**（`com/unionList.ts` → `/com/union-list`、`files/sts.ts` →
//      `/files/sts-tmp-keys`、`parts/*` → `/parts/*`）。注意 `files/` 只有 1 个文件、
//      1 条端点路径，它成目录**不是因为端点多**；只有 `parts/`（`/parts/*` 端点数
//      确实多到拆出 4 个实现文件 batch / bid / crud / file）才适用「端点多到需拆
//      文件」。**没有** `prod/` 目录。
//
//   ⚠️ 旧路径现在的行为（改动理由，也是「不能留兼容层」的依据）：
//     - `GET /shelves/processes` → **400，且响应体不是 `R` 信封**。它现在落到
//       shelf 域的 `/{id}` 路由上，`processes` 解析不成 i64 被 axum 的
//       `Path<i64>` 拒掉，返回纯文本 → 走 `@/api/http` 的统一信封错误解析会抛
//       解析异常而不是给出可展示的业务码。
//     - `GET|POST /shelves/{id}/processes` → **404**（写路径 404 = 保存功能全废）。
//   两条都不能静默兼容：保留旧调用只会把「后端 404 / 400 裸文本」原样带到用户面前。

import { api, cleanParams } from '@/api/http';
import type {
  AllShelfProcessMappingItem,
  Shelf,
  ShelfForInspectionResult,
  ShelfForReturnResult,
  ShelfListResult,
  ShelfProcessesResult,
  SetShelfProcessesPayload,
} from '@/types/shelf';

export interface ListShelvesParams {
  zone?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}

export async function listShelves(params: ListShelvesParams = {}): Promise<ShelfListResult> {
  const resp = await api.get<ShelfListResult>('/shelves', {
    params: cleanParams(params),
  });
  return resp.data;
}

export interface CreateShelfPayload {
  code: string;
  name: string;
  zone: string;
  location?: string;
  display_order?: number;
  /** 2026-10-10：负载上限（件数）。`null` / 省略 = 不限。 */
  capacity?: number | null;
}

export async function createShelf(payload: CreateShelfPayload): Promise<Shelf> {
  const resp = await api.post<Shelf>('/shelves', payload);
  return resp.data;
}

export interface UpdateShelfPayload {
  name?: string;
  location?: string;
  is_active?: boolean;
  display_order?: number;
  /** 2026-10-10：负载上限（件数）。**三态**：字段不传 = 不改、传 `null` = 清空
   *  （回到不限）。别用「传 undefined」表达清空 —— 那与「不传」在 JSON 序列化后不可分。 */
  capacity?: number | null;
}

export async function updateShelf(id: string, payload: UpdateShelfPayload): Promise<Shelf> {
  const resp = await api.post<Shelf>(`/shelves/${id}/update`, payload);
  return resp.data;
}

export async function deactivateShelf(id: string): Promise<Shelf> {
  const resp = await api.post<Shelf>(`/shelves/${id}/deactivate`);
  return resp.data;
}

/**
 * 读取单架已映射工序。
 *
 * 后端 v2 返 `{items: [{shelf_id, shelf_code, process_id, process_code,
 * sort_order}]}`（契约见 `docs/api/production/shelf-process-mapping.md` 的
 * 「单架端点」一节 + `src/modules/prod/shelf_process/` 的 dto / vo）——
 * **不是** v1(Python) 的 `ShelfWithProcesses {..., processes: [...]}`，消费侧
 * `sp.processes` 恒 undefined。
 * 全集端点（`getAllShelfProcessMappings`）是**另一个** VO：4 字段、**明确不含**
 * `sort_order`，所以本函数的响应类型与它不能共用。
 *
 * 2026-10-02 域拆分：URL 从 `/shelves/{id}/processes` 硬切到
 * `/prod/shelf-processes/{shelf_id}`（旧路径 404），响应契约逐字不变。
 */
export async function getShelfProcesses(id: string): Promise<ShelfProcessesResult> {
  const resp = await api.get<ShelfProcessesResult>(`/prod/shelf-processes/${id}`);
  return resp.data;
}

/**
 * 2026-10-02 修：把「下拉多选 id 列表」编成后端 `SetShelfProcessesRequest` 的
 * `items` 数组。
 *
 * 抽成纯函数而不是内联在 ShelfList.vue 里，是因为 BUG-1 的本质就是「调用方编错了
 * 请求形态」—— 类型系统挡不住对象字面量的 key 名拼错（`{process_ids}` 恰好满足
 * 旧的 `SetShelfProcessesPayload`）。把这个映射收口到一处 + 本文件单测逐字断言，
 * 调用方就再也编不出 v1 形态。
 *
 * sort_order 取数组下标：沿 v1(Python) 契约「提交顺序即 sort_order」的语义 —— 前端
 * 没有独立的拖拽排序入口，el-select 多选的选中顺序就是业务上的工序顺序。
 *
 * 2026-10-02 review M-3 新增去重：后端 `t_shelf_process` 上有 partial unique index
 * `uk_t_shelf_process (shelf_id, process_id) WHERE deleted_at IS NULL`
 * （backend-rust migrations/20260925000000_001_baseline.sql:3545），`items` 里
 * 一旦出现重复 process_id，`bulk_insert` 就撞唯一索引 → HTTP 500（不是 40001，
 * 是没人能自解释的 500）。
 * 今天不可达（`el-select multiple` 产不出重复值），但本函数的立身之本是
 * 「收口 payload 形态」——将来若改成「已有映射 + 新增勾选」合并提交，重复就会
 * 真实发生。保留首次出现，`sort_order` 按**去重后**的下标重算（沿用原下标会
 * 留下空洞，语义上不再是 0..n-1 的连续顺序）。
 */
export function toShelfProcessesPayload(processIds: readonly string[]): SetShelfProcessesPayload {
  const unique = [...new Set(processIds)];
  return { items: unique.map((process_id, idx) => ({ process_id, sort_order: idx })) };
}

/**
 * 2026-10-02 修：把 `GET /prod/shelf-processes/{shelf_id}` 的响应还原成下拉多选
 * id 列表。
 *
 * 抽成纯函数同 toShelfProcessesPayload 的动机：BUG-2 的本质是「调用方读错响应
 * 形态」（旧代码 `sp.processes.map(...)` —— 后端返 `{items:[...]}`，`processes`
 * 恒 undefined → TypeError → 被裸 catch 吞掉 → 每次打开编辑弹窗已选工序被清空，
 * 用户不察觉点保存就静默清空整组映射）。收口 + 单测后读形态不可能再漂。
 *
 * 排序：后端单架端点已按 `ORDER BY sp.sort_order ASC, sp.id ASC` 返回，这里再
 * 显式排一次。2026-10-02 review M-1：`sort_order` 是**必填**（类型已收紧），原
 * 先的 `?? 0` 兜底是在给「后端可能不返」这个假设擦屁股，代价是把契约漂移静默
 * 吞掉。sort_order 重复时靠 `Array.prototype.sort` 的稳定性（ES2019 起规范保证）
 * 保住后端给的 id ASC 次序，仍然稳定。
 */
export function toShelfProcessIds(result: ShelfProcessesResult): string[] {
  return [...result.items].sort((a, b) => a.sort_order - b.sort_order).map((p) => p.process_id);
}

/**
 * 2026-10-02 修：整组替换单架的工序映射（items 可为 [] = 清空）。
 *
 * - 请求体：必须是 `{items: [{process_id, sort_order}]}`。旧实现发
 *   `{process_ids: string[]}`，后端 `SetShelfProcessesRequest.items` 必填且无
 *   `#[serde(default)]` → serde missing field → 40001 VALIDATION_ERROR →
 *   HTTP 422（用户 2026-10-02 报的就是这个；该功能自 v1 迁 v2 起从未成功过）。
 * - 响应：`data` 为 null（整组替换无回显），故返回 Promise<void>，不再谎称
 *   返回 ShelfWithProcesses。
 * - 2026-10-02 域拆分：URL 从 `/shelves/{id}/processes` 硬切到
 *   `/prod/shelf-processes/{shelf_id}`（旧写路径 404），请求体契约逐字不变。
 */
export async function setShelfProcesses(
  id: string,
  payload: SetShelfProcessesPayload,
): Promise<void> {
  await api.post(`/prod/shelf-processes/${id}`, payload);
}

/**
 * 共享 HMI RETURN 卡片网格 picker 数据源。
 * 后端 `GET /shelves/for-return?next_process_id=...`
 * 返回候选架列表（按 current_load 升序，同 load 时按 display_order ASC, id ASC）；
 * 「推荐架」不是独立字段，而是每条 item 上的 `is_recommended`（load 最小那条为 true）。
 *
 * 错误面（2026-10-02 回后端逐条核实）：本端点对 `next_process_id` 的任何取值都返 200，
 * **不会**抛 20506 BIZ_SHELF_NO_MATCH_FOR_PROCESS —— 后端已从 `list_for_return` 删掉
 * `next_process_id` 的存在性校验（那个校验的码是 20104 / 20801）。唯一错误是 40300
 * FORBIDDEN（角色不在 Manager / Clerk / ShelfAccount / CncProgrammer 之内）。没有候选架时
 * 返 200 + `items: []`，不是错误。「货架是否映射了该 process」的语义由 worker-scan 后端
 * 强校验（20507 BIZ_SHELF_PROCESS_NOT_MAPPED）承担，不由本 picker 端点负责。
 */
export async function listShelvesForReturn(nextProcessId: string): Promise<ShelfForReturnResult> {
  const resp = await api.get<ShelfForReturnResult>('/shelves/for-return', {
    params: { next_process_id: nextProcessId },
  });
  return resp.data;
}

/**
 * 共享 HMI INSPECT 卡片网格 picker 数据源。
 * 后端 `GET /shelves/for-inspection` 返回 `zone='INSPECTION' AND is_active=true`
 * 的货架列表，**不过滤 SHELF_ACCOUNT scope**（品检架全员可见，见
 * `docs/api/shelves.md` 的 for-inspection 一节）。
 *
 * 三条要点（2026-10-02 逐条回后端核实）：
 *
 * 1. **排序**：本端点不做任何 load 维度排序 —— service 层
 *    `ShelfService::list_for_inspection` 复用 `list_with_filters` 且固定带
 *    `ORDER BY display_order ASC, id ASC`，即「物理顺序 + id 兜底」。推论：品检架
 *    **不保证**「最空的排最前」，前端不能依赖列表序做任何业务判断。
 * 2. **推荐架**：`ShelfForInspectionItem` 没有 `is_recommended` 字段，也没有
 *    `recommended_shelf_id`。本端点**不存在**任何推荐语义（推荐标记只属于
 *    for-return VO）。
 * 3. **错误码**：本端点**唯一**的错误是 `require_any_role` 失败 → 40300 FORBIDDEN
 *    （允许角色 5 个：Manager / Clerk / CncProgrammer / ShelfAccount / Inspector，
 *    比 for-return 多一个 Inspector——品检员自己要用它）。
 *    **没有品检架时返 200 + `items: []`，不是错误。**
 *
 * 返回类型是 `ShelfForInspectionResult`（独立类型，不是 for-return 那份 —— 两个后端
 * VO 不同，见 `@/types/shelf.ts` 的对照表）。品检架的 `current_load` 后端**计划**补
 * 聚合、当前 VO 仍无该字段，故声明为可选：老后端上跑时消费侧（`ShelfPickerDialog` →
 * `HmiPickerCard`）缺省就不渲染「在架 N 件」。
 */
export async function listShelvesForInspection(): Promise<ShelfForInspectionResult> {
  const resp = await api.get<ShelfForInspectionResult>('/shelves/for-inspection');
  return resp.data;
}

/**
 * 2026-07-17 新增：批量取所有 active 货架的工序映射。
 * 后端 `GET /prod/shelf-processes`（2026-10-02 域拆分硬切，原
 * `GET /shelves/processes` —— 旧路径现在是 400 裸文本非 `R` 信封，见文件头）
 *
 * 2026-10-02 订正：旧注释写的 `{items: [{shelf_id, process_ids}, ...]}`
 * （一架子集一个元素）是 **v1(Python) 形态**，v2 后端返的是**扁平行**——一行一个
 * (货架, 工序) 对，同一 shelf_id 会出现多行：`{items: [{shelf_id, shelf_code,
 * process_id, process_code}]}`（AllShelfProcessMappingItem —— 已在本文件导出成
 * `@/types/shelf::AllShelfProcessMappingItem`，注意它**不返** sort_order，排序由
 * service 层 ORDER BY 保证）。空映射的货架不出现在 items 中。
 *
 * 消费侧 `useShelfProcessFilter` 必须按 shelf_id regroup 扁平行，不能读
 * `item.process_ids`（恒 undefined ⇒ 空集 ⇒ 8 个页面的下拉被静默清空）。
 *
 * 给 `useShelfProcessFilter` composable 一次性消费，避免弹窗打开时
 * N+1 次 `GET /prod/shelf-processes/{shelf_id}` 调用。
 */
export interface ShelfProcessMappingsResult {
  items: AllShelfProcessMappingItem[];
}
export async function getAllShelfProcessMappings(): Promise<ShelfProcessMappingsResult> {
  const resp = await api.get<ShelfProcessMappingsResult>('/prod/shelf-processes');
  return resp.data;
}
