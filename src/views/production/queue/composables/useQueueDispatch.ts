// 生产队列「待下发」Tab 的视图层 composable：待下发列表（读）+ 下发 / 自动下发（写）。
//
// 角色：
//   - 持有 selectedIds（Set<string>）私有状态 —— 多选卡 + 自动下发共用；
//   - 内部持有一条 `GET /prod/queue/pending` 的 useQuery（`useQueuePendingQuery`，
//     见文件末），暴露 batches / total / isLoading 给视图层；
//   - 提供 2 个 mutation：dispatchMutation（单件 / 批量合一）+ autoDispatchMutation
//     （只读预览 → 用户确认 → 链式调 dispatchMutation 真正下发）；
//   - mutationFn 走 Zod parse 守门（守门点在本层而非 api 层：queue 域的 schema 随
//     视图目录走，api 层 import 它就是 api → views 的反向依赖）；
//   - 写后集中失效：待下发前缀 + 工序看板前缀 + 快照前缀，外加跨域 `qk.partsPrefix`；
//   - 不写 retry（信任 main.ts 全局 mutations.retry: 0）。
//
// 自动下发是**两步**（后端 auto-dispatch 降级为只读 preview）：
//   ① 点「自动下发」调 `previewAutoDispatch({ batch_ids })` 拿预览（不写库、不发 WS）；
//   ② ElMessageBox 展示「可下发 N 件 / 跳过 M 件」明细，用户确认后用
//      `first_process_id` 构造 targets 调 dispatchMutation 真正下发。
//   `skip_reason === 'NO_PROCESS_CHAIN'` 的项走 `handleProcessChainRequired`
//   引导去「制定工序」页，一次操作只弹一次引导框、件数写进弹窗文案、深链只带第一件的
//   part_id（用户点「取消」即留在原地，不会被误跳到另一零件的工艺链页）。
//
// 全部可下发项都被跳过时不弹确认框、直接提示原因 —— 避免给用户一个「确认了却什么
// 都不会发生」的空确认框。

import { computed, ref, toValue, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryReturnType,
} from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import {
  AUTO_DISPATCH_SKIP_REASON_LABELS,
  dispatchBatches,
  fetchPendingBatches,
  previewAutoDispatch,
  type ListQueuePendingParams,
} from '@/api/productionQueue';
import type { QueuePendingBatchDto } from '@/api/productionQueue.contract';
import { ApiError } from '@/api/http';
import { qk } from '@/composables/queries/keys';
import {
  BIZ_PROCESS_CHAIN_REQUIRED,
  handleProcessChainRequired,
} from '@/composables/useProcessChainRequiredHandler';
import {
  autoDispatchResultSchema,
  dispatchResultSchema,
  queuePendingBatchListSchema,
  type AutoDispatchResultSchema,
  type DispatchResultSchema,
  type QueuePendingBatchListSchema,
} from './productionQueueSchema';
import { invalidateQueueBoardAll } from './useQueueBoard';
import { invalidateQueueSnapshot } from './useQueueSnapshot';

export interface UseQueueDispatchReturn {
  /** 待下发批次列表（已与 query 解包） */
  batches: ComputedRef<QueuePendingBatchDto[]>;
  /** 总数（不受分页截断影响，面板「总计 N 件」用它） */
  total: ComputedRef<number>;
  /** isFetching 暴露给视图层（loading 占位） */
  isLoading: Ref<boolean>;
  /** 多选卡已选 batchId 集合 */
  selectedIds: Ref<Set<string>>;
  /** 多选切换（视图层 el-table @selection-change → 全量替换） */
  setSelectedIds: (ids: string[]) => void;
  /** 清除已选 */
  clearSelection: () => void;
  /** 下发 mutation（单件与批量合一，mutation.isPending / mutate）。
   *  入参 `{ batchIds, targetProcessId }`：单件传 `batchIds.length === 1`。 */
  dispatchMutation: ReturnType<
    typeof useMutation<DispatchResultSchema, Error, { batchIds: string[]; targetProcessId: string }>
  >;
  /** 自动下发 mutation（只读预览 → 确认 → 链式 dispatch），mutation.isPending / mutate。 */
  autoDispatchMutation: ReturnType<
    typeof useMutation<AutoDispatchResultSchema, Error, { batchIds: string[] }>
  >;
}

