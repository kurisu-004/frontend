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
//
// 2026-09-29 清理：「编程中」入口下线 —— 删除 sendToProgramming / recallToProgramming
// 相关 mutation、function、按钮展示条件。原单件 cnc 模式（dispatchMode='cnc'）与
// 批量编程 action（batchDispatchAction='programming'）一并移除，批量 action 仅
// 保留 'shelf'。CNC 编程主入口迁到「待编程一览」Tab 页。
//
// 2026-10-02 已知缺口（**2026-10-03 订正，仍未修**）：place-on-shelf /
// recall-to-pending 迁 prod 域后以**批次**为锚，而本页拿不到批次锚点：
//   - 数据源：零件一览页自 2026-09-29 起读 `GET /api/v2/com/union-list`
//     （`usePartsListQuery` 内的 `listUnionItems`，queryKey `qk.unionList`），
//     出参复用 part 域 `PartListItem`（union-list 与 `GET /parts` 是同一个 VO）。
//   - 后端已明确**不会**给这类 part 级行填批次 id：`PartListItem.batch_id` /
//     `batch_version` 的填充口径是「仅 pickable-by-work-type 填，其余路径恒 null」
//     （backend-rust `PartListItem` 字段注释）。理由是 part 级行的单位是 part，
//     而一个 part 的活跃批次可能不止一个，填任意一个都是**错锚点** —— 拿它发写请求
//     会在 422 / 版本冲突之外制造更难定位的错批次流转。⇒ 这是后端的**有意决策**，
//     不是「等后端补字段」。
//   - 因此解阻塞需要**新的后端决策**（给 part 级列表提供一个批次锚点，或让该操作走
//     按批次寻址的路径），**不是**前端接线就能解决的。
// 在此之前保持既有行为：不用 part_id 顶替（会打成后端「批次不存在」），直接抛
// *_NO_BATCH_HINT 显式报错，让用户知道是数据缺口而不是随机失败。

import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useQueryClient, useMutation } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { placeOnShelf, recallToPending, forceCompletePart } from '@/api/parts';
import { listShelves } from '@/api/shelves';
import type { Shelf } from '@/types/shelf';
import type { Process } from '@/types/process';
import type { PartListItem } from '@/types/parts';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { qk } from '@/composables/queries/keys';
import { useConfirm } from '@/composables/useConfirm';
import { usePermissions } from '@/composables/usePermissions';
// 2026-09-26：迁移到 Pinia store useAuthStore（替代原 useAuthSession 模块级单例）。
import { useAuthStore } from '@/stores/auth';
import { handleProcessChainRequired } from '@/composables/useProcessChainRequiredHandler';

/** 2026-10-02：列表行缺活跃批次 id 时的统一提示（见文件头「已知缺口」）。 */
const PLACE_ON_SHELF_NO_BATCH_HINT = '该零件的批次信息缺失，无法下发（列表接口未返回批次）';
const RECALL_NO_BATCH_HINT = '该零件的批次信息缺失，无法召回（列表接口未返回批次）';
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

/** 2026-09-21 显式返回类型。
 *  2026-09-29：移除 dispatchMode 编程分支（'cnc' 不再使用，固定 'direct'）；移除
 *  batchDispatchAction 编程分支（'programming' 不再使用，固定 'shelf'）；移除
 *  canRecallToProgramming / onRecallToProgramming（CNC 编程入口已迁出零件一览）。 */
