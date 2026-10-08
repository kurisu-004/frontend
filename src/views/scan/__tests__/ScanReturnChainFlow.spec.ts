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
//   TAIL（链内最后一道）→ 工序选择弹窗内常驻提示「加工完成后请送检」，工人手选工序；
//   NONE（无链 / 软删 / 指针漂移 / 未知取值）→ 行为与改动前逐字一致。
//
// 这批用例守四件容易静默坏掉的事：
//   1. 分流判据写错（拿 chain_state 之外的东西判 / 三态写串）—— 症状是链已知时仍弹
//      工序选择，且**没有任何报错**；或 TAIL 被当成 NEXT 让工人「再放回一次」；
//   2. 兜底出口被删掉 —— 候选架为空 / 推荐架缺失 / 链字段异常时工人被卡死在
//      「该工序暂无可用货架」上，没有任何路可走；
//   3. 确认放回提交的参数不是派生出来的值（工序 id / 货架 id 串了）—— 工件会落到
//      没配该工序的架上（后端 20507），返工成本由现场承担；
//   4. 候选货架请求在途时切到另一件 —— 旧响应回来会与新弹窗并存，工人一点就把**当前
//      这件**记到**上一件**的工序 / 货架上（后端要么 20507，要么静默记错，现场无从
//      察觉）。这是 HMI 触屏下最危险的一条，改动前的用例只覆盖了「反选同一件」。
//
// 桩的取舍：
//   - `@/api/parts` / `@/api/shelves` 整模块桩掉：本页与 api 层是「直接 await + 手写
//     ref」范式（报工台域不用 TanStack Query），不桩就真发请求。
//   - `element-plus` 桩成 `{ ElMessage: { ...vi.fn() } }`：按 CLAUDE.md 约定。本页
//     所有提示（无货架 warning / 提交成功失败）都走 ElMessage，桩掉才能断言提示文案；
//     node/happy-dom 下真实 ElMessage 也会污染输出。
//   - `@/composables/useBarcodeScanner` 桩掉并把注册的 handler 抓出来：扫码是本页
//     与点选并行的第二个入口（`applyScanSelection`），不桩就得模拟键盘时序。
//   - 两个弹窗：ProcessPickerDialog / ShelfPickerDialog 桩成带标记 class 的空壳（它们
//     各自要打 `listProcesses` / `listShelvesForReturn`，且内部 HmiPickerCard 与本组断言
//     无关）；ProcessPickerDialog 的空壳额外把 `hint` 透出成 data-*，用来验链尾送检
//     提醒进了弹窗。ReturnConfirmDialog **用真组件**（它是本次分流的主角，文案与三个
//     出口都要验）。
//   - `PdfViewer` 桩掉：它 import pdfjs-dist，与放回分流无关，却会把单测拖进 pdf worker。
//
// 2026-10-09 追加：列表卡**左边框**的链语义着色（同一批数据、另一条独立语义 ——
// 「有没有链」不是「链上还有没有下一道」）。放在本文件复用上面这套挂载脚手架，
// 详见文件末尾那一组用例。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

