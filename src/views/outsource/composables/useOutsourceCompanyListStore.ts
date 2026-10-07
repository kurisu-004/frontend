// src/views/outsource/composables/useOutsourceCompanyListStore.ts
//
// 2026-10-09 新建：外协厂一览页的 Pinia setup store。形态照
// `views/inspection/composables/useInspectionListStore.ts`（同域 query hook + 切片形态 +
// restoreState 末尾开闸的那一套）。
//
// 不变量（改动前必读，抄自 usePartsListStore）：
// 1. 必须在 OutsourceList.vue 的 setup 内首调 —— 切片链路上的 useColumnVisibility /
//    useColumnDrag / useProcessesQuery 的 onBeforeUnmount 会绑到首个创建 store 的组件。
// 2. OutsourceList 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，不 dispose
//    会把 search / 分页 / 对话框态泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问、不写
//    .value（深代理自动解包）。store 内部闭包持 raw 切片，照写 .value —— 两个访问面落
//    同一批 ref，无双写分裂。
// 4. 不 import vue-router：去对账页的导航留壳（store 需能在 node 单测里无 router 实例化）。
//
// 2026-10-09 契约对齐两处（对齐依据见 `outsourceListSchema.ts` 文件头的登记表）：
//   - 编辑保存**必传 `version`**（`POST /{id}/update` 的 OCC 锚，缺省是 HTTP 422 纯文本）；
//   - 工序能力清单的保存并进同一次 update（`process_ids` 三态：不动 / 清空 / 整体替换）。

import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  createOutsourceCompany,
  getOutsourceCompany,
  softDeleteOutsourceCompany,
  updateOutsourceCompany,
} from '@/api/outsource';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { useConfirm } from '@/composables/useConfirm';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import { buildOutsourceCompanyColumnDefs } from '../outsourceCompanyColumnDefs';
import type { OutsourceCompanySchema } from './outsourceListSchema';
import {
  makeNativeBoolFilter,
  useOutsourceColumnFilters,
  type OutsourceTextFilter,
} from './useOutsourceColumnFilters';
import {
  invalidateOutsourceCompaniesAll,
  useOutsourceCompaniesQuery,
} from './useOutsourceCompaniesQuery';
import type { Process } from '@/types/process';

/** 本页的 search shape（表头筛选的唯一状态源）。 */
export interface OutsourceCompanySearchState {
  /** 公司名 ILIKE 子串（后端 `name_like`）。 */
  name_like: string;
  /** 启用 / 停用三态：undefined = 不过滤。 */
  is_active: boolean | undefined;
}

function initialSearch(): OutsourceCompanySearchState {
  return { name_like: '', is_active: undefined };
}

/** 对话框表单（基础字段 + 工序勾选，一次保存）。 */
interface CompanyFormState {
  name: string;
  contact_name: string;
  contact_phone: string;
  address: string;
  is_active: boolean;
  process_ids: string[];
}

function initialForm(): CompanyFormState {
  return {
    name: '',
    contact_name: '',
    contact_phone: '',
    address: '',
    is_active: true,
    process_ids: [],
  };
}

