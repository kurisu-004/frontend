// @vitest-environment happy-dom
// src/views/outsource/components/__tests__/CompanyColumn.spec.ts
//
// 外协看板「外协公司列」的投放落点分发 + 三条拖拽守卫 + Sortable 接线 guard。
// 守的是整条前端发送链路：候选池 onStart 记源 → 公司列 onAdd 分发 → 三条守卫 →
// 注入的 sendToCompany 被调（或被拒）。
//
// 覆盖：
//   - D1：Sortable 用**二参重载**（不传 list）—— 库的内建 onAdd/onRemove 假定「传进来的
//     list 就是渲染源」，而本列的渲染源是 props 派生的 heldBatches。
//   - D2：group = outsource-send 且 pull:false / put:true（只接投放）。
//   - D3：`onRemove` 存在且把节点放回 `from.children[oldIndex]`（DOM 下标）—— 二参形态
//     下库不挂内建 onRemove，少了它投放失败时幻影节点留在落点列、invalidate 清不掉。
//   - D4：sort:false（列内重排无语义，二参形态下也没人回滚 DOM 顺序）。
//   - D5：容器带 data-company-id；卡片带 data-batch-version（move 的 OCC 锚，落点只拿得
//     到 DOM 拿不到渲染源对象）。
//   - D6：既无候选池源 → 零请求（`put: true` 的布尔形态不做 group 名比对，非本看板的
//     来源也会被 onAdd 叫醒）。
//   - D7（守卫 ①白名单）：APPROVAL 行只接受落到报价锁定的那家公司列；DIRECT 行只接受落到
//     `company_options` 内的公司；两者都拒绝时零请求 + warning。
//   - D8（守卫 ②can_send）：`can_send === false` 的行不接受投放。
//   - D9（守卫 ③OCC / 货架）：version 为 0/NaN、shelf_id 为空串都早退、零请求。
//   - D10：守卫全部早退时**只弹一条** warning（不逐条刷 toast）。
//   - D11：多选拖拽 → 逐个串行发 move；成功的移出勾选、失败的留在集合里并汇总 error。
//   - D12：未 provide sendToCompany 时落点退化为不发请求、不抛错（inject 缺省兜底）。
//   - D13：卡片右键 → 注入的 opener 被调一次，第三参带 `held` + companyId/companyName
//     （在途卡 DTO 上没有公司字段，回收请求的 `from.company_id` 正是它）。
//   - D14：Sortable 容器 .col-body 内只有卡片（无注释节点、无空态混入）；空列时容器仍在、
//     空态是兄弟覆盖层（空公司列是主场景的投放目标）。
//   - D15：`:deep(.sortable-ghost)` 规则在本组件的 scoped style 里（生产队列域的
//     WorkerColumn / PoolDrawer 漏了这条 ⇒ 从池拖进工人列没有半透明占位反馈）。
//
// 测试策略：vi.mock('vue-draggable-plus') 复刻重载判别（照 WorkerColumn.spec.ts 同款），
// 捕获 `{list, options}` 后手工驱动 `options.onAdd(evt)`；dndSourceTracker 用**真实
// 实现**（记源 / 取源的读写配对是被测行为的一半）；EP 组件 stub + ElMessage 桩成 no-op。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  OutsourceQueueCandidateData,
  OutsourceQueueCompanyData,
  OutsourceQueueHeldBatchData,
} from '../../composables/outsourceQueueSchema';

const captured = vi.hoisted(() => ({
  calls: [] as { list: unknown; options: Record<string, unknown> }[],
  starts: [] as unknown[],
}));

