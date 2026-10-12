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
// 这批用例守四件「写错了也**不会报错**、只会让工人读一句无关文案或做一次注定失败的
// 操作」的事：
//   1. **走的是 locate 而不是 by-serial**（L1）；
//   2. **工序参数的形态随 `chain_state` 变**（L2 / L3）：接管在 `NEXT` 时**不发**
//      `next_process_id`（后端自推）；外协收回在 `NEXT` 时**必须原样回传** diagnose 行
//      的那个 id —— 写侧缺省推导是 `sort_order = 当前 + 1`，与读侧
//      `sort_order > 当前 LIMIT 1` 在稀疏链上不等价，省略就吃 `20706` / `40001`；
//   3. **`action === null` 的行不给按钮**（L4）：给了就是「点了必失败」；
//   4. **守门 schema 真在 queryFn 上**（L5）：把 `locateResultSchema.parse` 整段删掉时，
//      少键 / 雪花 id 发成 number 的响应会一路流到视图层，页面变成一张空表 ——
//      所以这里断言的是「固定文案出现」，不是「页面没崩」。
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
  fetchScanLocate: vi.fn(),
  pickUpBatch: vi.fn(),
  takeOverBatch: vi.fn(),
  receiveFromOutsource: vi.fn(),
  getPartBySerial: vi.fn(),
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/productionScan', () => ({
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
import { SCAN_LIST_CONTRACT_DRIFT_TEXT } from '@/views/production/scan/composables/scanListErrorMessage';

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

/** 一份合法的诊断结果信封。 */
function locateResult(rows: unknown[]): Record<string, unknown> {
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
    props: ['modelValue', 'kind', 'showClose', 'currentProcessId', 'hint', 'excludeProcessIds'],
    emits: ['confirm', 'cancel', 'update:modelValue'],
    // `data-kind` / `data-showclose` 用来验「弹窗按 kind 出文案」+「关闭权收在 footer」。
    template: `<div
      v-if="modelValue"
      class="mock-picker-dialog"
      :data-kind="kind"
      :data-showclose="String(showClose)"
    >
      <button class="picker-ok" @click="$emit('confirm', { id: '190000000000888', code: 'P8', name: '钻孔', category: 'INHOUSE' })">选它</button>
    </div>`,
  }),
};

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
  it('L4：链推不出下一道 → 先弹手填工序弹窗（kind 分流），且关闭权不在 × 上', async () => {
    m.fetchScanLocate.mockResolvedValue(
      locateResult([batch({ action: 'TAKE_OVER', chain_state: 'NONE', next_process_id: null })]),
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
  it('L8：坏响应被守门 schema 拦下（少键 / 雪花 id 发成 number）→ 走 scanListErrorText 固定文案', async () => {
    // (a) 少一个键（holder_display）
    m.fetchScanLocate.mockResolvedValue(locateResult([batch({ holder_display: undefined })]));
    let w = await mountDialog();
    expect(w.text()).toContain(SCAN_LIST_CONTRACT_DRIFT_TEXT);
    expect(w.find('.mock-table').exists(), '守门失败时不得渲染表格').toBe(false);
    w.unmount();

    // (b) 雪花 id 发成 number（19 位在 JS Number 下会丢精度，后端发的是 string）
    m.fetchScanLocate.mockResolvedValue(locateResult([batch({ batch_id: Number(BATCH_ID) })]));
    w = await mountDialog();
    expect(w.text()).toContain(SCAN_LIST_CONTRACT_DRIFT_TEXT);
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
    expect(w.text()).not.toContain(SCAN_LIST_CONTRACT_DRIFT_TEXT);
    w.unmount();
  });
});