// vi.mock 的工厂会被提升到文件顶部，不能引用后声明的 const ⇒ 所有桩函数集中放进
// vi.hoisted 暴露的那一个对象里。
const h = vi.hoisted(() => ({
  listPartsHeldByWorker: vi.fn(),
  workerScan: vi.fn(),
  listShelvesForReturn: vi.fn(),
  replace: vi.fn(),
  scanHandlers: [] as ((code: string) => void)[],
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

// 真实实现是 window.keydown 单例；这里只保留「注册 handler」这一半，让用例能直接
// 触发一次扫码。onScan 的返回值（退订函数）也要给，否则组件卸载时会炸。
vi.mock('@/composables/useBarcodeScanner', () => ({
  useBarcodeScanner: () => ({
    onScan: (fn: (code: string) => void) => {
      h.scanHandlers.push(fn);
      return () => {};
    },
  }),
}));

vi.mock('@/components/PdfViewer.vue', () => ({
  default: { name: 'PdfViewerStub', template: '<div class="stub-pdf" />' },
}));

import ScanReturnParts from '../ScanReturnParts.vue';
import ReturnConfirmDialog from '../components/ReturnConfirmDialog.vue';
import { SCAN_LIST_CONTRACT_DRIFT_TEXT } from '@/views/scan/composables/scanListErrorMessage';
import { CHAIN_BORDER_COLOR, NO_CHAIN_BORDER_COLOR } from '@/views/scan/chainAccent';
import { useScanSession } from '@/composables/useScanSession';
import type { ScanPartRowSchema } from '@/composables/queries/schemas';
import { ZodError } from 'zod';

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
    has_process_chain: false,
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

/** 模拟「后端漏发链四件套」的行：真路径上 scanPartRowSchema 把四键补成默认值
 *  （chain_state 留 undefined / 另三个取后端兜底），这里把键整个删掉，验证页面读到
 *  undefined 时的降级行为。 */
function rowWithoutChainFields(over: Partial<ScanPartRowSchema> = {}): ScanPartRowSchema {
  const full = row(over);
  const bare: Record<string, unknown> = { ...full };
  for (const key of [
    'chain_state',
    'chain_next_process_id',
    'chain_next_process_name',
    'chain_current_process_name',
  ]) {
    delete bare[key];
  }
  return bare as unknown as ScanPartRowSchema;
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

/** 让下一次 listShelvesForReturn 挂起，返回「手动放行在途响应」的函数。
 *  竞态用例要的就是「请求在途 ⇒ 页面上一个弹窗都没有、卡片完全可点」这个窗口。 */
function deferShelves(): (v: { items: (typeof RECOMMENDED)[] }) => void {
  let settle: (v: { items: (typeof RECOMMENDED)[] }) => void = () => {};
  h.listShelvesForReturn.mockReturnValue(
    new Promise<{ items: (typeof RECOMMENDED)[] }>((res) => {
      settle = res;
    }),
  );
  return settle;
}

/** 同上，挂在 workerScan（提交）上：产出 `submitting === true` 那个窗口。 */
function deferScan(): () => void {
  let settle: () => void = () => {};
  h.workerScan.mockReturnValue(
    new Promise<void>((res) => {
      settle = () => res(undefined);
    }),
  );
  return settle;
}

const stubs = {
  // 三个弹窗的壳：el-dialog 渲染 default + footer 两个 slot，el-button 的原生 click
  // 由 attrs 透传到 <button>（本页的按钮点击断言就靠它）。
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title', 'width'],
    template: '<div class="mock-dialog" :data-title="title"><slot /><slot name="footer" /></div>',
  },
  'el-button': {
    name: 'ElButtonStub',
    // disabled 显式声明成 prop 并透出成 data-*：留在 attrs 里时 Vue 会把它当 DOM prop
    // 落到根 <button>（el.disabled = x），attributes('disabled') 拿到的是 null，断言不到
    // 状态。data-* 透出是本目录 stub 的统一口径（同 ProcessPickerDialog.spec 的 el-alert）。
    props: { disabled: Boolean },
    template: '<button :data-disabled="String(disabled)"><slot /></button>',
  },
  'el-card': { name: 'ElCardStub', template: '<div class="mock-card"><slot /></div>' },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  'el-divider': { name: 'ElDividerStub', template: '<hr />' },
  'el-image': { name: 'ElImageStub', template: '<div />' },
  'el-badge': { name: 'ElBadgeStub', template: '<div><slot /></div>' },
  // 本组只关心分流，手选路径的两个弹窗换成带标记的空壳（省掉 listProcesses /
  // HmiPickerCard 的依赖），标记 class 就是断言锚点；ProcessPickerDialog 额外把
  // `hint` 透出成 data-*，用来验链尾送检提醒确实进了弹窗。
  ProcessPickerDialog: {
    name: 'ProcessPickerDialogStub',
    props: ['modelValue', 'hint'],
    template: '<div class="stub-process-picker" :data-hint="hint ?? \'\'" />',
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

/** 按序列号点零件卡。列表渲染顺序走的是客户端排序（id 降序，见 useScanPartsSort），
 *  不等于 mock 返回的行序，所以按序号取卡而不是按下标。 */
async function clickPartBySerial(
  w: Awaited<ReturnType<typeof mountPage>>,
  serial: string,
): Promise<void> {
  const card = w.findAll('.part-row').find((c) => c.text().includes(serial));
  if (!card) {
    const seen = w.findAll('.part-row').map((c) => c.find('.serial-no').text());
    throw new Error(`列表里没有序列号 ${serial} 的行，实际：${seen.join(' / ')}`);
  }
  await card.trigger('click');
  await flushPromises();
}

function dialogText(w: Awaited<ReturnType<typeof mountPage>>): string {
  return w.findComponent(ReturnConfirmDialog).text();
}

/** 工序选择弹窗弹出的横幅文案（链尾送检提醒传进来的 hint）。 */
function processHint(w: Awaited<ReturnType<typeof mountPage>>): string {
  return w.find('.stub-process-picker').attributes('data-hint') ?? '';
}

async function clickConfirmBar(w: Awaited<ReturnType<typeof mountPage>>, text: string) {
  const btn = w.findAll('button').find((b) => b.text() === text);
  if (!btn) throw new Error(`找不到按钮「${text}」`);
  await btn.trigger('click');
  await flushPromises();
}

/** 触发一次扫码（走 useBarcodeScanner 桩注册的 handler，即页面的 onScanToSelect）。 */
async function scan(w: Awaited<ReturnType<typeof mountPage>>, code: string): Promise<void> {
  const last = h.scanHandlers.at(-1);
  if (!last) throw new Error('页面没有注册扫码 handler');
  last(code);
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
  h.scanHandlers.length = 0;
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

  it('NEXT + 确认放回：workerScan 收到派生的 next_process_id 与推荐架 id，成功后选中态与确认框被清空', async () => {
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
    // 提交后重新拉列表。断言的是**状态收敛**而不是「件从列表消失」：本组把
    // listPartsHeldByWorker 桩成恒返同一行，列表里那件一直在，真正该验的是放回成功后
    // 选中态与确认框都被清掉（不清的话确认栏会留着上一件的工序名 / 货架名）。
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

  // 2026-10-04：契约漂移（ZodError）时不得把后端原文 / Zod 的 issues JSON 弹给工人 ——
  // 走同页 refresh 的 scanListErrorText 收口（人话给工人、细节给 console）。
  it('NEXT + 候选架请求契约漂移（ZodError）：给工人固定人话 + 细节进 console，回退手选工序', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.listShelvesForReturn.mockRejectedValue(
      new ZodError([{ code: 'custom', path: [], message: 'boom' }]),
    );
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    expect(h.ElMessage.error).toHaveBeenCalledWith(SCAN_LIST_CONTRACT_DRIFT_TEXT);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
  });

  // 无 message 的异常走 fallback：候选架请求失败也要有一句能读懂的话，而不是「undefined」
  // （scanListErrorText 只在 message 缺失时回落 fallback，message 为空串时逐字透传）。
  it('NEXT + 候选架请求抛无 message 的异常：回退手选工序并给 fallback 文案', async () => {
    h.listShelvesForReturn.mockRejectedValue({});
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    expect(h.ElMessage.error).toHaveBeenCalledWith('加载候选货架失败');
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
  });

  it('TAIL：工序选择弹窗内常驻「加工完成后请送检」提示（点名当前工序）', async () => {
    const w = await mountPage([
      row({
        chain_state: 'TAIL',
        chain_next_process_id: '0',
        chain_next_process_name: null,
        chain_current_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    expect(w.find('.stub-process-picker').exists()).toBe(true);
    // 提示必须是**弹窗内的常驻横幅**，不是 toast：后开的 el-dialog 遮罩必然盖住先发的
    // ElMessage，工人在产线屏幕前看不到那句 3 秒后自动消失的提示。
    expect(processHint(w)).toBe('「CUT-01 下料」为最后一道工序，加工完成后请送检。');
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

    expect(processHint(w)).toBe('当前为最后一道工序，加工完成后请送检。');
    expect(w.find('.stub-process-picker').exists()).toBe(true);
  });

  it('NONE：不发货架请求、不带横幅，直接走原三步路径（工序选择 → 货架点选）', async () => {
    const w = await mountPage([row({ chain_state: 'NONE', chain_next_process_id: '0' })]);
    await clickFirstPart(w);

    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(processHint(w)).toBe('');
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

  // 提交在途时确认栏的「取消选择」置灰：放回请求已发出，此时清选中态会让工人看到
  // 「我明明取消了，怎么还放回去了」。onCancelSelect 的守卫照旧拦着（真 el-button 上
  // disabled 根本不派发 click，stub 上会派发并被守卫挡下 —— 两条路径都不清）。
  it('提交在途：确认栏「取消选择」置灰且点了不生效，提交成功后照常清空', async () => {
    const settleScan = deferScan();
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

    const cancelBtn = w
      .find('.confirm-bar')
      .findAll('button')
      .find((b) => b.text() === '取消选择');
    expect(cancelBtn, '确认栏里没有「取消选择」按钮').toBeDefined();
    expect(cancelBtn!.attributes('data-disabled')).toBe('true');
    // stub 上 disabled 仍会派发 click：守卫必须把这次取消吃掉
    await cancelBtn!.trigger('click');
    await flushPromises();
    expect(w.find('.confirm-bar').exists()).toBe(true);
    expect(h.workerScan).toHaveBeenCalledTimes(1);

    settleScan();
    await flushPromises();
    expect(w.find('.confirm-bar').exists()).toBe(false);
  });

  // 竞态守卫（反选）：`openChainConfirm` 里有一次货架请求往返，这期间工人可以点同一张
  // 卡反选。不丢弃在途响应的话，它回来会为「已经被取消的件」弹出一个确认框 —— 点确认后
  // submitReturn 因 selectedPart 为空 bail，工人看到的是一个点不动的死框。
  it('候选架在途时反选同一件：在途响应被丢弃，不弹确认框', async () => {
    const settle = deferShelves();
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

  // 竞态守卫（切到另一件，HMI 触屏下最危险的一条）：NEXT 件 A 的候选架请求在途时，
  // **页面上没有任何弹窗、卡片完全可点**，工人点（防抖挡不住的 impatient 双击 / 扫码枪
  // 补扫）另一件 NONE 的 B。若作废点只放在 openChainConfirm 入口，A 的响应会带着
  // A 的工序与推荐架回来，而此时 showProcessDialog（B 的手选工序弹窗）已经开着 ——
  // 两个弹窗并存，工人点「确认放回」提交的是 **B 的 serial_no / batch_id + A 的
  // next_process_id / shelf_id**。后端要么 20507 报错，要么该架恰好也映射了 A 的工序
  // ⇒ B 被静默记到 A 的工序上，现场无从察觉。
  it('NEXT 件候选架在途时点选 NONE 件：在途响应被丢弃，只留 B 的工序选择弹窗', async () => {
    const settle = deferShelves();
    const w = await mountPage([
      row({
        serial_no: 'F-A',
        batch_id: '1900000000001A1',
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
      row({ serial_no: 'F-B', batch_id: '1900000000001B1', chain_state: 'NONE' }),
    ]);

    // 点 A：候选架请求挂起
    await w.findAll('.part-row')[0]!.trigger('click');
    await flushPromises();
    expect(h.listShelvesForReturn).toHaveBeenCalledTimes(1);
    expect(w.find('.stub-process-picker').exists()).toBe(false);
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);

    // 窗口内点 B（同步开工序选择弹窗，不发请求）
    await w.findAll('.part-row')[1]!.trigger('click');
    await flushPromises();
    expect(w.find('.stub-process-picker').exists()).toBe(true);

    // A 的响应这时才回来
    settle({ items: [RECOMMENDED] });
    await flushPromises();

    // A 的答案不得落地：没有确认框，确认栏不显示 A 的目标货架
    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    expect(w.find('.confirm-bar').text()).not.toContain('目标货架');
    expect(w.find('.confirm-bar').text()).not.toContain('CUT-01');
    expect(processHint(w)).toBe('');
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  // 同一条竞态的扫码入口：applyScanSelection → enterReturnFlow 是同一个分流，
  // 自增点也必须覆盖它（扫码枪连扫 / 补扫在 HMI 上比双击更常见）。
  it('NEXT 件候选架在途时扫码命中 NONE 件：在途响应被丢弃', async () => {
    const settle = deferShelves();
    const w = await mountPage([
      row({
        serial_no: 'F-A',
        batch_id: '1900000000001A1',
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
      row({ serial_no: 'F-B', batch_id: '1900000000001B1', chain_state: 'NONE' }),
    ]);

    await w.findAll('.part-row')[0]!.trigger('click');
    await flushPromises();
    expect(h.listShelvesForReturn).toHaveBeenCalledTimes(1);

    await scan(w, 'F-B');
    expect(w.find('.stub-process-picker').exists()).toBe(true);

    settle({ items: [RECOMMENDED] });
    await flushPromises();

    expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
    expect(w.find('.confirm-bar').text()).not.toContain('目标货架');
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  // 扫码入口的链分流本身（applyScanSelection → enterReturnFlow）：扫码命中 NEXT 件也走
  // 单确认框，不弹工序选择。此前这条链零覆盖。
  it('扫码命中 NEXT 件：走单确认框，不弹工序选择弹窗', async () => {
    h.listShelvesForReturn.mockResolvedValue({ items: [RECOMMENDED] });
    const w = await mountPage([
      row({
        serial_no: 'F-A',
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);

    await scan(w, 'F-A');

    expect(h.listShelvesForReturn).toHaveBeenCalledWith('190000000000131');
    expect(w.find('.stub-process-picker').exists()).toBe(false);
    expect(dialogText(w)).toContain('下一道工序为 CUT-01 下料，请将工件放到 A-03 货架');
  });

  // 2026-10-04 工序链四件套按「带默认值的必输出键」声明（理由见 schemas.ts
  // scanPartRowSchema.chain_state 的注释）：后端漏发这四个键时**页面必须仍可用** ——
  // 走 NONE 旧路径（弹工序选择），而不是在 API 边界抛 ZodError 让报工台三页全空。
  // 可诊断性由一次性 console.warn 补回（人话给工人、细节给 console）。
  //
  // 「只报一次」这条必须给**两行坏数据、依次选两次**才有牙：单行单次时 narrowChainState
  // 恰好被调 1 次，去重标志在不在结果都一样。列表一次最多 200 行、逐行 warn 会把真正的
  // 报错埋掉 ⇒ 「整个页面实例只报一次」是需求，两次窄化只报一次才是它的守卫。
  it('后端漏发链四件套：页面仍可用（走 NONE 旧路径），且整个页面实例只 console.warn 一次', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // id / batch_id 两行都不同：同 batch 会被 onSelect 当成「反选同一件」而根本不再
      // 走 enterReturnFlow，第二行就白给了。
      const w = await mountPage([
        rowWithoutChainFields({
          serial_no: 'F-101',
          id: '190000000000201',
          batch_id: '190000000000201',
        }),
        rowWithoutChainFields({
          serial_no: 'F-202',
          id: '190000000000101',
          batch_id: '190000000000101',
        }),
      ]);

      // 依次选中两件坏数据行 ⇒ narrowChainState 被调两次
      await clickPartBySerial(w, 'F-101');
      await clickPartBySerial(w, 'F-202');

      expect(w.find('.stub-process-picker').exists()).toBe(true);
      expect(processHint(w)).toBe('');
      expect(w.findComponent(ReturnConfirmDialog).exists()).toBe(false);
      // 列表一次最多 200 行，逐行 warn 会把真正的报错埋掉 ⇒ 两次窄化只报一次
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(consoleWarn.mock.calls[0]!.join(' ')).toContain('chain_state');
    } finally {
      consoleWarn.mockRestore();
    }
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  // 后端新增第四个 chain_state 取值（纯后端单方面改动）也只能降级、不能停工：
  // 未知字面量按 NONE 处理并整页只 warn 一次。守卫这条的是「不锁 z.enum」这个决定，
  // 两件坏行、选两次 —— 同上，单次窄化验证不了「一次」。
  it('chain_state 是未知取值：按 NONE 降级 + 两件只 warn 一次，不崩页', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = await mountPage([
        row({
          serial_no: 'F-301',
          id: '190000000000301',
          batch_id: '190000000000301',
          chain_state: 'SKIP' as unknown as string,
          chain_next_process_id: '190000000000131',
        }),
        row({
          serial_no: 'F-302',
          id: '190000000000302',
          batch_id: '190000000000302',
          chain_state: 'SKIP' as unknown as string,
          chain_next_process_id: '190000000000131',
        }),
      ]);

      await clickPartBySerial(w, 'F-301');
      await clickPartBySerial(w, 'F-302');

      expect(w.find('.stub-process-picker').exists()).toBe(true);
      expect(h.workerScan).not.toHaveBeenCalled();
      expect(h.listShelvesForReturn).not.toHaveBeenCalled();
      // 未知取值不做 NEXT 处理 ⇒ 一次货架请求都不发（连降级路径的派生答案都拿不到）
      expect(consoleWarn).toHaveBeenCalledTimes(1);
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

// ============================================================
// 2026-10-09 新增：列表卡**左边框**的链语义着色（与上面的 `chain_state` 分流同源，
// 但回答的是另一个问题 —— 这条批次有没有制定工序链）。
//
// 放在本文件而不是新开一个 spec：挂载脚手架（`@/api/parts` / `@/api/shelves` /
// `useBarcodeScanner` / 弹窗壳的整组 vi.mock + `mountPage` / `row()` fixture）在这里，
// 为一条边框断言复制一份上百行的桩，漂移成本高于收益。
//
// 顺带守一条易踩的坑：三页此前各有一套硬编码左边框色（取件蓝 / 放回琥珀 / 送检绿）
// 用来区分**流程**，而 `.part-row.is-urgent` 里还显式写了 `border-left-color: #f56c6c`
// —— 那条规则一旦留着，加急行的绿边框会被加急红压掉。两条都从 CSS 里删掉了。
// ============================================================
describe('ScanReturnParts — 列表卡左边框按 has_process_chain 着色', () => {
  /** 卡片的左边框色（模板 inline :style 给到 el-card，stub 落在根 div 上）。 */
  function borderLeftOf(card: { element: Element }): string {
    return (card.element as HTMLElement).style.borderLeftColor;
  }

  /** 把 CSS 颜色字面量归一到浏览器实际生效的形态（happy-dom 把 #rrggbb 转 rgb(...)）。 */
  function normalizeColor(color: string): string {
    const scratch = document.createElement('div');
    scratch.style.borderLeftColor = color;
    return scratch.style.borderLeftColor;
  }

  function cardBySerial(w: Awaited<ReturnType<typeof mountPage>>, serial: string) {
    const card = w.findAll('.part-row').find((c) => c.text().includes(serial));
    if (!card) throw new Error(`列表里没有序列号 ${serial} 的行`);
    return card;
  }

  it('有链且指针未漂移 ⇒ 绿边框；无链 ⇒ 中性边框（两态色值不同）', async () => {
    const w = await mountPage([
      row({
        serial_no: 'F-901',
        id: '190000000000901',
        batch_id: '190000000000901',
        has_process_chain: true,
      }),
      row({
        serial_no: 'F-902',
        id: '190000000000902',
        batch_id: '190000000000902',
        has_process_chain: false,
      }),
    ]);

    const chained = borderLeftOf(cardBySerial(w, 'F-901'));
    const noChain = borderLeftOf(cardBySerial(w, 'F-902'));
    expect(chained).toBe(normalizeColor(CHAIN_BORDER_COLOR));
    expect(noChain).toBe(normalizeColor(NO_CHAIN_BORDER_COLOR));
    expect(chained).not.toBe(noChain);
  });

  // 加急语义改由红底 + 「加急」tag 承担；边框让位给链。加急 + 有链的卡片必须是绿边框，
  // 加急 + 无链的必须是中性边框 —— 两种加急都不该染成加急红。
  it('加急不再染边框：红底 + 「加急」tag 保留，边框色仍只由链决定', async () => {
    const w = await mountPage([
      row({
        serial_no: 'F-911',
        id: '190000000000911',
        batch_id: '190000000000911',
        is_urgent: true,
        has_process_chain: true,
      }),
      row({
        serial_no: 'F-912',
        id: '190000000000912',
        batch_id: '190000000000912',
        is_urgent: true,
        has_process_chain: false,
      }),
    ]);

    const urgentChained = cardBySerial(w, 'F-911');
    expect(urgentChained.classes()).toContain('is-urgent');
    expect(urgentChained.text()).toContain('加急');
    expect(borderLeftOf(urgentChained)).toBe(normalizeColor(CHAIN_BORDER_COLOR));

    const urgentNoChain = cardBySerial(w, 'F-912');
    expect(urgentNoChain.text()).toContain('加急');
    expect(borderLeftOf(urgentNoChain)).toBe(normalizeColor(NO_CHAIN_BORDER_COLOR));
  });
});
