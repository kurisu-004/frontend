// 2026-08-26 新增：工人队列看板跨组件拖拽的"源信息"传递（vuedraggable @start → @add）。
//
// 机制：vuedraggable 在 @add 时只能拿到 evt.item（被拖元素 DOM 节点）和
// evt.from（源容器 DOM 节点），但拿不到"这张卡片原本属于哪个 process / worker"。
// 折中：@start 时（DOM dataset 还完整）把源信息写到模块级 Map；@add 时读 + delete。
//
// 模块级单例：WorkerColumn 与 PoolDrawer 共用同一份 Map。
// 用前缀隔离两类条目（同 batchId 不会冲突）：
//   - 裸 batchId     → 候选池源（recordPoolSource / consumePoolSource）
//   - 'w:' + batchId → 工人持有源（recordWorkerSource / consumeWorkerSource）
//
// 2026-08-27：把 vue-draggable-plus Sortable.js 原生事件子集（onStart/onAdd 共有：
// item + from）抽成本接口，WorkerColumn / PoolDrawer 共用，避免重复声明。
//
// 2026-09-30：候选池源信息从「单值 processId」升级为 `{ processId, shelfId }`
// 对象（`PoolDragSource`）。原因：后端把 `admin/worker-pool/assign` 合并进了通用
// 移动端点 `POST /prod/pool/move`，其 `from` 必须与 batch 实际位置严格一致 ——
// `from.kind=POOL` 时 `shelf_id` 必须等于 `batch.current_holder_id`，否则返
// 20122 BIZ_BATCH_LOCATION_MISMATCH（HTTP 409）。而 `GET /prod/pool/{process_id}`
// 是**跨所有货架**返回候选批次的，batch 所在货架未必等于用户当前激活货架
// （auth.activeShelfId），所以必须在 @start 时把卡片自带的 `data-shelf-id` 一起记下。

/** vue-draggable-plus onStart / onAdd 事件最小子集（Sortable.js 原生）。
 *  拿不到 Vue 包装层；@add 事件需要 evt.item.dataset.batchId 反查源。 */
export interface DraggableStartEvent {
  item: HTMLElement;
  from: HTMLElement;
}

/** 2026-09-30 新增：候选池拖拽源信息（recordPoolSource / consumePoolSource 的载荷）。
 *
 *  - `processId`：源工序 ID（= PoolDrawer 容器的 `data-process-id`）。仅用于
 *    失效缓存 / 日志定位等前端侧用途；`POST /prod/pool/move` 的入参**不含**
 *    process_id（service 从 `batch.current_process_step.process_id` 自推）。
 *  - `shelfId`：batch **真实所在货架**（卡片 `data-shelf-id`）。这是 move 请求
 *    `from.shelf_id` 的唯一正确来源。空串表示该卡片没有货架位置（held 侧），
 *    此时 move 走 `WORKER` 分支而非 `POOL` 分支。 */
export interface PoolDragSource {
  processId: string;
  shelfId: string;
}

const sources = new Map<string, string>();
const poolSources = new Map<string, PoolDragSource>();

/** 2026-09-30：记录卡片从某工序候选池拖出（WorkerColumn 接收端使用）。
 *  `shelfId` 取卡片自身的 `data-shelf-id`（batch 真实所在货架）。 */
export function recordPoolSource(batchId: string, source: PoolDragSource): void {
  poolSources.set(batchId, source);
}

/** 2026-09-30：读 + 删：卡片从某工序候选池拖出。WorkerColumn 在 @add 时调用。
 *  返回 undefined 表示不是候选池来源（调用方应直接 return，不发 move 请求）。 */
export function consumePoolSource(batchId: string): PoolDragSource | undefined {
  const v = poolSources.get(batchId);
  poolSources.delete(batchId);
  return v;
}

/** 记录卡片从某 worker 列拖出。落点可能是工序池（撤回批次）也可能是另一个工人列
 *  （转交批次），两者消费同一个工人源条目、各取其一（Sortable 的 onAdd 只在落点
 *  容器触发，源列拿不到事件；两张 Map 又按 `w:` 前缀与裸 batchId 隔离，不存在互抢）。 */
export function recordWorkerSource(batchId: string, fromWorkerId: string): void {
  sources.set(`w:${batchId}`, fromWorkerId);
}

/** 读 + 删：卡片从某 worker 列拖出。消费方两处 —— PoolDrawer（@add 撤回候选池）
 *  与 WorkerColumn（@add 转交给另一名工人），各取其一。 */
export function consumeWorkerSource(batchId: string): string | undefined {
  const v = sources.get(`w:${batchId}`);
  sources.delete(`w:${batchId}`);
  return v;
}
