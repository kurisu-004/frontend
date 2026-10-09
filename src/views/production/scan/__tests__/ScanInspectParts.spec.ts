// @vitest-environment happy-dom
// src/views/production/scan/__tests__/ScanInspectParts.spec.ts
//
// 送检页（`/scan/inspect`）提交链的回归守卫，重点是 2026-10-11 的「指定送检数量」。
//
// 本页的提交路径只有一条：点选卡片 → 扫到该件条码（`onScanToSelect` →
// `applyScanSelection`）→ **选数量**（`QuantityDialog`，`onQtyConfirm` 才真正提交）。
// 2026-10-11 之前 `applyScanSelection` 直接提交，页面上的 `showQtyDialog` 是恒为 false
// 的死入口（注释写着「worker-scan 不支持部分数量」）；后端 worker-scan 新增可选
// `quantity` 之后，数量步骤被接进正常流程。
//
// 这批用例守三件容易静默坏掉的事：
//   1. **quantity 必须是 JSON 字符串**：后端 `deserialize_i64_opt` 只解 `str`，
//      发 number 拿到的是 HTTP 422 纯文本（不进 `R<T>` 信封，页面只看到一句
//      axios 错误 —— 现场是「点确定没反应」，没有任何业务码可读）。
//   2. **必须先选数量再提交**：跳过 `onQtyConfirm` 直接提交的话，工人在 HMI 上就没有
//      任何机会选数量，部分送检永远做不到；而带 0 / 超量的值会被后端 20111 拒掉。
//   3. **不在本地删行**：部分送检时余量留在工人手上（`location='WORKER'` 不变），
//      那一行仍在列表里、只是数量变小。页面若做「扫掉一行」的本地假定，刷新后
//      会出现一条已经送走的行。
//
// 桩的取舍：与 `ScanReturnChainFlow.spec.ts` 同款 —— `@/api/productionScan` 整模块桩掉、
// `element-plus` 桩成 `{ ElMessage }`、`vue-router` 桩出 `replace`、
// `@/composables/useBarcodeScanner` 桩掉并把注册的 handler 抓出来（扫码是本页点选
// 之外的第二个入口）、`PdfViewer` 桩掉（它 import pdfjs-dist）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, ref, watch } from 'vue';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

const h = vi.hoisted(() => ({
  fetchScanHeld: vi.fn(),
  scanWorker: vi.fn(),
  replace: vi.fn(),
  scanHandlers: [] as ((code: string) => void)[],
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/productionScan', () => ({
  fetchScanHeld: h.fetchScanHeld,
  scanWorker: h.scanWorker,
}));
vi.mock('element-plus', () => ({ ElMessage: h.ElMessage }));
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: h.replace }) }));
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

import ScanInspectParts from '../ScanInspectParts.vue';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';

const WORKER = {
  id: '190000000000009',
  badge_code: 'W-001',
  name: '张三',
  work_type_id: '190000000000010',
};

function row(over: Partial<ScanPartRowSchema> = {}): ScanPartRowSchema {
  return {
    id: '190000000000101',
    serial_no: 'F2256',
    name: '法兰盘',
    drawing_no: 'DWG-1',
    quantity: 6,
    is_urgent: false,
    planned_delivery_date: '2026-10-20',
    system_delivery_date: null,
    process_chain_id: null,
    has_process_chain: false,
    chain_state: 'NONE',
    chain_next_process_id: '0',
    chain_next_process_name: null,
    chain_current_process_name: null,
    batch_id: '190000000000111',
    batch_version: 6,
    location: 'WORKER',
    ...over,
  };
}

function scanOut() {
  return {
    scan: {
      worker_id: WORKER.id,
      part_id: '190000000000102',
      batch_id: '190000000000111',
      event_type: 'WORKER_SCAN_INSPECTED',
      synced_assembly_id: null,
    },
    refill: { taken: [], released: 0 },
  };
}

const stubs = {
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
  'el-divider': { name: 'ElDividerStub', template: '<hr />' },
  'el-card': { name: 'ElCardStub', template: '<div class="mock-card"><slot /></div>' },
  'el-button': {
    name: 'ElButtonStub',
    props: { disabled: Boolean },
    emits: ['click'],
    template:
      '<button :data-disabled="String(disabled)" @click="$emit(\'click\')"><slot /></button>',
  },
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue'],
    template: '<div v-if="modelValue" class="mock-dialog"><slot /></div>',
  },
  // 数量弹窗是提交前的必经一步（2026-10-11），桩自带数量输入 + 确定 / 取消。
  QuantityDialog: defineComponent({
    name: 'QuantityDialogStub',
    props: {
      modelValue: { type: Boolean, default: false },
      max: { type: Number, default: 0 },
      actionLabel: { type: String, default: '' },
    },
    emits: ['confirm', 'cancel'],
    setup(props) {
      // 避开 `vue/no-setup-props-destructure`：在 setup 顶层读 props.max 会拿到失去
      // 响应性的快照（这里只在 watch 里再读一次，所以不受影响）
      const qty = ref((() => props.max)());
      // 打开时取 max（整批），与真实 QuantityDialog 的 watch 同一口径
      watch(
        () => props.modelValue,
        (v) => {
          if (v) qty.value = props.max;
        },
      );
      return { qty };
    },
    template: `<div
      v-if="modelValue"
      class="mock-qty-dialog"
      :data-max="String(max)"
      :data-action="actionLabel"
    >
      <input class="qty-input" v-model.number="qty" />
      <button class="qty-confirm" @click="$emit('confirm', qty)">确定</button>
      <button class="qty-cancel" @click="$emit('cancel')">取消</button>
    </div>`,
  }),
  HeldPartsBadge: { name: 'HeldPartsBadgeStub', template: '<div />' },
  ScrollFabPair: { name: 'ScrollFabPairStub', template: '<div />' },
  BatchPickerDialog: { name: 'BatchPickerDialogStub', template: '<div />' },
  RefillTakenDialog: {
    name: 'RefillTakenDialogStub',
    props: ['modelValue', 'items', 'leadText'],
    template: '<div class="stub-refill-taken" :data-lead="leadText ?? \'\'" />',
  },
};

