// @vitest-environment happy-dom
// src/views/production/scan/__tests__/ScanPickQtyGate.spec.ts
//
// 取件页「扫码 → 数量弹窗」这条闸门的回归守卫。
//
// 为什么单独开一个文件：2026-10-11 起 `QuantityDialog` 统一 `:show-close="false"`
// （见 CLAUDE.md「弹窗关闭权」），三个消费方（取件 / 放回 / 送检）里放回与送检两页
// 各有自己的 spec 钉住关闭后的状态收尾，**取件页一条都没有**。而本页恰恰是那个
// 「× 消失不损失任何能力」的调用方，下面两条用例把这个认知钉住。
//
// 取件页关弹窗有**两条各自独立成立**的路径（都已实测：任摘一条，另一条仍关得掉）：
//   ① `v-model="showQtyDialog"` 收到组件 emit 的 `update:modelValue(false)`；
//   ② `@cancel="showQtyDialog = false"`。
// 右上角 × 做的事与这两条**逐字相同**（它经 v-model 把同一个 ref 置 false），
// 所以 `:show-close="false"` 在本页只是拿掉一个冗余副本，不影响关闭能力。
// ⚠️ 由此可知这两条用例守的是**行为**（footer 取消关得掉、且不清选中态），
// **不是**某一条具体绑定 —— 单独摘掉①或②本 spec 仍绿，两条同时摘掉才红。
// 组件侧的 `:show-close="false"` 由 `QuantityDialog.spec.ts` 的 Q7 守，不在此重复。
//
// 桩的取舍与同域 `ScanInspectParts.spec.ts` 同款：`@/api/productionScan` 整模块桩掉、
// `element-plus` 桩成 `{ ElMessage }`、`vue-router` 桩出 `replace`、
// `@/composables/useBarcodeScanner` 桩掉并把注册的 handler 抓出来（扫码是本页点选之外
// 的第二个入口，也是打开数量弹窗的那一步）、`@/api/assembly` 桩掉（预览弹窗的取文件
// 与下载闸门走它）、`PdfViewer` 桩掉（它 import pdfjs-dist）。
// 另挂 pinia —— 图纸预览弹窗的「下载文件」闸门走 `usePermissions()` → `useAuthStore()`。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

const h = vi.hoisted(() => ({
  fetchScanPickable: vi.fn(),
  pickUpBatch: vi.fn(),
  scanHandlers: [] as ((code: string) => void)[],
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/productionScan', () => ({
  fetchScanPickable: h.fetchScanPickable,
  pickUpBatch: h.pickUpBatch,
}));
vi.mock('@/api/assembly', () => ({
  listPartFilesByOwner: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getDownloadUrl: vi.fn(),
}));
vi.mock('element-plus', () => ({ ElMessage: h.ElMessage }));
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
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

import ScanPickParts from '../ScanPickParts.vue';
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
    location: null,
    ...over,
  };
}

const stubs = {
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
  'el-divider': { template: '<hr />' },
  'el-card': { name: 'ElCardStub', template: '<div class="mock-card"><slot /></div>' },
  'el-button': {
    name: 'ElButtonStub',
    props: { disabled: Boolean },
    emits: ['click'],
    template:
      '<button :data-disabled="String(disabled)" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  'el-image': { template: '<div />' },
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue'],
    // 必须渲染 footer 槽：数量弹窗的「取消 / 确定」两键都在 footer 里，
    // 本 spec 断言的正是这两键构成的关闭出口。
    template: '<div v-if="modelValue" class="mock-dialog"><slot /><slot name="footer" /></div>',
  },
  HeldPartsBadge: { name: 'HeldPartsBadgeStub', template: '<div />' },
  ScrollFabPair: { name: 'ScrollFabPairStub', template: '<div />' },
  BatchPickerDialog: { name: 'BatchPickerDialogStub', template: '<div />' },
  DeliveryDateChip: { name: 'DeliveryDateChipStub', template: '<span />' },
  PartDrawingPreviewDialog: true,
};

