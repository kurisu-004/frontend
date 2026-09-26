<!--
  PartBatchMonitorCard.vue

  批次监控卡（PartDetail 第 9 张卡）：
  - 批次列表（el-table + 拆分 / 取消列）
  - 拆分对话框（partId + batch + quantity → emit split）
  - 取消按钮（emit cancel-batch；父组件弹 confirm 后再调 usePartDetail.onCancelBatch）
  - 拆分 / 取消 dialog 状态由本组件局部维护
  - 行选中（@row-click → emit select）让 ProcessChainCard / PartHistoryCard
    按选中 batch 派生高亮步骤 / 过滤事件

  2026-08-25 frontend-overall-refactor：从 PartDetail.vue 抽出。

  2026-08-28 改造（B 组 batch 1 列拖动接入）：
  - el-table 在 el-card 内 v-if 控制（batches.length > 0 时挂载）→
    传 el-table 实例 ref 给 drag.applyDrag(tableRef)，composable 内部 watch +
    MutationObserver 自愈（覆盖 batches=0 → 加载后挂载的过渡）。
  - 「操作」fixed="right" 列受 canManageBatches 控制：保留为字面量 <el-table-column v-if>，
    不进 defs。
  - 拖点挂到表头 <tr>（列换序；绑 thead 会变成拖整行）。

  2026-09-17 PR-3 改造：
  - 移除 next_process_name / created_at 列：
    next_process_name 已在 PartBatchMonitorCard 内被 PR-3 步骤化替换为
    current_process_step_id（FK → t_process_chain_step.id），由 ProcessChainCard
    通过 process chain steps 渲染；created_at 视觉价值低 + 与批次流水管理重叠。
  - 移除「批次名」「创建时间」之外的批次细节展示 → 卡片进一步瘦身。
  - 加 @row-click + :row-class-name：点击批次行 emit('select', batch| null)，
    同一行二次点击撤销选中（与点空白处一致）；操作列按钮 stopPropagation 避免
    误触选中。

  2026-09-17 UI 调整第 2 轮：
  - 默认 wrapCard=false（裸 div 渲染）：详情页时间线卡父级已包 el-card，避免
    嵌套两重。保留 wrapCard=true 兼容未来独立入口（包 el-card + header）。
-->
<template>
  <!-- wrapCard=true：包外层 el-card（独立入口用） -->
  <el-card v-if="wrapCard" v-loading="batchesLoading" shadow="never" class="batch-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">批次监控</span>
        <span class="event-count"> 共 {{ batches.length }} 批 / {{ batchTotalQty }} 件 </span>
      </div>
    </template>
    <BatchBody
      ref="bodyRef"
      :batches="batches"
      :can-manage-batches="canManageBatches"
      :status-tag-type="statusTagType"
      :status-label-of="statusLabelOf"
      :row-class-name="rowClassName"
      :on-row-click="onRowClick"
      :is-terminal-batch="isTerminalBatch"
      :open-split-dialog="openSplitDialog"
      :drag="drag"
      :column-identifier="columnIdentifier"
      :column-visibility="columnVisibility"
      :resolve-draggable="resolveDraggable"
      :column-defs="columnDefs"
    />
  </el-card>

  <!-- wrapCard=false：裸渲染（详情页时间线卡父级已包），靠 CSS 与父级视觉对齐 -->
  <div v-else v-loading="batchesLoading" class="batch-card batch-card-flat">
    <BatchBody
      ref="bodyRef"
      :batches="batches"
      :can-manage-batches="canManageBatches"
      :status-tag-type="statusTagType"
      :status-label-of="statusLabelOf"
      :row-class-name="rowClassName"
      :on-row-click="onRowClick"
      :is-terminal-batch="isTerminalBatch"
      :open-split-dialog="openSplitDialog"
      :drag="drag"
      :column-identifier="columnIdentifier"
      :column-visibility="columnVisibility"
      :resolve-draggable="resolveDraggable"
      :column-defs="columnDefs"
    />
  </div>

  <!-- 拆分批次对话框（两种模式共用，靠 teleport 默认挂到 body） -->
  <el-dialog
    v-model="splitDialogVisible"
    title="拆分批次"
    :width="splitDlg.width"
    :fullscreen="splitDlg.fullscreen"
    @closed="onSplitDialogClosed"
  >
    <div v-if="splitSource" class="split-dialog-body">
      <p>
        源批次 <b>{{ splitSource.batch_label }}</b> （当前 {{ splitSource.quantity }} 件，
        {{ statusLabelOf(splitSource.status) }}）
      </p>
      <el-form label-width="90px">
        <el-form-item label="拆出数量" required>
          <el-input-number
            v-model="splitQuantity"
            :min="1"
            :max="splitSource.quantity - 1"
            :precision="0"
            style="width: 160px"
          />
        </el-form-item>
      </el-form>
      <p class="muted">
        拆出后：源批次剩 {{ splitSource.quantity - (splitQuantity ?? 0) }} 件， 新批次
        {{ splitQuantity ?? 0 }} 件（继承当前状态/位置）。
      </p>
    </div>
    <template #footer>
      <el-button @click="splitDialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="splitSubmitting"
        :disabled="!splitQuantity || !splitSource || splitQuantity >= splitSource.quantity"
        @click="onSplitConfirm"
        >确认拆分</el-button
      >
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue';
import { ElTag } from 'element-plus';
import type { PartBatch } from '@/api/parts';
import { useDialogSize } from '@/composables/useDialogSize';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import type { OrderStatus } from '@/types/parts';
import BatchBody from './PartBatchMonitorBody.vue';

