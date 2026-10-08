<!--
  DeliveryScanTreeDialog.vue — 扫码入单三层树（装配件 → 子件 → 批次）对话框
  （2026-10-08 新增）。数据源是 `GET /api/v2/com/delivery/note/scan/{serial_no}`
  （`useDeliveryScanTreeMutation` 拉，结果在 `submission.scanTree`）。

  三层用一张 el-table 的 tree data 表达，`row-key` 按层加前缀
  （`ASSEMBLY_` / `PART_` / `BATCH_`）：三层的 id 都来自雪花流，跨层完全可能撞车
  （零件 id 与批次 id 同号是可能的），撞了展开态 / 选择态会串行。

  **入单按钮的位置是业务硬约束**（不是随手放的）：
    · 装配件 → 按钮在 **assembly 行**（入单单位是「套」，服务端按套把每个子件的目标件数
      算成 `sets × (part.quantity / assembly.quantity)` 再跑一遍 DP 分配）；
    · 普通零件 → 按钮在 **part 行**（入单单位是「件」）；
    · 批次行**没有**入单按钮 —— 批次是服务端 DP 分配的结果，前端不选批次。
  点按钮弹 `DeliveryEntryQuantityDialog` 收量，收集齐后一次性提交
  `POST /com/delivery/note/scan`（同一个 serial 下可能有多个节点入单）。

  批次层的 `occupied_by_note_no` 非空 = 已被某张送货单占用（后端
  `LEFT JOIN t_delivery_note … dn.deleted_at IS NULL`）⇒ 标「已被 DN-xxx 占用」。
  ⚠️ 这只是**提示**：本表没有 `type="selection"` 列，占用不影响任何前端闸门 ——
  入单单位是「零件 / 装配件」，批次由服务端 DP 分配，而 DP 候选集只取「可入单」批次
  （SQL 已结构性排除被占用的）⇒ 占用批次永远选不中，不存在重复挂单。21406
  `BIZ_DELIVERY_NOTE_PART_ALREADY_ASSIGNED` 只在**该零件凑不出本次要的量、且失败明细
  里带占用批次**时才出现；同零件另有足量空闲批次时正常入单（判定域 = 本次分配实际
  需要的量，2026-10-09）。

  ⚠️ 规模上限：扫码端点**无分页、不过滤状态**（含终态批次），这里 `default-expand-all`
  全展开且没有虚拟滚动。装配件 N 子件 × M 批次到上千行会卡；后端一旦在该端点加分页，
  本组件要换虚拟表格（并把展开态改成按需拉子节点）。

  本组件**不**调任何 hook —— 数据与提交都由壳（DeliveryNoteScan.vue）持有
  （沿 ScanTreeDialog 的「壳首调 store、子组件只渲染」约定）。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="扫码入单 — 装配件 / 子零件 / 批次"
    :width="dlg.width"
    :top="dlg.top"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="scan-tree-toolbar">
      <span class="muted">
        扫到条码 <strong>{{ tree?.scanned_serial_no || '—' }}</strong>（{{ hitKindLabel }}）——
        共 {{ partCount }} 个零件 / {{ batchCount }} 个批次
      </span>
      <el-tag v-if="draft" type="warning" size="small" effect="plain">
        加入草稿 {{ draft.note_no }}（{{ draft.status }}）
      </el-tag>
      <el-tag v-else type="info" size="small" effect="plain">
        该一级客户下暂无草稿，提交时新建
      </el-tag>
    </div>

    <el-table
      :data="rows"
      :row-key="rowKey"
      :tree-props="{ children: 'children' }"
      default-expand-all
      max-height="52vh"
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
      <el-table-column label="数量" width="110" align="center">
        <template #default="{ row }">
          <span v-if="row.node_kind === 'BATCH'">#{{ row.batch_no }} · {{ row.quantity }}</span>
          <span v-else>{{ row.quantity }}</span>
        </template>
      </el-table-column>
      <el-table-column label="可入单" width="120" align="center">
        <template #default="{ row }">
          <span v-if="row.node_kind === 'PART'">
            {{ row.entry_max_quantity }} 件
          </span>
          <el-tooltip
            v-else-if="row.node_kind === 'ASSEMBLY'"
            :content="perSetText(row as ScanTreeRow)"
          >
            <span>{{ row.entry_max_sets }} 套</span>
          </el-tooltip>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small" effect="plain">
            {{ statusLabel(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="占用" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">
          <el-tag v-if="(row as ScanTreeRow).occupied_by_note_no" type="danger" size="small" effect="plain">
            已被 {{ (row as ScanTreeRow).occupied_by_note_no }} 占用
          </el-tag>
          <span v-else-if="row.node_kind === 'BATCH'" class="muted">未占用</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="系统交期" width="110" align="center">
        <template #default="{ row }">
          <span :class="{ muted: !row.system_delivery_date }">
            {{ row.system_delivery_date || '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="customer_name" label="客户" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ muted: !row.customer_name }">{{ row.customer_name || '—' }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" min-width="180" fixed="right">
        <!--
          el-table-column 的插槽行类型是 EP 的 `DefaultRow`（索引签名），动作函数统一
          只收窄到 `ActionRow`，模板里断言一次而不是整行 `as ScanTreeRow`。
          **入单按钮只在 assembly / part 行渲染**（见文件头「入单按钮的位置是业务硬约束」）。
        -->
        <template #default="{ row }">
          <el-button
            v-if="row.node_kind === 'ASSEMBLY'"
            size="small"
            type="primary"
            :disabled="entryMaxOf(row as ActionRow) <= 0"
            @click="onPick(row as ActionRow)"
          >
            入单
          </el-button>
          <el-button
            v-else-if="row.node_kind === 'PART'"
            size="small"
            type="primary"
            :disabled="entryMaxOf(row as ActionRow) <= 0"
            @click="onPick(row as ActionRow)"
          >
            入单
          </el-button>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="scan-tree-footer">
      <span class="muted">
        已选 {{ pendingEntries.length }} 项
        <template v-if="pendingEntries.length > 0">
          （{{ pendingEntries.map((e) => `${entryLabel(e)} ${e.quantity}`).join('、') }}）
        </template>
      </span>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        type="primary"
        data-role="submit"
        :loading="submitting"
        :disabled="pendingEntries.length === 0"
        @click="emit('submit', [...pendingEntries])"
      >
        确认入单
      </el-button>
    </div>

    <!-- 入单数量输入（零件输件数 / 装配件输套数） -->
    <DeliveryEntryQuantityDialog
      v-model="qtyDialogVisible"
      :kind="qtyTarget ? qtyTarget.kind : 'PART'"
      :node-id="qtyTarget ? qtyTarget.nodeId : ''"
      :node-name="qtyTarget ? qtyTarget.nodeName : ''"
      :max-quantity="qtyTarget ? qtyTarget.maxQuantity : 1"
      :per-set-parts="qtyTarget ? qtyTarget.perSetParts : []"
      :part-serials="partSerialMap"
      @submit="onQtySubmit"
    />
  </el-dialog>
</template>

<script setup lang="ts">
// views/com/delivery/components/DeliveryScanTreeDialog.vue —— 见文件头。

import { computed, ref, watch } from 'vue';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE, type OrderStatus } from '@/types/parts';
import { useDialogSize } from '@/composables/useDialogSize';
import DeliveryEntryQuantityDialog, { type DeliveryEntryKind } from './DeliveryEntryQuantityDialog.vue';
import type {
  DeliveryScanAssemblyData,
  DeliveryScanBatchData,
  DeliveryScanPartData,
  DeliveryScanTreeData,
} from '../composables/deliveryScanTreeSchema';
import type { DeliveryScanEntry } from '../composables/deliveryNoteSchema';

const props = defineProps<{
  modelValue: boolean;
  /** 三层树数据（壳从 submission.scanTree 传进来）。 */
  tree: DeliveryScanTreeData | null;
  submitting?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 确认入单：把收集到的条目交给壳提交。 */
  submit: [entries: DeliveryScanEntry[]];
}>();

const dlg = useDialogSize({ desktopWidth: 1200 });

// ============ 树 → 表格行 ============
// 三层的字段集不一样，统一摊成一行一形态，好处是列定义只写一遍、模板里不必到处 v-if 判层。
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
  /** 入单上限：assembly = entry_max_sets（套）；part = entry_max_quantity（件）。 */
  entry_max_quantity: number;
  entry_max_sets: number;
  per_set_parts: DeliveryScanAssemblyData['per_set_parts'];
  // 批次行专有
  batch_no: number | null;
  occupied_by_note_no: string | null;
  children: ScanTreeRow[];
}

/** 动作函数只收这两个字段（el-table 注入的插槽行是索引签名，模板里断言一次）。 */
type ActionRow = Pick<ScanTreeRow, 'id' | 'node_kind' | 'entry_max_quantity' | 'entry_max_sets'>;

function partRow(part: DeliveryScanPartData): ScanTreeRow {
  return {
    node_kind: 'PART',
    id: part.id,
    serial_no: part.serial_no,
    drawing_no: part.drawing_no,
    name: part.name,
    quantity: part.quantity,
    status: part.status,
    // 系统交期 / 客户只在零件节点上，批次行从父零件继承：装配件跨子件时树的每一行
    // 都要能看出交期与客户，否则扫装配件时无从判断这批活是哪家的、赶不赶得上。
    system_delivery_date: part.system_delivery_date,
    customer_name: part.customer_name,
    entry_max_quantity: part.entry_max_quantity,
    entry_max_sets: 0,
    per_set_parts: [],
    batch_no: null,
    occupied_by_note_no: null,
    children: part.children.map((b) => batchRow(b, part)),
  };
}

function batchRow(batch: DeliveryScanBatchData, parent: DeliveryScanPartData): ScanTreeRow {
  return {
    node_kind: 'BATCH',
    id: batch.id,
    // 批次本身没有序列号 / 图号 / 名称：这三个字段在父级零件行上。
    serial_no: null,
    drawing_no: '',
    name: '',
    quantity: batch.quantity,
    status: batch.status,
    system_delivery_date: parent.system_delivery_date,
    customer_name: parent.customer_name,
    entry_max_quantity: 0,
    entry_max_sets: 0,
    per_set_parts: [],
    batch_no: batch.batch_no,
    occupied_by_note_no: batch.occupied_by_note_no,
    children: [],
  };
}

function assemblyRow(a: DeliveryScanAssemblyData): ScanTreeRow {
  return {
    node_kind: 'ASSEMBLY',
    id: a.id,
    serial_no: a.serial_no,
    drawing_no: a.drawing_no,
    name: a.name,
    quantity: a.quantity,
    status: a.status,
    system_delivery_date: a.system_delivery_date,
    customer_name: a.customer_name,
    entry_max_quantity: 0,
    entry_max_sets: a.entry_max_sets,
    per_set_parts: a.per_set_parts,
    batch_no: null,
    occupied_by_note_no: null,
    children: [],
  };
}

const rows = computed<ScanTreeRow[]>(() => {
  const t = props.tree;
  if (!t) return [];
  // 扫到装配件条码时顶层是装配件节点（它自己没有批次，批次挂在子件下）；扫到子件 /
  // 独立件条码时顶层直接就是零件数组。两种形态的列渲染完全一致，故统一成一张表。
  if (t.assembly) {
    return [assemblyRow(t.assembly), ...t.children.map(partRow)];
  }
  return t.children.map(partRow);
});

const draft = computed(() => props.tree?.draft ?? null);

/** 扫到的东西有三种：装配件条码 / 装配件子件条码 / 独立件条码。 */
const hitKindLabel = computed<string>(() => {
  const t = props.tree;
  if (!t) return '';
  if (t.hit_kind === 'ASSEMBLY') return '装配件条码';
  return t.assembly ? '装配件子件条码' : '独立件条码';
});
const partCount = computed<number>(() => props.tree?.children.length ?? 0);
const batchCount = computed<number>(
  () => props.tree?.children.reduce((sum, p) => sum + p.children.length, 0) ?? 0,
);

/** row-key 按层加前缀（见文件头）。 */
function rowKey(row: ScanTreeRow): string {
  return `${row.node_kind}_${row.id}`;
}

function statusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status as OrderStatus] ?? status;
}

function statusTagType(status: string): 'info' | 'warning' | 'success' | 'danger' | 'primary' {
  return ORDER_STATUS_TAG_TYPE[status as OrderStatus] ?? 'info';
}

/** 「每套需 F1001-01 3 件 / 铝电解电容 2 件」——part_id 翻成子件可读名（序列号优先）。 */
function perSetText(row: ScanTreeRow): string {
  if (row.per_set_parts.length === 0) return '该装配件没有子件用量信息';
  return `每套需 ${row.per_set_parts
    .map((p) => `${partSerialOf(p.part_id)} ${p.per_set_quantity} 件`)
    .join(' / ')}`;
}

/**
 * part_id → 子件的可读名（把 per_set_parts 的雪花 id 翻成人看的东西）。
 *
 * 无序列号（`serial_no: null`：手工子件 / migration 007 释放过序列号的终态工单）退到
 * `name` —— **不退到 part_id**：那是裸雪花 id（「每套需 225132995307110400 3 件」）
 * 用户完全无法对应实物。查表本身仍由 `partSerialOf` 兜底 part_id（per_set_parts 引用了
 * 不在 children 里的子件时才会走到那条路，后端两处同源，正常不会）。
 */
const partSerialMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const p of props.tree?.children ?? []) map[p.id] = p.serial_no ?? p.name;
  return map;
});

