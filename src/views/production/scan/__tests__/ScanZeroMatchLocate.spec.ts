// @vitest-environment happy-dom
// src/views/production/scan/__tests__/ScanZeroMatchLocate.spec.ts
//
// ⭐ **本次 bug 的接线守卫**：报工台三页「扫到 0 匹配」的兜底出口。
//
// 背景：工人一体机账号（后端角色 `SHELF_ACCOUNT`）在报工台扫到**别的工人手上 /
// 别的工序**的序列号时，旧兜底走 `src/utils/scanHelpers.ts::findPartBySerialAndPrompt`
// → `GET /api/v2/parts/by-serial/{serial_no}`，而那条端点的后端闸门是
// `[Manager, Clerk, Inspector, CncProgrammer]`、**不含 `SHELF_ACCOUNT`** ⇒ 一体机账号
// 恒 403，现场表现为「扫了没反应 + 一句看不懂的报错」。报工台自有的 8 个端点则全部
// 放行 `SHELF_ACCOUNT`。现在兜底改接 `GET /api/v2/prod/scan/locate`（扫码找件诊断）。
//
// 三页都接的理由（别只改一页）：取件页的 0 匹配还可能是「件不在**本工种**的候选池里」
// —— locate 诊断恰恰就是用来回答「那它在谁手上 / 什么状态」的，所以放回页与送检页
// 的 0 匹配同样需要它（否则工人扫到自己手上的件却看不到任何反馈）。
//
// 这三条用例守两件**改错了也不会立刻报错**的事：
//   1. 0 匹配真的打开了 LocateDialog（而不是又落回某个别的提示）；
//   2. `getPartBySerial` **零调用** —— 这一条是旧路径的守门：谁把
//      `findPartBySerialAndPrompt` 加回 `else` 分支（哪怕只是「locate 失败时再试一下」
//      这种看起来人道的兜底），这里都会当场红，因为那条端点在一体机账号上必然 403。
//
// 为什么三页写在一个文件里：三条用例守的是**同一条兜底链**在三个调用点上的接线，
// 拆成三个文件会让「改了一页忘了另外两页」这件事没有对照面。
//
// 桩法：`@/api/productionScan` / `@/api/parts` 整模块桩掉（前者是三页的列表源与写
// 路径，后者是旧兜底经 `@/utils/scanHelpers` 打到的 `getPartBySerial`）；`element-plus`
// 桩成 `{ ElMessage }`；`vue-router` 桩出 `replace`；`@/composables/useBarcodeScanner`
// 桩掉并把注册的 handler 抓出来（扫码是三页点选之外的第二个入口）；`LocateDialog` 桩成
// 一个把 `code` 透出成 data-* 的空壳（本文件守的是「页面有没有打开它、把哪个条码交给
// 它」，弹窗内部行为由同目录 `LocateDialog.spec.ts` 守）；其余域内弹窗与预览桩掉
// （图纸预览会 import pdfjs）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

const m = vi.hoisted(() => ({
  fetchScanPickable: vi.fn(),
  fetchScanHeld: vi.fn(),
  fetchScanLocate: vi.fn(),
  pickUpBatch: vi.fn(),
  scanWorker: vi.fn(),
  takeOverBatch: vi.fn(),
  receiveFromOutsource: vi.fn(),
  findWorkerByBadge: vi.fn(),
  getPartBySerial: vi.fn(),
  replace: vi.fn(),
  scanHandlers: [] as ((code: string) => void)[],
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/productionScan', () => ({
  fetchScanPickable: m.fetchScanPickable,
  fetchScanHeld: m.fetchScanHeld,
  fetchScanLocate: m.fetchScanLocate,
  pickUpBatch: m.pickUpBatch,
  scanWorker: m.scanWorker,
  takeOverBatch: m.takeOverBatch,
  receiveFromOutsource: m.receiveFromOutsource,
  findWorkerByBadge: m.findWorkerByBadge,
}));
vi.mock('@/api/parts', () => ({ getPartBySerial: m.getPartBySerial }));
vi.mock('@/api/assembly', () => ({ getDownloadUrl: vi.fn() }));
vi.mock('@/api/files/objects', () => ({
  listPartFilesByOwner: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  fetchPartFileContent: vi.fn(),
}));
vi.mock('element-plus', () => ({ ElMessage: m.ElMessage }));
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: m.replace, push: vi.fn() }) }));
vi.mock('@/composables/useBarcodeScanner', () => ({
  useBarcodeScanner: () => ({
    onScan: (fn: (code: string) => void) => {
      m.scanHandlers.push(fn);
      return () => {};
    },
  }),
}));
vi.mock('@/components/PdfViewer.vue', () => ({
  default: { name: 'PdfViewerStub', template: '<div class="stub-pdf" />' },
}));

