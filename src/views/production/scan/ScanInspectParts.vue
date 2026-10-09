<!--
  ScanInspectParts.vue

  /scan/inspect —— 扫码台 INSPECT 流程（2026-07-19，2026-09-15 Phase 5 切 v2）
  1. onBeforeMount 调 GET /prod/scan/held 列出当前 worker 持有件
  2. 工人点选一件 → 进入「待扫码确认」状态（confirm-bar 提示扫该件条码）
  3. 扫码枪扫到与选中件 serial_no 匹配的条码 → 直接提交送检
     （与 ScanPickParts.vue 的「选中后扫码确认」同款防误触模式；不匹配 → ElMessage.error）
  4. 送检不需要下一道工序（后端 INSPECTED 忽略 next_process_id）
  5. 提交走 POST /prod/scan/worker-scan（event_type=INSPECTED），service
     ::mark_inspected → 写事件 + 同事务 WorkerPool refill。
  6. 成功后自动 refresh（该件从列表消失）

  2026-10-10：**「作业货架」整条下线**。`shelf_id`（工人所在的补料生产架）与
  `target_inspection_shelf_id`（送检目标品检架）两个字段后端一并删除 —— 目标架改由
  后端按负载自动选择，`WorkingShelfDialog` / `useScanShelfStore` /
  `resolveWorkingShelf` 随之删除。扫码确认后直接提交，不再有任何货架闸门。

  旧「扫一批条码」流程（ScanPartsWork.vue ?action=inspect）已随本页上线替换不保留。

  2026-10-09：列表卡的左边框专供「这条批次有制定工序链且链指针未漂移」这一个语义
  （有链 = 绿，规则见 `@/views/production/scan/chainAccent`）；流程区分由顶栏标题 + 路由承担，
  加急由红底 + 「加急」tag 承担，两者都不进边框。
-->

<template>
  <div class="scan-inspect">
    <!-- 顶栏（2026-10-11 抽成 components/ScanTopbar.vue） -->
    <ScanTopbar :worker="worker" flow-label="送 检" flow-tag-type="success">
      <template #actions>
        <HeldPartsBadge
          v-if="worker?.id"
          :worker-id="String(worker.id)"
          :auto-open-on-change="true"
          :auto-open-token="heldChangeToken"
        />
        <el-button type="info" plain @click="backToAction">
          <el-icon><Back /></el-icon>
          <span>返回操作选择</span>
        </el-button>
        <el-button type="warning" plain @click="backToBadge">
          <el-icon><Refresh /></el-icon>
          <span>重新扫工牌</span>
        </el-button>
      </template>
    </ScanTopbar>

    <div ref="contentRef" class="content">
      <!-- 加载 -->
      <div v-if="loadingList" class="loading-block">
        <el-icon :size="32" class="is-loading"><Loading /></el-icon>
        <p>加载持有零件列表…</p>
      </div>

      <!-- 未识别工人 -->
      <div v-else-if="!worker?.id" class="empty-block">
        <el-icon :size="60" color="#e6a23c"><Warning /></el-icon>
        <h3>未识别工人</h3>
        <p>请重新刷工牌。</p>
        <el-button type="primary" @click="backToAction">返回</el-button>
      </div>

      <!-- 空列表 -->
      <div v-else-if="parts.length === 0" class="empty-block">
        <el-icon :size="60" color="#c0c4cc"><Box /></el-icon>
        <h3>您当前没有持有零件</h3>
        <p>请先到「取件」领取零件后再来送检。</p>
        <el-button type="primary" @click="refresh">刷新</el-button>
        <el-button @click="backToAction">返回</el-button>
      </div>

      <!-- 持有件列表 -->
      <div v-else>
        <div class="parts-header">
          <el-icon :size="24"><Box /></el-icon>
          <span class="parts-header-text">我的持有零件</span>
          <el-tag type="info" effect="plain" size="large" class="count-tag">
            共 {{ total }} 件<template v-if="total > parts.length"
              >（显示前 {{ parts.length }} 件）</template
            >
          </el-tag>
          <el-button :icon="Refresh" circle size="small" @click="refresh" />
        </div>

        <!-- 待扫码确认栏 -->
        <div v-if="selectedPart && awaitingScan" class="confirm-bar pending-scan">
          <el-icon :size="20" color="#e6a23c"><Aim /></el-icon>
          <span class="confirm-text">
            已选 <strong>{{ selectedPart.serial_no || selectedPart.drawing_no }}</strong> ·
            {{ selectedPart.name }} · 送检数量 {{ selectedPart.quantity }}
            · 请<strong>扫描该零件条码</strong>确认送检
          </span>
          <el-button size="small" @click="cancelSelect">取消选择</el-button>
        </div>

        <div class="parts-list">
          <PartRowCard
            v-for="p in sortedParts"
            :key="p.batch_id || p.id"
            :row="p"
            :selected="sameBatch(selectedPart, p)"
            :previewing="previewDlg?.loading === true && previewPart?.id === p.id"
            @select="onSelect"
            @preview="openPreview"
          />
        </div>
      </div>
    </div>

    <ScrollFabPair :target="contentRef" />

    <!-- 同条码多批次选择弹窗 -->
    <BatchPickerDialog
      v-if="showBatchPicker"
      v-model="showBatchPicker"
      :code="batchPickerCode"
      :rows="batchPickerRows"
      @pick="onBatchPicked"
    />

    <!-- 自动补料告知：worker-scan 同事务 refill 抢到批次时弹窗（数量 / 系统交期见卡内）；
         补料弹窗打开时它兼作本次送检的成功提示（lead-text），故此处不另发 ElMessage.success -->
    <RefillTakenDialog
      v-if="showRefillTaken"
      v-model="showRefillTaken"
      :items="refillTaken"
      :lead-text="refillLead"
    />

    <!-- 数量选择弹窗 -->
    <QuantityDialog
      v-if="showQtyDialog"
      v-model="showQtyDialog"
      :max="selectedPart?.quantity ?? 1"
      :serial-no="selectedPart?.serial_no || selectedPart?.drawing_no || null"
      :part-name="selectedPart?.name || null"
      action-label="送检"
      @confirm="onQtyConfirm"
      @cancel="cancelSelect"
    />

    <!-- 图纸 / 图片 预览（2026-10-11 抽成 components/PartDrawingPreviewDialog.vue：
         四个分支 + 下载闸门 + blob 生命周期是一件事的完整口径，此前三页各抄一份） -->
    <PartDrawingPreviewDialog
      ref="previewDlg"
      v-model="showPreview"
      :part="previewPart"
      :title="previewTitle"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeMount, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Aim, Back, Box, Loading, Refresh, Warning } from '@element-plus/icons-vue';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import { useScanPartsSort } from '@/views/production/scan/composables/useScanPartsSort';
