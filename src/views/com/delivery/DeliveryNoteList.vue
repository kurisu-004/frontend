<!--
  送货单一览（PR-G 2026-07-22 新增；2026-07-23 增强）

  - 文员 / MANAGER：filter (statuses × customer_id × keyword) → table → 操作
    (详情 / 送货 / 删除)
  - 顶部「扫码建单」按钮：入单的唯一入口是扫码（`/delivery-notes/scan`），
    手动新建草稿已下线（`POST /delivery-notes` 端点删除）
  - 配送日期列、送货日期列

  形态对齐 frontend/src/views/outsource/OutsourceQuoteList.vue
-->
<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox, ElTag } from 'element-plus';
import { Promotion } from '@element-plus/icons-vue';

import { listNotes, pickup, softDeleteNote } from '@/api/com/deliveryNote';
import {
  DELIVERY_NOTE_STATUS_LABEL,
  DELIVERY_NOTE_STATUS_TAG,
  type DeliveryNoteStatus,
} from '@/types/deliveryNote';
import type { DeliveryNoteItemData } from './composables/deliveryNoteSchema';
import {
  canDeliver,
  canSoftDelete,
  defaultStatusesForRole,
  hasManageNoteRole,
} from '@/utils/deliveryNotePermissions';
// 2026-09-26：客户全集改走共享 query useCustomersQuery（CustomerList 写后失效自动 refetch）。
import { useCustomersQuery } from '@/composables/queries/useCustomersQuery';
// 读 auth 只走 Pinia store（useAuthStore），不解构（见 CLAUDE.md §auth）。
import { useAuthStore } from '@/stores/auth';
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import PagedTable from '@/components/PagedTable.vue';

const route = useRoute();
// 2026-09-26：消费侧禁止解构 store（沿 usePartsListStore 不变量 #3），统一 auth.xxx。
const auth = useAuthStore();
const role = computed(() => ({
  MANAGER: auth.hasRole('MANAGER'),
  CLERK: auth.hasRole('CLERK'),
  INSPECTOR: auth.hasRole('INSPECTOR'),
}));

// ============================================================
// 一览过滤
// ============================================================
const allStatuses: DeliveryNoteStatus[] = ['DRAFT', 'SUBMITTED', 'PICKED_UP', 'ARCHIVED'];
// vue/no-ref-object-destructure：role 是 computed，value 不能直接读；IIFE 包一层把读取放进函数体。
const statuses = ref<DeliveryNoteStatus[]>(
  defaultStatusesForRole(((): typeof role.value => role.value)()),
);

const customerId = ref<string>('');
const keyword = ref('');
// 2026-08-25 T7：items / total / loading / page 已迁到 <PagedTable>
const pagedRef = ref();

// ============ 筛选状态持久化（2026-07-30 commit 4B；2026-08-25 T7：page 不再持久化）============
// 把 3 个离散 ref 包成一个对象传给 useListStatePersist；restore 后逐个 .value 写回。
// page 排除。优先级：URL ?statuses= > restore 快照 > 角色默认
const { restore: restoreNoteListFilter } = useListStatePersist(
  'delivery_note_list',
  { statuses, customerId, keyword },
  { exclude: new Set(['page']) },
);

// ============ 列可见性 + 列顺序拖动 ============
// 「操作」列不放进 defs → 始终可见
// 2026-08-27 T17：补 prop / minWidth / align + 文本列走 cellRender(ListShell 同款)。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  {
    key: 'delivery_note_no',
    label: '单号',
    prop: 'delivery_note_no',
    minWidth: 180,
    align: 'center',
  },
  {
    key: 'delivery_date',
    label: '送货日期',
    minWidth: 120,
    align: 'center',
    cellRender: ({ row }) => h('span', null, (row as DeliveryNoteItemData).delivery_date ?? '—'),
  },
  {
    key: 'customer',
    label: '客户',
    minWidth: 130,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as DeliveryNoteItemData;
      return h('span', null, r.customer_path ?? r.customer_name ?? '—');
    },
  },
  {
    key: 'status',
    label: '状态',
    minWidth: 80,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as DeliveryNoteItemData;
      return h(
        ElTag,
        {
          type: DELIVERY_NOTE_STATUS_TAG[r.status as DeliveryNoteStatus] || 'info',
          size: 'small',
          effect: 'plain',
        },
        () => DELIVERY_NOTE_STATUS_LABEL[r.status as DeliveryNoteStatus],
      );
    },
  },
  { key: 'part_count', label: '零件数', prop: 'part_count', minWidth: 70, align: 'center' },
  {
    key: 'submitted_at',
    label: '提交时间',
    minWidth: 170,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as DeliveryNoteItemData;
      return h('span', null, r.submitted_at ? new Date(r.submitted_at!).toLocaleString() : '—');
    },
  },
  {
    key: 'picked_up_at',
    label: '领取时间',
    minWidth: 170,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as DeliveryNoteItemData;
      return h('span', null, r.picked_up_at ? new Date(r.picked_up_at!).toLocaleString() : '—');
    },
  },
  {
    key: 'driver_worker_name',
    label: '司机',
    prop: 'driver_worker_name',
    minWidth: 80,
    align: 'center',
    cellRender: ({ row }) => h('span', null, (row as DeliveryNoteItemData).driver_worker_name ?? '—'),
  },
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'delivery_note_list' });
const drag = useColumnDrag(columnDefs, { listKey: 'delivery_note_list' });
const tableRef = ref();
// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
drag.applyDrag(tableRef);

