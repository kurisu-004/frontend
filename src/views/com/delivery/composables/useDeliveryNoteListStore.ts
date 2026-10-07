// src/views/com/delivery/composables/useDeliveryNoteListStore.ts
//
// 送货单一览页的 Pinia setup store（替代原 DeliveryNoteList.vue 里的 PagedTable
// fetcher + 一堆裸 ref）。
//
// 范本：src/views/cnc/composables/usePendingProgrammingStore.ts（页面级 store）
//   + usePendingProgrammingQuery.ts（useQuery 部分）。
//
// 不变量（改动前必读）：
//   1. 必须在组件 setup 内首次调用 useDeliveryNoteListStore()；
//   2. 视图 onBeforeUnmount 必须 store.$dispose()（Pinia 单例，泄漏筛选 / 分页到下次
//      进入 —— 注意 $dispose 只 reset 本 store 自建的 ref，故对外状态必须走 query /
//      actions 两个 plain object slice，见 return 处的说明）；
//   3. 消费侧禁止解构 store —— 一律 store.query.xxx / store.actions.xxx；
//   4. 不 import vue-router：路由跳转能力由视图通过 registerRouter 注入 —— store 需在
//      node 单测里无 router 实例化。
//
// 沿 CLAUDE.md 硬约束：
//   - 两层数据获取架构：本文件是**页面级 store**（私有状态 + 失效 + 列定义 + 行操作），
//     主查询的 useQuery 段外提成同域 hook（useDeliveryNotesQuery），客户全集走**共享
//     基础数据层**（useCustomersQuery）；
//   - 本文件**不含 queryKey / queryFn**：queryKey 走 qk.xxx 工厂、queryFn 从 queryKey
//     读最新 params、Zod 守门 parse、error → ElMessage 桥接，四件事都在
//     useDeliveryNotesQuery 内；本文件用到 qk 的场合只有写后失效的前缀；
//   - enabled 闸门（restored）避免「默认参数首屏 + 持久化参数再屏」双 fetch；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0 / mutations.retry: 0；
//   - 缓存时长：本页是页面级列表，走 main.ts 全局默认。
//
// ⚠️ **两个模块级 localStorage 单例不在本 store 的清理范围内**：
//   `useDeliveryScanState`（扫码台 L1 选择）与 `usePrintedLabels`（已打印标签记录）
//   是**跨路由会话态** —— 用户离开本页再回来时扫码台该记住上次选的 L1、标签绿底不该
//   消失。store 的 `$dispose()` 一律不碰它们。

import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/vue-query';

import { pickup, softDeleteNote, type ListNotesParams } from '@/api/com/deliveryNote';
import { qk } from '@/composables/queries/keys';
import { useCustomersQuery } from '@/composables/queries/useCustomersQuery';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { useColumnDrag } from '@/composables/useColumnDrag';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import { useAuthStore } from '@/stores/auth';
import { canDeliver, canSoftDelete, defaultStatusesForRole } from '@/utils/deliveryNotePermissions';
import type { DeliveryNoteStatus } from '@/types/deliveryNote';
import {
  buildDeliveryNoteColumnDefs,
  DELIVERY_NOTE_LIST_KEY,
  type DeliveryNoteRow,
} from '../deliveryNoteColumnDefs';
import { useDeliveryNotesQuery } from './useDeliveryNotesQuery';

/** 下发 / 行内操作失败兜底所需的最小 router 形态（只用 push）。
 *  结构化注入而非 `import type { Router }`：沿 src/stores/auth.ts::refreshOrLogout 的
 *  先例 —— store 不 import vue-router（不变量 #4，node 单测无 router 实例）。 */
export interface DeliveryNoteListRouter {
  push: (path: string) => Promise<unknown> | unknown;
}

