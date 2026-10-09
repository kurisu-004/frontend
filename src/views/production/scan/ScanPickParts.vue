<!--
  ScanPickParts.vue

  /scan/pick —— 扫码台 PICK_UP 流程（2026-09-15 Phase 5）

  流程：
  1. 拉取 worker.work_type_id 映射下、该账号可及的全部货架上的零件列表
     （`GET /prod/scan/pickable`，后端按 user.shelf_ids 收口）
  2. 工人点选一个零件 → 进入「等待扫码」状态
  3. 扫码枪输入 serial_no；前端校验必须等于选中零件.serial_no；不等则拒绝
  4. 通过则弹「数量」对话框；确认后调 POST /prod/scan/batches/{batch_id}/pick-up

   2026-10-10 迁 `prod::scan` 域（列表 `GET /prod/scan/pickable` + 领取
  `POST /prod/scan/batches/{batch_id}/pick-up`），URL 硬切无 alias。
  2026-10-03 迁 v2 批次锚定端点（pick-up 由 v1 遗留的 /parts/pick-up 迁入 prod 域）：
   - 批次 id 走**路径参数**，body 只剩 `{ version, worker_id, quantity?, note? }`：
     `version` 取列表项 `batch_version`（t_part_batch.version，OCC 锚）、
     `worker_id` 是工人雪花 ID（**不是** badge_code）、`quantity` **必须发字符串**
     （后端只解 JSON string，发 number 直接 422）。
   - 数量对话框不再是死 UI：v2 端点支持部分领取，缺省 quantity 才 = 整批。
   - 本页依赖的两处后端能力均已合入 backend `master`（2026-10-03：部分领取 +
     拆批、`/prod/scan/pickable` 返 `batch_id` / `batch_version`），即流程可跑通。
   - 列表行缺 batch_id / batch_version 时走显式报错（`PICK_UP_NO_BATCH_HINT`），
     **不静默用 part_id 顶替**（那会打成后端「批次不存在」，掩盖真实原因）。
     ⚠️ 这条守卫是**防线**而非常态：正常路径上 `GET /prod/scan/pickable` 恒返
     这两个字段（后端对 part 级行一律不填，只对这个「行单位就是批次」的端点填），所以
     弹这条提示基本等于「后端没给锚点」，值得当异常上报。
   - 本页 PICK_UP 不直接调 worker-scan（该端点服务 RETURNED / INSPECTED 事件），
     仍走 pickUpPart 这条手动领取路径。

   2026-10-04 解绑作业架：后端把 pick-up 的 `shelf_id` 改成可选（缺省不做任何校验），
   该值本就既不落库也不参与任何 WHERE ⇒ 本页提交不带任何货架字段。
   这解掉了「账号绑 ≥ 2 个架 ⇒ 作业架判不出 ⇒ 守卫 100% 拦死、取件一次都提交不出去」
   的死结：取件对账号绑了几个架不再有任何要求。扫码台三页都不再有「作业货架」概念 ——
   目标货架一律由后端按负载自动选（见 CLAUDE.md「货架自动选择」）。
   - ⚠️ **部署顺序**：后端改成可选的那一支必须先上线；旧后端 + 不发 `shelf_id` = 裸
     HTTP 422（axum Json extractor 拒，不是项目统一信封）。

   2026-10-09：列表卡的左边框专供「这条批次有制定工序链且链指针未漂移」这一个语义
   （有链 = 绿，规则见 `@/views/production/scan/chainAccent`）；流程区分由顶栏标题 + 路由承担，
   加急由红底 + 「加急」tag 承担，两者都不进边框。
-->

