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
  - 2026-09-17 UI 调整第 2 轮：
    - 删除顶部独立的 PartHistoryCard（重复，搬到时间线卡内）。
    - 时间线卡去 header；批次监控移到历史 + 工序链下方（同行撑满）。
    - 零件文件卡 body 不再嵌套 card，按钮移到最外层 footer。
  - 底部操作（品检 / 外协回收 / 取消 / 删除）留在 shell，因为它们跨多张卡
    状态；dialog 状态由 shell 局部维护，业务函数调 usePartDetail。
  - 2026-09-15 Phase 5：业务全切 v2（api 基址 `/api/v2`）。品检通过走
    `POST /parts/{id}/to-ship`（v2 必填 batch_id + version），指定工序走
    `POST /parts/{id}/fail-inspection`。
  - 工艺链：part.process_chain_id 改走 useProcessChain 拉链（PR-3）。
  - 2026-10-10 数据层分层：本页只做「shell 接线」，取数在
    `composables/usePartDetailQuery.ts` + `usePartEventsQuery.ts`（+ 共享的
    `usePartBatchesQuery`），7 个写操作在 `composables/usePartDetailActions.ts`，
    权限 / 派生 / 行内编辑态在 `composables/usePartDetail.ts`。相应地
    onMounted 与 route watcher 里不再手写 fetch（reactive queryKey 自己驱动，
    手写会造成双 fetch），取消 / 删除后的跳转仍在本页（composable 不 import
    vue-router）。
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
        <BarcodeView :value="part.serial_no" format="CODE39" :height="80" :width="2" />
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
      :drawings="drawings"
      :models3d="models3d"
      :cad-files="cadFiles"
      :can-manage-drawings="canManageDrawings"
      :can-manage-3-d-models="canManage3DModels"
      :can-manage-cnc-files="canManageCncFiles"
      :can-manage-setup-sheet="canManageSetupSheet"
      :drawing-upload="drawingUpload"
      :model3d-upload="model3dUpload"
      :cad-upload="cadUpload"
      :cnc-setup-groups="cncSetupGroups"
      :cnc-loading="cncLoading"
      :format-bytes="formatBytes"
      :file-list="fileList"
      :on-download-cnc="onDownloadCnc"
      :on-delete-cnc="onDeleteCnc"
      @refresh="onFileTabRefresh"
      @fetch="fetchCncPrograms"
      @pairUpload="handlePairUpload"
    />

    <!--
      时间线卡（2026-09-17 PR-4）：批次列表 + 历史 + 工序链 三列联动。
      - PartBatchMonitorCard 行选中 → onBatchSelect → 写入 selectedBatchId
      - selectedBatchId 同步驱动：PartHistoryCard 过滤 / ProcessChainCard
        高亮 current_process_step_id 对应步骤
      - 无人点过时由 useDefaultBatchSelection 兜底选中（优先带工序链定位的批次）
      - 2026-09-17 UI 调整第 2 轮：去掉外层 header；批次监控移到历史 +
        工序链下方（同行撑满），避免两列等高造成批次表区域浪费。
    -->
    <el-card shadow="never" class="timeline-card">
      <div class="timeline-top">
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
          :selected-batch-id="selectedBatchId"
          :loading="processChain.loading.value"
          :processes-lookup="processesLookup"
        />
      </div>
      <div class="timeline-bottom">
        <PartBatchMonitorCard
          :part-id="partId"
          :batches="batches"
          :batches-loading="batchesLoading"
          :can-manage-batches="canManageBatches"
          :status-tag-type="statusTagType"
          :status-label-of="statusLabelOf"
          :selected-batch-id="selectedBatchId"
          :wrap-card="false"
          @fetch="fetchBatches"
          @split="handleSplitBatch"
          @cancelBatch="handleCancelBatch"
          @select="onBatchSelect"
        />
      </div>
    </el-card>

    <!-- 底部操作：取消订单 / 删除 / 品检（按角色 + 批次状态门控） -->
    <el-card v-if="part" shadow="never" class="bottom-actions">
      <div class="action-row">
        <!--
          品检相关：⚠️ 判据是**批次**而非 `part.status`。
          `t_part.status` 是 min-progress 派生列（后端 `rollup_part_derived`），同工单只要
          还有任一批次进度更靠前，整单就派生成那个更早的状态 ⇒ 多批次工单上会出现
          「批次确实是 INSPECTION、`part.status` 却是 IN_PROCESS / PENDING」，两个按钮
          整排消失，那个批次永远动不了。后端
          `prod/batch/service/transition_core.rs::to_ship_core` 对同一处有专门警告。
          判据统一走派生出的 `inspectionBatch`，两个按钮也就必然打同一个批次。
        -->
        <template v-if="canInspect && inspectionBatch">
          <span class="inspection-anchor">
            目标批次
            <span class="mono">{{ inspectionBatch.batch_label }}</span>
            （{{ inspectionBatch.quantity }} 件）
          </span>
          <el-button type="success" :loading="passSubmitting" @click="onPassInspection"
            >品检通过</el-button
          >
          <el-button type="warning" @click="openFailInspDialog">指定工序</el-button>
        </template>
        <el-button
          v-if="canCancelPart && part.status !== 'CANCELLED' && part.status !== 'COMPLETED'"
          type="warning"
          @click="openConfirmForCancel"
          >取消订单</el-button
        >
        <el-button v-if="canDeletePart" type="danger" @click="openConfirmForDelete">删除</el-button>
      </div>
    </el-card>

    <!-- 指定工序对话框（PartDetail 用）—— 选下一道工序；可选品检备注 -->
    <el-dialog
      v-model="failInspDialogVisible"
      title="指定工序 — 选择下一道工序"
      :width="failInspDlg.width"
      :top="failInspDlg.top"
      :fullscreen="failInspDlg.fullscreen"
      :close-on-click-modal="false"
      @closed="onFailInspDialogClosed"
    >
      <el-form label-width="96px">
        <el-form-item label="目标批次">
          <span class="mono">{{ inspectionBatch?.batch_label ?? '—' }}</span>
          <span v-if="inspectionBatch" class="muted">
            （{{ inspectionBatch.quantity }} 件，当前状态：{{
              statusLabelOf(inspectionBatch.status)
            }}）
          </span>
        </el-form-item>
        <el-form-item label="下一道工序" required>
          <el-select
            v-model="failInspProcessId"
            placeholder="请先选择下一道工序"
            filterable
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="p in processes"
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
          title="指定工序后零件回到「在生产货架上」状态（目标货架由系统按负载自动选择），下一道工序与备注已写入事件历史；工人领取时可在卡片上看到备注。"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="failInspDialogVisible = false">取消</el-button>
        <el-button
          type="warning"
          :loading="failInspSubmitting"
          :disabled="!failInspProcessId"
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

    <!--
      2026-09-29 修复：dev-only 调试面板（仅 import.meta.env.DEV 时渲染）。
      用户报告「PartDetail 详情页有 /assemblies/{part_id} 可疑请求」，实际
      URL 是 /parts/{part_id}/assembly（视觉混淆），调试面板把端点路径 +
      当前 part.assembly_id + 装配件详情加载状态都列出来，QA 一眼对照。
      生产构建 import.meta.env.DEV = false → 自动消失，无 CSS 体积代价。
    -->
    <el-card v-if="isDev" shadow="never" class="debug-card" style="margin-top: 12px">
      <template #header>调试面板（仅 dev）</template>
      <div>端点：GET /api/v2/parts/{{ partId }}/assembly</div>
      <div>当前 part.assembly_id：{{ part?.assembly_id ?? 'null' }}</div>
      <div>装配件详情：{{ assemblyDetail ? '已加载' : '未加载' }}</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { PriceTag } from '@element-plus/icons-vue';
