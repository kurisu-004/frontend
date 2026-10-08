<!--
  ScanReturnParts.vue

  /scan/return —— 扫码台 RETURN 流程（2026-07-10 PR-E，2026-09-15 Phase 5 切 v2）
  1. onBeforeMount 调 GET /prod/scan/held 列出当前 worker 持有件
  2. 工人点选一件 → 按行 VO 的 `chain_state` 分流（2026-10-04，工序链适配）：
       - NEXT（链内有下一道）→ 下一道工序由链直接给出，弹单确认框三选一：
         「按链放回」/「换一道工序」（落回手选）/「取消」
       - TAIL（当前是链内最后一道）→ 工序选择弹窗内常驻提示「加工完成后请送检」，
         工人手选工序（提示不判死下一步的选择权）
       - NONE（无链 / 链已软删 / 指针漂移）→ 手选「下一道工序」picker
  3. 2026-09-15 Phase 5：提交走 POST /prod/scan/worker-scan（event_type=RETURNED），
     service 层 mark_returned + 同事务 WorkerPool refill。
  4. 成功后自动 refresh（该件从列表消失）

  2026-10-10：**货架不再由工人指定** —— 目标货架改由后端按负载自动选择（按
  `current_load / capacity` 升序，capacity 为 null = 不限，超载不拒）。本页因此
  删掉货架选择弹窗与「拉候选货架取推荐架」旁路。

  ⚠️ **单确认弹窗的主文案随之下半句**：原来要先拿到候选架才能说「放到哪个架」，
  现在前端没有货架信息可展示，只讲下一道工序。选中态里也只保留工序段 —— 写一个
  后端不保证等于用户所想的架号，比不写更糟（超载被允许时后端完全可能选另一个架）。
  但「换一道工序」这个出口必须留着：确认框是 NEXT 分支唯一能到达 ProcessPickerDialog
  的路，少了它工人一旦不同意管理员配的链就被困死（详见 showChainConfirm 处注释）。

  与 ScanPickParts.vue 范式对齐：
  - 选件 → （必要时选工序）→ 提交
  - 不需要扫码确认（点选即确认；旧流程「扫一批条码」已替换不保留）

  2026-10-09：列表卡的左边框专供「这条批次有制定工序链且链指针未漂移」这一个语义
  （有链 = 绿，规则见 `@/views/production/scan/chainAccent`）；流程区分由顶栏标题 + 路由承担，
  加急由红底 + 「加急」tag 承担，两者都不进边框。
  ⚠️ 本页是放回流程，`/prod/scan/held` 存量数据里链指针常常是 NULL ⇒ 短期内部分卡片灰边框
  属于预期，与下面 `chain_state` 分流是同一根因（指针未维护），不是渲染缺陷。
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
              chainRowClass(p.has_process_chain),
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
                     计划交期只作排序键、不上屏。⚠️ 后端给 held 的
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
         把下一道预填成选中项，工人直接点「下一步」就等于没得选；这两个绑定
         保持组件默认值（null / []）= 不预填、全部可选。
         链已知分支（chain_state=NEXT）下本 dialog 由「换一道工序」那个出口打开；
         「按链放回」与「取消」两条出口不经它。
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

    <!-- 链已知（chain_state=NEXT）单确认弹窗：下一道工序由链给出，工人三选一 ——
         「按链放回」/「换一道工序」/「取消」。
         自绘 el-dialog 而不是 ElMessageBox：后者只有确认/取消两个键，而「换一道工序」
         是工人不同意管理员配的链时唯一的出路（工序链是配置、临时插单会改道）；HMI
         触屏上三个并排大按钮也远好过塞在 message 正文里的小链接。
         ⚠️ **`:show-close="false"` 不是可选的洁癖**：右上角 × 只 emit
         `update:modelValue(false)`，不发任何业务事件，而本框是 NEXT 分支**唯一**的提交
         入口（`submitReturn` 的另外两个调用点分别要先进工序选择框、另一个是调试入口）。
         × 一关就留下「卡片已选中 + 工序已填 + 无处可提交」的死角，工人只能按
         「取消选择」再重选一遍。同页另外三个弹窗关掉不致命（确认栏的「取消选择」就能
         恢复），只有本框必须把关闭权收在 footer 三键上。 -->
    <el-dialog
      v-model="showChainConfirm"
      title="确认放回"
      width="min(95vw, 640px)"
      :align-center="true"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        :title="`「${selectedNextProcessName}」是这道工序的下一道。`"
      />
      <p class="chain-confirm-hint">
        确认后工件自动按负载放到合适的货架。若这道工序不对，用「换一道工序」自己选。
      </p>
      <template #footer>
        <el-button @click="onChainCancel">取消</el-button>
        <el-button type="warning" @click="onChainManual">换一道工序</el-button>
        <el-button type="primary" :loading="submitting" @click="onChainConfirm">
          按链放回
        </el-button>
      </template>
    </el-dialog>

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
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import { useScanPartsSort } from '@/views/production/scan/composables/useScanPartsSort';
import { refillTakenOf } from '@/views/production/scan/composables/refillTaken';
import HeldPartsBadge from '@/views/production/scan/components/HeldPartsBadge.vue';
import ScrollFabPair from '@/views/production/scan/components/ScrollFabPair.vue';
import QuantityDialog from '@/views/production/scan/components/QuantityDialog.vue';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';
import ProcessPickerDialog from '@/views/production/scan/components/ProcessPickerDialog.vue';
import BatchPickerDialog, {
  type BatchPickerRow,
} from '@/views/production/scan/components/BatchPickerDialog.vue';
import DeliveryDateChip from '@/views/production/scan/components/DeliveryDateChip.vue';
import RefillTakenDialog from '@/views/production/scan/components/RefillTakenDialog.vue';
import { chainRowClass } from '@/views/production/scan/chainAccent';
import { useScanHeldQuery } from '@/views/production/scan/composables/useScanListQuery';
import { useScanWorkerScanMutation } from '@/views/production/scan/composables/useScanWrite';

