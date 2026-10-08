// @vitest-environment happy-dom
// src/views/com/delivery/composables/__tests__/useDeliveryNoteActions.removeSelected.spec.ts
//
// 「移除选中」的接线守卫（2026-10-09 新增）。
//
// 表格行由「批次行」改为「零件 / 装配件行」后，移除这条链路多出两件以前不需要做的事：
//   1. **按行展开成批次 id**：用户按行勾选，`POST /remove-batches` 收的是 batch_ids，
//      所以要走 `rowIdToBatchIds` 展开（装配件父行 = 子件批次的并集）；
//   2. **移除成功后 `clearSelection()`**：勾选列开了 `reserve-selection`，只清 composable
//      侧的选中态而不清 EP 的保留集，同一零件重新扫码入单会带着「已删行」的勾选态回来
//      —— 这个回归没有任何报错，只有用户看见一个自己没勾过的框。
//
// 确认文案也要跟着走：用户按行勾、接口按批次删，只说「N 个批次」会让人以为删的就是那 N 行。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { computed, createApp, ref, type Ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { DeliveryNoteDetailBindings } from '../useDeliveryNoteActions';
import type { PartTreeRow } from '../../utils/deliveryNotePartRows';

const { removeBatchesMock, confirmMock } = vi.hoisted(() => ({
  removeBatchesMock: vi.fn(),
  confirmMock: vi.fn(),
}));

vi.mock('@/api/com/deliveryNote', () => ({
  removeBatches: removeBatchesMock,
  recallNote: vi.fn(),
  softDeleteNote: vi.fn(),
  submitNote: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  // 二次确认走 useConfirm → ElMessageBox.confirm（危险操作都经它）
  ElMessageBox: { confirm: confirmMock },
}));

const { ElMessage } = await import('element-plus');
const { useDeliveryNoteActions } = await import('../useDeliveryNoteActions');

const app = createApp({ render: () => null });
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
setActivePinia(app.config.globalProperties.$pinia);

function partRow(id: string, batchIds: string[]): PartTreeRow {
  return {
    id,
    is_part_row: true,
    serial_no: '',
    drawing_no: '',
    name: '',
    order_no: '',
    applicant_name: '',
    customer_name: '',
    customer_path: '',
    note: '',
    quantity: batchIds.length,
    unit: '件',
    batch_ids: batchIds,
    label_printed: false,
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: null,
    status: 'READY_TO_SHIP',
    part_id: id,
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    assembly_quantity: null,
    shippable_sets: null,
    seq: 1,
    min_seq: null,
  };
}

function boot(selected: PartTreeRow[], rowMap: Record<string, string[]>) {
  const bindings: DeliveryNoteDetailBindings = {
    note: ref({
      id: 'N1',
      version: 7,
      part_count: 3,
      delivery_note_no: 'DN-001',
      delivery_date: null,
    }),
    selectedRows: ref(selected) as Ref<PartTreeRow[]>,
    rowIdToBatchIds: computed(() => new Map(Object.entries(rowMap))),
    editDeliveryDate: ref(''),
    fetchDetail: vi.fn().mockResolvedValue(undefined),
    setSelectedRows: vi.fn(),
    clearSelection: vi.fn(),
  };
  const actions = app.runWithContext(() => useDeliveryNoteActions(bindings));
  return { actions, bindings };
}

beforeEach(() => {
  removeBatchesMock.mockReset();
  confirmMock.mockReset();
  removeBatchesMock.mockResolvedValue({ version: 8 });
  confirmMock.mockResolvedValue(true);
  (ElMessage.warning as unknown as { mock: { calls: unknown[] } }).mock.calls.length = 0;
  (ElMessage.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length = 0;
});

describe('onRemoveSelected 空选', () => {
  it('零勾选 → warning 说清怎么补救，零请求', async () => {
    const { actions } = boot([], {});
    expect(await actions.onRemoveSelected()).toBe(false);
    expect(ElMessage.warning).toHaveBeenCalledWith('请勾选要移除的零件/装配件');
    expect(removeBatchesMock).not.toHaveBeenCalled();
  });
});

describe('onRemoveSelected 按行展开成批次 id', () => {
  it('零件行：一行多个批次 ⇒ 一次请求带全部批次 id', async () => {
    const row = partRow('P:-:P1', ['10', '11']);
    const { actions, bindings } = boot([row], { [row.id]: ['10', '11'] });
    expect(await actions.onRemoveSelected()).toBe(true);
    expect(removeBatchesMock).toHaveBeenCalledWith('N1', { batch_ids: ['10', '11'], version: 7 });
    expect(bindings.setSelectedRows).toHaveBeenCalledWith([]);
  });

  it('装配件父行：展开成子件批次并集（父行本身没有批次）', async () => {
    const asm: PartTreeRow = {
      ...partRow('ASM_A1', []),
      is_part_row: undefined,
      is_asm_row: true,
      assembly_id: 'A1',
      unit: '套',
    };
    const { actions } = boot([asm], { ASM_A1: ['13', '14', '15'] });
    expect(await actions.onRemoveSelected()).toBe(true);
    expect(removeBatchesMock).toHaveBeenCalledWith('N1', {
      batch_ids: ['13', '14', '15'],
      version: 7,
    });
  });

  it('行 id 不在展开表里时回落该行自带的 batch_ids（不静默丢批次）', async () => {
    const row = partRow('P:-:P1', ['10', '11']);
    const { actions } = boot([row], {});
    await actions.onRemoveSelected();
    expect(removeBatchesMock.mock.calls[0]![1]).toMatchObject({ batch_ids: ['10', '11'] });
  });

  it('确认文案同时说出两个口径：N 个零件/装配件、M 个批次', async () => {
    const a = partRow('P:-:PA', ['10', '11']);
    const b = partRow('P:-:PB', ['12']);
    const { actions } = boot([a, b], { [a.id]: ['10', '11'], [b.id]: ['12'] });
    await actions.onRemoveSelected();
    // confirmDangerous(message, title, opts) 的入参顺序：正文在前、标题在后
    expect(confirmMock).toHaveBeenCalledWith(
      '确认移除选中的 2 个零件/装配件（含 3 个批次）？',
      '移除零件/装配件',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' },
    );
  });

  it('用户取消（confirm 抛）→ 零请求、勾选态不动', async () => {
    confirmMock.mockRejectedValue(new Error('cancel'));
    const row = partRow('P:-:P1', ['10']);
    const { actions, bindings } = boot([row], { [row.id]: ['10'] });
    expect(await actions.onRemoveSelected()).toBe(false);
    expect(removeBatchesMock).not.toHaveBeenCalled();
    expect(bindings.clearSelection).not.toHaveBeenCalled();
  });
});

describe('onRemoveSelected 移除成功后清勾选态', () => {
  it('clearSelection 被调（否则 reserve-selection 留下已删行的残影）', async () => {
    const row = partRow('P:-:P1', ['10']);
    const { actions, bindings } = boot([row], { [row.id]: ['10'] });
    await actions.onRemoveSelected();
    expect(bindings.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('请求失败 → 不清勾选态（行还在，用户可以直接重试）', async () => {
    removeBatchesMock.mockRejectedValue(new Error('版本已过期'));
    const row = partRow('P:-:P1', ['10']);
    const { actions, bindings } = boot([row], { [row.id]: ['10'] });
    expect(await actions.onRemoveSelected()).toBe(false);
    expect(ElMessage.error).toHaveBeenCalledWith('版本已过期');
    expect(bindings.setSelectedRows).not.toHaveBeenCalled();
    expect(bindings.clearSelection).not.toHaveBeenCalled();
  });
});