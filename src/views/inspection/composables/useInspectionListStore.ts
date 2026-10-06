// views/inspection/composables/useInspectionListStore.ts
//
// 2026-10-03 新增：待品检一览页的 Pinia setup store。替代 2026-08-25 的
// `useInspectionList`（fetcher 闭包 + `<ListShell>` 内部分页）旧范式，改为
// useQuery + queryKey 工厂 + Zod 守门 + enabled 闸门（CLAUDE.md 硬约束）。
//
// 迁移动机（两条独立理由，缺一条都不该做这次改造）：
//   1. 数据新鲜度：`ListShell` 的分页 / 勾选 / 排序是**本地**状态机（每次翻页重发
//      请求、无缓存、无失效点），品检流转（品检通过 / 指定工序 / 送检）后只能
//      靠各处的 `fetchList()` 手动重拉，漏一处就展示过期队列。
//   2. 筛选范式统一：待品检页要把图号 / 名称 / 序列号 / 日期筛选搬进表头（照零件一览），
//      而 `ListShell` 的 filter 插槽与列定义（`ColumnDef.headerRender`）不在同一层，
//      表头 popover 没法挂进去。
//
// 不变量（改动前必读，照 `usePartsListStore` 抄）：
// 1. 必须在组件 setup 内首次调用 useInspectionListStore() —— 切片链路上
//    useCustomerTree / useListFilterPersist 的 onBeforeUnmount 会绑定到首个创建 store
//    的组件（= InspectionPending）。本 store 不注入子组件（表格状态由组件自己持有），
//    天然满足。组件外（路由守卫 / 其它 store）禁止首调。
// 2. InspectionPending 的 onBeforeUnmount 必须 store.$dispose()：Pinia 是单例，不 dispose
//    会把 search / sort / passingBatchId 泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 store.切片.字段 访问，
//    不写 .value（深代理自动解包）。store 内部闭包持 raw 切片，照写 .value。
// 4. 不 import vue-router：导航（详情跳 `/parts/{part_id}`）由视图侧持有 router。

import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toInspection, toProcess, toShip } from '@/api/parts';
import {
  scanInspection,
  type InspectionQueueItem,
  type ListInspectionQueueParams,
  type ScanTreeOut,
} from '@/api/inspection';
import { qk } from '@/composables/queries/keys';
import { useProductionShelvesQuery } from '@/composables/queries/useProductionShelvesQuery';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useListFilterPersist } from '@/composables/useListFilterPersist';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import {
  INSPECTION_SORT_KEY_SET,
  INSPECTION_SORT_KEY_TO_PROP,
  INSPECTION_SORT_PROP_MAP,
  type InspectionSortKey,
} from '@/types/inspection';
import type { SortDir } from '@/types/parts';
import type { Shelf } from '@/types/shelf';
import type { Process } from '@/types/process';
import { buildInspectionColumnDefs, type InspectionColumnActions } from '../inspectionColumnDefs';
import {
  useInspectionColumnFilters,
  type InspectionSearchState,
} from './useInspectionColumnFilters';
import { useInspectionQueueQuery } from './useInspectionQueueQuery';

/** 2026-10-03：品检通过（`POST /prod/batches/{batch_id}/to-ship`）的 mutation 入参。
 *  `label` 只用于拼成功提示（serial_no || drawing_no），不参与请求。 */
export interface ToShipVars {
  batchId: string;
  version: number;
  quantity: number | null;
  label: string;
}

/** 2026-10-03：指定工序（`POST /prod/batches/{batch_id}/to-process`）的 mutation 入参。
 *  `processCode` / `shelfCode` 同样只进提示文案（它们由视图从 options 里查出来）；
 *  `processName` / `shelfName` 只进扫码树写后本地回写（「工序」「当前位置」两列）。 */
export interface ToProcessVars {
  batchId: string;
  shelfId: string;
  nextProcessId: string;
  version: number;
  note: string | null;
  quantity: number | null;
  label: string;
  processCode: string;
  shelfCode: string;
  processName: string;
  shelfName: string;
}

/** 2026-10-05：送检（`POST /prod/batches/{batch_id}/to-inspection`）的 mutation 入参。
 *  `targetInspectionShelfId` 是目标品检架；`label` 只进成功提示，
 *  `targetShelfName` 只用于扫码树写后本地回写的「当前位置」列。 */