export interface UsePartDispatchReturn {
  shelves: Ref<Shelf[]>;
  processes: ComputedRef<Process[]>;
  processesLoading: Ref<boolean>;
  /** 2026-09-26（B 任务）：重新加载 shelves（单件 / 批量下发共用缓存）；
   *  内部暴露以便 caller 在必要时强制刷新（默认 onMounted/onDispatch 时已经按需加载）。 */
  reloadShelves: () => Promise<void>;
  /** 2026-09-29：单件下发对话框可见性（2026-09-29 后只剩 'direct' 模式，dispatchMode 字段已移除） */
  dispatchVisible: Ref<boolean>;
  dispatchShelfId: Ref<string | null>;
  dispatchNextProcessId: Ref<string | null>;
  dispatchPartId: Ref<string | null>;
  dispatchSubmitting: ComputedRef<boolean>;
  filteredShelves: ComputedRef<readonly Shelf[]>;
  filteredProcesses: ComputedRef<readonly Process[]>;
  onDispatch: (row: PartListItem) => Promise<void>;
  onDispatchClosed: () => void;
  onDispatchConfirm: () => Promise<void>;
  /** 2026-09-29：批量下发对话框可见性（2026-09-29 后只剩 'shelf' action） */
  batchDispatchVisible: Ref<boolean>;
  batchDispatchShelfId: Ref<string | null>;
  batchDispatchNextProcessId: Ref<string | null>;
  batchDispatchSubmitting: ComputedRef<boolean>;
  batchFilteredShelves: ComputedRef<readonly Shelf[]>;
  batchFilteredProcesses: ComputedRef<readonly Process[]>;
  onOpenBatchDispatch: () => Promise<void>;
  onBatchDispatchConfirm: () => Promise<void>;
  canRecallToPending: (row: PartListItem) => boolean;
  onRecallToPending: (row: PartListItem) => Promise<void>;
  /** 2026-09-30 新增：MANAGER 专属「完成」按钮（强制完成工单+所有非取消批次为 COMPLETED）。 */
  forceCompletingMap: Record<string, boolean>;
  canForceComplete: (row: PartListItem) => boolean;
  onForceComplete: (row: PartListItem) => Promise<void>;
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
  // description / color 对齐后端 skip_serializing_if 后是 `string | null | undefined`，
  // processSchema (Zod) 派生字段是 optional，而 Process 业务类型是 required，TS 结构
  // 子类型不匹配。沿 ProcessTab.vue 同模式走 `as Process[]` 桥接，
  // 渲染层（useShelfProcessFilter 等）已有 `?? null` / `?? '#ddd'` 等 nullish 兜底同时覆盖
  // null + undefined，零行为差异。
  const processes = computed<Process[]>(() => (procQuery.data.value?.items ?? []) as Process[]);
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
  // 2026-09-29：dispatchMode='cnc' 分支删除（sendToProgramming 下线），单件对话框
  // 仅支持 'direct'（直接下生产货架）。
  const dispatchVisible = ref(false);
  const dispatchShelfId = ref<string | null>(null);
  const dispatchNextProcessId = ref<string | null>(null);
  const dispatchPartId = ref<string | null>(null);
  /** 2026-10-02：place-on-shelf 的批次锚点。零件一览行只有在外协报价选件场景才带
   *  `batch_id`（`GET /parts` 列表项不含活跃批次 id），故此处可能为 null。 */
  const dispatchBatchId = ref<string | null>(null);
  // 2026-07-17：useShelfProcessFilter 双向收窄货架/工序下拉
  const { filteredShelves, filteredProcesses } = useShelfProcessFilter(
    shelves,
    processes,
    dispatchShelfId,
    dispatchNextProcessId,
  );

  // 2026-09-26（B 任务）：单件直发 mutation —— PENDING → ON_SHELF。
  // 2026-10-02：place-on-shelf 迁 prod 域并以批次为锚（batch_id 是路径参数），
  // 故 vars 同时带 partId（工艺链兜底跳转用）与 batchId（端点锚点）。
  const placeOnShelfMutation = useMutation<
    unknown,
    Error,
    { partId: string; batchId: string | null; shelfId: string; nextProcessId: string }
  >({
    mutationKey: ['parts', 'dispatch', 'place-on-shelf'],
    mutationFn: ({ batchId, shelfId, nextProcessId }) => {
      if (!batchId) throw new Error(PLACE_ON_SHELF_NO_BATCH_HINT);
      return placeOnShelf(batchId, { shelf_id: shelfId, next_process_id: nextProcessId });
    },
    onSuccess: () => {
      ElMessage.success('下发成功');
      qc.invalidateQueries({ queryKey: qk.partsPrefix });
    },
    onError: async (e, { partId }) => {
      const handled = await handleProcessChainRequired(e, partId, router);
      if (!handled) ElMessage.error(e.message ?? '下发失败');
    },
  });

