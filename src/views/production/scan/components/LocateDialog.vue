<!--
  LocateDialog.vue

  扫码找件 · 只读诊断弹窗（`GET /api/v2/prod/scan/locate`）+ 自助恢复按钮。

  2026-10-15 新增。报工台三页（取件 / 放回 / 送检）扫到 0 匹配时的兜底出口组件：
  它回答「这个件现在在哪、为什么不在本工序、我能不能对它动手」，并把「能动手」的
  那些行变成按钮。

  为什么不再走 `GET /parts/by-serial/{sn}`（`findPartBySerialAndPrompt` 那一支）：
  那条端点的后端闸门是 `[Manager, Clerk, Inspector, CncProgrammer]`，**不含
  `SHELF_ACCOUNT`** ⇒ 工人一体机账号恒 403；报工台自有的 8 个端点全部放行它。
  返修页 `views/repair/RepairReceive.vue` 的角色集本就能过那道闸，故它继续用
  `findPartBySerialAndPrompt`，本组件**不**替换那条路径。

  数据流：
    三页扫到 0 匹配 → 置 `locateCode` + 开本弹窗
      → `useScanLocateQuery`（params = `{ serialNo: code, workerId: worker.id }`）
      → `locateResultSchema` 守门（少一个键 / 雪花 id 发成 number 都在这里炸）
      → 逐行按 `action` 渲染按钮。

  ⚠️ `worker_id` 必传：后端 `locate` 只在传了它时才计算 `action` / `disabled_reason`，
  不传则两者恒 null、一颗按钮都渲染不出来（只剩纯位置事实）。

  四类动作与「工序参数」的形态（后端 `docs/api/scan.md` §2.8 / §2.9 / §3.6 是权威）：
    - `PICK_UP`            → 复用取件端点，**先弹数量弹窗**（支持部分领取），确认后提交；
    - `MINE`               → 无按钮，行内写明「该批次已在你手上」（引导去放回 / 送检流）；
    - `TAKE_OVER`          → `POST /prod/scan/take-over`。`chain_state === 'NEXT'` 时
                             **不发** `next_process_id`（后端按链自推）；其余形态先弹
                             `ProcessPickerDialog` 手填（缺 → `40001`，链外 → `20702`）；
    - `RECEIVE_FROM_OUTSOURCE` → `POST /prod/scan/outsource-receive`。`chain_state ===
                             'NEXT'` 时**必须把诊断行的 `next_process_id` 原样回传**
                             （写侧缺省推导口径是 `sort_order = 当前 + 1`，与读侧
                             `sort_order > 当前 LIMIT 1` 在稀疏链上不等价，省略会吃
                             `20706` / `40001`）；其余形态先弹手填。
    - `action === null`    → 渲染 `disabled_reason` 的指引文案（9 个字面量逐条映射），
                             **该行不给按钮**。

  关闭权：本弹窗**不是**提交闸门（关掉只丢一次诊断，工人可重扫），故保留右上角 ×；
  但它内部启用的「手填工序」弹窗**是**提交闸门（那条链上它是唯一的提交入口），按
  CLAUDE.md「弹窗关闭权」以 `:show-close="false"` 收在 footer 两键上。
  本弹窗的成功路径**不依赖 WS**：动作成功后主动 `emit('done')` 让页面 refetch。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="min(95vw, 1200px)"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <!-- 诊断结果加载中 -->
    <div v-if="loading" class="state-block">
      <el-icon :size="32" class="is-loading"><Loading /></el-icon>
      <p>正在查询该条码的位置…</p>
    </div>

    <!-- 诊断失败（含 Zod 契约漂移）：文案走同目录既有的 scanListErrorText 收口。
         ⚠️ 后端「未命中」（20101）不算失败 —— 它落下面的空态，不落这里。 -->
    <div v-else-if="errorText" class="state-block error-state">
      <el-icon :size="32" color="#f56c6c"><CircleCloseFilled /></el-icon>
      <p class="error-text">{{ errorText }}</p>
      <el-button size="large" @click="retry">重新查询</el-button>
    </div>

    <!-- 未命中（后端返 20101）或该工单一个未软删批次都没有 -->
    <div v-else-if="notFound || !part || batches.length === 0" class="state-block">
      <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
      <p>没有找到条码 {{ code }} 对应的在制零件。</p>
      <p class="sub">若这是装配件，请改扫子件的序列号。</p>
    </div>

    <template v-else>
      <!-- 工单侧 7 字段：条码 / 名称 / 图号 / 交期 / 紧急标记 -->
      <div class="part-head">
        <div class="head-line">
          <span class="serial">{{ part.serial_no || code }}</span>
          <el-tag v-if="part.is_urgent" type="danger" size="small" effect="dark">加急</el-tag>
          <span class="name">{{ part.name }}</span>
        </div>
        <div class="head-meta">
          <span class="kv">
            <span class="k">图号</span>
            <span class="v">{{ part.drawing_no || '—' }}</span>
          </span>
          <span class="kv">
            <span class="k">系统交期</span>
            <span class="v">{{ part.system_delivery_date || '—' }}</span>
          </span>
          <span class="kv">
            <span class="k">计划交期</span>
            <span class="v">{{ part.planned_delivery_date || '—' }}</span>
          </span>
          <span class="kv">
            <span class="k">工单号</span>
            <span class="v mono">{{ part.id }}</span>
          </span>
        </div>
      </div>

      <!-- 批次诊断表：每行一个 LocateBatchItemDto（16 字段全用上）。
           ⚠️ 模板里逐处的 `row as LocateBatchRowData` 窄化不是洁癖：Element Plus 的
           `el-table-column` 作用域槽把 `row` 声明成 `DefaultRow`（`Record<PropertyKey, any>`），
           它**不是**本表的行类型；`:data` 的实际类型是 `LocateBatchRowData[]`，
           这些窄化恒成立，且与仓内其它 el-table 列表页（`WorkerList` / `ApplicantList` /
           `OutsourceList`）的同款写法一致。 -->
      <el-table :data="batches" class="locate-table" row-key="batch_id" border>
        <el-table-column label="批次" width="130">
          <template #default="{ row }">
            <span class="mono">#{{ (row as LocateBatchRowData).batch_no }}</span>
            <span class="qty">× {{ (row as LocateBatchRowData).quantity }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <span class="mono">{{ (row as LocateBatchRowData).status }}</span>
          </template>
        </el-table-column>
        <el-table-column label="位置 / 持有人" min-width="180">
          <template #default="{ row }">
            <span>{{ locationText(row as LocateBatchRowData) }}</span>
            <span v-if="(row as LocateBatchRowData).holder_display" class="holder">{{
              (row as LocateBatchRowData).holder_display
            }}</span>
            <!-- 外协批次另有两项诊断事实（仅 OUTSOURCE 非空），与 holder_display 不重复 -->
            <span v-if="(row as LocateBatchRowData).company_name" class="holder"
              >外协：{{ (row as LocateBatchRowData).company_name }}</span
            >
            <span v-if="(row as LocateBatchRowData).sent_at" class="holder"
              >发出：{{ (row as LocateBatchRowData).sent_at }}</span
            >
          </template>
        </el-table-column>
        <el-table-column label="当前工序" width="120">
          <template #default="{ row }">
            <span>{{ (row as LocateBatchRowData).current_process_name || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="链位置 / 下一道" min-width="180">
          <template #default="{ row }">
            <span class="chain-state">{{
              chainStateText((row as LocateBatchRowData).chain_state)
            }}</span>
            <span class="next">{{ nextProcessText(row as LocateBatchRowData) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="更新于" width="180">
          <template #default="{ row }">
            <span class="mono">{{ (row as LocateBatchRowData).updated_at }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="260" fixed="right">
          <template #default="{ row }">
            <template v-if="!(row as LocateBatchRowData).action">
              <!-- 无可行动作：只给指引文案，不给按钮 -->
              <span class="disabled-hint">{{
                locateDisabledReasonText((row as LocateBatchRowData).disabled_reason)
              }}</span>
            </template>
            <span v-else-if="(row as LocateBatchRowData).action === 'MINE'" class="mine-hint"
              >该批次已在你手上</span
            >
            <template v-else>
              <el-button
                size="small"
                type="primary"
                :loading="submitting"
                @click="onActionClick(row as LocateBatchRowData)"
              >
                {{ actionLabel((row as LocateBatchRowData).action) }}
              </el-button>
              <!-- 「为什么会推不出下一道」的可见事实：手填弹窗是点了按钮之后才出现的，
                   工人需要提前看到「这次要点两下」。 -->
              <span v-if="needManualProcess(row as LocateBatchRowData)" class="manual-hint">{{
                manualHintText(row as LocateBatchRowData)
              }}</span>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <template #footer>
      <el-button size="large" :icon="Refresh" @click="retry">刷新</el-button>
      <el-button size="large" type="primary" @click="close">关闭</el-button>
    </template>

    <!-- PICK_UP 的数量弹窗（部分领取）：与取件页同一个组件 -->
    <QuantityDialog
      v-if="qtyRow"
      v-model="showQtyDialog"
      :max="qtyRow.quantity"
      :serial-no="part?.serial_no || code"
      :part-name="part?.name || null"
      action-label="领取"
      @confirm="onQtyConfirm"
      @cancel="closeQtyDialog"
    />

    <!-- 手填下一道工序：提交闸门，关闭权收在 footer（:show-close="false"） -->
    <ProcessPickerDialog
      v-if="manualRow"
      v-model="showManualDialog"
      :kind="manualRow.kind"
      :show-close="false"
      @confirm="onManualProcessConfirm"
      @cancel="closeManualDialog"
    />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Box, CircleCloseFilled, Loading, Refresh } from '@element-plus/icons-vue';
import { ApiError } from '@/api/http';
import type { ScanWorkerBriefDto } from '@/api/productionScan.contract';
import { useScanLocateQuery } from '@/views/production/scan/composables/useScanLocateQuery';
import {
  useScanOutsourceReceiveMutation,
  useScanPickUpMutation,
  useScanTakeOverMutation,
} from '@/views/production/scan/composables/useScanWrite';
import { scanListErrorText } from '@/views/production/scan/composables/scanListErrorMessage';
import {
  locateDisabledReasonText,
  locateWriteErrorText,
} from '@/views/production/scan/composables/locateActionErrorText';
import type { LocateBatchRowData } from '@/views/production/scan/composables/scanSchema';
import ProcessPickerDialog from './ProcessPickerDialog.vue';
import QuantityDialog from './QuantityDialog.vue';
import type { Process } from '@/types/process';

const props = defineProps<{
  modelValue: boolean;
  /** 扫到的条码（后端只按 `t_part.serial_no` 查，**不回退 `t_assembly`**）。 */
  code: string;
  /** 当前扫码工人（`worker.id` 是传 `worker_id` 的来源，`badge_code` 是写端点的来源）。 */
  worker: ScanWorkerBriefDto;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 任一动作成功后触发：让页面 refetch 自己的列表（弹窗刷新不依赖 WS）。 */
  done: [];
}>();

/** `location` 是**真实值**（与同域两条 list 行那个恒 null 的占位方向相反），故逐值给中文名。 */
const LOCATION_TEXT: Readonly<Record<string, string>> = {
  PRODUCTION_SHELF: '生产架',
  WORKER: '工人手上',
  OUTSOURCE_COMPANY: '外协公司',
  INSPECTION_SHELF: '品检区',
  OFFICE: '办公室',
};

const CHAIN_STATE_TEXT: Readonly<Record<string, string>> = {
  NONE: '无工序链',
  NEXT: '链上有下一道',
  TAIL: '链尾（无下一道）',
};

const pickUpMutation = useScanPickUpMutation();
const takeOverMutation = useScanTakeOverMutation();
const receiveMutation = useScanOutsourceReceiveMutation();

/** 打开时才发起诊断：params 为 null 时 query 走占位键 + `enabled` 闸门，不发请求。 */
const locate = useScanLocateQuery(() =>
  props.modelValue && props.code && props.worker?.id
    ? { serialNo: props.code, workerId: String(props.worker.id) }
    : null,
);

const data = computed(() => locate.data.value);
const part = computed(() => data.value?.part ?? null);
const batches = computed<LocateBatchRowData[]>(() => data.value?.batches ?? []);
// `isPending` 而非 `isFetching`：后者在后台 refetch 期间也为 true，会让整表闪一次。
const loading = computed(() => locate.query.isPending.value);
// 2026-10-15：`20101`（工单未命中）走**空态**而不是失败态。
// 本弹窗只在「扫到 0 匹配」时打开，所以「扫了个不存在的条码」是它最高频的输入形态 —
// 把它渲染成一句红字「查询失败」+「重新查询」按钮是在告诉工人他操作错了，而他并没有。
// ⚠️ `locate` 刻意不回退 `t_assembly`（后端 §8 有登记），所以装配件序列号也走这一态。
const notFound = computed(
  () => locate.error.value instanceof ApiError && locate.error.value.code === 20101,
);
const errorText = computed(() =>
  !notFound.value && locate.error.value
    ? scanListErrorText(locate.error.value, '查询零件位置失败')
    : '',
);
const submitting = computed(
  () =>
    pickUpMutation.isPending.value ||
    takeOverMutation.isPending.value ||
    receiveMutation.isPending.value,
);

const dialogTitle = computed<string>(() => `扫码找件 · ${props.code}`);

/** --- PICK_UP 的数量弹窗状态 --- */
const qtyRow = ref<LocateBatchRowData | null>(null);
const showQtyDialog = ref(false);

/** --- 手填下一道工序的状态（接管 / 外协收回共用） --- */
const manualRow = ref<{ row: LocateBatchRowData; kind: 'takeover' | 'outsource' } | null>(null);
const showManualDialog = ref(false);

watch(
  () => props.modelValue,
  (open) => {
    // 关掉时把两条写路径的局部状态清干净，重开不会带着上一件的行。
    if (!open) {
      qtyRow.value = null;
      showQtyDialog.value = false;
      manualRow.value = null;
      showManualDialog.value = false;
    }
  },
);

function locationText(row: LocateBatchRowData): string {
  return LOCATION_TEXT[row.location ?? ''] ?? '未知位置';
}

function chainStateText(state: string): string {
  return CHAIN_STATE_TEXT[state] ?? `未知链位置（${state}）`;
}

/** 下一道工序名；`chain_state === 'NEXT'` 却没有名字 ⇒ 那道工序被软删了（id 仍在）。 */
function nextProcessText(row: LocateBatchRowData): string {
  if (row.next_process_name) return row.next_process_name;
  return row.chain_state === 'NEXT' ? '（下一道工序已删除）' : '—';
}

/**
 * 动作按钮文案 —— **三个可写动作逐个列出来**，不要用「不是 A 就是 B」的二选一。
 *
 * 按钮所在的那个分支同时覆盖 `PICK_UP` / `TAKE_OVER` / `RECEIVE_FROM_OUTSOURCE` 三个
 * 取值（`MINE` 与 `action === null` 在更上面两个分支各自 render 掉了），二选一会让
 * `PICK_UP` 的行长出「确认收回」这种与动作无关的按钮。`unknown` 档兜住后端新增字面量
 * 时「文案是个空白按钮」这个更难被发现的失败形态。
 */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  PICK_UP: '领取',
  TAKE_OVER: '接管',
  RECEIVE_FROM_OUTSOURCE: '确认收回',
};

function actionLabel(action: string | null): string {
  return ACTION_LABEL[action ?? ''] ?? '处理';
}

/** 该行是否必须先手填下一道工序：`chain_state !== 'NEXT'` 的形态（无链 / 链尾 /
 *  指针漂移）写侧都要求显式 `next_process_id`。 */
function needManualProcess(row: LocateBatchRowData): boolean {
  if (row.action !== 'TAKE_OVER' && row.action !== 'RECEIVE_FROM_OUTSOURCE') return false;
  return row.chain_state !== 'NEXT';
}

/** 手填提示：把「点下去会弹一个工序选择框」这件事提前说清楚，并说明为什么。 */
function manualHintText(row: LocateBatchRowData): string {
  if (row.chain_state === 'NONE') return '无工序链，需手工指定下一道';
  if (row.chain_state === 'TAIL') return '已是链上最后一道，需手工指定下一道';
  return '工序链推不出下一道，需手工指定';
}

function close(): void {
  emit('update:modelValue', false);
}

function retry(): void {
  void locate.fetchList();
}

function closeQtyDialog(): void {
  showQtyDialog.value = false;
  qtyRow.value = null;
}

function closeManualDialog(): void {
  showManualDialog.value = false;
  manualRow.value = null;
}

/**
 * 2026-10-15：写动作失败后立刻重新诊断一次。
 *
 * 为什么不能只弹一句错误就走：`action` 是**读侧按当前数据算出来的**，而最常见的失败
 * 恰恰意味着读侧那份数据已经过期 —— `40901`（别人已把这批处置了）、`20204`（容量触顶）、
 * `20103` / `20122`（行的持有关系与诊断结论不符）。不重查的话，这一行仍按旧事实渲染
 * 同一个按钮，工人再点一次吃同一个错，弹窗就成了「反复失败的机器」。
 * 重查后 `action` / `disabled_reason` 由新事实重新决定（如 40901 之后多半落
 * `TERMINAL` 或换成别人的 `MINE`），指引文案也跟着变。
 *
 * ⚠️ 失效链 `invalidateScanLists` 只覆盖报工台两条 list，不含本诊断查询
 * （见 `qk.scanLocate` 的注释：只读诊断、零写点），故这里显式 refetch。
 */
function reDiagnose(): void {
  void locate.fetchList();
}

async function onActionClick(row: LocateBatchRowData): Promise<void> {
  if (row.action === 'PICK_UP') {
    qtyRow.value = row;
    showQtyDialog.value = true;
    return;
  }
  if (row.action === 'MINE' || row.action === null) return;
  if (needManualProcess(row)) {
    manualRow.value = {
      row,
      kind: row.action === 'TAKE_OVER' ? 'takeover' : 'outsource',
    };
    showManualDialog.value = true;
    return;
  }
  // 链能自推：接管不带走工序（后端自推），外协收回**必须**原样回传诊断行的下一道 id。
  if (row.action === 'TAKE_OVER') {
    await submitTakeOver(row, null);
    return;
  }
  if (row.action === 'RECEIVE_FROM_OUTSOURCE') {
    await submitReceive(row, row.next_process_id);
  }
}

async function onQtyConfirm(qty: number): Promise<void> {
  const row = qtyRow.value;
  closeQtyDialog();
  if (!row) return;
  try {
    await pickUpMutation.mutateAsync({
      batchId: row.batch_id,
      version: row.version,
      workerId: String(props.worker.id),
      // 必须发字符串（后端 `deserialize_i64_opt` 只解 JSON string）。
      quantity: String(qty),
    });
    ElMessage.success(`已领取: ${part.value?.serial_no || props.code} × ${qty}`);
    close();
    emit('done');
  } catch (e) {
    ElMessage.error(locateWriteErrorText(e, 'PICK_UP'));
    reDiagnose();
  }
}

function onManualProcessConfirm(process: Process): void {
  const target = manualRow.value;
  closeManualDialog();
  if (!target) return;
  if (target.kind === 'takeover') {
    void submitTakeOver(target.row, process.id);
    return;
  }
  void submitReceive(target.row, process.id);
}

async function submitTakeOver(
  row: LocateBatchRowData,
  nextProcessId: string | null,
): Promise<void> {
  try {
    await takeOverMutation.mutateAsync({
      batchId: row.batch_id,
      badgeCode: props.worker.badge_code,
      version: row.version,
      nextProcessId,
    });
    ElMessage.success('已接管，该批次已转到你的名下');
    close();
    emit('done');
  } catch (e) {
    ElMessage.error(locateWriteErrorText(e, 'TAKE_OVER'));
    reDiagnose();
  }
}

async function submitReceive(row: LocateBatchRowData, nextProcessId: string | null): Promise<void> {
  try {
    await receiveMutation.mutateAsync({
      batchId: row.batch_id,
      badgeCode: props.worker.badge_code,
      version: row.version,
      nextProcessId,
    });
    ElMessage.success('已从外协收回，并交到你手上');
    close();
    emit('done');
  } catch (e) {
    ElMessage.error(locateWriteErrorText(e, 'RECEIVE_FROM_OUTSOURCE'));
    reDiagnose();
  }
}
</script>

<style lang="scss" scoped>
.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
  gap: 12px;
  color: #606266;
  p {
    margin: 0;
    font-size: 16px;
  }
  .sub {
    color: #909399;
    font-size: 14px;
  }
}
.error-state {
  color: #f56c6c;
  .error-text {
    font-weight: 600;
  }
}

.part-head {
  padding: 12px 16px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 12px;
}
.head-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  .serial {
    font-family: 'SF Mono', Menlo, Consolas, monospace;
    font-size: 20px;
    font-weight: 700;
    color: #303133;
  }
  .name {
    font-size: 17px;
    color: #303133;
  }
}
.head-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  .kv {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .k {
    color: #909399;
    font-size: 14px;
  }
  .v {
    color: #303133;
    font-size: 15px;
    font-weight: 600;
  }
}

.locate-table {
  width: 100%;
}
.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}
.qty {
  margin-left: 6px;
  color: #606266;
}
.holder {
  display: block;
  color: #909399;
  font-size: 13px;
}
.chain-state {
  margin-right: 8px;
  color: #409eff;
}
.next {
  color: #606266;
}
.disabled-hint {
  color: #b88230;
  font-size: 14px;
  line-height: 1.6;
}
.mine-hint {
  color: #67c23a;
  font-size: 14px;
}
.manual-hint {
  display: block;
  margin-top: 4px;
  color: #b88230;
  font-size: 13px;
  line-height: 1.5;
}
.is-loading {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