const workerScanMutation = useScanWorkerScanMutation();
import type { TakenItemDto } from '@/api/productionQueue.contract';
import type { Process } from '@/types/process';
import { findAllByCode, findPartBySerialAndPrompt } from '@/utils/scanHelpers';

const router = useRouter();
const { worker, requireWorker, reset: resetScanSession } = useScanSession();
const { onScan } = useBarcodeScanner();

// 2026-10-10：持有件列表改走 `GET /prod/scan/held` 的 query hook，与送检页 /
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

// 2026-10-10：货架选择整块下线（目标架由后端按负载自动选）。showQtyDialog 保留：
// 正常路径已不走它，但它是 worker-scan 整批语义的旧调试入口。
const showQtyDialog = ref(false);

// --- 自动补料告知（worker-scan 同事务 refill；抢到批次才弹窗） ---
const showRefillTaken = ref(false);
const refillTaken = ref<TakenItemDto[]>([]);
/** 扫码动作自身的成功文案（补料弹窗打开时它取代 ElMessage.success，见组件注释） */
const refillLead = ref('');

// --- 工序链已知分支（chain_state=NEXT）：下一工序已由链派生，只差一次确认 ---
//
// 目标货架不由前端决定（后端按负载自选），所以这个弹窗只有「下一道工序」一句话要摆。
// 但它**必须有三个出口**：确认框打开时页面上没有任何别的路能进 `ProcessPickerDialog`，
// 只给「按链放回 / 取消」的话，工人一旦不同意管理员配的链（临时插单、改道）就被困死
// —— 取消只是清选中态，再点卡片还是同一个弹窗。
// 故自绘 el-dialog 而不用 ElMessageBox：后者只有确认/取消两键，且塞在 message 正文里
// 的小链接在 HMI 触屏上是个难点目标。
const showChainConfirm = ref(false);

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
  // 换件前先收掉上一件的确认框，理由见 closeChainConfirm 的注释。
  closeChainConfirm();
  selectedPart.value = p;
  selectedQty.value = p.quantity;
  selectedNextProcessId.value = '';
  selectedNextProcessCode.value = '';
  selectedNextProcessName.value = '';
  const key = String(p.batch_id || p.id);
  await scrollCardIntoView(key);
  enterReturnFlow(p);
}

