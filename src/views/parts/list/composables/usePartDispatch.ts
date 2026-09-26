// views/parts/list/composables/usePartDispatch.ts
//
// 2026-08-22 从 PartsList.vue 抽出：单件下发 + 批量下发 + 召回（2026-08-05）。
//
// 2026-08-22：不用 useDialogSize（弹窗 size 在模板里写死即可，避免引入额外 composable
// 依赖）。
//
// 2026-09-16 PR-3：placeOnShelf 后端新增前置校验 —— part.process_chain_id 非空，
// 否则 20706 BIZ_PROCESS_CHAIN_REQUIRED。单件 / 批量两条 path 都 wrap
// `handleProcessChainRequired`：命中 20706 → 弹「前往制定」确认框 → 跳
// /production/process-design?part_id=XXX；命中后直接 return，不进 toast 兜底。
//
// 2026-09-26 重构（B 任务）：手写状态机 → TanStack Query / useMutation。
//   - 4 个写操作包 useMutation（单件 cnc / 单件直发 / 批量循环 / 2 个召回）；
//   - 共享 qc.invalidateQueries({queryKey: qk.partsPrefix}) 失效整个 parts 域；
//   - 单件对话框 processes 走共享 useProcessesQuery（与 usePartsColumnFilters 同源，
//     session 级缓存）；shelves 维持现状（本期不动 shelves 共享 query）；
//   - fetchList dep 删除（M-2 修复）：mutation onSuccess 不再调 fetchList
//     （queryKey 失效后下次访问自动 refetch；这与原「fetchList 同步刷新」语义等价）。
//     原 fetchList dep 是过渡期兼容位，store 装配时已不再传
//     （usePartsListStore.ts:77-85），本 composable 也不读；
//   - 保存原 onSuccess / onError / ElMessage / 20706 兜底行为。

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useQueryClient, useMutation } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { placeOnShelf, recallToPending, recallToProgramming, sendToProgramming } from '@/api/parts';
import { listShelves } from '@/api/shelves';
import type { Shelf } from '@/types/shelf';
import type { Process } from '@/types/process';
import type { PartListItem } from '@/types/parts';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { qk } from '@/composables/queries/keys';
// 2026-09-26：迁移到 Pinia store useAuthStore（替代原 useAuthSession 模块级单例）。
import { useAuthStore } from '@/stores/auth';
import { handleProcessChainRequired } from '@/composables/useProcessChainRequiredHandler';
import type { SelectedRowType } from './usePartBatchSelection';

interface TableRef {
  toggleRowSelection: (row: PartListItem, selected: boolean) => void;
}

export interface UsePartDispatchDeps {
  selectedIds: Set<string>;
  selectedRows: Ref<PartListItem[]>;
  selectedRowTypes: Map<string, SelectedRowType>;
  getTable: () => TableRef | null | undefined;
}

/** 2026-09-21 显式返回类型。 */
export interface UsePartDispatchReturn {
  shelves: Ref<Shelf[]>;
  processes: ComputedRef<Process[]>;
  processesLoading: Ref<boolean>;
  /** 2026-09-26（B 任务）：重新加载 shelves（单件 / 批量下发共用缓存）；
   *  内部暴露以便 caller 在必要时强制刷新（默认 onMounted/onDispatch 时已经按需加载）。 */
  reloadShelves: () => Promise<void>;
  dispatchVisible: Ref<boolean>;
  dispatchMode: Ref<'direct' | 'cnc'>;
  dispatchShelfId: Ref<string | null>;
  dispatchNextProcessId: Ref<string | null>;
  dispatchPartId: Ref<string | null>;
  dispatchSubmitting: ComputedRef<boolean>;
  // 2026-09-21 fix：原 ReturnType<typeof useShelfProcessFilter> 默认泛型落到 Identifiable，
  // 下游 el-option 访问 .code / .name 编译失败。收紧到 Shelf / Process 业务类型。
  filteredShelves: ComputedRef<readonly Shelf[]>;
  filteredProcesses: ComputedRef<readonly Process[]>;
  onDispatch: (row: PartListItem) => Promise<void>;
  onDispatchClosed: () => void;
  onDispatchConfirm: () => Promise<void>;
  batchDispatchVisible: Ref<boolean>;
  batchDispatchAction: Ref<'shelf' | 'programming'>;
  batchDispatchShelfId: Ref<string | null>;
  batchDispatchNextProcessId: Ref<string | null>;
  batchDispatchSubmitting: ComputedRef<boolean>;
  // 2026-09-21 fix：同上，单件 / 批量两条 path 同源问题
  batchFilteredShelves: ComputedRef<readonly Shelf[]>;
  batchFilteredProcesses: ComputedRef<readonly Process[]>;
  onOpenBatchDispatch: () => Promise<void>;
  onBatchDispatchConfirm: () => Promise<void>;
  canRecallToPending: (row: PartListItem) => boolean;
  canRecallToProgramming: (row: PartListItem) => boolean;
  onRecallToPending: (row: PartListItem) => Promise<void>;
  onRecallToProgramming: (row: PartListItem) => Promise<void>;
}

