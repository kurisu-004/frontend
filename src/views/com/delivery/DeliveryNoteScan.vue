<script setup lang="ts">
// DeliveryNoteScan — 扫码建单页面（装配壳）。
//
// 结构：
//   - 业务状态 / 函数全部下移到 composables：
//       useDeliveryDraftBoard     — 草稿卡片列表 + 移除 / 打印标签 / 删除草稿
//       useDeliveryScanSubmission — 扫码取树 + 三层树入单 + 提交草稿 + 打印送货单预览
//   - 视图层切为 3 个子组件：
//       DeliveryScanBar              — 顶部 L1 客户选择条
//       DeliveryGroupPanel           — 分组规则面板（含编辑器 dialog）
//       DeliveryDraftCard            — 单张草稿卡片（重复 4-5 次）
//   - 装配壳只负责：拉客户全集 + 订阅扫码枪 + watch L1 变化触发 reload + 编排 3 子组件 +
//     装配 page-level 对话框（PrintPreviewDialog）+ router.push。
//
// 设计要点：
//   - useBarcodeScanner 扫码枪订阅 → handleScan → 拉三层树并弹树对话框；
//     **建单发生在用户在树对话框里确认数量时**，扫码本身是纯读。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComponentInstance } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElTable } from 'element-plus';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import { useDeliveryScanState } from './composables/useDeliveryScanState';
import type { Customer } from '@/api/customer';
// 客户全集走共享 query（CustomerList 写后失效自动 refetch）。
import { useCustomersQuery } from '@/composables/queries/useCustomersQuery';
import {
  createDeliveryGroup,
  listDeliveryGroups,
  softDeleteDeliveryGroup,
  updateDeliveryGroup,
} from '@/api/com/deliveryGroup';
import { useAuthStore } from '@/stores/auth';
import { canPrint } from '@/utils/deliveryNotePermissions';
import type {
  DeliveryGroupData,
  DeliveryGroupListResultData,
} from './composables/deliveryGroupSchema';
import type { DeliveryNoteItemData } from './composables/deliveryNoteSchema';
import {
  useDeliveryDraftBoard,
  type DraftTableInstance,
  type MergedDraftRow,
} from './composables/useDeliveryDraftBoard';
import { useDeliveryScanSubmission } from './composables/useDeliveryScanSubmission';
import DeliveryScanBar from './components/DeliveryScanBar.vue';
import DeliveryGroupPanel from './components/DeliveryGroupPanel.vue';
import DeliveryDraftCard from './components/DeliveryDraftCard.vue';
import PrintPreviewDialog from './components/PrintPreviewDialog.vue';

const router = useRouter();

// ============ L1 / 客户全集 ============
const scanState = useDeliveryScanState();
// 读 auth 只走 Pinia store（useAuthStore），不解构（见 CLAUDE.md §auth）。
const auth = useAuthStore();

// 客户全集走共享 query useCustomersQuery，自动 fetch。
const { data: customersData, error: customersError } = useCustomersQuery();
const allCustomers = computed<Customer[]>(() => customersData.value?.items ?? []);
/** 一级客户全集（parent_id === null）。 */
const rootCustomers = computed<Customer[]>(() =>
  allCustomers.value.filter((c) => c.parent_id === null),
);
/** 当前 L1 下的 L2 客户全集（分组编辑器用）。 */
const allL2Customers = computed<Customer[]>(() => {
  if (!scanState.l1CustomerId.value) return [];
  return allCustomers.value.filter((c) => c.parent_id === scanState.l1CustomerId.value);
});
// query 错误状态 → ElMessage（沿 useCustomerTree 同款 watch 桥接）。
watch(
  () => customersError.value,
  (err) => {
    if (err) ElMessage.error(err.message ?? '加载客户列表失败');
  },
);

/** CurrentUser.roles → boolean map（canPrint 用）。 */
const roleMap = computed<{ MANAGER?: boolean; CLERK?: boolean; INSPECTOR?: boolean }>(() => {
  const r = auth.user?.roles ?? [];
  return {
    MANAGER: r.includes('MANAGER'),
    CLERK: r.includes('CLERK'),
    INSPECTOR: r.includes('INSPECTOR'),
  };
});

// ============ 分组态 ============
const groups = ref<DeliveryGroupListResultData>({ groups: [], ungrouped_customers: [] });
const groupsLoading = ref(false);

