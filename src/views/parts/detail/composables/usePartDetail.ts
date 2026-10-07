// views/parts/detail/composables/usePartDetail.ts
//
// 2026-08-25 frontend-overall-refactor：PartDetail 拆分的 usePartDetail。
// 负责 /parts/:id 详情页的所有 page-level 业务：
// - 零件主信息 fetchPart
// - 行内编辑 editing / form / saving
// - 取消订单 / 删除（confirm dialog 由 shell 持有 UI 状态）
// - 品检通过 / 指定工序（failInsp dialog 由 shell 持有 UI 状态）
// - 外协回收（receive dialog 由 shell 持有 UI 状态）
// - 批次拆分 / 取消批次（split dialog 由 PartBatchMonitorCard 持有 UI 状态）
// - 状态 / 事件标签 helpers
//
// composable 只持有纯业务数据 + 业务函数；dialog 可见性、form 数据 refs 由
// 各自的子组件或 shell 持有，调用本 composable 的纯函数完成提交。
//
// 2026-09-28 契约修复（修「修改工单报 422 missing field `version`」）：
//   - 后端 `PartUpdateRequest.version` / `PartSoftDeleteRequest.version` 均**无
//     `#[serde(default)]`**，缺字段时 axum `Json` extractor 在 service 之前直接拒
//     （HTTP 422，非项目统一信封）。onSave / onDeletePart 此前都不带 version →
//     详情页保存与删除恒失败。
//   - OCC 锚点取自 `PartDetailOut.version`；onSave 成功路径整体替换 part.value，
//     新 version 天然回写。补 40901 分支：他人已改 → 提示 + fetchPart 拉最新值。

import { computed, reactive, ref, watch, watchEffect, type ComputedRef, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  cancelPart,
  cancelPartBatch,
  getPart,
  listPartBatches,
  listPartEvents,
  softDeletePart,
  toProcess,
  toShip,
  updatePart,
  type PartBatch,
  type PartEvent,
  type PartItem,
  type PartUpdatePayload,
} from '@/api/parts';
import { enrichAssemblyItem, getAssemblyForPart } from '@/api/assembly';
import { splitBatch } from '@/api/batch';
import type { BatchSplitDto } from '@/api/batch.contract';
import type { AssemblyDetail } from '@/types/assembly';
import { receiveFromOutsource } from '@/api/parts';
import { usePermissions } from '@/composables/usePermissions';
import { useConfirm } from '@/composables/useConfirm';
// fetchAssembly 走客户 enrich（PartAssemblyLinkCard 客户列展示所需），数据源是
// useCustomersQuery 共享缓存（唯一 queryKey + 30s staleTime 去重窗口，多 subscriber
// 不触发额外 fetch）。
import { useCustomersQuery } from '@/composables/queries/useCustomersQuery';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  PART_EVENT_LABEL,
  PART_EVENT_TAG_TYPE,
  type OrderStatus,
  type PartEventType,
} from '@/types/parts';

/** 行内编辑 form。
 *  2026-09-16 PR-2：actual_delivery_date 随 t_part 瘦身从表单 / 提交载荷一并删除。 */
export interface PartEditForm {
  name: string;
  drawing_no: string;
  quantity: number;
  is_urgent: boolean;
  planned_delivery_date: string;
  order_no: string | null;
  system_delivery_date: string | null;
  note: string | null;
}

function makeEmptyEditForm(): PartEditForm {
  return {
    name: '',
    drawing_no: '',
    quantity: 1,
    is_urgent: false,
    planned_delivery_date: '',
    order_no: null,
    system_delivery_date: null,
    note: null,
  };
}

