<!--
  ScanReturnParts.vue

  /scan/return —— 扫码台 RETURN 流程（2026-07-10 PR-E，2026-09-15 Phase 5 切 v2）
  1. onBeforeMount 调 GET /parts/by-worker/{worker_id} 列出当前 worker 持有件
  2. 工人点选一件 → 按行 VO 的 `chain_state` 分流（2026-10-04，工序链适配）：
       - NEXT（链内有下一道）→ 拉候选货架取推荐架，开 ReturnConfirmDialog 单确认，
         不再让工人选工序、不再点货架
       - TAIL（当前是链内最后一道）→ 工序选择弹窗内常驻提示「加工完成后请送检」，
         工人手选工序（提示不判死下一步的选择权）
       - NONE（无链 / 链已软删 / 指针漂移）→ 原路径：弹「下一道工序」picker
  3. 选完工序 → 弹 ShelfPickerDialog（共享 HMI 卡片网格）
  4. 2026-09-15 Phase 5：提交改走 POST /parts/worker-scan（event_type=RETURNED），
     单一端点扫 RETURN；旧 POST /parts/scan?event_type=RETURNED 保留 v1 兼容，
     新流程走 v2 worker-scan（service 层 mark_returned + 同事务 WorkerPool refill）。
  5. 成功后自动 refresh（该件从列表消失）

  与 ScanPickParts.vue 范式对齐：
  - 选件 → 选工序 → 选架 → 提交
  - 不需要扫码确认（点选即确认；旧流程「扫一批条码」已替换不保留）
-->