async function mountPage(items: ScanPartRowSchema[]): Promise<VueWrapper> {
  h.fetchScanPickable.mockResolvedValue({ items, total: items.length, limit: 200, offset: 0 });
  const w = mount(ScanPickParts, {
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

/** 触发一次扫码（走 useBarcodeScanner 桩注册的 handler）。 */
async function scan(w: VueWrapper, code: string): Promise<void> {
  const last = h.scanHandlers.at(-1);
  if (!last) throw new Error('页面没有注册扫码 handler');
  last(code);
  await flushPromises();
}

/** 真实 QuantityDialog 里的 footer「取消」（弹窗内唯一键）—— 不是页面确认栏那个。 */
function qtyCancelButton(w: VueWrapper) {
  return w.findAll('button').find((b) => b.text().replace(/\s+/g, '') === '取消')!;
}

beforeEach(() => {
  h.fetchScanPickable.mockReset();
  h.pickUpBatch.mockReset().mockResolvedValue({ batch_id: '190000000000111' });
  h.ElMessage.success.mockReset();
  h.ElMessage.error.mockReset();
  h.ElMessage.warning.mockReset();
  h.ElMessage.info.mockReset();
  h.scanHandlers.length = 0;
  useScanSession().setWorker(WORKER);
});

describe('ScanPickParts / 数量弹窗的关闭权', () => {
  // ⛔ 本页是 `:show-close="false"` 三个消费方里唯一「不损失能力」的那个（文件头），
  // 但它仍是**唯一提交闸门**：关掉弹窗必须不发任何写请求，否则「关一下」就等于领了。
  it('P1：扫到条码开数量弹窗 → footer「取消」能关掉，且不发任何写请求', async () => {
    const w = await mountPage([row()]);
    await scan(w, 'F2256');

    // 扫码命中即停在数量弹窗上，还没提交
    expect(w.find('.mock-dialog').exists(), '扫码命中后必须先选数量再提交').toBe(true);
    expect(h.pickUpBatch).not.toHaveBeenCalled();

    await qtyCancelButton(w).trigger('click');
    await flushPromises();

    expect(w.find('.mock-dialog').exists(), 'footer「取消」必须真的关掉弹窗').toBe(false);
    expect(h.pickUpBatch, '取消不是提交，任何时候都不该发 pick-up').not.toHaveBeenCalled();
    w.unmount();
  });

  // 取件页的确认栏是 `v-if="selectedPart"`（不像送检页还多一道 awaitingScan），
  // 所以关掉弹窗后工人仍在确认栏上、有「取消选择」可走 —— 出路完整，不是死角。
  it('P2：关掉弹窗后选中态与确认栏仍在，「取消选择」能彻底清干净', async () => {
    const w = await mountPage([row()]);
    await scan(w, 'F2256');
    expect(w.find('.mock-dialog').exists()).toBe(true);

    await qtyCancelButton(w).trigger('click');
    await flushPromises();

    const bar = w.find('.confirm-bar');
    expect(bar.exists(), '关掉弹窗不该顺手清掉选中态 —— 确认栏要留着给工人继续操作').toBe(true);
    expect(bar.text()).toContain('F2256');
    // 卡片仍是选中态
    expect(w.findAll('.part-row')[0]!.classes()).toContain('is-selected');

    const cancelSelect = bar
      .findAll('button')
      .find((b) => b.text().replace(/\s+/g, '') === '取消选择');
    expect(cancelSelect, '确认栏里没有「取消选择」按钮').toBeDefined();
    await cancelSelect!.trigger('click');
    await flushPromises();

    expect(w.find('.confirm-bar').exists()).toBe(false);
    expect(w.findAll('.part-row')[0]!.classes()).not.toContain('is-selected');
    expect(h.pickUpBatch).not.toHaveBeenCalled();
    w.unmount();
  });
});