import { useQueryClient } from '@tanstack/vue-query';
import PartInfoCard from './components/PartInfoCard.vue';
import BarcodeView from './components/BarcodeView.vue';
import PartHistoryCard from './components/PartHistoryCard.vue';
import PartAssemblyLinkCard from './components/PartAssemblyLinkCard.vue';
import PartFilesTabsCard from './components/PartFilesTabsCard.vue';
import PartBatchMonitorCard from './components/PartBatchMonitorCard.vue';
import ProcessChainCard from './components/ProcessChainCard.vue';
import type { PartBatch } from '@/api/parts';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import type { Process } from '@/types/process';
import { useDialogSize } from '@/composables/useDialogSize';
import { useConfirm } from '@/composables/useConfirm';
import { usePartFileUpload } from '@/composables/usePartFileUpload';
// 2026-09-29 迁移：usePartFiles 三并发已迁到 usePartFilesListQuery 单调用，
// usePartFiles.ts 同步删除。这里用 reactive params 自动驱动 useQuery，
// 切 part / 上传 / 删除完成后调 invalidatePartFilesListQuery 失效缓存。
import {
  usePartFilesListQuery,
  invalidatePartFilesListQuery,
} from '@/composables/queries/usePartFilesListQuery';
import { usePartDetail } from './composables/usePartDetail';
import type { PartEditForm } from './composables/usePartDetail';
import { usePartDetailActions } from './composables/usePartDetailActions';
import { isPartDetailActive } from './composables/partDetailActive';
import { usePartCncGroups } from './composables/usePartCncGroups';
import { useProcessChain } from './composables/useProcessChain';
import { useDefaultBatchSelection } from './composables/useDefaultBatchSelection';

