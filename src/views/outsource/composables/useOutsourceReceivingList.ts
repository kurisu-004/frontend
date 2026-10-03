// composables/useOutsourceReceivingList.ts
//
// 待接收 tab 的业务状态 + 业务函数（2026-08-25 T12 从 OutsourceSendReceive.vue 抽出）。
//
// 持有：
//   - receivingFilter：filter bar 持久化（pageSize 不再持久化，详见 2026-08-31 注释）
//   - receivingPagedRef：<PagedTable> 模板 ref
//   - shelves / processes：页级 lookup（接收 dialog 用；shell 装载后通过 setter 注入）
//   - receiveDialogVisible / receiveTarget / receiveBranch / receiveShelf /
//     receiveProcess / receiveQuantity / receiveSubmitting：接收 dialog 状态
//   - useShelfProcessFilter 双向收窄（仅 production 分支）
//
// 不持有：
//   - customers（页级共享 lookup，由 shell 持有并下传）
//   - activeTab（页级 shell 持有）
//   - 发送 tab 相关状态
//
// 子组件约定：
//   - OutsourceReceivingTab 通过 props 读 receivingFilter / receiveDialogXxx，
//     通过 defineExpose 把 refresh() 暴露给页级 shell 用于「发送后联动刷新」。

import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { listOutsourceInFlight } from '@/api/outsource';
import { receiveFromOutsource, receiveFromOutsourceToInspection } from '@/api/parts';
import { useConfirm } from '@/composables/useConfirm';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import type { Process } from '@/types/process';
import type { OutsourceInFlightItem } from '@/types/outsource';
import type { Shelf as ShelfItem } from '@/types/shelf';

type Branch = 'production' | 'inspection';

export interface UseOutsourceReceivingListOptions {
  shelves: Ref<readonly ShelfItem[]>;
  processes: Ref<readonly Process[]>;
}

/** `<PagedTable>` 模板 ref 暴露出来的成员（本 composable 实际用到的部分）。
 *
 *  与 useOutsourceSendableList 的同名接口同款取舍：`ref()` 无初值会推断成 `Ref<any>`，
 *  成员名写错 / 把已解包成员当 ref 再读一层都不会报 TS 错。成员一律必填 ——
 *  `PagedTable.vue` 的 `defineExpose` 无条件解构出这些成员，ref 的 `value` 一旦就位
 *  必然齐全；写可选会逼调用点写 `?.()`，把「成员缺失」吞成静默 no-op。必填声明换来
 *  的是赋值点检查（往 ref 塞缺成员的对象直接编译报错）。
 *
 *  ⚠️ 与 `defineExpose` 无编译期关联：模板用字符串 ref（`ref="receivingPagedRef"`），
 *  Vue 按名字在运行时回填，组件侧改成员名不会被这里拦下。 */
export interface ReceivingPagedTableExpose {
  total?: number;
  fetch: () => Promise<void>;
  reset: () => Promise<void>;
}

/** 2026-09-21 显式返回类型。 */
export interface UseOutsourceReceivingListReturn {
  receivingError: Ref<string | null>;
  receivingFilter: { keyword: string; customer_id: string };
  receivingPagedRef: Ref<ReceivingPagedTableExpose | undefined>;
  receiveDialogVisible: Ref<boolean>;
  receiveTarget: Ref<OutsourceInFlightItem | null>;
  receiveSubmitting: Ref<boolean>;
  receiveQuantity: Ref<number>;
  receiveBranch: Ref<Branch>;
  receiveShelf: Ref<string>;
  receiveProcess: Ref<string>;
  inspectionShelves: ComputedRef<readonly ShelfItem[]>;
  filteredProductionShelves: ComputedRef<readonly ShelfItem[]>;
  filteredInhouseProcesses: ComputedRef<readonly Process[]>;
  receiveBranchLabel: ComputedRef<string>;
  restore: () => Record<string, unknown> | null;
  snapshot: () => void;
  clearPersisted: () => void;
  receivingFetcher: (params: {
    page: number;
    pageSize: number;
  }) => Promise<{ items: OutsourceInFlightItem[]; total: number }>;
  refreshReceiving: () => Promise<void>;
  onReceivingSearch: () => void;
  onReceivingReset: () => void;
  receivingRowClassName: (ctx: { row: OutsourceInFlightItem }) => string;
  openReceive: (row: OutsourceInFlightItem) => void;
  onReceiveDialogClosed: () => void;
  onConfirmReceive: () => Promise<void>;
}

