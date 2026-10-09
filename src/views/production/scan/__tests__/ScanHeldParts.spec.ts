// @vitest-environment happy-dom
// src/views/production/scan/__tests__/ScanHeldParts.spec.ts
//
// `/scan/held`（「查看持有」独立页，2026-10-11 从操作选择页的对话框迁出）的回归守卫。
//
// 迁出的理由：取件 / 放回 / 送检三个动作都进独立页，「我手上有什么」却是一层盖住
// 整屏的对话框，形态不一致。本页与三页同款顶栏 + 同款 `PartRowCard` + 同款三列网格。
//
// 这批用例守三件容易静默坏掉的事：
//   1. **params 与徽章 / 三页逐字一致**（`{ workerId, limit: 200 }`）⇒ 落在同一条
//      `qk.scanHeld` 上。写成另一个形状会让 query key 分裂、同屏发两次完全相同的
//      请求 —— 症状只是「网络面板里两条一样的 GET」，没有任何报错。
//   2. **只读**：本页没有任何选中态 / 写操作。误接上一条流转路径就会让工人在这个
//      只读页把工件放掉。
//   3. 入口守卫：未扫工牌时打回 `/scan/badge`，不渲染任何列表。
//
// 桩的取舍：与同域 `ScanActionPicker.spec.ts` / `ScanReturnChainFlow.spec.ts` 同款 ——
// `@/api/productionScan` 整模块桩掉、`element-plus` 桩成 `{ ElMessage }`、
// `vue-router` 桩出 `replace`、`PdfViewer` 桩掉（它 import pdfjs-dist）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

const h = vi.hoisted(() => ({
  fetchScanHeld: vi.fn(),
  listPartFilesByOwner: vi.fn(),
  getDownloadUrl: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/productionScan', () => ({ fetchScanHeld: h.fetchScanHeld }));
vi.mock('@/api/assembly', () => ({
  getDownloadUrl: h.getDownloadUrl,
  listPartFilesByOwner: h.listPartFilesByOwner,
}));
vi.mock('element-plus', () => ({ ElMessage: h.ElMessage }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: h.push, replace: h.replace }) }));
vi.mock('@/components/PdfViewer.vue', () => ({
  default: { name: 'PdfViewerStub', template: '<div class="stub-pdf" />' },
}));

import ScanHeldParts from '@/views/production/scan/ScanHeldParts.vue';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';

const WORKER = {
  id: '190000000000009',
  badge_code: 'B1',
  name: '工人甲',
  work_type_id: '190000000000009',
};

/** 一行合法的 `ScanListItem`（17 字段）。 */
function heldRow(id: string, over: Partial<ScanPartRowSchema> = {}): ScanPartRowSchema {
  return {
    id,
    serial_no: `SN-${id}`,
    name: '法兰盘',
    drawing_no: 'DWG-1',
    quantity: 3,
    is_urgent: false,
    planned_delivery_date: '2026-10-20',
    system_delivery_date: null,
    process_chain_id: null,
    has_process_chain: false,
    chain_state: 'NONE',
    chain_next_process_id: '0',
    chain_next_process_name: null,
    chain_current_process_name: null,
    batch_id: `19000000000001${id}`,
    batch_version: 1,
    location: null,
    ...over,
  };
}

function envelope(ids: string[], over: Partial<ScanPartRowSchema> = {}) {
  return {
    items: ids.map((id) => heldRow(id, over)),
    total: ids.length,
    limit: 200,
    offset: 0,
  };
}

const stubs = {
  'el-icon': { template: '<i class="mock-icon"><slot /></i>' },
  'el-tag': { template: '<span class="mock-tag"><slot /></span>' },
  'el-divider': { template: '<hr />' },
  'el-card': { template: '<div class="mock-card"><slot /></div>' },
  'el-button': {
    props: ['disabled', 'type', 'size', 'plain', 'circle', 'loading', 'icon'],
    emits: ['click'],
    // 必须把原生事件透传出去：PartRowCard 的预览按钮是 `@click.stop`，`.stop` 修饰符
    // 跑在组件 vnode 上、拿的是 emit 出来的参数 —— 不透传时它拿到 undefined 直接抛
    // 「Cannot read properties of undefined (reading 'stopPropagation')」。
    template: '<button @click="$emit(\'click\', $event)"><slot /></button>',
  },
  'el-image': { template: '<div class="mock-image" />' },
  'el-dialog': {
    props: ['modelValue'],
    template: '<div v-if="modelValue" class="mock-dialog"><slot /></div>',
  },
  ScrollFabPair: true,
};

function freshQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
}

async function mountPage(): Promise<VueWrapper> {
  const w = mount(ScanHeldParts, {
    global: {
      stubs,
      plugins: [createPinia(), [VueQueryPlugin, { queryClient: freshQueryClient() }]],
    },
  });
  await flushPromises();
  return w;
}

beforeEach(() => {
  localStorage.clear();
  h.fetchScanHeld.mockReset().mockResolvedValue(envelope(['101', '102']));
  h.listPartFilesByOwner.mockReset().mockResolvedValue({ items: [], total: 0 });
  h.getDownloadUrl.mockReset();
  h.replace.mockReset();
  h.push.mockReset();
  h.ElMessage.success.mockReset();
  h.ElMessage.error.mockReset();
  useScanSession().setWorker(WORKER);
});

