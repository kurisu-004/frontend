<!--
  PartDetail.vue

  /parts/:id  零件详情页（装配壳）。
  - 8 张卡：信息卡 / 历史记录卡 / 条形码卡 / 装配件卡 / 零件文件 tabs 卡 /
    时间线卡（含批次监控 + 历史过滤 + 工序链）/ 底部操作 / dialog 区。
  - 2026-09-17 PR-4 卡片化重构：
    - 删除 PartQuoteCard / usePartQuote（外协报价下线，仅保留 /outsource/quote
      入口；PartDetail 不再展示报价列表）。
    - 4 张 FileListCard + PartCncCard 合并为 PartFilesTabsCard（el-tabs 切
      DRAWING / 3D_MODEL / CAD_2D / CNC_PAIR 4 tab）。
    - 新增「时间线」卡：3 列 flex 容器 → PartBatchMonitorCard（左，批次列表
      + 拆分 / 取消 + 行选中联动） / PartHistoryCard（中，按选中批次过滤的
      历史）/ ProcessChainCard（右，工艺链可视化）。
  - 底部操作（品检 / 外协回收 / 取消 / 删除）留在 shell，因为它们跨多张卡
    状态；dialog 状态由 shell 局部维护，业务函数调 usePartDetail。
  - 2026-09-15 Phase 5：业务全切 v2（api 基址 `/api/v2`）。品检通过走
    `POST /parts/{id}/to-ship`（v2 必填 batch_id + version），指定工序走
    `POST /parts/{id}/fail-inspection`。
  - 工艺链：part.process_chain_id 改走 useProcessChain 拉链（PR-3）。