<template>
  <div class="scan-return">
    <!-- 顶栏 -->
    <div class="topbar">
      <div class="topbar-left">
        <el-icon :size="22" color="#fff"><Avatar /></el-icon>
        <span class="title">报工台</span>
        <el-divider direction="vertical" class="divider" />
        <span class="worker-name">{{ worker?.name ?? '—' }}</span>
        <el-tag size="default" type="info" effect="dark" class="badge-tag">
          {{ worker?.badge_code ?? '' }}
        </el-tag>
        <el-divider direction="vertical" class="divider" />
        <el-tag type="warning" effect="dark">放 回</el-tag>
      </div>
      <div class="topbar-right">
        <HeldPartsBadge
          v-if="worker?.id"
          :worker-id="String(worker.id)"
          :auto-open-on-change="true"
        />
        <el-button type="info" plain @click="backToAction">
          <el-icon><Back /></el-icon>
          <span>返回操作选择</span>
        </el-button>
        <el-button type="warning" plain @click="backToBadge">
          <el-icon><Refresh /></el-icon>
          <span>重新扫工牌</span>
        </el-button>
      </div>
    </div>

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
        <p>请先到「取件」领取零件后再来放回。</p>
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

        <!-- 已选确认栏 -->
        <div v-if="selectedPart" class="confirm-bar">
          <el-icon :size="20" color="#67c23a"><CircleCheckFilled /></el-icon>
          <span class="confirm-text">
            已选 <strong>{{ selectedPart.serial_no || selectedPart.drawing_no }}</strong> ·
            {{ selectedPart.name }} · 归还数量 {{ selectedPart.quantity }} · 下一工序：{{
              selectedNextProcessName || '未选'
            }}
            · {{ confirmShelfText }}
          </span>
          <!-- 2026-10-04：提交在途时置灰，不是不置灰也点不动（onCancelSelect 的守卫照旧
               拦着，只是把「按了没反应」变成「按不了」，HMI 上工人不会以为按钮坏了）。 -->
          <el-button size="small" :disabled="submitting" @click="onCancelSelect"
            >取消选择</el-button
          >
        </div>

        <div class="parts-list">
          <el-card
            v-for="p in sortedParts"
            :key="p.batch_id || p.id"
            :data-batch-id="String(p.batch_id || p.id)"
            shadow="hover"
            :class="[
              'part-row',
              {
                'is-selected': sameBatch(selectedPart, p),
                'is-urgent': p.is_urgent,
              },
            ]"
            @click="onSelect(p)"
          >
            <div class="part-row-main">
              <!-- 右上角预览按钮（@click.stop 阻止冒泡触发选中） -->
              <el-button
                text
                size="small"
                type="info"
                class="preview-btn"
                :loading="previewLoading && previewPart?.id === p.id"
                @click.stop="onPreview(p)"
              >
                <el-icon><View /></el-icon>
                <span>预览</span>
              </el-button>

              <!-- 1) 序列号 + 交期 高优行 -->
              <div class="part-line-top">
                <span class="serial-no">{{ p.serial_no || p.drawing_no }}</span>
                <el-tag
                  v-if="p.is_urgent"
                  type="danger"
                  size="small"
                  effect="dark"
                  class="urgent-pulse"
                  >加急</el-tag
                >
                <!-- 2026-10-04：chip 只显示系统交期，无值显示 '-'（恒渲染，不加 v-if）。
                     计划交期只作排序键、不上屏。⚠️ 后端给 by-worker 的
                     system_delivery_date 恒 null（占位值 '1970-01-01' 已在
                     scanPartRowSchema 归一成 null）⇒ 后端补真实投影之前，本页这一位
                     全是 '-'，是发布顺序问题、不是渲染缺陷。 -->
                <DeliveryDateChip :system-delivery-date="p.system_delivery_date" />
              </div>

              <!-- 2) 名称 -->
              <div class="part-line-name">
                <span class="part-name">{{ p.name }}</span>
              </div>

              <!-- 3) 数量 -->
              <div class="part-line-bottom">
                <span class="qty">× {{ p.quantity }}</span>
              </div>
            </div>
          </el-card>
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

    <!-- 下一道工序选择对话框（2026-07-17 升级为大卡 + INHOUSE/OUTSOURCE tabs）。
         2026-10-04：仍不传 current-process-id / exclude-process-ids —— 行 VO 的
         `chain_next_process_id` 是**下一道**的 id，填进「当前工序」槽位会让 dialog
         把下一道预填成选中项，工人直接点「下一步 · 选货架」就等于没得选；这两个绑定
         保持组件默认值（null / []）= 不预填、全部可选。
         链已知分支（chain_state=NEXT）下本 dialog 根本不开，由 ReturnConfirmDialog
         直接落下一道工序；只有「手动选择工序」与 NONE / TAIL 分支才会进来。
         `hint` 是链尾（TAIL）时段的常驻送检提醒 —— 做成弹窗内的横幅而不是 toast，
         因为后开的 el-dialog 遮罩必然盖住先发的 ElMessage。 -->
    <ProcessPickerDialog
      v-if="showProcessDialog"
      v-model="showProcessDialog"
      kind="return"
      :hint="processHint"
      @confirm="onProcessPicked"
      @cancel="onProcessCancel"
    />

    <!-- 链已知（chain_state=NEXT）单确认弹窗：下一工序 + 目标货架由后端派生好，
         工人只做「确认放回 / 手动选择工序 / 取消」三选一。 -->
    <ReturnConfirmDialog
      v-if="showChainConfirm"
      v-model="showChainConfirm"
      :process-label="selectedNextProcessName"
      :shelf-label="chainShelfCode"
      @confirm="onChainConfirm"
      @manual="onChainManual"
      @cancel="onChainCancel"
    />

    <!-- 共享 HMI RETURN 货架选择卡片网格 picker -->
    <ShelfPickerDialog
      v-if="showShelfPicker"
      v-model="showShelfPicker"
      :next-process-id="selectedNextProcessId || ''"
      empty-action-label="重新选择工序"
      @confirm="onShelfConfirm"
      @cancel="onShelfCancel"
      @emptyAction="onShelfEmpty"
    />

    <!-- 数量选择弹窗 -->
    <QuantityDialog
      v-if="showQtyDialog"
      v-model="showQtyDialog"
      :max="selectedPart?.quantity ?? 1"
      :serial-no="selectedPart?.serial_no || selectedPart?.drawing_no || null"
      :part-name="selectedPart?.name || null"
      action-label="放回"
      @confirm="onQtyConfirm"
      @cancel="onCancelSelect"
    />

    <!-- 自动补料告知：worker-scan 同事务 refill 抢到批次时弹窗（数量 / 系统交期见卡内）；
         补料弹窗打开时它兼作本次放回的成功提示（lead-text），故此处不另发 ElMessage.success -->
    <RefillTakenDialog
      v-if="showRefillTaken"
      v-model="showRefillTaken"
      :items="refillTaken"
      :lead-text="refillLead"
    />

    <!-- 图纸 / 图片 全屏预览 -->
    <el-dialog
      v-model="showPreview"
      class="pdf-preview-dialog"
      :title="previewTitle"
      fullscreen
      :close-on-click-modal="false"
      destroy-on-close
      @closed="onPreviewClosed"
    >
      <div v-if="previewLoading" class="preview-loading">
        <el-icon :size="32" class="is-loading"><Loading /></el-icon>
        <span>加载图纸中…</span>
      </div>

      <PdfViewer v-else-if="previewFile && isPdf(previewFile.file_type)" :url="previewBlobUrl" />

      <div v-else-if="previewFile && isImage(previewFile.file_type)" class="image-preview-wrap">
        <el-image
          v-if="!isHeic(previewFile.file_type)"
          :src="previewBlobUrl"
          :preview-src-list="[previewBlobUrl]"
          :initial-index="0"
          fit="contain"
          style="max-width: 100%; max-height: calc(100vh - 80px)"
        />
        <div v-else class="non-pdf-preview">
          <el-icon :size="48" color="#67c23a"><Picture /></el-icon>
          <p class="non-pdf-name">{{ previewFile.original_filename }}</p>
          <p class="non-pdf-hint">HEIC 格式浏览器不直接支持预览，请下载后查看。</p>
          <el-button type="primary" @click="downloadPreview">
            <el-icon><Download /></el-icon><span>下载文件</span>
          </el-button>
        </div>
      </div>

      <div v-else class="non-pdf-preview">
        <el-icon :size="48" color="#909399"><Files /></el-icon>
        <p class="non-pdf-name">{{ previewFile?.original_filename || '该零件暂无图纸' }}</p>
        <p class="non-pdf-hint">
          {{
            previewFile
              ? `${previewFile.file_type} 文件不支持浏览器内嵌预览，请下载后查看。`
              : '请上传图纸后再预览。'
          }}
        </p>
        <el-button v-if="previewFile" type="primary" @click="downloadPreview">
          <el-icon><Download /></el-icon><span>下载文件</span>
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeMount, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  Avatar,
  Back,
  Box,
  CircleCheckFilled,
  Download,
  Files,
  Loading,
  Picture,
  Refresh,
  View,
  Warning,
} from '@element-plus/icons-vue';
import { api } from '@/api/http';
import PdfViewer from '@/components/PdfViewer.vue';
import { getDownloadUrl, listPartFilesByOwner } from '@/api/assembly';
import type { PartFileItem } from '@/types/part_file';
import { useScanSession } from '@/composables/useScanSession';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import { useScanBus } from '@/views/scan/composables/useScanBus';
import { useScanPartsSort } from '@/views/scan/composables/useScanPartsSort';
import { scanListErrorText } from '@/views/scan/composables/scanListErrorMessage';
import { refillTakenOf } from '@/views/scan/composables/refillTaken';
import HeldPartsBadge from '@/views/scan/components/HeldPartsBadge.vue';
import ScrollFabPair from '@/views/scan/components/ScrollFabPair.vue';
import QuantityDialog from '@/views/scan/components/QuantityDialog.vue';
import { listPartsHeldByWorker, workerScan, type PartItem } from '@/api/parts';
import { listShelvesForReturn } from '@/api/shelves';
import type { ScanPartRowSchema } from '@/composables/queries/schemas';
import ShelfPickerDialog from '@/views/scan/components/ShelfPickerDialog.vue';
import ProcessPickerDialog from '@/views/scan/components/ProcessPickerDialog.vue';
import ReturnConfirmDialog from '@/views/scan/components/ReturnConfirmDialog.vue';
import BatchPickerDialog from '@/views/scan/components/BatchPickerDialog.vue';
import DeliveryDateChip from '@/views/scan/components/DeliveryDateChip.vue';
import RefillTakenDialog from '@/views/scan/components/RefillTakenDialog.vue';
import type { TakenItemDto } from '@/api/workerPool.contract';
import type { Process } from '@/types/process';
import type { ShelfForReturn } from '@/types/shelf';
import { findAllByCode, findPartBySerialAndPrompt } from '@/utils/scanHelpers';