// 2026-09-26：客户全集改走共享 query useCustomersQuery（CustomerList 写后
// invalidateCustomersQuery 自动 refetch）。原 customers ref + loadCustomers()
// 删除；保留同名 computed 派生 {id, name, parent_id, path} 视图。
const { data: customersData } = useCustomersQuery();
const customers = computed<{ id: string; name: string; path: string; parent_id: string | null }[]>(
  () =>
    (customersData.value?.items ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      parent_id: c.parent_id ?? null,
      path: c.parent_name ? `${c.parent_name} / ${c.name}` : c.name,
    })),
);

// 2026-09-02 新增：per-row loading 容器（reactive Record 让 :loading 自动响应）
const deliveringMap = reactive<Record<string, boolean>>({});

// 2026-08-25 T7：fetcher 给 PagedTable；其它地方仍调 fetchList() 触发刷新
async function fetcher(params: { page: number; pageSize: number }) {
  try {
    const resp = await listNotes({
      statuses: statuses.value.length ? statuses.value : undefined,
      customer_id: customerId.value || undefined,
      keyword: keyword.value.trim() || undefined,
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    });
    return { items: resp.items, total: resp.total };
  } catch (e) {
    ElMessage.error((e as Error).message ?? '查询失败');
    return { items: [], total: 0 };
  }
}

async function fetchList() {
  await pagedRef.value?.fetch();
}

function resetFilter() {
  statuses.value = defaultStatusesForRole(role.value);
  customerId.value = '';
  keyword.value = '';
  void pagedRef.value?.reset();
}

// 2026-08-25 T7：替换原 @click="page = 1; fetchList()"（page 已被 PagedTable 接管）
function resetToFirstPage() {
  void pagedRef.value?.reset();
}

onMounted(async () => {
  // 2026-09-26：useCustomersQuery 在 setup 顶层已自动 fetch；loadCustomers() 删除。
  // 2026-07-30 commit 4B：筛选项恢复（与 OutsourceQuoteList 同优先级）
  //   1) URL ?statuses=  → 最高优先
  //   2) restore() 快照里 statuses / customerId / keyword
  //   3) 角色默认（已在 ref initializer 注入到 statuses.value；restore 不覆盖现有值）
  const urlStatusesRaw = route.query.statuses;
  const urlStatuses: DeliveryNoteStatus[] =
    typeof urlStatusesRaw === 'string'
      ? urlStatusesRaw
          .split(',')
          .filter((s): s is DeliveryNoteStatus => allStatuses.includes(s as DeliveryNoteStatus))
      : [];
  if (urlStatuses.length > 0) {
    statuses.value = [...urlStatuses];
  } else {
    const persisted = restoreNoteListFilter() as
      { statuses?: DeliveryNoteStatus[]; customerId?: string; keyword?: string } | null | undefined;
    if (persisted) {
      if (Array.isArray(persisted.statuses)) statuses.value = [...persisted.statuses];
      if (typeof persisted.customerId === 'string') customerId.value = persisted.customerId;
      if (typeof persisted.keyword === 'string') keyword.value = persisted.keyword;
    }
  }
  await fetchList();
});