/** 拉当前 L1 下的分组 + 未分组 L2。 */
async function reloadGroups(l1Id: string): Promise<void> {
  if (!l1Id) {
    groups.value = { groups: [], ungrouped_customers: [] };
    return;
  }
  groupsLoading.value = true;
  try {
    groups.value = await listDeliveryGroups(l1Id);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载分组规则失败');
  } finally {
    groupsLoading.value = false;
  }
}

// ============ 草稿卡片业务（board）============
const board = useDeliveryDraftBoard();

// ============ 扫码 + 入单 + 提交 + 预览（submission）============
const submission = useDeliveryScanSubmission({
  writeDraftFromScan: board.writeDraftFromScan,
  refreshDraftDetail: board.refreshDraftDetail,
  onDraftRemoved: (noteId) => {
    delete submission.submittingByNote[noteId];
    board.clearNoteLocalState(noteId);
  },
});

// ============ 扫码枪订阅 ============
const { onScan } = useBarcodeScanner();
let unsubScan: (() => void) | null = null;

// ============ 草稿卡片：行为函数（透传 board / submission 业务）============
/** 草稿卡片 row 是否允许打印（canPrint：管理角色 + DRAFT + 行项 > 0 + 已指定司机）。 */
function canPrintNote(d: DeliveryNoteItemData): boolean {
  return canPrint(d, roleMap.value);
}

/** 草稿卡片 row 是否允许提交（status === 'DRAFT'）。 */
function canSubmitDraft(d: DeliveryNoteItemData): boolean {
  return d.status === 'DRAFT';
}

// ============ 草稿卡片：emit → 业务函数桥接 ============
function onCardGotoDetail(d: DeliveryNoteItemData): void {
  gotoDetail(d);
}
function onCardSelectionChange(d: DeliveryNoteItemData, rows: MergedDraftRow[]): void {
  board.onSelectionChange(d.id, rows);
}
function onCardRemove(d: DeliveryNoteItemData, row: MergedDraftRow): void {
  void board.onRemove(d, row);
}
function onCardPrintLabels(d: DeliveryNoteItemData): void {
  void board.onPrintLabels(d);
}
function onCardDeleteDraft(d: DeliveryNoteItemData): void {
  void board.onDeleteDraft(d);
}
function onCardPrintNote(d: DeliveryNoteItemData): void {
  void submission.openPrintNote(d);
}
function onCardSubmitDraft(d: DeliveryNoteItemData): void {
  void submission.onSubmitDraft(d);
}
function onCardTableRef(
  d: DeliveryNoteItemData,
  el: ComponentInstance<typeof ElTable> | null,
): void {
  board.setTableRef(d.id, el as DraftTableInstance | null);
}

// ============ 卡片跳转 ============
function gotoDetail(draft: DeliveryNoteItemData): void {
  void router.push(`/delivery-notes/${draft.id}`);
}

function gotoAllDrafts(): void {
  if (!scanState.l1CustomerId.value) return;
  void router.push({
    path: '/delivery-notes',
    query: { statuses: 'DRAFT', customer_id: scanState.l1CustomerId.value },
  });
}

// ============ 分组：create / update / delete ============
async function onGroupCreate(payload: {
  name: string;
  member_customer_ids: string[];
}): Promise<void> {
  if (!scanState.l1CustomerId.value) return;
  try {
    await createDeliveryGroup({
      customer_id: scanState.l1CustomerId.value,
      name: payload.name,
      member_customer_ids: payload.member_customer_ids,
    });
    ElMessage.success('分组已创建');
    await reloadGroups(scanState.l1CustomerId.value);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存分组失败');
  }
}

async function onGroupUpdate(payload: {
  group: DeliveryGroupData;
  name: string;
  member_customer_ids: string[];
}): Promise<void> {
  try {
    await updateDeliveryGroup(payload.group.id, {
      version: payload.group.version,
      name: payload.name,
      member_customer_ids: payload.member_customer_ids,
    });
    ElMessage.success('分组已更新');
    if (scanState.l1CustomerId.value) {
      await reloadGroups(scanState.l1CustomerId.value);
    }
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存分组失败');
  }
}

async function onGroupDelete(g: DeliveryGroupData): Promise<void> {
  try {
    await softDeleteDeliveryGroup(g.id, { version: g.version });
    ElMessage.success('分组已删除');
    if (scanState.l1CustomerId.value) {
      await reloadGroups(scanState.l1CustomerId.value);
    }
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存分组失败');
  }
}

// ============ 生命周期 ============
onMounted(async () => {
  // L1 持久化恢复：单例扫描整个页面载入后从 localStorage 读回；只触发一次
  scanState.init();
  // 扫码枪订阅：每页独立挂载；卸载时退订避免劫持到其他页
  unsubScan = onScan((code) => {
    void submission.handleScan(code);
  });
});

