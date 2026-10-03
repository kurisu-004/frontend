// @vitest-environment happy-dom
// src/views/scan/__tests__/ScanReturnChainFlow.spec.ts
//
// 2026-10-04 新增：放回流程「按 chain_state 分流」三条分支的回归守卫。
//
// 报工台放回页此前只有一条路径：选件 → 选工序 → 选货架。零件定了工序链之后，工人完成
// 当前工序放回时**下一道工序是后端已知的**（行 VO 的 chain_state / chain_next_process_*），
// 再让他点一遍工序 + 点一遍货架就是纯重复劳动。改动后按 chain_state 三态分流：
//
//   NEXT（链内有下一道）→ 不开工序选择弹窗，拉候选货架取推荐架，直接开单确认弹窗；
//   TAIL（链内最后一道）→ 先 warning「加工完成后请送检」，再回退手选工序；
//   NONE（无链 / 软删 / 指针漂移）→ 行为与改动前逐字一致。
//
// 这批用例守三件容易静默坏掉的事：
//   1. 分流判据写错（拿 chain_state 之外的东西判 / 三态写串）—— 症状是链已知时仍弹
//      工序选择，且**没有任何报错**；或 TAIL 被当成 NEXT 让工人「再放回一次」；
//   2. 兜底出口被删掉 —— 候选架为空 / 推荐架缺失 / 链字段异常时工人被卡死在
//      「该工序暂无可用货架」上，没有任何路可走；
//   3. 确认放回提交的参数不是派生出来的值（工序 id / 货架 id 串了）—— 工件会落到
//      没配该工序的架上（后端 20507），返工成本由现场承担。
//
// 桩的取舍：
//   - `@/api/parts` / `@/api/shelves` 整模块桩掉：本页与 api 层是「直接 await + 手写
//     ref」范式（报工台域不用 TanStack Query），不桩就真发请求。
//   - `element-plus` 桩成 `{ ElMessage: { ...vi.fn() } }`：按 CLAUDE.md 约定。本页
//     所有提示（送检 warning / 无货架 warning / 提交成功失败）都走 ElMessage，桩掉才能
//     断言提示文案；node/happy-dom 下真实 ElMessage 也会污染输出。
//   - 三个弹窗：ProcessPickerDialog / ShelfPickerDialog 桩成带标记 class 的空壳（它们
//     各自要打 `listProcesses` / `listShelvesForReturn`，且内部 HmiPickerCard 与本组断言
//     无关）；ReturnConfirmDialog **用真组件**（它是本次分流的主角，文案与三个出口
//     都要验）。
//   - `PdfViewer` 桩掉：它 import pdfjs-dist，与放回分流无关，却会把单测拖进 pdf worker。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

// vi.mock 的工厂会被提升到文件顶部，不能引用后声明的 const ⇒ 所有桩函数集中放进
// vi.hoisted 暴露的那一个对象里。
const h = vi.hoisted(() => ({
  listPartsHeldByWorker: vi.fn(),
  workerScan: vi.fn(),
  listShelvesForReturn: vi.fn(),
  replace: vi.fn(),
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/parts', () => ({
  listPartsHeldByWorker: h.listPartsHeldByWorker,
  workerScan: h.workerScan,
}));

vi.mock('@/api/shelves', () => ({
  listShelvesForReturn: h.listShelvesForReturn,
}));

vi.mock('element-plus', () => ({ ElMessage: h.ElMessage }));

vi.mock('vue-router', () => ({ useRouter: () => ({ replace: h.replace }) }));

vi.mock('@/components/PdfViewer.vue', () => ({
  default: { name: 'PdfViewerStub', template: '<div class="stub-pdf" />' },
}));

import ScanReturnParts from '../ScanReturnParts.vue';
import ReturnConfirmDialog from '../components/ReturnConfirmDialog.vue';
import { useScanSession } from '@/composables/useScanSession';
import type { ScanPartRowSchema } from '@/composables/queries/schemas';

const WORKER = {
  id: '190000000000900',
  version: 1,
  badge_code: 'W-001',
  name: '张三',
  work_type_id: '190000000000901',
  is_active: true,
  created_at: '1970-01-01T00:00:00',
  updated_at: '1970-01-01T00:00:00',
};