const props = withDefaults(
  defineProps<{
    partId: string;
    batches: PartBatch[];
    batchesLoading: boolean;
    canManageBatches: boolean;
    /**
     * 2026-09-17 新增：当前选中批次 id（受控）。
     * 同一行二次点击 / 切换到不同行都通过 @row-click → emit('select') 走。
     * 父级 usePartDetail 持有 selectedBatchId ref，本卡与 ProcessChainCard /
     * PartHistoryCard 共享同一份 selectedBatchId 形成联动。
     */
    selectedBatchId?: string | null;
    statusTagType: (s: OrderStatus) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
    statusLabelOf: (s: string | null | undefined) => string;
    /**
     * 2026-09-17 UI 调整：是否包外层 el-card + header。
     * 默认 false（详情页时间线卡父级已包，避免嵌套两重）；
     * 独立入口（如未来批量批次管理页）传 true 即可拿到完整卡视觉。
     */
    wrapCard?: boolean;
  }>(),
  { wrapCard: false, selectedBatchId: null },
);

const emit = defineEmits<{
  (e: 'fetch'): void;
  // 2026-08-25 T10p5：dialog 关闭延迟到 API 成功之后。
  // shell 调用 resolve(ok) → 本组件根据 ok 决定是否关 dialog + reset submitting。
  (
    e: 'split',
    payload: { batch: PartBatch; quantity: number; resolve: (ok: boolean) => void },
  ): void;
  (e: 'cancelBatch', batch: PartBatch): void;
  // 2026-09-17 新增：行选中（toggle）。payload = PartBatch 时选中；
  // payload = null 时撤销选中。
  (e: 'select', batch: PartBatch | null): void;
}>();

const batchTotalQty = computed(() => props.batches.reduce((acc, b) => acc + b.quantity, 0));

function isTerminalBatch(b: PartBatch): boolean {
  return b.status === 'COMPLETED' || b.status === 'CANCELLED';
}

/**
 * 2026-09-17 新增：行选中态。
 * - rowClassName 给 el-table 当前选中行加 is-selected-batch
 *   （CSS scoped 命中后背景色改变，与 EP 默认 hover 区分开）
 * - onRowClick 实现 toggle：同一行二次点击撤销选中；
 *   操作列按钮已 @click.stop，不会冒泡到 @row-click。
 */
function rowClassName({ row }: { row: PartBatch }): string {
  if (row.id === props.selectedBatchId) return 'is-selected-batch';
  return '';
}

function onRowClick(row: PartBatch): void {
  if (row.id === props.selectedBatchId) {
    emit('select', null);
  } else {
    emit('select', row);
  }
}

// 2026-08-27 T22：列顺序拖动 + 可见性。
// 「操作」列受 canManageBatches 控制 → 保留为字面量 <el-table-column v-if>，不进 defs。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  {
    key: 'batch_label',
    label: '批次',
    minWidth: 110,
    align: 'center',
    cellRender: ({ row }) =>
      h('span', { class: 'batch-label' }, (row as PartBatch).batch_label ?? ''),
  },
  {
    key: 'quantity',
    label: '数量',
    width: 80,
    align: 'right',
    cellRender: ({ row }) => h('span', null, (row as PartBatch).quantity),
  },
  {
    key: 'status',
    label: '状态',
    minWidth: 110,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartBatch;
      return h(
        ElTag,
        { type: props.statusTagType(r.status as OrderStatus), size: 'small', effect: 'plain' },
        () => props.statusLabelOf(r.status),
      );
    },
  },
  {
    key: 'current_holder_display',
    label: '所在位置',
    minWidth: 130,
    align: 'center',
    showOverflowTooltip: true,
    cellRender: ({ row }) => h('span', null, (row as PartBatch).current_holder_display || '—'),
  },
  {
    key: 'delivery_note_no',
    label: '送货单',
    minWidth: 150,
    align: 'center',
    showOverflowTooltip: true,
    cellRender: ({ row }) => h('span', null, (row as PartBatch).delivery_note_no || '—'),
  },
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'part_batch_monitor' });
const drag = useColumnDrag(columnDefs, { listKey: 'part_batch_monitor' });

