// 生产队列「候选池 ↔ 工人」拖拽移动 + 自动分配的写操作 composable
// （`POST /api/v2/prod/queue/move` 与 `POST /api/v2/prod/queue/auto-allocate`）。
//
// 角色：
//   - 提供 3 个 move 包装（POOL→WORKER / WORKER→POOL / WORKER→WORKER），全部
//     收口同一个 `moveMutation`，视图层（PoolDrawer / WorkerColumn）只 inject 这三个
//     函数、不直接 import 本文件；
//   - 三个包装的入参都带 `version`（源批次 `t_part_batch.version`，取自卡片 model，
//     经卡片 `:data-batch-version` → DOM dataset 传递）：move 改的是 current_holder_id
//     / location 属并发敏感写，后端必填 OCC 锚，缺失时返 HTTP 422 纯文本；
//   - mutationFn 走 `moveResultSchema.parse()` 守门；
//   - 写后集中失效「工序看板前缀 + 快照前缀」两个域。
//
// 失效链为什么是「前缀全失效」：move 的目标工序由**后端**从批次当前 step 推导
// （前端不传 process_id），一次 auto-allocate 可同时动多名工人 ⇒ 调用 onSuccess 时
// 前端拿不到受影响的 processId，精确失效必然漏刷。
//
// 拖拽投放与本文件的三条硬约定（不要改）：
//   1. Sortable 容器一律二参重载（不传 list）⇒ 视图侧必须自己补
//      `onRemove: restoreNodeToSource` 做 DOM 回滚，否则投放失败时幻影卡片留在
//      落点列、失效也清不掉；
//   2. 空态用兄弟覆盖层（pointer-events: none），别把投放容器 v-if 摘掉 —— 空列
//      必须仍是合法投放目标（往空闲工人派活是主场景）；
//   3. 卡片组件根必须是单元素（BatchCard 已满足），且容器内不许留模板注释
//      （dev 构建保留注释，注释节点也算容器的直接子节点）。
//   守卫：src/components/__tests__/BatchCardDndFootprint.spec.ts 与
//   components/__tests__/WorkerColumn.spec.ts（W13 系列）。

import { ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { autoAllocate, moveBatch } from '@/api/productionQueue';
import type {
  AutoAllocateRequest,
  AutoAllocateResultDto,
  MoveRequest,
  MoveResultDto,
} from '@/api/productionQueue.contract';
import { moveResultSchema } from './productionQueueSchema';
import { invalidateQueueBoardAll } from './useQueueBoard';
import { invalidateQueueSnapshot } from './useQueueSnapshot';

export interface UseQueueMoveReturn {
  /** 最近一次写操作错误信息（视图层 el-alert 展示）。成功时置 null。 */
  error: Ref<string | null>;
  /** POOL → WORKER：把候选池批次分配给工人。
   *  @param batchId      待移动批次
   *  @param version      OCC 锚（`t_part_batch.version`，取自卡片 model）。后端必填，
   *                     缺失 / 非有限数一律早退（见包装内的守卫）
   *  @param toWorkerId   目标工人
   *  @param fromShelfId  **批次真实所在货架**（不是当前激活货架 —— 候选池跨所有
   *                     货架，填错后端返 20122 BIZ_BATCH_LOCATION_MISMATCH）*/
  moveBatchToWorker: (
    batchId: string,
    version: number,
    toWorkerId: string,
    fromShelfId: string,
  ) => Promise<boolean>;
  /** WORKER → POOL：把工人持有的批次撤回候选池。
   *  @param version OCC 锚（同上，后端必填）
   *  目标货架由后端按批次当前工序下的候选架中负载最低者自动选 ⇒ 不再接受目标架入参。
   *  注意 `from` 侧仍带起点锚（POOL 侧的 `shelf_id` / WORKER 侧的 `worker_id`），
   *  两侧形态不同，故 from / to 分用两个 DTO 类型。 */
  moveBatchToPool: (batchId: string, version: number, fromWorkerId: string) => Promise<boolean>;
  /** WORKER → WORKER：把一名工人手中的批次转交给另一名。落点列的 onDragAdd 在
   *  「拿不到候选池源」时走这条路径（从自己那一列拖回自己不构成移动，由调用方早退，
   *  故本函数不校验 from ≠ to）。 */
  moveBatchBetweenWorkers: (
    batchId: string,
    version: number,
    fromWorkerId: string,
    toWorkerId: string,
  ) => Promise<boolean>;
  /** 按 process + shelf 范围自动为每个匹配工人抢批次数 / 工时。 */
  runAutoAllocate: (req: AutoAllocateRequest) => Promise<void>;
}

export function useQueueMove(): UseQueueMoveReturn {
  const qc = useQueryClient();
  const error = ref<string | null>(null);

  /** 写操作完成后集中失效「工序看板 + 快照」两个域（全是前缀失效，理由见文件头）。
   *  返回 Promise 让 mutation 回调 await 完整失效链再弹 toast，避免两个域的 refetch
   *  重叠。⚠️ 在 mutation 的 onSuccess / onError 里调用时异常由 mutation 框架 catch；
   *  但三个包装函数的入参早退分支是**裸 await**，那条路上必须自己兜（见
   *  reconcileAfterEarlyReturn），否则 invalidateQueries 一抛就是未捕获 rejection。 */
  async function invalidateQueueDomains(): Promise<void> {
    await invalidateQueueBoardAll(qc);
    await invalidateQueueSnapshot(qc);
  }

  /** 入参早退路径的失效兜底。
   *  早退意味着「投放已经发生、写操作没发生」：卡片被拖到落点列却没有对应的 move。
   *  屏幕与服务器的偏差由**源侧**的 onRemove（restoreNodeToSource，把节点放回源列）
   *  抹平，那才是这条路径的必需项；这里失效一次是防御性对账，代价是早退本来就
   *  只在「卡片缺货架 / 未选目标货架」这两种罕见入参下发生。
   *  异常必须在此吞掉：早退的用户可见反馈已由调用方给的 ElMessage.warning 承担，
   *  invalidateQueries 抛错不该再冒一个 unhandledrejection。 */
  async function reconcileAfterEarlyReturn(): Promise<void> {
    try {
      await invalidateQueueDomains();
    } catch {
      // 失效失败无可展示动作；下一次写操作 / 刷新按钮会重拉。
    }
  }

  /** `POST /queue/move`：mutationFn 走 `moveResultSchema.parse()` 守门 ——
   *  MoveResult 的 current_held / max_held / shelf_id / taken 四字段在 rust 侧都带
   *  `skip_serializing_if`（条件不满足时整个字段从 JSON 省略），schema 用
   *  `.nullish()` 兜住；契约漂移立刻抛 ZodError 由 onError 接管。
   *
   *  onError 也失效本域：本域 Sortable 容器是「纯投放信号源」，投放结果一律以
   *  query refetch 之后的 Vue 渲染为准。失败路径这次失效是**防御性对账**、不是必需项
   *  （失败时服务器没有任何变化，重拉只会拿回同一份数据）；真正有实质价值的是
   *  「本端副本已过期」那类失败 —— 409 OCC（40901，他人并发改动）与 20122
   *  （from 与批次实际位置不符）：本端看到的批次状态已经旧了，只能靠重拉纠正。
   *  ⚠️ 卡片节点本身的归位不靠这次失效：源侧的 onRemove（restoreNodeToSource）
   *  已在 drop 事件里把它放回源列，失效只负责把徽标与候选池拉齐。 */
  const moveMutation = useMutation<MoveResultDto, Error, MoveRequest>({
    mutationKey: ['production-queue', 'move'],
    mutationFn: async (req) => moveResultSchema.parse(await moveBatch(req)),
    onSuccess: async (res) => {
      await invalidateQueueDomains();
      error.value = null;
      ElMessage.success(moveSuccessText(res));
    },
    onError: async (e: Error) => {
      error.value = e.message ?? '移动批次失败';
      ElMessage.error(e.message ?? '移动批次失败');
      await invalidateQueueDomains();
    },
  });

  /** `POST /queue/auto-allocate`：出参 `AutoAllocateResult`（`{process_id, shelf_id,
   *  mode, fill_ratio, filled[], pool_empty}`）**没有对应 schema，mutationFn 也没有
   *  Zod parse** —— 与上面 moveMutation 的 `moveResultSchema.parse()` 不同款。后端改
   *  这个 VO 的字段名不会被运行时或测试抓到。声明见 productionQueueSchema.ts 文件头
   *  的覆盖登记；补 schema 时注意别复用 `refillResultSchema`（字段集不同）。
   *
   *  onError 也要失效本域（与 moveMutation 同款理由）：auto-allocate 一次会动多名
   *  工人，任一名中途遇 OCC 就整体中断，此时部分工人的持有数已经落库、本地看板却停在
   *  中断前 —— 与真值分叉。 */
  const autoAllocateMutation = useMutation<AutoAllocateResultDto, Error, AutoAllocateRequest>({
    mutationKey: ['production-queue', 'auto-allocate'],
    mutationFn: async (req) => autoAllocate(req),
    onSuccess: async () => {
      await invalidateQueueDomains();
      error.value = null;
    },
    onError: async (e: Error) => {
      error.value = e.message ?? '自动分配失败';
      ElMessage.error(e.message ?? '自动分配失败');
      await invalidateQueueDomains();
    },
  });

  /** 成功 toast 文案按方向分。WORKER→WORKER 不带批次号：后端 `MoveResult.taken`
   *  只在 POOL→WORKER 时填，转交方向拿不到 batch_no，硬拼只会得到一个空的
   *  「已转交批次 」。 */
  function moveSuccessText(res: MoveResultDto): string {
    if (res.from_kind === 'WORKER' && res.to_kind === 'WORKER') return '已在工人之间转交批次';
    return res.to_kind === 'WORKER'
      ? `已分配批次 ${res.taken?.batch_no ?? ''}`.trim()
      : '已撤回批次至候选池';
  }

  /** version 守卫（三个 move 包装共用）。
   *
   *  `POST /queue/move` 的 `version` 是必填的 OCC 锚（后端 serde 无
   *  `#[serde(default)]` ⇒ 缺字段返 HTTP 422 **纯文本**，不是业务信封，错误文案对用户
   *  毫无意义），所以宁可不发请求也不能发一个注定被拒的 move。
   *
   *  判据是 `typeof !== 'number' || !Number.isFinite(...)` 两条而不是只看 typeof：
   *  调用侧从卡片 dataset 读 version（`Number.parseInt(dataset.x ?? '', 10)`），
   *  dataset 缺失时得到的是 **NaN** —— 它 `typeof` 是 `number`，只查 typeof 会让它
   *  穿过守卫，发出去的 `version: null` 又变回同一个 422。 */
  async function guardVersion(version: number): Promise<boolean> {
    if (typeof version === 'number' && Number.isFinite(version)) return true;
    ElMessage.warning('批次版本信息缺失，无法移动');
    await reconcileAfterEarlyReturn();
    return false;
  }

  /** POOL → WORKER 包装 —— 保留 Promise<boolean> 签名以兼容 WorkerColumn.onDragAdd
   *  调用点。`from.shelf_id` 必填（空串直接早退，避免发出必被后端 20122 拒的请求），
   * `version` 同样必填（见 guardVersion）。两条早退都走一次失效对账，且包 try/catch
   * 防止未捕获 rejection。 */
  async function moveBatchToWorker(
    batchId: string,
    version: number,
    toWorkerId: string,
    fromShelfId: string,
  ): Promise<boolean> {
    if (!(await guardVersion(version))) return false;
    if (!fromShelfId) {
      ElMessage.warning('批次货架信息缺失，无法分配');
      await reconcileAfterEarlyReturn();
      return false;
    }
    try {
      await moveMutation.mutateAsync({
        batch_id: batchId,
        version,
        from: { kind: 'POOL', shelf_id: fromShelfId },
        to: { kind: 'WORKER', worker_id: toWorkerId },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** WORKER → POOL 包装 —— 撤回候选池。**目标货架由后端按批次当前工序下的候选架中
   *  负载最低者自动选**，前端不再需要「当前货架」。
   *
   *  `from` 侧的 `worker_id` 是起点锚（后端与批次 `current_holder_id` 比对）；
   *  `to` 侧只有一个 `kind: 'POOL'`，不带任何货架字段。
   *
   *  这一改动同时解掉了旧实现那条结构性限制：目标架曾取自
   *  `auth.activeShelfId = boundShelves[0]`，而该字段只对「SHELF_ACCOUNT +
   *  scope_type='shelf'」的角色行有值 ⇒ MANAGER / CLERK / INSPECTOR 恒为 null，
   * 撤回对这三类角色曾经结构性不可用。现在没有任何早退分支了。 */
  async function moveBatchToPool(
    batchId: string,
    version: number,
    fromWorkerId: string,
  ): Promise<boolean> {
    if (!(await guardVersion(version))) return false;
    try {
      await moveMutation.mutateAsync({
        batch_id: batchId,
        version,
        from: { kind: 'WORKER', worker_id: fromWorkerId },
        to: { kind: 'POOL' },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** WORKER → WORKER 包装（工人之间转交）。与上面两个包装共用同一个 moveMutation，
   *  失效链 / toast / 错误桥接完全同构。
   *  from 与 to 都是 worker_id：`from` 由拖拽源的 WorkerColumn.onDragStart 记进
   *  dndSourceTracker（与「撤回候选池」共用工人源），`to` 是落点列自己的 worker_id。
   *  不校验 from ≠ to —— 拖回自己那一列不构成一次移动，由调用方早退。 */
  async function moveBatchBetweenWorkers(
    batchId: string,
    version: number,
    fromWorkerId: string,
    toWorkerId: string,
  ): Promise<boolean> {
    if (!(await guardVersion(version))) return false;
    try {
      await moveMutation.mutateAsync({
        batch_id: batchId,
        version,
        from: { kind: 'WORKER', worker_id: fromWorkerId },
        to: { kind: 'WORKER', worker_id: toWorkerId },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** runAutoAllocate 包装 —— 保留 Promise<void> 签名。 */
  async function runAutoAllocate(req: AutoAllocateRequest): Promise<void> {
    await autoAllocateMutation.mutateAsync(req);
  }

  return {
    error,
    moveBatchToWorker,
    moveBatchToPool,
    moveBatchBetweenWorkers,
    runAutoAllocate,
  };
}