/** 一行完整合法的 scanPartRowSchema（按 shape 造，值随用例覆盖）。
 *  chain_state 决定分流；chain_next_process_id 为 '0' 是 NONE / TAIL 的兜底值。 */
function row(over: Partial<ScanPartRowSchema> = {}): ScanPartRowSchema {
  return {
    id: '190000000000101',
    serial_no: 'F2256',
    name: '法兰盘',
    drawing_no: 'DWG-1',
    applicant_name: '',
    quantity: 2,
    request_date: null,
    planned_delivery_date: null,
    customer_id: '0',
    assembly_id: null,
    status: 'IN_PROCESS',
    is_urgent: false,
    order_no: null,
    system_delivery_date: null,
    note: null,
    unit_price: '0',
    total_price: '0',
    version: 0,
    created_at: '1970-01-01T00:00:00',
    created_by: null,
    updated_at: '1970-01-01T00:00:00',
    updated_by: null,
    deleted_at: null,
    process_chain_id: null,
    chain_state: 'NONE',
    chain_next_process_id: '0',
    chain_next_process_name: null,
    chain_current_process_name: null,
    customer_name: null,
    l1_customer_name: null,
    location: null,
    holder_name: null,
    row_type: 'PART',
    has_children: false,
    child_count: null,
    has_cnc_program: false,
    batch_id: '190000000000111',
    batch_version: 6,
    ...over,
  };
}

const RECOMMENDED = {
  id: '190000000000301',
  code: 'A-03',
  name: 'A 区 3 号架',
  zone: 'PRODUCTION',
  location: '一车间 A 区',
  current_load: 4,
  is_recommended: true,
};

const OTHER_SHELF = {
  id: '190000000000302',
  code: 'A-04',
  name: 'A 区 4 号架',
  zone: 'PRODUCTION',
  location: '一车间 A 区',
  current_load: 12,
  is_recommended: false,
};

const stubs = {
  // 三个弹窗的壳：el-dialog 渲染 default + footer 两个 slot，el-button 的原生 click
  // 由 attrs 透传到 <button>（本页的按钮点击断言就靠它）。
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title', 'width'],
    template: '<div class="mock-dialog" :data-title="title"><slot /><slot name="footer" /></div>',
  },
  'el-button': { name: 'ElButtonStub', template: '<button><slot /></button>' },
  'el-card': { name: 'ElCardStub', template: '<div class="mock-card"><slot /></div>' },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  'el-divider': { name: 'ElDividerStub', template: '<hr />' },
  'el-image': { name: 'ElImageStub', template: '<div />' },
  'el-badge': { name: 'ElBadgeStub', template: '<div><slot /></div>' },
  // 本组只关心分流，手选路径的两个弹窗换成带标记的空壳（省掉 listProcesses /
  // HmiPickerCard 的依赖），标记 class 就是断言锚点。
  ProcessPickerDialog: {
    name: 'ProcessPickerDialogStub',
    props: ['modelValue'],
    template: '<div class="stub-process-picker" />',
  },
  ShelfPickerDialog: {
    name: 'ShelfPickerDialogStub',
    props: ['modelValue', 'nextProcessId'],
    template: '<div class="stub-shelf-picker" />',
  },
  HeldPartsBadge: { name: 'HeldPartsBadgeStub', template: '<div />' },
  ScrollFabPair: { name: 'ScrollFabPairStub', template: '<div />' },
  QuantityDialog: { name: 'QuantityDialogStub', template: '<div />' },
  BatchPickerDialog: { name: 'BatchPickerDialogStub', template: '<div />' },
};

async function mountPage(items: ScanPartRowSchema[]) {
  h.listPartsHeldByWorker.mockResolvedValue({ items, total: items.length, limit: 200, offset: 0 });
  const w = mount(ScanReturnParts, { global: { stubs } });
  await flushPromises();
  return w;
}

