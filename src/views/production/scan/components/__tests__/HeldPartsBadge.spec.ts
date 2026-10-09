// @vitest-environment happy-dom
// src/views/production/scan/components/__tests__/HeldPartsBadge.spec.ts
//
// 报工台顶栏「已持有 N 件」徽章的回归保护，重点是 2026-10-10 的两处改动：
//
//   1. **数据源换成 query**：徽章与放回页 / 送检页共用同一条 `qk.scanHeld`（同一组
//      params ⇒ 同一 cache identity）。这条把「同屏只发一次请求」钉成断言 —— 此前徽章与
//      页面各自 `fetchScanHeld(workerId, { limit: 200 })`，同一屏对同一个工人发 2 次
//      同参请求且切页零缓存。
//   2. **`useScanBus` 模块级信号换成 `autoOpenToken` 计数器 prop**。自动开抽屉是**写侧
//      信息**（invalidate 只说「数据过期了」，不说「刚刚有人提交成功」），用数据侧的
//      近似（watch dataUpdatedAt 之类）在暖缓存进页面时会失准，故由页面在写成功后自增。
//      这三条把自增时机钉死：初始 0 不开、变 1 开、再变 2 还开、`autoOpenOnChange=false`
//      时自增也不开。
//
// 另守一条易静默坏掉的契约：徽章的错误**不再弹 toast**（`silent: true`），而是渲染进抽屉
// 内的 `errorMsg` 行 —— 与页面上的 hook 共用同一条 query key 时，两边都弹会在同一次失败上
// 弹两条一模一样的 toast。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

const h = vi.hoisted(() => ({
  fetchScanHeld: vi.fn(),
}));

vi.mock('@/api/productionScan', () => ({ fetchScanHeld: h.fetchScanHeld }));
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import HeldPartsBadge from '../HeldPartsBadge.vue';

const WORKER = '190000000000900';

/** 后端 `ScanListItem` 的合法 17 字段行。 */
function validRow(id: string) {
  return {
    id,
    serial_no: `SN-${id}`,
    name: '法兰盘',
    drawing_no: 'DWG-1',
    quantity: 2,
    is_urgent: false,
    planned_delivery_date: '2026-10-20',
    system_delivery_date: '2026-12-31',
    process_chain_id: null,
    has_process_chain: false,
    chain_state: 'NONE',
    chain_next_process_id: '0',
    chain_next_process_name: null,
    chain_current_process_name: null,
    batch_id: `19000000000001${id}`,
    batch_version: 1,
    location: null,
  };
}

function envelope(ids: string[]) {
  return { items: ids.map(validRow), total: ids.length, limit: 200, offset: 0 };
}

const stubs = {
  'el-button': {
    name: 'ElButtonStub',
    props: ['disabled', 'type', 'plain'],
    template: '<button><slot /></button>',
  },
  'el-badge': { name: 'ElBadgeStub', template: '<div class="mock-badge"><slot /></div>' },
  'el-drawer': {
    name: 'ElDrawerStub',
    props: ['modelValue'],
    template: '<div v-if="modelValue" class="mock-drawer"><slot /></div>',
  },
  'el-icon': { name: 'ElIconStub', template: '<i><slot /></i>' },
};

function freshQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
}

interface BadgeProps {
  workerId: string;
  autoOpenOnChange?: boolean;
  autoOpenToken?: number;
}

async function mountBadge(props: BadgeProps) {
  const w = mount(HeldPartsBadge, {
    props,
    global: { stubs, plugins: [[VueQueryPlugin, { queryClient: freshQueryClient() }]] },
  });
  await nextTick();
  await nextTick();
  return w;
}

beforeEach(() => {
  h.fetchScanHeld.mockReset().mockResolvedValue(envelope(['190000000000101']));
});

