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

  动作取值与「工序参数」的形态（后端 `docs/api/scan.md` 的「逐字段 · locate / take-over /
  outsource-receive」与「口径表 · locate 的 action 决策表与写侧守卫对照」两节是权威）：
    - `PICK_UP`            → 复用取件端点，**先弹数量弹窗**（支持部分领取），确认后提交；
    - `MINE`               → 无按钮，行内写明「该批次已在你手上」（引导去放回 / 送检流）；
    - `TAKE_OVER`          → `POST /prod/scan/take-over`。`chain_state === 'NEXT'` 时
                             **不发** `next_process_id`（后端按链自推）；其余形态进入**手填
                             路径**（弹框还是直提由候选条数决定，见下面「手填框的候选」那段：
                             恰好一条时不弹框、直接提交那一条）；缺 → `40001`，链外 → `20702`。
                             ⚠️ 写侧的免填前置比读侧多一道「指针一致性」，而它不在 locate 出参里
                             ⇒ 这类行吃 `40001` 时降级弹手填框兜底（见 `submitTakeOver`）；
    - `RECEIVE_FROM_OUTSOURCE` → `POST /prod/scan/outsource-receive`。`chain_state ===
                             'NEXT'` 时**必须把诊断行的 `next_process_id` 原样回传**
                             （写侧缺省推导口径是 `sort_order = 当前 + 1`，与读侧
                             `sort_order > 当前 LIMIT 1` 在稀疏链上不等价，省略会吃
                             `20706` / `40001`）；其余形态同样进入**手填路径**（是否弹框
                             由候选条数决定，同上）。
    - `action === null`    → 渲染 `disabled_reason` 的指引文案（9 个字面量逐条映射），
                             **该行不给按钮**；未知字面量同样不给按钮（`isWritableAction`）。

  ⚠️ **手填框的候选是工种工序，不是全部工序**（2026-10-16）：出参顶层
  `worker_processes` 是后端按该工人的工种算好的可执行工序，写端点的工种闸门用的是同一份
  判据。候选恰好一条时**不弹框、直接提交那一条** —— 工种已经唯一确定了目标工序，让工人
  再点一次只是多一步（触屏上最贵的一步）；多条才弹框，且框内只列这 N 条。
  ⚠️ 因为「恰好一条」是**主用例**（工种通常只配一道工序），行内那句预提示必须跟着候选
  条数变：单候选时说「将直接接管到…唯一的工序」，说「需…指定下一道」就是假话
  （见 `manualHintText`）。
  ⚠️ **空集合不是「到不了的边角」**（2026-10-16 review 第 2 轮 MINOR-1 订正，先前这里
  与 `startManualFlow` 的注释都写着「后端已判成不可点」）：后端判「这行可不可点」用的是
  **含已软删工序的宽集合**，出参 `worker_processes` 发的是**未软删的窄集合** ⇒ 工种只映射
  了已软删工序时，「行可点 + 候选为空数组」是后端自己认可的形态。所以三条路径都得说人话：
  行内提示、手填框、0 条兜底。

  关闭权：本弹窗**不是**提交闸门（关掉只丢一次诊断，工人可重扫），故保留右上角 ×；
  但它内部启用的「手填工序」弹窗**是**提交闸门（那条链上它是唯一的提交入口），按
  CLAUDE.md「弹窗关闭权」以 `:show-close="false"` 收在 footer 两键上。

  写动作**无论成功还是失败，刷新都由 mutation 的 `onSuccess` / `onError` 统一承担**：两条
  都走 `invalidateScanReadSide`（见 `useScanWrite.ts`），它失效的前缀同时盖住
  ① 页面那两条列表（`qk.scanPickablePrefix` / `qk.scanHeldPrefix`）与 ② 本弹窗自己的诊断
  （`qk.scanLocatePrefix`）。这些 query 都是 active 的，TanStack 失效即后台重取，且
  mutation 的两个回调返回的都是那条失效链的 promise、`mutateAsync` 会 await 它 ⇒ 动作返回
  时页面列表与本弹窗诊断都已是重取后的状态。因此三条 catch 里都没有手动 `refetch()`
  （两条通道同时跑会对 diagnose 端点打两次 GET），也**不依赖 WS**、不再通知页面去
  `refresh()`。刷新这件事的后人不许从 `onError` 里摘掉，理由见 script 里「写动作失败后诊断
  一定会重查」那段。

  三种「没有行可渲染」的状态**必须分开**：`20101` 未命中（条码不对 / 是装配件序列号）、
  工单查到了但**一个未软删批次都没有**（条码对、批次全没了）、契约漂移 / 网络失败。
  把后两者混进第一段文案会把「条码是对的」说成「条码错了」。
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

    <!-- 诊断失败（含 Zod 契约漂移）：机制走同目录既有的 scanListErrorText 收口，
         漂移文案用「诊断」口吻（`SCAN_LOCATE_CONTRACT_DRIFT_TEXT`）而不是列表那一句 ——
         本弹窗不是列表，工人扫的条码没进列表，说「列表格式异常」会把他指去看错界面。
         ⚠️ 后端「未命中」（20101）不算失败 —— 它落下面的空态，不落这里。 -->
    <div v-else-if="errorText" class="state-block error-state">
      <el-icon :size="32" color="#f56c6c"><CircleCloseFilled /></el-icon>
      <p class="error-text">{{ errorText }}</p>
      <el-button size="large" @click="retry">重新查询</el-button>
    </div>

    <!-- 未命中（后端返 20101 / 响应无工单侧数据）。locate 只按 t_part.serial_no 查、
         **不回退 t_assembly** ⇒ 扫装配件序列号也落这一态，所以要给「改扫子件」的指引。
         ⚠️ 必须排在「没有在制批次」那一态**之前**：20101 时响应里根本没有 part，
         `batches` 自然也是空数组，两个判据都为真、顺序反了就会把未命中说成「批次没了」。 -->
    <div v-else-if="notFound || !part" class="state-block">
      <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
      <p>没有找到条码 {{ code }} 对应的在制零件。</p>
      <p class="sub">若这是装配件，请改扫子件的序列号。</p>
    </div>

    <!-- 工单查到了、但它名下**一个未软删批次都没有**。这是与「未命中」不同的第三种状态，
         指引不能复用「请改扫子件」—— 条码是对的，工单在，只是全部批次已软删 / 已归档。 -->
    <div v-else-if="batches.length === 0" class="state-block">
      <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
      <p>工单 {{ part?.serial_no || code }} 当前没有在制批次。</p>
      <p class="sub">该工单的批次可能已全部交付 / 取消，可点「刷新」重新确认。</p>
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
            <span v-else-if="!isWritableAction(row as LocateBatchRowData)" class="disabled-hint">{{
              locateDisabledReasonText(null)
            }}</span>
            <template v-else>
              <!-- HMI 触屏：同域所有提交级交互件都是 `size="large"`（footer 两键、
                   QuantityDialog 全套、ProcessPickerDialog footer），行内这个按钮是本弹窗
                   唯一的提交入口，小号在一体机上手指点不准。 -->
              <el-button
                size="large"
                type="primary"
                :loading="submitting"
                @click="onActionClick(row as LocateBatchRowData)"
              >
                {{ actionLabel((row as LocateBatchRowData).action) }}
              </el-button>
              <!-- 「点下去会发生什么」的可见事实：手填弹窗是点了按钮之后才出现的，
                   工人需要提前看到「这次要点两下」。⚠️ 这句话只在**候选多条**时成立 ——
                   候选恰好一条时根本不弹框、直接提交（见 `manualHintText`），继续写死
                   「要点两下」就是在骗工人。 -->
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

    <!-- 手填下一道工序：提交闸门，关闭权收在 footer（:show-close="false"）。
         候选收窄到该工人的工种工序（allowedProcessIds）；恰好一条时根本不走到这里，
         `startManualFlow` 会直接提交，见该函数注释。 -->
    <ProcessPickerDialog
      v-if="manualRow"
      v-model="showManualDialog"
      :kind="manualRow.kind"
      :allowed-process-ids="allowedProcessIds"
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
import {
  scanListErrorText,
  SCAN_LOCATE_CONTRACT_DRIFT_TEXT,
} from '@/views/production/scan/composables/scanListErrorMessage';
import {
  locateDisabledReasonText,
  locateWriteErrorText,
} from '@/views/production/scan/composables/locateActionErrorText';
import type {
  LocateBatchRowData,
  LocateProcessBriefData,
} from '@/views/production/scan/composables/scanSchema';
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
  props.modelValue && props.code && props.worker.id
    ? { serialNo: props.code, workerId: String(props.worker.id) }
    : null,
);

