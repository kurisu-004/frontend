// views/inspection/composables/useInspectionListStore.ts
//
// 2026-10-03 新增：待品检一览页的 Pinia setup store。替代 2026-08-25 的
// `useInspectionList`（fetcher 闭包 + `<ListShell>` 内部分页）旧范式，改为
// useQuery + queryKey 工厂 + Zod 守门 + enabled 闸门（CLAUDE.md 硬约束）。
//
// 迁移动机（两条独立理由，缺一条都不该做这次改造）：
//   1. 数据新鲜度：`ListShell` 的分页 / 勾选 / 排序是**本地**状态机（每次翻页重发
//      请求、无缓存、无失效点），品检流转（品检通过 / 指定工序 / 扫码快捷品检）后只能
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

import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  listInspectionBatches,
  scanInspect,
  toProcess,
  toShip,
  type InspectionQueueItem,
  type ListInspectionQueueParams,
} from '@/api/parts';
import { qk } from '@/composables/queries/keys';
import {
  inspectionQueueListResultSchema,
  type InspectionQueueListResultSchema,
} from '@/composables/queries/schemas';
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
import {
  buildInspectionColumnDefs,
  type InspectionColumnActions,
} from '@/utils/inspectionColumnDefs';
import {
  useInspectionColumnFilters,
  type InspectionSearchState,
} from './useInspectionColumnFilters';

/** 2026-10-03：品检通过（`POST /prod/batches/{batch_id}/to-ship`）的 mutation 入参。
 *  `label` 只用于拼成功提示（serial_no || drawing_no），不参与请求。 */
export interface ToShipVars {
  batchId: string;
  version: number;
  quantity: number | null;
  label: string;
}

/** 2026-10-03：指定工序（`POST /prod/batches/{batch_id}/to-process`）的 mutation 入参。
 *  `processCode` / `shelfCode` 同样只进提示文案（它们由视图从 options 里查出来）。 */
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
}

/** 2026-10-03：扫码快捷品检（`POST /prod/batches/{batch_id}/scan-inspect`）的入参。 */
export interface ScanInspectVars {
  batchId: string;
  targetInspectionShelfId: string;
  pass: boolean;
  version: number;
  shelfId: string | null;
  nextProcessId: string | null;
  note: string | null;
  quantity: number | null;
  label: string;
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

