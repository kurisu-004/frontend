// @vitest-environment happy-dom
// src/views/production/scan/__tests__/LocateDialog.spec.ts
//
// 扫码找件诊断弹窗（`GET /prod/scan/locate` + `take-over` / `outsource-receive`）的
// 回归守卫。
//
// ⭐ **本文件的 L1 是这次 bug 的守卫本体**：工人一体机账号（后端角色 `SHELF_ACCOUNT`）
// 在报工台扫到别的工人手上的件时，旧兜底走 `src/utils/scanHelpers.ts::
// findPartBySerialAndPrompt` → `GET /parts/by-serial/{sn}`，而那条端点的后端闸门是
// `[Manager, Clerk, Inspector, CncProgrammer]`、**不含 `SHELF_ACCOUNT`** ⇒ 恒 403。
// 现在兜底改接报工台自有的 `locate`（放行 `SHELF_ACCOUNT`）。三条页面的接线守卫在
// 同目录 `ScanZeroMatchLocate.spec.ts`，本文件守组件自身的取数与写动作。
//
// 这批用例守六件「写错了也**不会报错**、只会让工人读一句无关文案或做一次注定失败的
// 操作」的事：
//   1. **走的是 locate 而不是 by-serial**（L1）；
//   2. **工序参数的形态随 `chain_state` 变**（L2 / L3）：接管在 `NEXT` 时**不发**
//      `next_process_id`（后端自推）；外协收回在 `NEXT` 时**必须原样回传** diagnose 行
//      的那个 id —— 写侧缺省推导是 `sort_order = 当前 + 1`，与读侧
//      `sort_order > 当前 LIMIT 1` 在稀疏链上不等价，省略就吃 `20706` / `40001`；
//   3. **`action === null` 与未知字面量的行都不给按钮**（L4 / L10）：给了就是
//      「点了必失败」或「点了没动静」；
//   4. **守门 schema 真在 queryFn 上**（L5）：把 `locateResultSchema.parse` 整段删掉时，
//      少键 / 雪花 id 发成 number 的响应会一路流到视图层，页面变成一张空表 ——
//      所以这里断言的是「固定文案出现」，不是「页面没崩」；
//   5. **失败必须给得出下一步**（L11 / L11b）：写侧要求的工序条件比读侧多一道判据，
//      读侧给不出的那部分只能靠「吃 40001 ⇒ 降级弹手填框」兜底，否则弹窗是个死循环；
//   6. **动作成功后页面列表自己会刷新**（L13）：弹窗不发「请刷新页面」信号，三页的列表
//      靠写路径的前缀失效自动重取 —— 这条钉住「三页不接刷新回调也能刷新」。
//
// 桩法：`@/api/productionScan` 整模块桩掉（弹窗的取数与三条写路径都走它）；
// `element-plus` 桩成 `{ ElMessage }`；`@/api/parts` 桩掉以便把「零调用」钉成断言
// （旧兜底经 `@/utils/scanHelpers` 打到那里的 `getPartBySerial`）。
// 真实 `el-table` 是「列 × 行」的二维渲染，桩退化成「表格桩逐行渲染、每格调该列的
// 默认插槽」—— 本文件要断言的全是**行内**的东西（按钮 / 指引文案），逐行渲染才够用。
// `QuantityDialog` / `ProcessPickerDialog` 各自桩成一个只暴露「确认」键的空壳：
// 本文件只关心「有没有走到提交、提交体的工序参数是什么」，不关心那两个弹窗怎么选值。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type VNode, type VNodeArrayChildren } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

const m = vi.hoisted(() => ({
  fetchScanHeld: vi.fn(),
  fetchScanLocate: vi.fn(),
  pickUpBatch: vi.fn(),
  takeOverBatch: vi.fn(),
  receiveFromOutsource: vi.fn(),
  getPartBySerial: vi.fn(),
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/productionScan', () => ({
  fetchScanHeld: m.fetchScanHeld,
  fetchScanLocate: m.fetchScanLocate,
  pickUpBatch: m.pickUpBatch,
  takeOverBatch: m.takeOverBatch,
  receiveFromOutsource: m.receiveFromOutsource,
}));
// 旧兜底路径（`findPartBySerialAndPrompt`）经 `@/utils/scanHelpers` 打到这里的
// `getPartBySerial`。桩掉是为了把「零调用」变成可断言的事实，而不是一句注释。
vi.mock('@/api/parts', () => ({ getPartBySerial: m.getPartBySerial }));
vi.mock('element-plus', () => ({ ElMessage: m.ElMessage }));

import LocateDialog from '@/views/production/scan/components/LocateDialog.vue';
import { ApiError } from '@/api/http';
import { SCAN_LOCATE_CONTRACT_DRIFT_TEXT } from '@/views/production/scan/composables/scanListErrorMessage';
import { useScanHeldQuery } from '@/views/production/scan/composables/useScanListQuery';

const WORKER = {
  id: '190000000000009',
  badge_code: 'W-001',
  name: '张三',
  work_type_id: '190000000000010',
};

