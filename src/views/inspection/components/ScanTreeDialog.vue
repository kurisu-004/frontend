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

  高亮一律以**后端**的 `is_scanned` 为准：独立件树 = 该件全部批次亮；扫装配件子件 =
  只有被扫中那个子件的批次亮（兄弟子件不亮）；扫装配件条码 = 全部不亮。零件层没有
  独立 flag，由「任一批次被扫中」反推。

  ⚠️ 规模上限：扫码端点**无分页、不过滤状态**（含终态批次），这里 `default-expand-all`
  全展开且没有虚拟滚动。装配件 N 子件 × M 批次到上千行会卡；后端一旦在该端点加分页，
  本组件要换虚拟表格（并把展开态改成按需拉子节点）。

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
        含返修中批次：指定工序已被禁用（后端 20118 守卫），请到「返修接收」页处理
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
          <span :class="{ muted: !row.current_holder_display && !row.location }">{{
            locationDisplay(row as ScanTreeRow)
          }}</span>
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
      <el-table-column prop="customer_name" label="客户" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ muted: !row.customer_name }">{{ row.customer_name || '—' }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" min-width="300" fixed="right">
        <!--
          el-table-column 的插槽行类型是 EP 的 `DefaultRow`（Record<PropertyKey, any>），
          那个类型不可赋给「有必填属性」的结构（索引签名不算声明了这些键），所以动作
          函数统一只收窄到 `ActionRow`，模板里断言一次而不是整行 `as ScanTreeRow`。
        -->
        <template #default="{ row }">
          <span v-if="row.node_kind !== 'BATCH'" class="muted">—</span>
          <template v-else-if="row.status === 'INSPECTION'">
            <el-button size="small" type="success" @click="onPass(row as ActionRow)"
              >品检通过</el-button
            >
            <el-tooltip :disabled="!row.is_repairing" :content="REPAIRING_HINT" placement="top">
              <span class="btn-wrap">
                <el-button
                  size="small"
                  type="warning"
                  :disabled="row.is_repairing"
                  @click="onAssignProcess(row as ActionRow)"
                  >指定工序</el-button
                >
              </span>
            </el-tooltip>
          </template>
          <template v-else-if="canSendToInspection(row as SendGateRow)">
            <el-button size="small" type="primary" @click="toggleSendPanel(row as ActionRow)">
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
                @click="onConfirmSend(row as ActionRow)"
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

const props = defineProps<{
  modelValue: boolean;
  /** 品检架候选（INSPECTION zone / active）。由壳从 `store.options.inspectionShelves`
   *  传入 —— 子组件不读 store.options（store 的不变量 #1：首调只在壳里）。
   *  送检提交时还要用它把品检架名回传给 store（写后本地回写「当前位置」列）。 */
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
  /** 加急标记：批次行从父零件继承（批次表本身没有该列）。 */
  is_urgent: boolean;
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

/** 动作函数只收这三个字段：el-table 注入的插槽行是 `Record<PropertyKey, any>`，把它断言
 *  成下面的窄结构再传，模板里就不用整行断言。 */
type ActionRow = Pick<ScanTreeRow, 'id' | 'quantity' | 'batch'>;

/** 送检按钮的显隐还要读 status / location，凑成这一个窄结构。 */
type SendGateRow = ActionRow & Pick<ScanTreeRow, 'status' | 'location'>;

/** 可送检的批次状态。IN_PROCESS 还带一道 location 闸门，见 canSendToInspection。 */
const SEND_TO_INSPECTION_STATUSES: readonly string[] = ['PENDING', 'PROGRAMMING', 'IN_PROCESS'];

/** 返修批次的「指定工序」为什么不给：后端对返修中批次返 20118 守卫，而本仓的返修出口
 *  在「返修接收」页（那里才是「返修中」批次的可操作面）。 */
const REPAIRING_HINT = '返修中的批次不可指定工序（后端 20118 守卫），请在「返修接收」页处理';

/** 位置枚举 → 中文。仓内无共享 location 文案表，这里域内自持一份：只用来兜住
 *  「批次在池里但 holder 显示不出来」的行，宁可给个粗粒度中文也不把枚举原文
 *  （PRODUCTION_SHELF / OUTSOURCE_COMPANY）怼到产线操作员脸上。 */
const LOCATION_LABEL: Record<string, string> = {
  PRODUCTION_SHELF: '生产架',
  INSPECTION_SHELF: '品检架',
  WORKER: '工人',
  OFFICE: '办公室',
  OUTSOURCE_COMPANY: '外协',
};

function partRow(part: ScanPartOut): ScanTreeRow {
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
    is_urgent: part.is_urgent,
    batch_no: null,
    is_repairing: false,
    location: null,
    current_holder_display: null,
    process_name: null,
    // 零件层后端没有独立 flag：任一批次被扫中即视为「这条子件就是刚扫的那个」。
    is_scanned: part.children.some((b) => b.is_scanned),
    batch: null,
    children: part.children.map((b) => batchRow(b, part)),
  };
}

