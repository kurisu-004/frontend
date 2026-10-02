// views/parts/list/composables/usePartInlineEdit.ts
//
// 2026-08-22 从 PartsList.vue 抽出：行内编辑（editBuffer / startEdit / saveEdit / cancelEdit）
// + 申请人 autocomplete 集成 + Enter/Esc 键盘监听。
//
// 删死代码 `applicantEditingReady`（已 grep 确认模板未用）。
//
// 2026-09-26 重构（B 任务）：saveEdit 包 useMutation。
//   - mutationFn: 根据 row.row_type 分发 updateAssembly / updatePart；
//   - onSuccess: 失效 parts 域（整表 refetch，与同域 usePartDispatch 逐字对齐）；
//   - onError: 命中 40901 BIZ_VERSION_CONFLICT → ElMessage.warning + 整表 invalidate；
//     其它 → ElMessage.error；
//   - fetchList dep 删除（M-2 修复）：40901 触发整表刷新走
//     qc.invalidateQueries({queryKey: qk.partsPrefix})；正常编辑走同一条失效路径。
//     原 fetchList dep 是过渡期兼容位，store 装配时
//     已不再传（usePartsListStore.ts:86-93），本 composable 也不读，留着只是
//     noise 与潜在类型漂移源。
//
// 2026-09-28 契约修复（修「修改工单报 422 missing field `version`」）：
//   - 后端 PartUpdateRequest / AssemblyUpdateRequest 的 `version: i32` 均**无
//     `#[serde(default)]`**，缺字段时 axum `Json` extractor 在 service 之前直接拒
//     （HTTP 422，非项目统一信封）。前端 payload 此前从不带 version → part 与
//     assembly 两条分支**恒 422**（行内编辑完全不可用）。
//   - saveEdit 带 `version: row.version`（OCC 锚点，PartListItem.version 由
//     partSchema parse 填充）。
//   - assembly 分支改为条件展开 unit_price / total_price：三态
//     `Option<Option<Decimal>>` 下发 `null` = 置 NULL，而 t_assembly 这两列
//     NOT NULL → 23502 → 500（此前被 422 掩盖）。
//
// 2026-10-02 根因修复（「编辑后控制台刷 Set operation on key "version" failed:
// target is readonly」+「改完不重新拉数据，必须手动刷新」）：
//   本文件此前在 onSuccess 里做**就地回填** `Object.assign(row, {...})`（含
//   version / total_price 回写），并在注释里论证「不整表刷新，无闪烁」。该论证
//   建立在一个**事实错误**的前提上 —— 「行对象引用稳定 ⇒ 可写」。实际上
//   `deps.items` 的数据源是 @tanstack/vue-query 的 useQuery data，vue-query 对它
//   套了 `readonly(state)` 深只读代理（node_modules/@tanstack/vue-query/build/
//   modern/useBaseQuery.js:77-78，本仓未开 shallow: true）。Vue 3.5 的
//   `ReadonlyReactiveHandler.set` 对**每个** key 都 warn 并丢弃（无 hadKey 豁免），
//   ⇒ Object.assign 的 13 个 key 一个都写不进去，`version` 只是最后一条 warn。
//   已排除 Zod / Object.freeze / deepReadonly 等其它 readonly 来源（全仓零命中）。
//   雪上加霜的是 onSuccess **没有任何失效 / refetch / setQueryData**：就地回填
//   与 refetch 两条路同时断掉，所以用户必须手动刷新才能看到自己的修改。
//   修法：删掉注定 100% 失效的就地回填（它还掩盖了「onSuccess 缺失效」这个真正
//   的 bug），onSuccess 改走 `qc.invalidateQueries({queryKey: qk.partsPrefix})`
//   —— 与同域 `usePartDispatch.ts:159-162` 的 mutation onSuccess 结构逐字对齐。
//   `qk.partsPrefix` = ['parts']，本页主查询键 `qk.unionList(params)` =
//   ['parts','union-list',params] 前缀命中，键不用动；query 处于 active 状态，
//   invalidate 走后台 refetch，data 不清空，无白屏闪烁。
//   失效后 refetch 回来的行自带后端 +1 的新 `version`，故 2026-09-28 起那条
//   「不回写 version 则同一行第二次保存必撞 40901 假冲突」的隐患**由失效覆盖**，
//   readResponseVersion 随之成为死代码删除。

