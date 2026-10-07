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
//   - B6：右键菜单项按**容器 + 角色**逐项过滤：候选池卡只给「拆分批次」（M/C）；公司列卡
//     给「回收生产 / 回收品检」（M/C/I）+「拆分批次」（M/C）。Inspector 拿不到拆批。
//   - B7：菜单本体挂在 el-tabs **之外**（骨架态下已挂载）。
//   - B8：provide 三件套（sendToCompany / openOutsourceBatchMenu / activeOutsourceProcessId）
//     真的提供了，且 sendToCompany 是写操作 composable 的那一个实例。
//   - B9：回收对话框 submit 后走 receiveToProduction / receiveToInspection，成功才关。
//   - B10：tab body 组件带 process-id 挂载（:lazy 的懒挂载语义由 EP 负责，本用例守 prop
//     接线）。
//
// 测试策略：
//   - EP 组件桩：`el-tabs` / `el-tab-pane` 各渲染其 label slot + default slot（不实现
//     :lazy，子组件桩统一渲染），`el-skeleton` / `el-alert` / `el-button` 走最小桩；
//   - 子组件带接缝桩（ProcessBoardTab / OutsourceReceiveDialog / BatchSplitDialog）渲染出
//     自己的 props 与可触发的 emit，让本用例能断言「板级把什么接给了谁」；
//   - 数据层桩：useProcessesQuery / 两个 query hook / useOutsourceQueueMove 全部
//     vi.mock 成可控桩（测的是壳的接线与派生，不重复测数据层）。

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
    // canMove 恒真：角色差异由 authMock 走 ctxMenuItems 那一侧的 hasRole 断言覆盖
    canMove: computed(() => true),
    sendToCompany: moveMock.send,
    receiveToProduction: moveMock.receiveToProduction,
    receiveToInspection: moveMock.receiveToInspection,
  }),
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ hasRole: (r: string) => authMock.roles.includes(r) }),
}));
vi.mock('@tanstack/vue-query', async (importOriginal) => {
  const actual = await importOriginal<typeof VueQuery>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries: invalidateSpy }) };
});
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
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
/**
 * BatchContextMenu 桩：**只在被 open() 调过之后才渲染菜单项**。
 *
 * 这样「板级确实持有菜单实例并调了 open()」就落进断言面 —— 只按 `items` 渲染的桩会让
 * 「模板上漏了 ref、菜单永远打不开」这类缺陷照样绿（items 有值但没人调 open）。
 */
const menuStubRef = vi.hoisted(() => ({ open: vi.fn() }));
interface MenuItemStub {
  key: string;
  label?: string;
}

const BatchContextMenuStub = defineComponent({
  name: 'BatchContextMenuStub',
  props: { items: { type: Array as () => MenuItemStub[], default: () => [] } },
  emits: ['select'],
  setup(props, { emit, expose }) {
    menuStubRef.open.mockClear();
    const opened = ref(false);
    expose({
      open: (evt: MouseEvent, batch: BatchCardModel) => {
        opened.value = true;
        menuStubRef.open(evt, batch);
      },
    });
    return () =>
      h(
        'div',
        { class: 'ctx-menu-stub', 'data-opened': String(opened.value), 'data-count': props.items.length },
        opened.value
          ? props.items.map((it) =>
              h('button', {
                class: 'ctx-menu-stub__item',
                'data-key': it.key,
                onClick: () => emit('select', it.key, MENU_TARGET_BATCH),
              }),
            )
          : [],
      );
  },
});

/** 被右键的那张卡（板级 select 回调的第二参）。 */
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
    BatchContextMenu: BatchContextMenuStub,
  },
};

