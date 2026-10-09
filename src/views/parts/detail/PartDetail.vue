<!--
  PartDetail.vue

  `/parts/:id` 零件详情页（装配壳）。

  壳只做两件事：**接线**（把数据层 / 动作层的返回值喂给卡片、处理对话框与导航的收尾）
  与**本文件独有的局部态**（选中批次、两个对话框的可见性、三个提交中标记）。
  取数在 `composables/usePartDetailQuery.ts` + `usePartEventsQuery.ts` + 共享的
  `usePartBatchesQuery`；7 个写操作在 `composables/usePartDetailActions.ts`；权限矩阵 /
  派生 / 行内编辑态在 `composables/usePartDetail.ts`。

  卡片：信息卡 / 条形码卡 / 装配件卡 / 零件文件 tabs 卡 / 时间线卡（历史 + 工序链 +
  批次监控）/ 底部操作卡 + 两个对话框。

  边界取舍：
    - 「底部操作」与「指定工序」已抽成 `PartActionBar.vue` / `PartFailInspectionDialog.vue`
      —— 两个都是**纯展示 + 事件转发**，门控口径与各自边界写在它们的文件头。
    - **取消 / 删除确认框刻意留在壳里**：它要求逐字输入 `part.serial_no` 才解锁，是那条
      路径上**唯一**的提交出口，关掉权必须收在自己手里（CLAUDE.md「一个弹窗若是某条
      路径的唯一出口，它的关闭权就必须收在自己手里」）。同理不给它加 `:show-close`。
    - 软删后的跳转也在壳里 —— composable 不 import vue-router（CLAUDE.md 不变量）。

  端点：详情 `GET /api/v2/parts/{id}`；品检流转 `POST /api/v2/prod/batches/{id}/to-ship`
  （品检通过）与 `/to-process`（指定工序）；工艺链由 `part.process_chain_id` 指过去，
  走 `useProcessChain` 拉 `GET /prod/process-chains/{chain_id}`。
