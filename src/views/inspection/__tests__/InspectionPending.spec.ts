// @vitest-environment happy-dom
// src/views/inspection/__tests__/InspectionPending.spec.ts
//
// 2026-10-05 新增：待品检一览**壳**的扫码流程契约回归守卫。壳里挂了 4 个弹窗
// （品检通过 / 指定工序 / 扫码树 / 行内送检面板）+ 表格 + store + router + 扫码枪订阅，
// 只靠 ScanTreeDialog.spec（子组件）覆盖不到「壳这一层的时间序」，故单独立一份。
// 本 spec 断三条壳侧行为：
//
//  1. **乐观开窗**：扫码请求 settle 之前树弹窗的 `model-value` 就已经是 true ——
//     否则弹窗内的 v-loading 是死绑定，请求期间零反馈（先开窗后发请求的设计意图）。
//     顺带断「开窗前先把上一棵树清掉」：请求在飞时 `scanTree` 必须是 null，
//     否则用户在请求途中按 ESC 关窗（closed 清了个寂寞）再开窗会先闪出上一次的树。
//  2. **失败收窗**：扫码端点 reject（查不到条码 20101）后 `model-value` 回 false，
//     不留一个空弹窗；提示由 store 的 scanMutation.onError 弹。
//  3. **三弹窗守卫**：品检通过 / 指定工序 / 扫码树任一开着时，新到的扫码被丢弃
//     （守卫在 await 之前判，不换掉用户正在填的上下文）。行内送检面板在扫码树弹窗
//     内部，跟着树弹窗一起被这条守卫挡住。
//
//  为什么两个子组件都桩掉、被测的是壳自己：
//   - `InspectionTable`：表格的列 / 表头筛选 / 排序契约由
//     src/views/inspection/__tests__/InspectionTable.spec.ts 负责（连 el-table 的
//     插槽协议都是那边复刻的）；
//   - `ScanTreeDialog`：同上，见 ScanTreeDialog.spec.ts。桩成只暴露 `modelValue`
//     的壳 + 转发 `pass` / `assignProcess` 两个事件 —— 这两个事件是壳唯一的外部入口
//     （壳拿它抛出来的批次行去开自己的两个既有弹窗），「从树上点按钮」这条路径因此
//     仍然是真的。
//   - element-plus 桩：`vi.mock('element-plus')` 只桩 ElMessage / ElMessageBox +
//     列定义 import 期就要解析的四个组件（同 InspectionTable.spec.ts 的理由）；
//     模板里剩下的 el-* 走 global.components 注册的最小壳。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { ScanBatchOut, ScanTreeOut } from '@/api/inspection';

// ---------------------------------------------------------------- 扫码枪：捕获订阅者
// 不用真实 window.keydown：那套「30ms 连击窗口 + Enter 收尾」是 composable 自己的
// 契约（另有单测），本页要断的是**收到条码之后**的行为。
const scanSubscribers: Array<(code: string) => void> = [];
vi.mock('@/composables/useBarcodeScanner', () => ({
  useBarcodeScanner: () => ({
    onScan: (handler: (code: string) => void) => {
      scanSubscribers.push(handler);
      return () => {
        const i = scanSubscribers.indexOf(handler);
        if (i >= 0) scanSubscribers.splice(i, 1);
      };
    },
    setEnabled: () => {},
    clearBuffer: () => {},
    enabled: { value: true },
    lastScan: { value: '' },
    lastScanAt: { value: 0 },
  }),
}));

// ---------------------------------------------------------------- EP 桩
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  // useConfirm 的二次确认（指定工序的确认框），本 spec 不点它，给个恒 false 的壳。
  ElMessageBox: { confirm: vi.fn(async () => Promise.reject(new Error('未确认'))) },
  // 列定义（src/utils/inspectionColumnDefs.ts）在 store setup 期就 h() 这几个组件，
  // import 期要能解析（被测的是壳，表格本身已桩掉）。
  ElButton: { name: 'ElButtonStub', template: '<button><slot /></button>' },
  ElInput: { name: 'ElInputStub', template: '<input />' },
  ElDatePicker: { name: 'ElDatePickerStub', template: '<div />' },
  ElTreeSelect: { name: 'ElTreeSelectStub', template: '<div />' },
}));

const scanInspectionMock = vi.fn();
vi.mock('@/api/inspection', () => ({
  scanInspection: (...args: unknown[]) => scanInspectionMock(...args),
}));

