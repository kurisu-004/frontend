// @vitest-environment happy-dom
// src/views/outsource/__tests__/OutsourceBoard.spec.ts
//
// 外协看板壳（`/outsource/send-receive`）的行为 spec。
//
// 覆盖：
//   - B1：tab 集合必须与**全量 OUTSOURCE 工序列表** join —— 快照 `processes[]` 只含
//     `sendable + in_flight > 0` 的工序，直接拿它当 tab 列表的话，「某工序收发清零」的
//     瞬间该 tab 凭空消失、操作到一半页面结构跳走。
//   - B2：快照只补 `sendable_count` / `in_flight_count` / `color` 三个字段；快照里没有的
//     工序徽标补 0、颜色回落到工序列表自带的 color。
//   - B3：tab 标题 = 工序 code + `(可发 N / 在途 M)` 双徽标；快照加载中显「…」。
//   - B4：深链 `?tab=<process_id>` 生效；非法值（已删除 / 自产工序）在工序列表解析后校正到
//     第一个 OUTSOURCE 工序。
//   - B5：手动刷新失效**两个前缀**（快照 + 单工序看板），语义是「我把当前屏幕当成不可信」。
//   - B6：右键菜单项按**区域 × 角色 × 批次状态 × 报价路径**逐格派生：候选池卡 = 召回 +
//     拆分批次 + 发送到外协公司二级菜单；公司列卡 = 回收生产 / 回收品检 + 拆分批次。
//     Inspector 拿不到拆批；`can_send=false` 的候选行拿不到「发送到」。
//   - B7：拆批对话框挂在 el-tabs **之外**（骨架态下已挂载），且 `done` → 板级失效外协
//     两域（失效编排在板级，不在共享对话框内）。
//   - B8：provide 三件套（sendToCompany / openOutsourceBatchMenu / activeOutsourceProcessId）
//     真的提供了，且 sendToCompany 是写操作 composable 的那一个实例。
//   - B9：回收对话框 submit 后走 receiveToProduction / receiveToInspection，成功才关。
//   - B10：tab body 组件带 process-id 挂载（:lazy 的懒挂载语义由 EP 负责，本用例守 prop
//     接线）。
//
// 测试策略：
//   - EP 组件桩：`el-tabs` / `el-tab-pane` 各渲染其 label slot + default slot（不实现
//     :lazy，子组件桩统一渲染），`el-skeleton` / `el-alert` / `el-button` 走最小桩；
//   - 菜单本体（`@imengyu/vue3-context-menu` 函数模式）整体 mock：板级在右键回调里派生
//     items 并调 `showBatchContextMenu(evt, items)`，本 spec 断言递进去的 **items**（菜单
//     本体的固定传参与打开串行化由 src/composables/__tests__/useBatchContextMenu.spec.ts
//     守）；菜单项的派生矩阵本身由 composables/__tests__/outsourceBatchMenuItems.spec.ts
//     逐格覆盖，本 spec 只守接线；
//   - 子组件带接缝桩（ProcessBoardTab / OutsourceReceiveDialog / BatchSplitDialog）渲染出
//     自己的 props 与可触发的 emit，让本用例能断言「板级把什么接给了谁」；
//   - 数据层桩：useProcessesQuery / 两个 query hook / useOutsourceQueueMove / 生产队列域的
//     useQueueRecall 全部 vi.mock 成可控桩（测的是壳的接线与派生，不重复测数据层）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import type { BatchCardModel } from '@/types/batchCard';
import type * as VueQuery from '@tanstack/vue-query';