async function mountPage(items: ScanPartRowSchema[]): Promise<VueWrapper> {
  h.fetchScanHeld.mockResolvedValue({ items, total: items.length, limit: 200, offset: 0 });
  const w = mount(ScanInspectParts, {
    global: {
      stubs,
      plugins: [
        createPinia(),
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }),
          },
        ],
      ],
    },
  });
  await flushPromises();
  return w;
}

/** 触发一次扫码（走 useBarcodeScanner 桩注册的 handler）。 */
async function scan(w: VueWrapper, code: string): Promise<void> {
  const last = h.scanHandlers.at(-1);
  if (!last) throw new Error('页面没有注册扫码 handler');
  last(code);
  await flushPromises();
}

function qtyDialogOpen(w: VueWrapper): boolean {
  return w.find('.mock-qty-dialog').exists();
}

async function confirmQty(w: VueWrapper, qty?: number): Promise<void> {
  const dlg = w.find('.mock-qty-dialog');
  expect(dlg.exists(), '数量弹窗没有打开 —— 正常流程必须先选数量再提交').toBe(true);
  if (qty !== undefined) await dlg.get('.qty-input').setValue(String(qty));
  await dlg.get('.qty-confirm').trigger('click');
  await flushPromises();
}

beforeEach(() => {
  h.fetchScanHeld.mockReset();
  h.scanWorker.mockReset().mockResolvedValue(scanOut());
  h.replace.mockReset();
  h.ElMessage.success.mockReset();
  h.ElMessage.error.mockReset();
  h.ElMessage.warning.mockReset();
  h.scanHandlers.length = 0;
  useScanSession().setWorker(WORKER);
});

describe('ScanInspectParts / 送检数量', () => {
  it('S1：扫到条码 → 弹数量弹窗（上限 = 批次全量），确认后才提交', async () => {
    const w = await mountPage([row()]);
    await scan(w, 'F2256');

    // 扫中后停在数量弹窗上，还没提交
    expect(qtyDialogOpen(w)).toBe(true);
    expect(w.find('.mock-qty-dialog').attributes('data-max')).toBe('6');
    expect(w.find('.mock-qty-dialog').attributes('data-action')).toBe('送检');
    expect(h.scanWorker).not.toHaveBeenCalled();

    // 默认值 = max（整批），不点加减直接确定
    await confirmQty(w);

    expect(h.scanWorker).toHaveBeenCalledTimes(1);
    expect(h.scanWorker).toHaveBeenCalledWith({
      serial_no: 'F2256',
      badge_code: 'W-001',
      event_type: 'INSPECTED',
      batch_id: '190000000000111',
      quantity: '6',
    });
    // 送检不需要下一道工序（后端 INSPECTED 忽略 next_process_id）
    expect(Object.keys(h.scanWorker.mock.calls[0]![0] as object)).not.toContain('next_process_id');
    w.unmount();
  });

  // ⛔ 2026-10-11：quantity 的 wire 形态是 **JSON 字符串**。发 number 得到的是
  // HTTP 422 纯文本（不进业务信封），现场表现是「点确定没反应」—— 没有 code 可读。
  it('S2：部分送检：quantity 发工人选的数（字符串），余量那行不被本地删掉', async () => {
    const w = await mountPage([row({ quantity: 6 })]);
    await scan(w, 'F2256');
    await confirmQty(w, 2);

    expect(h.scanWorker).toHaveBeenCalledTimes(1);
    expect(h.scanWorker.mock.calls[0]![0]).toMatchObject({ quantity: '2' });
    expect(typeof (h.scanWorker.mock.calls[0]![0] as { quantity: unknown }).quantity).toBe(
      'string',
    );

    // 后端把余量留在工人手上（location 不变、只扣数量 + version+1）⇒ 这一行仍在列表里，
    // 行数不变。页面若做「扫掉一行」的本地假定，刷新后会出现一条已送走的行。
    expect(w.findAll('.part-row')).toHaveLength(1);
    w.unmount();
  });

  it('S3：确认栏读的是本次送检数量（selectedQty），不是恒为批次全量', async () => {
    const w = await mountPage([row({ quantity: 6 })]);
    // 点选只进入「待扫码确认」，不提交
    await w.findAll('.part-row')[0]!.trigger('click');
    await flushPromises();
    expect(w.find('.confirm-bar').text()).toContain('送检数量 6');
    expect(qtyDialogOpen(w)).toBe(false);
    expect(h.scanWorker).not.toHaveBeenCalled();

    // 扫码 → 选数量 → 提交成功后确认栏收起
    await scan(w, 'F2256');
    await confirmQty(w, 4);
    expect(h.scanWorker.mock.calls[0]![0]).toMatchObject({ quantity: '4' });
    expect(w.find('.confirm-bar').exists()).toBe(false);
    w.unmount();
  });

  it('S4：取消数量弹窗 = 整次送检作废，不发请求', async () => {
    const w = await mountPage([row()]);
    await scan(w, 'F2256');
    await w.find('.mock-qty-dialog .qty-cancel').trigger('click');
    await flushPromises();

    expect(h.scanWorker).not.toHaveBeenCalled();
    expect(w.find('.confirm-bar').exists()).toBe(false);
    w.unmount();
  });
});