<template>
  <div class="scan-pick">
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
        <el-tag type="primary" effect="dark">取 件</el-tag>
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
      <div v-if="loadingList" class="loading-block">
        <el-icon :size="32" class="is-loading"><Loading /></el-icon>
        <p>加载可领件列表…</p>
      </div>

      <div v-else-if="!worker?.work_type_id" class="empty-block">
        <el-icon :size="60" color="#e6a23c"><Warning /></el-icon>
        <h3>未分配工种</h3>
        <p>请联系管理员在「权限管理 → 工人一览」中为本工牌指派工种。</p>
        <el-button type="primary" @click="backToAction">返回</el-button>
      </div>

      <div v-else-if="parts.length === 0" class="empty-block">
        <el-icon :size="60" color="#c0c4cc"><Box /></el-icon>
        <h3>当前工种无可领件</h3>
        <p>该工种在所有生产货架上没有匹配「下一道工序」的零件。</p>
        <el-button type="primary" @click="refresh">刷新</el-button>
        <el-button @click="backToAction">返回</el-button>
      </div>

      <div v-else>
        <div class="parts-header">
          <el-icon :size="24"><Box /></el-icon>
          <span class="parts-header-text">可领件列表</span>
          <el-tag type="info" effect="plain" size="large" class="count-tag">
            共 {{ total }} 件<template v-if="total > parts.length"
              >（显示前 {{ parts.length }} 件）</template
            >
          </el-tag>
          <el-button :icon="Refresh" circle size="small" @click="refresh" />
        </div>

        <div v-if="selectedPart" class="confirm-bar">
          <el-icon :size="20" color="#409eff" class="is-loading"><Aim /></el-icon>
          <span class="confirm-text">
            已选 <strong>{{ selectedPart.serial_no || selectedPart.drawing_no }}</strong> ·
            {{ selectedPart.name }} · 数量 {{ selectedPart.quantity }} ·
            请扫描该零件的序列号条码确认
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
                     计划交期只作排序键、不上屏。⚠️ 后端在这两个端点上把
                     planned_delivery_date 写死 '1970-01-01'、system_delivery_date 恒 null
                     （已在 scanPartRowSchema 的 transform 里归一成 null）⇒ 后端补真实投影
                     之前，全仓卡片这一位都会是 '-'，是发布顺序问题、不是渲染缺陷。 -->
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

    <!-- 数量选择弹窗 -->
    <QuantityDialog
      v-if="showQtyDialog"
      v-model="showQtyDialog"
      :max="selectedPart?.quantity ?? 1"
      :serial-no="selectedPart?.serial_no || selectedPart?.drawing_no || null"
      :part-name="selectedPart?.name || null"
      action-label="领取"
      @confirm="onQtyConfirm"
      @cancel="showQtyDialog = false"
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
import HeldPartsBadge from '@/views/production/scan/components/HeldPartsBadge.vue';
import ScrollFabPair from '@/views/production/scan/components/ScrollFabPair.vue';
import QuantityDialog from '@/views/production/scan/components/QuantityDialog.vue';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';
import { findAllByCode, findPartBySerialAndPrompt } from '@/utils/scanHelpers';
import BatchPickerDialog, {
  type BatchPickerRow,
} from '@/views/production/scan/components/BatchPickerDialog.vue';
import DeliveryDateChip from '@/views/production/scan/components/DeliveryDateChip.vue';
import { chainRowClass } from '@/views/production/scan/chainAccent';
import { useScanPickableQuery } from '@/views/production/scan/composables/useScanListQuery';
import { useScanPickUpMutation } from '@/views/production/scan/composables/useScanWrite';

const pickUpMutation = useScanPickUpMutation();

const router = useRouter();
const { worker, requireWorker, reset: resetScanSession } = useScanSession();
const { onScan } = useBarcodeScanner();
// 2026-10-10：取件列表改走 `GET /prod/scan/pickable` 的 query hook（后端按
// user.shelf_ids 收口）。取件提交不再需要任何货架字段（目标架由后端按负载自动选）——
// 账号绑几个架都提交得出去。

// 列表：query 驱动。params 为 null（未扫工牌 / 无工种）时不发请求 —— 端点的
// work_type_id 是必填 query 键且只吃 JSON 字符串，漏传会被后端 QueryRejection 拒成 400。
const pickable = useScanPickableQuery(() => {
  const workTypeId = worker.value?.work_type_id;
  return workTypeId ? { workTypeId, limit: 200 } : null;
});
// limit=200 是后端 clamp 上限：不传时后端默认只返 50 条，列表会静默截断。
const parts = computed<ScanPartRowSchema[]>(() => pickable.query.data.value?.items ?? []);
// 后端信封里的总条数（可能大于已加载的 parts.length —— 见上面 limit 的说明）
const total = computed(() => pickable.query.data.value?.total ?? 0);
// `isPending`（还没有任何数据）而非 `isFetching`：后者在写后失效触发的后台 refetch 期间
// 也为 true，用它会让整页在每次提交后闪一次 loading 块。
const loadingList = computed(() => pickable.query.isPending.value);
const submitting = computed(() => pickUpMutation.isPending.value);
/** 写成功后自增，驱动徽章自动开抽屉（见 HeldPartsBadge 的 autoOpenToken 注释）。 */
const heldChangeToken = ref(0);
// 「系统交期」硬优先级 + 原 is_urgent / planned_delivery_date 排序；详见 composable 注释
const sortedParts = useScanPartsSort(parts);

const contentRef = ref<HTMLElement | null>(null);
const selectedPart = ref<ScanPartRowSchema | null>(null);
const showQtyDialog = ref(false);

// --- 多批次扫码命中弹窗状态 ---
const showBatchPicker = ref(false);
const batchPickerCode = ref('');
const batchPickerRows = ref<ScanPartRowSchema[]>([]);

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

onBeforeMount(() => {
  // 取件页不依赖任何货架状态（目标架由后端按负载自动选，见文件头）；列表由 query 在
  // setup 时按 `enabled` 闸门自行发起。
  requireWorker(router);
});

/** 页面「刷新」按钮 / 空态里的「刷新」：走 query 的 refetch。 */
function refresh(): Promise<void> {
  return pickable.fetchList();
}

const selectedQty = ref<number | undefined>(undefined);

/** 2026-07-29 批次化：行=批次，选中比较按 batch_id（无批次信息退回 part id） */
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
  ElMessage.info(`已选中 ${p.serial_no || p.drawing_no}，请扫码确认`);
}

function cancelSelect(): void {
  selectedPart.value = null;
  selectedQty.value = undefined;
}