/**
 * 生产队列「待下发」Tab 视图层 composable。
 *
 * 用法：
 * ```ts
 * const dispatch = useQueueDispatch();
 * // 拖到工序卡 / 单击工序卡：
 * dispatch.dispatchMutation.mutate({ batchIds: [...], targetProcessId: p.id });
 * // 自动下发（preview → 确认 → dispatch）：
 * dispatch.autoDispatchMutation.mutate({ batchIds: [...dispatch.selectedIds.value] });
 * ```
 */
export function useQueueDispatch(): UseQueueDispatchReturn {
  const qc = useQueryClient();
  // useRouter() 必须在 setup 顶部一次性拿闭包复用：在 lifecycle hook 之外调
  // inject() 会返回 undefined（vue-router 4.6.4 + vue 3.5.38）。
  const router = useRouter();

  // 默认 limit=200（KB 级基础数据全量拉取，写操作触发 invalidate 失效）。后端
  // `ListQueuePendingQuery` 只接 limit / offset。
  const query = useQueuePendingQuery({ limit: 200 });

  const batches = computed<QueuePendingBatchDto[]>(() => query.data.value?.items ?? []);
  const total = computed<number>(() => query.data.value?.total ?? 0);
  const isLoading = query.isFetching;

  // ===== 多选状态 =====
  const selectedIds = ref<Set<string>>(new Set());
  function setSelectedIds(ids: string[]): void {
    selectedIds.value = new Set(ids);
  }
  function clearSelection(): void {
    selectedIds.value = new Set();
  }

  /** batchId → partId 反查表，供「未制定工序链」兜底深链用。dispatch / auto-dispatch
   *  两个 mutation 共享。 */
  const partIdByBatchId = computed<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const b of batches.value) m.set(b.batch_id, b.part_id);
    return m;
  });

  /** 写操作完成后集中失效：待下发列表 + 工序看板 + 队列快照，外加跨域 parts。
   *  跨域理由：下发后批次从 PENDING 进入 IN_PROCESS + 候选池，同一件工单在零件列表
   *  的派生状态（下一道工序指针、批次成员资格）也变了。
   *  **不含 processes 域**：下发批次不可能改变工序列表，而显式 invalidateQueries
   *  不会被 staleTime 挡掉，每次下发都重拉一次 processes（QueueBoard 的
   *  `useProcessesQuery` observer）纯属浪费；工序列表走 30s 有限 staleTime 兜新鲜度。
   *  返回 Promise 让两个 mutation 的 onSuccess 内部 await 完整失效链，避免 query
   *  重叠触发雪崩。 */
  async function invalidateAll(): Promise<void> {
    await invalidateQueuePendingAll(qc);
    await invalidateQueueBoardAll(qc);
    await invalidateQueueSnapshot(qc);
    await qc.invalidateQueries({ queryKey: qk.partsPrefix }).then(() => undefined);
  }

  // ===== mutation 范本（沿 2026-09-26 CLAUDE.md #8）=====

  /** 下发（单件 / 批量合一）：后端 dispatch 统一 bulk-only，单条下发即
   *  `targets.length === 1`。不写 retry（信任全局默认）。
   *  onSuccess 报数取 `res.succeeded.length`；`res.failed` 当前恒空（任一失败 →
   *  service 抛 AppError 全回滚），schema 已 `.default([])` 兜底，仍保留分支以便
   *  后端未来启用 partial commit。 */
  // TData 取 z.infer（parse 后的类型）而不是 api 层 DTO：dispatchResultSchema 对
  // `failed` 做了 `.default([])`，只有用 infer 类型才拿得到「必填数组」的可写契约。
  const dispatchMutation = useMutation<
    DispatchResultSchema,
    Error,
    { batchIds: string[]; targetProcessId: string }
  >({
    mutationKey: ['production-queue', 'dispatch'],
    mutationFn: async ({ batchIds, targetProcessId }) =>
      dispatchResultSchema.parse(
        await dispatchBatches({
          targets: batchIds.map((id) => ({
            batch_id: id,
            target_process_id: targetProcessId,
          })),
        }),
      ),
    onSuccess: async (res) => {
      await invalidateAll();
      // 多选场景（拖到工序卡 / 自动下发确认）成功后清空多选；单件路径本来无多选，
      // clearSelection 是幂等的。
      clearSelection();
      const ok = res.succeeded.length;
      const failed = res.failed.length;
      if (ok > 0) ElMessage.success(`已下发 ${ok} 件`);
      if (failed > 0) {
        ElMessage.error(
          `下发失败 ${failed} 件：${failed > 3 ? '…' : res.failed.map((f) => f.batch_id).join('；')}`,
        );
      }
    },
    onError: async (e: Error) => {
      // 后端 dispatch 端点不再抛「工序链缺失」业务错（统一走 auto-dispatch preview
      // 的 skip_reason = NO_PROCESS_CHAIN 引导路径），故此处只报原始错误消息。
      ElMessage.error(e.message ?? '下发失败');
      // 失败也要走**全套**失效链（与 onSuccess 同款），不是只刷待下发列表：dispatch
      // 最常见的失败恰恰是 40901 OCC 与 20120 状态不允许 —— 那意味着**别人已经把这批
      // 下发出去了**（批次真的离开待下发池、真的进了目标工序候选池）。只失效 pending
      // 会让目标工序列凭空少卡、tab 徽标过期，只能等 30s staleTime 到期自愈。
      // 失败信息不可能预知是哪一类，所以统一按「本端副本已过期」处理。
      await invalidateAll();
    },
  });

  /** 自动下发（两步，详见文件头）。`items` 按入参顺序稳定排序；可下发判定 =
   * `skip_reason === null` 且 `first_process_id !== null`。 */
  const autoDispatchMutation = useMutation<AutoDispatchResultSchema, Error, { batchIds: string[] }>({
    mutationKey: ['production-queue', 'auto-dispatch'],
    mutationFn: async ({ batchIds }) =>
      autoDispatchResultSchema.parse(await previewAutoDispatch({ batch_ids: batchIds })),
    onSuccess: async (res) => {
      const dispatchable = res.items.filter(
        (it) => it.skip_reason === null && it.first_process_id !== null,
      );
      const skipped = res.items.filter((it) => it.skip_reason !== null);

      if (dispatchable.length === 0) {
        clearSelection();
        const noChain = skipped.filter((s) => s.skip_reason === 'NO_PROCESS_CHAIN');
        const firstNoChain = noChain[0];
        if (firstNoChain) {
          const partId = partIdByBatchId.value.get(firstNoChain.batch_id) ?? null;
          await handleProcessChainRequired(
            new ApiError(
              BIZ_PROCESS_CHAIN_REQUIRED,
              noChain.length > 1 ? `${noChain.length} 件工单未制定工序链` : '请先制定工序链',
            ),
            partId,
            router,
          );
        }
        const other = skipped.filter((s) => s.skip_reason !== 'NO_PROCESS_CHAIN');
        if (other.length > 0) {
          ElMessage.warning(
            `无可下发批次：${summarizeSkipReasons(other.map((s) => s.skip_reason!))}`,
          );
        }
        return;
      }

      // 可下发项按「首道工序」分组 —— 一次 dispatch 请求只带一个 target_process_id，
      // 故多首道工序时按 first_process_id 拆成多次 dispatch（顺序执行）。
      const byProcess = new Map<string, string[]>();
      for (const it of dispatchable) {
        const pid = it.first_process_id!;
        const arr = byProcess.get(pid) ?? [];
        arr.push(it.batch_id);
        byProcess.set(pid, arr);
      }

      const detail =
        `可下发 ${dispatchable.length} 件` +
        (byProcess.size > 1 ? `（分 ${byProcess.size} 批首道工序）` : '') +
        (skipped.length > 0
          ? `\n跳过 ${skipped.length} 件：${summarizeSkipReasons(skipped.map((s) => s.skip_reason!))}`
          : '');
      try {
        await ElMessageBox.confirm(detail, '确认自动下发', {
          confirmButtonText: '下发',
          cancelButtonText: '取消',
          type: skipped.length > 0 ? 'warning' : 'info',
        });
      } catch {
        // 用户取消：不动数据（preview 是只读的，无需回滚任何东西）
        return;
      }

      // 逐组下发（任一组失败即中断，剩余组不再发；失败信息由 dispatchMutation 的
      // onError toast 呈现）
      for (const [targetProcessId, batchIds] of byProcess) {
        try {
          await dispatchMutation.mutateAsync({ batchIds, targetProcessId });
        } catch {
          return;
        }
      }
    },
    onError: (e: Error) => {
      ElMessage.error(e.message ?? '自动下发预览失败');
    },
  });

  return {
    batches,
    total,
    isLoading,
    selectedIds,
    setSelectedIds,
    clearSelection,
    dispatchMutation,
    autoDispatchMutation,
  };
}