const data = computed(() => locate.data.value);
const part = computed(() => data.value?.part ?? null);
const batches = computed<LocateBatchRowData[]>(() => data.value?.batches ?? []);
/** 2026-10-16 新增：当前工人的工种可执行工序（locate 出参顶层 `worker_processes`）。
 *  手填下一道工序的候选集就是它 —— 与写端点的工种闸门同一份判据，前端不再自己判一遍
 *  「这个工种能不能做这道工序」。空数组 = 未绑工种 / 工种未映射任何工序。 */
const workerProcesses = computed<LocateProcessBriefData[]>(
  () => data.value?.worker_processes ?? [],
);
/** 交给 `ProcessPickerDialog` 的收窄集合（纯 id，后端已算好工序名与分类）。 */
const allowedProcessIds = computed<string[]>(() => workerProcesses.value.map((p) => p.process_id));
// `isPending` 而非 `isFetching`：后者在后台 refetch 期间也为 true，会让整表闪一次。
const loading = computed(() => locate.query.isPending.value);
// `20101`（工单未命中）走**空态**而不是失败态。
// 本弹窗只在「扫到 0 匹配」时打开，所以「扫了个不存在的条码」是它最高频的输入形态 —
// 把它渲染成一句红字「查询失败」+「重新查询」按钮是在告诉工人他操作错了，而他并没有。
// ⚠️ `locate` 刻意不回退 `t_assembly`（后端「已知偏差登记」有这条），所以装配件序列号
// 也走这一态。
// ⚠️ 这一态**不弹 toast**：`useScanLocateQuery` 的错误桥接对 `20101` 早退，红字提示由本
// 弹窗的空态独家承担（同一件事不出现两遍）。
const notFound = computed(
  () => locate.error.value instanceof ApiError && locate.error.value.code === 20101,
);
const errorText = computed(() =>
  !notFound.value && locate.error.value
    ? scanListErrorText(locate.error.value, '查询零件位置失败', SCAN_LOCATE_CONTRACT_DRIFT_TEXT)
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
 * `PICK_UP` 的行长出「确认收回」这种与动作无关的按钮。
 */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  PICK_UP: '领取',
  TAKE_OVER: '接管',
  RECEIVE_FROM_OUTSOURCE: '确认收回',
};