// 2026-09-29 修复：Vue SFC template expression 默认 sourceType=script，不接受
// import.meta。dev 阶段定义 isDev 常量供模板 v-if 引用，避免
// [plugin:vite:vue] Error parsing JavaScript expression: import.meta may appear
// only with 'sourceType: "module"' (1:1) 报错。
const isDev = import.meta.env.DEV;

const route = useRoute();
const router = useRouter();
const partId = ref<string>(String(route.params.id ?? ''));

/**
 * 本页是否仍是当前路由（keep-alive 缓存页必需）。
 *
 * `useRoute()` 注入的是 vue-router 的**全局** currentRoute，不是本组件挂载那一刻的
 * 地址快照；本页被 keep-alive 缓存后（路由名 `PartDetail` = 组件文件名，MainLayout 的
 * `<keep-alive :include="tags.cachedViewNames">` 按名字匹配），用户切到别的页面时全局
 * 路由照样变。它同时喂给两处，必须共用同一个判据函数
 * （`composables/partDetailActive.ts`，别在两个地方各写一遍 `route.name !== ...`）：
 *   ① 下面 route watcher 的守卫 —— 否则 partId 会被改成别的页面的 id；
 *   ② 两条 query hook 的 `enabled` 闸门 —— 否则 reactive queryKey 跟着全局路由变，
 *      自动去拉「别的页面的零件」（比 404 更坏：那个 id 若恰好有效，本页会静默渲染成
 *      另一个工单）。
 */
const isActive = computed(() => isPartDetailActive(route.name));

// ============ composables ============
// 2026-09-17 PR-4：删 usePartQuote（外协报价下线，仅保留 /outsource/quote 入口）。
const detail = usePartDetail(partId, isActive);
const cnc = usePartCncGroups(partId);

// 2026-09-29 迁移：usePartFilesListQuery 单调用替代原 usePartFiles 三并发。
// reactive params 让 partId 变化自动 refetch；upload/delete 后由
// invalidatePartFilesListQuery 精确失效。
const qc = useQueryClient();
const partFilesQuery = usePartFilesListQuery(() => partId.value);
const partFiles = computed(() => partFilesQuery.data.value?.items ?? []);
// 2026-09-29：drawings / models3d / cadFiles 改 computed（替代原 ref + 手写 fetch）。
// computed 自动响应 partFiles 变化（partFiles 是 computed from useQuery.data，
// 上传 / 删除后 invalidate → data 重算 → drawings/models3d/cadFiles 自动更新）。
const drawings = computed(() => partFiles.value.filter((f) => f.kind === 'DRAWING'));
const models3d = computed(() => partFiles.value.filter((f) => f.kind === '3D_MODEL'));
const cadFiles = computed(() => partFiles.value.filter((f) => f.kind === 'CAD_2D'));