/** 待下发列表 query（`GET /api/v2/prod/queue/pending`）。
 *  **不复用全局共享层**：本域的列表只有一个消费方（「待下发」Tab 的左栏），
 *  按 dashboard 域的做法随视图目录走。`limit` / `offset` 进 queryKey ⇒ 换分页即换
 *  缓存身份；staleTime 30s / gcTime 5min（队列页本轮零 WS 订阅，不能设
 *  POSITIVE_INFINITY，理由见 useQueueSnapshot.ts 文件头）。
 *  error 不做 ElMessage 桥接：由面板渲染 el-skeleton / 空态承载（桥接会给「列表
 *  空」与「加载失败」两种状态弹同一条 toast，反而更吵）。 */
function useQueuePendingQuery(
  params?: MaybeRefOrGetter<ListQueuePendingParams>,
): UseQueryReturnType<QueuePendingBatchListSchema, Error> {
  const paramsKey = computed(() => qk.productionQueuePending(toValue(params) ?? {}));
  return useQuery<QueuePendingBatchListSchema, Error>({
    queryKey: paramsKey,
    // queryFn 从 queryKey 读最新 params（键是唯一真相源），不闭包捕获 stale 值。
    queryFn: async ({ queryKey }) => {
      const raw = queryKey[2];
      const p: ListQueuePendingParams =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as ListQueuePendingParams)
          : {};
      return queuePendingBatchListSchema.parse(await fetchPendingBatches(p));
    },
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 失效整个待下发列表域（写操作完成后调；返回 Promise<void> 让调用方可 await）。
 *  调用点：useQueueDispatch.invalidateAll / dispatchMutation.onError、
 *  useQueueRecall（召回把批次送回本列表）、QueueBoard.onRefresh（手动刷新）。 */
export function invalidateQueuePendingAll(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.productionQueuePendingPrefix })
    .then(() => undefined);
}

/** skip_reason 列表 → 紧凑中文摘要（按原因去重 + 计数，最多 2 种原因）。 */
function summarizeSkipReasons(reasons: string[]): string {
  const tally = new Map<string, number>();
  for (const r of reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
  return Array.from(tally.entries())
    .slice(0, 2)
    .map(([reason, n]) => `${AUTO_DISPATCH_SKIP_REASON_LABELS[reason] ?? reason} ${n}`)
    .join('、');
}