vi.mock('vue-draggable-plus', () => ({
  // 复刻 vue-draggable-plus 的重载判定：第 2 参的 .value 是数组 ⇒ 三参（list）形态。
  useDraggable: (_el: unknown, listOrOptions: unknown, maybeOptions?: unknown) => {
    const candidate = (listOrOptions as { value?: unknown }) ?? {};
    const hasList = Array.isArray(candidate.value ?? listOrOptions);
    const options = (hasList ? maybeOptions : listOrOptions) as Record<string, unknown>;
    captured.calls.push({ list: hasList ? listOrOptions : null, options });
    return {
      option: () => undefined,
      destroy: () => undefined,
      start: (el?: unknown) => captured.starts.push(el),
      pause: () => undefined,
      resume: () => undefined,
    };
  },
}));

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import CompanyColumn from '../CompanyColumn.vue';
import { recordOutsourceSource } from '@/utils/dndSourceTracker';
import {
  OPEN_OUTSOURCE_BATCH_MENU,
  SEND_TO_COMPANY,
} from '../../outsourceBoardTypes';

const ElCardStub = defineComponent({
  name: 'ElCardStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-card-stub' }, [slots.header?.(), slots.default?.()]);
  },
});
const ElTagStub = defineComponent({
  name: 'ElTagStub',
  props: { size: String, type: String },
  setup:
    (_, { slots }) =>
    () =>
      h('span', { class: 'el-tag-stub' }, slots.default?.()),
});
const ElEmptyStub = defineComponent({
  name: 'ElEmptyStub',
  props: { description: String, imageSize: Number },
  setup:
    (_, { slots }) =>
    () =>
      h('div', { class: 'el-empty-stub' }, slots.default?.()),
});

const globalConfig = {
  components: { ElCard: ElCardStub, ElTag: ElTagStub, ElEmpty: ElEmptyStub },
};

const COMPANY_ID = '9000000000001';
const OTHER_COMPANY_ID = '9000000000002';
const SHELF_ID = '5000000000001';

function makeHeld(overrides: Partial<OutsourceQueueHeldBatchData> = {}): OutsourceQueueHeldBatchData {
  return {
    batch_id: '3000000000002',
    part_id: '4000000000002',
    batch_no: 1025,
    quantity: 8,
    serial_no: null,
    drawing_no: 'DRW-2',
    name: '齿轮',
    system_delivery_date: null,
    planned_delivery_date: '2026-10-25',
    is_urgent: true,
    customer_name: '某某零件厂',
    parent_customer_name: null,
    applicant_name: null,
    location: 'OUTSOURCE_COMPANY',
    note: null,
    version: 5,
    sent_at: '2026-10-01T09:00:00',
    price: '8.00',
    receive_next_process_id: '2000000000002',
    receive_next_process_name: '装配',
    chain_resolvable: true,
    has_cnc_program: false,
    ...overrides,
  };
}