  const dispatchSubmitting = computed<boolean>(() => placeOnShelfMutation.isPending.value);

  async function onDispatch(row: PartListItem): Promise<void> {
    dispatchPartId.value = row.id;
    dispatchBatchId.value = row.batch_id ?? null;
    dispatchShelfId.value = null;
    dispatchNextProcessId.value = null;
    await reloadShelves();
    // processes 走共享 useQuery，自动 fetch，弹窗打开时可能仍在加载；
    // 原代码此处 setTimeout 不存在，弹窗打开即可观察下拉选项（listProcesses 返回
    // 已 cached 时无 loading 感知；uncached 时下拉会闪一下空）。
    dispatchVisible.value = true;
    // 2026-10-02：不再显式 load() —— 映射由共享 query 跟随 shelves / processes 就绪
    // 自动开闸（reloadShelves() 返回后 shelves 非空即开闸）。
  }

  function onDispatchClosed(): void {
    dispatchPartId.value = null;
    dispatchBatchId.value = null;
    dispatchShelfId.value = null;
    dispatchNextProcessId.value = null;
  }

  async function onDispatchConfirm(): Promise<void> {
    if (!dispatchPartId.value) return;
    if (!dispatchShelfId.value || !dispatchNextProcessId.value) return;
    placeOnShelfMutation.mutate({
      partId: dispatchPartId.value,
      batchId: dispatchBatchId.value,
      shelfId: dispatchShelfId.value,
      nextProcessId: dispatchNextProcessId.value,
    });
    // 关闭 dialog 立即可见；mutation 异步进行中。
    dispatchVisible.value = false;
  }

  // ============ 批量下发 ============
  // 2026-09-29：batchDispatchAction 字段删除（'programming' 不再支持），批量只走
  // placeOnShelf（直接下生产货架）。
  const batchDispatchVisible = ref(false);
  const batchDispatchShelfId = ref<string | null>(null);
  const batchDispatchNextProcessId = ref<string | null>(null);
  const { filteredShelves: batchFilteredShelves, filteredProcesses: batchFilteredProcesses } =
    useShelfProcessFilter(shelves, processes, batchDispatchShelfId, batchDispatchNextProcessId);