/**
 * 2026-10-04：按 chain_state 分流放回流程（点选与扫码两个入口共用这一个）。
 *
 * - `TAIL`：当前工序是链内最后一道 → 工序选择弹窗内**常驻**提示「加工完成后请送检」
 *   （不是 toast，见 `processHint`）。不把「下一道 = 送检」判死：链是管理员配的，
 *   工人对「这一步是不是真的走完」有最终发言权（临时插单 / 改道），提示 + 手选并存。
 * - `NEXT`：链内且有下一道 → 下一道工序已由链给出，弹一次确认框，工人不选工序、
 *   更不选货架（见 openChainConfirm）。
 * - 其它（含无链 / 链已软删 / 指针漂移 / 未知取值）：走原「选工序 → 提交」两步路径。
 */
function enterReturnFlow(p: ScanPartRowSchema): void {
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
    openChainConfirm(p);
    return;
  }
  showProcessDialog.value = true; // NONE：无链 / 漂移，现状不变
}

/** 后端认的三态；其余一律当 NONE（`scanSchema.ts::scanPartRowSchema.chain_state` 的
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

function onBatchPicked(p: BatchPickerRow): void {
  // 2026-10-04：BatchPickerDialog 的 pick emit 载荷是跨域共用的行契约（该组件的
  // props 才是本域最小结构型 BatchPickerRow），本页实际传进去的行是
  // scanPartRowSchema ⇒ 入口做一次窄化转换。
  showBatchPicker.value = false;
  void applyScanSelection(p as unknown as ScanPartRowSchema);
}

const unsubScan = onScan((code) => {
  void onScanToSelect(code);
});

onBeforeMount(() => {
  requireWorker(router);
});

/** 页面「刷新」按钮：走 query 的 refetch。 */
function refresh(): Promise<void> {
  return held.fetchList();
}

onBeforeUnmount(() => {
  unsubScan();
  if (previewBlobUrl.value) URL.revokeObjectURL(previewBlobUrl.value);
});

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
  // 换件前先收掉上一件的确认框（理由见 closeChainConfirm 的注释）；cancelSelect 那条
  // 分支已经自己复位，这里只管「换到另一件」。
  closeChainConfirm();
  selectedPart.value = p;
  selectedQty.value = p.quantity;
  selectedNextProcessId.value = '';
  selectedNextProcessName.value = '';
  enterReturnFlow(p);
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
  // 2026-10-10：选完工序直接提交（原先这里开货架 picker、再由它的 confirm 触发提交）。
  void submitReturn();
}

function onProcessCancel(): void {
  showProcessDialog.value = false;
  cancelSelect();
}

// ============================================================
// 2026-10-04 工序链已知分支：NEXT → 派生下一工序 → 单确认放回
// ============================================================

/**
 * 清掉链派生的半截状态（派生出来的下一工序），**保留选中件本身**。
 *
 * 为什么不整段 `cancelSelect()`：落回手选工序时选中件必须留着，否则工人选完工序后
 * `submitReturn` 会因 `!selectedPart` 直接 bail（弹一句「选择已重置」），整条手选路径
 * 走不通。要清的是「链给出的答案」，不是「选中的件」。
 *
 * 工序三件套（id / code / name）一起清：漏一个就会让确认栏或成功提示引用到上一次的
 * 标签，而 `selectedNextProcessId` 是 worker-scan 的必填入参，留着更危险。
 */
