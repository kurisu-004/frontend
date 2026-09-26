// views/parts/list/composables/usePartInlineEdit.ts
//
// 2026-08-22 从 PartsList.vue 抽出：行内编辑（editBuffer / startEdit / saveEdit / cancelEdit）
// + 申请人 autocomplete 集成 + Enter/Esc 键盘监听。
//
// 删死代码 `applicantEditingReady`（已 grep 确认模板未用）。
//
// 2026-09-26 重构（B 任务）：saveEdit 包 useMutation。
//   - mutationFn: 根据 row.row_type 分发 updateAssembly / updatePart；
//   - onSuccess: 保留就地 Object.assign(row, ...) 回填（不整表刷新，无闪烁）；
//   - onError: 命中 40901 BIZ_VERSION_CONFLICT → ElMessage.warning + 整表 invalidate；
//     其它 → ElMessage.error；
//   - fetchList dep 删除（M-2 修复）：40901 触发整表刷新走
//     qc.invalidateQueries({queryKey: qk.partsPrefix})；正常编辑走就地 Object.assign
//     回填（不调 fetchList）。原 fetchList dep 是过渡期兼容位，store 装配时
//     已不再传（usePartsListStore.ts:86-93），本 composable 也不读，留着只是
//     noise 与潜在类型漂移源。