  // 2026-09-26（B 任务）→ 2026-09-29 简化：批量下发 mutation —— 内部循环 targets 顺序 await，
  // 全部走 placeOnShelf（不再有 action 分支）。返回 { succeeded, failed } —— 失败件留
  // 对话框（onSuccess 据此分支：全成功才关闭）。
  interface BatchDispatchVars {
    targets: { id: string; label: string; batchId: string | null }[];
    shelfId: string;
    nextProcessId: string;
  }
  interface BatchDispatchResult {
    succeeded: { id: string; label: string }[];
    failed: { id: string; label: string; message: string; processChainHit: boolean }[];
  }
  const batchDispatchMutation = useMutation<BatchDispatchResult, Error, BatchDispatchVars>({
    mutationKey: ['parts', 'dispatch', 'batch'],
    mutationFn: async ({ targets, shelfId, nextProcessId }) => {
      const succeeded: BatchDispatchResult['succeeded'] = [];
      const failed: BatchDispatchResult['failed'] = [];
      let processChainRequiredHit = false;
      for (const t of targets) {
        if (processChainRequiredHit) break;
        try {
          if (!t.batchId) throw new Error(PLACE_ON_SHELF_NO_BATCH_HINT);
          await placeOnShelf(t.batchId, { shelf_id: shelfId, next_process_id: nextProcessId });
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

  const batchDispatchSubmitting = computed<boolean>(() => batchDispatchMutation.isPending.value);

  async function onOpenBatchDispatch(): Promise<void> {
    if (deps.selectedIds.size === 0) {
      ElMessage.warning('请先选择待下发零件');
      return;
    }
    batchDispatchShelfId.value = null;
    batchDispatchNextProcessId.value = null;
    await reloadShelves();
    batchDispatchVisible.value = true;
    // 2026-10-02：不再显式 load() —— 与单件下发共用同一份共享 query 缓存
    // （同一常量 queryKey），单件下发先开过闸后本对话框直接命中。
  }

  async function onBatchDispatchConfirm(): Promise<void> {
    if (deps.selectedIds.size === 0) return;
    if (!batchDispatchShelfId.value || !batchDispatchNextProcessId.value) return;
    // 快照：迭代过程中会修改 selectedIds/selectedRows
    const targets = deps.selectedRows.value
      .filter((r) => deps.selectedIds.has(r.id))
      .map((r) => ({
        id: r.id,
        label: r.serial_no || r.drawing_no || r.id,
        batchId: r.batch_id ?? null,
      }));
    if (targets.length === 0) {
      ElMessage.warning('当前页没有已选零件，请翻到已选页或重新选择');
      return;
    }

    batchDispatchMutation.mutate({
      targets,
      shelfId: batchDispatchShelfId.value,
      nextProcessId: batchDispatchNextProcessId.value,
    });
  }

  // ============ 召回（2026-08-05）============
  // 2026-09-26：消费侧禁止解构 store（沿 usePartsListStore 不变量 #3），统一 auth.xxx。
  // 2026-09-29：删除 canRecallToProgramming / onRecallToProgramming（CNC 编程入口
  // 已迁出零件一览，recallToProgramming 后端端点 404 下线）。仅保留
  // canRecallToPending / onRecallToPending。
  const auth = useAuthStore();
  // 2026-08-05 召回权限：与后端 POST /parts/{id}/recall-* 一致
  const canRecallToPendingAuth = auth.hasRole('MANAGER') || auth.hasRole('CLERK');

  /** 召回按钮可见性：与后端 `_resolve_target_batch` expect 保持一致。
   *  不显式判定 status=='PROGRAMMING'：PROGRAMMING 是 PROGRAMMING DB status；
   *  行 location 在该态下为 'OFFICE'，自然被排除。 */
  function canRecallToPending(row: PartListItem): boolean {
    if (!canRecallToPendingAuth) return false;
    if (row.row_type === 'ASSEMBLY') return false;
    // 2026-09-29：history PROGRAMMING 状态零件仍可走「召回(待生产)」路径，与原行为兼容。
    if (row.status === 'PROGRAMMING') return true;
    return row.status === 'IN_PROCESS' && row.location === 'PRODUCTION_SHELF';
  }

  // 2026-09-26（B 任务）：recallToPending mutation —— onSuccess 提示 + invalidate。
  const recallToPendingMutation = useMutation<
    unknown,
    Error,
    { rowId: string; batchId: string | null }
  >({
    mutationKey: ['parts', 'dispatch', 'recall-to-pending'],
    // 2026-10-02：recall-to-pending 迁 prod 域并以批次为锚（batch_id 是路径参数，
    // 缺省按活跃批次猜唯一者的旧语义已下线）。
    mutationFn: ({ batchId }) => {
      if (!batchId) throw new Error(RECALL_NO_BATCH_HINT);
      return recallToPending(batchId);
    },
    onSuccess: () => {
      ElMessage.success('已召回为待生产');
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

  // ============ 强制完成（2026-09-30）============
  // 系统管理员专属：绕过状态机把工单+所有非取消批次置为 COMPLETED。
  // 守卫 canForceComplete 收口角色 + row_type + status 三个维度：
  //   - isManager：仅 MANAGER 可见 / 可点；
  //   - row.row_type !== 'ASSEMBLY'：装配件无独立批次完成语义（待与后端契约确认）；
  //   - 非 COMPLETED / 非 CANCELLED：终态不可二次强制完成，避免日志噪声 + 避免
  //     与既有 cancelPart 路径冲突（取消件不强制回到已完成）。
  const confirm = useConfirm();
  const { isManager } = usePermissions();

  function canForceComplete(row: PartListItem): boolean {
    if (!isManager.value) return false;
    if (row.row_type === 'ASSEMBLY') return false;
    if (row.status === 'COMPLETED') return false;
    if (row.status === 'CANCELLED') return false;
    return true;
  }

  // 2026-09-30 新增：per-row loading map（参考 DeliveryNoteList.deliveringMap
  // 同款 reactive<Record<string, boolean>> 模式；本件 usePartDispatch 内部首次引入
  // 该模式——之前 placeOnShelf / recallToPending 仅用 dispatchSubmitting /
  // batchDispatchSubmitting 单 bool，不存在同款 map。命名 forceCompletingMap
  // 与按钮文案「完成」对齐）。
  const forceCompletingMap = reactive<Record<string, boolean>>({});

  const forceCompleteMutation = useMutation<
    unknown,
    Error,
    { partId: string; note: string | null }
  >({
    mutationKey: ['parts', 'dispatch', 'force-complete'],
    mutationFn: ({ partId, note }) => forceCompletePart(partId, { note }),
    onMutate: ({ partId }) => {
      forceCompletingMap[partId] = true;
    },
    onSettled: (_d, _e, { partId }) => {
      // 2026-09-30 修复：用 delete 而非 = false，避免 map 累积 stale key
      // （沿 DeliveryNoteList.vue:371 deliveringMap 清理范本）。
      delete forceCompletingMap[partId];
    },
    onSuccess: () => {
      ElMessage.success('已强制完成');
      void qc.invalidateQueries({ queryKey: qk.partsPrefix });
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '强制完成失败'),
  });

  async function onForceComplete(row: PartListItem): Promise<void> {
    // 2026-09-30 修复：label fallback 与 onRecallToPending 保持一致
    // （serial_no || drawing_no || row.id），不引入 order_no —— order_no 是
    // PR-F 2026-07-17 命名的「送货单号」，非工单号，不应出现在工单级确认文案里。
    const label = row.serial_no || row.drawing_no || row.id;
    // 2026-09-30 修复：移除 batchCount —— batch_no 是 per-part 递增的批次序号
    // （types/parts.ts:191），不是批次数。弹窗文案不再含具体批次数，仅承诺
    // 「所有非取消批次」，与后端 force-complete 端点语义一致。
    const ok = await confirm.dangerous(
      '强制完成工单',
      `将强制把工单「${label}」及其所有非取消批次置为已完成。\n` +
        `此操作绕过状态机（仅排除已取消批次），要求非 COMPLETED / 非 CANCELLED 状态。\n` +
        `仅系统管理员可执行，且不可撤销。是否继续？`,
      { confirmText: '确认完成', cancelText: '取消', type: 'warning' },
    );
    if (!ok) return;
    forceCompleteMutation.mutate({ partId: row.id, note: null });
  }

  return {
    // 共享数据
    shelves,
    processes,
    processesLoading,
    reloadShelves,
    // 单件下发（2026-09-29 后只剩 'direct' 模式，dispatchMode 字段已移除）
    dispatchVisible,
    dispatchShelfId,
    dispatchNextProcessId,
    dispatchPartId,
    dispatchSubmitting,
    filteredShelves,
    filteredProcesses,
    onDispatch,
    onDispatchClosed,
    onDispatchConfirm,
    // 批量下发（2026-09-29 后只剩 'shelf' action，batchDispatchAction 字段已移除）
    batchDispatchVisible,
    batchDispatchShelfId,
    batchDispatchNextProcessId,
    batchDispatchSubmitting,
    batchFilteredShelves,
    batchFilteredProcesses,
    onOpenBatchDispatch,
    onBatchDispatchConfirm,
    // 召回（2026-09-29：仅保留 recall-to-pending）
    canRecallToPending,
    onRecallToPending,
    // 强制完成（2026-09-30：MANAGER 专属）
    forceCompletingMap,
    canForceComplete,
    onForceComplete,
  };
}