import { refillTakenOf } from '@/views/production/scan/composables/refillTaken';
import HeldPartsBadge from '@/views/production/scan/components/HeldPartsBadge.vue';
import ScrollFabPair from '@/views/production/scan/components/ScrollFabPair.vue';
import QuantityDialog from '@/views/production/scan/components/QuantityDialog.vue';
import PartRowCard from '@/views/production/scan/components/PartRowCard.vue';
import PartDrawingPreviewDialog from '@/views/production/scan/components/PartDrawingPreviewDialog.vue';
import ScanTopbar from '@/views/production/scan/components/ScanTopbar.vue';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';
import BatchPickerDialog, {
  type BatchPickerRow,
} from '@/views/production/scan/components/BatchPickerDialog.vue';
import RefillTakenDialog from '@/views/production/scan/components/RefillTakenDialog.vue';
import { useScanHeldQuery } from '@/views/production/scan/composables/useScanListQuery';
import { useScanWorkerScanMutation } from '@/views/production/scan/composables/useScanWrite';

const workerScanMutation = useScanWorkerScanMutation();
import type { TakenItemDto } from '@/api/productionQueue.contract';
import { findAllByCode, findPartBySerialAndPrompt } from '@/utils/scanHelpers';

const router = useRouter();
const { worker, requireWorker, reset: resetScanSession } = useScanSession();
const { onScan } = useBarcodeScanner();

// 2026-10-10：持有件列表改走 `GET /prod/scan/held` 的 query hook，与放回页 /
// `HeldPartsBadge` 徽章共用同一条 query key ⇒ 同屏对同一个工人只发一次请求，且写后
// 由 mutation 的失效链同刷。
const held = useScanHeldQuery(() => {
  const workerId = worker.value?.id;
  return workerId ? { workerId: String(workerId), limit: 200 } : null;
});
// limit=200 是后端 clamp 上限：不传时后端默认只返 50 条，持有件列表会静默截断。
const parts = computed<ScanPartRowSchema[]>(() => held.query.data.value?.items ?? []);
// 后端信封里的总条数（可能大于已加载的 parts.length —— 见上面 limit 的说明）
const total = computed(() => held.query.data.value?.total ?? 0);
// 「系统交期」硬优先级 + 原 is_urgent / planned_delivery_date 排序；详见 composable 注释
const sortedParts = useScanPartsSort(parts);
// `isPending`（还没有任何数据）而非 `isFetching`：后者在写后失效触发的后台 refetch 期间
// 也为 true，用它会让整页在每次提交后闪一次 loading 块。
const loadingList = computed(() => held.query.isPending.value);
const selectedPart = ref<ScanPartRowSchema | null>(null);
const submitting = computed(() => workerScanMutation.isPending.value);
/** 写成功后自增，驱动徽章自动开抽屉（见 HeldPartsBadge 的 autoOpenToken 注释）。 */
const heldChangeToken = ref(0);

