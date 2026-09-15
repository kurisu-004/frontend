// views/parts/composables/usePartsListStore.ts
//
// 2026-09-15 新增：parts 列表页 Pinia setup store，替代 partsListCtx 的 :ctx prop 模式
// （用户 2026-09-15 批准页面级复杂状态可用 Pinia 3，覆盖 CLAUDE.md 旧硬约束 #1）。
//
// 不变量（改动前必读）：
// 1. 必须在组件 setup 内首次调用 usePartsListStore() —— 切片链路上
//    useCustomerTree 的 onMounted / useListFilterPersist 等的 onBeforeUnmount
//    会绑定到首个创建 store 的组件（= PartsList）。PartsList 壳在 setup 顶部首调，
//    子组件 setup 晚于父组件，天然满足。组件外（路由守卫/其他 store）禁止首调。
// 2. PartsList onBeforeUnmount 必须 store.$dispose()：Pinia 是单例，不 dispose
//    会把 editingId / selectedIds / batchMode / 对话框态泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 store.切片.字段 访问，
//    不写 .value（深代理自动解包）。store 内部闭包持 raw 切片，照写 .value ——
//    两个访问面落同一批 ref，无双写分裂。
// 4. 不 import vue-router：route/router 逻辑留壳（store 需在 node 单测无 router 实例化）。

import { defineStore } from 'pinia';
import { useAuthSession } from '@/composables/useAuthSession';
import { useColumnVisibility, type ColumnDef } from '@/composables/useColumnVisibility';
import { usePartsListQuery } from './usePartsListQuery';
import { usePartsColumnFilters } from './usePartsColumnFilters';
import { usePartBatchSelection } from './usePartBatchSelection';
import { useBatchPrint } from './useBatchPrint';
import { usePartDispatch } from './usePartDispatch';
import { usePartInlineEdit } from './usePartInlineEdit';
import { buildPartsListColumnDefs } from './partsListColumnDefs';
import type { PartListItem } from '@/types/parts';

/** 壳注册的 el-table getter（结构类型，对齐 batch/dispatch 两个 composable 的最小需求）。
 *  sort 形参顺序类型放宽为 string —— Element Plus 的 TableInstance.sort 签名是
 *  (prop: string, order: string) => void；壳 PartsList.vue 实际调用时已确保
 *  order 是 'ascending' | 'descending' | null 之一（PART_SORT_KEY_TO_PROP + sortDir 派生）。 */
export type PartsListTableGetter = () => {
  clearSelection: () => void;
  toggleRowSelection: (row: PartListItem, selected: boolean) => void;
  sort?: (prop: string, order: string) => void;
} | null;

export const usePartsListStore = defineStore('parts-list', () => {
  // ============ 角色 & 默认筛选（从 PartsList.vue 搬入，2026-09-15）============
  const { hasRole } = useAuthSession();
  const isCncProgrammer = hasRole('CNC_PROGRAMMER');
  // PR-I 2026-07-20：INSPECTOR 看不到导入 / 批量打印 / 下发按钮
  // 行内编辑权限：与后端 POST /parts/{id}/update 一致（MANAGER / CLERK）
  const canEdit = hasRole('MANAGER') || hasRole('CLERK');

  // ============ el-table getter：壳在 setup 里注册（PartsTable 组件 ref 在壳模板上）============
  let tableGetter: PartsListTableGetter = () => null;
  function registerTableGetter(fn: PartsListTableGetter): void {
    tableGetter = fn;
  }
  const getTable = () => tableGetter();

  // ============ 六切片装配（原 PartsList.vue L195-233 原样搬入）============
  const query = usePartsListQuery({ isCncProgrammer });
  const filters = usePartsColumnFilters({
    search: query.search,
    onSearch: query.onSearch,
    snapshot: query.snapshotPersist,
  });
  const batch = usePartBatchSelection({ items: query.items, getTable });
  query.registerBeforeSearch(() => {
    if (batch.batchMode.value) batch.clearAllSelection();
  });
  query.registerAfterFetch(() => {
    if (batch.batchMode.value) batch.restoreTableSelection();
  });
  const print = useBatchPrint({
    selectedIds: batch.selectedIds,
    selectedRowTypes: batch.selectedRowTypes,
  });
  const dispatch = usePartDispatch({
    fetchList: query.fetchList,
    selectedIds: batch.selectedIds,
    selectedRows: batch.selectedRows,
    selectedRowTypes: batch.selectedRowTypes,
    getTable,
  });
  const edit = usePartInlineEdit({
    items: query.items,
    fetchList: query.fetchList,
    customerTree: filters.customerTree,
    canEdit,
    isBatchMode: () => batch.batchMode.value,
  });

  // ============ 列定义 + 列可见性（原 PartsList.vue L240-1103 搬到 factory）============
  const columnDefs: ColumnDef[] = buildPartsListColumnDefs({ filters, edit, canEdit });
  const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'parts_list_columns' });

  return {
    query,
    filters,
    edit,
    batch,
    print,
    dispatch,
    canEdit,
    isCncProgrammer,
    columnVisibility,
    columnDefs,
    registerTableGetter,
  };
});
