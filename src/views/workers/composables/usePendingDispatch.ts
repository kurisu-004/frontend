// src/views/workers/composables/usePendingDispatch.ts
//
// 2026-09-29 新增：生产队列「待下发」Tab 视图层 composable。
// 2026-09-30 重写：对齐后端 `src/modules/prod/batch` 2026-09-30 重构
// （docs/api/production/batches.md）。
//
// 角色：
//   - 持有 selectedIds（Set<string>）私有状态 —— 多选卡 + 自动下发共用；
//   - 内部消费 usePendingBatchesQuery（共享基础数据层），暴露 batches /
//     total / isLoading 给 view 层；
//   - 提供 2 个 mutation：dispatchMutation（单件 / 批量合一）+ autoDispatchMutation
//     （只读预览 → 用户确认 → 链式调 dispatchMutation 真正下发）；
//   - mutationFn 走 Zod parse 守门，onSuccess 集中调 invalidateAll() 失效四域
//     （沿 2026-09-26 写操作精确失效约定）；
//   - 不写 retry（信任 main.ts 全局 mutations.retry: 0）；
//   - mutationKey 三层数组（['pending-batches', 'dispatch'] / ['pending-batches',
//     'auto-dispatch']）。
//
// 2026-09-30 后端契约漂移修复（三个断点）：
//   1. **dispatch 统一 bulk-only**：旧 `dispatchBatch(batchId, {target_process_id})`
//      发的 `{batch_id, target_process_id, note}` 与后端 `DispatchRequest
//      {targets: [...], note?}` 完全错位；且 `POST /batches/bulk-dispatch` 端点已被
//      **删除**（router 层不再挂载 ⇒ 404）。故 dispatchMutation + bulkDispatchMutation
//      合并为单个 `dispatchMutation`，入参 `{batchIds, targetProcessId}`。
//   2. **dispatch 出参改列表形态**：`DispatchResult {succeeded[], failed[]}`，旧前端
//      读的是单个 `DispatchSuccessItem`（schema 名字对不上）。
//   3. **auto-dispatch 改为只读 preview**：不再真正下发，出参由
//      `{succeeded, skipped}` 改为 `{items: [AutoDispatchItem]}`（含
//      `first_process_id` / `first_shelf_id` / `skip_reason`）。用户选择的交互：
//      **两步** —— ① 点「自动下发」调 preview；② ElMessageBox 展示可下发 / 跳过
//      明细，用户确认后用 `first_process_id` 构造 targets 调 dispatchMutation 真正
//      下发。`skip_reason === 'NO_PROCESS_CHAIN'` 的项仍走 handleProcessChainRequired
//      引导去工艺制定页（保持与旧 20706 业务错一致的 UX —— 后端 batch 域不再抛 20706，
//      改以 soft-skip 形式出现在 preview 里）。
//
// 2026-09-30 顺带清理：
//   - 删 `UsePendingDispatchDeps`（refreshBoard 依赖注入）—— 随
//     useWorkerQueue.loadBoard + 模块级 workerHeld 一并删除，invalidateAll 不再有
//     「触达不到的非 TanStack 数据源」要兜底。
//   - 删 `dispatchResultSchema` 双重 parse（api 层已 parse 过一次）。

import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import {
  AUTO_DISPATCH_SKIP_REASON_LABELS,
  dispatchBatches,
  previewAutoDispatch,
  type AutoDispatchPreviewDto,
  type DispatchBatchResultDto,
  type ListPendingBatchesParams,
} from '@/api/pendingBatches';
import { dispatchResultSchema } from '@/composables/queries/schemas';
import { ApiError } from '@/api/http';
import { invalidatePendingBatchesQuery } from '@/composables/queries/usePendingBatchesQuery';
import { invalidateWorkerPoolByProcessAll } from '@/composables/queries/useWorkerPoolByProcessQuery';
import { invalidateWorkerPoolCountsQuery } from '@/composables/queries/useWorkerPoolCountsQuery';
import { invalidateWorkerStateByWorkerAll } from '@/composables/queries/useWorkerStateByWorkerQuery';
import { qk } from '@/composables/queries/keys';
import { usePendingBatchesQuery } from '@/composables/queries/usePendingBatchesQuery';
import {
  BIZ_PROCESS_CHAIN_REQUIRED,
  handleProcessChainRequired,
} from '@/composables/useProcessChainRequiredHandler';
import type { PendingBatchItemDto } from '@/api/workerPool.contract';

