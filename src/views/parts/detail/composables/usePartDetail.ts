// views/parts/detail/composables/usePartDetail.ts
//
// `/parts/:id` 详情页的**派生 + UI 态层**（2026-10-10 由「数据层 + 动作层混在一起」
// 拆成三层：本文件 / `usePartDetailQuery.ts`+`usePartEventsQuery.ts` /
// `usePartDetailActions.ts`）。
//
// 本文件**只做**四件事，一件都不多：
//   1. 投影：把三条 query hook 的 `data` / `isFetching` / `error` 投影成页面要用的
//      `part` / `batches` / `events` / `infoLoading` / `eventsLoading` /
//      `batchesLoading` / `errorMsg`，以及派生的 `inspectionBatch`；
//   2. 权限矩阵：`canEditPart` / `canCancelPart` / `canDeletePart` / `canInspect` /
//      `canManageDrawings` / `canManage3DModels` / `canManageCncFiles` /
//      `canManageSetupSheet` / `canManageBatches`（逐条对齐后端角色集，见下）；
//   3. 行内编辑态：`editing` / `form` / `buildUpdatePayload()`；
//   4. 装配件详情（`assemblyDetail`）+ 状态 / 事件标签 helpers。
//
// 本文件**不做**：① 任何零件主数据的取数（全部来自 query hook）；② 任何写操作
// （7 个 mutation 在 `usePartDetailActions.ts`）；③ 导航（不 import vue-router，
//   取消 / 删除后的跳转由 shell 决定）。
//
// **为什么不用 Pinia store**（与 `useDeliveryNoteDetail`（`/delivery-notes/:id`）同款
// 取舍）：详情页没有跨路由的持久化筛选 / 分页 / 勾选态，Pinia 的四项契约（首调 +
// `onBeforeUnmount` `$dispose` + 禁解构 + 不 import vue-router）里，只有「不 import
// vue-router」这一条对本页有意义 —— 它在普通 composable 里同样成立。上 store 只会多出
// 「同一时刻两个实例共享同一份编辑态 / 选中态」这一类本页根本不存在的耦合问题。
//
// **keep-alive 下何时重置**：本页被 keep-alive 缓存（路由名 `PartDetail` = 组件文件名，
// MainLayout 的 `<keep-alive :include>` 按名字匹配）。切走只是 deactive，组件实例与
// 局部状态都还在 ⇒ **deactivate 时绝不能清状态**（切回来还要看到刚才的数据，`reset()`
// 挂在 `onDeactivated` 上会让用户每次切页回来都看到一张空表）。只有真正 unmount
// （关标签页 / 组件被销毁）才需要 `reset()`，由 shell 在 `onUnmounted` 调一次。
// ⚠️ 唯一在 deactive 期间必须**停手**的是「别再发请求」，那由 query hook 的 `isActive`
// 闸门负责（见 `usePartDetailQuery.ts` 的文件头注释），与状态重置是两件事。