import { computed, onBeforeUnmount, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { SummaryMethod } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { updatePart, type PartUpdatePayload } from '@/api/parts';
import { updateAssembly } from '@/api/assembly';
import type { AssemblyUpdatePayload } from '@/types/assembly';
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
  /** 2026-09-27 前后端字段对齐：unit_price 改 string（与后端 rust_decimal::Decimal
   *  序列化对齐），不再前端做 Number() 转换。 */
  unit_price: string;
  request_date: string;
  planned_delivery_date: string;
  system_delivery_date: string | null;
  order_no: string | null;
  note: string | null;
  is_urgent: boolean;
}

export interface UsePartInlineEditDeps {
  /** 2026-09-26（B 任务）：放宽到 ComputedRef<PartListItem[]> —— usePartsListQuery
   *  items 已改 ComputedRef。
   *  2026-10-02 订正旧注释：原文写「按地址读数组 + Object.assign 行对象（行对象
   *  引用稳定），Readonly / Computed 都 OK」—— **这句是错的**，「引用稳定 ≠ 可写」。
   *  数据源是 @tanstack/vue-query 的 useQuery data，vue-query 对它套了
   *  `readonly(state)` **深**只读代理（本仓未开 `shallow: true`），
   *  ⇒ 数组本身可读（`.find` / `.length` 正常）但**行对象上任何 key 都写不进**，
   *  Vue 会对每次写操作发 `[Vue warn] Set operation on key ... target is readonly`。
   *  本 composable 2026-10-02 起不再就地写行对象，写完一律走
   *  `qc.invalidateQueries({queryKey: qk.partsPrefix})` 让后端数据回流。 */
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
    // 2026-09-27：unit_price 改 string，初值用 '0' 占位。
    unit_price: '0',
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

  // ============ 行内编辑（OCC version + 总价派生）============

  /** 2026-09-28：总价 = quantity * unit_price。
   *  后端 `part_sql.rs::update_part` / `assembly/service/crud.rs::update_assembly`
   *  均**不重算**（只写 caller 传的值），故必须前端算。中间量走「分」整数
   *  避免浮点误差（0.1 * 3 = 0.30000000000000004）。unit_price 为空串 / 非法串时
   *  归一为 0 —— 空串会让后端 `Decimal::from_str("")` 抛错（40001）。 */
  function deriveTotalPrice(quantity: number, unitPrice: string): string {
    const price = parseFloat(unitPrice);
    const priceCents = Number.isFinite(price) ? Math.round(price * 100) : 0;
    return (Math.round(quantity * priceCents) / 100).toFixed(2);
  }