const router = useRouter();
const { worker, requireWorker, reset: resetScanSession } = useScanSession();
const { onScan } = useBarcodeScanner();
const { emitHeldChanged } = useScanBus();

const parts = ref<ScanPartRowSchema[]>([]);
// 后端信封里的总条数（可能大于已加载的 parts.length —— 见 refresh 里的 limit 说明）
const total = ref(0);
// 「系统交期」硬优先级 + 原 is_urgent / planned_delivery_date 排序；详见 composable 注释
const sortedParts = useScanPartsSort(parts);
const loadingList = ref(false);
const selectedPart = ref<ScanPartRowSchema | null>(null);
const submitting = ref(false);

// --- 预览状态 ---
const showPreview = ref(false);
const previewLoading = ref(false);
const previewPart = ref<ScanPartRowSchema | null>(null);
const previewFile = ref<PartFileItem | null>(null);
const previewBlobUrl = ref<string>('');
// 防竞态：每次开预览自增，老请求响应直接丢弃
let previewToken = 0;

const previewTitle = computed<string>(
  () => `预览 — ${previewPart.value?.serial_no || previewPart.value?.drawing_no || ''}`,
);

// --- 类型判定（与 FileListCard.vue 295-302 同步） ---
function isPdf(t: string): boolean {
  return t.toUpperCase() === 'PDF';
}
const IMAGE_TYPES = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'TIF', 'TIFF', 'WEBP']);
function isImage(t: string): boolean {
  return IMAGE_TYPES.has(t.toUpperCase());
}
function isHeic(t: string): boolean {
  return t.toUpperCase() === 'HEIC';
}

// 工序选择（2026-07-17：ProcessPickerDialog 自管加载与展示，这里只保留 select 后的状态）
const showProcessDialog = ref(false);
// 2026-10-04：工序选择弹窗内的**常驻**横幅（见模板注释）。只服务链尾（TAIL）分支的
// 送检提醒；其余分支为空串 ⇒ ProcessPickerDialog 不渲染横幅。
const processHint = ref('');
const selectedNextProcessId = ref<string>('');