// --- 预览 ---
async function onPreview(p: ScanPartRowSchema): Promise<void> {
  previewPart.value = p;
  showPreview.value = true;
  previewLoading.value = true;
  const myToken = ++previewToken;
  try {
    // 1. 取该零件的 DRAWING 文件列表
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
    // 2. PDF / 图片需要 blob URL；HEIC / STEP / DWG 等直接走下载按钮
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

// --- 扫码：扫描直接选中 + 滚动居中 + 打开下一弹窗；不在列表则提示当前位置 ---

/** 选中后等一拍再滚动；元素不在容器内则静默返回 */
async function scrollCardIntoView(batchKey: string): Promise<void> {
  await nextTick();
  const root = contentRef.value;
  if (!root) return;
  const el = root.querySelector<HTMLElement>(`.part-row[data-batch-id="${CSS.escape(batchKey)}"]`);
  if (!el || !root.contains(el)) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** PICK tail：选中 + 滚动 + 开数量弹窗 */
async function applyScanSelection(p: ScanPartRowSchema): Promise<void> {
  selectedPart.value = p;
  selectedQty.value = p.quantity;
  const key = String(p.batch_id || p.id);
  await scrollCardIntoView(key);
  if (!worker.value) return;
  showQtyDialog.value = true;
}

async function onScanToSelect(rawCode: string): Promise<void> {
  const code = rawCode.trim();
  if (!code) return;
  if (submitting.value || showQtyDialog.value || showBatchPicker.value || showPreview.value) return;
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

const unsub = onScan((code) => {
  void onScanToSelect(code);
});

onBeforeUnmount(() => {
  unsub();
  if (previewBlobUrl.value) URL.revokeObjectURL(previewBlobUrl.value);
});

/** 2026-10-03：列表行缺批次锚点（batch_id / batch_version）时的统一提示。
 *  2026-10-03 订正文案：原文案尾部写「（列表接口未返回批次）」，而本页唯一数据源
 *  `GET /prod/scan/pickable` 恰恰是**全仓唯一会填这两个字段的端点**（见文件
 *  头），那句话对它是假的，且与同文件头「弹这条提示基本等于『后端没给锚点』」自相
 *  矛盾。改为只描述现象、不归因端点。
 *  仍与「零件一览」的 `PLACE_ON_SHELF_NO_BATCH_HINT` 同范式：显式报错让用户知道是
 *  数据缺口，而不是让它变成后端一句含糊的「批次不存在」。 */
const PICK_UP_NO_BATCH_HINT =
  '该零件的批次锚点缺失（列表未下发 batch_id / batch_version），无法领取';

async function onQtyConfirm(qty: number): Promise<void> {
  showQtyDialog.value = false;
  if (!selectedPart.value || !worker.value) return;
  const code = selectedPart.value.serial_no || selectedPart.value.drawing_no || '';
  // 2026-10-03 迁 v2 批次锚定：batch_id 升为路径参数、version 为 OCC 锚，两者都取自
  // 列表项（两条 list 端点都填）。缺任一即契约/数据缺口，
  // **不用 part_id 顶替**（顶替会打成后端「批次不存在」，把真因盖掉）。
  const batchId = selectedPart.value.batch_id;
  const batchVersion = selectedPart.value.batch_version;
  if (!batchId || batchVersion === null || batchVersion === undefined) {
    ElMessage.error(PICK_UP_NO_BATCH_HINT);
    return;
  }
  selectedQty.value = qty;
  try {
    await pickUpMutation.mutateAsync({
      batchId,
      // 普通 number：后端 i32，无自定义 deserializer。
      version: batchVersion,
      // 工人雪花 ID 字符串（后端按 worker 记录归属，不认 badge_code）。
      workerId: String(worker.value.id),
      // 部分领取；必须发字符串（后端 deserialize_i64_opt 只解 JSON string）。
      quantity: String(qty),
    });
    ElMessage.success(`已领取: ${code} × ${qty}`);
    selectedPart.value = null;
    // mutateAsync 返回时 mutation 的 onSuccess 失效链已经 settle（TanStack 会 await
    // onSuccess 返回的 promise），列表与徽章都是刷新后的状态 ⇒ 此时自增 token 开抽屉。
    heldChangeToken.value++;
  } catch (e) {
    // 失败也走全套失效（mutation 的 onError）：40901 OCC 意味着这批已被别人领走，
    // 本端副本已过期，不刷就会留下一条作废的候选件。
    ElMessage.error((e as Error).message ?? '领取失败');
  }
}

function backToAction(): void {
  selectedPart.value = null;
  void router.replace('/scan/action');
}

function backToBadge(): void {
  selectedPart.value = null;
  resetScanSession();
  void router.replace('/scan/badge');
}
</script>

<style lang="scss" scoped>
.scan-pick {
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
  background: #ecf5ff;
  border: 1px solid #d9ecff;
  border-radius: 8px;
  margin-bottom: 16px;
}
.confirm-text {
  flex: 1;
  color: #303133;
}
.confirm-text strong {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: #409eff;
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
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.08);
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
  color: #409eff;
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