-->
<template>
  <div v-loading="infoLoading" class="part-detail">
    <!-- 信息卡 -->
    <PartInfoCard
      :part="part"
      :editing="editing"
      :saving="saving"
      :form="form"
      :info-loading="infoLoading"
      :can-edit-part="canEditPart"
      :status-label="statusLabel"
      :status-tag-type="statusTagType"
      @edit="onStartEdit"
      @save="onSave"
      @cancel="onCancelEdit"
      @update:form="onPartInfoFormChange"
    />

    <!-- 历史记录（被选中批次时由 PartHistoryCard 内部按 batch_id 过滤） -->
    <PartHistoryCard
      :part-id="partId"
      :events="events"
      :events-loading="eventsLoading"
      :status-label-of="statusLabelOf"
      :event-label="eventLabel"
      :event-tag-type="eventTagType"
      :selected-batch-id="selectedBatchId"
    />

    <!-- 条形码（仅当存在 serial_no 时显示） -->
    <el-card v-if="part && part.serial_no" shadow="never" class="barcode-card">
      <template #header>
        <div class="card-header">
          <span class="card-title">
            <el-icon><PriceTag /></el-icon>
            <span>序列号条码</span>
          </span>
          <span class="mono serial-label">{{ part.serial_no }}</span>
        </div>
      </template>
      <div class="barcode-wrap">
        <Barcode :value="part.serial_no" format="CODE39" :height="80" :width="2" />
      </div>
    </el-card>

    <!-- 所属装配件 -->
    <PartAssemblyLinkCard
      v-if="part && part.assembly_id !== null"
      :part="part"
      :assembly-detail="assemblyDetail"
      :assembly-loading="assemblyLoading"
    />

    <!-- 零件文件 tabs 卡（2026-09-17 PR-4：合并 4 张 FileListCard + PartCncCard） -->
    <PartFilesTabsCard
      :part-id="partId"
      :part-status="part?.status ?? 'PENDING'"
      :drawings="drawings"
      :models3d="models3d"
      :cad-files="cadFiles"
      :can-manage-drawings="canManageDrawings"
      :can-manage-3-d-models="canManage3DModels"
      :can-manage-cnc-files="canManageCncFiles"
      :can-manage-setup-sheet="canManageSetupSheet"
      :is-inspector="isInspectorRaw"
      :drawing-upload="drawingUpload"
      :model3d-upload="model3dUpload"
      :cad-upload="cadUpload"
      :cnc-setup-groups="cncSetupGroups"
      :cnc-loading="cncLoading"
      :production-shelves="productionShelves"
      :processes="processes"
      :format-bytes="formatBytes"
      :file-list="fileList"
      :on-download-cnc="onDownloadCnc"
      :on-delete-cnc="onDeleteCnc"
      @refresh="onFileTabRefresh"
      @fetch="fetchCncPrograms"
      @pairUpload="handlePairUpload"
      @release="handleRelease"
    />

    <!--
      时间线卡（2026-09-17 PR-4）：批次列表 + 历史 + 工序链 三列联动。
      - PartBatchMonitorCard 行选中 → onBatchSelect → 写入 selectedBatchId
      - selectedBatchId 同步驱动：PartHistoryCard 过滤 / ProcessChainCard
        高亮 current_process_step_id 对应步骤。
    -->
    <el-card shadow="never" class="timeline-card">
      <template #header>
        <div class="card-header">
          <span class="card-title">
            <el-icon><Clock /></el-icon>
            <span>时间线</span>
          </span>
        </div>
      </template>
      <div class="timeline-row">
        <PartBatchMonitorCard
          :part-id="partId"
          :batches="batches"
          :batches-loading="batchesLoading"
          :can-manage-batches="canManageBatches"
          :status-tag-type="statusTagType"
          :status-label-of="statusLabelOf"
          :selected-batch-id="selectedBatchId"
          @fetch="fetchBatches"
          @split="handleSplitBatch"
          @cancelBatch="handleCancelBatch"
          @select="onBatchSelect"
        />
        <PartHistoryCard
          :part-id="partId"
          :events="events"
          :events-loading="eventsLoading"
          :status-label-of="statusLabelOf"
          :event-label="eventLabel"
          :event-tag-type="eventTagType"
          :selected-batch-id="selectedBatchId"
        />
        <ProcessChainCard
          :steps="processChain.steps.value"
          :current-step-id="currentStepId"
          :loading="processChain.loading.value"
          :processes-lookup="processesLookup"
        />
      </div>
    </el-card>

    <!-- 底部操作：取消订单 / 删除 / 品检 / 外协回收（按角色门控） -->
    <el-card v-if="part" shadow="never" class="bottom-actions">
      <div class="action-row">
        <!-- 品检相关：仅 INSPECTION 状态可见 -->
        <template v-if="canInspect && part.status === 'INSPECTION'">
          <el-button type="success" :loading="passSubmitting" @click="onPassInspection"
            >品检通过</el-button
          >
          <el-button type="warning" @click="openFailInspDialog">指定工序</el-button>
        </template>
        <!-- 外协回收：OUTSOURCE 状态可见（MANAGER + CLERK） -->
        <el-button
          v-if="canReceiveFromOutsource && part.status === 'OUTSOURCE'"
          type="success"
          @click="openReceiveOutsourceDialog"
          >外协回收</el-button
        >
        <el-button
          v-if="canCancelPart && part.status !== 'CANCELLED' && part.status !== 'COMPLETED'"
          type="warning"
          @click="openConfirmForCancel"
          >取消订单</el-button
        >
        <el-button v-if="canDeletePart" type="danger" @click="openConfirmForDelete">删除</el-button>
      </div>
    </el-card>

    <!-- 外协回收 对话框（2026-07-15 新增） -->
    <el-dialog
      v-model="receiveOutsourceDialogVisible"
      title="外协回收 — 选择目标生产货架与下一道工序"
      :width="receiveOutsourceDlg.width"
      :top="receiveOutsourceDlg.top"
      :fullscreen="receiveOutsourceDlg.fullscreen"
      :close-on-click-modal="false"
      @closed="onReceiveOutsourceDialogClosed"
    >
      <el-form label-width="110px">
        <el-form-item label="目标生产货架" required for="">
          <el-radio-group
            v-model="receiveShelfId"
            aria-label="目标生产货架"
            style="
              display: flex;
              flex-direction: column;
              gap: 6px;
              max-height: 180px;
              overflow-y: auto;
            "
          >
            <el-radio
              v-for="s in receiveFilteredShelves"
              :key="s.id"
              :value="String(s.id)"
              :disabled="!s.is_active"
            >
              {{ s.code }} — {{ s.name }}
              <span v-if="!s.is_active" class="muted">（已停用）</span>
            </el-radio>
            <span v-if="receiveFilteredShelves.length === 0" class="muted">没有可用生产货架</span>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="下一道工序" required for="">
          <el-radio-group
            v-model="receiveProcessId"
            aria-label="下一道工序"
            style="
              display: flex;
              flex-direction: column;
              gap: 6px;
              max-height: 180px;
              overflow-y: auto;
            "
          >
            <el-radio v-for="p in receiveFilteredProcesses" :key="p.id" :value="String(p.id)">
              {{ p.code }} — {{ p.name }}
            </el-radio>
            <span v-if="receiveFilteredProcesses.length === 0" class="muted">
              没有 INHOUSE 工序
            </span>
          </el-radio-group>
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="回收后零件回到 IN_PROCESS / ON_SHELF 状态，可继续车间加工。"
        />
      </el-form>
      <template #footer>
        <el-button @click="receiveOutsourceDialogVisible = false">取消</el-button>
        <el-button
          type="success"
          :loading="receiveSubmitting"
          :disabled="!receiveShelfId || !receiveProcessId"
          @click="onReceiveConfirm"
          >确认回收</el-button
        >
      </template>
    </el-dialog>

    <!-- 指定工序对话框（PartDetail 用）—— 2026-07-21 改：先选下一道工序，再选目标生产货架；可选品检备注 -->
    <el-dialog
      v-model="failInspDialogVisible"
      title="指定工序 — 选择下一道工序 + 目标生产货架"
      :width="failInspDlg.width"
      :top="failInspDlg.top"
      :fullscreen="failInspDlg.fullscreen"
      :close-on-click-modal="false"
      @closed="onFailInspDialogClosed"
    >
      <el-form label-width="96px">
        <el-form-item label="下一道工序" required>
          <el-select
            v-model="failInspProcessId"
            placeholder="请先选择下一道工序"
            filterable
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="p in failInspFilteredProcesses"
              :key="p.id"
              :value="String(p.id)"
              :label="`${p.code} — ${p.name}`"
            >
              {{ p.code }} — {{ p.name }}
              <el-tag
                v-if="p.category === 'OUTSOURCE'"
                type="warning"
                size="small"
                effect="plain"
                class="opt-tag"
              >
                外协
              </el-tag>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="目标生产货架" required>
          <el-select
            v-model="failInspShelfId"
            placeholder="先选工序；货架候选按映射过滤"
            filterable
            clearable
            style="width: 100%"
            :disabled="!failInspProcessId"
          >
            <el-option
              v-for="s in failInspFilteredShelves"
              :key="s.id"
              :value="String(s.id)"
              :label="`${s.code} — ${s.name}`"
              :disabled="!s.is_active"
            >
              {{ s.code }} — {{ s.name }}
              <span v-if="!s.is_active" class="muted">（已停用）</span>
            </el-option>
            <template #empty>
              <span class="muted">
                {{
                  failInspProcessId
                    ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                    : '请先选择下一道工序'
                }}
              </span>
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="品检备注">
          <el-input
            v-model="failInspNote"
            type="textarea"
            :rows="3"
            :maxlength="500"
            show-word-limit
            placeholder="不合格原因 / 返修要点（写入事件历史，工人领取时可见）"
          />
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          title="指定工序后零件回到「在生产货架上」状态，下一道工序与备注已写入事件历史；工人领取时可在卡片上看到备注。"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="failInspDialogVisible = false">取消</el-button>
        <el-button
          type="warning"
          :loading="failInspSubmitting"
          :disabled="!failInspProcessId || !failInspShelfId"
          @click="onFailInspectionConfirm"
          >确认指定工序</el-button
        >
      </template>
    </el-dialog>

    <!-- 取消 / 删除确认对话框 -->
    <el-dialog
      v-model="confirmVisible"
      :title="confirmTitle"
      :width="confirmDlg.width"
      :top="confirmDlg.top"
      :fullscreen="confirmDlg.fullscreen"
    >
      <div class="confirm-body">
        <p class="confirm-hint">{{ confirmHint }}</p>
        <el-form label-width="80px">
          <el-form-item label="流水号">
            <el-input
              v-model="confirmSerialNo"
              placeholder="请输入该零件的流水号以确认"
              clearable
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button
          :type="confirmAction === 'cancel' ? 'warning' : 'danger'"
          :loading="confirmSubmitting"
          :disabled="!confirmSerialNo.trim()"
          @click="onConfirmAction"
          >确认{{ confirmAction === 'cancel' ? '取消' : '删除' }}</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Clock, PriceTag } from '@element-plus/icons-vue';