// ⚠️ vi.hoisted 的工厂跑在模块 import **之前**，里面不能碰 `ref` 等 import 进来的运行时。
// 这两个 mock 只需要「读 .value」这一面（板级把它们包进 computed），所以用裸的
// `{ value }` 替身即可；每个用例在 beforeEach 里先赋值再 mount，computed 首读就取到本用例的值。
const procsMock = vi.hoisted(() => ({
  items: [] as { id: string; code: string; name: string; color?: string | null }[],
  isLoading: { value: false },
}));
const snapshotMock = vi.hoisted(() => ({
  processes: [] as {
    process_id: string;
    process_code: string;
    process_name: string;
    color: string | null;
    category: string;
    sendable_count: number;
    in_flight_count: number;
  }[],
  isLoading: { value: false },
}));
const moveMock = vi.hoisted(() => ({
  send: vi.fn(async () => true),
  receiveToProduction: vi.fn(async () => true),
  receiveToInspection: vi.fn(async () => true),
}));
const authMock = vi.hoisted(() => ({ roles: ['MANAGER', 'CLERK', 'INSPECTOR'] as string[] }));
/** el-tabs 桩的「切到某个 tab」驱动器（真实 el-tabs 靠点 tab 头 emit update:modelValue）。 */
const tabSwitch = vi.hoisted(() => ({ to: '' }));
const invalidateSpy = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/composables/queries/useProcessesQuery', () => ({
  useProcessesQuery: () => ({
    data: computed(() => ({ items: procsMock.items })),
    isLoading: procsMock.isLoading,
  }),
}));
vi.mock('@/views/outsource/composables/useOutsourceQueueSnapshotQuery', () => ({
  useOutsourceQueueSnapshotQuery: () => ({
    data: computed(() =>
      snapshotMock.processes.length
        ? {
            processes: snapshotMock.processes,
            sendable_total: 0,
            in_flight_total: 0,
            ts: '2026-10-09T00:00:00+08:00',
          }
        : undefined,
    ),
    isLoading: snapshotMock.isLoading,
  }),
  invalidateOutsourceQueueSnapshotAll: invalidateSpy,
}));
vi.mock('@/views/outsource/composables/useOutsourceQueueProcessQuery', () => ({
  invalidateOutsourceQueueProcessAll: invalidateSpy,
}));
vi.mock('@/views/outsource/composables/useOutsourceQueueMove', () => ({
  useOutsourceQueueMove: () => ({
    error: ref(null),
    // canMove 跟着 authMock 的角色走：后端 move 端点是
    // require_any_role([Manager, Clerk, Inspector])，少放一个角色用户点了才吃 40300
    canMove: computed(() => authMock.roles.length > 0),
    sendToCompany: moveMock.send,
    receiveToProduction: moveMock.receiveToProduction,
    receiveToInspection: moveMock.receiveToInspection,
  }),
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ hasRole: (r: string) => authMock.roles.includes(r) }),
}));
/** QueryClient 的最小替身：`invalidateQueries` 记失效调用（串行化调用点），
 *  `setQueryData` / `getQueryData` 让用例能预置并读到「tab body 已经填好的缓存」（板级
 *  读「发送到」目标集用的就是同一份缓存 ⇒ 零新增请求，用例也无需真挂 ProcessBoardTab）。 */
const qcStub = vi.hoisted(() => {
  const cache = new Map<string, unknown>();
  const key = (k: unknown) => JSON.stringify(k);
  return {
    cache,
    invalidateQueries: vi.fn(async () => undefined),
    setQueryData: vi.fn((k: unknown, v: unknown) => cache.set(key(k), v)),
    getQueryData: (k: unknown) => cache.get(key(k)),
  };
});
vi.mock('@tanstack/vue-query', async (importOriginal) => {
  const actual = await importOriginal<typeof VueQuery>();
  return { ...actual, useQueryClient: () => qcStub };
});
const warningMock = vi.hoisted(() => vi.fn());
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: warningMock, info: vi.fn() },
}));

/** 右键菜单本体的记账替身：记录板级递进去的 (事件, items)。
 *  `showBatchContextMenu` 真实实现是**异步**的（内部 close → nextTick → show），板级对它
 *  fire-and-forget，本 spec 因此给一个同步替身 —— items 可同步断言。 */
const menuOpenCalls = vi.hoisted(() => [] as { evt: unknown; items: unknown }[]);
vi.mock('@/composables/useBatchContextMenu', () => ({
  showBatchContextMenu: (evt: MouseEvent, items: unknown) => {
    menuOpenCalls.push({ evt, items });
    return Promise.resolve();
  },
}));

/** 生产队列域的召回 composable 桩（外协候选池右键「召回到待下发」复用它）。 */
const recallBatchMock = vi.hoisted(() => vi.fn(async () => undefined));
const recallableMock = vi.hoisted(() => ({ current: true }));
vi.mock('@/views/production/queue/composables/useQueueRecall', () => ({
  useQueueRecall: () => ({
    canRecall: computed(() => recallableMock.current),
    recallMutation: { mutate: vi.fn(), isPending: ref(false) },
    recallBatch: recallBatchMock,
  }),
}));