export interface ToInspectionVars {
  batchId: string;
  targetInspectionShelfId: string;
  version: number;
  quantity: number | null;
  label: string;
  targetShelfName: string;
}

/** 流转后要写进扫码树批次节点的目标列。`undefined` = 保持原值（后端该列本就未变），
 *  `null` = 清空（后端出池清了 `current_process_id` / holder 这类列）。 */
interface ScanTreeBatchTarget {
  status: string;
  location?: string | null;
  holderDisplay?: string | null;
  processName?: string | null;
}

/** 三个写端点的响应里与本地回写有关的三段。`part` 是操作后 part 的最新投影，
 *  `new_batch_id` 非 null = 走了部分流转的拆批分支，
 *  `synced_assembly_id` 非 null = 父装配件的状态被同事务内的 rollup 翻了。 */
interface ScanTreeWriteResult {
  part?: { status?: string; version?: number } | null;
  new_batch_id?: string | null;
  /** 父装配件 id（雪花字符串）；非 null = 本次流转连带翻了它的派生状态。 */
  synced_assembly_id?: string | null;
}

export const useInspectionListStore = defineStore('inspection-list', () => {
  // ⚠️ 必须在 setup 第一行捕获：Pinia 只对 store setup 包 runWithContext，action wrapper
  //   与 listener 里**没有**注入上下文，`useQueryClient()` 的 hasInjectionContext 守卫
  //   会抛（同 src/stores/auth.ts 的硬约束）。
  const qc = useQueryClient();

  // ============ 切片：search（表头筛选的唯一状态源）============
  const search = reactive<InspectionSearchState>({
    serialNo: '',
    drawingNo: '',
    name: '',
    customerId: '',
    systemDeliveryDateFrom: '',
    systemDeliveryDateTo: '',
  });

  // ============ 切片：query（分页 / 排序 / 主查询）============
  const page = ref(1);
  const pageSize = ref(20);
  // 默认排序与后端非法值退化一致：SYSTEM_DELIVERY_DATE / ASC。
  const sortBy = ref<InspectionSortKey>('SYSTEM_DELIVERY_DATE');
  const sortDir = ref<SortDir>('ASC');
  // 2026-10-03 enabled 闸门：restored 默认 false，restoreState() 末尾置 true。避免
  // 「store 实例化即用默认 search 自动 fetch + restoreState 后用持久化 search 再 fetch」
  // 的双 fetch（与 usePartsListQuery 同一设计点）。
  const restored = ref(false);
  // 自动刷新布尔（5min 轮询，由 useInspectionQueueQuery 的 refetchInterval 承担定时器；
  // 视图不自建 window 定时器）。2026-10-03 起不再持久化：旧版的持久化 deps 形如
  // { search, autoRefresh }，与新的 { search, sortBy, sortDir, pageSize } 快照 shape
  // 不兼容，恢复会整份被丢弃。
  //
  // ⚠️ 为什么放在 `ui` 切片里返回（而不是作为 store 顶层返回）：Pinia setup store
  //   登记 state 的闸门是 `(isRef(prop) && !isComputed(prop)) || isReactive(prop)`
  //   （pinia.mjs createSetupStore）。`ui` 是**普通对象**（不是 `reactive()`），既不是
  //   ref 也不是 reactive ⇒ 压根不进 `pinia.state.value[storeId]`，没有 state 可回填 ⇒
  //   同一 pinia 内 `$dispose()` 后重建拿到的是全新实例，`ui.autoRefresh` 归 false。
  //   ⚠️ 这条护栏**只对普通对象成立**：写成 `reactive()` 就会通过闸门被登记进 state，
  //   重建时走 `mergeReactiveObjects` 递归回填，内层 ref 一样会被复活。
  const uiAutoRefresh = ref(false);

  /** search + 分页 + 排序 → queryKey params 的**唯一**转换点。 */
  function buildParams(): ListInspectionQueueParams {
    return {
      // 三个 ILIKE 子串各自独立，同时传 ⇒ 后端 AND 联合。
      drawing_no: search.drawingNo.trim() || undefined,
      name: search.name.trim() || undefined,
      serial_no: search.serialNo.trim() || undefined,
      // 雪花 ID 字符串直传，禁止 Number()（19 位雪花 ID 会丢精度）。
      customer_id: search.customerId || undefined,
      system_delivery_date_from: search.systemDeliveryDateFrom || undefined,
      system_delivery_date_to: search.systemDeliveryDateTo || undefined,
      sort_by: sortBy.value,
      sort_dir: sortDir.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  // ============ 主查询 ============
  // useQuery 段外提成同域 hook（useInspectionQueueQuery）：queryKey / queryFn / Zod 守门
  // （`inspectionQueueListResultSchema.parse`）/ 轮询 / 错误桥接都在 hook 内，本 store
  // 只递 params 与两个开关（enabled 闸门 + 自动刷新）。
  const listQuery = useInspectionQueueQuery({
    params: computed(() => buildParams()),
    enabled: restored,
    autoRefresh: uiAutoRefresh,
  });
  const { fetchList } = listQuery;

  const items = computed<InspectionQueueItem[]>(() => listQuery.data.value?.items ?? []);
  // 后端 total 是 serialize_i64 的 JSON string ⇒ 边界 Number()（分页组件要 number）。
  const total = computed<number>(() => Number(listQuery.data.value?.total ?? 0));
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const emptyText = computed<string>(() => errorMsg.value ?? '当前无待品检零件');

  /** el-table 的 `default-sort` 需要 prop 名（不是后端 sort_by 键）。 */
  const defaultSort = computed<{ prop: string; order: 'ascending' | 'descending' }>(() => ({
    prop: INSPECTION_SORT_KEY_TO_PROP[sortBy.value] ?? 'system_delivery_date',
    order: sortDir.value === 'ASC' ? 'ascending' : 'descending',
  }));

  // 2026-10-03：表头筛选 confirm 的统一入口（page=1）。改 search 不动 page 的话会停在
  // 「第 5 页但只有 1 页结果」的空态。
  function onSearch(): void {
    page.value = 1;
  }

  // ============ 切片：filters（表头筛选状态机）============
  // 声明在 query 切片的 onSearch 之后：resetAllFilters 要拿它把「已确认值 + 未确认草稿 +
  // popover 打开态」一起清掉（见该函数），而 filters 的 deps 只有 search 与 onSearch。
  const filters = useInspectionColumnFilters({ search, onSearch });

  // 工具栏「重置筛选」委托给 5 个筛选状态机的 reset：每个 reset 同时清「已确认值
  // （写回 search）」「未确认草稿（draft）」「popover 打开态（visible）」。只清 search
  // 是不够的 —— popover 正开着时点重置，active 会转 false 但草稿还在，用户下次在弹窗里
  // 点「确定」又把旧值写回去。
  //
  // **保留**排序与分页大小（与 usePartsListStore.resetAllFilters 的取舍一致：排序是
  // 「视图」不是「筛选」，连带清掉会让用户每次重置都要重新点一次表头）。
  function resetAllFilters(): void {
    filters.serialNoFilter.reset();
    filters.drawingNoFilter.reset();
    filters.nameFilter.reset();
    filters.systemDateFilter.reset();
    filters.customerFilter.reset();
    page.value = 1;
  }

  function onSortChange({
    prop,
    order,
  }: {
    prop: string | null;
    order: 'ascending' | 'descending' | null;
  }): void {
    // 用户点「取消排序」（第三次点击）不改状态：保持上一次的排序继续查。
    if (!prop || !order) return;
    sortBy.value = INSPECTION_SORT_PROP_MAP[prop] ?? 'SYSTEM_DELIVERY_DATE';
    sortDir.value = order === 'ascending' ? 'ASC' : 'DESC';
    // 不手动 fetchList：queryKey 变了，useQuery 自己会 refetch。
  }

  // 持久化：筛选 / 排序 / 分页大小（**不**持久化 page —— 恢复时可能停在一个不存在的页）。
  //
  // 为什么这个 key 不会与列可见性 / 列顺序快照互相污染：三处 localStorage key 形态不同
  // （`inspection_pending_filter` vs `inspection_pending_columns` vs
  // `inspection_pending_columnOrder`），而 `useListFilterPersist.restore()` 还有一道
  // 「每个 dep key 都必须存在于快照，缺一即整份丢弃返回 null」的全键存在性校验 ——
  // 即使将来某个 key 改名撞车，也会退化成「不恢复」而不是把别的快照当筛选读进来。
  const { restore: restorePersist } = useListFilterPersist<InspectionSearchState>(
    'inspection_pending_filter',
    { search, sortBy, sortDir, pageSize },
  );

  function restoreState(): void {
    const persisted = restorePersist();
    if (persisted) {
      // lenient 逐字段恢复：`?? ` 兜底让旧快照（keyword 时代只存了 keyword/serialNo）
      // 缺失的字段落回默认值，而不是整份丢弃。
      search.serialNo = persisted.search.serialNo ?? search.serialNo;
      search.drawingNo = persisted.search.drawingNo ?? search.drawingNo;
      search.name = persisted.search.name ?? search.name;
      search.customerId = persisted.search.customerId ?? search.customerId;
      search.systemDeliveryDateFrom =
        persisted.search.systemDeliveryDateFrom ?? search.systemDeliveryDateFrom;
      search.systemDeliveryDateTo =
        persisted.search.systemDeliveryDateTo ?? search.systemDeliveryDateTo;
      // localStorage 里是 string，按合法值收敛（与后端 sort 白名单一致）。
      sortBy.value = INSPECTION_SORT_KEY_SET.has(persisted.sortBy as InspectionSortKey)
        ? (persisted.sortBy as InspectionSortKey)
        : 'SYSTEM_DELIVERY_DATE';
      sortDir.value =
        persisted.sortDir === 'ASC' || persisted.sortDir === 'DESC'
          ? (persisted.sortDir as SortDir)
          : 'ASC';
      if (typeof persisted.pageSize === 'number' && persisted.pageSize > 0) {
        pageSize.value = persisted.pageSize;
      }
    }
    // 开闸放行首屏 fetch（两条分支都要走到这里）。
    restored.value = true;
  }

  // useQuery 的错误不在 setup 抛错，由 useInspectionQueueQuery 内的 watch 桥接弹
  // ElMessage（守门点与错误桥接同在 query hook，本 store 不重复弹）。

  const query = {
    search,
    page,
    pageSize,
    sortBy,
    sortDir,
    items,
    total,
    loading,
    errorMsg,
    emptyText,
    defaultSort,
    restored,
    buildParams,
    fetchList,
    onSearch,
    onSortChange,
    resetAllFilters,
    restoreState,
  };

  // ============ 切片：mutations（品检流转写操作）============
  /** 行内按钮 loading 态锚：正在提交品检通过的行 batch_id。
   *  2026-10-03 由「往 row 对象挂 `_passing`」改成 ref —— 后者在 Pinia 响应式下会让
   *  整表数据行跟着重渲染，且数据行不该承载 UI 态。 */
  const passingBatchId = ref<string | null>(null);

  /** 写完立即失效本域（「写完看到自己那笔」的优化，非一致性保证）。 */
  function invalidateInspectionQuery(): Promise<void> {
    return qc.invalidateQueries({ queryKey: qk.inspectionPrefix }).then(() => undefined);
  }

  const toShipMutation = useMutation({
    mutationKey: ['inspection', 'to-ship'],
    mutationFn: ({ batchId, version, quantity }: ToShipVars) =>
      toShip(batchId, { version, quantity }),
    onSuccess: async (data, vars) => {
      await invalidateInspectionQuery();
      // 品检通过只翻 status（后端该分支不动 location / holder / 工序列）⇒ 目标列全留空
      // 表示「保持原值」。
      const applied = applyScanTreeTransition(
        vars.batchId,
        { status: 'READY_TO_SHIP' },
        data,
        vars.quantity,
      );
      if (scanTreeNeedsResync(data, applied)) await resyncScanTree();
      ElMessage.success(`零件 ${vars.label} 品检通过${vars.quantity ? ` × ${vars.quantity}` : ''}`);
    },
    onError: async (e: Error & { code?: number }) => {
      if (e?.code === 40901) {
        await onOccConflict();
        return;
      }
      ElMessage.error(`品检通过失败：${e?.message ?? '未知错误'}`);
    },
  });

  const toProcessMutation = useMutation({
    mutationKey: ['inspection', 'to-process'],
    mutationFn: ({ batchId, shelfId, nextProcessId, version, note, quantity }: ToProcessVars) =>
      toProcess(batchId, {
        shelf_id: shelfId,
        next_process_id: nextProcessId,
        version,
        note,
        quantity,
      }),
    onSuccess: async (data, vars) => {
      await invalidateInspectionQuery();
      // 指定工序 = 打回生产：location 落目标生产架、holder 换成该架、工序换成下一道。
      const applied = applyScanTreeTransition(
        vars.batchId,
        {
          status: 'IN_PROCESS',
          location: 'PRODUCTION_SHELF',
          holderDisplay: vars.shelfName,
          processName: vars.processName,
        },
        data,
        vars.quantity,
      );
      if (scanTreeNeedsResync(data, applied)) await resyncScanTree();
      ElMessage.success(
        `零件 ${vars.label} 已指定下一道工序 ${vars.processCode}，放到生产货架 ${vars.shelfCode}`,
      );
    },
    onError: async (e: Error & { code?: number }) => {
      if (e?.code === 40901) {
        await onOccConflict();
        return;
      }
      ElMessage.error(`指定工序失败：${e?.message ?? '未知错误'}`);
    },
  });

  const toInspectionMutation = useMutation({
    mutationKey: ['inspection', 'to-inspection'],
    mutationFn: ({ batchId, targetInspectionShelfId, version, quantity }: ToInspectionVars) =>
      toInspection(batchId, {
        target_inspection_shelf_id: targetInspectionShelfId,
        version,
        quantity,
      }),
    onSuccess: async (data, vars) => {
      await invalidateInspectionQuery();
      // 送检 = 出池：location 落目标品检架、holder 换成该架、工序列被后端清空。
      const applied = applyScanTreeTransition(
        vars.batchId,
        {
          status: 'INSPECTION',
          location: 'INSPECTION_SHELF',
          holderDisplay: vars.targetShelfName,
          processName: null,
        },
        data,
        vars.quantity,
      );
      if (scanTreeNeedsResync(data, applied)) await resyncScanTree();
      ElMessage.success(`零件 ${vars.label} 已送检${vars.quantity ? ` × ${vars.quantity}` : ''}`);
    },
    onError: async (e: Error & { code?: number }) => {
      if (e?.code === 40901) {
        await onOccConflict();
        return;
      }
      ElMessage.error(`送检失败：${e?.message ?? '未知错误'}`);
    },
  });

  // ============ 扫码树（2026-10-05）============
  /** 扫码命中的树快照，供 `ScanTreeDialog` 渲染。null = 本次会话还没扫过码。
   *  弹窗关闭时由视图调 `clearScanTree()` 清掉：不清的话下次开弹窗会先闪出上一次的
   *  树（mutation 在飞、data 还没回来），用户会以为扫的是上一次那个条码。 */
  const scanTree = ref<ScanTreeOut | null>(null);

  function clearScanTree(): void {
    scanTree.value = null;
  }

  /** 扫码取树（`GET /prod/inspection/scan/{serial_no}`）。
   *  用 useMutation 而非 useQuery：扫码是用户触发的单次拉取，重扫同一条码必须重取
   *  （树里的批次可能已被别人流转），缓存留着反而会给出过期状态。
   *  `mutationKey` 写字面量（全仓写 mutation 一律如此，无一处从 `qk` 工厂取）：工厂项
   *  服务的是 queryKey 的缓存身份，扫码树不进任何 query 缓存，登记进去只会留下一个
   *  零消费者的死键。 */
  const scanMutation = useMutation({
    mutationKey: ['inspection', 'scan'],
    mutationFn: (serialNo: string) => scanInspection(serialNo),
    onSuccess: (data) => {
      scanTree.value = data;
    },
    // 序列号走 onError 的第二参（variables），不闭包捕获 —— 闭包里的「当前条码」在
    // 并发扫码（快速连扫）时可能是另一个条码的，提示会张冠李戴。
    onError: (e: Error & { code?: number }, serialNo: string) => {
      // 20101 = 零件 / 装配件不存在（后端查不到与空白序列号都走这一支，走 HTTP 404 +
      // 业务码信封）。这类不是「系统故障」，用 warning 而不是 error。
      if (e?.code === 20101) {
        ElMessage.warning(`未找到条码 ${serialNo} 对应的零件或装配件`);
        return;
      }
      ElMessage.error(`扫码查询失败：${e?.message ?? '未知错误'}`);
    },
  });

  const mutations = {
    passingBatchId,
    toShipMutation,
    toProcessMutation,
    toInspectionMutation,
    scanMutation,
    scanTree,
    clearScanTree,
  };

  // ============ 扫码树：写后本地回写（2026-10-05）============
  // 三个写 mutation 的 onSuccess 只失效列表前缀（键前缀 `inspection`），而扫码树是
  // 普通 ref、不在 query 缓存里 ⇒ 同一个弹窗内会一直停在流转前的状态：操作列的按钮
  // 矩阵不跟着变，用户再点一次必然 40901。这里按后端「一次流转 = 批次 version +1」的
  // 语义就地改树；部分流转（拆批）本地补不出被流转的那一行，交 resyncScanTree 重拉。

  /** 把一次流转的结果写进当前扫码树。返回 true = 调用方需要 `resyncScanTree()` 重拉。
   *
   *  拆批分支（响应 `new_batch_id` 非 null）是本地补不出来的一档：被流转的那部分落在一个
   *  **新批次**上（后端新造的 id 全程不返回，响应的 `new_batch_id` 反而是留在源状态的
   *  remainder —— 也就是本次传入的 batchId，源批次原地减量、id 不变）。故本地只回写
   *  remainder 自身（数量减、version +1，状态留在源状态），新批次行交重拉补。
   *
   *  part 节点的 status / version 直接采用响应里的 part 投影（后端 rollup 后的权威值，
   *  本地重算 min-progress 只会猜错）。 */
  function applyScanTreeTransition(
    batchId: string,
    target: ScanTreeBatchTarget,
    result: ScanTreeWriteResult,
    opQuantity: number | null,
  ): boolean {
    const tree = scanTree.value;
    if (!tree) return false;
    const partNode = tree.children.find((p) => p.children.some((b) => b.id === batchId));
    const node = partNode?.children.find((b) => b.id === batchId);
    if (partNode && result.part?.status) {
      partNode.status = result.part.status;
      if (typeof result.part.version === 'number') partNode.version = result.part.version;
    }
    if (!node) return false;
    if (result.new_batch_id) {
      node.quantity = Math.max(0, node.quantity - (opQuantity ?? 0));
      node.version += 1;
      return true;
    }
    node.status = target.status;
    node.version += 1;
    if (target.location !== undefined) node.location = target.location;
    if (target.holderDisplay !== undefined) node.current_holder_display = target.holderDisplay;
    if (target.processName !== undefined) node.process_name = target.processName;
    return false;
  }

  /** 这次写完之后扫码树要不要重拉。两档本地补不出来：
   *  1. 拆批 —— 新批次行（含新 id）只能从后端拿；
   *  2. 父装配件被级联翻了状态（`synced_assembly_id` 非 null）—— 回写只覆盖树里的
   *     零件 / 批次两层，装配件根行的状态列不在其中，不重拉就会一直显示流转前的旧值。 */
  function scanTreeNeedsResync(result: ScanTreeWriteResult, splitHandled: boolean): boolean {
    return splitHandled || Boolean(result.synced_assembly_id);
  }

  /** 按当前树的条码重拉一次（拆批后补新批次行 / 装配件级联改状态 / 树与后端已经对不齐
   *  时的兜底）。失败不抛：扫码端点的错误提示由 `scanMutation.onError` 弹，这里保持
   *  已回写的树不丢。 */
  async function resyncScanTree(): Promise<void> {
    const serialNo = scanTree.value?.scanned_serial_no;
    if (!serialNo) return;
    try {
      await scanMutation.mutateAsync(serialNo);
    } catch {
      // 已在 onError 提示过；这里吞掉不让写 mutation 的 onSuccess 变成失败。
    }
  }

  /** 40901（`t_part_batch.version` 不匹配 = 批次在扫码之后被别人流转过）的统一处理，
   *  三个写端点共用。
   *
   *  树上有人操作时**必须同时重拉扫码树**：树弹窗是 fullscreen、没有「刷新」按钮，
   *  而且开着时扫码会被守卫丢弃 —— 只刷列表的话树上那行还是旧 version，用户再点一次
   *  必然再次 40901（提示里说「请刷新后重试」，界面上却没有可刷新的入口）。
   *  列表页直接操作（没有树）时照旧只刷列表，那条路径上有工具栏的「刷新」按钮。
   *
   *  无递归：这里只经 `scanMutation` 一条路走（成功写 scanTree / 失败弹提示），
   *  不回调三个写 mutation 的 onSuccess ⇒ 与 applyScanTreeTransition 无环。 */
  async function onOccConflict(): Promise<void> {
    const treeOpen = scanTree.value !== null;
    ElMessage.warning(
      treeOpen ? '该批次已被他人修改，扫码树已刷新，请重新操作' : '该批次已被他人修改，请刷新后重试',
    );
    if (treeOpen) await resyncScanTree();
    await fetchList();
  }

  // ============ 切片：options（弹窗下拉的候选数据）============
  // 2026-10-03：替代旧版视图里的 3 处裸调（listShelves ×2 + listProcesses）——
  // 货架 / 工序是典型基础数据（跨页面共用），按 CLAUDE.md 两层架构归共享层 query。
  // 两个 zone 各开一个 useProductionShelvesQuery：queryKey 带 params，天然分两份缓存。
  const inspectionShelvesQuery = useProductionShelvesQuery({
    zone: 'INSPECTION',
    is_active: true,
    limit: 200,
  });
  const productionShelvesQuery = useProductionShelvesQuery({
    zone: 'PRODUCTION',
    is_active: true,
    limit: 200,
  });
  const processesQuery = useProcessesQuery({ limit: 200 });

  const inspectionShelves = computed<Shelf[]>(() => inspectionShelvesQuery.data.value?.items ?? []);
  const productionShelves = computed<Shelf[]>(() => productionShelvesQuery.data.value?.items ?? []);
  // processSchema 派生的 description / color 是 optional（后端 skip_serializing_if），
  // 而 `Process` 业务类型把这两个键声明成 required（值可为 undefined）⇒ 结构不匹配。
  // 沿 usePartDispatch / ProcessTab.vue 同款 `as Process[]` 桥接，渲染层已有 nullish
  // 兜底覆盖 null + undefined，零行为差异。
  const processes = computed<Process[]>(
    () => (processesQuery.data.value?.items ?? []) as Process[],
  );

  const options = {
    inspectionShelves,
    productionShelves,
    processes,
  };

  // ============ 切片：columnDefs + columnVisibility ============
  // 操作列的动作回调由视图**注入**（列定义在 store、导航与弹窗在视图 —— 不变量 #4：
  // store 不 import vue-router）。列定义在 setup 里只建一次，所以这里持一个可变
  // actions 对象，视图调 registerActions 就地改写 —— cellRender 每次点击读的都是
  // 最新的函数（与 usePartsListStore.registerTableGetter 同款注入形态）。
  const actions: InspectionColumnActions = {
    onPass: () => {},
    onOpenFail: () => {},
    onDetail: () => {},
  };
  const columnDefs = buildInspectionColumnDefs({
    filters,
    actions,
    passingBatchId: () => passingBatchId.value,
  });
  // listKey 与旧版 ListShell 保持一致 ⇒ 已存的「列可见性 / 列顺序」快照继续复用。
  // 注意批次列 key 由 batch_label 改成 batch_no（见 inspectionColumnDefs.ts 文件头），
  // 旧快照里的 batch_label 会被 lenient 策略忽略 ⇒ 该列回到默认可见。
  const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'inspection_pending' });

  /** 视图 setup 内调一次，注入操作列的三个动作（弹窗 / 路由导航都在视图侧）。 */
  function registerActions(next: InspectionColumnActions): void {
    actions.onPass = next.onPass;
    actions.onOpenFail = next.onOpenFail;
    actions.onDetail = next.onDetail;
  }

  // ============ 切片：ui（视图级开关）============
  // 自动刷新开关（布尔；轮询定时器归 useInspectionQueueQuery 的 refetchInterval，
  // 视图不再持有 timer，也不需要 onMounted/onBeforeUnmount 配对清理）。
  const ui = {
    autoRefresh: uiAutoRefresh,
  };

  return {
    query,
    filters,
    mutations,
    options,
    columnDefs,
    columnVisibility,
    ui,
    registerActions,
  };
});