import Barcode from '@/components/Barcode.vue';
import PartInfoCard from './components/PartInfoCard.vue';
import PartHistoryCard from './components/PartHistoryCard.vue';
import PartAssemblyLinkCard from './components/PartAssemblyLinkCard.vue';
import PartFilesTabsCard from './components/PartFilesTabsCard.vue';
import PartBatchMonitorCard from './components/PartBatchMonitorCard.vue';
import ProcessChainCard from './components/ProcessChainCard.vue';
import type { PartBatch } from '@/api/parts';
import { listShelves } from '@/api/shelves';
import type { Shelf } from '@/types/shelf';
import { listProcesses } from '@/api/process';
import type { Process } from '@/types/process';
import { useDialogSize } from '@/composables/useDialogSize';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import { useConfirm } from '@/composables/useConfirm';
import { usePermissions } from '@/composables/usePermissions';
import { usePartFileUpload } from '@/composables/usePartFileUpload';
import { usePartDetail } from './composables/usePartDetail';
import type { PartEditForm } from './composables/usePartDetail';
import { usePartFiles } from './composables/usePartFiles';
import { usePartCncGroups } from './composables/usePartCncGroups';
import { useProcessChain } from './composables/useProcessChain';

const route = useRoute();
const partId = ref<string>(String(route.params.id ?? ''));