/**
 * L1 变化（init 从 localStorage 恢复 / 用户切换 el-select）→ 重拉分组 + 草稿。
 *
 * 用 immediate: true 处理「重入页面时 watch 不会 fire 已有值」的问题：
 * useDeliveryScanState 是模块级单例，_l1CustomerId 在页面间共享。
 */
watch(
  scanState.l1CustomerId,
  async (id) => {
    if (!id) {
      groups.value = { groups: [], ungrouped_customers: [] };
      return;
    }
    await Promise.all([reloadGroups(id), board.reloadDrafts(id)]);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  unsubScan?.();
  unsubScan = null;
});
</script>

<template>
  <div class="page">
    <!-- 顶部：扫码入口条（L1 客户选择 + 扫码就绪提示）-->
    <DeliveryScanBar
      :l1-id="scanState.l1CustomerId.value"
      :root-customers="rootCustomers"
      @update:l1-id="(v: string) => scanState.setL1CustomerId(v)"
    />

    <!-- 分组规则面板 -->
    <DeliveryGroupPanel
      :groups="groups"
      :loading="groupsLoading"
      :can-create="!!scanState.l1CustomerId.value"
      :l1-id="scanState.l1CustomerId.value"
      :all-l2-customers="allL2Customers"
      @create="onGroupCreate"
      @update="onGroupUpdate"
      @delete="onGroupDelete"
    />

    <!-- 草稿卡片列表 -->
    <div v-loading="board.draftsLoading.value" class="drafts-section">
      <div class="drafts-header">
        <span class="dn-scan-card-title">当前草稿（{{ board.draftsCount.value }}）</span>
        <el-button v-if="board.draftsCount.value > 0" link type="primary" @click="gotoAllDrafts">
          查看全部 →
        </el-button>
      </div>

      <el-empty
        v-if="board.draftsCount.value === 0"
        description="暂无草稿 — 扫码枪扫码开始建单"
        :image-size="80"
      />
      <div v-else class="drafts-grid">
        <DeliveryDraftCard
          v-for="d in board.drafts.value"
          :key="d.id"
          :draft="d"
          :rows="board.foldedRows(d.id)"
          :selected-rows="board.selectedByNote[d.id] ?? []"
          :selection-count="board.getSelectionSize(d.id)"
          :printing="board.printingByNote[d.id] ?? false"
          :deleting="board.deletingByNote[d.id] ?? false"
          :submitting="submission.submittingByNote[d.id] ?? false"
          :can-print="canPrintNote(d)"
          :can-submit="canSubmitDraft(d)"
          :row-class-name="board.rowClassName"
          @gotoDetail="onCardGotoDetail(d)"
          @selection-change="(rs: MergedDraftRow[]) => onCardSelectionChange(d, rs)"
          @remove="(r: MergedDraftRow) => onCardRemove(d, r)"
          @printLabels="onCardPrintLabels(d)"
          @deleteDraft="onCardDeleteDraft(d)"
          @printNote="onCardPrintNote(d)"
          @submitDraft="onCardSubmitDraft(d)"
          @setTableRef="(el: ComponentInstance<typeof ElTable> | null) => onCardTableRef(d, el)"
        />
      </div>
    </div>

    <!-- ========== 打印送货单预览（page-level，shell 渲染） ==========
      v-if 保持：note=null 时（getNote 加载中）不渲染 dialog。openPrintNote
      等 detail 拉回后再开 dialog，避免 PrintPreviewDialog 在 note=null 时
      初始化空表格。 -->
    <PrintPreviewDialog
      v-if="submission.printNotePreviewVisible.value && submission.printNoteTarget.value"
      v-model="submission.printNotePreviewVisible.value"
      :note="submission.printNoteTarget.value"
      mode="note"
    />
  </div>
</template>

<style lang="scss" scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dn-scan-card-title {
  font-weight: 600;
  color: var(--text-primary, #303133);
}

/* ============ 草稿卡片列表 ============ */
.drafts-section {
  background: #fff;
  border-radius: 4px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
}
.drafts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.drafts-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

/* ============ 已打印标签行绿底 ============ */
:deep(.el-table__row.row-printed) > td.el-table__cell {
  background-color: #e6f7e6 !important;
}
:deep(.el-table__row.row-printed:hover) > td.el-table__cell {
  background-color: #d6efd6 !important;
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>