import {
  computed,
  onActivated,
  reactive,
  ref,
  toValue,
  watch,
  watchEffect,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';
import { ElMessage } from 'element-plus';
import { enrichAssemblyItem, getAssemblyForPart } from '@/api/assembly';
import type { PartBatch, PartEvent, PartUpdatePayload } from '@/api/parts';
import type { AssemblyDetail } from '@/types/assembly';
import { usePermissions } from '@/composables/usePermissions';
import { usePartBatchesQuery } from '@/composables/queries/usePartBatchesQuery';
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
import { usePartDetailQuery } from './usePartDetailQuery';
import { usePartEventsQuery } from './usePartEventsQuery';
import type { PartDetailData } from './partDetailSchema';

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

export interface UsePartDetailReturn {
  // ---------- 投影（query 的只读视图，本文件不发任何请求除装配件外）----------
  part: ComputedRef<PartDetailData | null>;
  infoLoading: Ref<boolean>;
  /** 工单级错误文案（详情 query 失败时非空）。ElMessage 桥接在 query hook 内，这里
   *  给的是页面内联的兜底展示位。 */
  errorMsg: Ref<string>;
  events: ComputedRef<PartEvent[]>;
  eventsLoading: Ref<boolean>;
  batches: ComputedRef<PartBatch[]>;
  batchesLoading: Ref<boolean>;
  // ⚠️ 品检锚批次（`inspectionBatch`）**不在本返回值里**：它的口径要把「用户选中的批次」
  // 算进去，而 `selectedBatchId` 是 shell 的局部态（批次表行选中）。派生函数
  // `./inspectionBatch.ts::resolveInspectionBatch` 是纯函数，由 shell 调一次即可同时喂
  // 按钮显隐 / 弹窗回显 / actions bindings 三处；在本文件再存一份只会多一个可能与
  // shell 不同步的副本。

  // ---------- 权限矩阵 ----------
  canEditPart: ComputedRef<boolean>;
  canCancelPart: ComputedRef<boolean>;
  canDeletePart: ComputedRef<boolean>;
  canInspect: ComputedRef<boolean>;
  canManageDrawings: ComputedRef<boolean>;
  canManage3DModels: ComputedRef<boolean>;
  canManageCncFiles: ComputedRef<boolean>;
  canManageSetupSheet: ComputedRef<boolean>;
  canManageBatches: ComputedRef<boolean>;

  // ---------- 行内编辑 ----------
  editing: Ref<boolean>;
  form: PartEditForm;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  /** 由当前 form 归一化出 `PartUpdatePayload`（不含 OCC 锚 —— version 由 actions 层
   *  从 `part.version` 补，避免两处各取一次锚）。 */
  buildUpdatePayload: () => Omit<PartUpdatePayload, 'version'>;

  // ---------- 装配件 ----------
  assemblyDetail: Ref<AssemblyDetail | null>;
  assemblyLoading: Ref<boolean>;
  fetchAssembly: () => Promise<void>;

  // ---------- 刷新别名（shell 的刷新按钮 / 测试驱动）----------
  //  只导出 `fetchBatches`：批次监控卡有一个「刷新」按钮（`@fetch`）。详情与事件没有
  //  手动刷新按钮 —— 它们的重新取数由写后失效链 + 有限 staleTime 负责，导出零消费方的
  //  别名只会让人误以为「不调它就少了一次刷新」。详情 / 事件的 `fetchDetail` /
  //  `fetchEvents` 别名在各自 query hook（`usePartDetailQuery.ts` /
  //  `usePartEventsQuery.ts`）上，本 composable **不**再转发：真要用就在调用方直接
  //  import 那个 hook，不要把这里扩成一个四件套。
  fetchBatches: () => Promise<void>;

  // ---------- 标签 helpers ----------
  statusLabel: (s: OrderStatus) => string;
  statusTagType: (s: OrderStatus) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
  statusLabelOf: (s: string | null | undefined) => string;
  eventLabel: (t: string) => string;
  eventTagType: (t: string) => 'primary' | 'success' | 'warning' | 'info' | 'danger';

  /**
   * 卸载（关标签页）时清本 composable 自建的 UI 态。
   *
   * ⚠️ **只在 `onUnmounted` 调，不要挂 `onDeactivated`**：本页被 keep-alive 缓存，
   * deactivate 只是切走、组件实例还在（切回来还要看到刚才的数据）。query 缓存由
   * queryClient 统一管（有限 gcTime 5min），本函数不碰。
   */
  reset: () => void;
}

export function usePartDetail(
  partId: MaybeRefOrGetter<string | null | undefined>,
  /**
   * 本页是否仍是当前路由（keep-alive 缓存页必需，默认恒真）。透传给两条 query hook
   * 的 `enabled` 闸门；判据由入口按 `route.name` 提供
   * （见 `./partDetailActive.ts`，与 shell 的 route watcher 共用同一判据）。
   */
  isActive: MaybeRefOrGetter<boolean> = true,
): UsePartDetailReturn {
  const { isManager, isClerk, isInspector, isCncProgrammer: isCnc } = usePermissions();

  // ============ 权限矩阵（逐条对齐后端角色集，见每条的注释）============
  /** 行内编辑 / 取消订单：`POST /parts/{id}/update`、`/parts/{id}/cancel`
   *  → 后端 `part/handler/crud.rs::CRUD_PART_ROLES = [Manager, Clerk]`、
   *  `part/handler/lifecycle.rs::cancel` 的 `[Manager, Clerk]`。 */
  const canEditPart = computed(() => isManager.value || isClerk.value);
  const canCancelPart = computed(() => isManager.value || isClerk.value);
  /** 软删：`POST /parts/{id}/soft-delete` → 后端 `require_role(Role::Manager)`（单角色）。 */
  const canDeletePart = computed(() => isManager.value);
  /**
   * 品检流转（通过 / 打回）：**`[Manager, Inspector]`**。
   *
   * ⚠️ 2026-10-10 修：此前写成 `isManager || isClerk || isInspector`，多给了 CLERK ——
   * 而后端 `prod/batch/handler/transition.rs::TO_XXX_ROLES = &[Role::Manager,
   * Role::Inspector]`，`require_any_role` 在进 service 之前就拒 ⇒ **文员看得到两个品检
   * 按钮，点下去必然 403**。
   *
   * ⚠️ **角色集必须与后端 `TO_XXX_ROLES` 逐字对齐**：这条同时覆盖
   * `POST /prod/batches/{id}/to-ship`、`/to-process`、`/to-inspection` 与对应批量端点
   * （同一个常量）。后端加 / 减角色时这里必须同步改，否则就是「看得到点不动」或
   * 「能点但没人看得到」两种现场症状之一。
   */
  const canInspect = computed(() => isManager.value || isInspector.value);
  /** 图纸 / 3D 模型 / CAD 2D：`POST /part-files`（kind = DRAWING / 3D_MODEL / CAD_2D）
   *  → 后端 `part_file` 域 `[Manager, Clerk, CncProgrammer]`，软删按 kind 派生
   *  `[Manager, Clerk]`。前端取 `[Manager, Clerk]` 是**更严**的一档（宁可不显示按钮，
   * 也不要给一个必 403 的入口）。 */
  const canManageDrawings = computed(() => isManager.value || isClerk.value);
  const canManage3DModels = computed(() => isManager.value || isClerk.value);
  /** G 代码：`POST /part-files/parts/{id}/cnc-programs`（kind = G_CODE）→ 后端
   *  `[Manager, CncProgrammer]`，与前端一致（逐字对齐）。 */
  const canManageCncFiles = computed(() => isManager.value || isCnc.value);
  /** 设定单：`POST /part-files/parts/{id}/setup-sheets`（kind = SETUP_SHEET）→ 后端
   *  `[Manager, CncProgrammer]`，与前端一致。⚠️ 同 kind 的**软删**后端却是
   *  `[Manager, Clerk]`（`handler.rs` 的按-kind 派生表），后端两档不一致；前端按上传
   * 那一档（更严）判，不会给 Clerk 一个后端其实允许、但现场口径也说不清的入口。 */
  const canManageSetupSheet = computed(() => isManager.value || isCnc.value);
  /** 批次管理（拆批 / 取消批次）：`POST /batches/split` 与
   *  `POST /prod/batches/{id}/cancel` → 后端
   *  `prod/batch/service/batch_ops.rs` 两处 `require_any_role([Manager, Clerk])`，
   *  逐字对齐。 */
  const canManageBatches = computed(() => isManager.value || isClerk.value);

  // ============ 主数据（三条 query hook，本文件只做投影）============
  const detailQuery = usePartDetailQuery(partId, isActive);
  const eventsQuery = usePartEventsQuery(partId, isActive);
  // 批次列表**复用共享基础数据层的 `usePartBatchesQuery`**（键 `qk.partBatchesList`）：
  // dashboard 的 PartPreviewDialog 是另一个消费方，同一条键才能同屏去重、失效链也只有
  // 一条。它没有 `isActive` 闸门 —— 入参 partId 是 shell 的**局部 ref**，只由本页那个
  // 带「本页是否活跃」守卫的 route watcher 改，全局路由变化不会传导过来。
  //
  // ⚠️ staleTime 覆盖成 30s（与本页详情 / 事件两条 query 同档），共享档仍是 20min。
  // 批次行在本页不是只读的展示：行状态决定 `inspectionBatch`，也就是「品检通过 / 指定
  // 工序」两个按钮的可点性 ⇒ 看到过期的 INSPECTION 会让人去点一个后端已经用 20103 拒掉
  // 的流转。而其它域（送检 / 工人放回 / 扫码送检 / 外协回收）改的是批次成员资格，那些写
  // 点只失效 `qk.partsPrefix`，**不会**碰 `qk.partBatchesPrefix`（CLAUDE.md「缓存定位」
  // 明确不做跨页面精确失效补齐）⇒ 本页的新鲜度只能靠 staleTime，20min 太长。
  const batchesQuery = usePartBatchesQuery(() => toValue(partId), 30_000);

  const part = computed<PartDetailData | null>(() => detailQuery.data.value ?? null);
  const events = computed<PartEvent[]>(() => eventsQuery.data.value ?? []);
  const batches = computed<PartBatch[]>(() => batchesQuery.data.value?.items ?? []);

  const errorMsg = computed<string>(() => {
    const e = detailQuery.error.value ?? eventsQuery.error.value ?? batchesQuery.error.value;
    return e ? (e.message ?? '加载零件失败') : '';
  });

  /**
   * keep-alive **重新激活**时对已过期的批次列表补一次 refetch。
   *
   * 为什么不挂 `onMounted`：本页被 keep-alive 缓存（路由名 `PartDetail`），第一次进来之后
   * 每次切走再回来都只走 deactivate / activate，`onMounted` 不再跑 ⇒ 挂在它上面只覆盖得了
   * 第一次。`onActivated` 才是 keep-alive 缓存页「每次回来」的钩子。
   *
   * **首次激活刻意不补刷**：那一刻 observer 自己正在按 staleTime 判新鲜度（冷缓存 ⇒ 自动
   * 首调；暖缓存且已过 30s ⇒ `shouldFetchOnMount` 为真同样自动重取），再补一次就是两次
   * 往返（`refetch` 默认 `cancelRefetch`，会把在飞的那次取消掉重发）。所以第一次激活直接
   * 放行，之后每次回来才按 `isStale` 补 —— 这一支与自动首调**不重叠**。
   *
   * 为什么需要它：keep-alive 下组件**不卸载** ⇒ observer 不重新订阅 ⇒ `shouldFetchOnMount`
   * 那条路在回来时压根不会触发，全仓也没有轮询（`refetchInterval` 未设）。补刷挂在
   * `onActivated` 上，是本页唯一的「回来即校验」通道。
   */
  let activatedOnce = false;
  onActivated(() => {
    if (!activatedOnce) {
      activatedOnce = true;
      return;
    }
    if (batchesQuery.isStale.value) void batchesQuery.refetch();
  });

  // ============ 行内编辑（PartInfoCard 读 editing/form）============
  const editing = ref(false);
  const form = reactive<PartEditForm>(makeEmptyEditForm());

  function onStartEdit(): void {
    const p = part.value;
    if (!p) return;
    form.name = p.name;
    form.drawing_no = p.drawing_no;
    form.quantity = p.quantity;
    form.is_urgent = p.is_urgent;
    form.planned_delivery_date = p.planned_delivery_date;
    form.order_no = p.order_no;
    form.system_delivery_date = p.system_delivery_date;
    form.note = p.note;
    editing.value = true;
  }

  function onCancelEdit(): void {
    editing.value = false;
  }

  /**
   * 由 form 归一化出提交载荷。链式 trim 与「空串 → null」在这里做一次（表单里
   * `el-input` 的空串与「后端要 null」不是同一件事），actions 层只负责补 OCC 锚并发起
   * 请求，不重复归一化。
   */
  function buildUpdatePayload(): Omit<PartUpdatePayload, 'version'> {
    return {
      name: form.name.trim(),
      drawing_no: form.drawing_no.trim(),
      quantity: form.quantity,
      is_urgent: form.is_urgent,
      planned_delivery_date: form.planned_delivery_date,
      order_no: form.order_no || null,
      system_delivery_date: form.system_delivery_date || null,
      note: form.note || null,
    };
  }

  // ============ 装配件详情（PartAssemblyLinkCard 用）============
  // 订阅 useCustomersQuery 拿客户全集，用于 enrichAssemblyItem 补全
  // customer_name / parent_customer_name / customer_path。
  // 唯一 queryKey + 30s staleTime 去重窗口，多 subscriber 不触发额外 fetch（共享缓存）。
  const { data: customersData } = useCustomersQuery();

  const assemblyDetail = ref<AssemblyDetail | null>(null);
  const assemblyLoading = ref(false);
  /**
   * 装配件详情**仍是单次手写拉取**，不走 query hook —— `GET /parts/{part_id}/assembly`
   * 在「零件无所属装配件」时返回 `null`（不是 404），端点只被本页消费、且要串一道客户
   * 名的 enrich 才给卡片用；为一个二选一（对象 / null）的响应单开 query hook 不划算。
   * 全页唯一的例外调用，理由登记在此以免后人以为「漏迁」。
   *
   * ⚠️ 端点不是 `GET /assemblies/{part_id}`：`assembly_id` 是 part 的 indirection，
   * 后端 part service 内部按 `part.assembly_id` 找装配件；Network 面板里看到
   * `/assemblies/{asm_id}` 形态的请求就是真 bug。错误 message 里的数字是
   * `part.assembly_id` 列值、不是 URL 里的 part_id。
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

  // ============ 切 partId 时重置本 composable 的 UI 态 ============
  // ⚠️ 不碰 query 缓存：切 id 时 queryKey 自己变了，旧 id 的缓存由有限 gcTime 自然回收。
  watch(
    () => toValue(partId),
    (next) => {
      if (!next) return;
      editing.value = false;
      assemblyDetail.value = null;
    },
  );

  // part 加载后，若有 assembly_id 拉装配件详情
  watch(
    () => part.value?.assembly_id,
    () => {
      void fetchAssembly();
    },
  );

  return {
    // 投影
    part,
    infoLoading: detailQuery.isFetching,
    errorMsg,
    events,
    eventsLoading: eventsQuery.isFetching,
    batches,
    batchesLoading: batchesQuery.isFetching,
    // permissions
    canEditPart,
    canCancelPart,
    canDeletePart,
    canInspect,
    canManageDrawings,
    canManage3DModels,
    canManageCncFiles,
    canManageSetupSheet,
    canManageBatches,
    // 行内编辑
    editing,
    form,
    onStartEdit,
    onCancelEdit,
    buildUpdatePayload,
    // 装配件
    assemblyDetail,
    assemblyLoading,
    fetchAssembly,
    // 刷新别名
    fetchBatches: async () => {
      await batchesQuery.refetch();
    },
    // 标签 helpers
    statusLabel,
    statusTagType,
    statusLabelOf,
    eventLabel,
    eventTagType,
    // 卸载时重置
    reset: () => {
      editing.value = false;
      assemblyDetail.value = null;
    },
  };
}