export const useOutsourceCompanyListStore = defineStore('outsource-company-list', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();
  const { dangerous: confirmDangerous } = useConfirm();

  // ============ 切片：query（分页 / 筛选 / 主查询）============
  const search = reactive<OutsourceCompanySearchState>(initialSearch());
  const page = ref(1);
  const pageSize = ref(100);
  // enabled 闸门：默认 false，restoreState() 末尾开闸，避免「默认 search 首屏 + 持久化
  // search 再屏」双 fetch。
  const restored = ref(false);

  /** search + 分页 → queryKey params 的**唯一**转换点。 */
  function buildParams() {
    return {
      name_like: search.name_like.trim() || undefined,
      is_active: search.is_active,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  const listQuery = useOutsourceCompaniesQuery({
    params: computed(() => buildParams()),
    enabled: restored,
  });
  const { fetchList } = listQuery;

  const items = computed<OutsourceCompanySchema[]>(() => listQuery.data.value?.items ?? []);
  const total = computed<number>(() => Number(listQuery.data.value?.total ?? 0));
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const emptyText = computed<string>(() => errorMsg.value ?? '暂无外协公司');

  /** 表头筛选 confirm 的统一入口（页码拨回 1）。改 search 不动 page 会停在
   *  「第 5 页但只有 1 页结果」的空态。 */
  function onSearch(): void {
    page.value = 1;
  }

  // ============ 切片：filters（表头筛选状态机）============
  const { makeTextFilter } = useOutsourceColumnFilters({ search, onSearch });
  const nameFilter: OutsourceTextFilter = makeTextFilter('name_like');
  // 状态列走 EP 原生 `:filters`（两态），`filteredValue` 由 search 派生。
  const activeBool = makeNativeBoolFilter({ search, onSearch }, {
    key: 'is_active',
    trueLabel: '启用',
    falseLabel: '停用',
  });
  const activeFilter = activeBool.filter;

  /** 工具栏「重置筛选」：同时清「已确认值 + 未确认草稿 + popover 打开态」。
   *  只清 search 不够 —— popover 正开着时点重置，active 会转 false 但草稿还在，
   *  用户下次点「确定」又把旧值写回去。
   *  **保留**排序与每页条数（它们是「视图」不是「筛选」，同 usePartsListStore 的取舍）。 */
  function resetAllFilters(): void {
    nameFilter.reset();
    search.is_active = undefined;
    page.value = 1;
  }

  // EP 的 `filter-change` 只上报本次变更的那一列 ⇒ 逐列判断命中哪条翻译器。
  function onNativeFilterChange(payload: Record<string, string[]>): void {
    activeBool.applyNativeChange(payload);
  }

  // 持久化：筛选（不持久化 page —— 恢复时可能停在一个不存在的页）。
  const { restore: restorePersist } = useListStatePersist('outsource_company_list', { search });

  function restoreState(): void {
    const persisted = restorePersist() as
      | { search?: Partial<OutsourceCompanySearchState> }
      | null
      | undefined;
    if (persisted?.search) {
      // lenient 逐字段恢复：旧快照（迁表头前）只有 name_like / is_active，缺字段落回默认。
      search.name_like = persisted.search.name_like ?? search.name_like;
      const restoredActive = persisted.search.is_active;
      search.is_active = restoredActive === true || restoredActive === false ? restoredActive : undefined;
    }
    // 开闸放行首屏 fetch。
    restored.value = true;
  }

  const query = {
    search,
    page,
    pageSize,
    items,
    total,
    loading,
    errorMsg,
    emptyText,
    onSearch,
    resetAllFilters,
    onNativeFilterChange,
    restoreState,
    fetchList,
  };

  // ============ 切片：options（工序勾选候选）============
  /** 已映射工序的 code / name（`GET /{id}` 回包提供，勾选项 label 与展示一致）。 */
  const mappedProcesses = ref<Array<{ process_id: string; process_code: string; process_name: string }>>(
    [],
  );

  // 勾选候选全集 = 共享 OUTSOURCE 工序列表 ∪ 回包里的已映射工序，**两条来源取并集**：
  //   - 共享列表（`useProcessesQuery({category:'OUTSOURCE'})`）给「还没映射过这道工序」的
  //     可选项（公司要能新增能力）；
  //   - 回包给「后端已映射但不在当前 OUTSOURCE 列表里」（工序被改成 INHOUSE 的历史映射）
  //     的那一项 —— 只走共享列表会让它在勾选框里凭空消失，用户看不见也取消不掉，
  //     保存时那一项就被静默删掉。
  const processesQuery = useProcessesQuery({ category: 'OUTSOURCE', limit: 200 });
  const outsourceProcesses = computed<Process[]>(
    () => (processesQuery.data.value?.items ?? []) as Process[],
  );

  /** 对话框「工序能力」勾选项 = 并集后的 `{id, label}` 列表（`outsourceProcesses` 在前，
   *  回包补出来的追加在后，后者带「非外协工序」标注让操作员看得出异常来源）。 */
  const processOptions = computed<{ id: string; label: string }[]>(() => {
    const opts = outsourceProcesses.value.map((p) => ({ id: p.id, label: `${p.code} — ${p.name}` }));
    const known = new Set(opts.map((o) => o.id));
    for (const m of mappedProcesses.value) {
      if (known.has(m.process_id)) continue;
      known.add(m.process_id);
      opts.push({ id: m.process_id, label: `${m.process_code} — ${m.process_name}（非外协工序）` });
    }
    return opts;
  });

  const options = { outsourceProcesses, processOptions };

  // ============ 切片：dialogs（新建 / 编辑合并为一个对话框）============
  const visible = ref(false);
  /** 正在编辑的公司 id；null = 新建模式。 */
  const editingId = ref<string | null>(null);
  /** OCC 锚：`POST /{id}/update` 必传，缺省是后端 422 纯文本。 */
  const editingVersion = ref<number | null>(null);
  const saving = ref(false);
  const form = reactive<CompanyFormState>(initialForm());

  function resetForm(): void {
    Object.assign(form, initialForm());
    editingId.value = null;
    editingVersion.value = null;
    mappedProcesses.value = [];
  }

  function openCreate(): void {
    resetForm();
    visible.value = true;
  }

  async function openEdit(row: OutsourceCompanySchema): Promise<void> {
    resetForm();
    editingId.value = row.id;
    editingVersion.value = row.version;
    form.name = row.name;
    form.contact_name = row.contact_name ?? '';
    form.contact_phone = row.contact_phone ?? '';
    form.address = row.address ?? '';
    form.is_active = row.is_active;
    visible.value = true;
    // 工序勾选的初值只能从详情拿（列表 VO 不带 processes[]）。
    try {
      const detail = await getOutsourceCompany(row.id);
      mappedProcesses.value = detail.processes;
      // 只有编辑态才回填勾选：新建时勾选全集就是空。
      form.process_ids = detail.processes.map((p) => p.process_id);
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载公司工序能力失败');
    }
  }

  async function onDelete(row: OutsourceCompanySchema): Promise<void> {
    if (
      !(await confirmDangerous(
        '提示',
        `确认删除外协公司「${row.name}」？若仍映射工序会返 21205 拒绝。`,
        { type: 'warning', confirmText: '删除', cancelText: '取消' },
      ))
    )
      return;
    try {
      await softDeleteMutation.mutateAsync({ id: row.id, version: row.version });
    } catch {
      // mutation onError 已 ElMessage 提示（OutsourceList 的按钮是裸接，不兜会多一条
      // unhandledrejection）
    }
  }

  // ============ 切片：mutations（三条写路径）============
  const createMutation = useMutation({
    mutationKey: ['outsource', 'companies', 'create'],
    mutationFn: (payload: Parameters<typeof createOutsourceCompany>[0]) =>
      createOutsourceCompany(payload),
    onSuccess: async () => {
      await invalidateOutsourceCompaniesAll(qc);
      ElMessage.success('已新增');
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '新增失败'),
  });

  const updateMutation = useMutation({
    mutationKey: ['outsource', 'companies', 'update'],
    mutationFn: (vars: { id: string; version: number; payload: Parameters<typeof updateOutsourceCompany>[1] }) =>
      updateOutsourceCompany(vars.id, vars.payload),
    onSuccess: async () => {
      await invalidateOutsourceCompaniesAll(qc);
      ElMessage.success('已保存');
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '保存失败'),
  });

  const softDeleteMutation = useMutation({
    mutationKey: ['outsource', 'companies', 'soft-delete'],
    mutationFn: (vars: { id: string; version: number }) =>
      softDeleteOutsourceCompany(vars.id, { version: vars.version }),
    onSuccess: async () => {
      await invalidateOutsourceCompaniesAll(qc);
      ElMessage.success('已删除');
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '删除失败'),
  });

  /** 对话框保存：编辑态一次 update（基础字段 + 工序勾选），新建态一次 create。
   *
   *  ⚠️ `version` 是硬约束：`POST /{id}/update` 的 `OutsourceCompanyUpdateRequest.version`
   *  无 `#[serde(default)]` ⇒ 漏传是 axum 的 HTTP 422 纯文本（不是业务信封），编辑功能
   *  100% 失败。`process_ids` 三态传法：编辑态恒传数组（`[]` = 清空，与「不动」语义不同，
   *  否则「取消全选并保存」会被当成没改而静默丢失）；新建态传当前勾选。 */
  async function onSave(): Promise<void> {
    if (!form.name.trim()) {
      ElMessage.warning('公司名不能为空');
      return;
    }
    const base = {
      name: form.name.trim(),
      contact_name: form.contact_name.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
      address: form.address.trim() || null,
      is_active: form.is_active,
    };
    saving.value = true;
    try {
      if (editingId.value !== null && editingVersion.value !== null) {
        await updateMutation.mutateAsync({
          id: editingId.value,
          version: editingVersion.value,
          payload: { ...base, version: editingVersion.value, process_ids: [...form.process_ids] },
        });
      } else {
        await createMutation.mutateAsync({ ...base, process_ids: [...form.process_ids] });
      }
      visible.value = false;
      resetForm();
    } catch {
      // 错误已由 mutation 的 onError 提示；保持弹窗开着让用户改完重试。
    } finally {
      saving.value = false;
    }
  }

  const dialogs = {
    visible,
    editingId,
    editingVersion,
    saving,
    form,
    mappedProcesses,
    openCreate,
    openEdit,
    resetForm,
    onSave,
    onDelete,
  };

  // ============ 列定义 + 列可见性 ============
  const columnDefs = buildOutsourceCompanyColumnDefs({ nameFilter, activeFilter });
  const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'outsource_company_list' });

  return {
    query,
    options,
    dialogs,
    mutations: { createMutation, updateMutation, softDeleteMutation },
    nameFilter,
    activeFilter,
    columnDefs,
    columnVisibility,
  };
});