// 路由桩：记录 replace 调用（深链写回）
const routeMock = vi.hoisted(() => {
  const query: Record<string, unknown> = {};
  return {
    query,
    replace: vi.fn(async () => undefined),
  };
});

import OutsourceBoard from '../OutsourceBoard.vue';
import { qk } from '@/composables/queries/keys';
import {
  ACTIVE_OUTSOURCE_PROCESS_ID,
  OPEN_OUTSOURCE_BATCH_MENU,
  SEND_TO_COMPANY,
} from '../outsourceBoardTypes';

const { useRoute, useRouter } = vi.hoisted(() => ({
  useRoute: () => routeMock,
  useRouter: () => routeMock,
}));
vi.mock('vue-router', () => ({ useRoute, useRouter }));

// ---------- EP 桩 ----------
const ElTabsStub = defineComponent({
  name: 'ElTabsStub',
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(props, { slots, emit }) {
    return () =>
      h('div', { class: 'el-tabs-stub', 'data-active': props.modelValue }, [
        h('div', { class: 'el-tabs-stub__labels' }, slots.default?.()),
        // 真实 el-tabs 靠点 tab 头 emit update:modelValue；桩里用 tabSwitch.to 代替那次点击
        h('button', {
          class: 'el-tabs-stub__switch',
          onClick: () => emit('update:modelValue', tabSwitch.to),
        }),
      ]);
  },
});
const ElTabPaneStub = defineComponent({
  name: 'ElTabPaneStub',
  // 不实现 :lazy（懒挂载由真实 EP 负责），本桩一律渲染 default + label 两个 slot
  setup(_, { slots }) {
    return () =>
      h('div', { class: 'el-tab-pane-stub' }, [
        h('div', { class: 'el-tab-pane-stub__label' }, slots.label?.()),
        h('div', { class: 'el-tab-pane-stub__body' }, slots.default?.()),
      ]);
  },
});
const ElSkeletonStub = defineComponent({
  name: 'ElSkeletonStub',
  props: { rows: Number, animated: Boolean },
  setup: () => () => h('div', { class: 'el-skeleton-stub' }),
});
const ElAlertStub = defineComponent({
  name: 'ElAlertStub',
  props: { title: String, type: String, closable: Boolean, showIcon: Boolean },
  setup: () => () => h('div', { class: 'el-alert-stub' }),
});
const ElButtonStub = defineComponent({
  name: 'ElButtonStub',
  props: { loading: Boolean, type: String },
  emits: ['click'],
  setup(_, { slots, emit }) {
    return () => h('button', { class: 'el-button-stub', onClick: () => emit('click') }, slots.default?.());
  },
});

// ---------- 子组件带接缝桩 ----------
const ProcessBoardTabStub = defineComponent({
  name: 'ProcessBoardTabStub',
  props: { processId: { type: String, required: true } },
  setup: (props) => () => h('div', { class: 'process-board-tab-stub', 'data-pid': props.processId }),
});
interface ReceiveStubProps {
  modelValue?: boolean;
  mode?: string;
  companyName?: string;
}
const receiveStub = vi.hoisted(() => ({
  lastSubmit: null as unknown,
  lastProps: null as unknown as ReceiveStubProps,
}));
const ReceiveDialogStub = defineComponent({
  name: 'OutsourceReceiveDialogStub',
  props: {
    modelValue: Boolean,
    mode: String,
    companyName: String,
    batch: Object,
    submitting: Boolean,
  },
  emits: ['update:modelValue', 'confirm'],
  setup(props, { emit }) {
    receiveStub.lastProps = props;
    return () =>
      h('div', { class: 'receive-dialog-stub', 'data-mode': props.mode }, [
        h('button', {
          class: 'receive-dialog-stub__confirm',
          onClick: () => {
            const payload = { toShelfId: '5000000000002', nextProcessId: '2000000000002' };
            receiveStub.lastSubmit = payload;
            emit('confirm', payload);
          },
        }),
      ]);
  },
});
const SplitDialogStub = defineComponent({
  name: 'BatchSplitDialogStub',
  props: { modelValue: Boolean, source: Object },
  emits: ['update:modelValue'],
  setup: (props) => () =>
    h('div', { class: 'split-dialog-stub' }, [
      h('span', { class: 'split-dialog-stub__src' }, props.source?.batch_id ?? ''),
    ]),
});
const PROC_A = '2000000000001';
const PROC_B = '2000000000002';
const PROC_INHOUSE = '2000000000003';
const COMPANY_ID = '9000000000001';

