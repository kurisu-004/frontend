// @vitest-environment happy-dom
// src/views/mail/accounts/__tests__/useMailAccountsQuery.spec.ts
//
// 2026-10-16 新增：两条读端点 query hook 的单测。
//
// ⚠️ **W3 系列是本 spec 存在的核心理由** —— api 层按 CLAUDE.md「queryFn Zod 守门」
// 只发请求、不做 parse（parse 返回深拷贝，在 api 层再走一遍等于每屏数据被校验并克隆两
// 遍），所以一旦有人把 queryFn 里的 `xxxSchema.parse(...)` 整段删掉，api 层那份负向守卫
// （`src/api/__tests__/mailAccounts.contract.spec.ts` 断言读端点不 parse）**照样全绿**，
// 而线上是「后端漏发一个字段 → 那一列整列 undefined，且零报错」。只有在这里 mock 一份
// **坏响应**、断言它进不了 data，才能把这个洞补上。**两组守卫必须成对存在**（少任一条 =
// 搬动 parse 时零测试信号；同款纪律见 statistics 域的 W3 与 `api/__tests__/statistics.spec.ts`）。
//
// 覆盖：
//   - W1 / M1：queryKey 取自 `keys.ts` 工厂（不在调用点拼字面量数组）；
//   - W2：`enabled: false` 时零网络请求（闸门由 store 的 `openGate()` 开）；
//   - W3 系列：坏响应 ⇒ `query.error` 非空且 data 不落值（**parse 真接在返回路径上**）；
//   - M4：meta 的 `staleTime` / `gcTime` 是共享基础数据层那一档（30s / **有限** 5min；禁
//     `POSITIVE_INFINITY` —— 那是 dashboard 域靠 WS 事件失效才成立的例外，本域没有失效通道）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { MaybeRefOrGetter } from 'vue';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listMailAccountsMock = vi.fn();
const fetchMailMetaMock = vi.fn();

vi.mock('@/api/mailAccounts', () => ({
  listMailAccounts: (...args: unknown[]) => listMailAccountsMock(...args),
  fetchMailMeta: (...args: unknown[]) => fetchMailMetaMock(...args),
}));

import { ElMessage } from 'element-plus';
import { useMailAccountsQuery, useMailMetaQuery } from '../composables/useMailAccountsQuery';
import { qk } from '@/composables/queries/keys';

/** 一条合法的 `AccountOut`（守门 schema 全 9 键）。 */
const ACCOUNT = {
  id: '9000000000000902',
  version: 1,
  name: '采购部邮箱',
  preset: 'NET_EASE_163',
  account: 'purchase@example.com',
  is_default: true,
  created_at: '2026-10-16 08:00:00',
  updated_at: '2026-10-16 08:00:00',
};

const META = {
  presets: [
    {
      value: 'NET_EASE_163',
      label: '网易 163',
      host: 'smtp.163.com',
      port: 465,
      tls_mode: 'WRAPPED',
    },
  ],
};

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountAccounts(enabled: MaybeRefOrGetter<boolean>) {
  const scope = effectScope();
  let c: ReturnType<typeof useMailAccountsQuery> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() => useMailAccountsQuery({ enabled }));
  });
  return { scope, comp: c! };
}

function mountMeta(enabled: MaybeRefOrGetter<boolean>) {
  const scope = effectScope();
  let c: ReturnType<typeof useMailMetaQuery> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() => useMailMetaQuery({ enabled }));
  });
  return { scope, comp: c! };
}

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  vi.clearAllMocks();
  listMailAccountsMock.mockResolvedValue([ACCOUNT]);
  fetchMailMetaMock.mockResolvedValue(META);
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

afterEach(() => {
  testQueryClient.unmount();
});