describe('ScanHeldParts / 数据源与入口守卫', () => {
  it('H1：params 与徽章 / 三页逐字一致（{ workerId, limit: 200 }）⇒ 必然同一条 qk.scanHeld', async () => {
    const w = await mountPage();
    expect(h.fetchScanHeld).toHaveBeenCalledTimes(1);
    expect(h.fetchScanHeld.mock.calls[0]![0]).toEqual({ workerId: WORKER.id, limit: 200 });
    w.unmount();
  });

  it('H2：未扫工牌 ⇒ 打回 /scan/badge，且零请求', async () => {
    useScanSession().setWorker(null);
    const w = await mountPage();
    expect(h.replace).toHaveBeenCalledWith('/scan/badge');
    expect(h.fetchScanHeld).not.toHaveBeenCalled();
    w.unmount();
  });

  it('H3：列表按行渲染（序列号 / 名称 / 数量），计数走信封 total', async () => {
    h.fetchScanHeld.mockResolvedValue({ ...envelope(['101', '102']), total: 9 });
    const w = await mountPage();
    // 列表顺序走客户端排序（`useScanPartsSort`，末位 tie-break 是 id 降序 ⇒ SN-102 在前），
    // 断言按内容而不是按下标。
    const cards = w.findAll('.part-row');
    expect(cards).toHaveLength(2);
    const texts = cards.map((c) => c.text());
    expect(texts.map((t) => t.includes('SN-101') || t.includes('SN-102'))).toEqual([true, true]);
    expect(texts[0]).toContain('法兰盘');
    expect(texts[0]).toContain('× 3');
    // total > 已加载条数 ⇒ 明说被 limit 截断，不谎称是全部
    expect(w.find('.count-tag').text()).toContain('共 9 件');
    expect(w.find('.count-tag').text()).toContain('显示前 2 件');
    w.unmount();
  });

  it('H4：加急 / 系统交期各有值才渲染；无系统交期时 chip 显示 -（不显示假占位 tag）', async () => {
    h.fetchScanHeld.mockResolvedValue({
      items: [
        heldRow('201', { is_urgent: true, system_delivery_date: '2026-11-01' }),
        heldRow('202', { is_urgent: false, system_delivery_date: null }),
      ],
      total: 2,
      limit: 200,
      offset: 0,
    });
    const w = await mountPage();
    const cards = w.findAll('.part-row');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.text()).toContain('加急');
    // chip 按 `utils/deliveryDate` 的口径格式化成 MM/DD 上屏（不是 ISO 原串）
    expect(cards[0]!.text()).toContain('11/01');
    // 无系统交期：不渲染「加急」tag，交期位是 '-'
    expect(cards[1]!.text()).not.toContain('加急');
    expect(cards[1]!.text()).toContain('-');
    w.unmount();
  });

  it('H5：空列表给空态（不给「加载中」），点「返回操作选择」回 /scan/action', async () => {
    h.fetchScanHeld.mockResolvedValue(envelope([]));
    const w = await mountPage();
    expect(w.text()).toContain('您当前没有持有零件');
    expect(w.text()).not.toContain('加载持有零件列表');

    const back = w.findAll('button').find((b) => b.text().includes('返回操作选择'));
    expect(back, '顶栏没有「返回操作选择」按钮').toBeDefined();
    await back!.trigger('click');
    expect(h.replace).toHaveBeenCalledWith('/scan/action');
    w.unmount();
  });
});

// ⛔ 本页是**只读**页：误接一条流转路径，工人就能在这个页把工件放掉 / 送检。
// 断言的是「点卡片不产生任何写请求、也不产生选中态」。
describe('ScanHeldParts / 只读', () => {
  it('H6：点卡片只选中不了 / 不发任何写请求（页面上没有任何写路径）', async () => {
    const scanWorker = h.fetchScanHeld;
    const w = await mountPage();
    await w.findAll('.part-row')[0]!.trigger('click');
    await flushPromises();

    // 请求数不变：点卡片既不重新拉列表，也不打任何写端点
    expect(scanWorker).toHaveBeenCalledTimes(1);
    const cards = w.findAll('.part-row');
    expect(cards[0]!.classes(), '只读页不该出现选中态').not.toContain('is-selected');
    w.unmount();
  });

  it('H7：图纸预览可用（卡片上的预览按钮 → 同一个预览弹窗）', async () => {
    h.fetchScanHeld.mockResolvedValue(envelope(['101']));
    const w = await mountPage();
    expect(w.find('.mock-dialog').exists(), '预览弹窗默认不该打开').toBe(false);
    await w.findAll('.preview-btn')[0]!.trigger('click');
    await flushPromises();
    // 没有图纸 ⇒ 弹窗被自动关掉（并给一句 warning），这一条只验「按钮接上了弹窗」
    expect(h.listPartFilesByOwner).toHaveBeenCalledWith('101', 'DRAWING');
    expect(h.ElMessage.warning).toHaveBeenCalledWith('暂无图纸');
    w.unmount();
  });
});