// ============ composables ============
// 2026-09-17 PR-4：删 usePartQuote（外协报价下线，仅保留 /outsource/quote 入口）。
const detail = usePartDetail(partId);
const files = usePartFiles(partId);
const cnc = usePartCncGroups(partId);

// 从 composables 解构出来（业务函数 + 状态）
const {
  part,
  infoLoading,
  events,
  eventsLoading,
  editing,
  saving,
  form,
  assemblyDetail,
  assemblyLoading,
  batches,
  batchesLoading,
  canEditPart,
  canCancelPart,
  canDeletePart,
  canInspect,
  canReceiveFromOutsource,
  canManageDrawings,
  canManage3DModels,
  canManageCncFiles,
  canManageSetupSheet,
  canManageBatches,
  fetchPart,
  fetchEvents,
  fetchBatches,
  onStartEdit,
  onCancelEdit,
  onSave,
  onFailInspection,
  onReceiveFromOutsource,
  onCancelOrder,
  onDeletePart,
  onSplitBatch,
  onCancelBatch,
  statusLabel,
  statusTagType,
  statusLabelOf,
  eventLabel,
  eventTagType,
} = detail;

const { drawings, models3d, cadFiles, fetchDrawings, fetch3DModels, fetchCadFiles } = files;

// 2026-09-16 T3.5：三个 kind 各自的补传 composable（场景 B）。
// 复用同一 partId（雪花 ID 字符串），kind 是字面量。
// PartFilesTabsCard 期望 `apiUpload: (ownerId, file) => Promise<PartFileItem>` 签名，
// 而 usePartFileUpload.upload 仅接 file（owner 已在 composable 闭包里）→ 这里
// 适配成兼容签名。
const drawingUploadComp = usePartFileUpload({
  ownerPartId: partId,
  kind: 'DRAWING',
});
const model3dUploadComp = usePartFileUpload({
  ownerPartId: partId,
  kind: '3D_MODEL',
});
const cadUploadComp = usePartFileUpload({
  ownerPartId: partId,
  kind: 'CAD_2D',
});
const drawingUpload = (_ownerId: string, file: File) => drawingUploadComp.upload(file);
const model3dUpload = (_ownerId: string, file: File) => model3dUploadComp.upload(file);
const cadUpload = (_ownerId: string, file: File) => cadUploadComp.upload(file);

const {
  cncSetupGroups,
  cncLoading,
  fetchCncPrograms,
  formatBytes,
  onDownloadCnc,
  onDeleteCnc,
  onPairUpload,
  onReleaseToShelf,
  // 2026-08-25 T10p5：上传 staging 助手（含 ElMessage.warning 兜底），通过函数 prop 注入 PartFilesTabsCard。
  fileList,
} = cnc;

// PR-2 2026-09-13：PartInfoCard 用本地 reactive 副本做双向 v-model，
// 父级把子组件 emit('update:form') 的最新值合并回 usePartDetail 持有的 form。
// 这样 onSave() 读 form.x 拿到的就是子组件当前编辑的内容。
function onPartInfoFormChange(next: PartEditForm): void {
  Object.assign(form, next);
}

