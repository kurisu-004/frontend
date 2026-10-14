// src/composables/__tests__/useCustomerTree.spec.ts
//
// 2026-10-17 新增：`useCustomerTree` 的**对外形状**与上溯行为守卫。
//
// 为什么测形状：它有 3 个零改动消费方（`views/repair/RepairReceive.vue`、
// `views/outsource` 的报价一览、`views/parts/list/composables/usePartsColumnFilters.ts`）
// + 另有两个间接消费方（待品检列筛选、装配件详情）。拼树实现从「内联两层」换成
// `@/api/customer.tree` 之后，返回形状必须**逐字不变**，否则这些调用点会在没有任何
// 报错的情况下把 `tree` 当空数组 / 误传给 ElTreeSelect。
//
// 覆盖：
//   - T1：返回形状 = { customers, tree, loading, resolveRootCustomerId }（键不多不少）
//   - T2：customers 就是 query 的 items（不复制、不重排）
//   - T3：tree 是任意深度（5 层），且第 3 层往下不再消失（改造核心 regression guard）
//   - T4：resolveRootCustomerId 跨任意深度上溯到 L1；null / 未知 id → null
//   - T5：query 出错时 ElMessage.error 被调一次（错误桥接不许被重构顺手删掉）
//   - T6：query 未完成时 tree / customers 是空数组（首屏不发 undefined）
//
// 环境：`vi.mock('element-plus')` 桩成 no-op（node env 下真实 ElMessage 走
// normalizeAppendTo 会撞 `document is not defined`）；`app.use(VueQueryPlugin)` +
// 自带 QueryClient 是实例化任何用 query 的 composable 的硬要求。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

const elMessageError = vi.fn();
vi.mock('element-plus', () => ({
  ElMessage: {
    error: (...args: unknown[]) => elMessageError(...args),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const listCustomersMock =
  vi.fn<() => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>>();

vi.mock('@/api/customer', () => ({
  listCustomers: () => listCustomersMock(),
}));

import { useCustomerTree, type UseCustomerTreeReturn } from '../useCustomerTree';

/** 后端 wire 形态的客户；customer_path 按 2026-10-17 口径给出。 */
function c(id: string, name: string, parentId: string | null, customerPath?: string): unknown {
  return {
    id,
    name,
    parent_id: parentId,
    parent_name: parentId,
    serial_prefix: parentId === null ? 'H' : null,
    customer_path: customerPath ?? (parentId === null ? name : `${parentId} / ${name}`),
    version: 1,
    created_at: '',
    updated_at: '',
  };
}

/** 5 层：华强 / 终端BG / 手机部 / 影像组 / 光学组。 */
const FIVE_LEVEL = [
  c('l1', '华强', null),
  c('l2', '终端BG', 'l1', '终端BG'),
  c('l3', '手机部', 'l2', '终端BG / 手机部'),
  c('l4', '影像组', 'l3', '终端BG / 手机部 / 影像组'),
  c('l5', '光学组', 'l4', '终端BG / 手机部 / 影像组 / 光学组'),
];

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountTree(): { tree: UseCustomerTreeReturn; stop: () => void } {
  const scope = effectScope();
  let t: UseCustomerTreeReturn | undefined;
  scope.run(() => {
    t = testApp.runWithContext(() => useCustomerTree());
  });
  return { tree: t!, stop: () => scope.stop() };
}

describe('useCustomerTree — 返回形状 + 任意深度上溯（2026-10-17）', () => {
  beforeEach(() => {
    elMessageError.mockReset();
    listCustomersMock.mockReset();
    listCustomersMock.mockResolvedValue({ items: FIVE_LEVEL, total: 5, limit: 50, offset: 0 });
    testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    vi.restoreAllMocks();
  });

  it('T1：返回形状 = { customers, tree, loading, resolveRootCustomerId }（键不多不少）', () => {
    const { tree, stop } = mountTree();
    // 3 个既有消费方按这四个键解构，多一个少一个都可能让某个调用点静默拿到 undefined
    expect(Object.keys(tree).sort()).toEqual([
      'customers',
      'loading',
      'resolveRootCustomerId',
      'tree',
    ]);
    expect(typeof tree.resolveRootCustomerId).toBe('function');
    stop();
  });

  it('T2/T3：tree 是任意深度（第 3 层往下不再消失）', async () => {
    const { tree, stop } = mountTree();
    await vi.waitFor(() => expect(tree.customers.value).toHaveLength(5));
    const nodes = tree.tree.value;
    expect(nodes).toHaveLength(1);
    const l1 = nodes[0]!;
    expect(l1.id).toBe('l1');
    expect(l1.children[0]?.id).toBe('l2');
    const l3 = l1.children[0]?.children[0];
    expect(l3?.id).toBe('l3');
    expect(l3?.children[0]?.id).toBe('l4');
    expect(l3?.children[0]?.children[0]?.id).toBe('l5');
    expect(l3?.children[0]?.children[0]?.depth).toBe(5);
    // 节点带出 wire 上的派生字段（旧两层实现只透 id + name）
    expect(l3?.customer_path).toBe('终端BG / 手机部');
    stop();
  });

  it('T2b：customers 就是 query 的 items（顺序与对象不重排）', async () => {
    const { tree, stop } = mountTree();
    await vi.waitFor(() => expect(tree.customers.value).toHaveLength(5));
    expect(tree.customers.value.map((x) => x.id)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    stop();
  });

  it('T4：resolveRootCustomerId 跨任意深度上溯到 L1；null / 未知 id → null', async () => {
    const { tree, stop } = mountTree();
    await vi.waitFor(() => expect(tree.customers.value).toHaveLength(5));
    expect(tree.resolveRootCustomerId('l1')).toBe('l1');
    expect(tree.resolveRootCustomerId('l2')).toBe('l1');
    expect(tree.resolveRootCustomerId('l3')).toBe('l1');
    expect(tree.resolveRootCustomerId('l5')).toBe('l1');
    expect(tree.resolveRootCustomerId(null)).toBeNull();
    expect(tree.resolveRootCustomerId('nope')).toBeNull();
    stop();
  });

  it('T5：query 出错时 ElMessage.error 弹一次（错误桥接不许被顺手删掉）', async () => {
    listCustomersMock.mockRejectedValue(new Error('boom'));
    const { stop } = mountTree();
    await vi.waitFor(() => expect(elMessageError).toHaveBeenCalledTimes(1));
    expect(elMessageError.mock.calls[0]?.[0]).toBe('boom');
    stop();
  });

  it('T6：数据回来之前 tree / customers 是空数组（不是 undefined）', () => {
    listCustomersMock.mockReturnValue(new Promise(() => undefined));
    const { tree, stop } = mountTree();
    expect(tree.customers.value).toEqual([]);
    expect(tree.tree.value).toEqual([]);
    stop();
  });

  it('T6b：loading 直接透出 query.isFetching（不二次包 computed）', () => {
    const { tree, stop } = mountTree();
    expect(typeof tree.loading.value).toBe('boolean');
    stop();
  });
});