const CODE = 'F2256';
const BATCH_ID = '190000000000111';
/** 诊断行回传的下一道工序 id（外协收回在 chain NEXT 时必须原样带回去）。 */
const NEXT_PROCESS_ID = '190000000000777';

/** 一行合法诊断行（后端 `LocateBatchItem` 16 字段，键集即网络契约）。 */
function batch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch_id: BATCH_ID,
    batch_no: 1,
    quantity: 3,
    status: 'IN_PROCESS',
    version: 6,
    location: 'WORKER',
    holder_display: '李四',
    current_process_name: '车削',
    chain_state: 'NEXT',
    next_process_id: NEXT_PROCESS_ID,
    next_process_name: '铣削',
    updated_at: '2026-10-15 09:00:00',
    company_name: null,
    sent_at: null,
    action: 'TAKE_OVER',
    disabled_reason: null,
    ...over,
  };
}

/** 一份合法的诊断结果信封。
 *
 *  `worker_processes` 是后端按工种算好的候选（2026-10-16 起顶层必发）。默认给**一条**：
 *  多数用例走 `chain_state === 'NEXT'` 的免填路径、根本不弹手填框，候选内容不影响断言；
 *  手工填候选的用例显式覆盖本键。 */
function locateResult(
  rows: unknown[],
  workerProcesses: unknown[] = [
    { process_id: '190000000000881', code: 'TURN', name: '车削', category: 'INHOUSE' },
  ],
): Record<string, unknown> {
  return {
    part: {
      id: '190000000000101',
      serial_no: CODE,
      name: '法兰盘',
      drawing_no: 'DWG-1',
      is_urgent: false,
      planned_delivery_date: '2026-10-20',
      system_delivery_date: null,
    },
    batches: rows,
    worker_processes: workerProcesses,
  };
}

/** 一份合法的持有件列表信封（一行 `ScanListItem` 的 17 字段，键集即网络契约）。 */
function heldEnvelope() {
  return {
    items: [
      {
        id: '190000000000101',
        serial_no: CODE,
        name: '法兰盘',
        drawing_no: 'DWG-1',
        quantity: 1,
        is_urgent: false,
        planned_delivery_date: '2026-10-20',
        system_delivery_date: null,
        process_chain_id: null,
        has_process_chain: false,
        chain_state: 'NONE',
        chain_next_process_id: '0',
        chain_next_process_name: null,
        chain_current_process_name: null,
        batch_id: BATCH_ID,
        batch_version: 6,
        location: null,
      },
    ],
    total: 1,
    limit: 200,
    offset: 0,
  };
}

// --- 桩 ---

/** 表格桩：逐行渲染，每行一格，格内容 = 该列默认插槽的返回值（传 `{ row }`）。
 *  真实 el-table 由表格自己驱动「列 × 行」，桩反过来让**行**驱动**列**——
 *  本文件的断言全部落在行内（按钮 / 指引文案 / 提交体），不需要二维顺序。 */
const ElTableStub = defineComponent({
  name: 'ElTableStub',
  props: ['data', 'rowKey', 'border'],
  setup(props, { slots }) {
    return () => {
      const rows = (props.data as unknown[] | undefined) ?? [];
      const columns = (slots.default?.() ?? []) as VNode[];
      return h(
        'div',
        { class: 'mock-table' },
        rows.map((row, index) =>
          h(
            'div',
            { class: 'mock-row', 'data-row': index, key: index },
            columns.map((col, ci) => {
              // 列 vnode 的 children 就是它那一组具名 / 默认插槽（模板里的
              // `#default="{ row }"` 编译成 `children.default`），调用它拿到单元格内容。
              const slot = (
                col.children as { default?: (a: { row: unknown }) => VNodeArrayChildren } | null
              )?.default;
              return h('div', { class: 'mock-cell', 'data-col': ci }, slot ? slot({ row }) : []);
            }),
          ),
        ),
      );
    };
  },
});
const ElTableColumnStub = defineComponent({
  name: 'ElTableColumnStub',
  props: ['label', 'prop', 'width', 'minWidth', 'fixed'],
  setup() {
    return () => h('div');
  },
});