-->
<template>
  <div v-loading="infoLoading" class="part-detail">
    <!--
      三条读（详情 / 事件 / 批次列表）任一失败时的**页内兜底位**。
      与 query hook 内的 `watch(error) → ElMessage.error` 是两层、不是重复：
      ElMessage 是瞬时提示（几秒后消失、连点几次会互相顶掉），这里留一条常驻横幅，
      让「这一屏的数据不完整」在页面上留得下痕迹。正常路径零 DOM。
    -->
    <el-alert
      v-if="errorMsg"
      type="error"
      :closable="false"
      show-icon
      :title="`部分数据加载失败：${errorMsg}`"
      description="已加载的卡片仍可正常使用；若持续失败请刷新页面或检查网络。"
    />

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

    <PartAssemblyLinkCard
      v-if="part && part.assembly_id !== null"
      :part="part"
      :assembly-detail="assemblyDetail"
      :assembly-loading="assemblyLoading"
    />

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
      时间线卡：批次列表 + 历史 + 工序链 三列联动。
      `selectedBatchId` 是唯一的联动锚（批次行选中写入），同时驱动 PartHistoryCard 的
      事件过滤与 ProcessChainCard 的步骤高亮；没人点过时由 `useDefaultBatchSelection`
      兜底选中（优先带工序链定位的批次）。批次监控在本轮布局调整后移到下方同行撑满。
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

    <PartActionBar
      :visible="!!part"
      :status="part?.status ?? null"
      :can-inspect="canInspect"
      :can-cancel-part="canCancelPart"
      :can-delete-part="canDeletePart"
      :inspection-batch="inspectionBatch"
      :pass-submitting="passSubmitting"
      @pass="onPassInspection"
      @openFailInsp="openFailInspDialog"
      @cancelOrder="openConfirmForCancel"
      @deletePart="openConfirmForDelete"
    />

    <PartFailInspectionDialog
      v-model:model-value="failInspDialogVisible"
      :inspection-batch="inspectionBatch"
      :processes="processes"
      :submitting="failInspSubmitting"
      :status-label-of="statusLabelOf"
      @confirm="onFailInspectionConfirm"
    />

    <!-- 取消订单 / 删除确认对话框（唯一提交出口，关闭权在本框，见文件头） -->
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
      dev-only 调试面板（`import.meta.env.DEV` 为假时自动消失，无生产 CSS 体积）。
      端点路径 + 当前 part.assembly_id + 装配件详情加载状态 —— 用户报告「详情页有
      /assemblies/{part_id} 可疑请求」时一眼可对照（实际是 /parts/{part_id}/assembly）。
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
import { computed, onUnmounted, ref, watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { PriceTag } from '@element-plus/icons-vue';
import type { PartBatch } from '@/api/parts';
import { useTagsViewStore } from '@/stores/tagsView';
import { useDialogSize } from '@/composables/useDialogSize';
import { useConfirm } from '@/composables/useConfirm';
import PartInfoCard from './components/PartInfoCard.vue';
import BarcodeView from './components/BarcodeView.vue';
import PartHistoryCard from './components/PartHistoryCard.vue';
import PartAssemblyLinkCard from './components/PartAssemblyLinkCard.vue';
import PartFilesTabsCard from './components/PartFilesTabsCard.vue';
import PartBatchMonitorCard from './components/PartBatchMonitorCard.vue';
import PartActionBar from './components/PartActionBar.vue';
import PartFailInspectionDialog from './components/PartFailInspectionDialog.vue';
import ProcessChainCard from './components/ProcessChainCard.vue';
import { usePartDetail } from './composables/usePartDetail';
import type { PartEditForm } from './composables/usePartDetail';
import { usePartDetailActions } from './composables/usePartDetailActions';
import { isPartDetailActive } from './composables/partDetailActive';
import { usePartFilesPanel } from './composables/usePartFilesPanel';
import { usePartTimeline } from './composables/usePartTimeline';

// 2026-09-29：Vue SFC template expression 默认 sourceType=script，不接受 import.meta。
// 定义 isDev 常量供模板 v-if 引用，避免 [plugin:vite:vue] 的解析报错。
const isDev = import.meta.env.DEV;

const route = useRoute();
const router = useRouter();
const tags = useTagsViewStore();
const partId = ref<string>(String(route.params.id ?? ''));

/**
 * 本页是否仍是当前路由（keep-alive 缓存页必需）。
 *
 * `useRoute()` 注入的是 vue-router 的**全局** currentRoute，不是本组件挂载那一刻的
 * 地址快照；本页被 keep-alive 缓存（路由名 `PartDetail` = 组件文件名，MainLayout 的
 * `<keep-alive :include="tags.cachedViewNames">` 按名字匹配）后，用户切到别的页面时
 * 全局路由照样变。它同时喂给两处，必须共用同一个判据函数（`composables/partDetailActive.ts`，
 * 别在两个地方各写一遍 `route.name !== ...`）：
 *   ① 下面的 route watcher 与标签页标题的 watchEffect —— 否则 partId 被改成别的页面的
 *      id，或把别的 tab 的标题刷成本工单的流水号；
 *   ② 两条 query hook 的 `enabled` 闸门 —— 否则 reactive queryKey 跟着全局路由变，
 *      自动去拉「别的页面的零件」（比 404 更坏：那个 id 若恰好有效，本页会静默渲染成
 *      另一个工单）。
 */
const isActive = computed(() => isPartDetailActive(route.name));

// ============ 数据层 / 动作层 ============
const detail = usePartDetail(partId, isActive);

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
  errorMsg,
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

// ============ 选中批次（三卡联动的唯一锚）============
// 时间线三卡（历史 / 工序链 / 批次监控）的联动锚与派生态都在 `usePartTimeline` 里；
// 「品检锚批次」是其中之一，它同时喂 PartActionBar 的显隐、PartFailInspectionDialog
// 的回显与 usePartDetailActions 的写锚 —— 三处读的是同一个值。
const timeline = usePartTimeline(partId, part, batches);
const {
  selectedBatchId,
  onBatchSelect,
  inspectionBatch,
  processChain,
  currentStepId,
  processes,
  processesLookup,
} = timeline;

// 写操作层：7 个 mutation 在 `usePartDetailActions` 内。它不认识对话框、不 import
// vue-router —— 每个 action 返回 Promise<boolean>，后续（关框 / 跳转）由本页决定。
const actions = usePartDetailActions({ partId, part, inspectionBatch });
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

// ============ 零件文件面板（列表 + 三个 kind 的上传 + G 代码 / 设定单）============
const {
  drawings,
  models3d,
  cadFiles,
  drawingUpload,
  model3dUpload,
  cadUpload,
  onFileTabRefresh,
  cncSetupGroups,
  cncLoading,
  fetchCncPrograms,
  formatBytes,
  onDownloadCnc,
  onDeleteCnc,
  onPairUpload,
  fileList,
} = usePartFilesPanel(partId);

// PartInfoCard 的 save 按钮 emit 无参，父级读 form 组载荷 —— 归一化（trim / 空串→null）
// 在数据层的 `buildUpdatePayload` 里做一次，OCC 锚由 actions 从 `part.version` 补。
async function onSave(): Promise<void> {
  if (!(await savePart(buildUpdatePayload()))) return;
  editing.value = false;
}

// PartInfoCard 用本地 reactive 副本做双向 v-model，父级把子组件 emit('update:form')
// 的最新值合并回 usePartDetail 持有的 form ⇒ onSave() 读到的是子组件当前编辑内容。
function onPartInfoFormChange(next: PartEditForm): void {
  Object.assign(form, next);
}

// ============ 对话框 / 提交中标记（壳的局部态）============
const { dangerous: confirmDangerous } = useConfirm();

// 「指定工序」对话框：可见性与提交态在壳，表单字段与开关时的清空在组件内。
// 2026-10-10：目标生产货架下拉随打回端点删除 —— 目标架改由后端按负载自动选
// （`to-process` 不再收货架字段）。
const failInspDialogVisible = ref(false);
const failInspSubmitting = ref(false);
function openFailInspDialog(): void {
  // processes 已是共享 query 的响应式派生，弹窗打开即已就位。
  failInspDialogVisible.value = true;
}

/**
 * `PartFailInspectionDialog` 的 confirm（备注已 trim、空串归一为 null）。
 *
 * ⚠️ 不传 batchId：锚批次由 actions 从 `inspectionBatch` 派生（与「品检通过」同一条），
 * 与三卡联动的 `selectedBatchId` 解耦 —— 后者是「用户在看哪个批次」的视图锚，拿它当写
 * 锚就会让两个品检按钮在多批次工单上打不同的批次。
 */
async function onFailInspectionConfirm(payload: { processId: string; note: string | null }) {
  failInspSubmitting.value = true;
  try {
    const ok = await failInspection(payload);
    if (ok) failInspDialogVisible.value = false;
  } finally {
    failInspSubmitting.value = false;
  }
}

// 「品检通过」按钮的 loading 由壳包一层（按钮与它的写操作不同层）。
const passSubmitting = ref(false);
async function onPassInspection(): Promise<void> {
  passSubmitting.value = true;
  try {
    await passInspection();
  } finally {
    passSubmitting.value = false;
  }
}

// 取消订单 / 删除共用一个 confirm dialog。
const confirmDlg = useDialogSize({ desktopWidth: 420 });
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

function openConfirmForCancel(): void {
  confirmAction.value = 'cancel';
  confirmSerialNo.value = '';
  confirmVisible.value = true;
}
function openConfirmForDelete(): void {
  confirmAction.value = 'delete';
  confirmSerialNo.value = '';
  confirmVisible.value = true;
}
async function onConfirmAction(): Promise<void> {
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
      // 跳转由壳负责 —— composable 不 import vue-router（CLAUDE.md 不变量）。
      if (await onDeletePart()) {
        confirmVisible.value = false;
        // ⚠️ **必须连标签一起关掉**：本页进了 keep-alive 的 `<keep-alive :include>`
        // （路由名 `PartDetail`），只 `router.push` 不关 tab 会把已删工单留在缓存里 ——
        // 组件不卸载（`onUnmounted` 不跑、`reset()` 不触发），用户点回去看到的是一份
        // 「还在」的旧工单，而它上面的任何写都会 404（软删后 `GET /parts/{id}` 带
        // `deleted_at IS NULL` 过滤）。
        // 用 `removeView` 而不是 `refreshSelectedView`：后者只临时摘缓存再挂回（换的是
        // 组件实例，tab 还在），而这里是「这张 tab 不该再存在」。顺序沿
        // `TagsView.vue::closeView`（先摘 tab、再导航）；本页的目标路由固定是 `/parts`，
        // 所以不需要 store 返回的 fullPath 去挑邻居。
        const selfTab = tags.visitedViews.find((v) => v.path === route.path);
        if (selfTab) tags.removeView(selfTab);
        await router.push('/parts');
      }
    }
  } finally {
    confirmSubmitting.value = false;
  }
}