function makeCompany(
  held: OutsourceQueueHeldBatchData[] = [makeHeld()],
  overrides: Partial<OutsourceQueueCompanyData> = {},
): OutsourceQueueCompanyData {
  return {
    company_id: COMPANY_ID,
    name: '外协厂甲',
    held_count: held.length,
    held_batches: held,
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<OutsourceQueueCandidateData> = {},
): OutsourceQueueCandidateData {
  return {
    version: 3,
    send_mode: 'APPROVAL',
    part_id: '4000000000001',
    part_serial_no: 'SN-0001',
    part_drawing_no: 'DRW-1',
    part_name: '连杆',
    quantity: 12,
    batch_id: '3000000000001',
    batch_no: 1024,
    planned_delivery_date: '2026-10-20',
    is_urgent: false,
    customer_name: '某某零件厂',
    parent_customer_name: '某某集团',
    shelf_code: 'A-01',
    shelf_id: SHELF_ID,
    outsource_company_id: COMPANY_ID,
    outsource_company_name: '外协厂甲',
    quote_id: '7000000000001',
    company_options: [],
    price: '12.50',
    has_cnc_program: true,
    applicant_name: '张三',
    note: null,
    system_delivery_date: '2026-10-18',
    can_send: true,
    ...overrides,
  };
}

/** DIRECT 候选（company_options 是 DIRECT 路径的公司下拉源）。 */
function makeDirectCandidate(overrides: Partial<OutsourceQueueCandidateData> = {}) {
  return makeCandidate({
    send_mode: 'DIRECT',
    outsource_company_id: null,
    outsource_company_name: null,
    quote_id: null,
    company_options: [{ id: OTHER_COMPANY_ID, name: '外协厂乙' }],
    ...overrides,
  });
}

function mountColumn(
  props: {
    company?: OutsourceQueueCompanyData;
    candidates?: OutsourceQueueCandidateData[];
    selectedIds?: Set<string>;
  } = {},
  provide: Record<string, unknown> = {},
) {
  return mount(CompanyColumn, {
    props: {
      company: props.company ?? makeCompany(),
      candidates: props.candidates ?? [makeCandidate()],
      selectedIds: props.selectedIds ?? new Set<string>(),
    },
    global: {
      components: globalConfig.components,
      provide: { [SEND_TO_COMPANY]: vi.fn(async () => true), ...provide },
    },
  });
}

function capturedOptions(): Record<string, unknown> {
  expect(captured.calls).toHaveLength(1);
  return captured.calls[0]!.options;
}

/** 造一个形状与 Sortable 原生 onAdd 事件一致的最小载荷。 */
function dragEvent(batchId: string) {
  const item = document.createElement('div');
  item.dataset.batchId = batchId;
  const from = document.createElement('div');
  from.dataset.processId = '2000000000001';
  return { item, from };
}

/** 模拟候选池 onStart 记下的源条目（真实 dndSourceTracker 实现）。 */
function recordPoolDrag(batchId: string, companyId: string) {
  recordOutsourceSource(batchId, {
    processId: '2000000000001',
    shelfId: SHELF_ID,
    version: 3,
    companyId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.calls.length = 0;
  captured.starts.length = 0;
});

describe('CompanyColumn（外协公司列：投放落点分发）', () => {
  it('D1：Sortable 用二参重载（不传 list）—— 渲染源与 list 不同源', () => {
    const wrapper = mountColumn();
    expect(captured.calls[0]!.list).toBeNull();
    wrapper.unmount();
  });

  it('D2：group = outsource-send 且 pull:false / put:true', () => {
    const wrapper = mountColumn();
    expect(capturedOptions().group).toEqual({ name: 'outsource-send', pull: false, put: true });
    wrapper.unmount();
  });

  it('D3：onRemove 把被拖节点放回 from.children[oldIndex]（二参形态的 DOM 放回补齐）', () => {
    const wrapper = mountColumn();
    const onRemove = capturedOptions().onRemove as (e: unknown) => void;
    expect(typeof onRemove).toBe('function');

    // 造出「源列 [A, 卡片, C] → Sortable 已把卡片搬进落点列」的现场
    const source = document.createElement('div');
    const a = document.createElement('div');
    a.id = 'a';
    const card = document.createElement('div');
    card.id = 'card';
    const c = document.createElement('div');
    c.id = 'c';
    const target = document.createElement('div');
    source.append(a, c);
    target.appendChild(card);

    onRemove({ item: card, from: source, oldIndex: 1 });

    expect(card.parentElement).toBe(source);
    expect(Array.from(source.children).map((el) => el.id)).toEqual(['a', 'card', 'c']);
    expect(target.children).toHaveLength(0);
    wrapper.unmount();
  });

  it('D4：sort:false（列内重排无语义，二参形态下也没人回滚 DOM 顺序）', () => {
    const wrapper = mountColumn();
    expect(capturedOptions().sort).toBe(false);
    wrapper.unmount();
  });

  it('D5：容器带 data-company-id，卡片带 data-batch-version', () => {
    const wrapper = mountColumn();
    const container = wrapper.find('.col-body');
    expect((container.element as HTMLElement).dataset.companyId).toBe(COMPANY_ID);
    expect((container.find('.batch-card').element as HTMLElement).dataset.batchVersion).toBe('5');
    wrapper.unmount();
  });

  it('D6：既无候选池源 → 零请求', async () => {
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn({}, { [SEND_TO_COMPANY]: sendToCompany });
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('D7a：APPROVAL 行落到报价锁定的公司列 → 发请求（候选行 + 本列 id）', async () => {
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn({ candidates: [makeCandidate()] }, { [SEND_TO_COMPANY]: sendToCompany });
    recordPoolDrag('3000000000001', COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).toHaveBeenCalledTimes(1);
    expect(sendToCompany.mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY_ID,
      candidate: { batch_id: '3000000000001', send_mode: 'APPROVAL' },
    });
    wrapper.unmount();
  });

  it('D7b（守卫①）：APPROVAL 行落到别的公司列 → 早退、零请求 + 报价锁定提示', async () => {
    const { ElMessage } = await import('element-plus');
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      { company: makeCompany([], { company_id: OTHER_COMPANY_ID, name: '外协厂乙' }) },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag('3000000000001', COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith(
      '该批次已由报价锁定外协公司，不能改投其它公司',
    );
    wrapper.unmount();
  });

  it('D7c（守卫①）：DIRECT 行落到 company_options 内的公司 → 放行', async () => {
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      {
        company: makeCompany([], { company_id: OTHER_COMPANY_ID, name: '外协厂乙' }),
        candidates: [makeDirectCandidate()],
      },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag('3000000000001', ''); // DIRECT 行记空串
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).toHaveBeenCalledTimes(1);
    expect(sendToCompany.mock.calls[0]![0]).toMatchObject({ companyId: OTHER_COMPANY_ID });
    wrapper.unmount();
  });

  it('D7d（守卫①）：DIRECT 行落到不在 company_options 内的公司 → 早退、零请求', async () => {
    const { ElMessage } = await import('element-plus');
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      { candidates: [makeDirectCandidate()] },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag('3000000000001', '');
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('所选外协公司不在该批次的可发送范围内');
    wrapper.unmount();
  });

  it('D8（守卫②）：can_send === false 的行不接受投放', async () => {
    const { ElMessage } = await import('element-plus');
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      { candidates: [makeCandidate({ can_send: false })] },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag('3000000000001', COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith(
      '该批次当前不可发送（无可用报价或外协公司）',
    );
    wrapper.unmount();
  });

  it('D9a（守卫③）：version 为 0 → 早退、零请求', async () => {
    const { ElMessage } = await import('element-plus');
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      { candidates: [makeCandidate({ version: 0 })] },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag('3000000000001', COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('批次版本信息缺失，无法移动');
    wrapper.unmount();
  });

  it('D9b（守卫③）：version 为 NaN → 早退、零请求', async () => {
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      { candidates: [makeCandidate({ version: Number.NaN })] },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag('3000000000001', COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('D9c（守卫③）：shelf_id 为空串（PENDING 未上架）→ 早退、零请求', async () => {
    const { ElMessage } = await import('element-plus');
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      { candidates: [makeCandidate({ shelf_id: '', shelf_code: null })] },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag('3000000000001', COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('该批次尚未上架，请先下发到生产货架');
    wrapper.unmount();
  });

  it('D10：候选已不在当前工序的可发送集合 → 早退、零请求', async () => {
    const { ElMessage } = await import('element-plus');
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn({ candidates: [] }, { [SEND_TO_COMPANY]: sendToCompany });
    recordPoolDrag('3000000000001', COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(
      dragEvent('3000000000001'),
    );
    expect(sendToCompany).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('已不在当前工序的可发送候选中');
    wrapper.unmount();
  });

  it('D11：多选拖拽 → 串行发 move，成功的移出勾选、失败的留下并汇总 error', async () => {
    const { ElMessage } = await import('element-plus');
    const a = makeCandidate();
    const b = makeCandidate({ batch_id: '3000000000003', batch_no: 3, version: 4 });
    // 第 2 个批次 OCC 冲突（后端 40901）⇒ 包装返回 false
    const sendToCompany = vi.fn(
      async (input: { candidate: OutsourceQueueCandidateData; companyId: string }) =>
        input.candidate.batch_id !== b.batch_id,
    );
    const selected = new Set<string>([a.batch_id, b.batch_id]);
    const wrapper = mountColumn(
      { candidates: [a, b], selectedIds: selected },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag(a.batch_id, COMPANY_ID);
    recordPoolDrag(b.batch_id, COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(dragEvent(a.batch_id));

    expect(sendToCompany).toHaveBeenCalledTimes(2);
    expect(sendToCompany.mock.calls.map((c) => c[0].candidate.batch_id)).toEqual([
      a.batch_id,
      b.batch_id,
    ]);
    // 上抛的勾选集合只留失败的那张
    const emitted = wrapper.emitted('update:selectedIds');
    expect(emitted).toHaveLength(1);
    expect(Array.from(emitted![0]![0] as Set<string>)).toEqual([b.batch_id]);
    expect(ElMessage.error).toHaveBeenCalledWith(
      expect.stringContaining('发送失败 1 个（成功 1 个）'),
    );
    wrapper.unmount();
  });

  it('D11b：单张投放（勾选集 ≤ 1）只发那一张，且不上抛勾选', async () => {
    const a = makeCandidate();
    const b = makeCandidate({ batch_id: '3000000000003', batch_no: 3 });
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      { candidates: [a, b], selectedIds: new Set<string>([a.batch_id]) },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag(a.batch_id, COMPANY_ID);
    recordPoolDrag(b.batch_id, COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(dragEvent(a.batch_id));
    expect(sendToCompany).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('update:selectedIds')).toBeUndefined();
    wrapper.unmount();
  });

  it('D11c：拖未勾选的卡 → 只发那一张（勾选集大于 1 也不扩范围）', async () => {
    const a = makeCandidate();
    const b = makeCandidate({ batch_id: '3000000000003', batch_no: 3 });
    const sendToCompany = vi.fn(async (_input: { candidate: OutsourceQueueCandidateData; companyId: string }) => true);
    const wrapper = mountColumn(
      { candidates: [a, b], selectedIds: new Set<string>([b.batch_id]) },
      { [SEND_TO_COMPANY]: sendToCompany },
    );
    recordPoolDrag(a.batch_id, COMPANY_ID);
    await (capturedOptions().onAdd as (e: unknown) => Promise<void>)(dragEvent(a.batch_id));
    expect(sendToCompany).toHaveBeenCalledTimes(1);
    expect(sendToCompany.mock.calls[0]![0]).toMatchObject({ candidate: { batch_id: a.batch_id } });
    wrapper.unmount();
  });

  it('D12：未 provide sendToCompany 时落点退化为不发请求、不抛错', async () => {
    const wrapper = mount(CompanyColumn, {
      props: {
        company: makeCompany(),
        candidates: [makeCandidate()],
        selectedIds: new Set<string>(),
      },
      global: { components: globalConfig.components },
    });
    recordPoolDrag('3000000000001', COMPANY_ID);
    await expect(
      (capturedOptions().onAdd as (e: unknown) => Promise<void>)(dragEvent('3000000000001')),
    ).resolves.not.toThrow();
    wrapper.unmount();
  });

  it('D13：卡片右键 → opener 带 held + companyId/companyName 被调一次', async () => {
    const openOutsourceBatchMenu = vi.fn();
    const held = makeHeld();
    const wrapper = mountColumn(
      { company: makeCompany([makeHeld({ batch_id: '3000000000001' }), held]) },
      { [OPEN_OUTSOURCE_BATCH_MENU]: openOutsourceBatchMenu },
    );
    const cards = wrapper.findAll('.col-body .batch-card');
    expect(cards).toHaveLength(2);
    await cards[1]!.trigger('contextmenu', { clientX: 320, clientY: 240 });

    expect(openOutsourceBatchMenu).toHaveBeenCalledTimes(1);
    const [evt, batch, ctx] = openOutsourceBatchMenu.mock.calls[0]! as [
      MouseEvent,
      { batch_id: string; version?: number },
      { kind: string; held: { batch_id: string }; companyId: string; companyName: string },
    ];
    expect((evt as MouseEvent).clientX).toBe(320);
    // 第三参带在途 DTO 与所在公司（公司字段只在列上，卡片上取不到）
    expect(ctx.kind).toBe('held');
    expect(ctx.held.batch_id).toBe('3000000000002');
    expect(ctx.companyId).toBe(COMPANY_ID);
    expect(ctx.companyName).toBe('外协厂甲');
    expect(batch.batch_id).toBe('3000000000002');
    wrapper.unmount();
  });

  it('D13b：未 provide opener 时右键不抛错（inject 缺省 noop）', async () => {
    const wrapper = mount(CompanyColumn, {
      props: { company: makeCompany(), candidates: [], selectedIds: new Set<string>() },
      global: { components: globalConfig.components },
    });
    const card = wrapper.find('.col-body .batch-card');
    await expect(card.trigger('contextmenu')).resolves.not.toThrow();
    wrapper.unmount();
  });

  it('D14：空列仍是合法投放目标（容器在、空态是兄弟覆盖层、容器内零元素子节点）', async () => {
    const wrapper = mountColumn({ company: makeCompany([]) });
    const col = wrapper.find('.col-body').element as HTMLElement;
    expect(col.children).toHaveLength(0);
    expect(
      Array.from(col.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE),
    ).toHaveLength(0);
    const empty = wrapper.find('.col-empty');
    expect(empty.exists()).toBe(true);
    expect(empty.element.closest('.col-body')).toBeNull();
    // 关键：容器挂着 Sortable 实例（空公司列是主场景的投放目标）
    await nextTick();
    expect(captured.starts).toContain(col);
    wrapper.unmount();
  });

  it('D14b：容器内只有卡片（无注释节点、无空态混入）', () => {
    const wrapper = mountColumn({
      company: makeCompany([makeHeld({ batch_id: '3000000000001' }), makeHeld()]),
    });
    const col = wrapper.find('.col-body').element as HTMLElement;
    const nodes = Array.from(col.childNodes);
    expect(nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE)).toHaveLength(2);
    expect(nodes.filter((n) => n.nodeType === Node.COMMENT_NODE)).toHaveLength(0);
    expect(wrapper.find('.col-empty').exists()).toBe(false);
    wrapper.unmount();
  });

  it('D15：scoped style 里定义了 :deep(.sortable-ghost)（拖拽反馈的半透明占位）', () => {
    // ghostClass 设了但没人给它样式 ⇒ 从候选池拖进来时完全没有视觉反馈。生产队列域的
    // WorkerColumn / PoolDrawer 正缺这条。
    // 断言读的是**源码文本**：scoped style 不进单测环境的 DOM（happy-dom 无样式注入），
    // DOM 侧断言不到这条不变式。仓库另有 `elementPlusManualImportStyles.spec.ts` 用
    // 同款 readFileSync 范式。
    // ⚠️ 不走 `new URL(...)`：happy-dom 会换掉全局 `URL`，它解析出来的实例过不了 Node
    // `readFileSync` 的 file-scheme 判定（抛「The URL must be of scheme file」）。
    // 直接把 `import.meta.url` 的 file://  scheme 摘掉当路径用。
    const here = dirname(import.meta.url.replace(/^file:\/\//, ''));
    const src = readFileSync(join(here, '..', 'CompanyColumn.vue'), 'utf-8');
    expect(src).toContain("ghostClass: 'sortable-ghost'");
    expect(src).toMatch(/:deep\(\.sortable-ghost\)\s*\{\s*opacity:\s*0\.4;/);
  });
});