const stubs = {
  'el-table': ElTableStub,
  'el-table-column': ElTableColumnStub,
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    // 只在 modelValue 为真时渲染，否则「弹窗开没开」断言不了。
    template: '<div v-if="modelValue" class="mock-dialog"><slot /><slot name="footer" /></div>',
  },
  'el-button': {
    name: 'ElButtonStub',
    props: { disabled: Boolean, loading: Boolean },
    emits: ['click'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  QuantityDialog: defineComponent({
    name: 'QuantityDialog',
    props: ['modelValue', 'max', 'serialNo', 'partName', 'actionLabel'],
    emits: ['confirm', 'cancel', 'update:modelValue'],
    template: `<div v-if="modelValue" class="mock-qty-dialog">
      <button class="qty-ok" @click="$emit('confirm', 2)">确定领取</button>
    </div>`,
  }),
  ProcessPickerDialog: defineComponent({
    name: 'ProcessPickerDialog',
    props: [
      'modelValue',
      'kind',
      'showClose',
      'currentProcessId',
      'hint',
      'excludeProcessIds',
      'allowedProcessIds',
    ],
    emits: ['confirm', 'cancel', 'update:modelValue'],
    // `data-kind` / `data-showclose` / `data-allowed` 用来验「弹窗按 kind 出文案」+
    // 「关闭权收在 footer」+「候选收窄到工种工序」。
    template: `<div
      v-if="modelValue"
      class="mock-picker-dialog"
      :data-kind="kind"
      :data-showclose="String(showClose)"
      :data-allowed="JSON.stringify(allowedProcessIds ?? null)"
    >
      <button class="picker-ok" @click="$emit('confirm', { id: '190000000000888', code: 'P8', name: '钻孔', category: 'INHOUSE' })">选它</button>
    </div>`,
  }),
};

/** 两条工种工序候选：弹手填框需要「多条」才成立（候选恰好一条时组件直接提交、
 *  不弹框 —— 见 describe 里 2026-10-16 那组用例）。 */
function twoProcesses(): unknown[] {
  return [
    { process_id: '190000000000881', code: 'TURN', name: '车削', category: 'INHOUSE' },
    { process_id: '190000000000882', code: 'MILL', name: '铣削', category: 'INHOUSE' },
  ];
}

async function mountDialog(): Promise<VueWrapper> {
  const w = mount(LocateDialog, {
    props: { modelValue: true, code: CODE, worker: WORKER },
    global: {
      stubs,
      plugins: [
        createPinia(),
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({
              defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
            }),
          },
        ],
      ],
    },
  });
  await flushPromises();
  return w;
}

/** 行内文本（把所有 mock-row 的文本拼起来，便于断言「指引文案出现过」）。 */
function rowsText(w: VueWrapper): string {
  return w
    .findAll('.mock-row')
    .map((r) => r.text().replace(/\s+/g, ' '))
    .join(' | ');
}

/** 第 index 行的动作按钮（按可见文案找，`<button>` 桩渲染 el-button 的默认插槽）。 */
function rowButton(w: VueWrapper, index: number, label: string) {
  return w
    .findAll('.mock-row')
    .at(index)!
    .findAll('button')
    .find((b) => b.text().replace(/\s+/g, '') === label);
}

beforeEach(() => {
  m.fetchScanHeld.mockReset().mockResolvedValue(heldEnvelope());
  m.fetchScanLocate.mockReset().mockResolvedValue(locateResult([batch()]));
  m.pickUpBatch.mockReset().mockResolvedValue({ batch_id: BATCH_ID });
  m.takeOverBatch.mockReset().mockResolvedValue({ batch_id: BATCH_ID, version: 7 });
  m.receiveFromOutsource.mockReset().mockResolvedValue({ batch_id: BATCH_ID, version: 8 });
  m.getPartBySerial.mockReset();
  m.ElMessage.success.mockReset();
  m.ElMessage.error.mockReset();
});

