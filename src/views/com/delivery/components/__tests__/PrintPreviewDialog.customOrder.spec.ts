// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/PrintPreviewDialog.customOrder.spec.ts
//
// 2026-10-04 新增：导出 payload 契约的回归守卫（线上 422 的直接原因）。
//
// 后端 `custom_order` / `line_item_ids` 只认**每个 part 一个代表批次 id**（代表 =
// 该 part 下最小的批次 id）：多发非代表 id 判 21113「含已合并的批次 id」，漏发代表
// id 判「漏行」。前端曾经把每 part 的**全部**批次 id 都发进去（送标签时同 part 被
// _split 拆成 2 批即 422），这里把「reps-only + 代表取 min + 与返回顺序无关 + 装配件
// 父行展开为组内各 part 的代表 id」钉成用例。
//
// 为什么用 EP 模板桩而不是真 el-table / el-dialog：被测的是「导出时发给后端的
// payload 长什么样」，与表格 DOM 无关；el-table ↔ el-table-column 的插槽作用域协议
// 也不该由本用例复刻（理由同 src/views/inspection/__tests__/InspectionTable.spec.ts）。
// 桩 el-table 把**真实**的 :data 逐行喂给列插槽（`data-row-id` 定位单元格），所以
// 数量列的用例断的是真 previewRows 计算结果，而不是手摆的行对象。
//
// 覆盖：payload 形状 / 代表取 min（含 BigInt 语义）/ merge 与 separate 两模式 /
// 装配件套数只读展示与缺失兜底。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteLineItemData,
} from '../../composables/deliveryNoteSchema';

const printNoteMock = vi.fn();
const printNoteLabelsMock = vi.fn();
vi.mock('@/api/com/deliveryNote', () => ({
  printNote: (...args: unknown[]) => printNoteMock(...args),
  printNoteLabels: (...args: unknown[]) => printNoteLabelsMock(...args),
}));

const triggerBrowserDownloadMock = vi.fn();
vi.mock('@/utils/download', () => ({
  triggerBrowserDownload: (...args: unknown[]) => triggerBrowserDownloadMock(...args),
}));

vi.mock('@/components/ColumnDragHandle.vue', () => ({
  default: { name: 'ColumnDragHandleStub', template: '<i class="mock-drag-handle" />' },
}));
vi.mock('@/components/ColumnVisibilityPopover.vue', () => ({
  default: { name: 'ColumnVisibilityPopoverStub', template: '<div class="mock-cvp" />' },
}));

/** el-table 桩把自己的 :data 摊到这里，列桩按行渲染单元格（桩拿不到 EP 的 table 上下文）。 */
let scopeRows: Record<string, unknown>[] = [];

const ElTableStub = defineComponent({
  name: 'ElTableStub',
  props: {
    data: { type: Array as PropType<Record<string, unknown>[]>, default: () => [] },
  },
  emits: ['selection-change'],
  setup(props, { slots }) {
    return () => {
      // 父组件 render 一定先于子组件 render，此处同步后列桩立即读到最新行
      scopeRows = props.data;
      return h('div', { class: 'mock-el-table' }, slots.default?.());
    };
  },
  mounted() {
    // 勾选态：label 模式默认全选，桩直接以整表 data 模拟 selection-change
    this.$emit('selection-change', this.data);
  },
  methods: {
    // selectAll 逐行 toggle 是个 no-op
    toggleRowSelection() {},
  },
});

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElTag: { name: 'ElTagStub', template: '<span class="mock-el-tag"><slot /></span>' },
  ElTable: ElTableStub,
}));