vi.mock('@/api/parts', () => ({
  listInspectionBatches: vi.fn(async () => ({
    items: [],
    total: '0',
    limit: '20',
    offset: '0',
  })),
  toShip: vi.fn(),
  toProcess: vi.fn(),
  toInspection: vi.fn(),
}));

// 共享基础数据层（useCustomerTree / useProductionShelvesQuery / useProcessesQuery）
// 在 store setup 里就 fetch，不桩会走真实 axios。
vi.mock('@/api/customer', () => ({
  listCustomers: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0 })),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  softDeleteCustomer: vi.fn(),
}));
vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));
vi.mock('@/api/process', () => ({
  listProcesses: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

import InspectionPending from '../InspectionPending.vue';
import { useInspectionListStore } from '../composables/useInspectionListStore';

// ---------------------------------------------------------------- 数据
/** 扫到独立件的一棵树（一个零件 + 两个批次，含一个 INSPECTION 批次可操作）。 */
const BATCH_INSPECTION: ScanBatchOut = {
  id: '9000000000101',
  batch_no: 1,
  quantity: 10,
  status: 'INSPECTION',
  version: 7,
  is_repairing: false,
  location: 'INSPECTION_SHELF',
  current_holder_display: 'SH-I01',
  process_name: null,
  is_scanned: true,
};

const TREE: ScanTreeOut = {
  hit_kind: 'PART',
  scanned_serial_no: 'F1006-01',
  assembly: null,
  children: [
    {
      id: '9000000000011',
      serial_no: 'F1006-01',
      name: '子件 01',
      drawing_no: 'DWG-01',
      status: 'INSPECTION',
      quantity: 10,
      is_urgent: false,
      system_delivery_date: '2026-10-20',
      customer_name: '二级客户',
      version: 3,
      children: [BATCH_INSPECTION],
    },
  ],
};

// ---------------------------------------------------------------- 子组件桩
const InspectionTableStub = {
  name: 'InspectionTable',
  template: '<div class="mock-inspection-table" />',
};

/** 扫码树弹窗桩：只暴露 model-value（壳侧要断的就是它）+ 转发两个动作事件。 */
const ScanTreeDialogStub = {
  name: 'ScanTreeDialog',
  props: ['modelValue', 'inspectionShelves'],
  emits: ['update:modelValue', 'pass', 'assignProcess'],
  template: '<div class="mock-scan-tree" :data-open="String(modelValue)" />',
};

const DialogStub = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'top', 'closeOnClickModal'],
  emits: ['update:modelValue', 'closed'],
  template:
    '<div class="mock-dialog" :data-open="String(modelValue)" :data-title="title">' +
    '<slot /><slot name="footer" /></div>',
};

const globalConfig = {
  components: {
    'el-card': { template: '<div><slot /></div>' },
    'el-icon': { template: '<i><slot /></i>' },
    'el-pagination': { template: '<div class="mock-pagination" />' },
    'el-checkbox': {
      props: ['modelValue'],
      emits: ['update:modelValue', 'change'],
      template: '<div class="mock-checkbox"><slot /></div>',
    },
    'el-dialog': DialogStub,
    'el-form': { template: '<form><slot /></form>' },
    'el-form-item': { props: ['label'], template: '<div><slot /></div>' },
    'el-input-number': { props: ['modelValue'], template: '<div class="mock-input-number" />' },
    'el-alert': { props: ['title'], template: '<div class="mock-alert" />' },
    'el-select': { template: '<div class="mock-select"><slot /></div>' },
    'el-option': { props: ['label', 'value'], template: '<div class="mock-option" />' },
    'el-input': { template: '<div class="mock-input" />' },
    'el-tag': { template: '<span class="mock-tag"><slot /></span>' },
  },
  stubs: { InspectionTable: InspectionTableStub, ScanTreeDialog: ScanTreeDialogStub },
};

async function mountPage() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [] });
  const wrapper = mount(InspectionPending, {
    global: {
      ...globalConfig,
      plugins: [
        pinia,
        router,
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) },
        ],
      ],
    },
  });
  // onMounted 里的 restoreState / nextTick / tableRef.sort 跑完再交回测试。
  await flushPromises();
  return { wrapper, store: useInspectionListStore() };
}

/** 模拟扫一次码：走壳里注册的订阅者（等价于扫码枪派发）。 */
async function scan(code: string): Promise<void> {
  for (const handler of [...scanSubscribers]) handler(code);
  await flushPromises();
}

function scanTreeDialog(wrapper: Awaited<ReturnType<typeof mountPage>>['wrapper']) {
  return wrapper.findComponent({ name: 'ScanTreeDialog' });
}