describe('LocateDialog / 取数走 locate 而不是 parts/by-serial', () => {
  // ⭐ 本 bug 的回归守卫本体。
  it('L1：打开弹窗调 fetchScanLocate（带 serial_no + worker_id），getPartBySerial 零调用', async () => {
    const w = await mountDialog();

    expect(m.fetchScanLocate).toHaveBeenCalledTimes(1);
    expect(m.fetchScanLocate).toHaveBeenCalledWith({
      serialNo: CODE,
      // worker_id 必须发：不发则后端不算 action，诊断行一颗按钮都渲染不出来。
      workerId: WORKER.id,
    });
    expect(
      m.getPartBySerial,
      '旧兜底 GET /parts/by-serial/{sn} 不放行 SHELF_ACCOUNT，工人一体机账号恒 403',
    ).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe('LocateDialog / 写动作的提交体', () => {
  // 接管在 `chain_state === 'NEXT'` 时**不发** next_process_id（后端按链自推）。
  // 发了反倒可能被写侧按「显式覆盖」处理，语义与「让它自推」不是一回事。
  it('L2：TAKE_OVER + chain NEXT → 发 take-over，带 batch_id/version/badge_code 且不发 next_process_id', async () => {
    m.fetchScanLocate.mockResolvedValue(locateResult([batch()]));
    const w = await mountDialog();

    const btn = rowButton(w, 0, '接管');
    expect(btn, 'TAKE_OVER 行必须给出「接管」按钮').toBeDefined();
    await btn!.trigger('click');
    await flushPromises();

    expect(m.takeOverBatch).toHaveBeenCalledTimes(1);
    const [batchId, body] = m.takeOverBatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(batchId).toBe(BATCH_ID);
    expect(body.batch_id).toBe(BATCH_ID);
    expect(body.version).toBe(6);
    expect(body.badge_code).toBe('W-001');
    expect('next_process_id' in body, '链能自推时不带走工序').toBe(false);
    expect(m.receiveFromOutsource).not.toHaveBeenCalled();
    w.unmount();
  });

  // ⭐ 外协收回在 `chain_state === 'NEXT'` 时**必须原样回传**诊断行的 next_process_id。
  // 写侧缺省推导口径是 `sort_order = 当前 + 1`，与读侧 `sort_order > 当前 LIMIT 1` 在
  // 稀疏链上不等价 ⇒ 省略会在稀疏链 / part 无链但指针存活时吃 `20706` / `40001`。
  it('L3：RECEIVE_FROM_OUTSOURCE + chain NEXT → 原样回传诊断行的 next_process_id', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult([batch({ action: 'RECEIVE_FROM_OUTSOURCE', location: 'OUTSOURCE_COMPANY' })]),
    );
    const w = await mountDialog();

    const btn = rowButton(w, 0, '确认收回');
    expect(btn).toBeDefined();
    await btn!.trigger('click');
    await flushPromises();

    expect(m.receiveFromOutsource).toHaveBeenCalledTimes(1);
    const [batchId, body] = m.receiveFromOutsource.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(batchId).toBe(BATCH_ID);
    expect(body.batch_id).toBe(BATCH_ID);
    expect(body.version).toBe(6);
    expect(body.badge_code).toBe('W-001');
    expect(
      body.next_process_id,
      'NEXT 形态也必须显式回传：写侧缺省推导与读侧在稀疏链上不等价',
    ).toBe(NEXT_PROCESS_ID);
    expect(m.takeOverBatch).not.toHaveBeenCalled();
    w.unmount();
  });

  // `chain_state !== 'NEXT'`（无链 / 链尾 / 指针漂移）⇒ 两个写端点都要求显式工序：
  // 接管缺失 → 40001、外协无链缺失 → 40001。所以这里必须先弹手填弹窗，且它按 kind 分流。
  // 工种给了两条候选（一条时组件直接提交、不弹框 —— 那条路径由 2026-10-16 那组用例守）。
  it('L4：链推不出下一道 → 先弹手填工序弹窗（kind 分流），且关闭权不在 × 上', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult(
        [batch({ action: 'TAKE_OVER', chain_state: 'NONE', next_process_id: null })],
        twoProcesses(),
      ),
    );
    const w = await mountDialog();

    // 行上必须提前给出「点下去会弹手填框」的可见事实
    expect(rowsText(w)).toContain('无工序链');

    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();

    // 此刻**还没有**发写请求 —— 手填是提交的前置闸门
    expect(m.takeOverBatch).not.toHaveBeenCalled();

    const picker = w.find('.mock-picker-dialog');
    expect(picker.exists(), '必须弹手填工序弹窗').toBe(true);
    expect(picker.attributes('data-kind')).toBe('takeover');
    expect(
      picker.attributes('data-showclose'),
      '手填框是那条路径的唯一提交出口，× 必须收起来（否则关掉了却没法提交）',
    ).toBe('false');

    await w.find('.mock-picker-dialog .picker-ok').trigger('click');
    await flushPromises();

    expect(m.takeOverBatch).toHaveBeenCalledTimes(1);
    const [, body] = m.takeOverBatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.next_process_id).toBe('190000000000888');
    w.unmount();
  });
});