/** 被右键的那张卡（板级 opener 的第二参）。 */
const MENU_TARGET_BATCH: BatchCardModel = {
  batch_id: '3000000000002',
  part_id: '4000000000002',
  batch_no: 'B1025',
  part_name: '齿轮',
  drawing_no: 'DRW-2',
  serial_no: null,
  quantity: 8,
  system_delivery_date: null,
  planned_delivery_date: null,
  is_urgent: false,
  has_cnc_program: false,
  customer_l1: null,
  customer_l2: null,
  applicant_name: null,
  note: null,
  location: 'OUTSOURCE_COMPANY',
  shelf_id: null,
  version: 5,
  extra: { outsource_company_name: '外协厂甲', can_auto_receive: true },
};

interface MenuItemStub {
  label?: string;
  onClick?: () => void;
  children?: MenuItemStub[];
}

/** 一条完整的候选行（发送白名单的五条锚都在它上面）：APPROVAL 报价锁定「外协厂甲」。 */
const CANDIDATE_STUB = {
  version: 5,
  send_mode: 'APPROVAL' as const,
  part_id: '4000000000002',
  part_serial_no: 'SN-2',
  part_drawing_no: 'DRW-2',
  part_name: '齿轮',
  quantity: 8,
  batch_id: MENU_TARGET_BATCH.batch_id,
  batch_no: 1025,
  planned_delivery_date: null,
  is_urgent: false,
  customer_name: null,
  parent_customer_name: null,
  shelf_code: 'SH-A01',
  shelf_id: '5000000000002',
  outsource_company_id: COMPANY_ID,
  outsource_company_name: '外协厂甲',
  quote_id: '7000000000001',
  company_options: [],
  price: '12.50',
  has_cnc_program: false,
  applicant_name: null,
  note: null,
  system_delivery_date: null,
  can_send: true,
};

const globalConfig = {
  components: {
    ElTabs: ElTabsStub,
    ElTabPane: ElTabPaneStub,
    ElSkeleton: ElSkeletonStub,
    ElAlert: ElAlertStub,
    ElButton: ElButtonStub,
  },
  stubs: {
    ProcessBoardTab: ProcessBoardTabStub,
    OutsourceReceiveDialog: ReceiveDialogStub,
    BatchSplitDialog: SplitDialogStub,
  },
};


function mountBoard(query: Record<string, unknown> = {}) {
  routeMock.query = query;
  routeMock.replace.mockClear();
  return mount(OutsourceBoard, { global: globalConfig });
}