const contentRef = ref<HTMLElement | null>(null);
const selectedNextProcessCode = ref<string>('');
const selectedNextProcessName = ref<string>('');

// 货架选择
const showShelfPicker = ref(false);
const showQtyDialog = ref(false);
const pendingShelfId = ref<string>('');

// --- 自动补料告知（worker-scan 同事务 refill；抢到批次才弹窗） ---
const showRefillTaken = ref(false);
const refillTaken = ref<TakenItemDto[]>([]);
/** 扫码动作自身的成功文案（补料弹窗打开时它取代 ElMessage.success，见组件注释） */
const refillLead = ref('');

// --- 2026-10-04 工序链已知分支：下一工序 + 推荐货架都已派生，只差一次确认 ---
// chainShelfId 存的是「还没提交」的推荐架：与 pendingShelfId 分开是因为后者一写就代表
// 「本次放回就放这个架」，而这里只是候选。`cancelSelect()` 会把两者一起清掉，保证
// 下次选件时确认框不会带着上一次的货架。
const showChainConfirm = ref(false);
const chainShelfId = ref<string>('');
const chainShelfCode = ref<string>('');
// 防竞态（照 onPreview 的 previewToken 同款）：`openChainConfirm` 里有一次
// `listShelvesForReturn` 往返，**这段时间页面上没有任何弹窗、卡片完全可点**，
// 工人 / 扫码枪都可能切到另一件 ⇒ 必须作废在途的那一趟。
// 自增点是 `enterReturnFlow` 的入口（**每一次新选件**，点选与扫码共用），而不是
// `openChainConfirm` 内部：只在自己入口自增的话，第二次选件（哪怕是无链的 NONE 件、
// 只同步开一个同步弹窗、不发请求）不会作废在途响应 ⇒ 旧响应回来后与新弹窗并存，
// 写出一组工序 / 货架 / 件三者互不相干的 state，工人点「确认放回」就把**这一件**
// 记到**上一件**的工序与货架上（后端要么 20507，要么静默记错，现场无从察觉）。
let chainToken = 0;

/** 确认栏的货架段：链已知分支已派生出目标货架就直接显示；否则仍是「待选货架」。 */
const confirmShelfText = computed<string>(() =>
  chainShelfCode.value ? `目标货架 ${chainShelfCode.value}` : '待选货架',
);

// --- 多批次扫码命中弹窗 ---
const showBatchPicker = ref(false);
const batchPickerCode = ref('');
const batchPickerRows = ref<ScanPartRowSchema[]>([]);

// --- 扫码：扫描直接选中 + 滚动居中 + 触发 per-page tail；不在列表则提示当前位置 ---