/** 2026-09-21 显式返回类型。 */
export interface UsePartDetailReturn {
  part: Ref<PartItem | null>;
  infoLoading: Ref<boolean>;
  events: Ref<PartEvent[] | null>;
  eventsLoading: Ref<boolean>;
  editing: Ref<boolean>;
  saving: Ref<boolean>;
  form: PartEditForm;
  assemblyDetail: Ref<AssemblyDetail | null>;
  assemblyLoading: Ref<boolean>;
  batches: Ref<PartBatch[]>;
  batchesLoading: Ref<boolean>;
  canEditPart: ComputedRef<boolean>;
  canCancelPart: ComputedRef<boolean>;
  canDeletePart: ComputedRef<boolean>;
  canInspect: ComputedRef<boolean>;
  canReceiveFromOutsource: ComputedRef<boolean>;
  canManageDrawings: ComputedRef<boolean>;
  canManage3DModels: ComputedRef<boolean>;
  canManageCncFiles: ComputedRef<boolean>;
  canManageSetupSheet: ComputedRef<boolean>;
  canManageBatches: ComputedRef<boolean>;
  fetchPart: () => Promise<void>;
  fetchEvents: () => Promise<void>;
  fetchAssembly: () => Promise<void>;
  fetchBatches: () => Promise<void>;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => Promise<void>;
  onCancelOrder: () => Promise<boolean>;
  onDeletePart: () => Promise<boolean>;
  onPassInspection: () => Promise<boolean>;
  /** 品检打回（to-process）。`batchId` 为空时直接失败 —— v2 端点以批次为锚，
   *  不再支持「缺省按唯一 INSPECTION 批次解析」。 */
  onFailInspection: (payload: {
    batchId: string | null;
    shelfId: string;
    processId: string;
    note: string | null;
  }) => Promise<boolean>;
  onReceiveFromOutsource: (payload: {
    batchId: string;
    shelfId: string;
    processId: string;
  }) => Promise<boolean>;
  /** 拆批。返回拆分结果（源批次余量 + 新批次 id）供调用方判成败；行数据靠调用方随后的
   *  `fetchBatches` 重拉，不在这里回显。 */
  onSplitBatch: (batch: PartBatch, quantity: number) => Promise<BatchSplitDto | null>;

  onCancelBatch: (batch: PartBatch) => Promise<PartBatch[] | null>;
  statusLabel: (s: OrderStatus) => string;
  statusTagType: (s: OrderStatus) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
  statusLabelOf: (s: string | null | undefined) => string;
  eventLabel: (t: string) => string;
  eventTagType: (t: string) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
}