// 从数据层 composable 解构出来（只读投影 + 权限 + 行内编辑态 + helpers）
const {
  part,
  infoLoading,
  events,
  eventsLoading,
  editing,
  form,
  assemblyDetail,
  assemblyLoading,
  batches,
  batchesLoading,
  inspectionBatch,
  canEditPart,
  canCancelPart,
  canDeletePart,
  canInspect,
  canManageDrawings,
  canManage3DModels,
  canManageCncFiles,
  canManageSetupSheet,
  canManageBatches,
  fetchBatches,
  onStartEdit,
  onCancelEdit,
  buildUpdatePayload,
  statusLabel,
  statusTagType,
  statusLabelOf,
  eventLabel,
  eventTagType,
} = detail;

// 写操作层：7 个 mutation 在 `usePartDetailActions` 内。它不认识对话框、不 import
// vue-router —— 每个 action 返回 Promise<boolean>，后续（关框 / 跳转）由本页决定。
const actions = usePartDetailActions({ partId, part, batches, inspectionBatch });
const {
  onSave: savePart,
  onCancelOrder,
  onDeletePart,
  onPassInspection: passInspection,
  onFailInspection: failInspection,
  onSplitBatch,
  onCancelBatch,
  saving,
} = actions;

// PartInfoCard 的 save 按钮 emit 无参，父级读 form 组载荷 —— 归一化（trim / 空串→null）
// 在数据层的 `buildUpdatePayload` 里做一次，OCC 锚由 actions 从 `part.version` 补。
async function onSave(): Promise<void> {
  if (!(await savePart(buildUpdatePayload()))) return;
  editing.value = false;
}

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
// chain 变化前先重置 selectedBatchId，避免旧批次 id 在 chain 未拉完前被
// currentStepId 派生计算时引用到错误的 step。
// ⚠️ 既有健壮性缺口（登记不改逻辑）：这里只置空 selectedBatchId，**不重取 batches**
// ⇒ 若现有 batches 里没有「带 current_process_step_id」的批次，
// useDefaultBatchSelection 的兜底也补不出选中项，工序链时间轴会继续整条全灰。
// 当前不可达：PartDetail 内没有工序链编辑器，process_chain_id 变化只可能由切
// partId 触发，而切 partId 的路由 watcher 会同步 `fetchBatches()`。
// 将来本页加入链编辑能力时必须在这里同时补 refetch。
watch(
  () => part.value?.process_chain_id,
  (id) => {
    if (id) {
      selectedBatchId.value = null;
      void processChain.fetchProcessChain();
    }
  },
);

// 兜底选中：selectedBatchId 唯一写入来源是「点批次行」，没人点过就恒为 null ⇒
// currentStepId 恒 null ⇒ 工序链时间轴整条全灰、「当前」徽标永不出现。
// 判据（优先带 current_process_step_id 的批次，否则回落第一条）与「不覆盖用户
// 已有选择」的语义住在 useDefaultBatchSelection 里（可单测，不埋在 .vue shell）。
// 连带影响：PartHistoryCard 跟随 selectedBatchId 过滤，进页面即落到该批次的事件
// 视图；再点一次该行（onBatchSelect(null)）可切回全量事件。
useDefaultBatchSelection(batches, selectedBatchId);

// ============ 共享 processes 缓存（failInsp 的工序下拉用它）============
// `processes` 来自共享 query useProcessesQuery（`/prod/processes`）。
// 2026-10-10：本页原先还并行维护一份 `productionShelves`（`listShelves({zone:'PRODUCTION'})`），
// 唯一消费方是「外协回收」弹窗的货架单选 —— 该弹窗随死路径删除后，这份本地 ref 变成
// 只写不读，一并删除；`/prod/shelf-processes` 的映射表（useShelfProcessMappingsQuery）
// 也随之不再有本页读点。
const processesQuery = useProcessesQuery({ limit: 200 });
// `as Process[]` 桥接：processSchema 派生的 description / color 是 optional
// （对齐后端 skip_serializing_if），而 Process 业务类型是 required，TS 结构不匹配。
// 沿 usePendingProgrammingStore / usePartDispatch 同模式桥接；本页消费方
// （ProcessChainCard 字典 / el-option）只读 id / code /
// name / category，对 optional 字段无依赖，零行为差异。
const processes = computed<Process[]>(() => (processesQuery.data.value?.items ?? []) as Process[]);

// 2026-09-17 PR-4：ProcessChainCard 需要 { process_id → { code, name } } 字典。
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
const confirmDlg = useDialogSize({ desktopWidth: 420 });
const { dangerous: confirmDangerous } = useConfirm();