describe('useMailAccountsQuery — 键 / 闸门', () => {
  it('W1：queryKey = ["mail","accounts"]（键一律取自 keys.ts 工厂）', async () => {
    const { scope } = mountAccounts(ref(true));
    await tick();

    const found = testQueryClient.getQueryCache().find({ queryKey: qk.mailAccounts() });
    expect(found).toBeTruthy();
    expect(found?.queryKey).toEqual(['mail', 'accounts']);
    expect(qk.mailAccounts()).toEqual(['mail', 'accounts']);
    scope.stop();
  });

  it('W2：enabled=false ⇒ 零网络请求（闸门由 store 的 openGate() 在 onMounted 末尾开）', async () => {
    const { scope, comp } = mountAccounts(ref(false));
    await tick();

    expect(listMailAccountsMock).not.toHaveBeenCalled();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('W2b：开闸后打一次，数据落进 data', async () => {
    const { scope, comp } = mountAccounts(ref(true));
    await tick();

    expect(listMailAccountsMock).toHaveBeenCalledTimes(1);
    expect(comp.data.value).toEqual([ACCOUNT]);
    scope.stop();
  });
});

// ⚠️ 本 spec 的核心断言：把 queryFn 里的 `.parse()` 整段删掉时，下面每一条立刻红，
// 而 api 层的负向守卫（断言读端点不 parse）仍然是绿的 —— 守门只能在这里被守住。
describe('useMailAccountsQuery — 坏响应守门（W3）', () => {
  it('W3a：缺必填键（version）⇒ 进 error 态、data 不落值', async () => {
    // Zod 的 strip 默认会把缺字段**悄悄吞掉**让页面照常渲染那一列的 undefined ——
    // queryFn 里的 parse 就是为拦住这个。
    const broken: Record<string, unknown> = { ...ACCOUNT };
    delete broken['version'];
    listMailAccountsMock.mockResolvedValue([broken]);

    const { scope, comp } = mountAccounts(ref(true));
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });

  it('W3b：preset 枚举越界（GMAIL）⇒ 进 error 态', async () => {
    listMailAccountsMock.mockResolvedValue([{ ...ACCOUNT, preset: 'GMAIL' }]);
    const { scope, comp } = mountAccounts(ref(true));
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    scope.stop();
  });

  it('W3c：⚠️ 后端误带 encrypted_secret ⇒ 当场抛（列表页不允许出现任何授权码派生值）', async () => {
    listMailAccountsMock.mockResolvedValue([{ ...ACCOUNT, encrypted_secret: 'AAAA' }]);
    const { scope, comp } = mountAccounts(ref(true));
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('W3d：顶层不是数组（信封搞错）⇒ 进 error 态', async () => {
    listMailAccountsMock.mockResolvedValue({ items: [ACCOUNT] });
    const { scope, comp } = mountAccounts(ref(true));
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    scope.stop();
  });
});

describe('useMailMetaQuery — 键 / 下发值 / 缓存档位', () => {
  it('M1：queryKey = ["mail","meta"]（常量键，端点不接 Query extractor）', async () => {
    const { scope } = mountMeta(ref(true));
    await tick();

    const found = testQueryClient.getQueryCache().find({ queryKey: qk.mailMeta() });
    expect(found?.queryKey).toEqual(['mail', 'meta']);
    expect(qk.mailMeta()).toEqual(['mail', 'meta']);
    scope.stop();
  });

  it('M2：host / port / tls_mode 全部取自后端下发（前端不推导、不缓存映射）', async () => {
    const { scope, comp } = mountMeta(ref(true));
    await tick();

    expect(comp.data.value?.presets[0]?.host).toBe('smtp.163.com');
    expect(comp.data.value?.presets[0]?.port).toBe(465);
    expect(comp.data.value?.presets[0]?.tls_mode).toBe('WRAPPED');
    scope.stop();
  });

  it('M3：预设选项缺 host ⇒ 进 error 态（弹窗那条只读描述行就没得显示）', async () => {
    const { host: _drop, ...noHost } = META.presets[0]!;
    fetchMailMetaMock.mockResolvedValue({ presets: [noHost] });
    const { scope, comp } = mountMeta(ref(true));
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('M4：staleTime 30s / gcTime 是**有限值** 5min（禁 POSITIVE_INFINITY）', () => {
    const { scope } = mountMeta(ref(false));
    // 断言形状与 `useQueueBoard.spec.ts` 的 B7 / `useOutsourceQueueSnapshotQuery.spec.ts`
    // 的 SQ4 同款：`QueryOptions` 不直接暴露这两个键，经 `as` 收窄读。
    const entry = testQueryClient.getQueryCache().find({ queryKey: qk.mailMeta() });
    const opts = entry?.options as { staleTime?: number; gcTime?: number };
    expect(opts.staleTime).toBe(30_000);
    expect(opts.gcTime).toBe(5 * 60 * 1000);
    scope.stop();
  });

  it('M5：enabled=false ⇒ 零网络请求', async () => {
    const { scope } = mountMeta(ref(false));
    await tick();
    expect(fetchMailMetaMock).not.toHaveBeenCalled();
    scope.stop();
  });
});
