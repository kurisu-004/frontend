<!--
  ScanTreeDialog.vue — 扫码命中的「装配件 → 子零件 → 批次」三层树（2026-10-05 新增）。

  数据源是 `GET /api/v2/prod/inspection/scan/{serial_no}`（store 的 `scanMutation`
  拉、结果存在 `store.mutations.scanTree`）。三层用一张 el-table 的 tree data 表达：
  `row-key` 按层加前缀（`ASSEMBLY_` / `PART_` / `BATCH_`）后，一张表就能承载这三层。

  操作列只对**批次行**渲染（装配件 / 零件行没有可写的对象），按钮矩阵由批次 `status`
  单点决定：
    - INSPECTION → 品检通过（to-ship）/ 指定工序（to-process）
    - PENDING / PROGRAMMING / IN_PROCESS → 送检（to-inspection，行内选品检架）
    - 其余（READY_TO_SHIP / DELIVERED / COMPLETED / CANCELLED / OUTSOURCE …）→ 不给按钮
  「品检通过」「指定工序」只 emit，由壳（InspectionPending.vue）复用它已有的两个对话框 ——
  品检器在这里选数量、选工序 + 货架，没有理由重造一遍。

  本组件**不**首调 `useInspectionListStore()`（不变量 #1：首调在壳里；父组件 setup
  先于子组件执行，这里的调用命中同一实例）。品检架候选也走 prop 传入，不在子组件里
  读 store.options。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="扫码结果 — 装配件 / 子零件 / 批次"
    fullscreen
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @closed="onClosed"
  >
    <div class="scan-tree-toolbar">
      <span class="muted">
        扫到条码 <strong>{{ scannedSerialNo || '—' }}</strong
        >（{{ hitKindLabel }}）—— 共 {{ partCount }} 个零件 / {{ batchCount }} 个批次
      </span>
      <el-tag v-if="isRepairingHint" type="danger" size="small" effect="plain">
        含返修中批次：指定工序已被禁用，请用「完成返修」
      </el-tag>
    </div>

    <el-table
      v-loading="store.mutations.scanMutation.isPending"
      :data="rows"
      :row-key="rowKey"
      :tree-props="{ children: 'children' }"
      :row-class-name="rowClassName"
      default-expand-all
      height="calc(100vh - 220px)"
      aria-label="扫码批次树"
      stripe
      border
      size="small"
      style="width: 100%"
    >
      <el-table-column prop="serial_no" label="序列号" min-width="130" fixed="left">
        <template #default="{ row }">
          <span>{{ row.serial_no || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="drawing_no" label="图号" min-width="130" show-overflow-tooltip />
      <el-table-column prop="name" label="名称" min-width="150" show-overflow-tooltip />
      <el-table-column label="数量" width="80" align="center">
        <template #default="{ row }">
          <span v-if="row.node_kind === 'BATCH'">#{{ row.batch_no }} · {{ row.quantity }}</span>
          <span v-else>{{ row.quantity }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small" effect="plain">
            {{ statusLabel(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="当前位置" min-width="130" show-overflow-tooltip>
        <template #default="{ row }">
          <span>{{ row.current_holder_display || row.location || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="工序" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ muted: !row.process_name }">{{ row.process_name || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="系统交期" width="110" align="center">
        <template #default="{ row }">
          <span :class="{ muted: !row.system_delivery_date }">
            {{ row.system_delivery_date || '—' }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="操作" min-width="300" fixed="right">
        <!--
          el-table-column 的插槽行类型是 EP 的 `DefaultRow`（Record<string, any>），
          这里按本组件的 ScanTreeRow 断言后交给动作函数（照 PartPickerDialog 操作列的
          同款 cast —— el-table 的行是 EP 从 table 上下文注入的，类型面拦不住）。
        -->
        <template #default="{ row }">
          <span v-if="row.node_kind !== 'BATCH'" class="muted">—</span>
          <template v-else-if="row.status === 'INSPECTION'">
            <el-button size="small" type="success" @click="onPass(row as ScanTreeRow)"
              >品检通过</el-button
            >
            <el-tooltip
              :disabled="!row.is_repairing"
              content="返修中的批次请用「完成返修」流转"
              placement="top"
            >
              <span class="btn-wrap">
                <el-button
                  size="small"
                  type="warning"
                  :disabled="row.is_repairing"
                  @click="onAssignProcess(row as ScanTreeRow)"
                  >指定工序</el-button
                >
              </span>
            </el-tooltip>
          </template>
          <template v-else-if="SEND_TO_INSPECTION_STATUSES.includes(row.status)">
            <el-button size="small" type="primary" @click="toggleSendPanel(row as ScanTreeRow)">
              {{ sendPanel(row.id) ? '收起' : '送检' }}
            </el-button>
            <!--
              面板内两个受控值用 `:model-value` + `@update:model-value` 而不是 v-model
              绑 `sendForms[id]` 的字段：后者要在渲染期取值（v-model 的读取是编译成
              在当前作用域求值的表达式），那会顺带在渲染里写 reactive 状态。
            -->
            <div v-if="sendPanel(row.id)" class="send-panel">
              <el-select
                :model-value="sendPanel(row.id)?.shelfId ?? ''"
                placeholder="选择品检架"
                filterable
                clearable
                size="small"
                style="width: 180px"
                @update:model-value="(v: string) => setShelfId(row.id, v)"
              >
                <el-option
                  v-for="s in inspectionShelves"
                  :key="s.id"
                  :value="String(s.id)"
                  :label="`${s.code} — ${s.name}`"
                />
              </el-select>
              <el-input-number
                :model-value="sendPanel(row.id)?.quantity"
                :min="1"
                :max="row.quantity"
                :precision="0"
                size="small"
                controls-position="right"
                style="width: 120px"
                @update:model-value="(v: number | undefined) => setQuantity(row.id, v)"
              />
              <el-button
                size="small"
                type="primary"
                :loading="sendSubmittingId === row.id"
                :disabled="!sendPanel(row.id)?.shelfId"
                @click="onConfirmSend(row as ScanTreeRow)"
                >确认送检</el-button
              >
            </div>
          </template>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>

<script setup lang="ts">
// views/inspection/components/ScanTreeDialog.vue —— 见文件头。

import { computed, reactive, ref } from 'vue';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE, type OrderStatus } from '@/types/parts';
import type { ScanBatchOut, ScanPartOut, ScanTreeOut } from '@/api/inspection';
import type { Shelf } from '@/types/shelf';
import { useInspectionListStore } from '../composables/useInspectionListStore';

defineProps<{
  modelValue: boolean;
  /** 品检架候选（INSPECTION zone / active）。由壳从 `store.options.inspectionShelves`
   *  传入 —— 子组件不读 store.options（store 的不变量 #1：首调只在壳里）。 */
  inspectionShelves: Shelf[];
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 「品检通过」：把该批次行抛给壳，由壳打开带数量输入的对话框。 */
  pass: [row: ScanBatchOut];
  /** 「指定工序」：同上，壳打开「下一道工序 + 目标生产货架 + 备注」对话框。
   *  事件名 camelCase（仓库 lint 规则 vue/custom-event-name-casing：只有 update:*
   *  协议事件允许连字符）；父组件仍可写 `@assign-process`，模板编译会 camelize。 */
  assignProcess: [row: ScanBatchOut];
}>();

const store = useInspectionListStore();

// ============ 树 → 表格行 ============
// 三层的字段集不一样（零件没有 location / 工序，批次没有系统交期 / 图号），统一摊成
// 一行一形态，好处是列定义只写一遍、模板里不必到处 v-if 判层。
type ScanNodeKind = 'ASSEMBLY' | 'PART' | 'BATCH';

interface ScanTreeRow {
  node_kind: ScanNodeKind;
  id: string;
  serial_no: string | null;
  drawing_no: string;
  name: string;
  quantity: number;
  status: string;
  system_delivery_date: string | null;
  customer_name: string | null;
  // 批次行专有
  batch_no: number | null;
  is_repairing: boolean;
  location: string | null;
  current_holder_display: string | null;
  process_name: string | null;
  is_scanned: boolean;
  /** 批次行的原始 VO（emit 载荷）；非批次行为 null */
  batch: ScanBatchOut | null;
  children: ScanTreeRow[];
}

/** 可送检的批次状态。IN_PROCESS 批次的 location 若是 WORKER（工人手上）后端会拒，
 *  提示由 toInspectionMutation 的 onError 给后端原文。 */
const SEND_TO_INSPECTION_STATUSES: readonly string[] = ['PENDING', 'PROGRAMMING', 'IN_PROCESS'];

function partRow(part: ScanPartOut, scanned: boolean): ScanTreeRow {
  return {
    node_kind: 'PART',
    id: part.id,
    serial_no: part.serial_no,
    drawing_no: part.drawing_no,
    name: part.name,
    quantity: part.quantity,
    status: part.status,
    system_delivery_date: part.system_delivery_date,
    customer_name: part.customer_name,
    batch_no: null,
    is_repairing: false,
    location: null,
    current_holder_display: null,
    process_name: null,
    is_scanned: scanned,
    batch: null,
    children: part.children.map((b) => batchRow(b, scanned)),
  };
}

function batchRow(batch: ScanBatchOut, parentScanned: boolean): ScanTreeRow {
  return {
    node_kind: 'BATCH',
    id: batch.id,
    // 批次本身没有序列号 / 图号 / 名称：这三个字段在父级零件行上。
    serial_no: null,
    drawing_no: '',
    name: '',
    quantity: batch.quantity,
    status: batch.status,
    system_delivery_date: null,
    customer_name: null,
    batch_no: batch.batch_no,
    is_repairing: batch.is_repairing,
    location: batch.location,
    current_holder_display: batch.current_holder_display,
    process_name: batch.process_name,
    is_scanned: parentScanned && batch.is_scanned,
    batch,
    children: [],
  };
}

const tree = computed<ScanTreeOut | null>(() => store.mutations.scanTree);

const rows = computed<ScanTreeRow[]>(() => {
  const t = tree.value;
  if (!t) return [];
  // 扫到装配件条码时顶层是装配件节点（它自己没有批次，批次挂在子件下）；扫到子件 /
  // 独立件条码时顶层直接就是零件数组。两种形态的列渲染完全一致，故统一成一张表。
  if (t.assembly) {
    return [
      {
        node_kind: 'ASSEMBLY',
        id: t.assembly.id,
        serial_no: t.assembly.serial_no,
        drawing_no: t.assembly.drawing_no,
        name: t.assembly.name,
        quantity: t.assembly.quantity,
        status: t.assembly.status,
        system_delivery_date: t.assembly.system_delivery_date,
        customer_name: t.assembly.customer_name,
        batch_no: null,
        is_repairing: false,
        location: null,
        current_holder_display: null,
        process_name: null,
        is_scanned: false,
        batch: null,
        children: t.children.map((p) => partRow(p, false)),
      },
    ];
  }
  return t.children.map((p) => partRow(p, true));
});

const scannedSerialNo = computed<string>(() => tree.value?.scanned_serial_no ?? '');
const hitKindLabel = computed<string>(() =>
  tree.value?.hit_kind === 'ASSEMBLY' ? '装配件条码' : '子零件 / 独立件条码',
);
const partCount = computed<number>(() => tree.value?.children.length ?? 0);
const batchCount = computed<number>(
  () => tree.value?.children.reduce((sum, p) => sum + p.children.length, 0) ?? 0,
);
const isRepairingHint = computed<boolean>(
  () => tree.value?.children.some((p) => p.children.some((b) => b.is_repairing)) ?? false,
);

/** row-key 按层加前缀：三层的 id 都来自雪花流，跨层完全可能撞车（装配件 id 与它的
 *  子件 id 同号在库层面不成立，但零件 id 与批次 id 同号是可能的），撞了 el-table 的
 *  展开态 / 选择态会串行。与 PartsTable 的 rowKey 同款理由。 */
function rowKey(row: ScanTreeRow): string {
  return `${row.node_kind}_${row.id}`;
}

/** 被扫中的那个零件（含它的批次）整行高亮 —— 用户扫完一眼要能认出「刚扫的是哪个」。 */
function rowClassName({ row }: { row: ScanTreeRow }): string {
  return row.is_scanned ? 'row-scanned' : '';
}

function statusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status as OrderStatus] ?? status;
}

function statusTagType(status: string): 'info' | 'warning' | 'success' | 'danger' | 'primary' {
  return ORDER_STATUS_TAG_TYPE[status as OrderStatus] ?? 'info';
}

// ============ 行内送检面板 ============
/** 展开态与面板内选择按 batch_id 记：同一个批次反复送检不该重填品检架 / 数量。
 *  key 不存在 = 面板收起（渲染期只读，不在这里建对象）。 */
const sendForms = reactive<Record<string, { shelfId: string; quantity: number | undefined }>>({});
const sendSubmittingId = ref<string | null>(null);

function sendPanel(batchId: string): { shelfId: string; quantity: number | undefined } | undefined {
  return sendForms[batchId];
}

function setShelfId(batchId: string, value: string | undefined): void {
  const form = sendForms[batchId];
  if (form) form.shelfId = value ?? '';
}

function setQuantity(batchId: string, value: number | undefined): void {
  const form = sendForms[batchId];
  if (form) form.quantity = value;
}

function toggleSendPanel(row: ScanTreeRow): void {
  if (sendForms[row.id]) {
    delete sendForms[row.id];
    return;
  }
  sendForms[row.id] = { shelfId: '', quantity: row.quantity };
}

async function onConfirmSend(row: ScanTreeRow): Promise<void> {
  const batch = row.batch;
  const form = sendForms[row.id];
  if (!batch || !form?.shelfId) return;
  sendSubmittingId.value = row.id;
  try {
    // OCC 锚用 **batch.version**（t_part_batch.version），不是零件行的 version
    // （t_part.version 是另一个计数器，混用必 409）。
    await store.mutations.toInspectionMutation.mutateAsync({
      batchId: batch.id,
      targetInspectionShelfId: form.shelfId,
      version: batch.version,
      quantity: form.quantity ?? null,
      label: batch.batch_no ? `批次 #${batch.batch_no}` : batch.id,
    });
    delete sendForms[row.id];
  } catch {
    // onError 已提示；保留面板让用户改品检架后重试。
  } finally {
    sendSubmittingId.value = null;
  }
}

// ============ 外抛动作 ============
function onPass(row: ScanTreeRow): void {
  if (row.batch) emit('pass', row.batch);
}

function onAssignProcess(row: ScanTreeRow): void {
  if (row.batch) emit('assignProcess', row.batch);
}

/** 关闭时把树清掉：不清的话下次扫码请求在飞时会先闪出上一次的树。 */
function onClosed(): void {
  store.mutations.clearScanTree();
}
</script>

<style lang="scss" scoped>
.scan-tree-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 4px 8px;
}

.muted {
  color: var(--text-secondary);
}

.send-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

// el-tooltip 的触发子元素必须是能接收事件的单元素；按钮 disabled 后不派发事件，
// 套一层 span 承接 hover（否则禁用态拿不到 tooltip）。
.btn-wrap {
  display: inline-block;
}

// 行高亮走 :deep —— 目标 el-table__row 是 EP 内部节点，scoped 选择器带不上 scopeId。
:deep(.el-table__row.row-scanned) > td.el-table__cell {
  background-color: #eaf2fb !important;
}
:deep(.el-table__row.row-scanned:hover) > td.el-table__cell {
  background-color: #d6e6f7 !important;
}
</style>