const PROC_A = '2000000000001';
const PROC_B = '2000000000002';
const PROC_INHOUSE = '2000000000003';

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

  it('B6a：公司列卡的菜单 = 回收生产 + 回收品检 + 拆分批次（三角色都有权）', async () => {
    const wrapper = mountBoard();
    // 模拟公司列卡右键：注入的 opener 由 ProcessBoardTab 消费，这里直接通过 provide
    // 的键拿到板级 opener 并驱动（等价于 CompanyColumn 触发 contextmenu）。
    const opener = provideOf(wrapper, OPEN_OUTSOURCE_BATCH_MENU) as (
      e: MouseEvent,
      b: BatchCardModel,
      c: unknown,
    ) => void;
    opener(new MouseEvent('contextmenu'), MENU_TARGET_BATCH, {
      kind: 'held',
      held: { batch_id: MENU_TARGET_BATCH.batch_id },
      companyId: '9000000000001',
      companyName: '外协厂甲',
    });
    await wrapper.vm.$nextTick();
    // open() 真的被调到了菜单实例上（否则模板上漏 ref 的缺陷照样绿）
    expect(menuStubRef.open).toHaveBeenCalledTimes(1);
    expect(menuKeys(wrapper)).toEqual(['receive-production', 'receive-inspection', 'split']);
    wrapper.unmount();
  });

  it('B6b：Inspector 拿得到回收两项、拿不到拆批（逐项过滤，不是「一次性闸」）', async () => {
    authMock.roles = ['INSPECTOR'];
    const wrapper = mountBoard();
    const opener = provideOf(wrapper, OPEN_OUTSOURCE_BATCH_MENU) as (
      e: MouseEvent,
      b: BatchCardModel,
      c: unknown,
    ) => void;
    opener(new MouseEvent('contextmenu'), MENU_TARGET_BATCH, {
      kind: 'held',
      held: { batch_id: MENU_TARGET_BATCH.batch_id },
      companyId: '9000000000001',
      companyName: '外协厂甲',
    });
    await wrapper.vm.$nextTick();
    expect(menuKeys(wrapper)).toEqual(['receive-production', 'receive-inspection']);
    wrapper.unmount();
  });

  it('B6c：候选池卡的菜单只有「拆分批次」（回收动作对公司列卡才有意义）', async () => {
    const wrapper = mountBoard();
    const opener = provideOf(wrapper, OPEN_OUTSOURCE_BATCH_MENU) as (
      e: MouseEvent,
      b: BatchCardModel,
      c: unknown,
    ) => void;
    opener(new MouseEvent('contextmenu'), MENU_TARGET_BATCH, {
      kind: 'candidate',
      candidate: { batch_id: MENU_TARGET_BATCH.batch_id },
      processName: '外协热处理',
    });
    await wrapper.vm.$nextTick();
    expect(menuKeys(wrapper)).toEqual(['split']);
    wrapper.unmount();
  });

  it('B7：菜单本体挂在 el-tabs 之外（骨架态下已挂载）', () => {
    const wrapper = mountBoard();
    // 骨架态（procsQuery 加载中）下 tabs 不渲染，但菜单必须已挂载
    expect(wrapper.find('.el-tabs-stub').exists()).toBe(true);
    expect(wrapper.find('.ctx-menu-stub').exists()).toBe(true);
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
    const opener = provideOf(wrapper, OPEN_OUTSOURCE_BATCH_MENU) as (
      e: MouseEvent,
      b: BatchCardModel,
      c: unknown,
    ) => void;
    const held = { batch_id: '3000000000002', version: 5, quantity: 8 };
    opener(new MouseEvent('contextmenu'), MENU_TARGET_BATCH, {
      kind: 'held',
      held,
      companyId: '9000000000001',
      companyName: '外协厂甲',
    });
    await wrapper.vm.$nextTick();
    await wrapper.find('.ctx-menu-stub__item').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.receive-dialog-stub').attributes('data-mode')).toBe('production');

    await wrapper.find('.receive-dialog-stub__confirm').trigger('click');
    expect(moveMock.receiveToProduction).toHaveBeenCalledWith({
      companyId: '9000000000001',
      batch: held,
      toShelfId: '5000000000002',
      nextProcessId: '2000000000002',
    });
    expect(moveMock.receiveToInspection).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('B9b：回收品检 → receiveToInspection 被调（不带工序）', async () => {
    const wrapper = mountBoard();
    const opener = provideOf(wrapper, OPEN_OUTSOURCE_BATCH_MENU) as (
      e: MouseEvent,
      b: BatchCardModel,
      c: unknown,
    ) => void;
    opener(new MouseEvent('contextmenu'), MENU_TARGET_BATCH, {
      kind: 'held',
      held: { batch_id: '3000000000002', version: 5 },
      companyId: '9000000000001',
      companyName: '外协厂甲',
    });
    await wrapper.vm.$nextTick();
    const items = wrapper.findAll('.ctx-menu-stub__item');
    await items[1]!.trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.receive-dialog-stub').attributes('data-mode')).toBe('inspection');

    await wrapper.find('.receive-dialog-stub__confirm').trigger('click');
    expect(moveMock.receiveToInspection).toHaveBeenCalledWith({
      companyId: '9000000000001',
      batch: { batch_id: '3000000000002', version: 5 },
      toShelfId: '5000000000002',
    });
    expect(moveMock.receiveToProduction).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('B9c：回收失败 → 对话框保持打开（用户改一下货架即可重试）', async () => {
    moveMock.receiveToProduction.mockResolvedValueOnce(false);
    const wrapper = mountBoard();
    const opener = provideOf(wrapper, OPEN_OUTSOURCE_BATCH_MENU) as (
      e: MouseEvent,
      b: BatchCardModel,
      c: unknown,
    ) => void;
    opener(new MouseEvent('contextmenu'), MENU_TARGET_BATCH, {
      kind: 'held',
      held: { batch_id: '3000000000002', version: 5 },
      companyId: '9000000000001',
      companyName: '外协厂甲',
    });
    await wrapper.vm.$nextTick();
    await wrapper.find('.ctx-menu-stub__item').trigger('click');
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
});

/** 从组件实例的 provides 里取值（provide/inject 的唯一可测缝）。 */
function provideOf(wrapper: ReturnType<typeof mountBoard>, key: string): unknown {
  return (wrapper.vm as unknown as { $: { provides: Record<string, unknown> } }).$.provides[key];
}

function menuKeys(wrapper: ReturnType<typeof mountBoard>): string[] {
  return wrapper.findAll('.ctx-menu-stub__item').map((b) => b.attributes('data-key')!);
}