// 点选卡片后进入「待扫码确认」状态；扫到匹配条码才提交送检
const awaitingScan = ref(false);

const contentRef = ref<HTMLElement | null>(null);

// --- 预览状态（2026-10-11：弹窗与取文件的逻辑搬进 PartDrawingPreviewDialog，
//     本页只留「点哪张卡」与标题的拼装） ---
const showPreview = ref(false);
const previewPart = ref<ScanPartRowSchema | null>(null);
/** 「正在预览哪一行」由弹窗自己管（它才发那两次请求），本页只经这个 ref 读它的 loading。 */
const previewDlg = ref<InstanceType<typeof PartDrawingPreviewDialog> | null>(null);

/** 弹窗弹出的那一刻 loading 归弹窗管，本页只在 `previewPart` 里记下是哪一行。 */
function openPreview(p: ScanPartRowSchema): void {
  previewPart.value = p;
  showPreview.value = true;
}

const previewTitle = computed<string>(
  () => `预览 — ${previewPart.value?.serial_no || previewPart.value?.drawing_no || ''}`,
);

// 2026-10-10：货架选择整块下线（目标架由后端按负载自动选）。showQtyDialog 保留：
// 正常路径已不走它，但它是 worker-scan 整批语义的旧调试入口。
const showQtyDialog = ref(false);

// --- 自动补料告知（worker-scan 同事务 refill；抢到批次才弹窗） ---
const showRefillTaken = ref(false);
const refillTaken = ref<TakenItemDto[]>([]);
/** 扫码动作自身的成功文案（补料弹窗打开时它取代 ElMessage.success，见组件注释） */
const refillLead = ref('');

// --- 多批次扫码命中弹窗 ---
const showBatchPicker = ref(false);
const batchPickerCode = ref('');
const batchPickerRows = ref<ScanPartRowSchema[]>([]);

onBeforeMount(() => {
  requireWorker(router);
});

/** 页面「刷新」按钮：走 query 的 refetch。 */
function refresh(): Promise<void> {
  return held.fetchList();
}

// --- 扫码：扫描直接选中 + 滚动居中 + 直接提交送检；不在列表则提示当前位置 ---