export interface UsePendingDispatchReturn {
  /** 待下发批次列表（已与共享 query 解包） */
  batches: ComputedRef<PendingBatchItemDto[]>;
  /** 总数 */
  total: ComputedRef<number>;
  /** isFetching 暴露给 view 层（loading 占位） */
  isLoading: Ref<boolean>;
  /** 多选卡已选 batchId 集合 */
  selectedIds: Ref<Set<string>>;
  /** 多选切换（view 层 el-table @selection-change → 全量替换） */
  setSelectedIds: (ids: string[]) => void;
  /** 清除已选 */
  clearSelection: () => void;
  /** 下发 mutation（单件与批量合一，mutation.isPending / mutate）。
   *  入参 `{ batchIds, targetProcessId }`：单件传 `batchIds.length === 1`。 */
  dispatchMutation: ReturnType<
    typeof useMutation<
      DispatchBatchResultDto,
      Error,
      { batchIds: string[]; targetProcessId: string }
    >
  >;
  /** 自动下发 mutation（只读预览 → 确认 → 链式 dispatch），mutation.isPending / mutate。 */
  autoDispatchMutation: ReturnType<
    typeof useMutation<AutoDispatchPreviewDto, Error, { batchIds: string[] }>
  >;
}

/**
 * 2026-09-29 新增 / 2026-09-30 重写：生产队列「待下发」Tab 视图层 composable。
 *
 * 用法：
 *   ```ts
 *   const dispatch = usePendingDispatch();
 *   // 拖到工序卡 / 单击工序卡：
 *   dispatch.dispatchMutation.mutate({ batchIds: [...], targetProcessId: p.id });
 *   // 自动下发（preview → 确认 → dispatch）：
 *   dispatch.autoDispatchMutation.mutate({ batchIds: [...dispatch.selectedIds.value] });
 *   ```
 */