/** 三个可写动作的判据（`MINE` 与 `null` 走另外两条分支）。
 *
 *  ⚠️ **按钮只对这三条渲染**：后端将来给 `LocateAction` 加第四个变体时，守门 schema
 *  （`z.string().nullable()`，刻意不锁枚举）会把它原样透进来，而
 *  `onActionClick` 只认这三条 ⇒ 未知的字面量落成「一个按下去静默 return 的按钮」，
 *  现场表现是按了没动静。未知字面量改走 `disabled-hint` 分支（与「无可行动作」同款指引），
 *  至少让工人看到一句「暂不支持」而不是一个骗人的按钮。
 */
function isWritableAction(row: LocateBatchRowData): boolean {
  const a = row.action;
  return a === 'PICK_UP' || a === 'TAKE_OVER' || a === 'RECEIVE_FROM_OUTSOURCE';
}

function actionLabel(action: string | null): string {
  // `'处理'` 兜底在当前渲染分支里不可达（按钮由 `isWritableAction` 把关，只放三个已知
  // 字面量进来）；留着它是为了将来有人放宽渲染条件时不至于渲染出「空文案按钮」。
  return ACTION_LABEL[action ?? ''] ?? '处理';
}

/** 该行是否在**点按钮之前**先弹手填下一道工序。
 *
 *  读侧只有 `chain_state` 一个信号，它覆盖不了写侧闸门的全部形态 —— 写侧接管要求
 *  `is_pointer_consistent(batch) && chain_state == "NEXT"` 才免填，而 `pointer_consistent`
 *  **不在 locate 出参里**（16 字段 VO 无此键）⇒ 「指针漂移但 `chain_state` 读作 NEXT」
 *  这类行在前端看起来与免填形态无异，发出去必吃 `40001`。
 *  故这里只做**读侧能判的那部分**（无链 / 链尾 / 链外），读侧判不出的那部分由
 *  `submitTakeOver` 的 catch 降级弹手填框兜底（那里是唯一拿到失败码的地方）。 */