/** 当前 tabs 渲染出的 (code, 徽标文案) 序列。 */
function tabLabels(wrapper: ReturnType<typeof mountBoard>) {
  return wrapper.findAll('.el-tab-pane-stub').map((p) => ({
    code: p.find('.tab-label__code').text(),
    badge: p.find('.tab-label__count').text(),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  procsMock.isLoading.value = false;
  snapshotMock.isLoading.value = false;
  procsMock.items = [
    { id: PROC_A, code: 'OP10', name: '外协粗车', color: '#E74C3CFF' },
    { id: PROC_B, code: 'OP20', name: '外协热处理', color: null },
  ];
  // 快照只含「有货」的工序：B 有在途、A 收发清零
  snapshotMock.processes = [
    {
      process_id: PROC_B,
      process_code: 'OP20',
      process_name: '外协热处理',
      color: '#3498DBFF',
      category: 'OUTSOURCE',
      sendable_count: 4,
      in_flight_count: 2,
    },
  ];
  authMock.roles = ['MANAGER', 'CLERK', 'INSPECTOR'];
  recallableMock.current = true;
  menuOpenCalls.length = 0;
  qcStub.cache.clear();
});

describe('OutsourceBoard（外协看板壳）', () => {
  it('B1：tab 集合与全量 OUTSOURCE 工序列表 join（快照只含有货工序）', () => {
    // 快照里只有 PROC_B；A 收发清零 ⇒ 拿快照当 tab 列表会让 A 的 tab 凭空消失
    const wrapper = mountBoard();
    expect(tabLabels(wrapper).map((t) => t.code)).toEqual(['OP10', 'OP20']);
    wrapper.unmount();
  });

  it('B1b：工序列表为空（快照非空也不能造 tab）→ 不渲染任何 tab', () => {
    procsMock.items = [];
    const wrapper = mountBoard();
    expect(wrapper.findAll('.el-tab-pane-stub')).toHaveLength(0);
    wrapper.unmount();
  });

  it('B2/B3：tab 标题 = code + (可发 N / 在途 M)，缺快照的工序补 0', () => {
    const wrapper = mountBoard();
    expect(tabLabels(wrapper)).toEqual([
      { code: 'OP10', badge: '(0 / 0)' },
      { code: 'OP20', badge: '(4 / 2)' },
    ]);
    wrapper.unmount();
  });

  it('B3b：快照加载中 → 徽标显「…」而不是 0（0 会被误读成「收发清零」）', () => {
    snapshotMock.isLoading.value = true;
    const wrapper = mountBoard();
    expect(tabLabels(wrapper).every((t) => t.badge.includes('…'))).toBe(true);
    wrapper.unmount();
  });

  it('B3c：工序色优先取快照，缺快照时回落到工序列表自带的 color', () => {
    const wrapper = mountBoard();
    const codes = wrapper.findAll('.tab-label__code');
    // OP10 不在快照里 ⇒ 用工序列表的 #E74C3CFF；OP20 在快照里 ⇒ #3498DBFF
    // （后端 `t_process.color` 是 9 字符 #RRGGBBAA，含 alpha 的 hex8 原样喂 CSS）
    expect(codes[0]!.attributes('style')).toContain('#E74C3CFF');
    expect(codes[1]!.attributes('style')).toContain('#3498DBFF');
    wrapper.unmount();
  });

  it('B4：深链 ?tab=<process_id> 选中对应 tab', () => {
    const wrapper = mountBoard({ tab: PROC_B });
    expect(wrapper.find('.el-tabs-stub').attributes('data-active')).toBe(PROC_B);
    wrapper.unmount();
  });

  it('B4b：非法深链值（已删除 / 自产工序）→ 校正到第一个 OUTSOURCE 工序', () => {
    const wrapper = mountBoard({ tab: '9999999999999' });
    expect(wrapper.find('.el-tabs-stub').attributes('data-active')).toBe(PROC_A);
    wrapper.unmount();
  });

  it('B4c：无 ?tab= 时默认第一个 OUTSOURCE 工序（而不是空字符串）', () => {
    const wrapper = mountBoard();
    expect(wrapper.find('.el-tabs-stub').attributes('data-active')).toBe(PROC_A);
    wrapper.unmount();
  });

  it('B4d：切 tab 用 router.replace 写回 URL（不污染 history）', async () => {
    const wrapper = mountBoard();
    expect(wrapper.find('.el-tabs-stub').attributes('data-active')).toBe(PROC_A);
    tabSwitch.to = PROC_B;
    routeMock.replace.mockClear();
    await wrapper.find('.el-tabs-stub__switch').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.el-tabs-stub').attributes('data-active')).toBe(PROC_B);
    // replace 而不是 push：后退键不该逐个 tab 回退
    expect(routeMock.replace).toHaveBeenCalledWith({ query: { tab: PROC_B } });
    expect(routeMock.replace).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('B5：手动刷新失效快照 + 单工序看板两个前缀', async () => {
    const wrapper = mountBoard();
    invalidateSpy.mockClear();
    await wrapper.find('.el-button-stub').trigger('click');
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('B6a：公司列卡的菜单 = 回收生产 + 回收品检 + 拆分批次（三角色都有权）', () => {
    const wrapper = mountBoard();
    openHeld(wrapper);
    expect(menuLabels()).toEqual(['回收生产', '回收品检', '拆分批次']);
    wrapper.unmount();
  });

  it('B6b：Inspector 拿得到回收两项、拿不到拆批（逐项过滤，不是「一次性闸」）', () => {
    authMock.roles = ['INSPECTOR'];
    const wrapper = mountBoard();
    openHeld(wrapper);
    expect(menuLabels()).toEqual(['回收生产', '回收品检']);
    wrapper.unmount();
  });

  it('B6c：公司列卡**不给**召回与「发送到」（在途批次的出路是回收，不是召回/改投）', () => {
    const wrapper = mountBoard();
    openHeld(wrapper);
    const labels = menuLabels();
    expect(labels).not.toContain('召回到待下发');
    expect(labels).not.toContain('发送到外协公司');
    wrapper.unmount();
  });

  it('B6d：候选池卡 = 召回 + 拆分批次 + 发送到外协公司（二级菜单按报价白名单收窄）', () => {
    const wrapper = mountBoard();
    openCandidate(wrapper, CANDIDATE_STUB);
    // tab body 的公司列缓存（板级从同一 queryKey 读，零新增请求）
    seedCompanies();
    openCandidate(wrapper, CANDIDATE_STUB);
    expect(menuLabels()).toEqual(['召回到待下发', '拆分批次', '发送到外协公司']);
    // APPROVAL 行：目标是报价锁定的那一家，白名单外的公司一律不进二级菜单
    expect(menuChildren('发送到外协公司')).toEqual(['外协厂甲']);
    wrapper.unmount();
  });

  it('B6e：候选池「召回到待下发」→ 复用生产队列域的 useQueueRecall（板级不新增 mutation）', () => {
    const wrapper = mountBoard();
    openCandidate(wrapper, CANDIDATE_STUB);
    clickItem('召回到待下发');
    expect(recallBatchMock).toHaveBeenCalledWith(MENU_TARGET_BATCH);
    wrapper.unmount();
  });

  it('B6f：候选池「发送到外协公司」二级菜单 → sendToCompany 带候选行 + 目标公司', () => {
    const wrapper = mountBoard();
    seedCompanies();
    openCandidate(wrapper, CANDIDATE_STUB);
    clickChild('发送到外协公司', '外协厂甲');
    expect(moveMock.send).toHaveBeenCalledWith({
      candidate: CANDIDATE_STUB,
      companyId: COMPANY_ID,
    });
    wrapper.unmount();
  });

  it('B6g：尚未上架（PENDING）的候选行不给召回 —— 它本来就在待下发区', () => {
    const wrapper = mountBoard();
    openCandidate(wrapper, { ...CANDIDATE_STUB, shelf_id: '' });
    expect(menuLabels()).not.toContain('召回到待下发');
    wrapper.unmount();
  });

  it('B6h：can_send=false 的候选行整个不给「发送到」（后端派生的可发送判据，前端不重算）', () => {
    const wrapper = mountBoard();
    seedCompanies();
    openCandidate(wrapper, { ...CANDIDATE_STUB, can_send: false });
    expect(menuLabels()).not.toContain('发送到外协公司');
    wrapper.unmount();
  });

  it('B6i：余量 ≤ 1 的卡不给「拆分批次」（后端要求拆出数量 ∈ [1, n-1]）', () => {
    const wrapper = mountBoard();
    openHeld(
      wrapper,
      { batch_id: MENU_TARGET_BATCH.batch_id, version: 5, quantity: 1 },
      { ...MENU_TARGET_BATCH, quantity: 1 },
    );
    expect(menuLabels()).not.toContain('拆分批次');
    wrapper.unmount();
  });

  it('B6j：一个动作都没有时不弹菜单，改为一句 warning（右键已被 prevent 掉系统菜单）', () => {
    // 一个角色都不给：既不能收发（canMove 假）、也不能拆批、也不能召回
    authMock.roles = [];
    recallableMock.current = false;
    const wrapper = mountBoard();
    openHeld(wrapper);
    expect(menuOpenCalls).toHaveLength(0);
    expect(warningMock).toHaveBeenCalledWith('当前角色对该批次没有可执行的操作');
    wrapper.unmount();
  });

  it('B7：拆批对话框挂在 el-tabs 之外（骨架态下已挂载）', () => {
    const wrapper = mountBoard();
    // 骨架态（procsQuery 加载中）下 tabs 不渲染，但对话框必须已挂载
    expect(wrapper.find('.el-tabs-stub').exists()).toBe(true);
    expect(wrapper.find('.split-dialog-stub').exists()).toBe(true);
    wrapper.unmount();
  });

  it('B7b：拆批 `done` → 板级失效外协两域（失效编排在板级，不在共享对话框里）', async () => {
    // 回归 guard：对话框是**共享组件**（生产队列看板也用它）。失效编排一旦留在对话框里
    // 就会锁死单域消费方（它 import 了某一方的前缀失效函数）。守法：对话框只发 `done`。
    const wrapper = mountBoard();
    invalidateSpy.mockClear();
    wrapper.findComponent({ name: 'BatchSplitDialogStub' }).vm.$emit('done');
    await wrapper.vm.$nextTick();
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('B8：provide 三件套（发送包装 / 右键 opener / 当前 tab 闸门）都在', () => {
    const wrapper = mountBoard();
    expect(typeof provideOf(wrapper, SEND_TO_COMPANY)).toBe('function');
    expect(typeof provideOf(wrapper, OPEN_OUTSOURCE_BATCH_MENU)).toBe('function');
    const activeId = provideOf(wrapper, ACTIVE_OUTSOURCE_PROCESS_ID) as { value: string };
    expect(activeId.value).toBe(PROC_A);
    // 发送包装就是写操作 composable 的那一个实例（多实例 = 双份成功 toast）
    expect(provideOf(wrapper, SEND_TO_COMPANY)).toBe(moveMock.send);
    wrapper.unmount();
  });

  it('B9a：回收生产 → receiveToProduction 被调，批次的 companyId 来自所在列', async () => {
    const wrapper = mountBoard();
    const held = { batch_id: '3000000000002', version: 5, quantity: 8 };
    openHeld(wrapper, held);
    clickItem('回收生产');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.receive-dialog-stub').attributes('data-mode')).toBe('production');

    await wrapper.find('.receive-dialog-stub__confirm').trigger('click');
    expect(moveMock.receiveToProduction).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      batch: held,
      toShelfId: '5000000000002',
      nextProcessId: '2000000000002',
    });
    expect(moveMock.receiveToInspection).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('B9b：回收品检 → receiveToInspection 被调（不带工序）', async () => {
    const wrapper = mountBoard();
    const held = { batch_id: '3000000000002', version: 5 };
    openHeld(wrapper, held);
    clickItem('回收品检');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.receive-dialog-stub').attributes('data-mode')).toBe('inspection');

    await wrapper.find('.receive-dialog-stub__confirm').trigger('click');
    expect(moveMock.receiveToInspection).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      batch: held,
      toShelfId: '5000000000002',
    });
    expect(moveMock.receiveToProduction).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('B9c：回收失败 → 对话框保持打开（用户改一下货架即可重试）', async () => {
    moveMock.receiveToProduction.mockResolvedValueOnce(false);
    const wrapper = mountBoard();
    openHeld(wrapper);
    clickItem('回收生产');
    await wrapper.vm.$nextTick();
    await wrapper.find('.receive-dialog-stub__confirm').trigger('click');
    await wrapper.vm.$nextTick();
    expect((receiveStub.lastProps as ReceiveStubProps).modelValue).toBe(true);
    wrapper.unmount();
  });

  it('B10：每个 tab 都挂上带 process-id 的 ProcessBoardTab（:lazy 语义由 EP 负责）', () => {
    const wrapper = mountBoard();
    const bodies = wrapper.findAll('.process-board-tab-stub');
    expect(bodies.map((b) => b.attributes('data-pid'))).toEqual([PROC_A, PROC_B]);
    wrapper.unmount();
  });

  it('B10b：自产工序（INHOUSE）不出现在 tab 里', () => {
    procsMock.items = [
      { id: PROC_INHOUSE, code: 'IP10', name: '自产车削', color: null },
      { id: PROC_A, code: 'OP10', name: '外协粗车', color: null },
    ];
    const wrapper = mountBoard();
    // procsQuery 的入参本身已按 category='OUTSOURCE' 过滤；这里守的是「板级不自己再
    // 二次过滤」——即它信任入参过滤、不因返回集里混进自产工序而崩溃（板级只 join 徽标）。
    expect(tabLabels(wrapper).map((t) => t.code)).toEqual(['IP10', 'OP10']);
    wrapper.unmount();
  });

  // 快照的 `category` 是 DB 真值：批次停在外协公司、`current_process_id` 却指向 INHOUSE
  // 工序时（工序改过类别）后端照样下发这一行。它不在 OUTSOURCE 工序列表里 ⇒ 不补行的话
  // 这批在途批次在看板彻底不可见，操作员既看不到也无从收货。
  it('B10c：快照里 category=INHOUSE 且不在 OUTSOURCE 列表的工序 → 补成 tab（带在途徽标）', () => {
    procsMock.items = [{ id: PROC_A, code: 'OP10', name: '外协粗车', color: null }];
    snapshotMock.processes = [
      {
        process_id: PROC_INHOUSE,
        process_code: 'IP10',
        process_name: '自产车削',
        color: null,
        category: 'INHOUSE',
        sendable_count: 0,
        in_flight_count: 3,
      },
    ];

    const wrapper = mountBoard();

    expect(tabLabels(wrapper)).toEqual([
      { code: 'OP10', badge: '(0 / 0)' },
      { code: 'IP10', badge: '(0 / 3)' },
    ]);
    expect(wrapper.findAll('.process-board-tab-stub').map((b) => b.attributes('data-pid'))).toEqual([
      PROC_A,
      PROC_INHOUSE,
    ]);
    wrapper.unmount();
  });
});

/** 从组件实例的 provides 里取值（provide/inject 的唯一可测缝）。 */
function provideOf(wrapper: ReturnType<typeof mountBoard>, key: string): unknown {
  return (wrapper.vm as unknown as { $: { provides: Record<string, unknown> } }).$.provides[key];
}

/** 驱动板级右键 opener（等价于 CompanyColumn / CandidatePool 触发 contextmenu）。
 *  第三参是**区域标签**（容器恒定给），第四参是该侧的行 DTO。 */
function openMenu(
  wrapper: ReturnType<typeof mountBoard>,
  area: 'outsource-company' | 'outsource-candidate',
  ctx: unknown,
  batch: BatchCardModel = MENU_TARGET_BATCH,
): void {
  const opener = provideOf(wrapper, OPEN_OUTSOURCE_BATCH_MENU) as (
    e: MouseEvent,
    b: BatchCardModel,
    a: string,
    c: unknown,
  ) => void;
  opener(new MouseEvent('contextmenu'), batch, area, ctx);
}

function openHeld(
  wrapper: ReturnType<typeof mountBoard>,
  held: unknown = { batch_id: MENU_TARGET_BATCH.batch_id, version: 5, quantity: 8 },
  batch: BatchCardModel = MENU_TARGET_BATCH,
): void {
  openMenu(
    wrapper,
    'outsource-company',
    { kind: 'held', held, companyId: COMPANY_ID, companyName: '外协厂甲' },
    batch,
  );
}

function openCandidate(
  wrapper: ReturnType<typeof mountBoard>,
  candidate: unknown,
  batch: BatchCardModel = MENU_TARGET_BATCH,
): void {
  openMenu(
    wrapper,
    'outsource-candidate',
    { kind: 'candidate', candidate, processName: '外协热处理' },
    batch,
  );
}

/** 往 query 缓存里塞当前 tab 的公司列（板级从同一个 queryKey 读，零新增请求）。
 *  「开到哪一列」与 tab 一致：默认首个 tab = PROC_A。 */
function seedCompanies(): void {
  qcStub.setQueryData(qk.outsourceQueueProcess(PROC_A), {
    companies: [{ company_id: COMPANY_ID, name: '外协厂甲', held_count: 0, held_batches: [] }],
  });
}

/** 最近一次传给菜单本体的菜单项。 */
function lastItems(): MenuItemStub[] {
  return menuOpenCalls[menuOpenCalls.length - 1]!.items as MenuItemStub[];
}

function menuLabels(): (string | undefined)[] {
  return lastItems().map((i) => i.label);
}

function menuChildren(label: string): (string | undefined)[] {
  return (lastItems().find((i) => i.label === label)?.children ?? []).map((c) => c.label);
}

/** 触发某一项的 onClick（模拟用户在菜单上点它）。 */
function clickItem(label: string): void {
  lastItems().find((i) => i.label === label)!.onClick!();
}

/** 触发某项二级菜单里某一项的 onClick。 */
function clickChild(label: string, child: string): void {
  lastItems()
    .find((i) => i.label === label)!
    .children!.find((c) => c.label === child)!
    .onClick!();
}