describe('LocateDialog / 取件动作（部分数量）', () => {
  // `actionLabel` 若写成「不是 A 就是 B」的二选一，PICK_UP 会长出「确认收回」那种与
  // 动作无关的按钮 —— 工人看着不知道自己在干什么。这条把三个可写动作的文案都钉住。
  it('L5：PICK_UP 行的按钮文案是「领取」（不是接管 / 确认收回）', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult([
        batch({ action: 'PICK_UP', location: 'PRODUCTION_SHELF', holder_display: 'A架' }),
      ]),
    );
    const w = await mountDialog();

    const buttons = w.findAll('.mock-row').at(0)!.findAll('button');
    const labels = buttons.map((b) => b.text().replace(/\s+/g, ''));
    expect(labels).toEqual(['领取']);
    // HMI 一体机：同域提交级交互件一律 `size="large"`，行内这个按钮是本弹窗唯一的提交入口。
    expect(buttons[0]!.attributes('size'), '触屏规格：动作按钮不得用 small').toBe('large');
    w.unmount();
  });

  // 取件支持部分数量：先弹数量弹窗，确认后才提交，且 `quantity` 必须发**字符串**
  // （后端 `deserialize_i64_opt` 只解 `str`，发 number 拿到的是 422 纯文本）。
  it('L6：PICK_UP 先弹数量弹窗，确认后发 pick-up 且 quantity 是字符串', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult([batch({ action: 'PICK_UP', location: 'PRODUCTION_SHELF' })]),
    );
    const w = await mountDialog();

    await rowButton(w, 0, '领取')!.trigger('click');
    await flushPromises();
    expect(m.pickUpBatch, '选数量之前不发写请求').not.toHaveBeenCalled();

    await w.find('.mock-qty-dialog .qty-ok').trigger('click');
    await flushPromises();

    expect(m.pickUpBatch).toHaveBeenCalledTimes(1);
    const [batchId, body] = m.pickUpBatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(batchId).toBe(BATCH_ID);
    expect(body.version).toBe(6);
    expect(body.worker_id).toBe(WORKER.id);
    expect(body.quantity).toBe('2');
    expect(typeof body.quantity).toBe('string');
    expect(m.takeOverBatch).not.toHaveBeenCalled();
    w.unmount();
  });
});
// `action === null` 的行**不给按钮**：locate 是诊断不是预演，但决策表守的纪律是
// 「写侧会拒的绝不显示可点按钮」，给了按钮就是让工人点一次注定失败的按钮。
describe('LocateDialog / 不可行动作与守门', () => {
  it('L7：action=null + disabled_reason → 渲染指引文案、该行无可点按钮', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult([
        batch({ action: null, disabled_reason: 'PROGRAMMING' }),
        batch({
          action: null,
          disabled_reason: 'WORKER_HOLD_LIMIT_EXCEEDED',
          batch_id: '190000000000222',
        }),
      ]),
    );
    const w = await mountDialog();

    const text = rowsText(w);
    expect(text).toContain('待编程');
    expect(text).toContain('持有上限');

    // 两行都只有指引文本，一个动作按钮都没有
    expect(
      w.findAll('.mock-row').every((r) => r.findAll('button').length === 0),
      '不可行的行不得给按钮',
    ).toBe(true);
    expect(w.find('.mock-table').text()).not.toContain('接管');
    expect(m.takeOverBatch).not.toHaveBeenCalled();
    expect(m.receiveFromOutsource).not.toHaveBeenCalled();
    w.unmount();
  });

  // 守门在 queryFn 上（约定「api 层不 parse」）。少了它，少键 / 雪花 id 发成 number 的
  // 响应会一路流到视图层，页面变成一张空表且**没有任何报错** —— 所以断言的是固定文案。
  // ⚠️ 漂移文案是「诊断」口吻而非列表口吻：断言的是**具体那一句**，顺带把「别退回列表
  // 文案」钉住（工人扫的条码根本没进任何列表，弹窗说「列表数据格式异常」会指错界面）。
  it('L8：坏响应被守门 schema 拦下（少键 / 雪花 id 发成 number）→ 走诊断漂移文案', async () => {
    // (a) 少一个键（holder_display）
    m.fetchScanLocate.mockResolvedValue(locateResult([batch({ holder_display: undefined })]));
    let w = await mountDialog();
    expect(w.text()).toContain(SCAN_LOCATE_CONTRACT_DRIFT_TEXT);
    expect(w.find('.mock-table').exists(), '守门失败时不得渲染表格').toBe(false);
    w.unmount();

    // (b) 雪花 id 发成 number（19 位在 JS Number 下会丢精度，后端发的是 string）
    m.fetchScanLocate.mockResolvedValue(locateResult([batch({ batch_id: Number(BATCH_ID) })]));
    w = await mountDialog();
    expect(w.text()).toContain(SCAN_LOCATE_CONTRACT_DRIFT_TEXT);
    expect(w.find('.mock-table').exists()).toBe(false);
    w.unmount();
  });

  // `20101`（工单未命中）不是失败：它是本弹窗最高频的输入形态（弹窗只在扫到 0 匹配时
  // 打开），渲染成一句红字「查询失败」等于告诉工人他操作错了，而他并没有。
  it('L9：20101（未命中）落空态而不是失败态，且提示装配件要扫子件', async () => {
    m.fetchScanLocate.mockRejectedValue(new ApiError(20101, '零件不存在'));
    const w = await mountDialog();

    expect(w.text()).toContain('没有找到条码');
    expect(w.text()).toContain('装配件');
    expect(w.text()).not.toContain(SCAN_LOCATE_CONTRACT_DRIFT_TEXT);
    // ⭐ 同一件事只说一遍：query hook 的错误桥接必须对 `20101` 早退，否则弹窗渲染灰态的
    // 同时屏幕上方还弹一条红色 ElMessage.error（把「扫了个不存在的条码」说成一次失败）。
    expect(m.ElMessage.error, '20101 归空态承担，不得再弹红色错误 toast').not.toHaveBeenCalled();
    w.unmount();
  });

  // 非 20101 的失败仍要弹 toast（否则 query hook 的错误桥接就成了死代码，契约漂移 /
  // 网络失败会静默 —— 弹窗里虽然有 errorText，但工人看不到弹窗外的那条提示）。
  it('L9b：非 20101 的失败仍然弹一次错误 toast', async () => {
    m.fetchScanLocate.mockRejectedValue(new ApiError(20201, '工人不存在'));
    const w = await mountDialog();

    expect(m.ElMessage.error).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  // ⭐ 漂移文案的口吻必须跟着**出口**走，而不是「谁忘了传就回落成列表」。
  // 同一次查询失败有两个渲染出口，各调一次 `scanListErrorText`：弹窗体内的红字区
  // （`errorText`）与屏幕上方这条 toast。弹窗体内那条已传「诊断」口吻，toast 这条若漏传
  // 第三/四参就回落成「列表数据格式异常」—— 而工人扫的是条码、压根没打开过任何列表，
  // 那句话会把他指去看一个不存在的界面。
  it('L9b2：契约漂移的 toast 走「诊断」口吻（不得说「列表」）', async () => {
    // queryFn 里 `locateResultSchema.parse` 对坏响应抛的正是 ZodError（query hook
    // 「响亮地炸」的设计意图），这就是收口函数的漂移分支。
    m.fetchScanLocate.mockResolvedValue(locateResult([batch({ holder_display: undefined })]));
    const w = await mountDialog();

    expect(
      m.ElMessage.error,
      '漂移也要弹一次 toast（与 L9b 同一条错误桥接）',
    ).toHaveBeenCalledTimes(1);
    const msg = String(m.ElMessage.error.mock.calls[0]?.[0] ?? '');
    expect(msg, 'toast 与弹窗体内红字必须是同一句').toBe(SCAN_LOCATE_CONTRACT_DRIFT_TEXT);
    expect(msg).toContain('诊断');
    expect(msg, '诊断查询的漂移不得说「列表」——工人扫的是条码，本就没打开任何列表').not.toContain(
      '列表',
    );
    w.unmount();
  });

  // 「工单查到了但一个未软删批次都没有」是**第三种**状态：条码是对的，指引不能是
  // 「请改扫子件」（那是未命中才需要的指路）。
  it('L9c：工单存在但批次为空 → 单独的空态文案，不复用「改扫子件」的指引', async () => {
    m.fetchScanLocate.mockResolvedValue(locateResult([]));
    const w = await mountDialog();

    expect(w.text()).toContain('当前没有在制批次');
    expect(w.text(), '条码是对的，不能把人指去扫子件').not.toContain('改扫子件');
    expect(w.find('.mock-table').exists()).toBe(false);
    w.unmount();
  });

  // ⭐ 未知 action 字面量**不给按钮**：守门 schema 刻意不锁枚举（`z.string().nullable()`），
  // 后端加第四个 `LocateAction` 变体时会原样透进来，而 `onActionClick` 只认三个可写动作
  // ⇒ 给按钮就是给一个「按下去静默 return」的骗人按钮。
  it('L10：未知 action 字面量 → 落指引文案、不渲染动作按钮、点不动', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult([batch({ action: 'SOME_FUTURE_ACTION', disabled_reason: null })]),
    );
    const w = await mountDialog();

    expect(rowsText(w), '未知动作必须走 disabled-hint 分支').toContain('暂不支持自助操作');
    expect(
      w.findAll('.mock-row').every((r) => r.findAll('button').length === 0),
      '未知动作不得渲染按钮',
    ).toBe(true);
    // 三个可写动作的按钮文案都不能被误挂到这一行
    expect(w.find('.mock-table').text()).not.toContain('接管');
    w.unmount();
  });

  // ⭐ 接管收 `40001` 且本次本来就没填工序 ⇒ 降级弹手填框。
  //
  // 写侧免填的前置是 `is_pointer_consistent(batch) && chain_state == "NEXT"`，而指针一致性
  // **不在 locate 出参里** ⇒ 「指针漂移但读侧 chain_state 仍是 NEXT」的行在 wire 上与免填
  // 形态不可区分，前端必然走「不发 next_process_id」分支 ⇒ 必吃 `40001`。只弹错误 + 重查
  // 是死循环（读侧结论不变，工人点一次错一次）；必须给出手填出口。
  it('L11：接管吃 40001 且本次没填工序 → 降级弹手填框（不是死循环）', async () => {
    m.takeOverBatch.mockRejectedValue(new ApiError(40001, '必须在 next_process_id 里显式指定'));
    const w = await mountDialog();

    // chain NEXT ⇒ 点按钮不发 next_process_id，直接提交
    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();

    const [batchId, body] = m.takeOverBatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(batchId).toBe(BATCH_ID);
    expect('next_process_id' in body).toBe(false);

    const picker = w.find('.mock-picker-dialog');
    expect(picker.exists(), '40001 且本次没填工序 ⇒ 必须降级弹手填框').toBe(true);
    expect(picker.attributes('data-kind')).toBe('takeover');
    expect(m.ElMessage.error, '仍要告诉工人这次失败').toHaveBeenCalledTimes(1);

    // 补一次工序后应能提交成功（出口真的通）
    m.takeOverBatch.mockResolvedValue({ batch_id: BATCH_ID, version: 7 });
    await w.find('.mock-picker-dialog .picker-ok').trigger('click');
    await flushPromises();
    const [, body2] = m.takeOverBatch.mock.calls[1] as [string, Record<string, unknown>];
    expect(body2.next_process_id).toBe('190000000000888');
    w.unmount();
  });

  // 反向对照：本次**已经**手填了工序还吃 `40001`，不降级弹框（那是别的问题，靠重查）。
  it('L11b：已手填工序还吃 40001 → 不重复弹手填框，且诊断恰好重查一次', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult(
        [batch({ action: 'TAKE_OVER', chain_state: 'NONE', next_process_id: null })],
        twoProcesses(),
      ),
    );
    m.takeOverBatch.mockRejectedValue(new ApiError(40001, 'next_process_id 非法'));
    const w = await mountDialog();

    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();
    expect(w.find('.mock-picker-dialog').exists()).toBe(true);

    await w.find('.mock-picker-dialog .picker-ok').trigger('click');
    await flushPromises();

    expect(w.find('.mock-picker-dialog').exists(), '已手填还失败时不该再弹一次同一个框').toBe(
      false,
    );
    // 重查 = 重打一次 locate。**精确计数**：挂载时首取 1 次，写失败后由 mutation 的
    // `onError` 失效链重取 1 次 ⇒ 恰好 2。用 `toBeGreaterThan(1)` 写不出任何东西
    // （1 次也过、2 次也过、3 次也过），双重刷新就是从这里漏过去的。
    expect(m.fetchScanLocate, '失败后由失效链重查，且只重查一次').toHaveBeenCalledTimes(2);
    w.unmount();
  });

  // `20104` 在 take-over 路径上有**两个真因**：「批次已在你手上，无需接管」与「接管目标
  // 工序不在你的工种范围内」。共用表里那句「所选工序不在你的工种范围内」在前一条路径上
  // 完全指错方向（工人根本没选过工序），故接管自己的文案必须覆盖两条。
  it('L12：接管的 20104 文案覆盖两个真因（不预设「所选工序」）', async () => {
    m.takeOverBatch.mockRejectedValue(new ApiError(20104, '批次已在你手上，无需接管'));
    const w = await mountDialog();

    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();

    const msg = String(m.ElMessage.error.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('可能已不在别人手上');
    expect(msg).toContain('不在你的工种范围内');
    expect(msg, '不得预设工人选过工序').not.toContain('请改选其他工序');
    w.unmount();
  });

  // ⭐ 动作成功后，**三页的列表自己就刷新了**，不靠任何「请刷新页面」的信号。
  //
  // 守的是「弹窗动作成功 ⇒ 页面列表拿到新数据」这条链，刻意**不**把页面当成协作方挂进来：
  // `PageHost` 只做两件事 —— ① 在 setup 里调 `useScanHeldQuery`（放回页 / 送检页 /
  // `HeldPartsBadge` 徽章用的都是这个 hook，这就是「页面列表」的真实形态）、
  // ② 渲染本弹窗。它**没有任何** `@done` 之类的回调，弹窗也不发这种事件
  // ⇒ 列表刷新这件事**只可能**由写路径的失效链造成（页面上的列表 query 是 active 的，
  // 失效即后台重取，而 `mutateAsync` await `onSuccess` 返回的那条失效 promise）。
  // 少了失效链里的 list 前缀，这里立刻红；反过来若有人再把「通知页面刷新」接回来，
  // 本用例不会变绿也变红 —— 它守的是刷新**确实发生**，不是刷新**只发生一次**。
  it('L13：动作成功后页面列表 query 被失效并自动重取（不依赖页面侧任何刷新信号）', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
    });
    const PageHost = defineComponent({
      components: { LocateDialog },
      setup() {
        useScanHeldQuery(() => ({ workerId: WORKER.id, limit: 200 }));
        return () =>
          h(LocateDialog, {
            modelValue: true,
            code: CODE,
            worker: WORKER,
            'onUpdate:modelValue': () => {},
          });
      },
    });
    const w = mount(PageHost, {
      global: { stubs, plugins: [createPinia(), [VueQueryPlugin, { queryClient: qc }]] },
    });
    await flushPromises();
    // 基线：页面列表首取 1 次（`staleTime` 30s 内它自己不会再发）
    expect(m.fetchScanHeld).toHaveBeenCalledTimes(1);

    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();
    expect(m.takeOverBatch).toHaveBeenCalledTimes(1);

    expect(
      m.fetchScanHeld,
      '接管成功后页面列表必须被失效并自动重取（active query + 前缀失效）',
    ).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  // ⭐ 写失败时对 diagnose 端点**只打一次** GET。
  //
  // 弹窗开着时 `qk.scanLocatePrefix` 下的 query 是 active 的，mutation 的 `onError` 失效
  // 它必然触发一次重取；若三条 catch 里再手动 `query.refetch()` 一次，同一次失败就对
  // `GET /prod/scan/locate` 打两次 —— 而 `refetch` 默认 `cancelRefetch: true`，第二次会把
  // 第一次**掐掉重发**、已回来的那份响应被丢弃。
  //
  // 守法与 L13 同款：**真 QueryClient、不 spy `invalidateQueries`**。断言的是「重取确实
  // 发生了，且恰好一次」这个外部可观测事实，而不是「某条失效函数被调了」——后者对
  // 「组件是不是又自己补了一次 refetch」完全失明。
  //
  // ⚠️ 这条用例与「失败后必须重查」是一对：只钉次数下界会让「干脆不重查」也过，只钉上界
  // 会让「失败后不刷新、界面停在旧 `action` / 旧 `version`」也过。故这里钉的是**精确值**
  // （首取 1 + 失效链 1 = 2），少一次、多一次都红。
  it('L14：写失败后 locate 端点恰好被重取一次（失效链那条，没有第二次手动 refetch）', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
    });
    m.takeOverBatch.mockRejectedValue(new ApiError(40901, '版本冲突：该批次已被他人处置'));
    const w = mount(LocateDialog, {
      props: { modelValue: true, code: CODE, worker: WORKER },
      global: { stubs, plugins: [createPinia(), [VueQueryPlugin, { queryClient: qc }]] },
    });
    await flushPromises();
    // 基线：挂载首取 1 次（`staleTime` 30s 内它自己不会再发）
    expect(m.fetchScanLocate).toHaveBeenCalledTimes(1);

    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();

    expect(m.takeOverBatch).toHaveBeenCalledTimes(1);
    expect(
      m.fetchScanLocate,
      '写失败必须重查（onError 失效链），且只重查一次 —— 3 次就是「失效链 + 手动 refetch」两条通道同时跑',
    ).toHaveBeenCalledTimes(2);
    w.unmount();
  });
});