function needManualProcess(row: LocateBatchRowData): boolean {
  if (row.action !== 'TAKE_OVER' && row.action !== 'RECEIVE_FROM_OUTSOURCE') return false;
  return row.chain_state !== 'NEXT';
}

/** 手填提示：把「点下去会发生什么」提前说清楚，并说明为什么。
 *
 *  ⚠️ **必须跟着候选条数变**（2026-10-16 review 第 1 轮）。本函数原本只按 `chain_state`
 *  分支，恒说「需在你的工种工序中指定下一道」—— 那是改动**之前**的形态才恒为真
 *  （改动前点「接管」必然弹手填框）。候选恰好一条时 `startManualFlow` **直接提交那一条、
 *  根本不弹框**，工人读到「需…指定」、点下去却被直接接管，没有任何「指定」发生。
 *  而单候选恰恰是主用例（工种通常只配一道工序），所以这不是边角文案，是主路径上的假话。
 *
 *  动词按动作分（接管 / 收回）：两行共用这一个组件，说错动作等于让工人在外协那行读到
 * 「直接接管」。
 *
 *  ⚠️ **三条分支必须穷举候选条数**（2026-10-16 review 第 2 轮 MINOR-1）。原先只有
 *  「恰好一条」与「其余」两支，0 条落进「其余」⇒ 恒说「需…指定下一道」，而点下去
 *  走的是 `startManualFlow` 的 0 条分支：**只弹一条 warning、永不弹框** —— 与上一轮
 *  MAJOR-2 修掉的症状同一个，只是发生在姊妹分支上（同样是「行内承诺要弹框，点下去不弹」）。
 *  0 候选在 wire 上**可达**（不是理论边角）：后端读侧闸门用的是**含已软删工序的宽集合**
 *  判「这行可不可点」，出参 `worker_processes` 发的是**未软删的窄集合** ⇒ 工种只映射了
 *  已软删工序时，「行可点 + 候选为空数组」就是后端自己认可的形态。 */
function manualHintText(row: LocateBatchRowData): string {
  const reason =
    row.chain_state === 'NONE'
      ? '无工序链'
      : row.chain_state === 'TAIL'
        ? '已是链上最后一道'
        : '工序链推不出下一道';
  const candidates = workerProcesses.value;
  if (candidates.length === 0) {
    return `${reason}，但你的工种当前没有可执行的工序，请联系管理员配置`;
  }
  if (candidates.length === 1) {
    const verb = row.action === 'RECEIVE_FROM_OUTSOURCE' ? '收回' : '接管';
    return `${reason}，将直接${verb}到你的工种里唯一的工序「${candidates[0]!.name}」`;
  }
  return `${reason}，需在你的工种工序中指定下一道`;
}

/** 工种一道可执行工序都没有时的兜底文案（两个动作各一句，指路不同）。 */
const NO_WORK_TYPE_PROCESS_TEXT: Readonly<Record<'takeover' | 'outsource', string>> = {
  takeover: '该工种未映射任何工序，无法接管，请联系管理员配置工种的工序',
  outsource: '该工种未映射任何工序，无法收回，请联系管理员配置工种的工序',
};

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

