// src/views/com/delivery/__tests__/useDeliveryScanSubmission.spec.ts
//
// 2026-10-08：扫码建单契约整体重做后的守卫。
//
// 旧契约（4 outcome 包装 + 候选弹窗 + 提交前批量过检弹窗）整体下线；新契约：
//   1. `GET /com/delivery/note/scan/{serial_no}` 是**纯读**端点 —— 扫码只弹三层树，
//      不建单；建单发生在用户在树对话框里确认数量后的 `POST /scan`；
//   2. `POST /scan` 的响应含拆批后的完整详情 ⇒ 就地替换草稿看板那张卡；
//   3. `POST /{id}/submit` 只回单据 id（闸门收敛在服务端），没有候选分流。
//
// 覆盖：防抖 / inflight 守卫 / 扫码取树成功与错误分流 / 入单提交 / 草稿提交。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

vi.mock('@/api/com/deliveryNote', () => ({
  getDeliveryScanTree: vi.fn(),
  submitDeliveryEntries: vi.fn(),
  getNote: vi.fn(),
  submitNote: vi.fn(),
}));

// vitest 跑在 node 下，element-plus 的 ElMessage 会访问 document —— 整体 stub。
vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  ElMessageBox: {
    confirm: vi.fn(),
  },
}));

// composable 内部已经用上 useMutation（扫码取树 / 入单提交），需要 vue-query 的注入上下文。
const app = createApp({ render: () => null });
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient: new QueryClient() });
setActivePinia(app.config.globalProperties.$pinia);
/** 在 app 注入上下文里跑一段 setup 体（vue-query hook 的硬要求）。 */
function inSetup<T>(fn: () => T): T {
  return app.runWithContext(fn);
}

const {
  getDeliveryScanTree,
  submitDeliveryEntries,
  getNote,
  submitNote,
} = await import('@/api/com/deliveryNote');
import { useDeliveryScanSubmission } from '../composables/useDeliveryScanSubmission';
import { ApiError } from '@/api/http';
import type { DeliveryScanTreeData } from '../composables/deliveryScanTreeSchema';
import type { DeliveryNoteDetailData, DeliveryNoteItemData } from '../composables/deliveryNoteSchema';

const baseOpts = () => ({
  writeDraftFromScan: vi.fn(),
  refreshDraftDetail: vi.fn().mockResolvedValue(null),
  onDraftRemoved: vi.fn(),
});

function mkTree(over: Partial<DeliveryScanTreeData> = {}): DeliveryScanTreeData {
  return {
    hit_kind: 'PART',
    scanned_serial_no: 'A001',
    draft: { note_id: 'N1', note_no: 'DN-001', version: 5, status: 'DRAFT' },
    assembly: null,
    children: [
      {
        id: 'P1',
        serial_no: 'A001',
        name: 'N1',
        drawing_no: 'D-1',
        status: 'READY_TO_SHIP',
        quantity: 5,
        is_urgent: false,
        system_delivery_date: null,
        customer_name: null,
        version: 1,
        customer_id: 'C1',
        entry_max_quantity: 5,
        children: [],
      },
    ],
    ...over,
  };
}

function mkDetail(noteId: string, version: number): DeliveryNoteDetailData {
  return {
    id: noteId,
    version,
    delivery_note_no: 'DN-001',
    customer_id: 'C1',
    customer_name: null,
    customer_path: null,
    status: 'DRAFT',
    submitted_at: null,
    picked_up_at: null,
    driver_worker_name: null,
    part_count: 1,
    note: null,
    delivery_date: null,
    line_items: [],
  };
}

function mkDraft(noteId: string, version: number): DeliveryNoteItemData {
  const { line_items: _drop, ...rest } = mkDetail(noteId, version);
  void _drop;
  return rest;
}

describe('useDeliveryScanSubmission 扫码取树（纯读，不建单）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('命中 → 打开三层树对话框，且不写草稿（建单要等用户确认数量）', async () => {
    vi.mocked(getDeliveryScanTree).mockResolvedValue(mkTree());
    const opts = baseOpts();
    const sub = inSetup(() => useDeliveryScanSubmission(opts));
    await sub.handleScan('A001');
    await nextTick();
    expect(sub.scanTreeDialogVisible.value).toBe(true);
    expect(sub.scanTree.value?.scanned_serial_no).toBe('A001');
    expect(opts.writeDraftFromScan).not.toHaveBeenCalled();
    expect(submitDeliveryEntries).not.toHaveBeenCalled();
  });

  it('空条码 / 超长条码 → 直接 warning，不发请求', async () => {
    const sub = inSetup(() => useDeliveryScanSubmission(baseOpts()));
    await sub.handleScan('   ');
    expect(getDeliveryScanTree).not.toHaveBeenCalled();
    expect(sub.scanTreeDialogVisible.value).toBe(false);
  });

  it('1.5s 内同码重复扫码 → 吞掉（扫码枪连扫容错）', async () => {
    vi.mocked(getDeliveryScanTree).mockResolvedValue(mkTree());
    const sub = inSetup(() => useDeliveryScanSubmission(baseOpts()));
    await sub.handleScan('A001');
    await sub.handleScan('A001');
    expect(getDeliveryScanTree).toHaveBeenCalledTimes(1);
  });

  it('21421（C 组状态不允许）→ toast，不弹对话框', async () => {
    vi.mocked(getDeliveryScanTree).mockRejectedValue(new ApiError(21421, '批次状态不允许'));
    const { ElMessage } = await import('element-plus');
    const sub = inSetup(() => useDeliveryScanSubmission(baseOpts()));
    await sub.handleScan('X');
    await nextTick();
    expect(sub.scanTreeDialogVisible.value).toBe(false);
    expect(ElMessage.error).toHaveBeenCalledWith('批次状态不允许');
  });

  it('21417（条码未命中）→ toast「无法识别扫码」', async () => {
    vi.mocked(getDeliveryScanTree).mockRejectedValue(new ApiError(21417, 'not found'));
    const { ElMessage } = await import('element-plus');
    const sub = inSetup(() => useDeliveryScanSubmission(baseOpts()));
    await sub.handleScan('X');
    await nextTick();
    expect(sub.scanTreeDialogVisible.value).toBe(false);
    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('无法识别扫码'));
  });
});