export const useDeliveryNoteListStore = defineStore('delivery-note-list', () => {
  // useQueryClient 必须 setup 第一行捕获：Pinia 不给 action wrapper 注入上下文，
  // 挪进 action / listener 惰性取会抛。
  const qc = useQueryClient();
  const auth = useAuthStore();

  // ============ 私有状态 ============
  /** 角色矩阵（canDeliver / canSoftDelete / defaultStatusesForRole 都要它）。 */
  const role = computed(() => ({
    MANAGER: auth.hasRole('MANAGER'),
    CLERK: auth.hasRole('CLERK'),
    INSPECTOR: auth.hasRole('INSPECTOR'),
  }));

  const allStatuses: DeliveryNoteStatus[] = ['DRAFT', 'SUBMITTED', 'PICKED_UP', 'ARCHIVED'];
  /** 状态筛选（进 queryKey ⇒ 进请求）。持久化到 `delivery_note_list`。 */
  // vue/no-ref-object-destructure：role 是 computed，初值读取必须包进函数体（读的是
  // 当时的角色矩阵，之后不再跟随 —— 换账号会重建 store）。
  const statuses = ref<DeliveryNoteStatus[]>(
    defaultStatusesForRole(((): typeof role.value => role.value)()),
  );
  /** 客户筛选（单值 L1/L2 id，空串 = 全部）。 */
  const customerId = ref<string>('');
  /** 搜索**生效态**（进 queryKey ⇒ 进请求）。 */
  const search = ref<string>('');
  /** 搜索**输入态**（只被视图 el-input 的 v-model 写，**不进 queryKey**）。
   *  拆开的原因：生效态直接绑 v-model 时每敲一个字符就换一个 queryKey ⇒ 每个字符
   *  一次 GET；且 onSearch 只绑 @keyup.enter / @clear，打字途中页码不重置 ⇒ 在第 3 页
   *  打字会拉到「第 3 页的筛选结果」（大概率空表）。 */
  const searchInput = ref<string>('');
  /** 自动刷新开关（5min 轮询，持久化）。原视图用 PagedTable 的 fetcher 手动刷新，
   *  2026-10-08 改由 useQuery 的 refetchInterval 承担，这里只保留开关状态。 */
  const autoRefresh = ref(false);
  const page = ref(1);
  const pageSize = ref(50);
  /** enabled 闸门：store 实例化时 useQuery 不发请求，restoreState() 末尾置 true 才开闸
   *  （避免默认参数 + 持久化参数双 fetch）。 */
  const restored = ref(false);

  /** 一键送货的 per-row loading 容器（Record 让 :loading 自动响应）。 */
  const deliveringMap = reactive<Record<string, boolean>>({});

  // ============ buildParams ============
  function buildParams(): ListNotesParams {
    return {
      statuses: statuses.value.length ? statuses.value : undefined,
      customer_id: customerId.value || undefined,
      keyword: search.value.trim() || undefined,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  // ============ 主查询 ============
  // useQuery 段外提成同域 hook（useDeliveryNotesQuery）：私有状态留在这里，
  // queryKey / queryFn / Zod 守门 / 轮询 / 错误桥接归 hook。
  const listQuery = useDeliveryNotesQuery({
    params: computed(() => buildParams()),
    enabled: restored,
    autoRefresh,
  });

  // ============ 派生 ============
  const items = computed<DeliveryNoteRow[]>(() => listQuery.data.value?.items ?? []);
  const total = computed<number>(() => listQuery.data.value?.total ?? 0);
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const emptyText = computed<string>(() => errorMsg.value ?? '无数据');

  /** 客户全集（共享基础数据层 query：CustomerList 写后失效自动 refetch）。 */
  const { data: customersData } = useCustomersQuery();
  const customers = computed(() =>
    (customersData.value?.items ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      path: c.parent_name ? `${c.parent_name} / ${c.name}` : c.name,
    })),
  );

  // ============ 事件处理 ============
  /** 提交搜索：输入态 → 生效态 + 页码归 1（queryKey 变化自动 refetch）。
   *  ⚠️ 视图只在 `@keyup.enter` / `@clear` 调它，**不要**绑到输入框的
   *  `update:modelValue`（那只是打字，会每字一请求）。 */
  function onSearch(): void {
    search.value = searchInput.value;
    page.value = 1;
  }

  function resetFilter(): void {
    statuses.value = defaultStatusesForRole(role.value);
    customerId.value = '';
    searchInput.value = '';
    search.value = '';
    page.value = 1;
  }

  function onPageChange(next: number): void {
    page.value = next;
  }

  function onPageSizeChange(next: number): void {
    page.value = 1;
    pageSize.value = next;
  }

  // ============ 持久化 ============
  // ⚠️ key 沿用既有值 `delivery_note_list`（与列可见性 / 列顺序快照共用同一个 key
  // 前缀约定，**不许改**：改了老用户的筛选记忆全丢）。
  //
  // ⚠️ **dep 键名 `keyword` 是既有快照里的名字，不许改成 `search`**：快照结构是
  // `{ statuses, customerId, keyword }`（老视图写的），键名一改，
  // restore() 的「每个 dep key 都必须在快照里」校验就让**整份**快照返回 null ——
  // 所有老用户的状态 / 客户 / 单号筛选记忆一次性全丢。dep 的值直接绑生效态 `search`
  // 这个 ref（键名与被绑的 ref 名可以不同），读取时 `s.keyword` 回填 `search`。
  //
  // `autoRefresh` 是本轮新增的 dep，老快照里没有它 ⇒ `requireAllDeps: false`（否则老
  // 快照又是一次性作废）+ 读取时 `?? false` 兜底。
  //
  // deps 只放**生效态** search，**不放** searchInput：① 存草稿会让下次进页面时输入框
  // 显示一个从未生效过的条件（且与列表内容不一致）；② 多一个键会让旧快照整体失效。
  // page 排除（避免恢复到不存在的页）。
  const { restore: restorePersisted } = useListStatePersist(
    DELIVERY_NOTE_LIST_KEY,
    { statuses, customerId, keyword: search, autoRefresh },
    { exclude: new Set(['page']), requireAllDeps: false },
  );

  function restoreState(): void {
    // URL ?statuses= 优先于持久化快照，其次是角色默认（已在 ref initializer 注入）。
    const urlStatuses = parseUrlStatuses(routeStatuses.value);
    if (urlStatuses.length > 0) {
      statuses.value = urlStatuses;
    } else {
      const s = restorePersisted() as
        | {
            statuses?: DeliveryNoteStatus[];
            customerId?: string;
            /** 快照键名（见上方注释），值写进生效态 `search`。 */
            keyword?: string;
            autoRefresh?: boolean;
          }
        | null;
      if (s) {
        if (Array.isArray(s.statuses)) statuses.value = s.statuses;
        if (typeof s.customerId === 'string') customerId.value = s.customerId;
        if (typeof s.keyword === 'string') search.value = s.keyword;
        autoRefresh.value = s.autoRefresh === true;
      }
    }
    // 把生效态同步回输入态，否则输入框空白而列表已按恢复出的条件过滤 ——
    // 用户看到的框与表不一致，按回车还会把条件清空。
    searchInput.value = search.value;
    // 开闸 → useQuery 触发首屏 fetch（视图不再显式调 fetchList）
    restored.value = true;
  }

  /** URL ?statuses= 注入点（视图在 setup 里读 route.query 后写入，不 import vue-router）。 */
  const routeStatuses = ref<string | undefined>(undefined);
  function setRouteStatuses(raw: unknown): void {
    routeStatuses.value = typeof raw === 'string' ? raw : undefined;
  }

  function parseUrlStatuses(raw: string | undefined): DeliveryNoteStatus[] {
    if (!raw) return [];
    return raw
      .split(',')
      .filter((s): s is DeliveryNoteStatus => allStatuses.includes(s as DeliveryNoteStatus));
  }

  // ============ 列可见性 + 列顺序拖动 ============
  const columnDefs = buildDeliveryNoteColumnDefs();
  const columnVisibility = useColumnVisibility(columnDefs, { listKey: DELIVERY_NOTE_LIST_KEY });
  const drag = useColumnDrag(columnDefs, { listKey: DELIVERY_NOTE_LIST_KEY });

  // ============ 路由注入（不变量 #4）============
  const routerHolder: { get: (() => { push: (path: string) => unknown } | null) | null } = {
    get: null,
  };
  function registerRouter(fn: () => { push: (path: string) => unknown } | null): void {
    routerHolder.get = fn;
  }
  function navigateToDetail(id: string): void {
    void routerHolder.get?.()?.push(`/delivery-notes/${id}`);
  }

  // ============ 行操作 mutation ============
  /** 一键送货（`POST /{id}/pickup`，入参只剩 version；司机由 `/{id}/driver` 预先指定）。 */
  const deliverMutation = useMutation({
    mutationKey: ['delivery', 'pickup'],
    mutationFn: (row: DeliveryNoteRow) => pickup(row.id, { version: row.version }),
    onSuccess: async () => {
      await invalidateDeliveryNotesQuery(qc);
      ElMessage.success('已送货');
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '送货失败'),
  });

  async function onDeliver(row: DeliveryNoteRow): Promise<void> {
    try {
      await ElMessageBox.confirm(
        `一键送货 ${row.delivery_note_no}（${row.part_count} 条）？批次将全部置为已送货。`,
        '一键送货',
        { type: 'success', confirmButtonText: '确认送货', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    deliveringMap[row.id] = true;
    try {
      await deliverMutation.mutateAsync(row);
    } catch {
      // onError 已提示；清 loading 让按钮恢复可点。
    } finally {
      delete deliveringMap[row.id];
    }
  }

  const softDeleteMutation = useMutation({
    mutationKey: ['delivery', 'soft-delete'],
    mutationFn: (row: DeliveryNoteRow) => softDeleteNote(row.id, { version: row.version }),
    onSuccess: async () => {
      await invalidateDeliveryNotesQuery(qc);
      ElMessage.success('已删除');
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '删除失败'),
  });

  async function onSoftDelete(row: DeliveryNoteRow): Promise<void> {
    try {
      await ElMessageBox.confirm(
        `确认删除 ${row.delivery_note_no}（草稿）？关联零件会解除。`,
        '删除送货单',
        { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    await softDeleteMutation.mutateAsync(row);
  }

  function canDeliverRow(row: DeliveryNoteRow): boolean {
    return canDeliver(row.status, role.value, row.part_count);
  }

  function canSoftDeleteRow(row: DeliveryNoteRow): boolean {
    return canSoftDelete(row.status, role.value);
  }

  // ============ 对外切片 ============
  // ⚠️ 为什么切 query / actions 两个 slice，而不是把 15 个 ref 平铺在 store 顶层：
  // Pinia setup store 的 `$dispose()` 只做 `scope.stop()` + 清订阅 + 从 `pinia._s`
  // 摘除，**不删** `pinia.state.value[$id]`；下次 `useStore()` 时 Pinia 会把上次残留的
  // state **hydrate 回新建的 ref**（pinia.mjs createSetupStore 的
  // `if (initialState && shouldHydrate(prop)) prop.value = initialState[key]`）。
  //   - 平铺的顶层 ref（如 page / statuses）会被序列化进 state ⇒ $dispose 后「停在第 3 页」
  //     泄漏到下次进入，直接违反不变量 #2；
  //   - 切成 plain object slice 后，slice 既不是 ref 也不是 reactive，Pinia 不会把它
  //     写进 state ⇒ $dispose 后真 fresh。
  //     ⚠️ 前提是 slice 确实是 **plain object**：写成 reactive() 会通过 Pinia 的 state
  //     登记闸门（isRef || isReactive）进 state，重建时由 mergeReactiveObjects 递归回填、
  //     内层 ref 一样复活 ⇒ 本护栏失效。
  return {
    // 主查询切片：筛选 / 分页 + items / total / loading / 错误
    query: {
      allStatuses,
      /** 状态筛选（进 queryKey）。视图只经 restoreState / resetFilter 写。 */
      statuses,
      customerId,
      /** 生效态（进 queryKey ⇒ 进请求）。视图不直接绑 v-model，只经 onSearch 写。 */
      search,
      /** 输入态（视图 el-input 的 v-model 绑这里）；打字 0 请求，提交走 onSearch */
      searchInput,
      autoRefresh,
      page,
      pageSize,
      items,
      total,
      loading,
      errorMsg,
      emptyText,
      customers,
      /** fetchList 别名（视图「刷新」按钮 / 测试驱动） */
      fetchList: listQuery.fetchList,
      onSearch,
      resetFilter,
      onPageChange,
      onPageSizeChange,
      /** 恢复持久化筛选 + 开 enabled 闸门（视图 onMounted 首调一次） */
      restoreState,
      /** URL ?statuses= 注入（视图读 route.query 后写入） */
      setRouteStatuses,
    },
    // 行操作切片
    actions: {
      navigateToDetail,
      onDeliver,
      onSoftDelete,
      canDeliverRow,
      canSoftDeleteRow,
      /** 该行是否正在送货中（按钮 loading） */
      isDelivering: (id: string) => Boolean(deliveringMap[id]),
      /** **不暴露 mutation 本身**：行内按钮的 loading 由 isDelivering 派生、错误提示走
       *  onError 的 ElMessage，视图与测试都不需要读 mutation 对象 —— 暴露出去只是死 API。 */
    },
    // 列
    columnDefs,
    columnVisibility,
    drag,
    registerRouter,
  };
});

/** 失效整个送货单域（写操作成功后调）。返回 Promise<void> 让 caller 可以 await。 */
export function invalidateDeliveryNotesQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.deliveryNotesPrefix }).then(() => undefined);
}

/** 行类型再导出（视图 cellRender / 测试用；与域 schema 的 z.infer 同源）。 */
export type { DeliveryNoteRow };