/** 点第一张零件卡（列表行单位是批次，`.part-row` 是 el-card 落下来的 class）。 */
async function clickFirstPart(w: Awaited<ReturnType<typeof mountPage>>): Promise<void> {
  await w.findAll('.part-row')[0]!.trigger('click');
  await flushPromises();
}

function dialogText(w: Awaited<ReturnType<typeof mountPage>>): string {
  return w.findComponent(ReturnConfirmDialog).text();
}

async function clickConfirmBar(w: Awaited<ReturnType<typeof mountPage>>, text: string) {
  const btn = w.findAll('button').find((b) => b.text() === text);
  if (!btn) throw new Error(`找不到按钮「${text}」`);
  await btn.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  h.listPartsHeldByWorker.mockReset();
  h.workerScan.mockReset().mockResolvedValue(undefined);
  h.listShelvesForReturn.mockReset();
  h.ElMessage.success.mockReset();
  h.ElMessage.error.mockReset();
  h.ElMessage.warning.mockReset();
  h.ElMessage.info.mockReset();
  h.replace.mockReset();
  // 扫码 session 是模块级单例：每个用例都要有工人，否则 onBeforeMount 的
  // requireWorker 守卫直接把本站重定向走。
  useScanSession().setWorker(WORKER);
});

describe('ScanReturnParts / chain_state 三态分流', () => {
  it('NEXT：不开工序选择弹窗，直接开单确认框，文案含派生工序名 + 推荐架 code', async () => {
    h.listShelvesForReturn.mockResolvedValue({ items: [OTHER_SHELF, RECOMMENDED] });
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
        chain_current_process_name: 'SAW-02 锯切',
      }),
    ]);

    await clickFirstPart(w);

    // 关键断言：工序选择弹窗不能开
    expect(w.find('.stub-process-picker').exists()).toBe(false);
    // 推荐架那一候选被选中（列表里 is_recommended 不在首位，取它才说明真按推荐选了）
    expect(h.listShelvesForReturn).toHaveBeenCalledWith('190000000000131');
    expect(dialogText(w)).toContain('下一道工序为 CUT-01 下料，请将工件放到 A-03 货架');
    // 确认栏也跟着显示派生的下一工序 + 目标货架，而不是「未选 / 待选货架」
    expect(w.find('.confirm-bar').text()).toContain('下一工序：CUT-01 下料');
    expect(w.find('.confirm-bar').text()).toContain('目标货架 A-03');
    // 货架点选弹窗同样不该开
    expect(w.find('.stub-shelf-picker').exists()).toBe(false);
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  it('NEXT + 确认放回：workerScan 收到派生的 next_process_id 与推荐架 id，成功后件从列表消失', async () => {
    h.listShelvesForReturn.mockResolvedValue({ items: [RECOMMENDED] });
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    await clickConfirmBar(w, '确认放回');

    expect(h.workerScan).toHaveBeenCalledTimes(1);
    expect(h.workerScan).toHaveBeenCalledWith({
      serial_no: 'F2256',
      badge_code: 'W-001',
      event_type: 'RETURNED',
      shelf_id: '190000000000301',
      next_process_id: '190000000000131',
      batch_id: '190000000000111',
    });
    expect(h.ElMessage.success).toHaveBeenCalledTimes(1);
    // 提交后重新拉列表：后端把该件移走 ⇒ 页面上不再有选中态，确认框也收掉
    expect(w.find('.confirm-bar').exists()).toBe(false);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    expect(h.listPartsHeldByWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('NEXT + 候选架为空：warning 后回退手选工序（不把工人卡死）', async () => {
    h.listShelvesForReturn.mockResolvedValue({ items: [] });
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    expect(h.ElMessage.warning).toHaveBeenCalledWith('该工序暂无可用货架，请手动选择工序');
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    // 选中件必须留着：否则工人选完工序 / 选完架后 submitReturn 会 bail
    expect(w.find('.confirm-bar').exists()).toBe(true);
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  it('NEXT + 确认框点「手动选择工序」：关确认框并回退手选工序', async () => {
    h.listShelvesForReturn.mockResolvedValue({ items: [RECOMMENDED] });
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    await clickConfirmBar(w, '手动选择工序');

    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    // 链派生的答案要清干净，确认栏不得留着上一轮的「目标货架 A-03」
    expect(w.find('.confirm-bar').text()).toContain('待选货架');
    expect(w.find('.confirm-bar').text()).not.toContain('A-03');
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  it('NEXT + 候选架请求失败：error 后回退手选工序', async () => {
    h.listShelvesForReturn.mockRejectedValue(new Error('40300 无权限'));
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    expect(h.ElMessage.error).toHaveBeenCalledWith('40300 无权限');
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
  });

  it('TAIL：先 warning「加工完成后请送检」（点名当前工序），再开工序选择弹窗', async () => {
    const w = await mountPage([
      row({
        chain_state: 'TAIL',
        chain_next_process_id: '0',
        chain_next_process_name: null,
        chain_current_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    expect(h.ElMessage.warning).toHaveBeenCalledWith(
      '「CUT-01 下料」为最后一道工序，加工完成后请送检。',
    );
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    // TAIL 没有下一道 ⇒ 一次货架请求都不该发
    expect(h.listShelvesForReturn).not.toHaveBeenCalled();
  });

  it('TAIL 且当前工序名解析不出：退到通用送检文案', async () => {
    const w = await mountPage([
      row({
        chain_state: 'TAIL',
        chain_next_process_id: '0',
        chain_next_process_name: null,
        chain_current_process_name: null,
      }),
    ]);
    await clickFirstPart(w);

    expect(h.ElMessage.warning).toHaveBeenCalledWith('当前为最后一道工序，加工完成后请送检。');
    expect(w.find('.stub-process-picker').exists()).toBe(true);
  });

  it('NONE：不发货架请求，直接走原三步路径（工序选择 → 货架点选）', async () => {
    const w = await mountPage([row({ chain_state: 'NONE', chain_next_process_id: '0' })]);
    await clickFirstPart(w);

    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    expect(h.listShelvesForReturn).not.toHaveBeenCalled();
    expect(h.ElMessage.warning).not.toHaveBeenCalled();
    expect(w.find('.confirm-bar').text()).toContain('下一工序：未选');
    expect(w.find('.confirm-bar').text()).toContain('待选货架');
  });

  it("chain_next_process_id 为兜底值 '0'：不发 listShelvesForReturn（'0' 不是真 id）", async () => {
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '0',
        chain_next_process_name: null,
        chain_current_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    expect(h.listShelvesForReturn).not.toHaveBeenCalled();
    expect(h.ElMessage.warning).toHaveBeenCalledWith('未找到下一道工序，请手动选择工序');
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
  });

  it('确认框「取消」：整次选择作废，不提交', async () => {
    h.listShelvesForReturn.mockResolvedValue({ items: [RECOMMENDED] });
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    await clickConfirmBar(w, '取消');

    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    expect(w.find('.confirm-bar').exists()).toBe(false);
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  // 竞态守卫：`openChainConfirm` 里有一次货架请求往返，这期间工人可以点同一张卡反选。
  // 不丢弃在途响应的话，它回来会为「已经被取消的件」弹出一个确认框 —— 点确认后
  // submitReturn 因 selectedPart 为空 bail，工人看到的是一个点不动的死框。
  it('候选架在途时反选同一件：在途响应被丢弃，不弹确认框', async () => {
    let settle: (v: { items: (typeof RECOMMENDED)[] }) => void = () => {};
    h.listShelvesForReturn.mockReturnValue(
      new Promise<{ items: (typeof RECOMMENDED)[] }>((res) => {
        settle = res;
      }),
    );
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);
    // 请求还挂着：此刻任何弹窗都不该出现
    expect(h.listShelvesForReturn).toHaveBeenCalledTimes(1);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);

    // 反选同一件（取消选择），随后在途响应才回来
    await w.findAll('.part-row')[0]!.trigger('click');
    settle({ items: [RECOMMENDED] });
    await flushPromises();

    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    expect(w.find('.stub-process-picker').exists()).toBe(false);
    expect(w.find('.confirm-bar').exists()).toBe(false);
    expect(h.workerScan).not.toHaveBeenCalled();
  });
});