export function usePartDetail(partId: Ref<string>): UsePartDetailReturn {
  const router = useRouter();
  const { isManager, isClerk, isInspector, isCncProgrammer: isCnc } = usePermissions();
  // 2026-08-25 T10p5：品检通过属于不可撤销操作，先用 useConfirm 二次确认。
  const { dangerous: confirmDangerous } = useConfirm();

  // ============ 权限 ============
  const canEditPart = computed(() => isManager.value || isClerk.value);
  const canCancelPart = computed(() => isManager.value || isClerk.value);
  const canDeletePart = computed(() => isManager.value);
  const canInspect = computed(() => isManager.value || isClerk.value || isInspector.value);
  const canReceiveFromOutsource = computed(() => isManager.value || isClerk.value);
  /** 图纸 / 3D 模型：MANAGER + CLERK（文员日常操作） */
  const canManageDrawings = computed(() => isManager.value || isClerk.value);
  const canManage3DModels = computed(() => isManager.value || isClerk.value);
  /** G 代码 / 设定单：MANAGER + CNC_PROGRAMMER */
  const canManageCncFiles = computed(() => isManager.value || isCnc.value);
  const canManageSetupSheet = computed(() => isManager.value || isCnc.value);
  /** 批次管理：MANAGER + CLERK */
  const canManageBatches = computed(() => isManager.value || isClerk.value);

  // ============ 主数据 ============
  const part = ref<PartItem | null>(null);
  const infoLoading = ref(false);

  async function fetchPart(): Promise<void> {
    infoLoading.value = true;
    try {
      part.value = await getPart(partId.value);
    } catch (e) {
      part.value = null;
      ElMessage.error((e as Error).message ?? '加载零件失败');
    } finally {
      infoLoading.value = false;
    }
  }

  // ============ 历史 ============
  const events = ref<PartEvent[] | null>(null);
  const eventsLoading = ref(false);
  async function fetchEvents(): Promise<void> {
    eventsLoading.value = true;
    try {
      events.value = await listPartEvents(partId.value);
    } catch (e) {
      events.value = null;
      ElMessage.error((e as Error).message ?? '加载历史记录失败');
    } finally {
      eventsLoading.value = false;
    }
  }

  // ============ 行内编辑（PartInfoCard 读 editing/form/saving）============
  const editing = ref(false);
  const saving = ref(false);
  const form = reactive<PartEditForm>(makeEmptyEditForm());

  function onStartEdit(): void {
    if (!part.value) return;
    form.name = part.value.name;
    form.drawing_no = part.value.drawing_no;
    form.quantity = part.value.quantity;
    form.is_urgent = part.value.is_urgent;
    form.planned_delivery_date = part.value.planned_delivery_date;
    form.order_no = part.value.order_no;
    form.system_delivery_date = part.value.system_delivery_date;
    form.note = part.value.note;
    editing.value = true;
  }

  function onCancelEdit(): void {
    editing.value = false;
  }

  async function onSave(): Promise<void> {
    // 2026-09-28 契约修复：后端 PartUpdateRequest.version 必填（无 serde(default)），
    // 缺字段 → HTTP 422 missing field version。OCC 锚点取自 PartDetailOut.version。
    if (!part.value) {
      ElMessage.error('零件信息未加载完成');
      return;
    }
    saving.value = true;
    try {
      const payload: PartUpdatePayload = {
        version: part.value.version,
        name: form.name.trim(),
        drawing_no: form.drawing_no.trim(),
        quantity: form.quantity,
        is_urgent: form.is_urgent,
        planned_delivery_date: form.planned_delivery_date,
        order_no: form.order_no || null,
        system_delivery_date: form.system_delivery_date || null,
        note: form.note || null,
      };
      // 响应即最新 PartDetailOut（含 OCC 后的新 version），整体替换 part.value
      // 天然完成 version 回写，下一次保存用新锚点。
      part.value = await updatePart(partId.value, payload);
      ElMessage.success('保存成功');
      editing.value = false;
    } catch (e) {
      // 40901 VERSION_CONFLICT：他人已改过，本地 form 基于旧 version → 拉最新值
      if ((e as { code?: number }).code === 40901) {
        ElMessage.warning('该记录已被他人修改，已为你刷新');
        editing.value = false;
        await fetchPart();
      } else {
        ElMessage.error((e as Error).message ?? '保存失败');
      }
    } finally {
      saving.value = false;
    }
  }

  // ============ 装配件详情（PartAssemblyLinkCard 用）============
  // 订阅 useCustomersQuery 拿客户全集，用于 enrichAssemblyItem 补全
  // customer_name / parent_customer_name / customer_path。
  // 唯一 queryKey + 30s staleTime 去重窗口，多 subscriber 不触发额外 fetch（共享缓存）。
  const { data: customersData } = useCustomersQuery();

  const assemblyDetail = ref<AssemblyDetail | null>(null);
  const assemblyLoading = ref(false);
  /**
   * 2026-09-29 修复：补 JSDoc 防止「PartDetail 误调 /assemblies/{id}」的误判。
   *
   * PartDetail **不**调 `GET /api/v2/assemblies/{part_id}`，而是调
   * `GET /api/v2/parts/{part_id}/assembly`（`getAssemblyForPart`）。后者由后端
   * part service 内部按 `part.assembly_id` 间接调 assembly service。
   *
   * Network 面板若在 PartDetail 上看到 `/assemblies/{asm_id}` 形式的请求 = 真 bug，
   * 需立即排查。
   *
   * 错误 message 里的数字是 `part.assembly_id` 列值（part 的 indirection），
   * 不是 URL path 里的 part_id —— 后端按 `assembly_id` 找装配件失败时报
   * BIZ_ASSEMBLY_NOT_FOUND `assembly {asm_id} 不存在`。
   */
  async function fetchAssembly(): Promise<void> {
    if (!part.value || part.value.assembly_id == null) {
      assemblyDetail.value = null;
      return;
    }
    assemblyLoading.value = true;
    try {
      const fetched = await getAssemblyForPart(part.value.id);
      // fetched 非 null 时调共享 enrich，PartAssemblyLinkCard「客户」列才能正确展示。
      // fetched 为 null（零件无所属装配件）时直接保留 null。
      if (fetched) {
        fetched.assembly = enrichAssemblyItem(fetched.assembly, customersData.value?.items ?? []);
      }
      assemblyDetail.value = fetched;
    } catch (e) {
      assemblyDetail.value = null;
      // 2026-09-29 修复：错误信息加端点路径前缀，避免与
      // `GET /api/v2/assemblies/{asm_id}`（不是这条！）混淆。
      // 用户报告 [20301] message 里的 id 与 URL path id 不同时，本前缀让
      // 排查者一眼看出「请求端点是 /parts/{id}/assembly 不是 /assemblies/{id}」。
      ElMessage.error(
        `所属装配件加载失败（端点 /api/v2/parts/${part.value.id}/assembly）：${(e as Error).message ?? '未知错误'}`,
      );
    } finally {
      assemblyLoading.value = false;
    }
  }

  // 响应式 customers 缓存到达时的补跑：useCustomersQuery 是懒查询，首次进 PartDetail 时
  // customers 可能未加载完，fetchAssembly 内 enrich 把 customer_* 置 null 后
  // 不会自动 re-trigger。watchEffect 在 customersData 变化时自动重跑 enrich，
  // 确保 PartAssemblyLinkCard「客户」列无需刷新就能展示。
  // 约束：assemblyDetail.value 为 null 时不跑（无父装配体分支）。
  watchEffect(() => {
    const items = customersData.value?.items;
    if (!assemblyDetail.value) return;
    if (!items) return;
    assemblyDetail.value.assembly = enrichAssemblyItem(assemblyDetail.value.assembly, items);
  });

  // ============ 取消订单 / 删除（confirm dialog 由 shell 持有 UI 状态）============
  /**
   * shell 收集到流水号后调用（流水号校验由 shell 负责）。
   * 成功后 shell 关闭 confirm dialog 并刷新。
   */
  async function onCancelOrder(): Promise<boolean> {
    try {
      await cancelPart(partId.value);
      ElMessage.success('已取消');
      await fetchPart();
      void fetchEvents();
      return true;
    } catch (e) {
      ElMessage.error((e as Error).message ?? '操作失败');
      return false;
    }
  }

  async function onDeletePart(): Promise<boolean> {
    // 2026-09-28 契约修复：后端 PartSoftDeleteRequest.version 必填（无
    // serde(default)），此前不发 body → 必 422。
    if (!part.value) return false;
    try {
      await softDeletePart(partId.value, part.value.version);
      ElMessage.success('已删除');
      router.push('/parts');
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 40901) {
        ElMessage.warning('该记录已被他人修改，请刷新后重试');
        await fetchPart();
        return false;
      }
      ElMessage.error((e as Error).message ?? '操作失败');
      return false;
    }
  }

  // ============ 品检通过 ============
  // 走 `POST /prod/batches/{batch_id}/to-ship`（INSPECTION → READY_TO_SHIP，事件
  // INSPECTED），二次确认沿用 confirmDangerous。OCC 锚 t_part_batch.version：
  // 从 batches 找 INSPECTION 状态批次，取其 id + version；40901 提示用户刷新。
  async function onPassInspection(): Promise<boolean> {
    if (!part.value) return false;
    const inspectionBatch = batches.value.find((b) => b.status === 'INSPECTION');
    if (!inspectionBatch) {
      ElMessage.error('未找到待过检批次');
      return false;
    }
    const ok = await confirmDangerous('品检通过', '确认将此零件标记为品检通过？此操作不可撤销。', {
      type: 'success',
      confirmText: '确认通过',
      cancelText: '取消',
    });
    if (!ok) return false;
    try {
      // 2026-10-02：批次锚定 `POST /prod/batches/{batch_id}/to-ship`（batch_id 已是路径）。
      await toShip(inspectionBatch.id, {
        version: inspectionBatch.version,
        quantity: null,
      });
      ElMessage.success('品检通过');
      await fetchPart();
      void fetchEvents();
      return true;
    } catch (e) {
      // 40901：批次 version 不匹配
      if ((e as { code?: number }).code === 40901) {
        ElMessage.warning('该批次已被他人修改，请刷新后重试');
        void fetchBatches();
      } else {
        ElMessage.error(`品检通过失败：${(e as Error).message}`);
      }
      return false;
    }
  }

  // ============ 指定工序（failInsp dialog 由 shell 持有 UI 状态）============
  // 2026-10-02：打回改打 v2 `POST /prod/batches/{batch_id}/to-process`（INSPECTION →
  // IN_PROCESS，事件 INSPECTION_FAILED）。batchId 由调用方（PartDetail）传入 ——
  // 复用批次卡三卡联动锚的选中批次，多批次 part 上比「找第一个 INSPECTION 批次」更准；
  // version 取该批次的 t_part_batch.version（后端必填，缺 → 422）。
  // 锚点批次的状态由本函数自守（见下方守卫），不信任 shell 的按钮可见性判据。
  async function onFailInspection(payload: {
    batchId: string | null;
    shelfId: string;
    processId: string;
    note: string | null;
  }): Promise<boolean> {
    if (!payload.batchId) {
      ElMessage.error('请先在批次列表中选中要打回的批次');
      return false;
    }
    const batch = batches.value.find((b) => b.id === payload.batchId);
    if (!batch) {
      ElMessage.error('未找到选中的批次，请刷新后重试');
      return false;
    }
    // 状态守卫：shell 的「指定工序」按钮按 **part 级** part.status === 'INSPECTION'
    // 决定可见性，而 to-process 是 **batch 级** 状态机（INSPECTION → IN_PROCESS）。
    // 多批次工单里 part.status 命中不代表选中批次也在品检中（最老批次可能还是
    // PENDING），硬发只会被后端状态机拒，用户只看到一条原文错误、看不出用的哪个批次。
    if (batch.status !== 'INSPECTION') {
      ElMessage.warning(
        `批次 ${batch.batch_label} 当前为 ${statusLabelOf(batch.status)}，不在品检中；请先在批次列表选中要打回的批次`,
      );
      return false;
    }
    try {
      await toProcess(batch.id, {
        shelf_id: payload.shelfId,
        next_process_id: payload.processId,
        version: batch.version,
        note: payload.note,
      });
      ElMessage.success('已指定下一道工序');
      await fetchPart();
      void fetchEvents();
      return true;
    } catch (e) {
      // 40901：批次 version 不匹配（与 onPassInspection 同款兜底）
      if ((e as { code?: number }).code === 40901) {
        ElMessage.warning('该批次已被他人修改，请刷新后重试');
        void fetchBatches();
      } else {
        ElMessage.error(`指定工序失败：${(e as Error).message}`);
      }
      return false;
    }
  }

  // ============ 外协回收（receive dialog 由 shell 持有 UI 状态）============
  async function onReceiveFromOutsourceFn(payload: {
    batchId: string;
    shelfId: string;
    processId: string;
  }): Promise<boolean> {
    // 2026-10-02：批次锚定 + version 必填（后端 receive_from_outsource 复用
    // PlaceOnShelfRequest）。version 取调用方指定批次的 t_part_batch.version。
    const batch = batches.value.find((b) => b.id === payload.batchId);
    if (!batch) {
      ElMessage.error('未找到要回收的批次，请刷新后重试');
      return false;
    }
    try {
      await receiveFromOutsource(batch.id, {
        shelf_id: payload.shelfId,
        next_process_id: payload.processId,
        version: batch.version,
      });
      ElMessage.success('外协已回收');
      await fetchPart();
      void fetchEvents();
      return true;
    } catch (e) {
      ElMessage.error(`外协回收失败：${(e as Error).message}`);
      return false;
    }
  }

  // ============ 批次（PartBatchMonitorCard 渲染 + 拆分 / 取消）============
  const batches = ref<PartBatch[]>([]);
  const batchesLoading = ref(false);
  async function fetchBatches(): Promise<void> {
    batchesLoading.value = true;
    try {
      batches.value = await listPartBatches(partId.value);
    } catch (e) {
      batches.value = [];
      ElMessage.error((e as Error).message ?? '加载批次失败');
    } finally {
      batchesLoading.value = false;
    }
  }

  async function onSplitBatch(batch: PartBatch, quantity: number): Promise<BatchSplitDto | null> {
    try {
      // 2026-10-08：拆批搬到共用层 `POST /api/v2/batches/split`（`batch_id` 走 body，
      // 不是路径参数）；version 取被拆批次的 t_part_batch.version（OCC 必填，缺了后端
      // 返 HTTP 422 纯文本而非业务信封）。出参是拆分结果对象（源批次余量 + 新批次 id），
      // 不是批次数组 —— 调用方只判成败，行数据由随后的 fetchBatches 重拉。
      const result = await splitBatch({
        batch_id: batch.id,
        quantity,
        version: batch.version,
      });
      ElMessage.success('拆分成功');
      await fetchPart();
      void fetchEvents();
      return result;
    } catch (e) {
      ElMessage.error(`拆分失败：${(e as Error).message}`);
      return null;
    }
  }

  async function onCancelBatch(batch: PartBatch): Promise<PartBatch[] | null> {
    try {
      // 2026-10-02：批次锚定 `POST /prod/batches/{batch_id}/cancel`（part 域的
      // `POST /parts/{id}/cancel` 是「取消该 part 全部活跃批次」，两者不要混）。
      const newBatches = await cancelPartBatch(batch.id, batch.version);
      ElMessage.success('批次已取消');
      await fetchPart();
      void fetchEvents();
      return newBatches;
    } catch (e) {
      ElMessage.error(`取消批次失败：${(e as Error).message}`);
      return null;
    }
  }

  // ============ 状态 / 事件标签 helpers ============
  function statusLabel(s: OrderStatus): string {
    return ORDER_STATUS_LABEL[s] ?? s;
  }
  function statusTagType(s: OrderStatus): 'primary' | 'success' | 'warning' | 'info' | 'danger' {
    return ORDER_STATUS_TAG_TYPE[s] ?? 'info';
  }
  function statusLabelOf(s: string | null | undefined): string {
    if (!s) return '';
    return ORDER_STATUS_LABEL[s as OrderStatus] ?? s;
  }
  function eventLabel(t: string): string {
    return PART_EVENT_LABEL[t as PartEventType] ?? t;
  }
  function eventTagType(t: string): 'primary' | 'success' | 'warning' | 'info' | 'danger' {
    return PART_EVENT_TAG_TYPE[t as PartEventType] ?? 'info';
  }

  // ============ 切 partId 时重置 ============
  watch(partId, (next) => {
    if (!next) return;
    editing.value = false;
    assemblyDetail.value = null;
  });

  // part 加载后，若有 assembly_id 拉装配件详情
  watch(
    () => part.value?.assembly_id,
    () => {
      void fetchAssembly();
    },
  );

  return {
    // data
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
    // permissions
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
    // fetchers
    fetchPart,
    fetchEvents,
    fetchAssembly,
    fetchBatches,
    // edit
    onStartEdit,
    onCancelEdit,
    onSave,
    // cancel / delete
    onCancelOrder,
    onDeletePart,
    // inspection
    onPassInspection,
    onFailInspection,
    // outsource receive
    onReceiveFromOutsource: onReceiveFromOutsourceFn,
    // batch split / cancel
    onSplitBatch,
    onCancelBatch,
    // label helpers
    statusLabel,
    statusTagType,
    statusLabelOf,
    eventLabel,
    eventTagType,
  };
}