function clearChainDerived(): void {
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
 * 链已知（`chain_state === 'NEXT'`）：下一道工序已由链给出，开单确认弹窗。
 *
 * 全程**同步**（读行 VO 上已带的链字段就赋值），没有请求往返窗口 ⇒ 不需要作废在途
 * 响应的竞态令牌。
 *
 * 一条边界（落回手选工序，保证工人永远有出路）：`chain_next_process_id` 为空或 `'0'`
 * —— NONE / TAIL 的兜底值，不是真 id，发过去必被拒，直接落回手选。
 */
function openChainConfirm(p: ScanPartRowSchema): void {
  const nextProcessId = p.chain_next_process_id;
  const nextProcessName = p.chain_next_process_name;
  if (!nextProcessId || nextProcessId === '0' || !nextProcessName) {
    ElMessage.warning('未找到下一道工序，请手动选择工序');
    fallBackToManualProcess();
    return;
  }

  selectedNextProcessId.value = nextProcessId;
  // 链上派生的只有工序名（无 code），与手选路径的「code + name」标签形态对齐不了；
  // 这里只显示名字，确认栏与成功提示都靠它。
  selectedNextProcessName.value = nextProcessName;
  showChainConfirm.value = true;
}

/** 「按链放回」：写死下一道工序后走提交路径。 */
async function onChainConfirm(): Promise<void> {
  showChainConfirm.value = false;
  if (submitting.value) return;
  if (!selectedNextProcessId.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    cancelSelect();
    return;
  }
  await submitReturn();
}

/** 「换一道工序」：关掉确认框后走与「链字段解析不出」**同一个**落回出口。 */
function onChainManual(): void {
  showChainConfirm.value = false;
  fallBackToManualProcess();
}

/** 「取消」：整次放回作废。 */
function onChainCancel(): void {
  showChainConfirm.value = false;
  cancelSelect();
}

/**
 * 关掉链确认框（如果开着），**不动选中态**。
 *
 * 点选与扫码这两个「换一件」入口都必须调它：它们直接改 `selectedPart`、不经
 * `cancelSelect`，所以确认框不会被顺带复位。漏调的话，上一件的确认框会留在屏幕上、
 * 正文摆着上一道的工序名，而选中件已经是新的 —— 工人点「按链放回」放回的是新件配旧工序。
 * 今天不可达（`el-dialog` 的模态遮罩挡住卡片点击、扫码路径另有早退闸），但这属于
 * 「状态分散在两处、其中一处漏复位」那一类，改动路由或遮罩就会现形，故显式收口。
 */
function closeChainConfirm(): void {
  showChainConfirm.value = false;
}

/** 实际提交：worker-scan（event_type=RETURNED）。 */
async function submitReturn(): Promise<void> {
  if (!selectedPart.value || !selectedNextProcessId.value || !worker.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    return;
  }
  // 成功提示在 await 之后才组装：先把要用的值取出来，不再回头读 state（那时 state 可能
  // 已被 cancelSelect 清掉、或已被下一轮选件改写）。
  const serialNo = selectedPart.value.serial_no ?? '';
  const batchId = selectedPart.value.batch_id ?? null;
  const nextProcessId = selectedNextProcessId.value;
  const nextProcessName = selectedNextProcessName.value ?? '';
  try {
    const res = await workerScanMutation.mutateAsync({
      serial_no: serialNo,
      badge_code: worker.value.badge_code ?? '',
      event_type: 'RETURNED',
      // 2026-10-10：**不发 shelf_id** —— 目标架由后端按负载自动选。
      next_process_id: nextProcessId,
      batch_id: batchId,
    });
    cancelSelect();
    // ⚠️ **成功文案按响应的 `scan.event_type` 分支**：客户端发的是 RETURNED，但当该批次的
    // 当前工序恰是工序链最后一道时，后端自动把这次放回改投品检、响应回来的是
    // `WORKER_SCAN_INSPECTED`。照请求的 event_type 说「已放回 → 下一道工序」会让工人
    // 以为工件还在待加工区，下一轮去放回时才发现它已经被送走了。
    const leadText = returnSuccessText(serialNo, nextProcessName, res.scan.event_type);
    // 2026-10-05：worker-scan 同事务 refill 抢到批次时弹窗告知（空数组 = 池空 / 已持满，
    // 不弹）。弹窗不依赖列表刷新的往返，工人立刻看到补了什么料。
    // 成功文案并进弹窗（lead-text），不另发 ElMessage.success —— 后开的 dialog 遮罩会盖住
    // 先发的 toast。
    const taken = refillTakenOf(res);
    if (taken.length) {
      refillTaken.value = taken;
      refillLead.value = leadText;
      showRefillTaken.value = true;
    } else {
      ElMessage.success(leadText);
    }
    // mutateAsync 返回时 onSuccess 的失效链已 settle（TanStack await onSuccess 返回的
    // promise）⇒ 列表与徽章都是刷新后的状态，此时自增 token 开抽屉。
    heldChangeToken.value++;
  } catch (e) {
    // 失败也走全套失效（mutation 的 onError）：40901 OCC / 20103 状态非法都意味着
    // 服务端那份数据已经变了，本端副本过期。
    ElMessage.error((e as Error).message ?? '放回失败');
  }
}

async function onQtyConfirm(qty: number): Promise<void> {
  // 2026-09-15 Phase 5：worker-scan 不支持部分数量；保留 dialog 入口以兼容
  // 旧调试路径，正常流程已由 openChainConfirm / onProcessPicked → submitReturn 跳过此步。
  showQtyDialog.value = false;
  if (submitting.value) return;
  if (!selectedPart.value || !selectedNextProcessId.value || !worker.value) {
    ElMessage.warning('选择已重置，请重新选择零件');
    return;
  }
  selectedQty.value = qty;
  await submitReturn();
}

/**
 * 放回成功文案。**判据是响应里的 `scan.event_type`，不是请求里的 `event_type`。**
 *
 * 后端在「当前工序是工序链最后一道」时会自动把这次放回改投品检，于是同一个
 * `event_type: 'RETURNED'` 的请求可能回来 `WORKER_SCAN_INSPECTED`；此时说
 * 「已放回 → 下一道工序」是错的（工件已被送走，「下一道」根本不存在）。
 * 这两个字面量就是 WS 广播名（见 `api/parts/crud.ts::WorkerScanOut.scan`），逐字比。
 * 未知取值走放回文案：宁可少说一句也不谎报已送检（后者会让工人白跑一趟品检）。
 */
function returnSuccessText(serialNo: string, nextProcessName: string, eventType: string): string {
  return eventType === 'WORKER_SCAN_INSPECTED'
    ? `已完工，已送检：${serialNo}`
    : `已放回：${serialNo} → ${nextProcessName}`;
}

/**
 * 确认栏 / 数量弹窗的「取消」入口：提交在途时**不**清选择。
 *
 * 清了会怎样：`submitReturn` 成功分支里的 `cancelSelect()` 之后还要自增
 * `heldChangeToken` 让徽章开抽屉，若用户在途点了取消，选中态已空、确认栏消失，而那次放回
 * 其实成功提交了 —— 工人看到的是「我明明取消了，怎么还放回去了」，下一次提交也可能带上
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
  processHint.value = '';
  // 确认框一并复位：漏复位会让下一次选件（哪怕是 NEXT 链字段解析不出、根本不开框的
  // 那一件）也被上一次的 true 顶出一个空确认框。
  showChainConfirm.value = false;
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
/* 链已知确认框里那句「自动按负载放架 + 可以换一道工序」的补充说明 */
.chain-confirm-hint {
  margin: 12px 0 0;
  color: #606266;
  font-size: 14px;
  line-height: 1.6;
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
  /* 左边框底色与另外三边同色；链语义绿由下面的 `.part-row.has-chain` 覆盖，
     状态类（.is-selected / .is-urgent）不动左边框。 */
  border-left: 4px solid #e4e7ed;
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
/* 加急未选中 → 原红底（左边框不参与加急：它归链语义，加急由红底 + 「加急」tag 表达） */
.part-row.is-urgent {
  background: #fef0f0;
  border-color: #f56c6c;
}
/* 加急选中 → 保持红底，绿色边框 + inset 阴影表示选中 */
.part-row.is-urgent.is-selected {
  background: #fef0f0;
  border-color: #67c23a;
  box-shadow: 0 0 0 2px #67c23a inset;
}
/* 左边框 = 链语义（有制定工序链且链指针未漂移），EP 语义绿的字面值。
   必须排在全部状态类之后：与它们同为 0,2,0，靠源码顺序取胜，这样
   `border-color` 简写染过的四边里左边框仍归链语义。 */
.part-row.has-chain {
  border-left-color: #67c23a;
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