/** 展示名兜底：查不到 id 就退到 id 本身（至少可定位，不显示空白）。 */
function partSerialOf(partId: string): string {
  return partSerialMap.value[partId] ?? partId;
}

// ============ 入单收集 ============
/** 已选但尚未提交的条目（同一节点重复点 = 后者覆盖前者，不产生重复行）。 */
const pendingEntries = ref<DeliveryScanEntry[]>([]);
/** 数量对话框的当前目标。 */
const qtyDialogVisible = ref(false);
const qtyTarget = ref<{
  kind: DeliveryEntryKind;
  nodeId: string;
  nodeName: string;
  maxQuantity: number;
  perSetParts: DeliveryScanAssemblyData['per_set_parts'];
} | null>(null);

// 每次打开（换一次扫码）清空上一批的待提交项。
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      pendingEntries.value = [];
      qtyTarget.value = null;
    }
  },
);

function entryMaxOf(row: ActionRow): number {
  return row.node_kind === 'ASSEMBLY' ? row.entry_max_sets : row.entry_max_quantity;
}

function onPick(row: ActionRow): void {
  const full = rows.value.find((r) => r.id === row.id && r.node_kind === row.node_kind);
  if (!full) return;
  const max = entryMaxOf(full);
  if (max <= 0) return;
  qtyTarget.value = {
    kind: full.node_kind as DeliveryEntryKind,
    nodeId: full.id,
    nodeName: full.name,
    maxQuantity: max,
    perSetParts: full.per_set_parts,
  };
  qtyDialogVisible.value = true;
}

function onQtySubmit(payload: { kind: DeliveryEntryKind; nodeId: string; quantity: number }): void {
  const entry: DeliveryScanEntry =
    payload.kind === 'ASSEMBLY'
      ? { node_kind: 'ASSEMBLY', node_id: payload.nodeId, sets: payload.quantity }
      : { node_kind: 'PART', node_id: payload.nodeId, quantity: payload.quantity };
  pendingEntries.value = [
    ...pendingEntries.value.filter((e) => !(e.node_kind === entry.node_kind && e.node_id === entry.node_id)),
    entry,
  ];
}

function entryLabel(e: DeliveryScanEntry): string {
  return e.node_kind === 'ASSEMBLY' ? '套' : '件';
}
</script>

<style lang="scss" scoped>
.scan-tree-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0 4px 8px;
}

.scan-tree-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>