// ============ 选中批次（2026-09-17 PR-4：3 卡联动锚）============
// PartBatchMonitorCard 行选中 → onBatchSelect → 写入 selectedBatchId；
// PartHistoryCard 按 batch_id 过滤 / ProcessChainCard 高亮
// current_process_step_id 对应步骤。
const selectedBatchId = ref<string | null>(null);
function onBatchSelect(b: PartBatch | null): void {
  selectedBatchId.value = b?.id ?? null;
}

// ============ 工序链（2026-09-17 PR-4：useProcessChain 拉链）============
// batches / part 来自 usePartDetail；selectedBatchId 同步驱动 currentStepId。
const processChain = useProcessChain(
  partId,
  computed(() => part.value),
  computed(() => batches.value),
  selectedBatchId,
);
const currentStepId = computed<string | null>(() => processChain.currentStepId.value);

// 2026-09-17 PR-4：part.process_chain_id 变化时拉链（首次 part 加载 + 后续
// 工艺变更）。useProcessChain 内部已 watch partId 清空状态；这里只触发拉取。
// 2026-09-17 review 第 1 轮修复：chain 变化前先重置 selectedBatchId，避免旧批次 id
// 在 chain 未拉完前被 currentStepId 派生计算时引用到错误的 step。
watch(
  () => part.value?.process_chain_id,
  (id) => {
    if (id) {
      selectedBatchId.value = null;
      void processChain.fetchProcessChain();
    }
  },
);

// ============ 共享 shelves/processes 缓存（release / failInsp / receive 共用）============
const productionShelves = ref<Shelf[]>([]);
const processes = ref<Process[]>([]);
async function ensureShelvesProcesses(): Promise<void> {
  if (productionShelves.value.length === 0) {
    try {
      const resp = await listShelves({ zone: 'PRODUCTION', is_active: true, limit: 200 });
      productionShelves.value = resp.items;
    } catch {
      /* ignore */
    }
  }
  if (processes.value.length === 0) {
    try {
      const resp = await listProcesses({ limit: 200 });
      processes.value = resp.items;
    } catch {
      /* ignore */
    }
  }
}

// 2026-09-17 PR-4：ProcessChainCard 需要 { process_id → { code, name } } 字典。
// processes 由 ensureShelvesProcesses 缓存（failInsp / receive / 配对下发共用），
// 这里派生 O(1) 查找表，避免在 ProcessChainCard 内 v-for .find。
const processesLookup = computed<Record<string, { code: string; name: string }>>(() => {
  const map: Record<string, { code: string; name: string }> = {};
  for (const p of processes.value) {
    map[p.id] = { code: p.code, name: p.name };
  }
  return map;
});

// ============ 底部 dialog 状态（shell 局部维护）============
const failInspDlg = useDialogSize({ desktopWidth: 480 });
const receiveOutsourceDlg = useDialogSize({ desktopWidth: 560 });
const confirmDlg = useDialogSize({ desktopWidth: 420 });
const { dangerous: confirmDangerous } = useConfirm();

// 品检打回（指定工序）对话框
const failInspDialogVisible = ref(false);
const failInspProcessId = ref<string>('');
const failInspShelfId = ref<string>('');
const failInspNote = ref<string>('');
const failInspSubmitting = ref(false);
const {
  filteredShelves: failInspFilteredShelves,
  filteredProcesses: failInspFilteredProcesses,
  load: loadFailInspMap,
} = useShelfProcessFilter(
  computed(() => productionShelves.value),
  computed(() => processes.value),
  computed({
    get: () => failInspShelfId.value || null,
    set: (v) => {
      failInspShelfId.value = v ?? '';
    },
  }),
  computed({
    get: () => failInspProcessId.value || null,
    set: (v) => {
      failInspProcessId.value = v ?? '';
    },
  }),
);

async function openFailInspDialog() {
  failInspProcessId.value = '';
  failInspShelfId.value = '';
  failInspNote.value = '';
  await ensureShelvesProcesses();
  void loadFailInspMap();
  failInspDialogVisible.value = true;
}
function onFailInspDialogClosed() {
  failInspProcessId.value = '';
  failInspShelfId.value = '';
  failInspNote.value = '';
}
async function onFailInspectionConfirm() {
  if (!failInspProcessId.value || !failInspShelfId.value) return;
  failInspSubmitting.value = true;
  try {
    const ok = await onFailInspection({
      shelfId: failInspShelfId.value,
      processId: failInspProcessId.value,
      note: failInspNote.value.trim() || null,
    });
    if (ok) failInspDialogVisible.value = false;
  } finally {
    failInspSubmitting.value = false;
  }
}

