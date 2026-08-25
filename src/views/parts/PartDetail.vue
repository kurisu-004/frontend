<!--
  PartDetail.vue

  /parts/:id  零件详情页（装配壳）。
  - 9 张卡由 7 个子组件 + 3 个 FileListCard 组成
  - 底部操作（品检通过 / 指定工序 / 外协回收 / 取消订单 / 删除）留在 shell，
    因为它们跨多张卡状态；dialog 状态由 shell 局部维护，业务函数调 usePartDetail
  - barcode 小卡：serial_no 存在时显示
  - 2026-08-25 frontend-overall-refactor：从 2355 行单体拆为装配壳
-->
<template>
  <div class="part-detail" v-loading="infoLoading">
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
    />

    <!-- 历史记录 -->
    <PartHistoryCard
      :part-id="partId"
      :events="events"
      :events-loading="eventsLoading"
      :status-label-of="statusLabelOf"
      :event-label="eventLabel"
      :event-tag-type="eventTagType"
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

    <!-- 所属送货单 -->
    <PartDeliveryNoteLinkCard
      v-if="part && part.delivery_note_id != null"
      :part="part"
    />

    <!-- 所属装配件 -->
    <PartAssemblyLinkCard
      v-if="part && part.assembly_id != null"
      :part="part"
      :assembly-detail="assemblyDetail"
      :assembly-loading="assemblyLoading"
    />

    <!-- 图纸 / 3D 模型 / CAD 源文件 -->
    <FileListCard
      :files="drawings"
      owner-type="part"
      :owner-id="partId"
      kind="DRAWING"
      :show-upload="canManageDrawings"
      :show-delete="canManageDrawings"
      :show-print="!isInspectorRaw"
      :api-upload="uploadPartDrawing"
      @refresh="fetchDrawings"
    />
    <FileListCard
      :files="models3d"
      owner-type="part"
      :owner-id="partId"
      kind="3D_MODEL"
      :show-upload="canManage3DModels"
      :show-delete="canManage3DModels"
      :api-upload="uploadPart3DModel"
      @refresh="fetch3DModels"
    />
    <FileListCard
      :files="cadFiles"
      owner-type="part"
      :owner-id="partId"
      kind="CAD_2D"
      :show-upload="canManageDrawings"
      :show-delete="canManageDrawings"
      :api-upload="uploadPartCadFile"
      @refresh="fetchCadFiles"
    />

    <!-- CNC 文件 -->
    <PartCncCard
      :part-id="partId"
      :part-status="part?.status ?? 'PENDING'"
      :cnc-setup-groups="cncSetupGroups"
      :cnc-loading="cncLoading"
      :can-manage-cnc-files="canManageCncFiles"
      :can-manage-setup-sheet="canManageSetupSheet"
      :production-shelves="productionShelves"
      :processes="processes"
      :format-bytes="formatBytes"
      :on-download-cnc="onDownloadCnc"
      :on-delete-cnc="onDeleteCnc"
      @fetch="fetchCncPrograms"
      @pair-upload="handlePairUpload"
      @release="handleRelease"
    />

    <!-- 外协报价 -->
    <PartQuoteCard
      v-if="canViewQuotes"
      :part-id="partId"
      :part-name="part?.name"
      :part-status="part?.status ?? 'PENDING'"
      :quotes="quotes"
      :quotes-loading="quotesLoading"
      :can-create-quote-base="canCreateQuoteBase"
      :quote-rules="quoteRules"
      :load-quote-create-data="loadQuoteCreateData"
      @fetch="fetchQuotes"
      @create="handleCreateQuote"
    />

    <!-- 批次监控 -->
    <PartBatchMonitorCard
      :part-id="partId"
      :batches="batches"
      :batches-loading="batchesLoading"
      :can-manage-batches="canManageBatches"
      :status-tag-type="statusTagType"
      :status-label-of="statusLabelOf"
      @fetch="fetchBatches"
      @split="handleSplitBatch"
      @cancel-batch="handleCancelBatch"
    />

    <!-- 底部操作：取消订单 / 删除 / 品检 / 外协回收（按角色门控） -->
    <el-card shadow="never" class="bottom-actions" v-if="part">
      <div class="action-row">
        <!-- 品检相关：仅 INSPECTION 状态可见 -->
        <template v-if="canInspect && part.status === 'INSPECTION'">
          <el-button
            type="success"
            :loading="passSubmitting"
            @click="onPassInspection"
          >品检通过</el-button>
          <el-button
            type="warning"
            @click="openFailInspDialog"
          >指定工序</el-button>
        </template>
        <!-- 外协回收：OUTSOURCE 状态可见（MANAGER + CLERK） -->
        <el-button
          v-if="canReceiveFromOutsource && part.status === 'OUTSOURCE'"
          type="success"
          @click="openReceiveOutsourceDialog"
        >外协回收</el-button>
        <el-button
          v-if="canCancelPart && part.status !== 'CANCELLED' && part.status !== 'COMPLETED'"
          type="warning"
          @click="openConfirmForCancel"
        >取消订单</el-button>
        <el-button
          v-if="canDeletePart"
          type="danger"
          @click="openConfirmForDelete"
        >删除</el-button>
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
        <el-form-item label="目标生产货架" required :for="''">
          <el-radio-group
            v-model="receiveShelfId"
            aria-label="目标生产货架"
            style="display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto;"
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
        <el-form-item label="下一道工序" required :for="''">
          <el-radio-group
            v-model="receiveProcessId"
            aria-label="下一道工序"
            style="display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto;"
          >
            <el-radio
              v-for="p in receiveFilteredProcesses"
              :key="p.id"
              :value="String(p.id)"
            >
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
        >确认回收</el-button>
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
              <el-tag v-if="p.category === 'OUTSOURCE'" type="warning" size="small" effect="plain" class="opt-tag">
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
        >确认指定工序</el-button>
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
        >确认{{ confirmAction === 'cancel' ? '取消' : '删除' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { PriceTag } from '@element-plus/icons-vue'
import FileListCard from '@/components/FileListCard.vue'
import Barcode from '@/components/Barcode.vue'
import PartInfoCard from './components/PartInfoCard.vue'
import PartHistoryCard from './components/PartHistoryCard.vue'
import PartDeliveryNoteLinkCard from './components/PartDeliveryNoteLinkCard.vue'
import PartAssemblyLinkCard from './components/PartAssemblyLinkCard.vue'
import PartCncCard from './components/PartCncCard.vue'
import PartQuoteCard from './components/PartQuoteCard.vue'
import PartBatchMonitorCard from './components/PartBatchMonitorCard.vue'
import type { PartBatch } from '@/api/parts'
import { uploadPart3DModel, uploadPartCadFile, uploadPartDrawing } from '@/api/assembly'
import { listShelves } from '@/api/shelves'
import type { Shelf } from '@/types/shelf'
import { listProcesses } from '@/api/process'
import type { Process } from '@/types/process'
import { useDialogSize } from '@/composables/useDialogSize'
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter'
import { useConfirm } from '@/composables/useConfirm'
import { usePermissions } from '@/composables/usePermissions'
import { usePartDetail } from './composables/usePartDetail'
import { usePartFiles } from './composables/usePartFiles'
import { usePartCncGroups } from './composables/usePartCncGroups'
import { usePartQuote } from './composables/usePartQuote'

const route = useRoute()
const partId = ref<string>(String(route.params.id ?? ''))

// ============ 4 个 composables ============
const detail = usePartDetail(partId)
const files = usePartFiles(partId)
const cnc = usePartCncGroups(partId)
const quote = usePartQuote(partId, computed(() => detail.part.value?.name))

// 从 composables 解构出来（业务函数 + 状态）
const {
  part, infoLoading, events, eventsLoading,
  editing, saving, form,
  assemblyDetail, assemblyLoading,
  batches, batchesLoading,
  canEditPart, canCancelPart, canDeletePart, canInspect, canReceiveFromOutsource,
  canManageDrawings, canManage3DModels, canManageCncFiles, canManageSetupSheet, canManageBatches,
  fetchPart, fetchEvents, fetchAssembly, fetchBatches,
  onStartEdit, onCancelEdit, onSave,
  onFailInspection, onReceiveFromOutsource,
  onCancelOrder, onDeletePart,
  onSplitBatch, onCancelBatch,
  statusLabel, statusTagType, statusLabelOf, eventLabel, eventTagType,
} = detail

const {
  drawings, models3d, cadFiles,
  fetchDrawings, fetch3DModels, fetchCadFiles,
} = files

const {
  cncSetupGroups, cncLoading,
  fetchCncPrograms, formatBytes, onDownloadCnc, onDeleteCnc,
  onPairUpload, onReleaseToShelf,
} = cnc

const {
  quotes, quotesLoading, canViewQuotes, canCreateQuote: canCreateQuoteBase,
  fetchQuotes, quoteRules, loadQuoteCreateData, onCreateQuote,
} = quote

// ============ 批次 ============
// batches / batchesLoading / fetchBatches 来自 usePartDetail（PartBatchMonitorCard 渲染）

// ============ 共享 shelves/processes 缓存（release / failInsp / receive 共用）============
const productionShelves = ref<Shelf[]>([])
const processes = ref<Process[]>([])
async function ensureShelvesProcesses(): Promise<void> {
  if (productionShelves.value.length === 0) {
    try {
      const resp = await listShelves({ zone: 'PRODUCTION', is_active: true, limit: 200 })
      productionShelves.value = resp.items
    } catch { /* ignore */ }
  }
  if (processes.value.length === 0) {
    try {
      const resp = await listProcesses({ limit: 200 })
      processes.value = resp.items
    } catch { /* ignore */ }
  }
}

// ============ 底部 dialog 状态（shell 局部维护）============
const failInspDlg = useDialogSize({ desktopWidth: 480 })
const receiveOutsourceDlg = useDialogSize({ desktopWidth: 560 })
const confirmDlg = useDialogSize({ desktopWidth: 420 })
const { dangerous: confirmDangerous } = useConfirm()

// 品检打回（指定工序）对话框
const failInspDialogVisible = ref(false)
const failInspProcessId = ref<string>('')
const failInspShelfId = ref<string>('')
const failInspNote = ref<string>('')
const failInspSubmitting = ref(false)
const {
  filteredShelves: failInspFilteredShelves,
  filteredProcesses: failInspFilteredProcesses,
  load: loadFailInspMap,
} = useShelfProcessFilter(
  computed(() => productionShelves.value),
  computed(() => processes.value),
  computed({
    get: () => failInspShelfId.value || null,
    set: (v) => { failInspShelfId.value = v ?? '' },
  }),
  computed({
    get: () => failInspProcessId.value || null,
    set: (v) => { failInspProcessId.value = v ?? '' },
  }),
)

async function openFailInspDialog() {
  failInspProcessId.value = ''
  failInspShelfId.value = ''
  failInspNote.value = ''
  await ensureShelvesProcesses()
  void loadFailInspMap()
  failInspDialogVisible.value = true
}
function onFailInspDialogClosed() {
  failInspProcessId.value = ''
  failInspShelfId.value = ''
  failInspNote.value = ''
}
async function onFailInspectionConfirm() {
  if (!failInspProcessId.value || !failInspShelfId.value) return
  failInspSubmitting.value = true
  try {
    const ok = await onFailInspection({
      shelfId: failInspShelfId.value,
      processId: failInspProcessId.value,
      note: failInspNote.value.trim() || null,
    })
    if (ok) failInspDialogVisible.value = false
  } finally {
    failInspSubmitting.value = false
  }
}

// 外协回收对话框
const receiveOutsourceDialogVisible = ref(false)
const receiveShelfId = ref<string>('')
const receiveProcessId = ref<string>('')
const receiveSubmitting = ref(false)
const inhouseProcesses = computed(() =>
  processes.value.filter((p) => p.category === 'INHOUSE'),
)
const {
  filteredShelves: receiveFilteredShelves,
  filteredProcesses: receiveFilteredProcesses,
  load: loadReceiveMap,
} = useShelfProcessFilter(
  computed(() => productionShelves.value),
  inhouseProcesses,
  computed({
    get: () => receiveShelfId.value || null,
    set: (v) => { receiveShelfId.value = v ?? '' },
  }),
  computed({
    get: () => receiveProcessId.value || null,
    set: (v) => { receiveProcessId.value = v ?? '' },
  }),
)

async function openReceiveOutsourceDialog() {
  receiveShelfId.value = ''
  receiveProcessId.value = ''
  await ensureShelvesProcesses()
  void loadReceiveMap()
  receiveOutsourceDialogVisible.value = true
}
function onReceiveOutsourceDialogClosed() {
  receiveShelfId.value = ''
  receiveProcessId.value = ''
}
async function onReceiveConfirm() {
  if (!receiveShelfId.value || !receiveProcessId.value) return
  receiveSubmitting.value = true
  try {
    const ok = await onReceiveFromOutsource({
      shelfId: receiveShelfId.value,
      processId: receiveProcessId.value,
    })
    if (ok) receiveOutsourceDialogVisible.value = false
  } finally {
    receiveSubmitting.value = false
  }
}

// 取消订单 / 删除（共用 confirm dialog）
const confirmVisible = ref(false)
const confirmAction = ref<'cancel' | 'delete'>('cancel')
const confirmSerialNo = ref('')
const confirmSubmitting = ref(false)
const confirmTitle = computed(() =>
  confirmAction.value === 'cancel' ? '取消订单' : '删除零件'
)
const confirmHint = computed(() => {
  const base = confirmAction.value === 'cancel'
    ? '取消后订单将变为 CANCELLED 状态，流水号将被释放。'
    : '删除后将软删除该零件记录。'
  return `${base}\n请输入该零件的流水号以确认操作。`
})

function openConfirmForCancel() {
  confirmAction.value = 'cancel'
  confirmSerialNo.value = ''
  confirmVisible.value = true
}
function openConfirmForDelete() {
  confirmAction.value = 'delete'
  confirmSerialNo.value = ''
  confirmVisible.value = true
}
async function onConfirmAction() {
  const expected = part.value?.serial_no
  if (!expected) {
    ElMessage.error('该零件无流水号，无法执行此操作')
    return
  }
  if (confirmSerialNo.value.trim() !== expected) {
    ElMessage.error('流水号不匹配，请重新输入')
    return
  }
  confirmSubmitting.value = true
  try {
    if (confirmAction.value === 'cancel') {
      const ok = await onCancelOrder()
      if (ok) confirmVisible.value = false
    } else {
      // delete 成功后 onDeletePart 内 router.push('/parts')，不再需要 close
      await onDeletePart()
    }
  } finally {
    confirmSubmitting.value = false
  }
}

// ============ 品检通过（shell 包一层 passSubmitting loading）============
const passSubmitting = ref(false)
async function onPassInspection() {
  passSubmitting.value = true
  try {
    await detail.onPassInspection()
  } finally {
    passSubmitting.value = false
  }
}

// ============ 拆 / 取消 批次（PartBatchMonitorCard 触发）============
async function handleSplitBatch(batch: PartBatch, quantity: number) {
  await onSplitBatch(batch, quantity)
  void fetchBatches()
}
async function handleCancelBatch(batch: PartBatch) {
  if (!await confirmDangerous(
    '取消批次',
    `确认取消批次 ${batch.batch_label}（${batch.quantity} 件，${statusLabelOf(batch.status)}）？`
      + '该批次数量将从在制中移除，不可恢复。',
    { type: 'warning', confirmText: '确认取消', cancelText: '返回' },
  )) return
  await onCancelBatch(batch)
  void fetchBatches()
}

// ============ 配对上传 / 下发（PartCncCard 触发）============
async function handlePairUpload(gcodes: File[], setup: File) {
  await onPairUpload(gcodes, setup)
}
async function handleRelease(shelfId: string, processId: string) {
  const ok = await onReleaseToShelf(shelfId, processId)
  if (ok) {
    await fetchPart()
    void fetchEvents()
  }
}

// ============ 报价新建（PartQuoteCard 触发）============
async function handleCreateQuote(form: { outsource_company_id: string; process_id: string; price: string; note: string }) {
  await onCreateQuote(form)
  void fetchEvents()  // 同步刷新历史（QUOTE_CREATED 事件）
}

// ============ 切换 partId 时重置 ============
const { isInspector } = usePermissions()
// FileListCard 需要 !isInspector 决定 show-print（直接用 raw ref）
const isInspectorRaw = computed(() => isInspector.value)

watch(
  () => route.params.id,
  async (id) => {
    const s = String(id ?? '')
    if (!s) return
    partId.value = s
    quotes.value = []
    drawings.value = []
    models3d.value = []
    cadFiles.value = []
    await fetchPart()
    void fetchEvents()
    void fetchBatches()
    void fetchQuotes()
    void fetchDrawings()
    void fetch3DModels()
    void fetchCadFiles()
    void fetchCncPrograms()
  },
)

onMounted(() => {
  void fetchPart()
  void fetchEvents()
  void fetchBatches()
  void fetchQuotes()
  void fetchDrawings()
  void fetch3DModels()
  void fetchCadFiles()
  void fetchCncPrograms()
})
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
</style>
