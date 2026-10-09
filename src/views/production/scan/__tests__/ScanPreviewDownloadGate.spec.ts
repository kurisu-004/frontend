// @vitest-environment happy-dom
// src/views/production/scan/__tests__/ScanPreviewDownloadGate.spec.ts
//
// 报工台三页图纸预览弹窗的「下载文件」按钮角色闸门（2026-10-11 新增）。
//
// 背景：后端把 part_file 的**列表** `GET /part-files` 与**内容** `GET /part-files/{id}/content`
// 对 SHELF_ACCOUNT 放开了（工控机的图纸预览打的就是这两条），但 `GET /part-files/{id}/url`
// **刻意没放开**（回的是 COS 预签直链，1 小时有效、可外传）。三页的预览弹窗里都有
// 「下载文件」按钮走的就是 `/url` ⇒ 不挂闸门就是「可见但必 403」，正是
// `utils/partsPermissions` 文件头警告的反模式。
//
// 这条 spec 守的是**接线**（v-if 挂在模板上 + 守卫在 `downloadPreview` 函数体里），
// 纯函数的角色表由 `utils/__tests__/partsPermissions.spec.ts` 守。两层都要：
// 纯函数对了但忘了接 v-if ⇒ 按钮照常显示；v-if 挂上但函数体没守卫 ⇒ 任何还能触达
// `downloadPreview` 的路径仍会发一次必 403 的请求。
//
// 场景取「非 PDF 图纸（STEP）」：PDF / 图片走 content 正常预览、根本没有下载按钮，
// 只有非 PDF 才让「下载 vs 不可见」这条差异可断言。
//
// 同一条闸门还管着**提示文案**（`.non-pdf-hint`）：文案与按钮必须同进同出。只藏按钮
// 不改文案，被拒的角色会读到一句「请下载后查看」—— 指向一个不在屏幕上的按钮。
//
// mount 的两个前提（缺一个就整页 setup 失败、不是只少一个按钮）：
//   - pinia：`usePermissions()` → `useAuthStore()`；
//   - VueQueryPlugin + QueryClient：auth store 在 setup 第一行就 `useQueryClient()`。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { PartFileItem } from '@/types/part_file';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';

const h = vi.hoisted(() => ({
  fetchScanPickable: vi.fn(),
  fetchScanHeld: vi.fn(),
  getDownloadUrl: vi.fn(),
  listPartFilesByOwner: vi.fn(),
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/productionScan', () => ({
  fetchScanPickable: h.fetchScanPickable,
  fetchScanHeld: h.fetchScanHeld,
}));
vi.mock('@/api/assembly', () => ({
  getDownloadUrl: h.getDownloadUrl,
  listPartFilesByOwner: h.listPartFilesByOwner,
}));
vi.mock('element-plus', () => ({ ElMessage: h.ElMessage }));
vi.mock('@/composables/useBarcodeScanner', () => ({
  useBarcodeScanner: () => ({ onScan: () => () => {} }),
}));
// PdfViewer 会经 `@/utils/pdfjs` 拉 pdfjs-dist（含 `?url` 的 worker 资源），
// 单测环境解析不了那个 import。与放回分流 spec 同款处理：整组件桩掉。
vi.mock('@/components/PdfViewer.vue', () => ({
  default: { name: 'PdfViewerStub', template: '<div class="stub-pdf" />' },
}));

import ScanPickParts from '@/views/production/scan/ScanPickParts.vue';
import ScanInspectParts from '@/views/production/scan/ScanInspectParts.vue';
import ScanReturnParts from '@/views/production/scan/ScanReturnParts.vue';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import type { Worker } from '@/types/worker';

/** 一个 STEP 图纸（非 PDF / 非图片）⇒ 预览弹窗只给「下载文件」这一个出口。 */
const STEP_FILE = {
  id: '9001',
  owner_kind: 'PART',
  owner_id: '1',
  kind: 'DRAWING',
  file_type: 'application/step',
  original_filename: 'FLANGE.step',
  object_key: 'x/FLANGE.step',
  size_bytes: 1024,
  uploaded_by: null,
  uploaded_at: '2026-10-10T00:00:00Z',
} as unknown as PartFileItem;

function partRow(): ScanPartRowSchema {
  return {
    id: '101',
    serial_no: 'SN-101',
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
    batch_id: '1900000000000101',
    batch_version: 1,
    location: null,
  };
}

function envelope(items: ScanPartRowSchema[]) {
  return { items, total: items.length, limit: 200, offset: 0 };
}

const worker: Worker = {
  id: '190000000000009',
  version: 1,
  badge_code: 'B1',
  name: '工人甲',
  work_type_id: '190000000000009',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

/** 预置登录态：auth store 的角色集合来自 `/iam/me` 带回来的 `user.roles`。 */
function seedSession(roles: string[]): void {
  localStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'tok-1',
      refresh_token: null,
      user: {
        id: 'u1',
        username: 'hmi-1',
        full_name: '工位 1',
        is_active: true,
        roles,
        shelf_ids: ['8800000000001'],
        menus: [],
      },
    }),
  );
}