// 外协回收对话框
const receiveOutsourceDialogVisible = ref(false);
const receiveShelfId = ref<string>('');
const receiveProcessId = ref<string>('');
const receiveSubmitting = ref(false);
const inhouseProcesses = computed(() => processes.value.filter((p) => p.category === 'INHOUSE'));
const {
  filteredShelves: receiveFilteredShelves,
  filteredProcesses: receiveFilteredProcesses,
  load: loadReceiveMap,
} = useShelfProcessFilter(
  computed(() => productionShelves.value),
  inhouseProcesses,
  computed({
    get: () => receiveShelfId.value || null,
    set: (v) => {
      receiveShelfId.value = v ?? '';
    },
  }),
  computed({
    get: () => receiveProcessId.value || null,
    set: (v) => {
      receiveProcessId.value = v ?? '';
    },
  }),
);

async function openReceiveOutsourceDialog() {
  receiveShelfId.value = '';
  receiveProcessId.value = '';
  await ensureShelvesProcesses();
  void loadReceiveMap();
  receiveOutsourceDialogVisible.value = true;
}
function onReceiveOutsourceDialogClosed() {
  receiveShelfId.value = '';
  receiveProcessId.value = '';
}
async function onReceiveConfirm() {
  if (!receiveShelfId.value || !receiveProcessId.value) return;
  receiveSubmitting.value = true;
  try {
    const ok = await onReceiveFromOutsource({
      shelfId: receiveShelfId.value,
      processId: receiveProcessId.value,
    });
    if (ok) receiveOutsourceDialogVisible.value = false;
  } finally {
    receiveSubmitting.value = false;
  }
}

// 取消订单 / 删除（共用 confirm dialog）
const confirmVisible = ref(false);
const confirmAction = ref<'cancel' | 'delete'>('cancel');
const confirmSerialNo = ref('');
const confirmSubmitting = ref(false);
const confirmTitle = computed(() => (confirmAction.value === 'cancel' ? '取消订单' : '删除零件'));
const confirmHint = computed(() => {
  const base =
    confirmAction.value === 'cancel'
      ? '取消后订单将变为 CANCELLED 状态，流水号将被释放。'
      : '删除后将软删除该零件记录。';
  return `${base}\n请输入该零件的流水号以确认操作。`;
});

function openConfirmForCancel() {
  confirmAction.value = 'cancel';
  confirmSerialNo.value = '';
  confirmVisible.value = true;
}
function openConfirmForDelete() {
  confirmAction.value = 'delete';
  confirmSerialNo.value = '';
  confirmVisible.value = true;
}
async function onConfirmAction() {
  const expected = part.value?.serial_no;
  if (!expected) {
    ElMessage.error('该零件无流水号，无法执行此操作');
    return;
  }
  if (confirmSerialNo.value.trim() !== expected) {
    ElMessage.error('流水号不匹配，请重新输入');
    return;
  }
  confirmSubmitting.value = true;
  try {
    if (confirmAction.value === 'cancel') {
      const ok = await onCancelOrder();
      if (ok) confirmVisible.value = false;
    } else {
      // delete 成功后 onDeletePart 内 router.push('/parts')，不再需要 close
      await onDeletePart();
    }
  } finally {
    confirmSubmitting.value = false;
  }
}

// ============ 品检通过（shell 包一层 passSubmitting loading）============
const passSubmitting = ref(false);
async function onPassInspection() {
  passSubmitting.value = true;
  try {
    await detail.onPassInspection();
  } finally {
    passSubmitting.value = false;
  }
}

// ============ 拆 / 取消 批次（PartBatchMonitorCard 触发）============
// 2026-08-25 T10p5：emit payload 改为 { batch, quantity, resolve }，
// shell 等 API 完成再调 resolve，把 dialog 关闭时机下沉到 API 成功之后。
async function handleSplitBatch(payload: {
  batch: PartBatch;
  quantity: number;
  resolve: (ok: boolean) => void;
}) {
  const result = await onSplitBatch(payload.batch, payload.quantity);
  payload.resolve(result !== null);
  void fetchBatches();
}
async function handleCancelBatch(batch: PartBatch) {
  if (
    !(await confirmDangerous(
      '取消批次',
      `确认取消批次 ${batch.batch_label}（${batch.quantity} 件，${statusLabelOf(batch.status)}）？` +
        '该批次数量将从在制中移除，不可恢复。',
      { type: 'warning', confirmText: '确认取消', cancelText: '返回' },
    ))
  )
    return;
  await onCancelBatch(batch);
  void fetchBatches();
}