// ============================================================
// 行操作
// 2026-08-07：操作栏瘦身——提交 / 撤回 / 打印（送货单 + 标签）按钮全部移除，
// 全部操作统一在详情页（DeliveryNoteDetail.vue）里完成。本页只保留：
//   · 详情（跳详情页）
//   · 删除（仅 DRAFT；CLERK / MANAGER）
// ============================================================
async function onSoftDelete(n: DeliveryNoteItemData) {
  try {
    await ElMessageBox.confirm(
      `确认删除 ${n.delivery_note_no}（草稿）？关联零件会解除。`,
      '删除送货单',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await softDeleteNote(n.id, { version: n.version });
    ElMessage.success('已删除');
    fetchList();
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除失败');
  }
}

// 列表页「一键送货」入口（送货台下线后本入口是唯一的送货路径）。
// - ElMessageBox.confirm 确认
// - 调 `POST /com/delivery/note/{id}/pickup`，**入参只剩 version**：司机由
//   `POST /{id}/driver` 预先指定，服务端从单据上读 driver_worker_id 并重跑
//   validate_driver（没指定 / 司机已停用 / 改工种 → 21409）
// - 成功后刷新列表；失败展示后端 msg
async function onDeliver(n: DeliveryNoteItemData) {
  try {
    await ElMessageBox.confirm(
      `一键送货 ${n.delivery_note_no}（${n.part_count} 件）？批次将全部置为已送货。`,
      '一键送货',
      { type: 'success', confirmButtonText: '确认送货', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  deliveringMap[n.id] = true;
  try {
    await pickup(n.id, { version: n.version });
    ElMessage.success('已送货');
    await fetchList();
  } catch (e) {
    ElMessage.error((e as Error).message ?? '送货失败');
  } finally {
    delete deliveringMap[n.id];
  }
}
</script>

<template>
  <div class="delivery-note-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline class="filter-form">
        <div style="display: flex; margin-bottom: 15px">
          <el-form-item label="状态">
            <el-select
              v-model="statuses"
              multiple
              clearable
              placeholder="全部"
              style="width: 380px"
            >
              <el-option
                v-for="s in allStatuses"
                :key="s"
                :label="DELIVERY_NOTE_STATUS_LABEL[s]"
                :value="s"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="客户">
            <el-select
              v-model="customerId"
              clearable
              filterable
              placeholder="全部"
              style="width: 200px"
            >
              <el-option v-for="c in customers" :key="c.id" :label="c.path" :value="c.id" />
            </el-select>
          </el-form-item>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between">
          <div>
            <el-form-item label="单号">
              <el-input
                v-model="keyword"
                placeholder="DN-20260723-…"
                clearable
                style="width: 200px"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="resetToFirstPage()">查询</el-button>
              <el-button @click="resetFilter">重置</el-button>
            </el-form-item>
          </div>

          <div class="delivery-list-actions">
            <el-button
              v-if="hasManageNoteRole(role)"
              type="primary"
              @click="$router.push('/delivery-notes/scan')"
            >
              <el-icon><Promotion /></el-icon>
              <span>扫码建单</span>
            </el-button>
          </div>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div class="dnl-card-header">
          <ColumnVisibilityPopover
            :defs="columnDefs"
            :model-value="columnVisibility.currentMap"
            @update:model-value="columnVisibility.update"
            @reset="columnVisibility.showAll"
            @resetOrder="drag.reset"
          />
        </div>
      </template>
      <!-- 2026-08-25 (T7)：el-table + el-pagination 收口到 <PagedTable> -->
      <PagedTable
        ref="pagedRef"
        :fetcher="fetcher"
        :default-page-size="50"
        pagination-layout="total, sizes, prev, pager, next"
      >
        <template #default="{ items, loading }">
          <el-table
            ref="tableRef"
            v-loading="loading"
            :data="items"
            :row-key="(r: DeliveryNoteItemData) => r.id"
            max-height="calc(100vh - 360px)"
            highlight-current-row
            stripe
            border
            :empty-text="loading ? '加载中' : '无数据'"
          >
            <!--
        2026-08-27 T17：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
        用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
        fixed="right" 操作列保留为字面量 <el-table-column>。
      -->
            <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
              <el-table-column
                v-if="columnVisibility.isVisible(d.key)"
                :prop="d.prop ?? d.key"
                :label="d.label"
                :width="d.width"
                :min-width="d.minWidth"
                :sortable="d.sortable"
                :align="d.align"
                :show-overflow-tooltip="d.showOverflowTooltip"
                :column-key="d.columnKey ?? d.key"
                :label-class-name="drag.dragLabelClass(d)"
              >
                <template v-if="d.cellRender" #default="scope">
                  <component :is="d.cellRender(scope)" />
                </template>
                <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
                  <span>{{ d.label }}</span>
                  <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
                </template>
              </el-table-column>
            </template>
            <el-table-column label="操作" min-width="180" fixed="right" align="center">
              <template #default="scope">
                <div style="display: flex; align-items: center; gap: 0px">
                  <el-button
                    link
                    type="primary"
                    @click="$router.push(`/delivery-notes/${(scope.row as DeliveryNoteItemData).id}`)"
                  >
                    详情
                  </el-button>
                  <!-- 2026-09-02 新增：一键送货（管理角色 + part_count>0 + SUBMITTED） -->
                  <el-button
                    v-if="
                      canDeliver(
                        (scope.row as DeliveryNoteItemData).status,
                        role,
                        (scope.row as DeliveryNoteItemData).part_count,
                      )
                    "
                    link
                    type="success"
                    :loading="Boolean(deliveringMap[(scope.row as DeliveryNoteItemData).id])"
                    @click="onDeliver(scope.row as DeliveryNoteItemData)"
                  >
                    送货
                  </el-button>
                  <el-button
                    v-if="canSoftDelete((scope.row as DeliveryNoteItemData).status, role)"
                    link
                    type="danger"
                    @click="onSoftDelete(scope.row as DeliveryNoteItemData)"
                  >
                    删除
                  </el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </PagedTable>
    </el-card>

  </div>
</template>

<style scoped>
.delivery-note-list {
  padding: 16px;
}
.filter-card :deep(.el-form-item) {
  margin-bottom: 0;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
.dnl-card-header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
.delivery-list-actions {
  display: inline-flex;
  gap: 8px;
}
</style>