import ScanPickParts from '../ScanPickParts.vue';
import ScanReturnParts from '../ScanReturnParts.vue';
import ScanInspectParts from '../ScanInspectParts.vue';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';

const WORKER = {
  id: '190000000000009',
  badge_code: 'W-001',
  name: '张三',
  work_type_id: '190000000000010',
};

/** 一行合法列表行（与三页各自的既有 spec 同款 shape）。 */
function row(over: Partial<ScanPartRowSchema> = {}): ScanPartRowSchema {
  return {
    id: '190000000000101',
    serial_no: 'F2256',
    name: '法兰盘',
    drawing_no: 'DWG-1',
    quantity: 2,
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

/** LocateDialog 的空壳：把 `code` 透出成 data-*，让「有没有打开、交给它哪个条码」可断言。 */
const LocateDialogStub = defineComponent({
  name: 'LocateDialog',
  props: ['modelValue', 'code', 'worker'],
  template: '<div v-if="modelValue" class="mock-locate-dialog" :data-code="code" />',
});

const stubs = {
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
  'el-divider': { template: '<hr />' },
  'el-card': { name: 'ElCardStub', template: '<div class="mock-card"><slot /></div>' },
  'el-button': {
    name: 'ElButtonStub',
    props: { disabled: Boolean },
    emits: ['click'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  'el-image': { template: '<div />' },
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue'],
    template: '<div v-if="modelValue" class="mock-dialog"><slot /><slot name="footer" /></div>',
  },
  LocateDialog: LocateDialogStub,
  HeldPartsBadge: { name: 'HeldPartsBadgeStub', template: '<div />' },
  ScrollFabPair: { name: 'ScrollFabPairStub', template: '<div />' },
  BatchPickerDialog: { name: 'BatchPickerDialogStub', template: '<div />' },
  RefillTakenDialog: { name: 'RefillTakenDialogStub', template: '<div />' },
  DeliveryDateChip: { name: 'DeliveryDateChipStub', template: '<span />' },
  PartDrawingPreviewDialog: true,
  QuantityDialog: true,
  ProcessPickerDialog: true,
};

async function mountPage(page: unknown, items: ScanPartRowSchema[]): Promise<VueWrapper> {
  const envelope = { items, total: items.length, limit: 200, offset: 0 };
  m.fetchScanPickable.mockResolvedValue(envelope);
  m.fetchScanHeld.mockResolvedValue(envelope);
  const w = mount(page as never, {
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
  const last = m.scanHandlers.at(-1);
  if (!last) throw new Error('页面没有注册扫码 handler');
  last(code);
  await flushPromises();
}

beforeEach(() => {
  m.fetchScanPickable.mockReset();
  m.fetchScanHeld.mockReset();
  m.fetchScanLocate.mockReset().mockResolvedValue({ part: {}, batches: [] });
  m.getPartBySerial.mockReset();
  m.replace.mockReset();
  m.scanHandlers.length = 0;
  m.ElMessage.success.mockReset();
  m.ElMessage.error.mockReset();
  m.ElMessage.warning.mockReset();
  useScanSession().setWorker(WORKER);
});

/** 三页共用的断言体：扫一个**不在列表里**的条码 ⇒ 打开 LocateDialog，且旧路径零调用。 */
async function expectZeroMatchOpensLocate(
  page: unknown,
  items: ScanPartRowSchema[],
): Promise<void> {
  const w = await mountPage(page, items);
  await scan(w, 'F-NOT-IN-LIST');

  const dialog = w.find('.mock-locate-dialog');
  expect(dialog.exists(), '扫到 0 匹配必须打开扫码找件诊断弹窗').toBe(true);
  expect(dialog.attributes('data-code'), '弹窗拿到的是工人扫进来的那个条码').toBe('F-NOT-IN-LIST');
  expect(
    m.getPartBySerial,
    '旧兜底 GET /parts/by-serial/{sn} 的后端闸门不含 SHELF_ACCOUNT，一体机账号恒 403',
  ).not.toHaveBeenCalled();
  w.unmount();
}

describe('报工台三页 / 扫到 0 匹配的兜底出口', () => {
  it('Z1：取件页 0 匹配 → 打开 LocateDialog，getPartBySerial 零调用', async () => {
    await expectZeroMatchOpensLocate(ScanPickParts, [row()]);
  });

  it('Z2：放回页 0 匹配 → 打开 LocateDialog，getPartBySerial 零调用', async () => {
    await expectZeroMatchOpensLocate(ScanReturnParts, [row()]);
  });

  it('Z3：送检页 0 匹配 → 打开 LocateDialog，getPartBySerial 零调用', async () => {
    await expectZeroMatchOpensLocate(ScanInspectParts, [row()]);
  });
});