const stubs = {
  'el-icon': { template: '<i><slot /></i>' },
  'el-tag': { template: '<span><slot /></span>' },
  'el-card': { template: '<div><slot /></div>' },
  'el-button': {
    props: ['type', 'size', 'text', 'loading', 'link', 'plain'],
    emits: ['click'],
    // 必须把原生事件透传出去：三页模板里是 `@click.stop`，`.stop` 修饰符跑在组件
    // vnode 上、拿的是 emit 出来的参数 —— 不透传时它拿到 undefined 直接抛
    // 「Cannot read properties of undefined (reading 'stopPropagation')」。
    template:
      '<button :class="[\'mock-btn\', $attrs.class]" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  'el-dialog': {
    props: ['modelValue'],
    template: '<div v-if="modelValue" class="mock-dialog"><slot /></div>',
  },
  'el-drawer': { props: ['modelValue'], template: '<div><slot /></div>' },
  PdfViewer: true,
  HeldPartsBadge: true,
  ScrollFabPair: true,
  QuantityDialog: true,
  BatchPickerDialog: true,
  DeliveryDateChip: true,
  RefillTakenDialog: true,
  ProcessPickerDialog: true,
};

// 三页同款预览弹窗、同款按钮、同款闸门 —— 逐页各跑一遍，别让「只改了两页」活下来。
const PAGES: [string, unknown][] = [
  ['取件页', ScanPickParts],
  ['放回页', ScanReturnParts],
  ['送检页', ScanInspectParts],
];

async function mountPage(comp: unknown): Promise<VueWrapper> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  const w = mount(comp as never, {
    global: { stubs, plugins: [createPinia(), [VueQueryPlugin, { queryClient: qc }]] },
  });
  await flushPromises();
  return w;
}

/** 点第一张卡的「预览」按钮，让弹窗按 STEP 文件的分支渲染（非 PDF ⇒ 只剩下载出口）。 */
async function openStepPreview(w: VueWrapper): Promise<void> {
  const btn = w.findAll('.preview-btn')[0];
  expect(btn, '没找到预览按钮').toBeTruthy();
  await btn!.trigger('click');
  await flushPromises();
}

function downloadButtons(w: VueWrapper): { trigger: (ev: string) => Promise<unknown> }[] {
  return w.findAll('.mock-dialog .mock-btn').filter((b) => b.text().includes('下载文件'));
}

beforeEach(() => {
  localStorage.clear();
  h.listPartFilesByOwner.mockReset().mockResolvedValue({ items: [STEP_FILE], total: 1 });
  h.getDownloadUrl.mockReset().mockResolvedValue('https://cos.example/presigned');
  h.fetchScanPickable.mockReset().mockResolvedValue(envelope([partRow()]));
  h.fetchScanHeld.mockReset().mockResolvedValue(envelope([partRow()]));
  useScanSession().setWorker(worker);
});

describe.each(PAGES)('%s：预览弹窗的「下载文件」按钮闸门', (_name, comp) => {
  it('D1：纯 SHELF_ACCOUNT（工控机）看不到下载按钮 —— 后端 /url 不放行这个角色', async () => {
    seedSession(['SHELF_ACCOUNT']);
    const w = await mountPage(comp);
    await openStepPreview(w);
    // 非 PDF 分支的下载按钮是「唯一直出路」的那一个
    expect(w.find('.mock-dialog').exists(), '预览弹窗未打开').toBe(true);
    expect(downloadButtons(w)).toHaveLength(0);
    // 提示文案与按钮**共用同一道闸门**：拿不到下载入口就不能读到「请下载后查看」——
    // 那是指向一个不在屏幕上的按钮的死胡同。只藏按钮不改文案，这里就会红。
    const hint = w.find('.mock-dialog .non-pdf-hint').text();
    expect(hint).toContain('请联系管理员');
    expect(hint).not.toContain('请下载后查看');
    w.unmount();
  });

  it('D2：MANAGER 能看到下载按钮，且点下去真的发起 getDownloadUrl', async () => {
    seedSession(['MANAGER', 'SHELF_ACCOUNT']);
    const w = await mountPage(comp);
    await openStepPreview(w);
    const btns = downloadButtons(w);
    expect(btns, '放行角色应看到下载按钮').toHaveLength(1);
    // 放行角色的文案仍是「请下载后查看」（闸门是按角色切，不是把所有文案都改口）
    expect(w.find('.mock-dialog .non-pdf-hint').text()).toContain('请下载后查看');
    await btns[0]!.trigger('click');
    await flushPromises();
    expect(h.getDownloadUrl).toHaveBeenCalledWith('9001');
    w.unmount();
  });

  it('D3：SHELF_ACCOUNT 点不到（函数体同守卫）⇒ 一次 /url 请求都不发', async () => {
    // 按钮已被 v-if 藏掉，这里直接拿实例上的处理函数模拟「任何仍能触达 downloadPreview
    // 的路径」：只藏按钮而不守函数体的话，这里会发一次必 403 的 getDownloadUrl。
    seedSession(['SHELF_ACCOUNT']);
    const w = await mountPage(comp);
    await openStepPreview(w);
    const vm = w.vm as unknown as { downloadPreview: () => Promise<void> };
    await vm.downloadPreview();
    expect(h.getDownloadUrl).not.toHaveBeenCalled();
    w.unmount();
  });
});