export function useOutsourceReceivingList(
  options: UseOutsourceReceivingListOptions,
): UseOutsourceReceivingListReturn {
  const { dangerous: confirmDangerous } = useConfirm();

  // ============ 列表 filter（持久化） ============
  // 2026-08-31 双实例修复：pageSize 不再持久化（与 ListShell 一致），
  // 每次进入视图从 <PagedTable :default-page-size="20"> 起算。
  const receivingError = ref<string | null>(null);
  const receivingFilter = reactive({ keyword: '', customer_id: '' });
  const receivingPagedRef = ref<ReceivingPagedTableExpose>();

  // 待接收 tab 持久化（2026-07-30 commit 4B）；2026-08-25 T7：page 不再持久化
  const persist = useListStatePersist('outsource_send_receive_receiving', { receivingFilter });

  // ============ 加急行红底 ============
  function receivingRowClassName({ row }: { row: OutsourceInFlightItem }): string {
    return row.is_urgent ? 'row-urgent' : '';
  }

  async function receivingFetcher(params: { page: number; pageSize: number }) {
    receivingError.value = null;
    try {
      // 2026-10-03 修正：后端已从「裸数组」改为分页信封（outsource 域
      // `OutsourceInFlightListOut`），此前把 {items,total,limit,offset} 当数组用
      // → items.length undefined → 「待接收」tab 表格空白且分页恒 1 页。
      const r = await listOutsourceInFlight({
        keyword: receivingFilter.keyword || undefined,
        limit: params.pageSize,
        offset: (params.page - 1) * params.pageSize,
      });
      return { items: r.items, total: r.total };
    } catch (e) {
      receivingError.value = (e as Error).message ?? '加载待接收列表失败';
      ElMessage.error(receivingError.value);
      return { items: [], total: 0 };
    }
  }

  async function refreshReceiving(): Promise<void> {
    await receivingPagedRef.value?.fetch();
  }

  function onReceivingSearch(): void {
    void receivingPagedRef.value?.reset();
  }
  function onReceivingReset(): void {
    receivingFilter.keyword = '';
    receivingFilter.customer_id = '';
    void receivingPagedRef.value?.reset();
  }

  // ============ 接收 dialog 状态 ============
  const receiveDialogVisible = ref(false);
  const receiveTarget = ref<OutsourceInFlightItem | null>(null);
  const receiveSubmitting = ref(false);
  const receiveQuantity = ref<number>(0);
  const receiveBranch = ref<Branch>('production');
  const receiveShelf = ref('');
  const receiveProcess = ref('');

  // 分支对应货架 / 工序过滤（壳里拿到的 shelves / processes 是只读 lookup）
  const productionShelves = computed(() =>
    options.shelves.value.filter((s) => s.zone === 'PRODUCTION' && s.is_active),
  );
  const inspectionShelves = computed(() =>
    options.shelves.value.filter((s) => s.zone === 'INSPECTION' && s.is_active),
  );
  const inhouseProcesses = computed(() =>
    options.processes.value.filter((p) => p.category === 'INHOUSE'),
  );

  // 2026-07-17：useShelfProcessFilter 双向收窄（仅 production 分支）。
  // inspection 分支无 next_process，走 INSPECTION 货架不过滤。
  const {
    filteredShelves: filteredProductionShelves,
    filteredProcesses: filteredInhouseProcesses,
  } = useShelfProcessFilter(
    productionShelves,
    inhouseProcesses,
    computed({
      get: () => receiveShelf.value || null,
      set: (v) => {
        receiveShelf.value = v ?? '';
      },
    }),
    computed({
      get: () => receiveProcess.value || null,
      set: (v) => {
        receiveProcess.value = v ?? '';
      },
    }),
  );

  function openReceive(row: OutsourceInFlightItem): void {
    receiveTarget.value = row;
    receiveBranch.value = 'production';
    receiveShelf.value = '';
    receiveProcess.value = '';
    receiveQuantity.value = row.quantity;
    receiveDialogVisible.value = true;
    // 2026-10-02：不再显式 load() —— 映射由共享 query 自动跟随 options.shelves /
    // options.processes 就绪（两个源非空即开闸，闸门推导见 useShelfProcessFilter）。
  }

  function onReceiveDialogClosed(): void {
    receiveTarget.value = null;
    receiveShelf.value = '';
    receiveProcess.value = '';
    receiveBranch.value = 'production';
  }

  const receiveBranchLabel = computed(() =>
    receiveBranch.value === 'production' ? '进入生产货架继续加工' : '品检',
  );

  async function onConfirmReceive(): Promise<void> {
    if (!receiveTarget.value) return;
    if (!receiveShelf.value) {
      ElMessage.warning('请选择货架');
      return;
    }
    if (receiveBranch.value === 'production' && !receiveProcess.value) {
      ElMessage.warning('生产分支请选择下一道 INHOUSE 工序');
      return;
    }
    if (receiveQuantity.value < 1 || receiveQuantity.value > receiveTarget.value.quantity) {
      ElMessage.warning(`数量必须在 1 ~ ${receiveTarget.value.quantity} 之间`);
      return;
    }
    if (
      !(await confirmDangerous(
        '接收外协件',
        `确认接收「${receiveTarget.value.drawing_no}」（批次 ${receiveTarget.value.batch_no}，${receiveQuantity.value} / ${receiveTarget.value.quantity} 件，${receiveBranchLabel.value}）？`,
        { type: 'warning', confirmText: '确认接收', cancelText: '取消' },
      ))
    )
      return;
    receiveSubmitting.value = true;
    try {
      const qty =
        receiveQuantity.value === receiveTarget.value.quantity ? null : receiveQuantity.value;
      if (receiveBranch.value === 'production') {
        // 2026-10-02：回收端点迁 prod 域并以批次为锚（batch_id 已是路径参数），
        // version 取列表行的批次版本（OCC 必填）。
        await receiveFromOutsource(receiveTarget.value.batch_id, {
          shelf_id: receiveShelf.value,
          next_process_id: receiveProcess.value,
          version: receiveTarget.value.version,
          quantity: qty,
        });
        ElMessage.success('已下发到生产货架');
      } else {
        // OUTSOURCE → INSPECTION 走 receive-from-outsource-to-inspection（仅送检，
        // 不自动 PASS），后续由品检员手动品检通过。
        // 2026-10-02：该端点随批次路由迁 prod 域并以批次为锚，函数名改为
        // receiveFromOutsourceToInspection（与「送检」端点 toInspection 区分）。
        await receiveFromOutsourceToInspection(receiveTarget.value.batch_id, {
          shelf_id: receiveShelf.value,
          version: receiveTarget.value.version,
        });
        ElMessage.success('已送检，等待品检');
      }
      receiveDialogVisible.value = false;
      await refreshReceiving();
      // PR-H 2026-07-29：「已接收历史」tab 已移除（功能由 per-company 对账页承担）
    } catch (e) {
      ElMessage.error((e as Error).message ?? '操作失败');
    } finally {
      receiveSubmitting.value = false;
    }
  }

  return {
    // state
    receivingError,
    receivingFilter,
    receivingPagedRef,
    receiveDialogVisible,
    receiveTarget,
    receiveSubmitting,
    receiveQuantity,
    receiveBranch,
    receiveShelf,
    receiveProcess,
    // 派生
    inspectionShelves,
    filteredProductionShelves,
    filteredInhouseProcesses,
    receiveBranchLabel,
    // 持久化恢复（shell 在 onMounted 里调一次，把 snapshot 写回 receivingFilter / pageSize）
    restore: persist.restore,
    snapshot: persist.snapshot,
    clearPersisted: persist.clear,
    // handlers
    receivingFetcher,
    refreshReceiving,
    onReceivingSearch,
    onReceivingReset,
    receivingRowClassName,
    openReceive,
    onReceiveDialogClosed,
    onConfirmReceive,
  };
}