// ============ 拆 / 取消 批次（PartBatchMonitorCard 触发）============
// emit payload 带 resolve：shell 等动作完成再调它，把 dialog 的关闭时机下沉到成功之后。
// ⚠️ 成功后**不**手写 fetchBatches：actions 的 mutation `onSuccess` 已失效
// `qk.partBatchesPrefix`（含本页消费的 `qk.partBatchesList(partId)`），活跃 observer
// 在 mutateAsync resolve 前就已 refetch 完毕。
async function handleSplitBatch(payload: {
  batch: PartBatch;
  quantity: number;
  resolve: (ok: boolean) => void;
}): Promise<void> {
  const result = await onSplitBatch(payload.batch, payload.quantity);
  payload.resolve(result !== null);
}
async function handleCancelBatch(batch: PartBatch): Promise<void> {
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

// 配对上传：同样等动作完成再 resolve，成功才关 dialog + reset submitting。
async function handlePairUpload(payload: {
  gcodes: File[];
  setup: File;
  resolve: (ok: boolean) => void;
}): Promise<void> {
  const ok = await onPairUpload(payload.gcodes, payload.setup);
  payload.resolve(ok);
}

// ============ 标签页标题动态化 ============
// tab 文案的唯一来源 `meta.title` 是**编译期常量**（「零件详情」），多开几个工单就分不
// 清谁是谁；`tags.setTitle` 把已存在的那张 tab 刷成当前工单的流水号。回退链必需：后端
// `PartDetailOut.serial_no` 是 `Option<String>`（可为 null），`drawing_no` 恒在。
// `meta.title` 的静态值本身不动（它还是侧栏菜单与 `noTagsView` 判定等处的兜底来源），
// 只在 tab 这一层覆盖。
//
// **靠响应式派生而不是手写同步**：`route.path` 与 `part` 任一变化都会重跑 ⇒ 切兄弟零件
// 与切回 tab（缓存命中、`part` 没换对象，只换了 path）都跟着更新。
// ⚠️ `isActive` 守卫是硬需求：本页被 keep-alive 缓存，切去别的页面时全局 `route.path`
// 照样变，而 `part` 还是缓存里的旧工单 —— 不守卫就会把**别的 tab** 刷成这个零件的流水号。
// `setTitle` 不新建 tab（尚未登记 / 已关闭时返回 false 且不做事），重复调用安全。
watchEffect(() => {
  if (!isActive.value) return;
  const p = part.value;
  tags.setTitle({ path: route.path }, p?.serial_no ?? p?.drawing_no ?? '零件详情');
});

// ============ 切 partId ============
// **不能删这个 watcher**：vue-router 对同一条路由记录只改 param（/parts/1 → /parts/2）
// 时会复用组件实例、不触发 onMounted，而本页内部就有这种导航（PartAssemblyLinkCard 的
// 兄弟零件 chips）；删了的话从 A 件跳到兄弟件 B，页面会停在 A 件的数据上。
// 守卫（`isPartDetailActive`）的根因见 `isActive` 的注释。
//
// 这里**不**手写任何 fetch：三条 query hook + 文件列表 + CNC 的 queryKey 都是 reactive
// 的，partId 一变 key 就变 → observer 自动 refetch。留着就是每次切件打两遍。
watch(
  () => route.params.id,
  (id) => {
    if (!isActive.value) return;
    const s = String(id ?? '');
    if (!s) return;
    partId.value = s;
    // 清空选中批次：让 PartHistoryCard 立刻恢复展示全部事件，避免闪旧批次的过滤态。
    // （useProcessChain 内部也 watch partId 清空自己的状态。）
    selectedBatchId.value = null;
  },
);

// 只在**真正卸载**（关标签页）时重置本 composable 的 UI 态，不挂 `onDeactivated` ——
// 本页被 keep-alive 缓存，deactivate 只是切走、实例还在，切回来必须还能看到刚才的
// 数据（行内编辑态 / 装配件详情不该每次切页都丢）。query 缓存由 queryClient 统一管
// （有限 gcTime 5min），这里不碰。
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

.confirm-body {
  .confirm-hint {
    white-space: pre-line;
    color: var(--text-secondary);
    font-size: 13px;
    margin-bottom: 16px;
  }
}

// 时间线卡：body 拆两行 —— 上方历史 + 工序链（flex 等高、可滚动），下方批次监控
// （自然撑开、不限高度）。批次表本身行数自适应，外层 60vh 限制反而会让列拖动 /
// 拆分 dialog 弹出时撑爆区域。
// 子卡自带 :deep(.el-card__body) padding，这里只约束容器 + 子卡视觉；`flex: 1 1 0` +
// min-width: 0 允许内部 el-table / el-timeline 自然收缩，`overflow-y: auto` 避免批次
// 多时整体撑爆页面。
.timeline-card {
  :deep(.el-card__body) {
    padding: 12px 16px;
  }
  .timeline-top {
    display: flex;
    gap: 12px;
    height: 60vh;
    overflow-y: auto;
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