/** 按 title 找壳里那 3 个 el-dialog 桩之一（品检通过 / 指定工序）。 */
function dialogByTitle(
  wrapper: Awaited<ReturnType<typeof mountPage>>['wrapper'],
  title: string,
) {
  return wrapper
    .findAllComponents({ name: 'ElDialog' })
    .find((d) => d.props('title')?.startsWith(title));
}

describe('InspectionPending · 扫码流程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scanSubscribers.length = 0;
  });

  it('乐观开窗：请求 settle 前树弹窗已 true，且请求在飞时树上没有上一棵树', async () => {
    // 先扫成功一次，把「上一棵树」留在 store 里。
    scanInspectionMock.mockResolvedValue(TREE);
    const { wrapper, store } = await mountPage();
    await scan('F1006-01');
    expect(store.mutations.scanTree).toEqual(TREE);
    scanTreeDialog(wrapper).vm.$emit('update:modelValue', false);
    await flushPromises();
    expect(scanTreeDialog(wrapper).props('modelValue')).toBe(false);

    // 再扫一次：这次请求不 resolve，看 settle 之前的状态。
    const release: Array<() => void> = [];
    scanInspectionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve(TREE));
        }),
    );
    await scan('F1006-02');

    expect(scanTreeDialog(wrapper).props('modelValue')).toBe(true);
    expect(scanInspectionMock).toHaveBeenLastCalledWith('F1006-02');
    // 开窗前先清树：请求在飞时 scanTree 必须是 null（ESC 关窗后重开不能闪出旧树）。
    expect(store.mutations.scanTree).toBeNull();

    release[0]?.();
    await flushPromises();
    expect(store.mutations.scanTree).toEqual(TREE);
    wrapper.unmount();
  });

  it('失败收窗：扫码端点 reject 后弹窗回 false（不留空弹窗），提示由 store 弹', async () => {
    const { ElMessage } = await import('element-plus');
    scanInspectionMock.mockRejectedValue(
      Object.assign(new Error('零件不存在'), { code: 20101 }),
    );
    const { wrapper, store } = await mountPage();

    await scan('F1009');

    expect(scanInspectionMock).toHaveBeenCalledWith('F1009');
    expect(scanTreeDialog(wrapper).props('modelValue')).toBe(false);
    expect(store.mutations.scanTree).toBeNull();
    expect(ElMessage.warning).toHaveBeenCalledWith('未找到条码 F1009 对应的零件或装配件');
    wrapper.unmount();
  });

  it('三弹窗守卫：树 / 品检通过 / 指定工序任一开着，新到的扫码被丢弃', async () => {
    scanInspectionMock.mockResolvedValue(TREE);
    const { wrapper } = await mountPage();
    await scan('F1006-01');
    const tree = scanTreeDialog(wrapper);
    const batch = TREE.children[0]?.children[0];
    expect(tree.props('modelValue')).toBe(true);
    expect(batch).toBeDefined();

    // (1) 扫码树开着（行内送检面板在它内部，同一条守卫）→ 丢弃
    await scan('F1006-02');
    expect(scanInspectionMock).toHaveBeenCalledTimes(1);
    expect(scanInspectionMock).toHaveBeenLastCalledWith('F1006-01');

    // (2) 关树弹窗、从树上点「品检通过」→ 品检通过弹窗开着 → 丢弃
    tree.vm.$emit('update:modelValue', false);
    await flushPromises();
    tree.vm.$emit('pass', batch);
    await flushPromises();
    expect(dialogByTitle(wrapper, '品检通过')?.props('modelValue')).toBe(true);
    await scan('F1006-03');
    expect(scanInspectionMock).toHaveBeenCalledTimes(1);

    // (3) 关品检通过弹窗、从树上点「指定工序」→ 指定工序弹窗开着 → 丢弃
    dialogByTitle(wrapper, '品检通过')?.vm.$emit('update:modelValue', false);
    await flushPromises();
    tree.vm.$emit('assignProcess', batch);
    await flushPromises();
    expect(dialogByTitle(wrapper, '指定工序')?.props('modelValue')).toBe(true);
    await scan('F1006-04');
    expect(scanInspectionMock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('空白条码（只有空白符）不触发任何请求，也不开弹窗', async () => {
    const { wrapper } = await mountPage();
    await scan('   ');
    expect(scanInspectionMock).not.toHaveBeenCalled();
    expect(scanTreeDialog(wrapper).props('modelValue')).toBe(false);
    wrapper.unmount();
  });
});
