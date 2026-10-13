// views/assemblies/composables/useAssemblyDetail.ts
//
// 2026-08-25 frontend-overall-refactor：AssemblyDetail 拆分的 useAssemblyDetail。
// 负责 /assemblies/:id 详情页的所有 page-level 业务：
// - 装配件主信息 fetchData
// - 文件过滤（masterFiles / childDrawingMap）
// - 权限矩阵（cancel / delete / edit-content / add-child / upload-pdf）
// - 编辑元数据（updateAssembly）+ 取消 / 删除
// - 添加子件 + 上传总装 PDF
// - 子件图号点击 → 图纸预览（2026-10-13：首选 CI 转图直链，/content blob 为兜底）
// - 客户列表加载（编辑对话框用）+ 申请人搜索
// - 状态标签 helpers
//
// 设计要点：
// - composable 只持有「业务数据 + 业务函数」；dialog 可见性、FormInstance refs、
//   form 局部数据由 shell 或各 dialog 子组件持有。
// - 所有破坏性操作（cancel / delete / update）返回 Promise<boolean>，
//   由调用方（shell / dialog）根据返回值决定是否关闭 dialog。
// - 出错统一在 composable 内 ElMessage 提示（fetchData 除外——它把 null 留给 shell）；
//   子件添加等业务操作返回 false 时不再二次提示。

import { computed, reactive, ref, watch, watchEffect, type ComputedRef, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { UploadFile, FormRules } from 'element-plus';
import {
  addAssemblyChild,
  cancelAssembly,
  enrichAssemblyItem,
  getAssembly,
  softDeleteAssembly,
  updateAssembly,
  uploadAssemblyPdf,
} from '@/api/assembly';
import { api } from '@/api/http';
import type { Customer } from '@/api/customer';
// 2026-09-26：客户全集改走共享 query useCustomersQuery（CustomerList 写后失效自动 refetch）。
// 原 listCustomers() + ref + loadLeafCustomers() 改走 query 派生；loadLeafCustomers
// 保留 API 兼容（→ query.refetch）。leafCustomers 的「叶子」判据见下方注释。
import { useCustomersQuery } from '@/composables/queries/useCustomersQuery';
import { leafCustomersOf } from '@/api/customer.tree';
import type { PartFileItem } from '@/types/part_file';
import type { Applicant } from '@/types/applicant';
import { useApplicantSearch } from '@/composables/useApplicantSearch';
import { usePermissions } from '@/composables/usePermissions';
import {
  ASSEMBLY_STATUS_LABEL,
  ASSEMBLY_STATUS_TAG_TYPE,
  type AssemblyDetail,
  type AssemblyStatus,
  type AssemblyUpdatePayload,
} from '@/types/assembly';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE, type OrderStatus } from '@/types/parts';

/** 编辑装配件元数据表单（可空字段用空字符串占位，提交时转回 null）。
 *  2026-09-16 PR-2：actual_delivery_date 随 t_assembly 瘦身从表单状态删除。 */
export interface AssemblyEditForm {
  drawing_no: string;
  name: string;
  customer_id: string;
  applicant_name: string;
  applicant_id: string;
  request_date: string;
  planned_delivery_date: string;
  is_urgent: boolean;
}

function makeEmptyEditForm(): AssemblyEditForm {
  return {
    drawing_no: '',
    name: '',
    customer_id: '',
    applicant_name: '',
    applicant_id: '',
    request_date: '',
    planned_delivery_date: '',
    is_urgent: false,
  };
}

/** 添加子件表单。 */
export interface AssemblyAddChildForm {
  drawing_no: string;
  name: string;
  quantity: number;
}

function makeEmptyAddChildForm(): AssemblyAddChildForm {
  return { drawing_no: '', name: '', quantity: 1 };
}

/** 编辑对话框表单规则。 */
export const ASSEMBLY_EDIT_RULES: FormRules = {
  drawing_no: [{ required: true, message: '请输入总图图号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入装配体名称', trigger: 'blur' }],
  customer_id: [{ required: true, message: '请选择客户', trigger: 'change' }],
};