  /** search + 分页 + 排序 → queryKey params 的**唯一**转换点。 */
  function buildParams(): ListInspectionQueueParams {
    return {
      // 三个 ILIKE 子串各自独立，同时传 ⇒ 后端 AND 联合。
      drawing_no: search.drawingNo.trim() || undefined,
      name: search.name.trim() || undefined,
      serial_no: search.serialNo.trim() || undefined,
      // 雪花 ID 字符串直传，禁止 Number()（CLAUDE.md §3：19 位 ID 丢精度）。
      customer_id: search.customerId || undefined,
      system_delivery_date_from: search.systemDeliveryDateFrom || undefined,
      system_delivery_date_to: search.systemDeliveryDateTo || undefined,
      sort_by: sortBy.value,
      sort_dir: sortDir.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  const listQuery = useQuery<
    InspectionQueueListResultSchema,
    Error,
    InspectionQueueListResultSchema,
    ReturnType<typeof qk.inspectionQueueList>
  >({
    queryKey: computed(() => qk.inspectionQueueList(buildParams())),
    // params 从 queryKey 读，不闭包捕获 buildParams() 的 snapshot（否则 search /
    // 排序变化后 queryFn 仍发旧参数）。
    queryFn: async ({ queryKey }) => {
      const params = queryKey[2] as ListInspectionQueueParams;
      return inspectionQueueListResultSchema.parse(await listInspectionBatches(params));
    },
    enabled: restored,
    placeholderData: keepPreviousData,
  });

  /** 2026-10-03：refetch 别名（写操作后 / 手动刷新 / 测试驱动都走它，不重写 queryKey）。 */
  async function fetchList(): Promise<void> {
    await listQuery.refetch();
  }

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
  // 声明在 query 切片之前：resetAllFilters 要拿它把「已确认值 + 未确认草稿 + popover
  // 打开态」一起清掉（见该函数），而 filters 的 deps 只有 search 与上面这个 onSearch。
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

  // useQuery 的错误不在 setup 抛错，走 watch 桥接弹 ElMessage。
  watch(errorMsg, (msg) => {
    if (msg) ElMessage.error(msg);
  });

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
    onSuccess: async (_data, vars) => {
      await invalidateInspectionQuery();
      ElMessage.success(`零件 ${vars.label} 品检通过${vars.quantity ? ` × ${vars.quantity}` : ''}`);
    },
    onError: async (e: Error & { code?: number }) => {
      // 40901：批次已被他人改动（OCC version 不匹配）→ 提示 + 重拉，让用户看到最新数量。
      if (e?.code === 40901) {
        ElMessage.warning('该批次已被他人修改，请刷新后重试');
        await fetchList();
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
    onSuccess: async (_data, vars) => {
      await invalidateInspectionQuery();
      ElMessage.success(
        `零件 ${vars.label} 已指定下一道工序 ${vars.processCode}，放到生产货架 ${vars.shelfCode}`,
      );
    },
    onError: async (e: Error & { code?: number }) => {
      if (e?.code === 40901) {
        ElMessage.warning('该批次已被他人修改，请刷新后重试');
        await fetchList();
        return;
      }
      ElMessage.error(`指定工序失败：${e?.message ?? '未知错误'}`);
    },
  });

  const scanInspectMutation = useMutation({
    mutationKey: ['inspection', 'scan-inspect'],
    mutationFn: ({
      batchId,
      targetInspectionShelfId,
      pass,
      version,
      shelfId,
      nextProcessId,
      note,
      quantity,
    }: ScanInspectVars) =>
      scanInspect(batchId, {
        target_inspection_shelf_id: targetInspectionShelfId,
        pass,
        version,
        shelf_id: shelfId ?? undefined,
        next_process_id: nextProcessId ?? undefined,
        note,
        quantity,
      }),
    onSuccess: async (_data, vars) => {
      await invalidateInspectionQuery();
      ElMessage.success(
        vars.pass ? `零件 ${vars.label} 快捷品检通过` : `零件 ${vars.label} 已快捷打回`,
      );
    },
    onError: async (e: Error & { code?: number }) => {
      // 40901：批次已被他人改动（OCC version 不匹配）—— 与 toShip / toProcess 同款分支。
      // 扫码快捷品检尤其需要它：版本锚错（见 InspectionPending.vue 里 PartItem.version
      // 的说明）时后端必回 40901，走通用分支只会显示无指导性的「快捷品检失败：批次已被他人修改」。
      if (e?.code === 40901) {
        ElMessage.warning('该批次已被他人修改，请刷新后重试');
        await fetchList();
        return;
      }
      ElMessage.error(`快捷品检失败：${e?.message ?? '未知错误'}`);
    },
  });

  const mutations = {
    passingBatchId,
    toShipMutation,
    toProcessMutation,
    scanInspectMutation,
  };

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
  // 自动刷新布尔放这里，timer 实例由视图持有（与旧版一致：store 不知道定时器）。
  // 2026-10-03 不再持久化：旧版的持久化 deps 形如 { search, autoRefresh }，与新的
  // { search, sortBy, sortDir, pageSize } 快照 shape 不兼容，恢复会整份被丢弃。
  //
  // ⚠️ 为什么塞进切片而不是摆在 store 根上：Pinia 的 setup store 在**同一 pinia 内
  //   `$dispose()` 后重建**时，会把残留的 `pinia.state.value[storeId]` 当 initialState
  //   回填进新的 ref（state hydration）。根级 ref 会被上一个页面实例的值「复活」，
  //   而嵌套在普通对象里的 ref 不会（整个对象被新实例替换）。放切片里 ⇒ $dispose 后
  //   一定是 false，行为可预期。
  const ui = {
    autoRefresh: ref(false),
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