// ============ 配对上传 / 下发（PartFilesTabsCard → PartCncCard 触发）============
// 2026-08-25 T10p5：emit payload 改为 { gcodes, setup, resolve }，
// shell 等 API 完成再调 resolve：成功才关 dialog + reset submitting。
async function handlePairUpload(payload: {
  gcodes: File[];
  setup: File;
  resolve: (ok: boolean) => void;
}) {
  const ok = await onPairUpload(payload.gcodes, payload.setup);
  payload.resolve(ok);
}
async function handleRelease(payload: {
  shelfId: string;
  processId: string;
  resolve: (ok: boolean) => void;
}) {
  const ok = await onReleaseToShelf(payload.shelfId, payload.processId);
  if (ok) {
    await fetchPart();
    void fetchEvents();
  }
  payload.resolve(ok);
}

// ============ 零件文件 tabs 刷新（PartFilesTabsCard 触发）============
// 2026-09-17 PR-4：tabs 卡把三个 FileListCard 的 refresh 收敛成一个 emit('refresh', kind)。
// 这里按 kind 转发回 usePartFiles 对应的 fetch*。
async function onFileTabRefresh(kind: 'DRAWING' | '3D_MODEL' | 'CAD_2D'): Promise<void> {
  if (kind === 'DRAWING') await fetchDrawings();
  else if (kind === '3D_MODEL') await fetch3DModels();
  else await fetchCadFiles();
}

// ============ 切换 partId 时重置 ============
const { isInspector } = usePermissions();
// PartFilesTabsCard 需要 !isInspector 决定 DRAWING tab 的「打印图纸」按钮可见性。
const isInspectorRaw = computed(() => isInspector.value);

watch(
  () => route.params.id,
  async (id) => {
    const s = String(id ?? '');
    if (!s) return;
    partId.value = s;
    // 2026-09-17 PR-4：清空选中批次（useProcessChain 内部已 watch partId 清空
    // selectedBatchId，但切 partId 时立刻置空让 PartHistoryCard 立刻恢复展示
    // 全部事件，避免闪旧批次的过滤态）。
    selectedBatchId.value = null;
    drawings.value = [];
    models3d.value = [];
    cadFiles.value = [];
    await fetchPart();
    void fetchEvents();
    void fetchBatches();
    void fetchDrawings();
    void fetch3DModels();
    void fetchCadFiles();
    void fetchCncPrograms();
  },
);

onMounted(() => {
  void fetchPart();
  void fetchEvents();
  void fetchBatches();
  void fetchDrawings();
  void fetch3DModels();
  void fetchCadFiles();
  void fetchCncPrograms();
});
</script>

<style lang="scss" scoped>
.part-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.barcode-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
    display: flex;
    justify-content: center;
  }
  .serial-label {
    font-weight: 600;
    color: var(--primary-color);
  }
  .barcode-wrap {
    background: #fff;
    padding: 8px 12px;
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}
.muted {
  color: var(--text-secondary);
}
.opt-tag {
  margin-left: 6px;
}

.bottom-actions {
  .action-row {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
}

.confirm-body {
  .confirm-hint {
    white-space: pre-line;
    color: var(--text-secondary);
    font-size: 13px;
    margin-bottom: 16px;
  }
}

// 2026-09-17 PR-4：时间线卡（PartBatchMonitorCard + PartHistoryCard + ProcessChainCard
// 三列联动）。子卡自带 :deep(.el-card__body) padding，这里只约束容器 + 三列等宽。
// 子卡用 flex: 1 1 0 + min-width: 0 允许内部 el-table / el-timeline 自然收缩；
// overflow-y: auto 避免批次多时整体撑爆页面。
.timeline-card {
  :deep(.el-card__body) {
    padding: 12px 16px;
  }
  .timeline-row {
    display: flex;
    gap: 12px;
    height: 60vh;
    overflow-y: auto;
    // 子卡片（PartBatchMonitorCard / PartHistoryCard / ProcessChainCard）
    // 各占 1 / 3 宽度；min-width: 0 防 flex 子项最小内容宽度撑爆容器。
    :deep(.el-card) {
      flex: 1 1 0;
      min-width: 0;
      overflow-y: auto;
    }
  }
}
</style>