/*
 * 2026-10-15：**写动作失败后诊断一定会重查，但通道只有失效链这一条。**
 *
 * 为什么失败后必须重查：`action` 是**读侧按当前数据算出来的**，而最常见的失败恰恰意味
 * 着读侧那份数据已经过期 —— `40901`（别人已把这批处置了）、`20204`（容量触顶）、
 * `20103` / `20122`（行的持有关系与诊断结论不符）。不重查的话，这一行仍按旧事实渲染
 * 同一个按钮，工人再点一次吃同一个错，弹窗就成了「反复失败的机器」。重查后 `action` /
 * `disabled_reason` 由新事实重新决定（如 40901 之后多半落 `TERMINAL` 或换成别人的
 * `MINE`），指引文案也跟着变。
 *
 * 触发者是写路径 mutation 的 `onError` → `invalidateScanReadSide`（`useScanWrite.ts`）→
 * 失效 `qk.scanLocatePrefix`。本弹窗打开时那条 query 是 active 的，TanStack 失效即后台
 * 重取；且 `mutateAsync` 会 await `onError` 返回的那条失效链 promise ⇒ catch 块跑起来时
 * 重取已经完成，`action` / `version` 是刷新后的值。
 *
 * ⚠️ **删掉失效链 = 失败后不再重查**：下一个人若看到三条 catch 里没有手动 refetch 而把
 * `onError` 里的失效一并删掉（以为「写路径只需要成功后刷新」），失败后就退回「按旧
 * `action` / 旧 `version` 渲染」——工人点一次错一次。「不手动重查」和「不重查」是两件事，
 * 本弹窗只取消了前者。
 *
 * ⚠️ 两条通道同时跑会对 `GET /prod/scan/locate` 发两次 GET，且后一次 `query.refetch()`
 * 默认 `cancelRefetch: true`，会掐掉在途的第一次请求再重发，第一份响应被丢弃。
 * 弹窗只保留失效链这一条；footer 的「刷新」键是工人显式按的，属第三条、刻意独立（见
 * `retry`）。
 */