// 2026-09-17 review 第 2 轮修复：列拖动接入改走 bodyRef → body 暴露的 tableRef。
// 旧版在父组件顶层 `const tableRef = ref()` 只是普通 ref，跟模板里的 `ref="tableRef"`
// 不挂钩（Vue 3 template ref 只匹配 <script setup> 里声明的顶层 ref），applyDrag
// 拿到 undefined 静默失效。batches=0 阶段 el-table 不挂载，tableRef 仍 undefined；
// v-if 切到 batches>0 后需要重新触发 applyDrag —— watch bodyRef.value.tableRef 兜底。
// 2026-09-17 修订：bodyRef 用结构化类型而非 InstanceType<typeof BatchBody>，
// <script setup> 编译产物不是合法构造器类型，InstanceType 取不到实例字段类型。
const bodyRef = ref<{ tableRef?: unknown } | null>(null);
// applyDrag 创建的内部 useDraggable 不可重复注册（每调一次都会新建一个），
// 用一次性的 flag 锁住，只在 tableRef 第一次非空时触发。
let dragApplied = false;
function tryApplyDrag(): void {
  if (dragApplied) return;
  const t = bodyRef.value?.tableRef;
  if (!t) return;
  drag.applyDrag(t as Parameters<typeof drag.applyDrag>[0]);
  dragApplied = true;
}
onMounted(tryApplyDrag);
watch(
  () => bodyRef.value?.tableRef,
  () => tryApplyDrag(),
);

// ============ 拆分对话框（局部 UI 状态）============
const splitDlg = useDialogSize({ desktopWidth: 420 });
const splitDialogVisible = ref(false);
const splitSource = ref<PartBatch | null>(null);
const splitQuantity = ref<number | undefined>(undefined);
const splitSubmitting = ref(false);

function openSplitDialog(b: PartBatch): void {
  splitSource.value = b;
  splitQuantity.value = undefined;
  splitDialogVisible.value = true;
}

function onSplitDialogClosed(): void {
  splitSource.value = null;
  splitQuantity.value = undefined;
}

function onSplitConfirm(): void {
  if (!splitSource.value || !splitQuantity.value) return;
  splitSubmitting.value = true;
  // shell 调 resolve(ok)：成功才关 dialog + reset submitting。
  emit('split', {
    batch: splitSource.value,
    quantity: splitQuantity.value,
    resolve: (ok: boolean) => {
      splitSubmitting.value = false;
      if (ok) splitDialogVisible.value = false;
    },
  });
}
</script>

<style lang="scss" scoped>
.batch-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}
// 2026-09-17 UI 调整：wrapCard=false 时裸 div 渲染，padding 留给父级卡片控制。
.batch-card-flat {
  padding: 0;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.event-count {
  color: var(--text-secondary);
  font-size: 13px;
}
.batch-label {
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
  font-weight: 600;
}
.muted {
  color: var(--text-secondary);
}

// 2026-08-27 T22：列设置工具条（与 ListShell 同款）
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.split-dialog-body p {
  margin: 6px 0;
  line-height: 1.6;
}

// 2026-09-17 新增：行选中态高亮。
// EP el-table row-class-name 加的 class 挂在 <tr> 上，但 hover/默认选中
// 也是 <tr>；用更高优先级的 background-color 直接覆盖，叠加 hover 用
// background-image 透明叠加即可。`--primary-bg` 在 variables.scss 已声明。
:deep(.el-table__row.is-selected-batch),
:deep(.el-table__row.is-selected-batch td.el-table__cell) {
  background-color: var(--primary-bg, #ecf5ff) !important;
}
:deep(.el-table__row.is-selected-batch:hover > td.el-table__cell) {
  background-color: var(--primary-bg, #ecf5ff) !important;
}
</style>
