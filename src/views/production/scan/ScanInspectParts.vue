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
        <el-tag type="success" effect="dark">送 检</el-tag>
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
          <el-button v-if="canDownload" type="primary" @click="downloadPreview">
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
        <el-button v-if="previewFile && canDownload" type="primary" @click="downloadPreview">
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
  Aim,
  Avatar,
  Back,
  Box,
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
// 2026-10-11：「下载文件」按钮的角色闸门。后端把 part_file 的列表 / content 对
// SHELF_ACCOUNT 放开了（工控机预览图纸打的就是这两条），但 `/part-files/{id}/url`
// **刻意没放开**（COS 预签直链可外传）⇒ 不挂闸门就是「可见但必 403」。判据在
// utils/partsPermissions，与后端 require_any_role 白名单同集合。
import { usePermissions } from '@/composables/usePermissions';
import { canDownloadPartFile } from '@/utils/partsPermissions';
import type { PartFileItem } from '@/types/part_file';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import { useScanPartsSort } from '@/views/production/scan/composables/useScanPartsSort';
import { refillTakenOf } from '@/views/production/scan/composables/refillTaken';
import HeldPartsBadge from '@/views/production/scan/components/HeldPartsBadge.vue';
import ScrollFabPair from '@/views/production/scan/components/ScrollFabPair.vue';
import QuantityDialog from '@/views/production/scan/components/QuantityDialog.vue';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';
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
  if (previewBlobUrl.value) URL.revokeObjectURL(previewBlobUrl.value);
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

// 2026-10-11：下载入口闸门（判据见 utils/partsPermissions 与上面那段 import 注释）。
const { isManager, isClerk, isInspector, isCncProgrammer } = usePermissions();
const canDownload = computed<boolean>(() =>
  canDownloadPartFile({
    MANAGER: isManager.value,
    CLERK: isClerk.value,
    INSPECTOR: isInspector.value,
    CNC_PROGRAMMER: isCncProgrammer.value,
  }),
);

async function downloadPreview(): Promise<void> {
  if (!previewFile.value) return;
  // 与按钮的 v-if 同一道守卫：按钮是 DOM 闸门，函数体是行为闸门 —— 只藏按钮的话，
  // 任何一个仍能触达本函数的地方（控制台、后续新增的快捷键）都会变成「点了必 403」。
  if (!canDownload.value) return;
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
  box-shadow: 0 2px 12px rgba(103, 194, 58, 0.08);
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