/** 添加子件对话框表单规则。 */
export const ASSEMBLY_ADD_CHILD_RULES: FormRules = {
  drawing_no: [{ required: true, message: '请输入图号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
};

/**
 * 客户 option label 工具（2026-10-17 客户无限层级改造后改为直接读后端字段）。
 *
 * 改前是「二级带父级名前缀」：`parent_name ? "父 / 名" : 名` —— 客户改成任意深度
 * （集团 / 分厂 / 车间 / 班组…）后这拼法必然缺层，第 3 层往下的中间节点整片消失。
 * 现在读 `Customer.customer_path`（后端下发的「第 2 层到叶子、不含 L1」）。
 *
 * 入参收的是**最小结构**而不是 `Customer`：调用方（`AssemblyEditDialog` 的客户下拉）
 * 传的是客户列表项，本函数不该对列表的完整形状提出要求。同时保留 `name` 兜底 ——
 * `customer_path` 是必填键但**值可能是空串**（客户软删 / 父链成环）。
 */
export function formatCustomerOptionLabel(c: { name: string; customer_path: string }): string {
  return c.customer_path || c.name;
}

export interface UseAssemblyDetailReturn {
  // data
  detail: Ref<AssemblyDetail | null>;
  loading: Ref<boolean>;
  /** 仅 master 文件（FileListCard 用） */
  masterFiles: ComputedRef<PartFileItem[]>;
  /** 子件 id → DRAWING 文件映射（点子件图号直接预览） */
  childDrawingMap: ComputedRef<Record<string, PartFileItem>>;
  // permissions
  canCancel: ComputedRef<boolean>;
  canDelete: ComputedRef<boolean>;
  canEditContent: ComputedRef<boolean>;
  canAddChild: ComputedRef<boolean>;
  canUploadTotalPdf: ComputedRef<boolean>;
  // edit form state
  editForm: AssemblyEditForm;
  addChildForm: AssemblyAddChildForm;
  // customer + applicant (edit dialog 用)
  leafCustomers: Ref<Customer[]>;
  loadingCustomers: Ref<boolean>;
  queryApplicants: (qs: string, cb: (items: Applicant[]) => void) => void;
  // fetchers
  fetchData: () => Promise<void>;
  loadLeafCustomers: () => Promise<void>;
  // actions — return Promise<boolean>（true = 业务成功，调用方据此关 dialog）
  /** 2026-09-28：入参去掉 `version` —— OCC 锚点由本函数从
   *  `detail.assembly.version` 注入（展示壳不持 OCC 状态）。 */
  updateAssembly: (payload: Omit<AssemblyUpdatePayload, 'version'>) => Promise<boolean>;
  cancelAssembly: (serialInput: string) => Promise<boolean>;
  deleteAssembly: (serialInput: string) => Promise<boolean>;
  addChild: () => Promise<boolean>;
  uploadPdf: (file: UploadFile) => Promise<boolean>;
  /** 子件图号点击 → 拉原始 PDF Blob（**兜底路径**，首选是 `/preview` 转图直链）。 */
  fetchDrawingBlob: (drawing: PartFileItem) => Promise<string>;
  // helpers
  statusLabel: (s: AssemblyStatus | string) => string;
  statusTagType: (
    s: AssemblyStatus | string,
  ) => 'info' | 'warning' | 'success' | 'danger' | 'primary';
  partStatusLabel: (s: OrderStatus | string) => string;
  partStatusTagType: (
    s: OrderStatus | string,
  ) => 'success' | 'warning' | 'info' | 'danger' | 'primary';
  childRowClass: (row: { is_urgent: boolean }) => string;
  /** 把 detail.assembly 当前值灌进 editForm（openEditDialog 时调） */
  populateEditForm: () => void;
  /** 重置 addChildForm 到默认值 */
  resetAddChildForm: () => void;
}

export function useAssemblyDetail(assemblyId: Ref<string>): UseAssemblyDetailReturn {
  const router = useRouter();
  const { isManager, isClerk } = usePermissions();

  // ============ 权限 ============
  const canCancel = computed(() => isManager.value || isClerk.value);
  const canDelete = computed(() => isManager.value);
  const canEditContent = computed(() => isManager.value || isClerk.value);

  // ============ 主数据 ============
  const detail = ref<AssemblyDetail | null>(null);
  const loading = ref(false);

  // ============ 客户全集（2026-09-29 修复：提到 enrichAssemblyCustomer 之前）
  // 2026-09-26：客户全集改走共享 query；leafCustomers 的判据（真叶子）见上方注释。
  // useQuery 自动 fetch + 缓存会话级，写操作完成后 useCustomersQuery 失效自动 refetch；
  // 错误状态走 query.error 暴露，原 try/catch ElMessage 行为保留。
  const {
    data: customersData,
    isFetching,
    error: customersError,
    refetch: refetchCustomers,
  } = useCustomersQuery();
  // 2026-10-17 客户无限层级：候选必须是**真叶子**（没有任何子节点），判据与后端
  // `assembly/service/crud.rs` → `shared/customer::require_leaf_customer` 同口径
  // （`has_children == false`；拒时回 `20104 BIZ_INVALID_VALUE`，文案「装配件只能挂在
  // 叶子客户上：… 下还有 N 个子节点」）。
  // 旧写法 `parent_id !== null` 在两层树上恰好等价于「叶子」，客户放开任意深度后它
  // 等价于「**除根以外的一切**」—— 第 3 层分厂 / 第 4 层车间都会进下拉，选中即被后端拒。
  // 改用 `api/customer.tree.ts::leafCustomersOf`（按「谁的 parent_id 指向我」反查）。
  const leafCustomers = computed<Customer[]>(() =>
    leafCustomersOf(customersData.value?.items ?? []),
  );
  // 2026-09-26：保留对外 API 兼容 → 派生 isFetching（编辑 dialog 视觉 loading）。
  const loadingCustomers: ComputedRef<boolean> = computed<boolean>(() => isFetching.value);
  // 2026-09-26：保留对外 API（编辑 dialog @open 时调），底层走 query.refetch。
  async function loadLeafCustomers(): Promise<void> {
    await refetchCustomers();
  }

  /** 2026-09-29 修复：按 detail.assembly.customer_id 在 useCustomersQuery
   *  客户全集中查，补全 customer_name / parent_customer_name / customer_path
   *  三字段。child_count 已由 mapper 注入。
   *
   * 2026-09-29 review 第 2 轮 MAJOR-1 / MAJOR-2 修复：
   * - MAJOR-1：enrich 逻辑提到 @/api/assembly.ts 的 `enrichAssemblyItem` 共享
   *   纯函数（PartAssemblyLinkCard 经 usePartDetail.fetchAssembly 走同一函数）。
   * - MAJOR-2：下方新增 `watchEffect` 监听 customersData + detail.value，
   *   customers 缓存 lazy 到达后自动 re-enrich，无需刷新。 */
  function enrichAssemblyCustomer(d: AssemblyDetail): void {
    d.assembly = enrichAssemblyItem(d.assembly, customersData.value?.items ?? []);
  }

  // 2026-09-29 review 第 2 轮 MAJOR-2 修复：响应式 customers 缓存到达。
  // useCustomersQuery 是懒查询，首次进详情页时 customers
  // 可能未加载完（customersData.value 为 undefined），enrich 把 customer_*
  // 置 null 后不会自动 re-trigger。watchEffect 在 customersData 变化时自动
  // 重跑 enrich，确保 detail.value.assembly.customer_path 始终反映最新客户名。
  // 约束：detail.value 为 null 时不跑（避免空 detail 时 enrich 报错）。
  watchEffect(() => {
    const items = customersData.value?.items;
    if (!detail.value) return;
    if (!items) return;
    detail.value.assembly = enrichAssemblyItem(detail.value.assembly, items);
  });

  async function fetchData(): Promise<void> {
    if (!assemblyId.value) return;
    loading.value = true;
    try {
      const fetched = await getAssembly(assemblyId.value);
      enrichAssemblyCustomer(fetched);
      detail.value = fetched;
    } catch (e) {
      detail.value = null;
      ElMessage.error((e as Error).message ?? '加载装配件详情失败');
    } finally {
      loading.value = false;
    }
  }

  // ============ 文件过滤 ============
  const masterFiles = computed<PartFileItem[]>(
    () => (detail.value?.files ?? []).filter((f) => f.kind === 'ASSEMBLY_MASTER') as PartFileItem[],
  );

  const childDrawingMap = computed<Record<string, PartFileItem>>(() => {
    const m: Record<string, PartFileItem> = {};
    for (const f of detail.value?.files ?? []) {
      if (f.kind === 'DRAWING' && f.owner_id) {
        // repository 端 list_for_assembly 已按 id DESC，单 key 直接覆盖（最新一条胜）
        m[f.owner_id] = f as PartFileItem;
      }
    }
    return m;
  });

  // ============ 派生权限 ============
  const canUploadTotalPdf = computed(() => {
    if (!canEditContent.value) return false;
    if (!detail.value) return false;
    if (detail.value.assembly.serial_no) return false; // 已分过 serial 不能再上传
    if (detail.value.files.length > 0) return false;
    if (detail.value.children.length > 0) return false;
    return detail.value.assembly.status === 'PENDING';
  });

  const canAddChild = computed(() => {
    if (!canEditContent.value) return false;
    if (!detail.value) return false;
    return detail.value.assembly.status === 'PENDING';
  });

  // ============ 表单状态 ============
  const editForm = reactive<AssemblyEditForm>(makeEmptyEditForm());
  const addChildForm = reactive<AssemblyAddChildForm>(makeEmptyAddChildForm());

  function populateEditForm(): void {
    if (!detail.value) return;
    const a = detail.value.assembly;
    editForm.drawing_no = a.drawing_no;
    editForm.name = a.name;
    editForm.customer_id = a.customer_id;
    editForm.applicant_name = a.applicant_name ?? '';
    editForm.applicant_id = '';
    editForm.request_date = a.request_date;
    editForm.planned_delivery_date = a.planned_delivery_date;
    editForm.is_urgent = a.is_urgent;
  }

  function resetAddChildForm(): void {
    addChildForm.drawing_no = '';
    addChildForm.name = '';
    addChildForm.quantity = 1;
  }

  // ============ 客户列表 + 申请人搜索（编辑对话框用）============
  // 2026-09-29 修复：customersData / leafCustomers / loadLeafCustomers 已上移到
  // 「主数据」之前（enrichAssemblyCustomer 需用 customersData）。
  // 此处只保留 customersError watch + applicant 搜索。
  // 2026-09-26：useQuery 在 setup 顶层就订阅、自动 fetch；以前 onMounted 触发的
  // loadLeafCustomers 由编辑 dialog @open 取代，composable 不主动触。watch error
  // 弹 ElMessage（与 useCustomerTree / DeliveryNoteScan 同款桥接）。
  watch(
    () => customersError.value,
    (err) => {
      if (err) ElMessage.error(err.message ?? '加载客户列表失败');
    },
  );

  // 装配体的 applicant 解析到一级客户需 detail.customer_id，
  // 但编辑流中 customer 也允许改，这里保持原行为 fallback null。
  const { querySearch: queryApplicants } = useApplicantSearch({
    resolveRootCustomerId: () => null,
  });

  // ============ 业务操作 ============
  /** 2026-09-28 契约修复：在此注入 OCC 锚点 `version`。
   *  后端 `AssemblyUpdateRequest.version: i32` **无 `#[serde(default)]`**，缺字段时
   *  axum `Json` extractor 在 service 之前直接拒 → HTTP 422 `missing field version`。
   *  展示壳（AssemblyEditDialog）只管表单字段，version 属业务层关注点，故在此拼。
   *
   * 2026-09-29 review 第 1 轮 C1 修复：后端 update 响应是 AssemblyOut（19 字段
   * 平铺，无 children / files），不能整体替换 detail.value。改走就地 mutate：
   * 把响应字段覆盖到 detail.value.assembly 对应字段，child_count 用现有
   * detail.value.children.length，customer_* 走 enrichAssemblyCustomer 重算。 */
  async function updateAssemblyFn(
    payload: Omit<AssemblyUpdatePayload, 'version'>,
  ): Promise<boolean> {
    if (!assemblyId.value) return false;
    if (!detail.value) {
      ElMessage.error('装配件信息未加载完成');
      return false;
    }
    try {
      const updated = await updateAssembly(assemblyId.value, {
        ...payload,
        version: detail.value.assembly.version,
      });
      // 就地 mutate：detail.value.assembly 替换字段 + children / files 沿用。
      // child_count 用现有 children 数量（响应不带），customer_* 由 enrich 派生。
      // ⚠️ `customer_path` **不置 null**：响应里就有（mapper 已透传），置 null 会把
      // 后端值抹掉、逼 enrich 走本地 customers 分支；`||` 兜底留给「响应落空串」。
      Object.assign(detail.value.assembly, updated, {
        child_count: detail.value.children.length,
        customer_name: null,
        parent_customer_name: null,
      });
      enrichAssemblyCustomer(detail.value);
      ElMessage.success('已保存');
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 40901) {
        ElMessage.warning('该记录已被他人修改，已为你刷新');
        await fetchData();
        return false;
      }
      ElMessage.error((e as Error).message ?? '保存失败');
      return false;
    }
  }

  /** 2026-09-29 review 第 1 轮 C1 修复：cancel 响应同 update，AssemblyOut 平铺
   *  不带 children / files。改为就地 mutate detail.value.assembly。 */
  async function cancelAssemblyFn(serialInput: string): Promise<boolean> {
    if (!detail.value) return false;
    const a = detail.value.assembly;
    if (!a.serial_no) {
      ElMessage.warning('该装配体暂无序列号，无法执行此操作');
      return false;
    }
    if (serialInput.trim() !== a.serial_no) {
      ElMessage.error('序列号不匹配');
      return false;
    }
    try {
      const updated = await cancelAssembly(a.id);
      // `customer_path` 不置 null（同 update：响应里有，置 null 反而丢掉后端值）。
      Object.assign(detail.value.assembly, updated, {
        child_count: detail.value.children.length,
        customer_name: null,
        parent_customer_name: null,
      });
      enrichAssemblyCustomer(detail.value);
      ElMessage.success('已取消装配件');
      return true;
    } catch (e) {
      ElMessage.error((e as Error).message ?? '操作失败');
      return false;
    }
  }

  async function deleteAssemblyFn(serialInput: string): Promise<boolean> {
    if (!detail.value) return false;
    const a = detail.value.assembly;
    if (!a.serial_no) {
      ElMessage.warning('该装配体暂无序列号，无法执行此操作');
      return false;
    }
    if (serialInput.trim() !== a.serial_no) {
      ElMessage.error('序列号不匹配');
      return false;
    }
    try {
      // 2026-09-28 契约修复：软删 OCC 锚点（后端必填 version）。
      await softDeleteAssembly(a.id, a.version);
      ElMessage.success('已删除');
      router.push('/parts');
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 40901) {
        ElMessage.warning('该记录已被他人修改，请刷新后重试');
        await fetchData();
        return false;
      }
      ElMessage.error((e as Error).message ?? '操作失败');
      return false;
    }
  }

  async function addChildFn(): Promise<boolean> {
    if (!assemblyId.value) return false;
    try {
      await addAssemblyChild(assemblyId.value, {
        drawing_no: addChildForm.drawing_no.trim(),
        name: addChildForm.name.trim(),
        quantity: addChildForm.quantity,
      });
      ElMessage.success('子件已添加');
      resetAddChildForm();
      await fetchData();
      return true;
    } catch (e) {
      ElMessage.error((e as Error).message ?? '添加子件失败');
      return false;
    }
  }

  /** 上传一份总装 PDF（`uploadAssemblyPdf` → `POST /files/objects`，owner_kind=ASSEMBLY
   *  + kind=ASSEMBLY_MASTER）。该端点是纯文件入库：只做 SHA-256 CAS + COS PUT +
   *  INSERT `t_part_file`，**不建任何子件** ⇒ 成功文案只说总装图已保存，子件请另行
   *  添加。响应是单个 `PartFileItem`（detail / children 走 fetchData() 重拉）。 */
  async function uploadPdfFn(file: UploadFile): Promise<boolean> {
    if (!file.raw) return false;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      ElMessage.error('总装文件必须是 .pdf 后缀');
      return false;
    }
    if (!assemblyId.value) return false;
    try {
      await uploadAssemblyPdf(assemblyId.value, file.raw);
      await fetchData();
      ElMessage.success('上传成功：总装 PDF 已保存（子件请单独添加）');
      return true;
    } catch (e) {
      ElMessage.error((e as Error).message ?? '上传总装 PDF 失败');
      return false;
    }
  }

  /**
   * 拉 PDF Blob（子件图号点击 → 预览用）。
   *
   * ⚠️ **2026-10-13 起这是「原始 PDF」兜底路径，不是预览首选**：预览首选是
   * `GET /files/objects/{id}/preview` 的 CI 转图直链（轮询编排见
   * `composables/usePreviewPolling.ts`，在 `AssemblyChildrenTable.vue` 里接）。
   * 本函数仍被两处调用：用户点「查看原始 PDF」，或转图降级（端点不支持 / CI 失败 /
   * 超时）自动兜底。
   *
   * ⚠️ **入参是文件对象，不是装配件**：这里的 `files[]` 来自 `GET /assemblies/{id}`
   * 详情响应，owner 是 PART（子件）或 ASSEMBLY（总装图），但预览端点与 `/content`
   * 都只认**文件对象 id**，owner 语义由后端按文件行自己解析 —— 前端只管传 `drawing.id`，
   * 装配件侧不需要另开一条预览链路。
   *
   * 调用方负责 URL.revokeObjectURL 释放（onDrawingPreviewClosed）。
   */
  async function fetchDrawingBlob(drawing: PartFileItem): Promise<string> {
    // 文件内容走 v2 /files/objects/{id}/content（2026-10-13 files 域重组后）
    const resp = await api.get<Blob>(`/files/objects/${drawing.id}/content`, {
      responseType: 'blob',
    });
    return URL.createObjectURL(resp.data);
  }

  // ============ 状态标签 helpers ============
  function statusLabel(s: AssemblyStatus | string): string {
    return ASSEMBLY_STATUS_LABEL[s as AssemblyStatus] ?? String(s);
  }
  function statusTagType(
    s: AssemblyStatus | string,
  ): 'info' | 'warning' | 'success' | 'danger' | 'primary' {
    return ASSEMBLY_STATUS_TAG_TYPE[s as AssemblyStatus] ?? 'info';
  }
  function partStatusLabel(s: OrderStatus | string): string {
    return ORDER_STATUS_LABEL[s as OrderStatus] ?? String(s);
  }
  function partStatusTagType(
    s: OrderStatus | string,
  ): 'success' | 'warning' | 'info' | 'danger' | 'primary' {
    return ORDER_STATUS_TAG_TYPE[s as OrderStatus] ?? 'info';
  }
  function childRowClass(row: { is_urgent: boolean }): string {
    return row.is_urgent ? 'row-urgent' : '';
  }

  // 切 assemblyId 时重置
  watch(
    assemblyId,
    () => {
      detail.value = null;
    },
    { immediate: true },
  );

  return {
    // data
    detail,
    loading,
    masterFiles,
    childDrawingMap,
    // permissions
    canCancel,
    canDelete,
    canEditContent,
    canAddChild,
    canUploadTotalPdf,
    // forms
    editForm,
    addChildForm,
    populateEditForm,
    resetAddChildForm,
    // customer + applicant
    leafCustomers,
    loadingCustomers,
    queryApplicants,
    // fetchers
    fetchData,
    loadLeafCustomers,
    // actions
    updateAssembly: updateAssemblyFn,
    cancelAssembly: cancelAssemblyFn,
    deleteAssembly: deleteAssemblyFn,
    addChild: addChildFn,
    uploadPdf: uploadPdfFn,
    fetchDrawingBlob,
    // helpers
    statusLabel,
    statusTagType,
    partStatusLabel,
    partStatusTagType,
    childRowClass,
  };
}