async function onActionClick(row: LocateBatchRowData): Promise<void> {
  if (row.action === 'PICK_UP') {
    qtyRow.value = row;
    showQtyDialog.value = true;
    return;
  }
  if (row.action === 'MINE' || row.action === null) return;
  if (needManualProcess(row)) {
    startManualFlow(row, row.action === 'TAKE_OVER' ? 'takeover' : 'outsource');
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

/**
 * 手填下一道工序的三分支（接管与外协收回共用同一条路径与同一份候选）。
 *
 * 候选 = `worker_processes`（后端按该工人的工种算好）：
 *   - **恰好一条 ⇒ 不弹框、直接提交那一条**。工种已经唯一确定了目标工序，让工人再点一次
 *     只是多一步，而这一部一次交互是触屏上最贵的一步；
 *   - **多条 ⇒ 弹框，且框内只列这 N 条**（`allowedProcessIds`）—— 写端点的工种闸门会拒掉
 *     集合外的工序，让工人先选错再吃一次 `20104` 没有意义；
 *   - **零条 ⇒ 不弹框，说人话**（2026-10-16 review 第 2 轮 MINOR-1：这一支**可达**，先前
 *     注释写的「后端已判成不可点」是错的 —— 读侧闸门用含已软删工序的**宽集合**判可点，
 *     出参发的是未软删的**窄集合**，工种只映射已软删工序时就是「可点 + 0 候选」）。
 *     静默 return 会让工人看着按钮毫无反应，所以给一条指路到「找管理员配工序」的提示，
 *     行内 `manualHintText` 也说同一件事 —— 两处必须一致，否则又变成「行内说要弹框、
 *     点下去不弹」。
 *
 * ⚠️ 这条路径**不做「单候选直提」以外的兜底**：直接提交后吃到的失败由各写路径自己的 catch
 * 处理（接管的 `40001` 会降级弹框让工人换一道），不在这里预判。
 */
function startManualFlow(row: LocateBatchRowData, kind: 'takeover' | 'outsource'): void {
  const candidates = workerProcesses.value;
  if (candidates.length === 0) {
    ElMessage.warning(NO_WORK_TYPE_PROCESS_TEXT[kind]);
    return;
  }
  if (candidates.length === 1) {
    void submitManual(row, kind, candidates[0]!.process_id);
    return;
  }
  manualRow.value = { row, kind };
  showManualDialog.value = true;
}

/** 手填结果的统一提交出口（单候选直提与框内确认共用，避免两条分支各写一遍 kind 分流）。 */
function submitManual(
  row: LocateBatchRowData,
  kind: 'takeover' | 'outsource',
  nextProcessId: string,
): void {
  if (kind === 'takeover') {
    void submitTakeOver(row, nextProcessId);
    return;
  }
  void submitReceive(row, nextProcessId);
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
  } catch (e) {
    // 诊断的刷新由 mutation 的 `onError` → `invalidateScanReadSide` 承担（见本文件
    // 「写动作失败后诊断一定会重查」那段），这里只负责把失败说成人话。
    ElMessage.error(locateWriteErrorText(e, 'PICK_UP'));
  }
}

function onManualProcessConfirm(process: Process): void {
  const target = manualRow.value;
  closeManualDialog();
  if (!target) return;
  submitManual(target.row, target.kind, process.id);
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
  } catch (e) {
    ElMessage.error(locateWriteErrorText(e, 'TAKE_OVER'));
    // 读侧判不出「写侧要求显式工序」的那一类形态（见 needManualProcess 的说明）：
    // 写侧免填的前置是 `is_pointer_consistent(batch) && chain_state == "NEXT"`，而指针
    // 一致性不在 locate 出参里 ⇒ 这类行读侧仍给 `TAKE_OVER` + `NEXT`，前端就走了「不发
    // next_process_id」分支，必吃 `40001`。此时**降级弹手填框**而不是只报错重查：
    // 重查的读侧结论不变（同一份数据算同一个 `chain_state`），工人点一次错一次、弹窗
    // 变成死循环；让他补一次工序才有出口。
    //
    // ⚠️ **本分支只认「弹框」那一条降级出口，不认 `startManualFlow` 的「单候选直提」** ——
    // 这是全文件唯一一处行为不对称，后人「顺手统一」成直提就正好制造出上面那个循环
    // （提交 → 40001 → 直提 → 40001 → 直提 …，每次都让工人白点一下、且没有任何选择余地）。
    // 不统一的风险其实很小，但**行为不变、只把理由钉在这里**：按冻结的契约「候选恰好
    // 一条时后端自己会推导」，走这条路时第一次 40001 是因为缺 `next_process_id`，工人
    // 补上那一条之后再吃 40001 的概率很低（后端此时会走 `20702`（链外）或 `20104`（不在
    // 工种内），而前者恰恰应该让人换一道、后者则说明候选集本身有问题，两者都不该再让
    // 系统替他猜一次）。
    //
    // 只在「本次本来就没填工序」时降级 —— 已经手填过还吃 `40001` 是别的问题，重查即可。
    // ⚠️ 这个 `e.code === 40001` 判据成立的前提是 **`40001` 带信封**（后端
    // `AppError::Validation` 的 422 失败由 `into_response` 手工拼 `{code,message,data}`），
    // 所以 `e` 是 `ApiError` 且 `code` 取到了业务码。无信封的 422（雪花 id 发成 number /
    // `version` 缺省）`code` 是 HTTP 状态码，落不进这个分支 —— 那两类是本弹窗自己拼
    // 请求时就不该犯的形态错误，不该在这里降级弹框。详见 `locateActionErrorText.ts` 文件头。
    if (e instanceof ApiError && e.code === 40001 && nextProcessId == null) {
      // 降级出口同样受工种候选约束：框内一道可选工序都没有时，弹出来是个只能取消的死胡同，
      // 直接把「工种没配工序」这件事说清楚。
      if (workerProcesses.value.length === 0) {
        ElMessage.warning(NO_WORK_TYPE_PROCESS_TEXT.takeover);
        return;
      }
      manualRow.value = { row, kind: 'takeover' };
      showManualDialog.value = true;
      return;
    }
    // 非降级分支到此为止：诊断的刷新由 mutation 的 `onError` → `invalidateScanReadSide`
    // 承担（见本文件「写动作失败后诊断一定会重查」那段），catch 里不再自己 refetch。
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
  } catch (e) {
    // 同上：刷新归失效链，这里只出文案。
    ElMessage.error(locateWriteErrorText(e, 'RECEIVE_FROM_OUTSOURCE'));
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