/** 选中后等一拍再滚动；元素不在容器内则静默返回 */
async function scrollCardIntoView(batchKey: string): Promise<void> {
  await nextTick();
  const root = contentRef.value;
  if (!root) return;
  const el = root.querySelector<HTMLElement>(`.part-row[data-batch-id="${CSS.escape(batchKey)}"]`);
  if (!el || !root.contains(el)) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 扫码命中：选中 + 滚动居中，再按 chain_state 分流放回流程 */
async function applyScanSelection(p: ScanPartRowSchema): Promise<void> {
  selectedPart.value = p;
  selectedQty.value = p.quantity;
  selectedNextProcessId.value = '';
  selectedNextProcessCode.value = '';
  selectedNextProcessName.value = '';
  const key = String(p.batch_id || p.id);
  await scrollCardIntoView(key);
  await enterReturnFlow(p);
}

/**
 * 2026-10-04：按 chain_state 分流放回流程（点选与扫码两个入口共用这一个）。
 *
 * - `TAIL`：当前工序是链内最后一道 → 工序选择弹窗内**常驻**提示「加工完成后请送检」
 *   （不是 toast，见 `processHint`）。不把「下一道 = 送检」判死：链是管理员配的，
 *   工人对「这一步是不是真的走完」有最终发言权（临时插单 / 改道），提示 + 手选并存。
 * - `NEXT`：链内且有下一道 → 拉候选货架取推荐架，直接开单确认弹窗，工人不选工序、
 *   不点货架（见 openChainConfirm）。
 * - 其它（含无链 / 链已软删 / 指针漂移 / 未知取值）：走原三步路径。
 *
 * 入口第一句就是 `++chainToken`：**每一次新选件都作废在途的候选货架请求**。这是本函数
 * 唯一的竞态守卫点，放在这里才覆盖得住「在 await 窗口内选中另一件」—— 那条路径下
 * 第二次选件根本不会走到 `openChainConfirm`，若只在 `openChainConfirm` 入口自增，
 * 旧响应仍会回来把工序 / 货架写给当前选中件。
 */
async function enterReturnFlow(p: ScanPartRowSchema): Promise<void> {
  const myToken = ++chainToken;
  const state = narrowChainState(p.chain_state);
  // 横幅每轮重算：只有 TAIL 才有，其余分支清空，避免上一件的送检提示留在本轮弹窗里。
  const cur = p.chain_current_process_name;
  processHint.value =
    state === 'TAIL'
      ? cur
        ? `「${cur}」为最后一道工序，加工完成后请送检。`
        : '当前为最后一道工序，加工完成后请送检。'
      : '';
  if (state === 'NEXT') {
    await openChainConfirm(p, myToken);
    return;
  }
  showProcessDialog.value = true; // NONE：无链 / 漂移，现状不变
}

/** 后端认的三态；其余一律当 NONE（`schemas.ts::scanPartRowSchema.chain_state` 的
 *  声明与降级理由见该字段注释）。 */
type ChainState = 'NONE' | 'NEXT' | 'TAIL';

// 未知取值 / 键缺失只 warn 一次：列表一次最多 200 行，逐行 warn 会刷屏把真正的报错
// 埋掉。按页面实例去重（新进页面重新 warn 一次），足够定位到「哪个环境的后端返了
// 第四种 chain_state」。
let warnedUnknownChainState = false;

/**
 * 把行 VO 的 `chain_state` 窄化成三态。
 *
 * 声明成 `z.string().nullish()` 的代价就是这一步：合法 `NONE` 与「键缺失 / 未知字面量」
 * 在类型上无法区分，所以未知取值一律降级成 `NONE`（旧路径，行为与工序链上线前逐字
 * 一致，工人最多多点两下），并 `console.warn` 一次补回可诊断性 —— 与同页
 * `scanListErrorText` 的「人话给工人，细节给 console」同一条原则。
 */
function narrowChainState(raw: string | null | undefined): ChainState {
  if (raw === 'NONE' || raw === 'NEXT' || raw === 'TAIL') return raw;
  if (!warnedUnknownChainState) {
    warnedUnknownChainState = true;
    console.warn(
      '[scan] 行 VO 的 chain_state 不在 {NONE,NEXT,TAIL} 内（含键缺失），本次放回已按 NONE 降级：',
      raw,
    );
  }
  return 'NONE';
}

async function onScanToSelect(rawCode: string): Promise<void> {
  const code = rawCode.trim();
  if (!code) return;
  if (
    submitting.value ||
    showProcessDialog.value ||
    showChainConfirm.value ||
    showShelfPicker.value ||
    showQtyDialog.value ||
    showBatchPicker.value ||
    showRefillTaken.value
  )
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

function onBatchPicked(p: PartItem): void {
  // 2026-10-04：BatchPickerDialog 的 pick emit 载荷是跨 3 域共用的 PartItem 契约
  // （本组件的 props 才是本域最小结构型 BatchPickerRow），本页实际传进去的行是
  // scanPartRowSchema ⇒ 入口做一次窄化转换。
  showBatchPicker.value = false;
  void applyScanSelection(p as unknown as ScanPartRowSchema);
}

const unsubScan = onScan((code) => {
  void onScanToSelect(code);
});

onBeforeMount(async () => {
  if (!requireWorker(router)) return;
  await refresh();
});

onBeforeUnmount(() => {
  unsubScan();
  // 作废在途的候选货架请求：响应回来时组件已卸载，往 ref 上写值不会再触发渲染，
  // 但同一次 await 之后的 if/赋值链仍会跑完（`showChainConfirm` 被置 true 等），
  // 与下一次进页面时的状态机搅在一起。
  chainToken++;
  if (previewBlobUrl.value) URL.revokeObjectURL(previewBlobUrl.value);
});

async function refresh(): Promise<void> {
  if (!worker.value?.id) return;
  loadingList.value = true;
  try {
    // 2026-10-04：端点返回分页信封，取 `.items`；显式传 limit=200（后端 clamp
    // 上限）取全 —— 不传时后端默认只返 50 条，持有件列表会静默截断。
    const res = await listPartsHeldByWorker(String(worker.value.id), { limit: 200 });
    parts.value = res.items;
    total.value = res.total;
  } catch (e) {
    ElMessage.error(scanListErrorText(e, '加载持有零件列表失败'));
    parts.value = [];
    total.value = 0;
  } finally {
    loadingList.value = false;
  }
}

// --- 选件 → 工序 → 货架 → 提交 ---
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
  selectedNextProcessId.value = '';
  selectedNextProcessName.value = '';
  void enterReturnFlow(p);
}

// --- 预览 ---
async function onPreview(p: ScanPartRowSchema): Promise<void> {
  previewPart.value = p;
  showPreview.value = true;
  previewLoading.value = true;
  const myToken = ++previewToken;
  try {
    // 2026-09-16 T3.5：列表端点切到 v2 /part-files?owner_id=...&kind=...（owner 多态）
    const files = (await listPartFilesByOwner(String(p.id), 'DRAWING')).items;
    if (myToken !== previewToken) return;
    if (!files.length) {
      ElMessage.warning('暂无图纸');
      showPreview.value = false;
      return;
    }
    const f = files[0];
    previewFile.value = f;
    if (isPdf(f.file_type) || isImage(f.file_type)) {
      // 2026-09-16：v2 无 /files/* 路由，文件内容走 /part-files/{id}/content
      const resp = await api.get(`/part-files/${f.id}/content`, { responseType: 'blob' });
      if (myToken !== previewToken) return;
      if (previewBlobUrl.value) URL.revokeObjectURL(previewBlobUrl.value);
      previewBlobUrl.value = URL.createObjectURL(resp.data);
    }
  } catch (e) {
    if (myToken !== previewToken) return;
    ElMessage.error((e as Error).message ?? '加载图纸失败');
    showPreview.value = false;
  } finally {
    if (myToken === previewToken) previewLoading.value = false;
  }
}

function onPreviewClosed(): void {
  if (previewBlobUrl.value) {
    URL.revokeObjectURL(previewBlobUrl.value);
    previewBlobUrl.value = '';
  }
  previewPart.value = null;
  previewFile.value = null;
}

async function downloadPreview(): Promise<void> {
  if (!previewFile.value) return;
  try {
    const url = await getDownloadUrl(previewFile.value.id);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '下载失败');
  }
}

