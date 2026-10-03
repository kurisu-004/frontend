// @vitest-environment happy-dom
// src/views/delivery/components/__tests__/PrintPreviewDialog.customOrder.spec.ts
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
// 数量列只额外断一件事 —— 装配件父行渲染成只读文本（无 el-input-number 输入框）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, type PropType } from 'vue';
import type { DeliveryNoteDetailOut, DeliveryNoteLineItem } from '@/types/deliveryNote';

const printNoteMock = vi.fn();
const printNoteLabelsMock = vi.fn();
vi.mock('@/api/deliveryNote', () => ({
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

/** el-table-column 默认插槽的 `{ row }` 由本变量喂进去（桩拿不到 EP 的 table 上下文）。 */
let scopeRow: Record<string, unknown> = {};

const ElTableStub = defineComponent({
  name: 'ElTableStub',
  props: {
    data: { type: Array as PropType<DeliveryNoteLineItem[]>, default: () => [] },
  },
  emits: ['selection-change'],
  mounted() {
    this.$emit('selection-change', this.data);
  },
  methods: {
    // 勾选态由 mounted 的「全选」emit 模拟（selectAll 逐行 toggle 是个 no-op）
    toggleRowSelection() {},
  },
  template: '<div class="mock-el-table"><slot /></div>',
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
  ElTableColumn: {
    name: 'ElTableColumnStub',
    props: ['label'],
    setup() {
      return { scopeRow };
    },
    template: '<div class="mock-el-table-column"><slot :row="scopeRow" :$index="0" /></div>',
  },
  ElSpace: { name: 'ElSpaceStub', template: '<div class="mock-el-space"><slot /></div>' },
  ElButton: {
    name: 'ElButtonStub',
    props: ['type', 'loading', 'disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  ElRadioGroup: { name: 'ElRadioGroupStub', template: '<div class="mock-el-radio" />' },
  ElRadioButton: { name: 'ElRadioButtonStub', template: '<div class="mock-el-radio-btn" />' },
};

function mkItem(p: Partial<DeliveryNoteLineItem> & { id: string; part_id: string }) {
  return {
    version: 1,
    batch_no: null,
    batch_label: null,
    serial_no: `S-${p.id}`,
    drawing_no: 'D-1',
    name: 'N1',
    quantity: 1,
    is_urgent: false,
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
    is_scanned: false,
    scanned: false,
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    ...p,
  } satisfies DeliveryNoteLineItem;
}

function mkNote(lineItems: DeliveryNoteLineItem[]): DeliveryNoteDetailOut {
  return {
    id: 'NOTE-1',
    version: 1,
    delivery_note_no: 'DN-001',
    customer_id: 'C1',
    customer_name: null,
    parent_customer_name: null,
    customer_path: null,
    status: 'DRAFT',
    submitted_at: null,
    picked_up_at: null,
    submitted_by: null,
    picked_up_by: null,
    driver_worker_id: null,
    driver_worker_name: null,
    part_count: lineItems.length,
    note: null,
    delivery_date: null,
    created_at: '2026-10-04',
    updated_at: '2026-10-04',
    line_items: lineItems,
    scanned_serials: [],
  };
}

/** 挂载弹窗（note 模式 / label 模式）并点「导出」按钮，返回触发后的 wrapper。 */
async function mountAndConfirm(note: DeliveryNoteDetailOut, mode: 'note' | 'label') {
  const { default: PrintPreviewDialog } = await import('../PrintPreviewDialog.vue');
  const wrapper = mount(PrintPreviewDialog, {
    props: { modelValue: true, note, mode },
    global: { stubs },
  });
  await flushPromises();
  // 桩按钮：footer 里「导出送货单」/「导出标签」是最后一个 button
  const btns = wrapper.findAll('button');
  await btns[btns.length - 1]!.trigger('click');
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  scopeRow = {};
  printNoteMock.mockResolvedValue({ blob: new Blob(), filename: 'note.xlsx' });
  printNoteLabelsMock.mockResolvedValue({ blob: new Blob(), filename: 'labels.xlsx' });
});

describe('printNote custom_order = 每 part 一个代表批次 id', () => {
  it('同 part 被 _split 拆成 2 批 → 只发最小 id（线上 422 场景）', async () => {
    const note = mkNote([
      mkItem({ id: '225132995307110400', part_id: '208421321317548032', quantity: 3 }),
      mkItem({ id: '225133032221179904', part_id: '208421321317548032', quantity: 2 }),
    ]);
    await mountAndConfirm(note, 'note');
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
    await mountAndConfirm(note, 'note');
    expect(printNoteMock.mock.calls[0]![1]).toMatchObject({ custom_order: ['225132995307110400'] });
  });

  it('多 part 混合 → 各 part 代表 id 各一个，按预览行顺序', async () => {
    const note = mkNote([
      mkItem({ id: '300', part_id: 'P1' }),
      mkItem({ id: '100', part_id: 'P2' }),
      mkItem({ id: '200', part_id: 'P1' }),
    ]);
    await mountAndConfirm(note, 'note');
    // 行序 = part 首现序（P1 → P2）；P1 的代表是 200 而非首现的 300
    expect(printNoteMock.mock.calls[0]![1]).toMatchObject({ custom_order: ['200', '100'] });
  });

  it('套数全由后端算：payload 不再带 merge_quantities', async () => {
    const note = mkNote([mkItem({ id: '100', part_id: 'P1' })]);
    await mountAndConfirm(note, 'note');
    expect(printNoteMock.mock.calls[0]![1]).not.toHaveProperty('merge_quantities');
  });

  it('装配件父行 → 该套装下每个 part 各一个代表 id（不只发首个）', async () => {
    const asm = 'ASM-1';
    const note = mkNote([
      mkItem({ id: '400', part_id: 'PA', assembly_id: asm, assembly_name: '总装' }),
      mkItem({ id: '300', part_id: 'PA', assembly_id: asm, assembly_name: '总装' }),
      mkItem({ id: '150', part_id: 'PB', assembly_id: asm, assembly_name: '总装' }),
      mkItem({ id: '999', part_id: 'PLOOSE' }),
    ]);
    await mountAndConfirm(note, 'note');
    expect(printNoteMock.mock.calls[0]![1]).toEqual({
      custom_order: ['300', '150', '999'],
      merge_assemblies: true,
    });
  });
});

describe('printNoteLabels line_item_ids 与 custom_order 同口径', () => {
  it('全选 → line_item_ids 是 custom_order 的代表 id 集合（非代表 id 会判不属于本单）', async () => {
    const note = mkNote([
      mkItem({ id: '225132995307110400', part_id: 'P1' }),
      mkItem({ id: '225133032221179904', part_id: 'P1' }),
      mkItem({ id: '500', part_id: 'P2' }),
    ]);
    await mountAndConfirm(note, 'label');
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
  it('渲染可出货套数 + tooltip（工单总套数），且没有输入框', async () => {
    // el-table-column 桩在 setup 期抓 scopeRow，故须先摆好装配件父行再 mount
    scopeRow = {
      id: 'ASM_ASM-1',
      is_asm_row: true,
      assembly_id: 'ASM-1',
      order_no: '',
      customer_name: '',
      applicant_name: '',
      drawing_no: 'D-ASM',
      name: '总装',
      quantity: 4, // 两子件 shippable_sets = 7 / 4 → 父行取最小 4
      unit: '套',
      assembly_quantity: 20,
    };
    const { default: PrintPreviewDialog } = await import('../PrintPreviewDialog.vue');
    const asm = 'ASM-1';
    const note = mkNote([
      mkItem({
        id: '400',
        part_id: 'PA',
        assembly_id: asm,
        assembly_name: '总装',
        shippable_sets: 7,
        assembly_quantity: 20,
      }),
      mkItem({
        id: '300',
        part_id: 'PB',
        assembly_id: asm,
        assembly_name: '总装',
        shippable_sets: 4,
        assembly_quantity: 20,
      }),
    ]);
    const wrapper = mount(PrintPreviewDialog, {
      props: { modelValue: true, note, mode: 'note' },
      global: { stubs },
    });
    await flushPromises();
    // 「数量」列是模板里手写的最后一列，不在 columnDefs 的 v-for 里
    const qtyCell = wrapper.findAll('.mock-el-table-column').at(-1)!;
    expect(qtyCell.text()).toContain('4');
    expect(qtyCell.find('.asm-qty').attributes('title')).toBe('工单总套数 20 套；本单可出货 4 套');
    // 原 el-input-number 已下线：装配件父行不再是可输入控件
    expect(qtyCell.find('input').exists()).toBe(false);
  });
});