export function usePartDispatch(deps: UsePartDispatchDeps): UsePartDispatchReturn {
  // 2026-09-17 PR-3 修复：useRouter() 必须在 setup 顶部一次性拿闭包复用，禁止在 async 事件回调里调
  // —— vue-router 4.6.4 + vue 3.5.38 下 inject() 在 lifecycle hook 之外返回 undefined。
  const router = useRouter();
  const qc = useQueryClient();

  // ============ 共享数据 ============
  // 2026-09-26（B 任务）：shelves 仍走本地 ref（本期不动 shelves 共享 query，user 同意）。
  const shelves = ref<Shelf[]>([]);
  // processes 切到共享 useProcessesQuery（A 任务已建，session 级缓存）：
  //   - 与 usePartsColumnFilters 同源（同一 query key），保证下一次切换时拿到同一份缓存；
  //   - isFetching 通过 processesLoading 暴露（dialog loading / 占位用）。
  const procQuery = useProcessesQuery({ limit: 200 });
  const processes = computed<Process[]>(() => procQuery.data.value?.items ?? []);
  const processesLoading = procQuery.isFetching;

  /** 2026-09-26（B 任务）：拉取 shelves（模块级缓存：shelves.value.length===0 才拉）。
   *  单件 / 批量两条 path 共用缓存；本期不迁共享 query（user 同意）。 */
  async function reloadShelves(): Promise<void> {
    if (shelves.value.length > 0) return;
    try {
      shelves.value = (
        await listShelves({ zone: 'PRODUCTION', is_active: true, limit: 200 })
      ).items;
    } catch {
      shelves.value = [];
    }
  }

  // ============ 单件下发 ============
  const dispatchVisible = ref(false);
  const dispatchMode = ref<'direct' | 'cnc'>('direct');
  const dispatchShelfId = ref<string | null>(null);
  const dispatchNextProcessId = ref<string | null>(null);
  const dispatchPartId = ref<string | null>(null);
  // 2026-07-17：useShelfProcessFilter 双向收窄货架/工序下拉
  const {
    filteredShelves,
    filteredProcesses,
    load: loadShelfProcessMap,
  } = useShelfProcessFilter(shelves, processes, dispatchShelfId, dispatchNextProcessId);

  // 2026-09-26（B 任务）：单件 cnc mutation —— PENDING → PROGRAMMING。
  // mutationFn / onSuccess / onError 三段对齐原 onDispatchConfirm 内的 cn c 分支。
  const sendToProgrammingMutation = useMutation<unknown, Error, { partId: string }>({
    mutationKey: ['parts', 'dispatch', 'send-to-programming'],
    mutationFn: ({ partId }) => sendToProgramming(partId),
    onSuccess: () => {
      ElMessage.success('已发送至 CNC 编程');
      qc.invalidateQueries({ queryKey: qk.partsPrefix });
    },
    onError: async (e, { partId }) => {
      const handled = await handleProcessChainRequired(e, partId, router);
      if (!handled) ElMessage.error(e.message ?? '下发失败');
    },
  });

  // 2026-09-26（B 任务）：单件直发 mutation —— PENDING → ON_SHELF。
  const placeOnShelfMutation = useMutation<
    unknown,
    Error,
    { partId: string; shelfId: string; nextProcessId: string }
  >({
    mutationKey: ['parts', 'dispatch', 'place-on-shelf'],
    mutationFn: ({ partId, shelfId, nextProcessId }) =>
      placeOnShelf(partId, shelfId, nextProcessId),
    onSuccess: () => {
      ElMessage.success('下发成功');
      qc.invalidateQueries({ queryKey: qk.partsPrefix });
    },
    onError: async (e, { partId }) => {
      const handled = await handleProcessChainRequired(e, partId, router);
      if (!handled) ElMessage.error(e.message ?? '下发失败');
    },
  });

  const dispatchSubmitting = computed<boolean>(
    () => sendToProgrammingMutation.isPending.value || placeOnShelfMutation.isPending.value,
  );

  async function onDispatch(row: PartListItem): Promise<void> {
    dispatchPartId.value = row.id;
    dispatchShelfId.value = null;
    dispatchNextProcessId.value = null;
    dispatchMode.value = 'direct';
    await reloadShelves();
    // processes 走共享 useQuery，自动 fetch，弹窗打开时可能仍在加载；
    // 原代码此处 setTimeout 不存在，弹窗打开即可观察下拉选项（listProcesses 返回
    // 已 cached 时无 loading 感知；uncached 时下拉会闪一下空）。
    dispatchVisible.value = true;
    // 2026-07-17：弹窗打开后异步加载映射（不阻塞 dialog 出现）
    void loadShelfProcessMap();
  }

  function onDispatchClosed(): void {
    dispatchPartId.value = null;
    dispatchShelfId.value = null;
    dispatchNextProcessId.value = null;
    dispatchMode.value = 'direct';
  }

  async function onDispatchConfirm(): Promise<void> {
    if (!dispatchPartId.value) return;
    if (dispatchMode.value === 'direct' && (!dispatchShelfId.value || !dispatchNextProcessId.value))
      return;
    // mutation 内已 onSuccess 关闭 dialog + ElMessage + invalidate；这里只触发 mutation。
    if (dispatchMode.value === 'cnc') {
      sendToProgrammingMutation.mutate({ partId: dispatchPartId.value });
    } else {
      placeOnShelfMutation.mutate({
        partId: dispatchPartId.value,
        shelfId: dispatchShelfId.value!,
        nextProcessId: dispatchNextProcessId.value!,
      });
    }
    // 关闭 dialog 立即可见；mutation 异步进行中。
    dispatchVisible.value = false;
  }

  // ============ 批量下发 ============
  // 状态完全独立于单件下发（batchDispatchShelfId / batchDispatchNextProcessId），避免互相踩。
  const batchDispatchVisible = ref(false);
  const batchDispatchAction = ref<'shelf' | 'programming'>('shelf');
  const batchDispatchShelfId = ref<string | null>(null);
  const batchDispatchNextProcessId = ref<string | null>(null);
  const {
    filteredShelves: batchFilteredShelves,
    filteredProcesses: batchFilteredProcesses,
    load: loadBatchShelfProcessMap,
  } = useShelfProcessFilter(shelves, processes, batchDispatchShelfId, batchDispatchNextProcessId);

  // 2026-09-26（B 任务）：批量下发 mutation —— 内部循环 targets 顺序 await。
  // 返回 { succeeded, failed } —— 失败件留对话框（onSuccess 据此分支：全成功才关闭）。
  // mutationKey 共享 ['parts', 'dispatch']，devtools 可聚合观察。
  interface BatchDispatchVars {
    action: 'shelf' | 'programming';
    targets: { id: string; label: string }[];
    shelfId: string | null;
    nextProcessId: string | null;
  }
  interface BatchDispatchResult {
    succeeded: { id: string; label: string }[];
    failed: { id: string; label: string; message: string; processChainHit: boolean }[];
  }
  const batchDispatchMutation = useMutation<BatchDispatchResult, Error, BatchDispatchVars>({
    mutationKey: ['parts', 'dispatch', 'batch'],
    mutationFn: async ({ action, targets, shelfId, nextProcessId }) => {
      const succeeded: BatchDispatchResult['succeeded'] = [];
      const failed: BatchDispatchResult['failed'] = [];
      let processChainRequiredHit = false;
      for (const t of targets) {
        if (processChainRequiredHit) break;
        try {
          if (action === 'programming') {
            await sendToProgramming(t.id);
          } else {
            await placeOnShelf(t.id, shelfId!, nextProcessId!);
          }
          succeeded.push(t);
        } catch (e) {
          const isProcessChain =
            (e as { code?: number }).code === 20706 ||
            (typeof e === 'object' &&
              e !== null &&
              'code' in e &&
              (e as { code: number }).code === 20706);
          if (isProcessChain) {
            processChainRequiredHit = true;
            failed.push({
              id: t.id,
              label: t.label,
              message: (e as Error).message ?? '请先制定工序链',
              processChainHit: true,
            });
            // 20706 单独弹确认框（与原 onBatchDispatchConfirm 行为一致）
            const handled = await handleProcessChainRequired(e, t.id, router);
            if (!handled) {
              // 已 cancel —— 不再 break，留 failed 但不再触发弹框
            }
            break;
          }
          failed.push({
            id: t.id,
            label: t.label,
            message: (e as Error).message ?? '未知错误',
            processChainHit: false,
          });
        }
      }
      return { succeeded, failed };
    },
    onSuccess: (res) => {
      // 成功项：移出三个状态源（selectedIds / selectedRowTypes / selectedRows）
      const tbl = deps.getTable();
      for (const t of res.succeeded) {
        deps.selectedIds.delete(t.id);
        deps.selectedRowTypes.delete(t.id);
        const row = deps.selectedRows.value.find((r) => r.id === t.id);
        if (tbl && row) tbl.toggleRowSelection(row, false);
      }
      if (res.succeeded.length > 0) {
        deps.selectedRows.value = deps.selectedRows.value.filter(
          (r) => !res.succeeded.some((s) => s.id === r.id),
        );
        ElMessage.success(`成功下发 ${res.succeeded.length} 件`);
      }
      // 失败 toast（20706 已经在 mutationFn 里弹过确认框 + 跳转，toast 简化为「部分失败」）
      if (res.failed.length > 0) {
        ElMessage.error(
          `失败 ${res.failed.length} 件：${res.failed
            .map((f) => `${f.label}（${f.message}）`)
            .join('；')}`,
        );
      }
      // 全部成功才关闭对话框（保留原"失败件留对话框"语义）
      if (res.failed.length === 0) {
        batchDispatchVisible.value = false;
      }
      qc.invalidateQueries({ queryKey: qk.partsPrefix });
    },
    onError: (e) => {
      // mutationFn 本身不抛错（try/catch 收口），这里兜底异常路径
      ElMessage.error(e.message ?? '批量下发失败');
    },
  });

  const batchDispatchSubmitting = computed<boolean>(
    () => batchDispatchMutation.isPending.value,
  );

  async function onOpenBatchDispatch(): Promise<void> {
    if (deps.selectedIds.size === 0) {
      ElMessage.warning('请先选择待下发零件');
      return;
    }
    batchDispatchAction.value = 'shelf';
    batchDispatchShelfId.value = null;
    batchDispatchNextProcessId.value = null;
    await reloadShelves();
    void loadBatchShelfProcessMap();
    batchDispatchVisible.value = true;
  }

  async function onBatchDispatchConfirm(): Promise<void> {
    if (deps.selectedIds.size === 0) return;
    if (
      batchDispatchAction.value === 'shelf' &&
      (!batchDispatchShelfId.value || !batchDispatchNextProcessId.value)
    )
      return;
    // 快照：迭代过程中会修改 selectedIds/selectedRows
    const targets = deps.selectedRows.value
      .filter((r) => deps.selectedIds.has(r.id))
      .map((r) => ({ id: r.id, label: r.serial_no || r.drawing_no || r.id }));
    if (targets.length === 0) {
      ElMessage.warning('当前页没有已选零件，请翻到已选页或重新选择');
      return;
    }

    batchDispatchMutation.mutate({
      action: batchDispatchAction.value,
      targets,
      shelfId: batchDispatchShelfId.value,
      nextProcessId: batchDispatchNextProcessId.value,
    });
  }

  // ============ 召回（2026-08-05）============
  // 2026-09-26：消费侧禁止解构 store（沿 usePartsListStore 不变量 #3），统一 auth.xxx。
  const auth = useAuthStore();
  // 2026-08-05 召回权限：与后端 POST /parts/{id}/recall-* 一致
  const canRecallToPendingAuth = auth.hasRole('MANAGER') || auth.hasRole('CLERK');
  const canRecallToProgrammingAuth = auth.hasRole('MANAGER') || auth.hasRole('CNC_PROGRAMMER');

  /** 召回按钮可见性：与后端 `_resolve_target_batch` expect 保持一致。
   *  不显式判定 status=='PROGRAMMING'：PROGRAMMING 是 PROGRAMMING DB status；
   *  行 location 在该态下为 'OFFICE'，自然被排除。 */
  function canRecallToPending(row: PartListItem): boolean {
    if (!canRecallToPendingAuth) return false;
    if (row.row_type === 'ASSEMBLY') return false;
    if (row.status === 'PROGRAMMING') return true;
    return row.status === 'IN_PROCESS' && row.location === 'PRODUCTION_SHELF';
  }

  function canRecallToProgramming(row: PartListItem): boolean {
    if (!canRecallToProgrammingAuth) return false;
    if (row.row_type === 'ASSEMBLY') return false;
    return row.status === 'IN_PROCESS' && row.location === 'PRODUCTION_SHELF';
  }

  // 2026-09-26（B 任务）：recallToPending mutation —— onSuccess 提示 + invalidate。
  const recallToPendingMutation = useMutation<
    unknown,
    Error,
    { rowId: string; batchId: string | null }
  >({
    mutationKey: ['parts', 'dispatch', 'recall-to-pending'],
    mutationFn: ({ rowId, batchId }) => recallToPending(rowId, { batch_id: batchId }),
    onSuccess: () => {
      ElMessage.success('已召回为待生产');
      qc.invalidateQueries({ queryKey: qk.partsPrefix });
    },
    onError: (e) => {
      ElMessage.error(e.message ?? '召回失败');
    },
  });

  // 2026-09-26（B 任务）：recallToProgramming mutation。
  const recallToProgrammingMutation = useMutation<
    unknown,
    Error,
    { rowId: string; batchId: string | null }
  >({
    mutationKey: ['parts', 'dispatch', 'recall-to-programming'],
    mutationFn: ({ rowId, batchId }) => recallToProgramming(rowId, { batch_id: batchId }),
    onSuccess: () => {
      ElMessage.success('已召回为待编程');
      qc.invalidateQueries({ queryKey: qk.partsPrefix });
    },
    onError: (e) => {
      ElMessage.error(e.message ?? '召回失败');
    },
  });

  async function onRecallToPending(row: PartListItem): Promise<void> {
    const label = row.serial_no || row.drawing_no || row.id;
    try {
      await ElMessageBox.confirm(`确认召回「${label}」为待生产？`, '召回确认', {
        type: 'warning',
        confirmButtonText: '确认召回',
        cancelButtonText: '取消',
      });
    } catch {
      // 用户取消
      return;
    }
    recallToPendingMutation.mutate({ rowId: row.id, batchId: row.batch_id ?? null });
  }

  async function onRecallToProgramming(row: PartListItem): Promise<void> {
    const label = row.serial_no || row.drawing_no || row.id;
    try {
      await ElMessageBox.confirm(`确认召回「${label}」为待编程？`, '召回确认', {
        type: 'warning',
        confirmButtonText: '确认召回',
        cancelButtonText: '取消',
      });
    } catch {
      // 用户取消
      return;
    }
    recallToProgrammingMutation.mutate({ rowId: row.id, batchId: row.batch_id ?? null });
  }

  return {
    // 共享数据
    shelves,
    processes,
    processesLoading,
    reloadShelves,
    // 单件下发
    dispatchVisible,
    dispatchMode,
    dispatchShelfId,
    dispatchNextProcessId,
    dispatchPartId,
    dispatchSubmitting,
    filteredShelves,
    filteredProcesses,
    onDispatch,
    onDispatchClosed,
    onDispatchConfirm,
    // 批量下发
    batchDispatchVisible,
    batchDispatchAction,
    batchDispatchShelfId,
    batchDispatchNextProcessId,
    batchDispatchSubmitting,
    batchFilteredShelves,
    batchFilteredProcesses,
    onOpenBatchDispatch,
    onBatchDispatchConfirm,
    // 召回
    canRecallToPending,
    canRecallToProgramming,
    onRecallToPending,
    onRecallToProgramming,
  };
}