function onProcessPicked(process: Process): void {
  selectedNextProcessId.value = process.id;
  selectedNextProcessCode.value = process.code;
  selectedNextProcessName.value = `${process.code} ${process.name}`;
  showProcessDialog.value = false;
  showShelfPicker.value = true;
}

function onProcessCancel(): void {
  showProcessDialog.value = false;
  cancelSelect();
}

// ============================================================
// 2026-10-04 工序链已知分支：NEXT → 派生下一工序 + 推荐架 → 单确认放回
// ============================================================

/**
 * 清掉链派生的半截状态（推荐架 + 派生出来的下一工序），**保留选中件本身**。
 *
 * 为什么不整段 `cancelSelect()`：落回手选工序时选中件必须留着，否则工人选完工序、
 * 选完架后 `onShelfConfirm` / `submitReturn` 会因 `!selectedPart` 直接 bail（弹一句
 * 「选择已重置」），整条手选路径走不通。要清的是「链给出的答案」，不是「选中的件」。
 *
 * 工序三件套（id / code / name）一起清：漏一个就会让确认栏或成功提示引用到上一次的
 * 标签，而 `selectedNextProcessId` 是 worker-scan 的必填入参，留着更危险。
 */
function clearChainDerived(): void {
  chainShelfId.value = '';
  chainShelfCode.value = '';
  selectedNextProcessId.value = '';
  selectedNextProcessCode.value = '';
  selectedNextProcessName.value = '';
}

/** 落回「手选工序」的统一出口：清掉链派生的答案后打开工序选择弹窗。 */
function fallBackToManualProcess(): void {
  clearChainDerived();
  processHint.value = '';
  showProcessDialog.value = true;
}

/**
 * 链已知（`chain_state === 'NEXT'`）：拉候选货架取推荐架，开 `ReturnConfirmDialog`。
 *
 * `myToken` 由 `enterReturnFlow` 入口自增后传入，本函数**只比对不自增** —— 自增点必须
 * 落在「每一次新选件」上（见 chainToken 处的注释），否则在途请求挡不住「窗口内选中
 * 另一件」。
 *
 * 三条边界（都不抛给视图层，全部落回手选工序，保证工人永远有出路）：
 *   1. `chain_next_process_id` 为空或 `'0'` —— NONE / TAIL 的兜底值，不是真 id。
 *      发过去必得空列表，白跑一趟，直接落回手选。
 *   2. `items` 为空 —— 该工序没配货架（worker-scan 的 20507 BIZ_SHELF_PROCESS_NOT_MAPPED
 *      的前置形态）。这时点确认只会换一个报错码，不如先让工人改选工序。
 *   3. 请求失败 / 下一工序名解析不出 —— 提示 + 落回手选。
 */
async function openChainConfirm(p: ScanPartRowSchema, myToken: number): Promise<void> {
  const nextProcessId = p.chain_next_process_id;
  if (!nextProcessId || nextProcessId === '0' || !p.chain_next_process_name) {
    ElMessage.warning('未找到下一道工序，请手动选择工序');
    fallBackToManualProcess();
    return;
  }

  let shelf: ShelfForReturn | undefined;
  try {
    const result = await listShelvesForReturn(nextProcessId);
    if (myToken !== chainToken) return;
    // 推荐架由后端标在每条 item 上（for-return 的 load 最小那条）；全都没标推荐时
    // 取第一条，保证仍有确定的目标架而不是把工人晾在确认框前。
    shelf = result.items.find((s) => s.is_recommended) ?? result.items[0];
  } catch (e) {
    if (myToken !== chainToken) return;
    // 走同页列表的文案收口：契约漂移（ZodError）时给工人固定人话、细节进 console，
    // 而不是把 axios 的「Request failed with status code 500」原文弹到产线。
    ElMessage.error(scanListErrorText(e, '加载候选货架失败'));
    fallBackToManualProcess();
    return;
  }

  if (!shelf) {
    ElMessage.warning('该工序暂无可用货架，请手动选择工序');
    fallBackToManualProcess();
    return;
  }

  selectedNextProcessId.value = nextProcessId;
  // 链上派生的只有工序名（无 code），与手选路径的「code + name」标签形态对齐不了；
  // 这里只显示名字，确认栏与成功提示都靠它。
  selectedNextProcessName.value = p.chain_next_process_name;
  chainShelfId.value = shelf.id;
  chainShelfCode.value = shelf.code;
  showChainConfirm.value = true;
}