function batchRow(batch: ScanBatchOut, parent: ScanPartOut): ScanTreeRow {
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
    // 客户与加急同样只在零件节点上，批次行从父零件继承（装配件跨子件时树的每一行
    // 都要能看出客户，否则扫装配件时无从判断这批活是哪家的）。
    customer_name: parent.customer_name,
    is_urgent: parent.is_urgent,
    batch_no: batch.batch_no,
    is_repairing: batch.is_repairing,
    location: batch.location,
    current_holder_display: batch.current_holder_display,
    process_name: batch.process_name,
    // 逐字透传后端 flag：扫装配件条码时全 false，扫子件时只有被扫中那个子件的批次 true。
    is_scanned: batch.is_scanned,
    batch,
    children: [],
  };
}

const tree = computed<ScanTreeOut | null>(() => store.mutations.scanTree);

const rows = computed<ScanTreeRow[]>(() => {
  const t = tree.value;
  if (!t) return [];
  // 扫到装配件条码时顶层是装配件节点（它自己没有批次，批次挂在子件下）；扫到子件 /
  // 独立件条码时顶层直接就是零件数组。两种形态的列渲染完全一致，故统一成一张表，
  // 高亮一律交给各行自己的后端 flag。
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
        is_urgent: t.assembly.is_urgent,
        batch_no: null,
        is_repairing: false,
        location: null,
        current_holder_display: null,
        process_name: null,
        is_scanned: false,
        batch: null,
        children: t.children.map((p) => partRow(p)),
      },
    ];
  }
  return t.children.map((p) => partRow(p));
});

const scannedSerialNo = computed<string>(() => tree.value?.scanned_serial_no ?? '');
/** 扫到的东西有三种，后端用 `hit_kind` + 「有没有 assembly」两处信息区分（单看
 *  hit_kind 分不出装配件子件与独立件，而两者的树形态不同：前者带装配件根行）。 */
const hitKindLabel = computed<string>(() => {
  const t = tree.value;
  if (!t) return '';
  if (t.hit_kind === 'ASSEMBLY') return '装配件条码';
  return t.assembly ? '装配件子件条码' : '独立件条码';
});
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

/** 被扫中的那个零件（含它的批次）整行高亮 —— 用户扫完一眼要能认出「刚扫的是哪个」；
 *  加急行套一层 `row-urgent`（红底，视觉信号照同页 InspectionTable 的做法）。
 *  两者同时命中时以 CSS 书写顺序为准：`row-urgent` 在前、`row-scanned` 在后，
 *  扫码高亮是「当前动作焦点」，优先于加急底色。 */
function rowClassName({ row }: { row: ScanTreeRow }): string {
  const classes: string[] = [];
  if (row.is_urgent) classes.push('row-urgent');
  if (row.is_scanned) classes.push('row-scanned');
  return classes.join(' ');
}

function statusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status as OrderStatus] ?? status;
}

function statusTagType(status: string): 'info' | 'warning' | 'success' | 'danger' | 'primary' {
  return ORDER_STATUS_TAG_TYPE[status as OrderStatus] ?? 'info';
}

/** 当前位置：holder 名优先（货架 / 工人 / 外协公司名），没有就退到 location 的中文
 *  兜底，都没有给 `—`（不吐枚举原文）。零件 / 装配件行恒 `—`（它们不入池）。 */
function locationDisplay(row: ScanTreeRow): string {
  if (row.current_holder_display) return row.current_holder_display;
  if (!row.location) return '—';
  return LOCATION_LABEL[row.location] ?? '—';
}

/** 送检按钮的显隐。IN_PROCESS 多一道 location 闸门：后端要求源批次
 *  `location='PRODUCTION_SHELF'` 且持有人是货架，工人手上的 IN_PROCESS 批次
 *  （location='WORKER'）必被 20103 拒 —— 那种行不给按钮。location 为空的老数据照给，
 *  真被拒时由 mutation 的 onError 把后端原文弹出来。 */
function canSendToInspection(row: SendGateRow): boolean {
  if (!SEND_TO_INSPECTION_STATUSES.includes(row.status)) return false;
  if (row.status !== 'IN_PROCESS') return true;
  return !row.location || row.location === 'PRODUCTION_SHELF';
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

function toggleSendPanel(row: ActionRow): void {
  if (sendForms[row.id]) {
    delete sendForms[row.id];
    return;
  }
  sendForms[row.id] = { shelfId: '', quantity: row.quantity };
}

async function onConfirmSend(row: ActionRow): Promise<void> {
  const batch = row.batch;
  const form = sendForms[row.id];
  if (!batch || !form?.shelfId) return;
  // 目标品检架名带进 vars：写成功后 store 要用它回写树里这一行的「当前位置」。
  const shelfName = props.inspectionShelves.find((s) => String(s.id) === form.shelfId)?.name ?? '';
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
      targetShelfName: shelfName,
    });
    delete sendForms[row.id];
  } catch {
    // onError 已提示；保留面板让用户改品检架后重试。
  } finally {
    sendSubmittingId.value = null;
  }
}

// ============ 外抛动作 ============
function onPass(row: ActionRow): void {
  if (row.batch) emit('pass', row.batch);
}

function onAssignProcess(row: ActionRow): void {
  if (row.batch) emit('assignProcess', row.batch);
}

/** 关闭时把树清掉：不清的话下次扫码请求在飞时会先闪出上一次的树。
 *  行内送检面板的选择也一起清（展开态 + 已选品检架 + 数量 + 提交中锚）：它是**按
 *  batch_id 记**的会话态，不清就会随扫过的批次单调增长，且下次扫别的码时旧条目
 *  还挂在内存里。「同一批次反复送检不重填」的意图靠「开着的时候不清」保住。 */
function onClosed(): void {
  store.mutations.clearScanTree();
  for (const key of Object.keys(sendForms)) delete sendForms[key];
  sendSubmittingId.value = null;
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

// 行底色走 :deep —— 目标 el-table__row 是 EP 内部节点，scoped 选择器带不上 scopeId。
// 两组规则的顺序即优先级：加急（红底，照同页 InspectionTable 的 #fde2e2 同款色值）
// 在前、扫码高亮（浅蓝）在后 ⇒ 两者同时命中时扫码高亮生效（它是「刚扫的是哪个」的
// 焦点信号，比加急更重要），且后写的规则靠同优先级覆盖取胜，不靠选择器权重博弈。
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover) > td.el-table__cell {
  background-color: #fbcaca !important;
}
:deep(.el-table__row.row-scanned) > td.el-table__cell {
  background-color: #eaf2fb !important;
}
:deep(.el-table__row.row-scanned:hover) > td.el-table__cell {
  background-color: #d6e6f7 !important;
}
</style>