const stubs = {
  ElDialog: {
    name: 'ElDialogStub',
    props: ['modelValue'],
    template: '<div class="mock-el-dialog"><slot /><slot name="footer" /></div>',
  },
  ElTable: ElTableStub,
  ElTableColumn: defineComponent({
    name: 'ElTableColumnStub',
    props: { label: { type: String, default: '' } },
    setup(props, { slots }) {
      // 每行一个单元格，data-row-id 便于按行断言
      return () =>
        h(
          'div',
          { class: 'mock-el-table-column', 'data-col': props.label },
          scopeRows.map((row, $index) =>
            h(
              'div',
              { class: 'mock-cell', 'data-row-id': String(row.id ?? '') },
              slots.default ? slots.default({ row, $index }) : [],
            ),
          ),
        );
    },
  }),
  ElSpace: { name: 'ElSpaceStub', template: '<div class="mock-el-space"><slot /></div>' },
  ElButton: {
    name: 'ElButtonStub',
    props: ['type', 'loading', 'disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  // v-model 通道：点击子 radio-button（原生 button + data-value）冒泡到 group，
  // 由 group 转成 update:modelValue。桩掉 v-model 就没法在用例里切合并/分开模式。
  ElRadioGroup: defineComponent({
    name: 'ElRadioGroupStub',
    props: { modelValue: { type: [String, Number, Boolean], default: '' } },
    emits: ['update:modelValue'],
    setup(_props, { emit, slots }) {
      return () =>
        h(
          'div',
          {
            class: 'mock-el-radio',
            onClick: (e: MouseEvent) => {
              const hit = (e.target as HTMLElement | null)?.closest('[data-value]');
              if (hit) emit('update:modelValue', hit.getAttribute('data-value'));
            },
          },
          slots.default?.(),
        );
    },
  }),
  ElRadioButton: defineComponent({
    name: 'ElRadioButtonStub',
    props: { value: { type: [String, Number, Boolean], default: '' } },
    setup(props, { slots }) {
      return () =>
        h(
          'button',
          { type: 'button', class: 'mock-el-radio-btn', 'data-value': String(props.value) },
          slots.default?.(),
        );
    },
  }),
};

function mkItem(p: Partial<DeliveryNoteLineItemData> & { id: string; part_id: string }) {
  return {
    version: 1,
    batch_no: null,
    batch_label: null,
    serial_no: `S-${p.id}`,
    drawing_no: 'D-1',
    name: 'N1',
    quantity: 1,
    status: 'READY_TO_SHIP',
    applicant_name: null,
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: null,
    order_no: null,
    note: null,
    customer_name: null,
    parent_customer_name: null,
    customer_path: null,
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    ...p,
  } satisfies DeliveryNoteLineItemData;
}

function mkNote(lineItems: DeliveryNoteLineItemData[]): DeliveryNoteDetailData {
  return {
    id: 'NOTE-1',
    version: 1,
    delivery_note_no: 'DN-001',
    customer_id: 'C1',
    customer_name: null,
    customer_path: null,
    status: 'DRAFT',
    submitted_at: null,
    picked_up_at: null,
    driver_worker_name: null,
    part_count: lineItems.length,
    note: null,
    delivery_date: null,
    line_items: lineItems,
  };
}

/** 一套装配（PA 被拆成 400/300 两批，PB 一批）+ 一个散件：合并模式折成 2 行，分开打 3 行。 */
function asmNoteItems(): DeliveryNoteLineItemData[] {
  const asm = 'ASM-1';
  return [
    mkItem({ id: '400', part_id: 'PA', assembly_id: asm, assembly_name: '总装' }),
    mkItem({ id: '300', part_id: 'PA', assembly_id: asm, assembly_name: '总装' }),
    mkItem({ id: '150', part_id: 'PB', assembly_id: asm, assembly_name: '总装' }),
    mkItem({ id: '999', part_id: 'PLOOSE' }),
  ];
}

/** 挂载弹窗（note 模式 / label 模式），等首屏数据落定。
 *  组件走动态 import：element-plus 的 mock 工厂在文件顶部执行，早于本文件的桩常量。 */
async function mountDialog(
  note: DeliveryNoteDetailData,
  mode: 'note' | 'label',
): Promise<VueWrapper> {
  const { default: PrintPreviewDialog } = await import('../PrintPreviewDialog.vue');
  const wrapper = mount(PrintPreviewDialog, {
    props: { modelValue: true, note, mode },
    global: { stubs },
  });
  await flushPromises();
  return wrapper;
}

/** 点 footer 的「导出」按钮（按 data-role 定位，不依赖它在 footer 里的位置）。 */
async function clickExport(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('button[data-role="export"]').trigger('click');
  await flushPromises();
}

/** 「数量」列某行的单元格；rowId 省略时返回全部行的单元格。 */
function qtyCell(wrapper: VueWrapper, rowId?: string) {
  const sel = rowId ? `[data-col="数量"] [data-row-id="${rowId}"]` : '[data-col="数量"] .mock-cell';
  return wrapper.findAll(sel);
}

/** 切「合并一套 / 分开打子件」模式（走 el-radio-group 的 v-model 通道）。 */
async function switchMergeMode(wrapper: VueWrapper, value: 'merge' | 'separate') {
  await wrapper.find(`.mock-el-radio-btn[data-value="${value}"]`).trigger('click');
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  scopeRows = [];
  printNoteMock.mockResolvedValue({ blob: new Blob(), filename: 'note.xlsx' });
  printNoteLabelsMock.mockResolvedValue({ blob: new Blob(), filename: 'labels.xlsx' });
});

describe('printNote custom_order = 每 part 一个代表批次 id', () => {
  it('同 part 被 _split 拆成 2 批 → 只发最小 id（线上 422 场景）', async () => {
    const note = mkNote([
      mkItem({ id: '225132995307110400', part_id: '208421321317548032', quantity: 3 }),
      mkItem({ id: '225133032221179904', part_id: '208421321317548032', quantity: 2 }),
    ]);
    await clickExport(await mountDialog(note, 'note'));
    expect(printNoteMock).toHaveBeenCalledTimes(1);
    expect(printNoteMock.mock.calls[0]![1]).toEqual({
      custom_order: ['225132995307110400'],
      merge_assemblies: true,
    });
  });

  it('代表取 min 与 line_items 返回顺序无关（大的排在前面也不换代表）', async () => {
    const note = mkNote([
      mkItem({ id: '225133032221179904', part_id: 'P1', quantity: 2 }),
      mkItem({ id: '225132995307110400', part_id: 'P1', quantity: 3 }),
    ]);
    await clickExport(await mountDialog(note, 'note'));
    expect(printNoteMock.mock.calls[0]![1]).toMatchObject({ custom_order: ['225132995307110400'] });
  });

  it('多 part 混合 → 各 part 代表 id 各一个，按预览行顺序', async () => {
    const note = mkNote([
      mkItem({ id: '300', part_id: 'P1' }),
      mkItem({ id: '100', part_id: 'P2' }),
      mkItem({ id: '200', part_id: 'P1' }),
    ]);
    await clickExport(await mountDialog(note, 'note'));
    // 行序 = part 首现序（P1 → P2）；P1 的代表是 200 而非首现的 300
    expect(printNoteMock.mock.calls[0]![1]).toMatchObject({ custom_order: ['200', '100'] });
  });

  it('套数全由后端算：payload 不再带 merge_quantities', async () => {
    const note = mkNote([mkItem({ id: '100', part_id: 'P1' })]);
    await clickExport(await mountDialog(note, 'note'));
    expect(printNoteMock.mock.calls[0]![1]).not.toHaveProperty('merge_quantities');
  });

  it('装配件父行 → 该套装下每个 part 各一个代表 id（不只发首个）', async () => {
    await clickExport(await mountDialog(mkNote(asmNoteItems()), 'note'));
    expect(printNoteMock.mock.calls[0]![1]).toEqual({
      custom_order: ['300', '150', '999'],
      merge_assemblies: true,
    });
  });
});

describe('代表批次按 BigInt 比（雪花 id 是 string，> 2^53）', () => {
  it('仅在 2^53 之后才有差别的 19 位 id → 仍要换代表（转 Number 比较会判相等）', async () => {
    const note = mkNote([
      mkItem({ id: '9223372036854775807', part_id: 'P1' }),
      mkItem({ id: '9223372036854775806', part_id: 'P1' }),
    ]);
    await clickExport(await mountDialog(note, 'note'));
    expect(printNoteMock.mock.calls[0]![1]).toMatchObject({
      custom_order: ['9223372036854775806'],
    });
  });

  it('不等长 id → 按数值而非字典序（999 < 1000）', async () => {
    const note = mkNote([
      mkItem({ id: '1000', part_id: 'P1' }),
      mkItem({ id: '999', part_id: 'P1' }),
    ]);
    await clickExport(await mountDialog(note, 'note'));
    expect(printNoteMock.mock.calls[0]![1]).toMatchObject({ custom_order: ['999'] });
  });
});

describe('合并 / 分开 两种模式', () => {
  it('切「分开打子件」→ 预览不折叠装配件（3 行）且 merge_assemblies=false', async () => {
    const wrapper = await mountDialog(mkNote(asmNoteItems()), 'note');
    // 默认合并：PA+PB 折成装配件父行 + 散件 → 2 行
    expect(qtyCell(wrapper).length).toBe(2);
    await switchMergeMode(wrapper, 'separate');
    // 分开打：每个 part 一行（PA 两批仍按 part 折叠成代表行）→ 3 行
    expect(qtyCell(wrapper).length).toBe(3);
    await clickExport(wrapper);
    expect(printNoteMock.mock.calls[0]![1]).toEqual({
      custom_order: ['300', '150', '999'],
      merge_assemblies: false,
    });
  });

  it('切回「合并一套」→ 恢复折叠且 merge_assemblies=true', async () => {
    const wrapper = await mountDialog(mkNote(asmNoteItems()), 'note');
    await switchMergeMode(wrapper, 'separate');
    await switchMergeMode(wrapper, 'merge');
    expect(qtyCell(wrapper).length).toBe(2);
    await clickExport(wrapper);
    expect(printNoteMock.mock.calls[0]![1]).toMatchObject({ merge_assemblies: true });
  });
});

describe('printNoteLabels line_item_ids 与 custom_order 同口径', () => {
  it('全选 → line_item_ids 是 custom_order 的代表 id 集合（非代表 id 会判不属于本单）', async () => {
    const note = mkNote([
      mkItem({ id: '225132995307110400', part_id: 'P1' }),
      mkItem({ id: '225133032221179904', part_id: 'P1' }),
      mkItem({ id: '500', part_id: 'P2' }),
    ]);
    await clickExport(await mountDialog(note, 'label'));
    const payload = printNoteLabelsMock.mock.calls[0]![1] as {
      custom_order: string[];
      line_item_ids: string[];
      merge_assemblies: boolean;
    };
    expect(payload.custom_order).toEqual(['225132995307110400', '500']);
    expect(payload.line_item_ids).toEqual(['225132995307110400', '500']);
    expect(payload.merge_assemblies).toBe(true);
    expect(payload).not.toHaveProperty('merge_quantities');
  });
});

describe('装配件父行数量列只读展示后端算出的套数', () => {
  const asm = 'ASM-1';
  const asmItems = (pa: Partial<DeliveryNoteLineItemData>, pb: Partial<DeliveryNoteLineItemData>) =>
    mkNote([
      mkItem({
        id: '400',
        part_id: 'PA',
        assembly_id: asm,
        assembly_name: '总装',
        assembly_quantity: 20,
        ...pa,
      }),
      mkItem({
        id: '300',
        part_id: 'PB',
        assembly_id: asm,
        assembly_name: '总装',
        assembly_quantity: 20,
        ...pb,
      }),
    ]);

  it('渲染可出货套数 + tooltip（工单总套数），且没有输入框', async () => {
    const wrapper = await mountDialog(
      asmItems({ shippable_sets: 7 }, { shippable_sets: 4 }),
      'note',
    );
    const cell = qtyCell(wrapper, 'ASM_ASM-1')[0]!;
    expect(cell.text()).toContain('4');
    expect(cell.find('.asm-qty').attributes('title')).toBe('工单总套数 20 套；本单可出货 4 套');
    // 原 el-input-number 已下线：装配件父行不再是可输入控件
    expect(cell.find('input').exists()).toBe(false);
  });

  it('后端整体没给 shippable_sets → 渲染「—」而不是「0 套」', async () => {
    const wrapper = await mountDialog(asmItems({}, {}), 'note');
    const cell = qtyCell(wrapper, 'ASM_ASM-1')[0]!;
    // 「0 套」会被读成「凑不齐一套、打不了」，与「后端没给数」含义相反
    expect(cell.text()).toBe('—');
    expect(cell.find('.asm-qty').attributes('title')).toBe('工单总套数 20 套；本单可出货 — 套');
  });

  it('只有部分子件行填了 shippable_sets → 取有值者的 min（不塌成 0）', async () => {
    const wrapper = await mountDialog(asmItems({}, { shippable_sets: 4 }), 'note');
    const cell = qtyCell(wrapper, 'ASM_ASM-1')[0]!;
    expect(cell.text()).toContain('4');
    expect(cell.text()).not.toContain('0');
  });

  it('真的凑不齐整套（shippable_sets = 0）→ 照实显示「0 套」', async () => {
    const wrapper = await mountDialog(
      asmItems({ shippable_sets: 0 }, { shippable_sets: 0 }),
      'note',
    );
    const cell = qtyCell(wrapper, 'ASM_ASM-1')[0]!;
    expect(cell.text()).toBe('0套');
  });
});