import { computed, onBeforeUnmount, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { SummaryMethod } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { updatePart, type PartUpdatePayload } from '@/api/parts';
import { updateAssembly } from '@/api/assembly';
import { useApplicantSearch } from '@/composables/useApplicantSearch';
import { qk } from '@/composables/queries/keys';
import type { PartListItem } from '@/types/parts';
import type { Applicant } from '@/types/applicant';
import type { CustomerCascaderNode } from '@/composables/useCustomerTree';

/** 2026-08-22：行内编辑缓冲区 shape。 */
export interface EditBuffer {
  name: string;
  drawing_no: string;
  applicant_name: string;
  quantity: number;
  unit_price: number;
  request_date: string;
  planned_delivery_date: string;
  system_delivery_date: string | null;
  order_no: string | null;
  note: string | null;
  is_urgent: boolean;
}

export interface UsePartInlineEditDeps {
  /** 2026-09-26（B 任务）：放宽到 ComputedRef<PartListItem[]> —— usePartsListQuery
   *  items 已改 ComputedRef；按地址读数组 + Object.assign 行对象（行对象引用稳定），
   *  Readonly / Computed 都 OK。 */
  items: ComputedRef<PartListItem[]>;
  customerTree: Ref<CustomerCascaderNode[]>;
  /** MANAGER / CLERK 行内编辑可见 */
  canEdit: boolean;
  /** 是否处于批量模式（双击行不进编辑） */
  isBatchMode: () => boolean;
}

/** 2026-09-21 显式返回类型。 */
export interface UsePartInlineEditReturn {
  editingId: Ref<string | null>;
  /** 2026-09-26（B 任务）：savingEdit 改为 ComputedRef<boolean>（派生自 mutation.isPending）。 */
  savingEdit: ComputedRef<boolean>;
  editBuffer: EditBuffer;
  startEdit: (row: PartListItem) => void;
  cancelEdit: () => void;
  saveEdit: (row: PartListItem) => Promise<void>;
  onRowDblClick: (row: PartListItem) => void;
  displayTotalPrice: (row: PartListItem) => string;
  totalPriceSummary: SummaryMethod<PartListItem>;
  applicantSuggest: (queryString: string, callback: (items: Applicant[]) => void) => void;
  applicantLoading: Ref<boolean>;
  resolveRootCustomerForRow: (row: PartListItem) => string | null;
}

export function usePartInlineEdit(deps: UsePartInlineEditDeps): UsePartInlineEditReturn {
  const editingId = ref<string | null>(null);
  const qc = useQueryClient();
  const editBuffer = reactive<EditBuffer>({
    name: '',
    drawing_no: '',
    applicant_name: '',
    quantity: 1,
    unit_price: 0,
    request_date: '',
    planned_delivery_date: '',
    system_delivery_date: null,
    order_no: null,
    note: null,
    is_urgent: false,
  });

  // ============ 申请人补全（PR-2026-08-20） ============
  // 行内编辑态下复用 PartBatchNew/AssemblyCreate 的同款 useApplicantSearch，按
  // 「当前编辑行所在客户」懒加载申请人全集。PartListItem 不含 customer_id，
  // 只能按 customer_name 在 customerTree 里反查一级客户 id。
  const {
    loading: applicantLoading,
    loadForCustomer,
    querySearch,
  } = useApplicantSearch({
    resolveRootCustomerId: (pickedId: string | null): string | null => {
      if (!pickedId) return null;
      const walk = (nodes: CustomerCascaderNode[]): string | null => {
        for (const n of nodes) {
          if (String(n.id) === pickedId) return String(n.id);
          const found = walk(n.children ?? []);
          if (found) return found;
        }
        return null;
      };
      return walk(deps.customerTree.value);
    },
  });

  /** 2026-08-20：按 PartListItem.customer_name 在 customerTree 中反查到一级客户 id。 */
  function resolveRootCustomerForRow(row: PartListItem): string | null {
    const name = row.customer_name;
    if (!name) return null;
    const walk = (nodes: CustomerCascaderNode[], rootId: string): string | null => {
      for (const n of nodes) {
        if (n.name === name) return rootId;
        const found = walk(n.children ?? [], rootId);
        if (found !== null) return found;
      }
      return null;
    };
    for (const root of deps.customerTree.value) {
      const found = walk(root.children ?? [], String(root.id));
      if (found !== null) return found;
    }
    return null;
  }

  /** 2026-08-20：el-autocomplete :fetch-suggestions 期望 (q, cb) => void 签名 */
  function applicantSuggest(queryString: string, callback: (items: Applicant[]) => void): void {
    querySearch(queryString, callback);
  }

  // ============ 编辑生命周期 ============
  function startEdit(row: PartListItem): void {
    if (editingId.value && editingId.value !== row.id) {
      ElMessage.warning('请先保存或取消当前正在编辑的行');
      return;
    }
    editBuffer.name = row.name;
    editBuffer.drawing_no = row.drawing_no;
    editBuffer.applicant_name = row.applicant_name ?? '';
    editBuffer.quantity = row.quantity;
    editBuffer.unit_price = row.unit_price;
    editBuffer.request_date = row.request_date;
    editBuffer.planned_delivery_date = row.planned_delivery_date;
    editBuffer.system_delivery_date = row.system_delivery_date;
    editBuffer.order_no = row.order_no;
    editBuffer.note = row.note;
    editBuffer.is_urgent = row.is_urgent;
    editingId.value = row.id;
    // 2026-08-20：申请人 autocomplete 按行所在客户懒加载全集。
    void loadForCustomer(resolveRootCustomerForRow(row));
  }

  function cancelEdit(): void {
    editingId.value = null;
  }

  // 2026-09-26（B 任务）：saveEdit 包 useMutation —— mutationFn 根据 row_type 分发
  // updateAssembly / updatePart；onSuccess 保留就地 Object.assign 回填（无整表刷新）；
  // onError 40901 BIZ_VERSION_CONFLICT → ElMessage.warning + 整表 invalidate。
  interface SaveEditVars {
    row: PartListItem;
    payload: PartUpdatePayload;
  }
  const saveEditMutation = useMutation<unknown, Error, SaveEditVars>({
    mutationKey: ['parts', 'inline-edit', 'save'],
    mutationFn: ({ row, payload }) => {
      if (row.row_type === 'ASSEMBLY') return updateAssembly(row.id, payload);
      return updatePart(row.id, payload);
    },
    onSuccess: (_data, { row, payload }) => {
      // 就地回填该行（避免整表刷新闪烁）
      Object.assign(row, {
        name: payload.name,
        drawing_no: payload.drawing_no,
        applicant_name: payload.applicant_name ?? null,
        quantity: payload.quantity ?? row.quantity,
        unit_price: payload.unit_price ?? row.unit_price,
        request_date: payload.request_date ?? row.request_date,
        planned_delivery_date: payload.planned_delivery_date ?? row.planned_delivery_date,
        system_delivery_date: payload.system_delivery_date ?? null,
        order_no: payload.order_no ?? null,
        note: payload.note ?? null,
        is_urgent: payload.is_urgent ?? row.is_urgent,
      });
      editingId.value = null;
      ElMessage.success('保存成功');
    },
    onError: (e) => {
      // 40901 = BIZ_VERSION_CONFLICT（乐观锁冲突）；装配件 update 不发 409，
      // 但保留分支以兼容未来 OCC 接入。
      if ((e as { code?: number }).code === 40901) {
        ElMessage.warning('该记录已被他人修改，已为你刷新列表');
        editingId.value = null;
        // 整表刷新：让 next useQuery 自动重拉最新数据
        qc.invalidateQueries({ queryKey: qk.partsPrefix });
      } else {
        ElMessage.error(e.message ?? '保存失败');
      }
    },
  });

  const savingEdit = computed<boolean>(() => saveEditMutation.isPending.value);

  async function saveEdit(row: PartListItem): Promise<void> {
    const name = editBuffer.name.trim();
    const drawingNo = editBuffer.drawing_no.trim();
    if (!name) {
      ElMessage.warning('名称不能为空');
      return;
    }
    if (!drawingNo) {
      ElMessage.warning('图号不能为空');
      return;
    }
    if (!editBuffer.request_date) {
      ElMessage.warning('请购日期不能为空');
      return;
    }
    if (!editBuffer.planned_delivery_date) {
      ElMessage.warning('计划交期不能为空');
      return;
    }
    if (editBuffer.quantity == null || editBuffer.quantity < 1) {
      ElMessage.warning('数量必须 ≥ 1');
      return;
    }
    const payload: PartUpdatePayload = {
      name,
      drawing_no: drawingNo,
      applicant_name: editBuffer.applicant_name.trim(),
      quantity: editBuffer.quantity,
      unit_price: editBuffer.unit_price,
      request_date: editBuffer.request_date,
      planned_delivery_date: editBuffer.planned_delivery_date,
      system_delivery_date: editBuffer.system_delivery_date || null,
      order_no: editBuffer.order_no || null,
      note: editBuffer.note || null,
      is_urgent: editBuffer.is_urgent,
    };
    saveEditMutation.mutate({ row, payload });
  }

  // 2026-07-24：双击行进入编辑（仅 MANAGER/CLERK + 非批量模式）
  function onRowDblClick(row: PartListItem): void {
    if (!deps.canEdit) return;
    if (deps.isBatchMode()) return;
    startEdit(row);
  }

  // 2026-07-24 v2：总价列响应式显示（编辑态用 editBuffer，非编辑态用 row）
  function displayTotalPrice(row: PartListItem): string {
    if (editingId.value === row.id) {
      const q = Number(editBuffer.quantity ?? row.quantity);
      const p = Number(editBuffer.unit_price ?? row.unit_price);
      return Number.isFinite(q) && Number.isFinite(p) ? (q * p).toFixed(2) : '—';
    }
    const q = Number(row.quantity);
    const p = Number(row.unit_price);
    return Number.isFinite(q) && Number.isFinite(p) ? (q * p).toFixed(2) : '—';
  }

  // 2026-07-24 v2：表格底部合计行（仅总价列求和）
  const totalPriceSummary: SummaryMethod<PartListItem> = ({ columns, data }) => {
    return columns.map((col, index) => {
      if (col.label === '总价') {
        const total = data.reduce((sum, row) => {
          const q = Number(row.quantity ?? 0);
          const p = Number(row.unit_price ?? 0);
          return sum + (Number.isFinite(q) && Number.isFinite(p) ? q * p : 0);
        }, 0);
        return total.toFixed(2);
      }
      if (index === 0) return '合计';
      return '';
    });
  };

  // ============ 键盘监听（Enter 保存 / Esc 取消） ============
  // 黑名单：搜索框（.filter-card）/ 日期 picker / 下拉 popper
  const ENTER_BLACKLIST = [
    '.filter-card',
    '.el-popper.is-light',
    '.el-select-dropdown',
    '.el-tree-select__popper',
    '.el-cascader__dropdown',
    '.el-date-picker',
  ];
  function onEditEnter(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (editingId.value == null) return;
      const target = e.target as HTMLElement | null;
      if (target && ENTER_BLACKLIST.some((sel) => target.closest(sel))) return;
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key !== 'Enter') return;
    if (editingId.value == null) return;
    const target = e.target as HTMLElement | null;
    if (target && ENTER_BLACKLIST.some((sel) => target.closest(sel))) return;
    e.preventDefault();
    const row = deps.items.value.find((r) => r.id === editingId.value);
    if (row) void saveEdit(row);
  }

  watch(editingId, (val) => {
    if (typeof document === 'undefined') return;
    if (val != null) {
      document.addEventListener('keydown', onEditEnter);
    } else {
      document.removeEventListener('keydown', onEditEnter);
    }
  });

  onBeforeUnmount(() => {
    if (typeof document === 'undefined') return;
    document.removeEventListener('keydown', onEditEnter);
  });

  return {
    editingId,
    savingEdit,
    editBuffer,
    startEdit,
    cancelEdit,
    saveEdit,
    onRowDblClick,
    displayTotalPrice,
    totalPriceSummary,
    applicantSuggest,
    applicantLoading,
    // 暴露供 usePartDispatch / PartsList 内联调用
    resolveRootCustomerForRow,
  };
}

// 让 TypeScript 在外部推断时拿得到 Ref 形状
import type {} from 'vue';