/** 确认框「确认放回」：写死目标架后走与货架点选同一条提交路径。 */
async function onChainConfirm(): Promise<void> {
  showChainConfirm.value = false;
  if (submitting.value) return;
  if (!chainShelfId.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    cancelSelect();
    return;
  }
  pendingShelfId.value = chainShelfId.value;
  await submitReturn();
}

/** 确认框「手动选择工序」：关掉确认框后走与链内兜底**同一个**落回出口。 */
function onChainManual(): void {
  showChainConfirm.value = false;
  fallBackToManualProcess();
}

/** 确认框「取消」：整次放回作废。 */
function onChainCancel(): void {
  showChainConfirm.value = false;
  cancelSelect();
}

/**
 * 工人选了无映射架的工序 → ShelfPickerDialog 返空 → 点「重新选择工序」按钮。
 * 关闭 shelf picker，重新弹工艺序 picker 让工人换一个。
 *
 * 只服务「手选工序」这条路径（NONE / TAIL 直接开的、`NEXT` 点「手动选择工序」落回来的）。
 * NEXT 分支的空候选架由 `openChainConfirm` 自己吸收（它直接落回手选、不经过本 dialog），
 * 但 NEXT 的确认框仍能经本函数到达：工人点「手动选择工序」后若选了一个没配货架的工序，
 * ShelfPicker 返空 → 本函数照常弹回工序选择。
 */
function onShelfEmpty(): void {
  showShelfPicker.value = false;
  processHint.value = '';
  showProcessDialog.value = true;
}

async function onShelfConfirm(shelfId: string): Promise<void> {
  showShelfPicker.value = false;
  if (submitting.value) return;
  if (!selectedPart.value || !selectedNextProcessId.value || !worker.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    return;
  }
  pendingShelfId.value = shelfId;
  // 2026-09-15 Phase 5：RETURN 走 worker-scan（整批 RETURN，不支持部分数量）；
  // 跳过 QuantityDialog 直接提交。
  await submitReturn();
}

/** 实际提交：worker-scan（event_type=RETURNED）。 */
async function submitReturn(): Promise<void> {
  if (!selectedPart.value || !selectedNextProcessId.value || !worker.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    return;
  }
  // 成功提示与后面的 refresh / emitHeldChanged 都在 await 之后：先把要用的值取出来，
  // 不再回头读 state（那时 state 可能已被 cancelSelect 清掉、或已被下一轮选件改写）。
  const serialNo = selectedPart.value.serial_no ?? '';
  const batchId = selectedPart.value.batch_id ?? null;
  const nextProcessId = selectedNextProcessId.value;
  const nextProcessName = selectedNextProcessName.value ?? '';
  submitting.value = true;
  try {
    const res = await workerScan({
      serial_no: serialNo,
      badge_code: worker.value.badge_code ?? '',
      event_type: 'RETURNED',
      shelf_id: pendingShelfId.value,
      next_process_id: nextProcessId,
      batch_id: batchId,
    });
    cancelSelect();
    // 2026-10-05：worker-scan 同事务 refill 抢到批次时弹窗告知（空数组 = 池空 / 已持满，
    // 不弹）。放在 refresh() 之前：弹窗不依赖列表刷新的往返，工人立刻看到补了什么料。
    // 成功文案并进弹窗（lead-text），不另发 ElMessage.success —— 后开的 dialog 遮罩会盖住
    // 先发的 toast。
    const taken = refillTakenOf(res);
    if (taken.length) {
      refillTaken.value = taken;
      refillLead.value = `已放回：${serialNo} → ${nextProcessName}`;
      showRefillTaken.value = true;
    } else {
      ElMessage.success(`已放回：${serialNo} → ${nextProcessName}`);
    }
    await refresh();
    emitHeldChanged();
  } catch (e) {
    ElMessage.error((e as Error).message ?? '放回失败');
  } finally {
    submitting.value = false;
  }
}

async function onQtyConfirm(qty: number): Promise<void> {
  // 2026-09-15 Phase 5：worker-scan 不支持部分数量；保留 dialog 入口以兼容
  // 旧调试路径，正常流程已由 onShelfConfirm → submitReturn 跳过此步。
  showQtyDialog.value = false;
  if (submitting.value) return;
  if (!selectedPart.value || !selectedNextProcessId.value || !worker.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    return;
  }
  selectedQty.value = qty;
  await submitReturn();
}