describe('HeldPartsBadge / 数据源与计数', () => {
  it('B1：徽章按 `{ workerId, limit: 200 }` 这组 params 发请求 —— 与三页同参 ⇒ 必然同键', async () => {
    const a = await mountBadge({ workerId: WORKER });
    const b = await mountBadge({ workerId: WORKER });
    await nextTick();
    // 本用例**不守去重**：两个实例各挂一份 QueryClient（本用例的隔离手段），cache 本来就
    // 不共享。「同一 QueryClient 下两个实例去重成 1 次请求」由 useScanQuery.spec.ts 的 Q1 守。
    // 这里守的是「徽章发的 params 与三页完全一致」，即它们的 query key 必然相同。
    expect(h.fetchScanHeld).toHaveBeenCalled();
    expect(h.fetchScanHeld.mock.calls[0]![0]).toEqual({ workerId: WORKER, limit: 200 });
    a.unmount();
    b.unmount();
  });

  it('B2：limit 恒为 200（后端 clamp 上限）—— 不传时后端默认只返 50 条，徽章会静默少报', async () => {
    const w = await mountBadge({ workerId: WORKER });
    expect(h.fetchScanHeld.mock.calls[0]![0]).toMatchObject({ limit: 200 });
    w.unmount();
  });

  it('B3：计数取 items.length，与信封 total 一起渲染「已加载 N 件（共 M 件）」', async () => {
    h.fetchScanHeld.mockResolvedValue({
      ...envelope(['190000000000101', '190000000000102']),
      total: 9,
    });
    const w = await mountBadge({ workerId: WORKER, autoOpenOnChange: true, autoOpenToken: 0 });
    await w.setProps({ autoOpenToken: 1 });
    expect(w.find('.mock-drawer').exists(), '抽屉未打开，计数行渲染不出来').toBe(true);
    expect(w.text()).toContain('已加载 2 件');
    expect(w.text()).toContain('共 9 件');
    w.unmount();
  });

  it('B4：workerId 为空 ⇒ 零请求（后端 worker_id 必填且只吃 JSON 字符串，闸门是必需的）', async () => {
    const w = await mountBadge({ workerId: '' });
    await nextTick();
    expect(h.fetchScanHeld).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe('HeldPartsBadge / autoOpenToken 驱动自动开抽屉', () => {
  it('B5：初始 token 不开抽屉；token 递增触发打开', async () => {
    const w = await mountBadge({ workerId: WORKER, autoOpenOnChange: true, autoOpenToken: 0 });
    expect(w.find('.mock-drawer').exists()).toBe(false);

    await w.setProps({ autoOpenToken: 1 });
    expect(w.find('.mock-drawer').exists()).toBe(true);
    w.unmount();
  });

  it('B6：autoOpenOnChange=false 时 token 递增也不开（徽章可只做计数展示）', async () => {
    const w = await mountBadge({ workerId: WORKER, autoOpenOnChange: false, autoOpenToken: 0 });
    await w.setProps({ autoOpenToken: 1 });
    expect(w.find('.mock-drawer').exists()).toBe(false);
    w.unmount();
  });

  it('B7：token 连续自增每次都触发（一次提交 = 一次自动开）', async () => {
    const w = await mountBadge({ workerId: WORKER, autoOpenOnChange: true, autoOpenToken: 0 });
    await w.setProps({ autoOpenToken: 1 });
    expect(w.find('.mock-drawer').exists()).toBe(true);
    // 关掉再自增：证明触发点挂在 token 变化上，而不是「抽屉曾经打开过」
    await w.setProps({ autoOpenToken: 2 });
    expect(w.find('.mock-drawer').exists()).toBe(true);
    w.unmount();
  });

  it('B8：挂载时 token 已是 3 也不开抽屉 —— watch 不是 immediate，只有「变化」才算一次提交', async () => {
    const w = await mountBadge({ workerId: WORKER, autoOpenOnChange: true, autoOpenToken: 3 });
    expect(w.find('.mock-drawer').exists()).toBe(false);
    await w.setProps({ autoOpenToken: 3 });
    expect(w.find('.mock-drawer').exists()).toBe(false);
    w.unmount();
  });
});

describe('HeldPartsBadge / 错误呈现', () => {
  it('B9：坏响应 ⇒ 抽屉内显示 errorMsg，且不弹 toast（silent，避免与页面上的 hook 重复弹）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.fetchScanHeld.mockRejectedValue(new Error('boom'));
    const w = await mountBadge({ workerId: WORKER });
    await w.setProps({ autoOpenOnChange: true, autoOpenToken: 1 });
    expect(w.find('.mock-drawer').exists()).toBe(true);
    // 非 ZodError 的异常原样透传 message
    expect(w.find('.held-error').text()).toContain('boom');
    consoleError.mockRestore();
    w.unmount();
  });
});

describe('HeldPartsBadge / HeldPartsList 的副信息渲染', () => {
  it('B10：加急 / 交期 / 工序各有值才渲染；没有工序链时副信息整块不出现（不显示假占位）', async () => {
    h.fetchScanHeld.mockResolvedValue({
      items: [
        { ...validRow('201'), is_urgent: true, planned_delivery_date: '2026-11-01' },
        {
          ...validRow('202'),
          planned_delivery_date: '',
          chain_current_process_name: '钻孔',
          chain_next_process_name: null,
        },
        { ...validRow('203'), planned_delivery_date: '' },
      ],
      total: 3,
      limit: 200,
      offset: 0,
    });
    const w = await mountBadge({ workerId: WORKER });
    await w.setProps({ autoOpenOnChange: true, autoOpenToken: 1 });

    const rows = w.findAll('.mock-drawer .held-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('加急');
    expect(rows[0]!.text()).toContain('交期 2026-11-01');
    expect(rows[1]!.text()).toContain('工序 钻孔');
    // 交期空 + 无工序链 ⇒ 副信息整块不渲染（不是渲染一个空的 tag）
    expect(rows[1]!.find('.held-row-sub').exists()).toBe(true);
    expect(rows[2]!.find('.held-row-sub').exists()).toBe(false);
    w.unmount();
  });
});
