// @vitest-environment happy-dom
// src/views/production/scan/__tests__/ScanReturnChainFlow.spec.ts
//
// 放回流程「按 chain_state 分流」三条分支的回归守卫。
//
// 报工台放回页按 chain_state 三态分流：
//   NEXT（链内有下一道）→ 下一道工序由链直接给出，弹一次确认框，工人三选一：
//                          「按链放回」/「换一道工序」（落回手选）/「取消」；
//   TAIL（链内最后一道）→ 工序选择弹窗内常驻提示「加工完成后请送检」，工人手选工序；
//   NONE（无链 / 软删 / 指针漂移）→ 弹工序选择弹窗，选完直接提交。
//
// 这批用例守四件容易静默坏掉的事：
//   1. 分流判据写错（拿 chain_state 之外的东西判 / 三态写串）—— 症状是链已知时仍弹
//      工序选择，且**没有任何报错**；或 TAIL 被当成 NEXT 让工人「再放回一次」；
//   2. 兜底出口被删掉 —— 链字段解析不出时工人被卡死，没有任何路可走；
//   2b. NEXT 分支的「换一道工序」出口被删掉 —— 确认框是 NEXT 唯一能到达
//      ProcessPickerDialog 的路，少了它工人一旦不同意管理员配的链就被困死
//      （取消只清选中态，再点卡片还是同一个框）；
//   3. 提交参数不是派生出来的值（工序 id 串了）—— 工件会落到没配该工序的架上；
//   4. **提交载荷里绝不能再出现 shelf_id**：目标架已由后端按负载自动选
//      （见 CLAUDE.md「货架自动选择」），前端发这个键等于把口径退回去。
//
// 桩的取舍：
//   - `@/api/parts` 整模块桩掉：本页与 api 层是「直接 await + 手写 ref」范式
//     （报工台域不用 TanStack Query），不桩就真发请求。
//   - `element-plus` 桩成 `{ ElMessage: {...} }`：本页所有提示走 ElMessage。
//     NEXT 分支的确认框是本页自绘的 `el-dialog`（不走 ElMessageBox：它只有确认/取消
//     两键，装不下「换一道工序」这个出口），所以确认框的断言直接打在
//     `el-dialog` / `el-button` 两个桩渲染出来的 DOM 上。
//   - `@/composables/useBarcodeScanner` 桩掉并把注册的 handler 抓出来：扫码是本页与
//     点选并行的第二个入口（`applyScanSelection`），不桩就得模拟键盘时序。
//   - `ProcessPickerDialog` 桩成带标记 class 的空壳（它自己要去打 listProcesses），
//     空壳额外把 `hint` 透出成 data-*，用来验链尾送检提醒进了弹窗。
//   - `PdfViewer` 桩掉：它 import pdfjs-dist，与放回分流无关，却会把单测拖进 pdf worker。
//
// 2026-10-10 改写：原先本文件守的「拉候选货架取推荐架」那条链路随「目标货架改由
// 后端自动选」整体下线，相关用例删除；NEXT 分支的确认框从 ElMessageBox 换成自绘
// el-dialog（补回「换一道工序」出口），由本页的 `el-dialog` / `el-button` 桩驱动。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// vi.mock 的工厂会被提升到文件顶部，不能引用后声明的 const ⇒ 所有桩函数集中放进
// vi.hoisted 暴露的那一个对象里。
const h = vi.hoisted(() => ({
  listPartsHeldByWorker: vi.fn(),
  workerScan: vi.fn(),
  replace: vi.fn(),
  scanHandlers: [] as ((code: string) => void)[],
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/parts', () => ({
  listPartsHeldByWorker: h.listPartsHeldByWorker,
  workerScan: h.workerScan,
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
import { CHAIN_ROW_CLASS } from '@/views/production/scan/chainAccent';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
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

/** 一行 `chain_state='NEXT'` 的放回行：链给出了下一道工序 ⇒ 选它就会开链确认框。 */
function nextRow(over: Partial<ScanPartRowSchema> = {}): ScanPartRowSchema {
  return row({
    chain_state: 'NEXT',
    chain_next_process_id: '190000000000131',
    chain_next_process_name: 'CUT-01 下料',
    chain_current_process_name: 'SAW-02 锯切',
    ...over,
  });
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

/** worker-scan 的成功响应（`scan` 段字段逐字对齐后端 WorkerScanCoreOut）。 */
function scanOut(eventType: string) {
  return {
    scan: {
      worker_id: WORKER.id,
      part_id: '190000000000102',
      batch_id: '190000000000111',
      event_type: eventType,
      synced_assembly_id: null,
    },
    refill: { taken: [], released: 0 },
  };
}

/** 确认框（本页自绘 el-dialog）里的三个出口按钮，按文案取。 */
function chainConfirmButtons(w: VueWrapper): ReturnType<VueWrapper['findAll']> {
  return w.findAll('.mock-dialog .mock-confirm-bar button');
}

function chainConfirmButton(w: VueWrapper, label: string) {
  const btn = chainConfirmButtons(w).find((b) => b.text().replace(/\s+/g, '') === label);
  expect(btn, `确认框里没有「${label}」按钮`).toBeDefined();
  return btn!;
}

/** 确认框开着？NEXT 分支的开框判据全靠它。 */
function chainConfirmOpen(w: VueWrapper): boolean {
  return w.findAll('.mock-dialog').some((d) => d.attributes('data-open') === 'true');
}

/** 同上，挂起 workerScan（提交）—— 产出 `submitting === true` 那个窗口。 */
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
  // el-dialog 渲染 default + footer 两个 slot，**只在 modelValue 为真时渲染**（否则
  // 确认框的「开没开」无法断言 —— 桩恒渲染时开与不开长得一模一样）。
  // ⚠️ `showClose` 必须列进 props 并透出成 data-*：Element Plus 的 el-dialog 把它默认成
  // true（node_modules/element-plus/.../dialog-content.mjs 的 `showClose: true`），
  // 父组件不显式传 `:show-close="false"` 时右上角 × 会渲染 —— 而 × 只 emit
  // `update:modelValue(false)`、不发业务事件，对本框就是「关掉了却没法提交」的死角。
  // 桩若不接这个 prop，`String(undefined)` 恒为 'undefined'，断言就成了恒真。
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title', 'width', 'showClose'],
    template: `<div
      v-if="modelValue"
      class="mock-dialog"
      :data-title="title"
      :data-showclose="String(showClose)"
      data-open="true"
    >
      <div class="mock-confirm-bar"><slot /></div>
      <div class="mock-confirm-bar"><slot name="footer" /></div>
    </div>`,
  },
  'el-button': {
    name: 'ElButtonStub',
    props: { disabled: Boolean },
    emits: ['click'],
    // ⚠️ 声明 `emits: ['click']` 后父组件的 `@click` **不会**进 $attrs，模板里必须
    // 自己 `$emit`；否则这个桩是个不响的按钮，而 NEXT 分支的三个出口（按链放回 /
    // 换一道工序 / 取消）全靠它驱动。
    // 反过来少声明 emits 更糟：`@click` 既被 `$emit` 接住又作为 fallthrough 落到根
    // <button> 的原生监听器上，一次点击触发两次提交。
    // disabled 显式声明成 prop 并透出成 data-*：留在 attrs 里时 Vue 会把它当 DOM prop
    // 落到根 <button>（el.disabled = x），attributes('disabled') 拿到的是 null，断言不到
    // 状态。
    template:
      '<button :data-disabled="String(disabled)" @click="$emit(\'click\')"><slot /></button>',
  },
  'el-card': { name: 'ElCardStub', template: '<div class="mock-card"><slot /></div>' },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
  // el-alert 的正文走 `title` prop（不是 slot）⇒ 桩要把 title 渲染成文本，否则
  // 「确认框里写的是哪道工序」这条断言会落在一个永远不渲染的未知组件上。
  'el-alert': {
    name: 'ElAlertStub',
    props: ['title'],
    template: '<div class="mock-alert"><span class="mock-alert-title">{{ title }}</span></div>',
  },
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  'el-divider': { name: 'ElDividerStub', template: '<hr />' },
  'el-image': { name: 'ElImageStub', template: '<div />' },
  'el-badge': { name: 'ElBadgeStub', template: '<div><slot /></div>' },
  // 手选工序路径的弹窗换成带标记的空壳，标记 class 就是断言锚点；额外把 `hint` 透出
  // 成 data-*，用来验链尾送检提醒确实进了弹窗。
  ProcessPickerDialog: {
    name: 'ProcessPickerDialogStub',
    props: ['modelValue', 'hint'],
    template: '<div class="stub-process-picker" :data-hint="hint ?? \'\'" />',
  },
  HeldPartsBadge: { name: 'HeldPartsBadgeStub', template: '<div />' },
  ScrollFabPair: { name: 'ScrollFabPairStub', template: '<div />' },
  QuantityDialog: { name: 'QuantityDialogStub', template: '<div />' },
  BatchPickerDialog: { name: 'BatchPickerDialogStub', template: '<div />' },
  // lead-text 透出成 data-*：它就是补料弹窗打开时**唯一**的本次动作成功文案
  // （ElMessage.success 被刻意不发，见组件注释），不断言它等于这条路径零覆盖。
  RefillTakenDialog: {
    name: 'RefillTakenDialogStub',
    props: ['modelValue', 'items', 'leadText'],
    template: `<div class="stub-refill-taken" :data-lead="leadText ?? ''" />`,
  },
};

async function mountPage(items: ScanPartRowSchema[]): Promise<VueWrapper> {
  h.listPartsHeldByWorker.mockResolvedValue({ items, total: items.length, limit: 200, offset: 0 });
  const w = mount(ScanReturnParts, { global: { stubs } });
  await flushPromises();
  return w;
}

/** 点第一张零件卡（列表行单位是批次，`.part-row` 是 el-card 落下来的 class）。 */
async function clickFirstPart(w: VueWrapper): Promise<void> {
  await w.findAll('.part-row')[0]!.trigger('click');
  await flushPromises();
}

/** 按序列号点零件卡。列表渲染顺序走的是客户端排序（id 降序，见 useScanPartsSort），
 *  不等于 mock 返回的行序，所以按序号取卡而不是按下标。 */
async function clickPartBySerial(w: VueWrapper, serial: string): Promise<void> {
  const card = w.findAll('.part-row').find((c) => c.text().includes(serial));
  if (!card) {
    const seen = w.findAll('.part-row').map((c) => c.find('.serial-no').text());
    throw new Error(`列表里没有序列号 ${serial} 的行，实际：${seen.join(' / ')}`);
  }
  await card.trigger('click');
  await flushPromises();
}

/** 工序选择弹窗弹出的横幅文案（链尾送检提醒传进来的 hint）。 */
function processHint(w: VueWrapper): string {
  return w.find('.stub-process-picker').attributes('data-hint') ?? '';
}

/** 触发一次扫码（走 useBarcodeScanner 桩注册的 handler，即页面的 onScanToSelect）。 */
async function scan(w: VueWrapper, code: string): Promise<void> {
  const last = h.scanHandlers.at(-1);
  if (!last) throw new Error('页面没有注册扫码 handler');
  last(code);
  await flushPromises();
}

beforeEach(() => {
  h.listPartsHeldByWorker.mockReset();
  h.workerScan.mockReset().mockResolvedValue(scanOut('WORKER_SCAN_RETURNED'));
  h.replace.mockReset();
  h.ElMessage.success.mockReset();
  h.ElMessage.error.mockReset();
  h.ElMessage.warning.mockReset();
  h.ElMessage.info.mockReset();
  h.scanHandlers.length = 0;
  // 扫码 session 是模块级单例：每个用例都要有工人，否则 onBeforeMount 的
  // requireWorker 守卫直接把本站重定向走。
  useScanSession().setWorker(WORKER);
});

describe('ScanReturnParts / chain_state 三态分流', () => {
  // 扫码入口的同一道收口：applyScanSelection 也直接改 selectedPart、不经 cancelSelect。
  // 正常路径上 onScanToSelect 有一道 showChainConfirm 早退闸挡着，这里是第二道 —— 两处
  // 都调 closeChainConfirm，任何一处被后人删掉都该红。
  it('NEXT 框开着时扫码改选无链的另一件：旧确认框同样被收掉', async () => {
    const w = await mountPage([
      nextRow({ serial_no: 'F-A', id: '190000000000101', batch_id: '190000000000111' }),
      row({
        serial_no: 'F-B',
        id: '190000000000102',
        batch_id: '190000000000112',
        chain_state: 'NONE',
        chain_next_process_id: '0',
      }),
    ]);
    await clickPartBySerial(w, 'F-A');
    expect(chainConfirmOpen(w)).toBe(true);

    const vm = w.vm as unknown as { applyScanSelection: (p: ScanPartRowSchema) => Promise<void> };
    await vm.applyScanSelection(
      row({
        serial_no: 'F-B',
        id: '190000000000102',
        batch_id: '190000000000112',
        chain_state: 'NONE',
        chain_next_process_id: '0',
      }),
    );
    await flushPromises();

    expect(chainConfirmOpen(w)).toBe(false);
    expect(w.find('.stub-process-picker').exists()).toBe(true);
  });

  it('NEXT：不开工序选择弹窗，直接弹确认框，文案只讲下一道工序（不再有货架）', async () => {
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
    // 确认框开了，文案只摆下一道工序 + 「自动按负载放架」
    expect(chainConfirmOpen(w)).toBe(true);
    const box = w.findAll('.mock-dialog')[0]!.text();
    expect(box).toContain('CUT-01 下料');
    expect(box).toContain('按负载');
    // 确认栏也跟着显示派生的下一工序
    expect(w.find('.confirm-bar').text()).toContain('下一工序：CUT-01 下料');
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  // ⛔ NEXT 分支唯一能到达 ProcessPickerDialog 的路。少了「换一道工序」，工人不同意
  // 管理员配的链（临时插单 / 改道）时就被困死：取消只清选中态，再点卡片还是同一个框。
  // 这条用例就是钉住那个出口不被当成冗余清掉。
  // ⛔ MAJOR-1 守卫：右上角 × 必须不存在。
  //
  // 为什么这条要单独钉：本框是 NEXT 分支**唯一**的提交入口（`submitReturn` 的另外两个
  // 调用点分别要先进程序选择框、另一个是调试入口）。× 只 emit update:modelValue(false)、
  // 不发任何业务事件，一旦能点，关掉后页面就停在「卡片已选中 + 工序已填 + 无处可提交」
  // 的死角，工人只能按「取消选择」再重选一遍。禁掉它之后，关闭权就只剩 footer 三键，
  // 而那三条出口各自都会收尾（提交 / 落回手选 / 清选中态）。
  it('NEXT：右上角 × 被关掉 —— 关闭权只在 footer 三键上', async () => {
    const w = await mountPage([nextRow()]);
    await clickFirstPart(w);

    expect(chainConfirmOpen(w)).toBe(true);
    expect(
      w.find('.mock-dialog').attributes('data-showclose'),
      'showClose 没显式关成 false ⇒ 右上角 × 会渲染出来（Element Plus 默认 true）',
    ).toBe('false');
  });

  // MINOR-1 守卫：换一件时上一件的确认框必须被收掉。
  //
  // 关键在第二件选**无链**的行：无链分支走工序选择弹窗、**不会**自己重开确认框 ⇒
  // 上一件的框若没被收掉，就会和工序选择弹窗同时开着（两个遮罩叠着，后开的那个把工人
  // 锁在工序选择里，而旧的确认框还摆着上一件的工序名）。
  //
  // 变体对照：若第二件**也**是 NEXT，它自己会重开一个确认框，收没收掉旧框看不出差别 ——
  // 所以这条用例必须用 NONE 行才咬得住。
  // 今天靠模态遮罩挡着点击而不可达，但这是「状态分散、漏复位」那一类，靠遮罩兜不牢。
  it('NEXT 框开着时改选无链的另一件：旧确认框被收掉，不会与工序选择弹窗叠着', async () => {
    const w = await mountPage([
      nextRow({ serial_no: 'F-A', id: '190000000000101', batch_id: '190000000000111' }),
      row({
        serial_no: 'F-B',
        id: '190000000000102',
        batch_id: '190000000000112',
        chain_state: 'NONE',
        chain_next_process_id: '0',
      }),
    ]);
    await clickPartBySerial(w, 'F-A');
    expect(chainConfirmOpen(w)).toBe(true);

    // 直接调 onSelect 绕开遮罩（生产里点不到，但这条守的是状态收口本身）。
    // 必须传**完整的行**：enterReturnFlow 按 chain_state 分流，给半个对象会被当未知值降级。
    const vm = w.vm as unknown as { onSelect: (p: ScanPartRowSchema) => void };
    vm.onSelect(
      row({
        serial_no: 'F-B',
        id: '190000000000102',
        batch_id: '190000000000112',
        chain_state: 'NONE',
        chain_next_process_id: '0',
      }),
    );
    await flushPromises();

    expect(chainConfirmOpen(w), '上一件的确认框没被收掉，与工序选择弹窗叠着了').toBe(false);
    expect(w.find('.stub-process-picker').exists()).toBe(true);
  });

  it('NEXT + 「换一道工序」：落回手选工序弹窗，且选中件必须留着（否则选完直接 bail）', async () => {
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);
    expect(chainConfirmOpen(w)).toBe(true);

    await chainConfirmButton(w, '换一道工序').trigger('click');
    await flushPromises();

    // 确认框关掉、手选弹窗开
    expect(chainConfirmOpen(w)).toBe(false);
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    // 链派生的答案要清干净：确认栏回落成「未选」，且提交前不会误带链上的工序
    expect(w.find('.confirm-bar').text()).toContain('下一工序：未选');
    expect(h.workerScan).not.toHaveBeenCalled();

    // 接着手选一道并提交 ⇒ 发出去的是**工人选的那道**，不是链上那道
    const vm = w.vm as unknown as { onProcessPicked: (p: unknown) => void };
    vm.onProcessPicked({ id: '190000000000141', code: 'WELD', name: '焊接' });
    await flushPromises();

    expect(h.workerScan).toHaveBeenCalledWith({
      serial_no: 'F2256',
      badge_code: 'W-001',
      event_type: 'RETURNED',
      next_process_id: '190000000000141',
      batch_id: '190000000000111',
    });
  });

  // ⛔ 这条直接钉住「不再指定货架」这个需求：载荷里**没有** shelf_id 这个键。
  // （用 toEqual 断言整个对象，而不是 toHaveBeenCalledWith 之外再补一条否定断言 ——
  //   否定断言漏写键名就等于没钉，而本仓已有过「payload 少一个键没人发现」的先例。）
  it('NEXT + 确认放回：workerScan 只拿到 serial/badge/event/next_process/batch，载荷无 shelf_id', async () => {
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);
    await chainConfirmButton(w, '按链放回').trigger('click');
    await flushPromises();

    expect(h.workerScan).toHaveBeenCalledTimes(1);
    expect(h.workerScan).toHaveBeenCalledWith({
      serial_no: 'F2256',
      badge_code: 'W-001',
      event_type: 'RETURNED',
      next_process_id: '190000000000131',
      batch_id: '190000000000111',
    });
    expect(Object.keys(h.workerScan.mock.calls[0]![0] as object)).not.toContain('shelf_id');
    expect(Object.keys(h.workerScan.mock.calls[0]![0] as object)).not.toContain(
      'target_inspection_shelf_id',
    );
    expect(h.ElMessage.success).toHaveBeenCalledTimes(1);
    expect(w.find('.confirm-bar').exists()).toBe(false);
    expect(h.listPartsHeldByWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('NEXT + 确认框点「取消」：整次放回作废，不提交', async () => {
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);
    await chainConfirmButton(w, '取消').trigger('click');
    await flushPromises();

    expect(h.workerScan).not.toHaveBeenCalled();
    expect(w.find('.confirm-bar').exists()).toBe(false);
    expect(chainConfirmOpen(w)).toBe(false);
  });

  // 没有货架 picker 之后，NEXT 分支少了一类兜底（原「候选架为空 → 回退手选」）。
  // 现在唯一还在的兜底是「链字段解析不出」⇒ 落回手选。
  it("NEXT + chain_next_process_id 为兜底值 '0'：不发提交，warning 后回退手选工序", async () => {
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '0',
        chain_next_process_name: null,
        chain_current_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);

    expect(chainConfirmOpen(w)).toBe(false);
    expect(h.ElMessage.warning).toHaveBeenCalledWith('未找到下一道工序，请手动选择工序');
    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(h.workerScan).not.toHaveBeenCalled();
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
    // 提示必须是**弹窗内的常驻横幅**，不是 toast：后开的 el-dialog 遮罩必然盖住
    // ElMessage，工人在产线屏幕前看不到那句 3 秒后自动消失的提示。
    expect(processHint(w)).toBe('「CUT-01 下料」为最后一道工序，加工完成后请送检。');
    // TAIL 没有下一道 ⇒ 连确认框都不该弹
    expect(chainConfirmOpen(w)).toBe(false);
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

  // NONE 路径上「选完工序 → 直接提交」，取代原来的「选完工序 → 弹货架 picker → 提交」。
  // 这条钉住的是那条新链路本身（含载荷无 shelf_id）。
  it('NONE：弹工序选择弹窗；选完工序直接提交（不再经过任何货架步骤）', async () => {
    const w = await mountPage([row({ chain_state: 'NONE', chain_next_process_id: '0' })]);
    await clickFirstPart(w);

    expect(w.find('.stub-process-picker').exists()).toBe(true);
    expect(processHint(w)).toBe('');
    expect(chainConfirmOpen(w)).toBe(false);
    expect(h.workerScan).not.toHaveBeenCalled();
    expect(w.find('.confirm-bar').text()).toContain('下一工序：未选');

    // ProcessPickerDialog 桩不发 confirm，这里直接调页面的 onProcessPicked 入口。
    const vm = w.vm as unknown as { onProcessPicked: (p: unknown) => void };
    vm.onProcessPicked({ id: '190000000000141', code: 'WELD', name: '焊接' });
    await flushPromises();

    expect(h.workerScan).toHaveBeenCalledTimes(1);
    expect(h.workerScan).toHaveBeenCalledWith({
      serial_no: 'F2256',
      badge_code: 'W-001',
      event_type: 'RETURNED',
      next_process_id: '190000000000141',
      batch_id: '190000000000111',
    });
  });

  it('NONE：工序选择弹窗取消 → 清空选择、不提交', async () => {
    const w = await mountPage([row({ chain_state: 'NONE', chain_next_process_id: '0' })]);
    await clickFirstPart(w);

    const vm = w.vm as unknown as { onProcessCancel: () => void };
    vm.onProcessCancel();
    await flushPromises();

    expect(h.workerScan).not.toHaveBeenCalled();
    expect(w.find('.confirm-bar').exists()).toBe(false);
  });

  // 扫码入口的链分流本身（applyScanSelection → enterReturnFlow）：扫码命中 NEXT 件同样走
  // 单确认框。此前这条链零覆盖。
  it('扫码命中 NEXT 件：走单确认框，不弹工序选择弹窗', async () => {
    const w = await mountPage([
      row({
        serial_no: 'F-A',
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);

    await scan(w, 'F-A');

    expect(w.find('.stub-process-picker').exists()).toBe(false);
    expect(chainConfirmOpen(w)).toBe(true);
  });

  // 后端新增第四个 chain_state 取值（纯后端单方面改动）也只能降级、不能停工：
  // 未知字面量按 NONE 处理并整页只 warn 一次。
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
      expect(chainConfirmOpen(w)).toBe(false);
      // 未知取值不做 NEXT 处理 ⇒ 连确认框都不弹
      expect(consoleWarn).toHaveBeenCalledTimes(1);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  // 「后端漏发链四件套」时页面必须仍可用（走 NONE 旧路径），而不是在 API 边界抛
  // ZodError 让报工台三页全空。
  it('后端漏发链四件套：页面仍可用（走 NONE 旧路径），且整个页面实例只 console.warn 一次', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
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

      await clickPartBySerial(w, 'F-101');
      await clickPartBySerial(w, 'F-202');

      expect(w.find('.stub-process-picker').exists()).toBe(true);
      expect(processHint(w)).toBe('');
      expect(chainConfirmOpen(w)).toBe(false);
      // 列表一次最多 200 行，逐行 warn 会把真正的报错埋掉 ⇒ 两次窄化只报一次
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(consoleWarn.mock.calls[0]!.join(' ')).toContain('chain_state');
    } finally {
      consoleWarn.mockRestore();
    }
    expect(h.workerScan).not.toHaveBeenCalled();
  });

  // 提交在途时确认栏的「取消选择」置灰：放回请求已发出，此时清选中态会让工人看到
  // 「我明明取消了，怎么还放回去了」。
  it('提交在途：确认栏「取消选择」置灰且点了不生效，提交成功后照常清空', async () => {
    const settleScan = deferScan();
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);
    await chainConfirmButton(w, '按链放回').trigger('click');
    await flushPromises();

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
});

// ============================================================================
// 2026-10-10 新增：成功文案按**响应**的 `scan.event_type` 分支。
//
// 客户端发的是 `event_type: 'RETURNED'`，但当该批次的当前工序恰是工序链最后一道时，
// 后端自动把这次放回改投品检、响应回来的是 `WORKER_SCAN_INSPECTED`。照请求的
// event_type 说「已放回 → 下一道工序」会让工人以为工件还在待加工区。
// ============================================================================
describe('ScanReturnParts / 成功文案按响应 event_type 分支', () => {
  it('E1：响应 WORKER_SCAN_RETURNED → 「已放回：serial → 下一道工序」', async () => {
    h.workerScan.mockResolvedValue(scanOut('WORKER_SCAN_RETURNED'));
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);
    await chainConfirmButton(w, '按链放回').trigger('click');
    await flushPromises();

    expect(h.ElMessage.success).toHaveBeenCalledWith('已放回：F2256 → CUT-01 下料');
  });

  it('E2：响应 WORKER_SCAN_INSPECTED（链尾自动送检）→ 「已完工，已送检」', async () => {
    h.workerScan.mockResolvedValue(scanOut('WORKER_SCAN_INSPECTED'));
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);
    await chainConfirmButton(w, '按链放回').trigger('click');
    await flushPromises();

    expect(h.ElMessage.success).toHaveBeenCalledWith('已完工，已送检：F2256');
    expect(h.ElMessage.success).not.toHaveBeenCalledWith(expect.stringContaining('已放回'));
  });

  // ⚠️ 「链尾自动送检」这条链路上 `refill.taken` 仍可能非空（送检同事务也跑 refill），
  // 那时文案进补料弹窗的 lead-text 而不是 ElMessage.success。两种投递方式都要覆盖 ——
  // 只测 ref 不测补料弹窗，会让「补料时文案错」这条路径零覆盖。
  it('E3：自动送检 + 同事务补到料 → 文案进补料弹窗的 lead-text（同样是送检口径）', async () => {
    h.workerScan.mockResolvedValue({
      ...scanOut('WORKER_SCAN_INSPECTED'),
      refill: {
        taken: [
          {
            batch_id: '190000000000901',
            serial_no: 'F9999',
            name: '法兰盘',
            quantity: 3,
            system_delivery_date: null,
          },
        ],
        released: 0,
      },
    });
    const w = await mountPage([
      row({
        chain_state: 'NEXT',
        chain_next_process_id: '190000000000131',
        chain_next_process_name: 'CUT-01 下料',
      }),
    ]);
    await clickFirstPart(w);
    await chainConfirmButton(w, '按链放回').trigger('click');
    await flushPromises();

    expect(w.find('.stub-refill-taken').exists()).toBe(true);
    expect(w.find('.stub-refill-taken').attributes('data-lead')).toBe('已完工，已送检：F2256');
    expect(h.ElMessage.success).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 2026-10-09 新增：列表卡**左边框**的链语义着色（与上面的 `chain_state` 分流同源，
// 但回答的是另一个问题 —— 这条批次有没有制定工序链）。
//
// 放在本文件而不是新开一个 spec：挂载脚手架在这里。
//
// 断言的是**类名**，不是渲染出来的色值 —— vitest 不处理 SFC 的 `<style>`（happy-dom 里
// `document.styleSheets` 恒为空），样式层的颜色无从断言，类名就是那条规则的唯一载体。
//
// 顺带守两条易踩的坑：
//   1. 三页此前各有一套硬编码左边框色（取件蓝 / 放回琥珀 / 送检绿）用来区分**流程**，
//      而 `.part-row.is-urgent` 里还显式写了 `border-left-color: #f56c6c` —— 那条规则
//      一旦留着，加急行的绿边框会被加急红压掉。两条都从 CSS 里删掉了；
//   2. 左边框色**不得回到模板 inline `:style`**：inline 优先于任何非 `!important` 规则，
//      `.is-selected` / `.is-urgent` 的 `border-color` 简写盖不住它，选中行会呈现
//      「三边状态色 + 一条中性灰左边框」。类绑定与状态类同为 0,2,0，靠源码顺序取胜。
// ============================================================================
describe('ScanReturnParts — 列表卡左边框按 has_process_chain 着色', () => {
  /** 取出 `selector { … }` 这条规则的花括号内原文（取不到返回空串，由用例报错）。 */
  function cssRuleBody(src: string, selector: string): string {
    const at = src.indexOf(`${selector} {`);
    if (at < 0) return '';
    const bodyStart = at + selector.length + 2;
    const end = src.indexOf('}', bodyStart);
    return src.slice(bodyStart, end < 0 ? src.length : end);
  }

  function cardBySerial(w: VueWrapper, serial: string) {
    const card = w.findAll('.part-row').find((c) => c.text().includes(serial));
    if (!card) throw new Error(`列表里没有序列号 ${serial} 的行`);
    return card;
  }

  /** 行根上的 inline 左边框色：必须恒为空串（见文件头第 2 条坑）。 */
  function inlineBorderLeftOf(card: { element: Element }): string {
    return (card.element as HTMLElement).style.borderLeftColor;
  }

  it('有链挂 has-chain、无链不挂（两边框色的判据唯一来自链）', async () => {
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

    expect(cardBySerial(w, 'F-901').classes()).toContain(CHAIN_ROW_CLASS);
    expect(cardBySerial(w, 'F-902').classes()).not.toContain(CHAIN_ROW_CLASS);
    for (const serial of ['F-901', 'F-902']) {
      expect(inlineBorderLeftOf(cardBySerial(w, serial)), `${serial} 不得有 inline 左边框色`).toBe(
        '',
      );
    }
  });

  // 加急语义改由红底 + 「加急」tag 承担；边框让位给链。
  it('加急不再染边框：红底 + 「加急」tag 保留，边框判据仍只由链决定', async () => {
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
    expect(urgentChained.classes()).toContain(CHAIN_ROW_CLASS);
    expect(inlineBorderLeftOf(urgentChained)).toBe('');

    const urgentNoChain = cardBySerial(w, 'F-912');
    expect(urgentNoChain.text()).toContain('加急');
    expect(urgentNoChain.classes()).not.toContain(CHAIN_ROW_CLASS);
    expect(inlineBorderLeftOf(urgentNoChain)).toBe('');
  });

  // 选中态此前零覆盖，正是「inline 压掉 `.is-selected`」那条回归能溜过测试的原因。
  it('选中态：选中类与链类共存，且不产生 inline 左边框色', async () => {
    const w = await mountPage([
      row({
        serial_no: 'F-921',
        id: '190000000000921',
        batch_id: '190000000000921',
        has_process_chain: true,
      }),
      row({
        serial_no: 'F-922',
        id: '190000000000922',
        batch_id: '190000000000922',
        has_process_chain: false,
      }),
    ]);

    await clickPartBySerial(w, 'F-921');

    const selectedChained = cardBySerial(w, 'F-921');
    expect(selectedChained.classes()).toContain('is-selected');
    expect(selectedChained.classes()).toContain(CHAIN_ROW_CLASS);
    expect(inlineBorderLeftOf(selectedChained), '选中态不得被 inline 左边框色压掉').toBe('');

    const unselectedNoChain = cardBySerial(w, 'F-922');
    expect(unselectedNoChain.classes()).not.toContain('is-selected');
    expect(unselectedNoChain.classes()).not.toContain(CHAIN_ROW_CLASS);
    expect(inlineBorderLeftOf(unselectedNoChain)).toBe('');
  });

  // 级联契约（读源码）：类名对了还不够 —— `.has-chain` 与 `.is-selected` / `.is-urgent`
  // 同为 0,2,0，谁生效全靠源码顺序。
  it('源码契约：三页的 .has-chain 规则排在全部状态类之后，且模板不再 inline 左边框色', () => {
    for (const file of ['ScanReturnParts.vue', 'ScanPickParts.vue', 'ScanInspectParts.vue']) {
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '..', file),
        'utf8',
      );
      expect(src, `${file} 不得用 inline :style 承载左边框语义色`).not.toContain('borderLeftColor');
      const chainAt = src.indexOf('.part-row.has-chain {');
      expect(chainAt, `${file} 缺少 .part-row.has-chain 规则`).toBeGreaterThan(-1);
      for (const selector of [
        '.part-row.is-selected {',
        '.part-row.is-urgent {',
        '.part-row.is-urgent.is-selected {',
      ]) {
        expect(src.indexOf(selector), `${file} 缺少 ${selector}`).toBeGreaterThan(-1);
        expect(chainAt, `${file} 的 .has-chain 必须排在 ${selector} 之后`).toBeGreaterThan(
          src.indexOf(selector),
        );
      }
      expect(
        cssRuleBody(src, '.part-row.has-chain'),
        `${file} 的 .has-chain 规则必须只染左边框`,
      ).toContain('border-left-color');
    }
  });
});