function onShelfCancel(): void {
  showShelfPicker.value = false;
  cancelSelect();
}

/**
 * 确认栏 / 数量弹窗的「取消」入口：提交在途时**不**清选择。
 *
 * 清了会怎样：`submitReturn` 成功分支里的 `cancelSelect()` 之后还要 `refresh()` +
 * `emitHeldChanged()`，若用户在途点了取消，选中态已空、确认栏消失，而那次放回其实
 * 成功提交了 —— 工人看到的是「我明明取消了，怎么还放回去了」，下一次提交也可能带上
 * 已被清空的批次锚点。`cancelSelect` 本身仍不做守卫：它也是提交成功路径的收口。
 */
function onCancelSelect(): void {
  if (submitting.value) return;
  cancelSelect();
}

function cancelSelect(): void {
  selectedPart.value = null;
  selectedQty.value = undefined;
  selectedNextProcessId.value = '';
  selectedNextProcessCode.value = '';
  selectedNextProcessName.value = '';
  pendingShelfId.value = '';
  processHint.value = '';
  // 2026-10-04：链确认框的 state 一并清掉，否则下次选件时确认框 / 确认栏会带着
  // 上一次的推荐架（worker-scan 提交的是 pendingShelfId，两者不是同一个值域，
  // 混着留迟早放错架）。同时作废在途的候选货架请求：反选 / 取消时那一趟请求的
  // 响应回来已无主，不丢弃就会为「已取消的件」弹出一个工序货架都对不上的确认框。
  chainToken++;
  showChainConfirm.value = false;
  chainShelfId.value = '';
  chainShelfCode.value = '';
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
.scan-return {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #f5f7fa;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(90deg, #142d54 0%, var(--primary-color) 100%);
  color: #fff;
  padding: 12px 24px;
  height: 60px;
  flex-shrink: 0;
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 16px;
}
.topbar-right {
  display: flex;
  gap: 8px;
}
.title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 2px;
}
.divider {
  background: rgba(255, 255, 255, 0.3);
  height: 20px;
}
.worker-name {
  font-size: 18px;
  font-weight: 600;
}
.badge-tag {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}

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
  background: #f0f9eb;
  border: 1px solid #e1f3d8;
  border-radius: 8px;
  margin-bottom: 16px;
}
.confirm-text {
  flex: 1;
  color: #303133;
}
.confirm-text strong {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: #67c23a;
  font-size: 18px;
  margin: 0 4px;
}

.parts-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.part-row {
  display: flex !important;
  align-items: stretch;
  padding: 14px 18px !important;
  border: 1px solid #e4e7ed;
  border-left: 4px solid #e6a23c; // 放回流程强调橙黄（与取件蓝区分）
  border-radius: 8px;
  cursor: pointer;
  position: relative;
  background: #fff;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s;
}
.part-row:hover {
  box-shadow: 0 2px 12px rgba(230, 162, 60, 0.08);
}

/* 非加急选中 → 加深绿底 */
.part-row.is-selected {
  background: #e1f3d8;
  border-color: #67c23a;
}
/* 加急未选中 → 原红底 */
.part-row.is-urgent {
  background: #fef0f0;
  border-color: #f56c6c;
  border-left-color: #f56c6c;
}
/* 加急选中 → 保持红底，绿色边框 + inset 阴影表示选中 */
.part-row.is-urgent.is-selected {
  background: #fef0f0;
  border-color: #67c23a;
  box-shadow: 0 0 0 2px #67c23a inset;
}

.part-row-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.preview-btn {
  position: absolute !important;
  top: 8px;
  right: 10px;
  z-index: 1;
}

.part-line-top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-right: 64px;
  flex-wrap: wrap;
}
.serial-no {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 22px;
  font-weight: 700;
  color: #303133;
  letter-spacing: 0.5px;
}
/* .delivery-date / .days-left / .overdue / .due-soon 已迁至 components/DeliveryDateChip.vue */

.part-line-name {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  color: #303133;
}
.part-name {
  font-weight: 500;
  color: #303133;
}

.part-line-bottom {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 14px;
  color: #606266;
  flex-wrap: wrap;
}
.qty {
  color: #e6a23c;
  font-weight: 700;
  font-size: 15px;
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

@keyframes urgentPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}
.urgent-pulse {
  animation: urgentPulse 1.2s ease-in-out infinite;
}

.preview-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 60vh;
  color: #606266;
  font-size: 16px;
}
.image-preview-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 80px);
  padding: 24px;
  background: #1e1e1e;
}
.non-pdf-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 80px 32px;
}
.non-pdf-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}
.non-pdf-hint {
  margin: 0;
  color: #606266;
  font-size: 14px;
}
</style>