/** 选中后等一拍再滚动；元素不在容器内则静默返回 */
async function scrollCardIntoView(batchKey: string): Promise<void> {
  await nextTick();
  const root = contentRef.value;
  if (!root) return;
  const el = root.querySelector<HTMLElement>(`.part-row[data-batch-id="${CSS.escape(batchKey)}"]`);
  if (!el || !root.contains(el)) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * INSPECT tail：选中 + 清 awaitingScan + 滚动 + 直接提交送检。
 *
 * 2026-10-10：原先这里开品检架 picker（选完架才提交），现改为**扫码确认即提交** ——
 * 目标架由后端按负载自动选，工人不再指定。
 */
async function applyScanSelection(p: ScanPartRowSchema): Promise<void> {
  selectedPart.value = p;
  selectedQty.value = p.quantity;
  awaitingScan.value = false;
  const key = String(p.batch_id || p.id);
  await scrollCardIntoView(key);
  await submitInspect();
}

async function onScanToSelect(rawCode: string): Promise<void> {
  const code = rawCode.trim();
  if (!code) return;
  if (submitting.value || showQtyDialog.value || showBatchPicker.value || showRefillTaken.value)
    return;
  const matches = findAllByCode(parts.value, code);
  if (matches.length === 1) {
    await applyScanSelection(matches[0]);
  } else if (matches.length > 1) {
    batchPickerCode.value = code;
    batchPickerRows.value = matches;
    showBatchPicker.value = true;
  } else {
    await findPartBySerialAndPrompt(code);
  }
}

function onBatchPicked(p: BatchPickerRow): void {
  // 2026-10-04：BatchPickerDialog 的 pick emit 载荷是跨域共用的行契约（该组件的
  // props 才是本域最小结构型 BatchPickerRow），本页实际传进去的行是
  // scanPartRowSchema ⇒ 入口做一次窄化转换。
  showBatchPicker.value = false;
  void applyScanSelection(p as unknown as ScanPartRowSchema);
}

// 全局扫码订阅：扫描直接触发 onScanToSelect
const unsubScan = onScan((code) => {
  void onScanToSelect(code);
});

onBeforeUnmount(() => {
  unsubScan();
});

// --- 选件 → 扫码确认 → 提交 ---
const selectedQty = ref<number | undefined>(undefined);

/** 2026-07-29 批次化：行=批次，选中比较按 batch_id */
function sameBatch(a: ScanPartRowSchema | null, b: ScanPartRowSchema): boolean {
  if (!a) return false;
  if (a.batch_id && b.batch_id) return a.batch_id === b.batch_id;
  return a.id === b.id;
}

function onSelect(p: ScanPartRowSchema): void {
  if (submitting.value) return;
  // 取消选中（已选同一件 → 反选）
  if (sameBatch(selectedPart.value, p)) {
    cancelSelect();
    return;
  }
  selectedPart.value = p;
  selectedQty.value = p.quantity;
  awaitingScan.value = true;
}

/** 实际提交：worker-scan（event_type=INSPECTED）。整批送检，不支持部分数量。 */
async function submitInspect(): Promise<void> {
  if (!selectedPart.value || !worker.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    return;
  }
  try {
    const res = await workerScanMutation.mutateAsync({
      serial_no: selectedPart.value.serial_no ?? '',
      badge_code: worker.value.badge_code ?? '',
      event_type: 'INSPECTED',
      // 2026-10-10：**不发任何货架字段** —— 目标品检架由后端按负载自动选。
      batch_id: selectedPart.value.batch_id ?? null,
    });
    // 成功文案在 await 后立即取值（见 cancelSelect 会把 selectedPart 清空）
    const serialNo = selectedPart.value.serial_no;
    cancelSelect();
    // 2026-10-05：worker-scan 同事务 refill 抢到批次时弹窗告知（空数组 = 池空 / 已持满，
    // 不弹）。弹窗不依赖列表刷新的往返，工人立刻看到补了什么料。
    const taken = refillTakenOf(res);
    if (taken.length) {
      refillTaken.value = taken;
      refillLead.value = `已送检：${serialNo}`;
      showRefillTaken.value = true;
    } else {
      ElMessage.success(`已送检：${serialNo}`);
    }
    // mutateAsync 返回时 onSuccess 的失效链已 settle（TanStack await onSuccess 返回的
    // promise）⇒ 列表与徽章都是刷新后的状态，此时自增 token 开抽屉。
    heldChangeToken.value++;
  } catch (e) {
    // 失败也走全套失效（mutation 的 onError）：40901 OCC / 20103 状态非法都意味着
    // 服务端那份数据已经变了，本端副本过期。
    ElMessage.error((e as Error).message ?? '送检失败');
  }
}

async function onQtyConfirm(qty: number): Promise<void> {
  // worker-scan 不支持部分数量；保留 dialog 入口以兼容旧调试路径，
  // 正常流程已由 applyScanSelection → submitInspect 跳过此步。
  showQtyDialog.value = false;
  if (submitting.value) return;
  if (!selectedPart.value || !worker.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    return;
  }
  selectedQty.value = qty;
  await submitInspect();
}

function cancelSelect(): void {
  selectedPart.value = null;
  selectedQty.value = undefined;
  awaitingScan.value = false;
}

function backToAction(): void {
  cancelSelect();
  void router.replace('/scan/action');
}

function backToBadge(): void {
  cancelSelect();
  resetScanSession();
  void router.replace('/scan/badge');
}
</script>

<style lang="scss" scoped>
.scan-inspect {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #f5f7fa;
}

/* `.topbar` / `.part-row*` / 预览弹窗四分支的样式都在 components/ 的三个共用件里
   （ScanTopbar / PartRowCard / PartDrawingPreviewDialog，2026-10-11 抽出），本页只留
   自己这一份的骨架与确认栏。 */

.content {
  flex: 1;
  overflow: auto;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
  padding: 24px;
}

.loading-block,
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 0;
  gap: 12px;
  color: #606266;
  text-align: center;
  h3 {
    font-size: 20px;
    margin: 0;
    color: #303133;
  }
  p {
    color: #909399;
    max-width: 480px;
  }
}

.parts-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  color: #303133;
}
.parts-header-text {
  font-size: 20px;
  font-weight: 600;
}
.count-tag {
  font-size: 16px;
  padding: 6px 14px;
}

.confirm-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
}
/* 待扫码确认：琥珀底提示工人动作未完成（与放回页的绿底「已确认」区分） */
.confirm-bar.pending-scan {
  background: #fdf6ec;
  border: 1px solid #faecd8;
}
.confirm-text {
  flex: 1;
  color: #303133;
}
.confirm-text strong {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: #e6a23c;
  font-size: 18px;
  margin: 0 4px;
}

.parts-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