// 2026-10-16：手填下一道工序的候选收窄到**当前工人的工种工序**（locate 顶层
// `worker_processes`，与写端点的工种闸门同一份判据）。这组用例守三件事：
//   1. 候选恰好一条时**不弹框、直接提交**（工种已经唯一确定目标工序，多一次触屏交互
//      是纯损耗）；
//   2. 多条时才弹框，且框内只列这 N 条；
//   3. 空集合给出兜底提示而不是让按钮点了没反应 —— 正常情况下这种行后端已判成不可点
//      （`disabled_reason = PROCESS_NOT_IN_WORK_TYPE`），本组守的是「万一到了也别装死」。
describe('LocateDialog / 手填工序的候选来自工种工序', () => {
  const NO_MANUAL_ROW = {
    action: 'TAKE_OVER',
    chain_state: 'NONE',
    next_process_id: null,
  };

  it('候选恰好 1 条：不弹手填框，直接用那一条提交', async () => {
    m.fetchScanLocate.mockResolvedValue(locateResult([batch(NO_MANUAL_ROW)]));
    const w = await mountDialog();

    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();

    expect(w.findAll('.mock-picker-dialog'), '单候选不该弹框').toHaveLength(0);
    expect(m.takeOverBatch).toHaveBeenCalledTimes(1);
    const [, body] = m.takeOverBatch.mock.calls[0] as [string, Record<string, unknown>];
    // 提交体带的就是候选里那一条的 process_id（后端雪花 id 字符串形态，不转 number）
    expect(body.next_process_id).toBe('190000000000881');
    w.unmount();
  });

  it('外协收回的单候选同样直提（两个动作走同一条手填路径）', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult(
        [
          batch({
            action: 'RECEIVE_FROM_OUTSOURCE',
            chain_state: 'TAIL',
            next_process_id: null,
            location: 'OUTSOURCE_COMPANY',
          }),
        ],
        [{ process_id: '190000000000881', code: 'TURN', name: '车削', category: 'INHOUSE' }],
      ),
    );
    const w = await mountDialog();

    await rowButton(w, 0, '确认收回')!.trigger('click');
    await flushPromises();

    expect(w.findAll('.mock-picker-dialog')).toHaveLength(0);
    expect(m.receiveFromOutsource).toHaveBeenCalledTimes(1);
    const [, body] = m.receiveFromOutsource.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.next_process_id).toBe('190000000000881');
    w.unmount();
  });

  it('候选多条：弹框且 allowedProcessIds 只含这 N 条', async () => {
    m.fetchScanLocate.mockResolvedValue(locateResult([batch(NO_MANUAL_ROW)], twoProcesses()));
    const w = await mountDialog();

    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();

    const picker = w.find('.mock-picker-dialog');
    expect(picker.exists()).toBe(true);
    expect(JSON.parse(picker.attributes('data-allowed') ?? 'null')).toEqual([
      '190000000000881',
      '190000000000882',
    ]);
    expect(m.takeOverBatch, '选之前不提交').not.toHaveBeenCalled();
    w.unmount();
  });

  it('候选为空：不弹框也不提交，给出「工种未映射工序」的兜底提示', async () => {
    m.ElMessage.warning.mockClear();
    m.fetchScanLocate.mockResolvedValue(locateResult([batch(NO_MANUAL_ROW)], []));
    const w = await mountDialog();

    await rowButton(w, 0, '接管')!.trigger('click');
    await flushPromises();

    expect(w.findAll('.mock-picker-dialog')).toHaveLength(0);
    expect(m.takeOverBatch).not.toHaveBeenCalled();
    const msg = String(m.ElMessage.warning.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('该工种未映射任何工序');
    expect(msg).toContain('管理员');
    w.unmount();
  });
});