// 品检打回（指定工序）对话框
// 2026-10-10：目标生产货架下拉删除 —— 打回的目标架由后端按负载自动选（`to-process`
// 不再收货架字段）。工序下拉直接用全量 processes。
const failInspDialogVisible = ref(false);
const failInspProcessId = ref<string>('');
const failInspNote = ref<string>('');
const failInspSubmitting = ref(false);

function openFailInspDialog() {
  failInspProcessId.value = '';
  failInspNote.value = '';
  failInspDialogVisible.value = true;
  // processes 已是共享 query 的响应式派生，弹窗打开即已就位。
}
function onFailInspDialogClosed() {
  failInspProcessId.value = '';
  failInspNote.value = '';
}
async function onFailInspectionConfirm() {
  if (!failInspProcessId.value) return;
  failInspSubmitting.value = true;
  try {
    // ⚠️ 不再传 batchId：锚批次由 actions 从 `inspectionBatch` 派生（与「品检通过」
    // 同一条），与三卡联动的 `selectedBatchId` 解耦 —— 后者是「用户在看哪个批次」的
    // 视图锚，拿它当写锚就会让两个品检按钮在多批次工单上打不同的批次。
    const ok = await failInspection({
      processId: failInspProcessId.value,
      note: failInspNote.value.trim() || null,
    });
    if (ok) failInspDialogVisible.value = false;
  } finally {
    failInspSubmitting.value = false;
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
      // 软删成功后目标资源已不存在（后端 `GET /parts/{id}` 带 `deleted_at IS NULL`），
      // 跳转由 shell 负责 —— composable 不 import vue-router（CLAUDE.md 不变量）。
      if (await onDeletePart()) {
        confirmVisible.value = false;
        await router.push('/parts');
      }
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
    await passInspection();
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
  // ⚠️ 成功后**不**再手写 fetchBatches：actions 的 mutation `onSuccess` 已失效
  // `qk.partBatchesPrefix`（含本页消费的 `qk.partBatchesList(partId)`），活跃 observer
  // 在 mutateAsync resolve 前就已 refetch 完毕。
  const result = await onSplitBatch(payload.batch, payload.quantity);
  payload.resolve(result !== null);
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
}

// ============ 配对上传（PartFilesTabsCard → PartCncCard 触发）============
// 2026-10-10：`handleRelease`（「下发到 CNC 货架」）随该功能下线一并删除。
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
// ============ 零件文件 tabs 刷新（PartFilesTabsCard 触发）============
// 2026-09-29 迁移：usePartFilesListQuery 单调用后失效整 owner 列表即可，
// active 消费者（PartFilesTabsCard 内部 tabs + DrawingPreviewPane）都会自动 refetch。
// 替代原 usePartFiles 三并发 + onFileTabRefresh 按 kind 转 fetch* 的模式。
async function onFileTabRefresh(_kind: 'DRAWING' | '3D_MODEL' | 'CAD_2D'): Promise<void> {
  // 2026-09-29：失效整 owner 的 part-files 列表，让 active 消费者（DrawingPreviewPane
  // + 当前页 PartFilesTabsCard）都自动 refetch。usePartFilesListQuery 的 queryKey 是
  // owner 维度，invalidate 一次覆盖三 kind。
  await invalidatePartFilesListQuery(qc, partId.value);
}

// ============ 切换 partId 时重置 ============
watch(
  () => route.params.id,
  async (id) => {
    // 2026-10-10 加「本页是否活跃」守卫（根因与 `AssemblyDetail.vue` 同款，这里只写后果）：
    // `useRoute()` 注入的是 vue-router 的**全局**响应式 currentRoute，不是本组件挂载
    // 那一刻的地址快照；本页被 keep-alive 缓存（路由名 `PartDetail` = 组件文件名，
    // MainLayout 的 `<keep-alive :include="tags.cachedViewNames">` 按名字匹配）后，
    // 用户切到别的页面时全局路由一变，本 watcher 仍在跑（只有 onUnmounted 才停），
    // 于是 partId 会被改成**别的页面**的 id。判据抽在
    // `composables/partDetailActive.ts`（与两条 query hook 的 `enabled` 闸门共用同一份，
    // 别在这里另写一遍 `route.name !== 'PartDetail'`）。
    //
    // **不能删 watcher**：vue-router 对同一条路由记录只改 param（/parts/1 → /parts/2）
    // 时会复用组件实例、不触发 onMounted；本页内部就有这种导航
    // （`PartAssemblyLinkCard` 的兄弟零件 chips）。删了的话，从 A 件跳到兄弟件 B，
    // 页面会停在 A 件的数据上。
    if (!isPartDetailActive(route.name)) return;
    const s = String(id ?? '');
    if (!s) return;
    partId.value = s;
    // 2026-09-17 PR-4：清空选中批次（useProcessChain 内部已 watch partId 清空
    // selectedBatchId，但切 partId 时立刻置空让 PartHistoryCard 立刻恢复展示
    // 全部事件，避免闪旧批次的过滤态）。
    selectedBatchId.value = null;
    // ⚠️ **这里不再手写 fetchPart / fetchEvents / fetchBatches**：三条 query hook 的
    // queryKey 是 reactive 的，partId 一变 key 就变 → observer 自动 refetch。
    // 留着这三行就是每次切件打两遍（hook 的自动 refetch + 这里的手写 refetch）。
    // 零件文件同理（`usePartFilesListQuery` 的 ownerKey 也是 reactive）。
  },
);

// 2026-10-10：`onMounted` 里那三行 fetchPart / fetchEvents / fetchBatches 一并删除
// —— 同上，首调由 useQuery 在 setup 阶段自动发起；再手写一遍就是首屏双请求。
// `usePartCncGroups` / `usePartFilesListQuery` 本来就是 reactive params 自驱（且两者
// 共用 `qk.partFilesList(partId)` 同一条键、按 queryKey 去重），不受影响。

// 2026-10-10：只在**真正卸载**（关标签页）时重置本 composable 的 UI 态，不挂
// `onDeactivated` —— 本页被 keep-alive 缓存，deactivate 只是切走、实例还在，切回来
// 必须还能看到刚才的数据（行内编辑态 / 装配件详情不该每次切页都丢）。query 缓存由
// queryClient 统一管（有限 gcTime 5min），这里不碰。
onUnmounted(() => {
  detail.reset();
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
    align-items: center;
    gap: 10px;
  }

  // 2026-10-10：品检按钮组左侧的锚批次标识。必须可见 —— 两个品检动作打在**同一个**
  // 派生的 `inspectionBatch` 上，用户要能在按下之前确认那是哪个批次（多批次工单上
  // 「品检通过」与「指定工序」打的批次曾经是两个，且界面上看不出来）。
  .inspection-anchor {
    font-size: 13px;
    color: var(--text-secondary);
    margin-right: 4px;
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

// 2026-09-17 PR-4 + 2026-09-17 UI 调整第 2 轮：时间线卡。
// 第 2 轮改造：
//   1. 去掉外层 card header；
//   2. body 拆成两行：上方历史 + 工序链（flex 等高、滚动），下方批次监控
//      （自然撑开、不限高度）。批次表本身就有行数自适应，外层 60vh 限制
//      反而会让列拖动 / 拆分 dialog 弹出时撑爆区域。
// 子卡自带 :deep(.el-card__body) padding，这里只约束容器 + 子卡视觉。
// 子卡用 flex: 1 1 0 + min-width: 0 允许内部 el-table / el-timeline 自然收缩；
// overflow-y: auto 避免批次多时整体撑爆页面。
.timeline-card {
  :deep(.el-card__body) {
    padding: 12px 16px;
  }
  .timeline-top {
    display: flex;
    gap: 12px;
    height: 60vh;
    overflow-y: auto;
    // 历史 + 工序链两列等宽；min-width: 0 防 flex 子项最小内容宽度撑爆容器。
    :deep(.el-card) {
      flex: 1 1 0;
      min-width: 0;
      overflow-y: auto;
    }
  }
  .timeline-bottom {
    margin-top: 12px;
    // 批次监控卡以 wrapCard=false 渲染（裸 div），让其撑满宽度。
    :deep(.batch-card-flat) {
      width: 100%;
    }
  }
}
</style>