  // 2026-09-26（B 任务）：saveEdit 包 useMutation —— mutationFn 根据 row_type 分发
  // updateAssembly / updatePart。
  // 2026-10-02：onSuccess 由「就地 Object.assign 回填」改为「失效 parts 域」。
  // 起因见文件头：deps.items 是 vue-query 深只读代理，就地写 100% 失效（每次还
  // 刷一条 [Vue warn]），而当时 onSuccess 又没有失效/refetch/setQueryData，
  // 导致「改完必须手动刷新」。结构与同域 usePartDispatch.ts:159-162 逐字对齐。
  // 失效后 refetch 回来的行自带后端 +1 的新 version 与新 total_price，
  // 2026-09-28 起「不回写 version 则第二次保存假冲突」的隐患由失效覆盖。
  interface SaveEditVars {
    row: PartListItem;
    payload: PartUpdatePayload;
  }
  const saveEditMutation = useMutation<unknown, Error, SaveEditVars>({
    mutationKey: ['parts', 'inline-edit', 'save'],
    mutationFn: ({ row, payload }) => {
      if (row.row_type === 'ASSEMBLY') {
        // 2026-09-28 契约修复（此前整条分支恒 422）：
        // 1) 补 version —— 后端 AssemblyUpdateRequest.version 无 serde(default)，
        //    缺字段被 axum Json extractor 在 service 之前拒。
        // 2) unit_price / total_price **绝不能发 null**：后端是三态
        //    Option<Option<Decimal>>，null 解成 Some(None) → SQL `col = NULL`，
        //    而 t_assembly 这两列是 NOT NULL → Postgres 23502 → HTTP 500。
        //    故用条件展开：有值才带 key，「不动」就省略。
        // 3) M2 收尾遗留：assembly 域未加 serde-with-str，JSON number 形态，
        //    EditBuffer / PartUpdatePayload 是 string，显式 string → number 转换。
        const { total_price, unit_price, ...rest } = payload;
        const assemblyPayload: AssemblyUpdatePayload = {
          ...rest,
          ...(unit_price == null ? {} : { unit_price: Number(unit_price) }),
          ...(total_price == null ? {} : { total_price: Number(total_price) }),
        };
        return updateAssembly(row.id, assemblyPayload);
      }
      return updatePart(row.id, payload);
    },
    onSuccess: async () => {
      // 2026-10-02 根因修复：失效整个 parts 域，让后端数据回流。
      // 键：qk.partsPrefix = ['parts']，本页主查询键 qk.unionList(params) =
      // ['parts','union-list',params] 前缀命中（前缀匹配），**键不用动**。
      // query 处于 active 状态 ⇒ invalidate 走后台 refetch，data 不会先被清空，
      // 页面无白屏闪烁（与「不整表刷新」的原诉求不冲突）。
      // 失效同时解决了三件事：
      //   ① 行内修改可见（此前两条路都断，用户必须手动刷新）；
      //   ② version 回流（后端每次 UPDATE version + 1）——不回写则同一行第二次
      //      保存必撞 40901 假冲突；
      //   ③ total_price 回流（由前端派生下发、后端不重算）。
      await qc.invalidateQueries({ queryKey: qk.partsPrefix });
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
    // 2026-09-28 契约修复：unit_price 空串 / 非法串归一为 '0'（后端
    // Decimal::from_str("") 会 40001），并按 quantity * unit_price 派生 total_price
    // 一并下发（后端 update 不重算总价）。
    const rawPrice = editBuffer.unit_price.trim();
    const unitPrice = rawPrice !== '' && Number.isFinite(parseFloat(rawPrice)) ? rawPrice : '0';
    const payload: PartUpdatePayload = {
      // 2026-09-28 契约修复：OCC 锚点（后端 PartUpdateRequest.version 必填，
      // 缺则 422）。取自 PartListItem.version（= t_part.version，由 partSchema parse）。
      version: row.version,
      name,
      drawing_no: drawingNo,
      applicant_name: editBuffer.applicant_name.trim(),
      quantity: editBuffer.quantity,
      unit_price: unitPrice,
      total_price: deriveTotalPrice(editBuffer.quantity, unitPrice),
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

  // 2026-07-24 v2：表格底部合计行（仅总价列求和）。
  // 2026-09-27：unit_price 改 string；改走 parseFloat 与编辑态对齐。
  const totalPriceSummary: SummaryMethod<PartListItem> = ({ columns, data }) => {
    return columns.map((col, index) => {
      if (col.label === '总价') {
        const total = data.reduce((sum, row) => {
          const q = Number(row.quantity ?? 0);
          const p = parseFloat(row.unit_price ?? '0');
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
    totalPriceSummary,
    applicantSuggest,
    applicantLoading,
    // 暴露供 usePartDispatch / PartsList 内联调用
    resolveRootCustomerForRow,
  };
}

// 让 TypeScript 在外部推断时拿得到 Ref 形状
import type {} from 'vue';