export function usePendingDispatch(): UsePendingDispatchReturn {
  const qc = useQueryClient();
  // 2026-09-29 review 第 1 轮修复：useRouter() 必须在 setup 顶部一次性拿闭包复用，
  // 沿 usePartDispatch.ts:92 fix（vue-router 4.6.4 + vue 3.5.38 下 inject() 在
  // lifecycle hook 之外返回 undefined）。
  const router = useRouter();

  // 2026-09-29：共享 useQuery 消费方式 —— 默认 limit=200（任务规约：KB 级基础数据，
  // 全量拉取；写操作触发 invalidate 失效）。后端 `ListPendingQuery` 只接 limit /
  // offset 两个参数（batch/dto.rs），旧前端的 urgent_only / keyword 已在 api 层删除。
  const params: ListPendingBatchesParams = { limit: 200 };
  const query = usePendingBatchesQuery(params);

  const batches = computed<PendingBatchItemDto[]>(() => query.data.value?.items ?? []);
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

  // 2026-09-29 review 第 1 轮修复（C1 / C2）：batchId → partId 反查表，供 20706
  // 兜底深链 / 工序链缺失引导用。dispatch / auto-dispatch 两 mutation 共享。
  const partIdByBatchId = computed<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const b of batches.value) m.set(b.batch_id, b.part_id);
    return m;
  });

  /** 2026-09-30：写操作完成后集中失效四域（pending-batches / parts /
   *  pool by-process / pool counts）+ pool state。
   *  跨域失效理由：下发后 batch 从 PENDING 进入 IN_PROCESS + 候选池，同一件工单在
   *  零件列表的派生状态也变（next_process_step 推进）。
   *  2026-09-30 修复：移除 processes 域失效。下发批次不可能改变工序列表，而
   *  显式 `invalidateQueries` 不会被 staleTime 挡掉（TanStack v5 预期行为），
   *  每次下发都重拉一次 processes（如 WorkerQueueBoard 的 `useProcessesQuery()`
   *  observer）纯属浪费。2026-09-30 策略变更后 processes 走 30s staleTime 有限缓存，
   *  新鲜度不再依赖「写点全集中」这个前提（见 CLAUDE.md「TanStack Query 缓存时长
   *  策略」）。
   *  返回 Promise 让 2 个 mutation onSuccess 内部 await 完整失效链，避免 query
   *  重叠触发雪崩。 */
  async function invalidateAll(): Promise<void> {
    await invalidatePendingBatchesQuery(qc);
    await qc.invalidateQueries({ queryKey: qk.partsPrefix }).then(() => undefined);
    // 2026-09-30：pool 域三域前缀失效（by-process 任意 processId + counts 全量 +
    // state 任意 worker —— 下发后 batch 进入候选池并被后续 worker 抢走）。
    await invalidateWorkerPoolByProcessAll(qc);
    await invalidateWorkerPoolCountsQuery(qc);
    await invalidateWorkerStateByWorkerAll(qc);
  }

  // ===== mutation 范本（沿 2026-09-26 CLAUDE.md #8）=====

  /** 下发（单件 / 批量合一）—— 2026-09-30：后端 dispatch 统一 bulk-only，
   *  单条下发即 `targets.length == 1`；`bulk-dispatch` 端点已删除。
   *  mutationKey 三层数组；不写 retry（信任全局默认）。
   *  onSuccess 报数取 `res.succeeded.length`；`res.failed` 当前恒空（任一失败 →
   *  service 抛 AppError 全回滚），schema 已 `.default([])` 兜底，仍保留分支以便
   *  后端未来启用 partial commit。 */
  const dispatchMutation = useMutation<
    DispatchBatchResultDto,
    Error,
    { batchIds: string[]; targetProcessId: string }
  >({
    mutationKey: ['pending-batches', 'dispatch'],
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
      // 2026-09-30：后端 batch 域错误码表已无 20706（`docs/api/production/batches.md`
      // §错误码速查：40001 / 20120 / 20121 / 20508 / 40901 / 40300），dispatch 不再抛
      // 工序链缺失错 —— 统一走「自动下发 preview 的 skip_reason = NO_PROCESS_CHAIN」
      // 路径引导。故此处只报原始错误消息。
      ElMessage.error(e.message ?? '下发失败');
      // 2026-10-02：失败即与服务器对账一次。下发失败时卡片本来就不会从待下发池
      // 消失 —— 面板渲染的是 props.batches 派生的 cards，Sortable 改的是不参与渲染
      // 的本地副本 sortableCards + DOM（被拖节点由库放回源容器），屏幕上的卡片纹丝
      // 不动。这里额外重拉一次是兜底：若列表已与服务器漂移（并发下发 / 状态被别处
      // 改过），不该留到下一次自然刷新才发现。
      await invalidatePendingBatchesQuery(qc);
    },
  });

  /** 自动下发 —— 2026-09-30 改为**两步**（后端 auto-dispatch 已降级为只读 preview）：
   *   ① mutationFn 只调 `previewAutoDispatch({batch_ids})` 拿预览（不写库、不发 WS）；
   *   ② onSuccess 用 ElMessageBox 展示「可下发 N 件 / 跳过 M 件」明细 + skip_reason
   *      中文文案，用户确认后用 `first_process_id` 构造 targets 链式调
   *      `dispatchMutation.mutateAsync` 真正下发；
   *   ③ `skip_reason === 'NO_PROCESS_CHAIN'` 的项仍走 handleProcessChainRequired
   *      引导去工艺制定页（后端 batch 域不再抛 20706，此处合成 ApiError 复用
   *      既有兜底逻辑，保持 UX 不退化）。
   *
   *  全部可下发项都被跳过（items 内无 skip_reason===null）时不再弹确认框，直接
   *  提示原因 —— 避免给用户一个「确认了却什么都不会发生」的空确认框。 */
  const autoDispatchMutation = useMutation<AutoDispatchPreviewDto, Error, { batchIds: string[] }>(
    {
      mutationKey: ['pending-batches', 'auto-dispatch'],
      mutationFn: async ({ batchIds }) => previewAutoDispatch({ batch_ids: batchIds }),
      onSuccess: async (res) => {
        const dispatchable = res.items.filter(
          (it) => it.skip_reason === null && it.first_process_id !== null,
        );
        const skipped = res.items.filter((it) => it.skip_reason !== null);

        // 无可下发项：只提示原因 + 引导，不弹确认框。
        if (dispatchable.length === 0) {
          clearSelection();
          const noChain = skipped.filter((s) => s.skip_reason === 'NO_PROCESS_CHAIN');
          for (const s of noChain) {
            const partId = partIdByBatchId.value.get(s.batch_id) ?? null;
            await handleProcessChainRequired(
              new ApiError(BIZ_PROCESS_CHAIN_REQUIRED, '请先制定工序链'),
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

        // 逐组下发（任一组失败即中断，剩余组不再发；失败信息由 dispatchMutation
        // 的 onError toast 呈现）
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
    },
  );

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

/** skip_reason 列表 → 紧凑中文摘要（按原因去重 + 计数，最多 2 种原因）。 */
function summarizeSkipReasons(reasons: string[]): string {
  const tally = new Map<string, number>();
  for (const r of reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
  return Array.from(tally.entries())
    .slice(0, 2)
    .map(([reason, n]) => `${AUTO_DISPATCH_SKIP_REASON_LABELS[reason] ?? reason} ${n}`)
    .join('、');
}