describe('useDeliveryScanSubmission 入单提交（POST /scan）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('带 draft.version 做 OCC → 响应就地替换草稿卡 + 关树', async () => {
    vi.mocked(getDeliveryScanTree).mockResolvedValue(mkTree());
    vi.mocked(submitDeliveryEntries).mockResolvedValue(mkDetail('N1', 6));
    const opts = baseOpts();
    const sub = inSetup(() => useDeliveryScanSubmission(opts));
    await sub.handleScan('A001');
    await sub.onSubmitEntries([{ node_kind: 'PART', node_id: 'P1', quantity: 3 }]);
    // mutationFn 会被 vue-query 追加第 2 个参数（mutation context），所以只断言第 1 个
    expect(vi.mocked(submitDeliveryEntries).mock.calls[0]![0]).toEqual({
      serial_no: 'A001',
      note_version: 5,
      entries: [{ node_kind: 'PART', node_id: 'P1', quantity: 3 }],
    });
    expect(opts.writeDraftFromScan).toHaveBeenCalledWith(expect.objectContaining({ id: 'N1' }));
    expect(opts.refreshDraftDetail).toHaveBeenCalledWith('N1');
    expect(sub.scanTreeDialogVisible.value).toBe(false);
  });

  it('无既有草稿（draft=null）→ note_version 传 null，由服务端建单', async () => {
    vi.mocked(getDeliveryScanTree).mockResolvedValue(mkTree({ draft: null }));
    vi.mocked(submitDeliveryEntries).mockResolvedValue(mkDetail('NEW', 1));
    const sub = inSetup(() => useDeliveryScanSubmission(baseOpts()));
    await sub.loadScanTree('A001');
    await sub.onSubmitEntries([{ node_kind: 'PART', node_id: 'P1', quantity: 1 }]);
    expect(vi.mocked(submitDeliveryEntries).mock.calls[0]![0].note_version).toBeNull();
  });

  it('40901（撞并发扫码）→ warning 且保留树对话框让用户重扫', async () => {
    // onSubmitEntries 把错误吞掉（onError 已 toast），不让它变成未处理的 rejection
    vi.mocked(getDeliveryScanTree).mockResolvedValue(mkTree());
    vi.mocked(submitDeliveryEntries).mockRejectedValue(new ApiError(40901, 'version 冲突'));
    const { ElMessage } = await import('element-plus');
    const sub = inSetup(() => useDeliveryScanSubmission(baseOpts()));
    await sub.handleScan('A001');
    await sub.onSubmitEntries([{ node_kind: 'PART', node_id: 'P1', quantity: 1 }]);
    expect(ElMessage.warning).toHaveBeenCalled();
    expect(sub.scanTreeDialogVisible.value).toBe(true);
  });
});

describe('useDeliveryScanSubmission 草稿提交', () => {
  beforeEach(() => vi.clearAllMocks());

  it('提交成功 → onDraftRemoved 清本地态 + 不再有任何候选弹窗', async () => {
    vi.mocked(getNote).mockResolvedValue(mkDetail('N1', 5));
    vi.mocked(submitNote).mockResolvedValue('N1');
    const opts = baseOpts();
    const sub = inSetup(() => useDeliveryScanSubmission(opts));
    await sub.onSubmitDraft(mkDraft('N1', 4));
    await nextTick();
    // 详情是 version 的更新源：listNotes 给的 4 会被刷成 5
    expect(submitNote).toHaveBeenCalledWith('N1', { version: 5 });
    expect(opts.onDraftRemoved).toHaveBeenCalledWith('N1');
    expect(opts.writeDraftFromScan).toHaveBeenCalledWith(expect.objectContaining({ version: 5 }));
  });

  it('提交 21403（版本冲突）→ warning + 刷新详情，不清本地态', async () => {
    vi.mocked(getNote).mockResolvedValue(mkDetail('N1', 5));
    vi.mocked(submitNote).mockRejectedValue(new ApiError(21403, '版本已过期'));
    const { ElMessage } = await import('element-plus');
    const opts = baseOpts();
    const sub = inSetup(() => useDeliveryScanSubmission(opts));
    await sub.onSubmitDraft(mkDraft('N1', 5));
    await nextTick();
    expect(opts.onDraftRemoved).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalled();
    expect(sub.submittingByNote['N1']).toBe(false);
  });
});