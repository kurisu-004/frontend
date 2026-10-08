// src/views/users/composables/__tests__/useUsersQuery.spec.ts
//
// 2026-10-10 新增：账号管理页主查询 hook（`useUsersQuery`）的回归保护。覆盖最容易踩的
// 五条规则（形态照 `views/inspection/composables/__tests__/useInspectionQueueQuery.spec.ts`）：
//
//   - Q1：queryKey 形态 = `['users','list',params]`（params 直接进键）。
//   - Q2：queryFn **从 queryKey 读 params**（reactive params 范式）—— 改 params 后请求
//     带的是新值，不是闭包捕获的 stale 快照。
//   - Q3：enabled 闸门 —— false 时**不发请求**；翻 true 后自动首屏 fetch。
//   - Q4：**computed `refetchInterval` 随 `autoRefresh` 变**（关 → false / 开 → 5min）。
//     这条最易踩：`refetchInterval` 若写成裸函数，vue-query 的 defaultedOptions 只在
//     queryKey 那一层求值，函数体里的 `autoRefresh` 不进依赖收集 ⇒ 勾选开关不触发
//     `observer.setOptions` ⇒ 轮询永远不启动。
//   - Q5：`placeholderData: keepPreviousData` —— 改筛选换 queryKey 时旧数据留在屏幕上，
//     不是整表清空。
//   - Q6：Zod 守门在 queryFn —— 分页信封缺 `total` / 计数传 string 都进 error 态并经
//     ElMessage 桥接（不在 setup 抛错）。
//
// 环境：默认 node（本 hook 不碰 DOM），故 `listUsers` 与 element-plus 都走 mock。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type MaybeRefOrGetter } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const listUsersMock = vi.fn();

vi.mock('@/api/iam', () => ({
  listUsers: (params: unknown) => listUsersMock(params),
}));

import { ElMessage } from 'element-plus';
import { qk } from '@/composables/queries/keys';
import type { ListUsersParams } from '@/api/iam';
import { useUsersQuery } from '../useUsersQuery';

const ROW = {
  id: '1900000000000000001',
  version: 3,
  username: 'zhangsan',
  full_name: '张三',
  phone: null,
  is_active: true,
  last_login_at: '2026-10-10T08:30:00',
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-10-01T00:00:00',
  roles: [],
};

/** 分页信封：后端 `UserListOut` 三个计数是裸 `i64` ⇒ wire 上是 JSON number。 */
function makeResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { items: [ROW], total: 1, limit: 20, offset: 0, ...over };
}

function baseParams(over: Partial<ListUsersParams> = {}): ListUsersParams {
  return { username_like: undefined, is_active: undefined, limit: 20, offset: 0, ...over };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountHook(opts: {
  params: MaybeRefOrGetter<ListUsersParams>;
  enabled: MaybeRefOrGetter<boolean>;
  autoRefresh?: MaybeRefOrGetter<boolean>;
}) {
  const scope = effectScope();
  let c: ReturnType<typeof useUsersQuery> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() =>
      useUsersQuery({ ...opts, autoRefresh: opts.autoRefresh ?? false }),
    );
  });
  return { scope, comp: c! };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读某个 query 的 `options.refetchInterval` 当前求值结果（`false` | `number`）。
 *  `refetchInterval` 在 `QueryOptions` 上是联合型（含函数形态），这里断言的正是
 *  「本 hook 传的是 computed ⇒ 求值成 number / false」，故按 unknown 读出再断言。 */
function refetchIntervalOf(key: readonly unknown[]): unknown {
  const query = testQueryClient.getQueryCache().find({ queryKey: key });
  return (query?.options as { refetchInterval?: unknown } | undefined)?.refetchInterval;
}

describe('useUsersQuery — 账号管理主查询', () => {
  beforeEach(() => {
    listUsersMock.mockReset();
    listUsersMock.mockResolvedValue(makeResult());
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
  });

  it('Q1：queryKey = ["users","list",params]', async () => {
    const params = ref(baseParams());
    const { scope } = mountHook({ params, enabled: true });
    await sleep(30);

    const found = testQueryClient
      .getQueryCache()
      .find({ queryKey: qk.usersList(params.value) });
    expect(found).toBeTruthy();
    expect(found?.queryKey[0]).toBe('users');
    expect(found?.queryKey[1]).toBe('list');
    expect(found?.queryKey[2]).toEqual(params.value);
    scope.stop();
  });

  it('Q2：queryFn 从 queryKey 读 params（改 params 后发新值，不发 stale 快照）', async () => {
    const params = ref(baseParams());
    const { scope, comp } = mountHook({ params, enabled: true });
    await comp.fetchList();
    expect(listUsersMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 0 }));

    params.value = baseParams({ username_like: 'zhang', offset: 40 });
    await sleep(30);
    expect(listUsersMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ username_like: 'zhang', offset: 40 }),
    );
    // 计数是 number 且**不做二次归一**（归一在 api 层 normalizeListResult）。
    expect(comp.data.value?.total).toBe(1);
    scope.stop();
  });

  it('Q3：enabled=false 时不发请求；翻 true 后自动首屏 fetch', async () => {
    const params = ref(baseParams());
    const enabled = ref(false);
    const { scope } = mountHook({ params, enabled });
    await sleep(30);
    expect(listUsersMock).not.toHaveBeenCalled();

    enabled.value = true;
    await sleep(30);
    expect(listUsersMock).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('Q4：refetchInterval 是 computed，随 autoRefresh 在 false / 5min 之间切换', async () => {
    const params = ref(baseParams());
    const autoRefresh = ref(false);
    const { scope } = mountHook({ params, enabled: true, autoRefresh });
    await sleep(30);
    expect(refetchIntervalOf(qk.usersList(params.value))).toBe(false);

    autoRefresh.value = true;
    await sleep(30);
    expect(refetchIntervalOf(qk.usersList(params.value))).toBe(300_000);

    autoRefresh.value = false;
    await sleep(30);
    expect(refetchIntervalOf(qk.usersList(params.value))).toBe(false);
    scope.stop();
  });

  it('Q5：keepPreviousData —— 换 queryKey 时旧数据留在屏幕上（不是整表清空）', async () => {
    const params = ref(baseParams());
    let release: (() => void) | undefined;
    const { scope, comp } = mountHook({ params, enabled: true });
    await sleep(30);
    expect(comp.data.value?.items).toHaveLength(1);

    // 换 params 换键 ⇒ 新请求挂在不 resolve 的 promise 上，期间 data 应仍是上一份。
    listUsersMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(makeResult({ items: [], total: 0, offset: 40 }));
        }),
    );
    params.value = baseParams({ offset: 40 });
    await sleep(30);
    expect(comp.isFetching.value).toBe(true);
    expect(comp.data.value?.items).toHaveLength(1);

    release?.();
    await sleep(30);
    expect(comp.data.value?.items).toHaveLength(0);
    expect(comp.data.value?.offset).toBe(40);
    scope.stop();
  });

  it('Q6a：分页信封缺 total → error 态 + ElMessage 桥接（守门在 queryFn，不在 setup 抛错）', async () => {
    const { total: _drop, ...withoutTotal } = makeResult();
    listUsersMock.mockResolvedValue(withoutTotal);

    const { scope, comp } = mountHook({ params: ref(baseParams()), enabled: true });
    await sleep(30);

    expect(comp.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });

  it('Q6b：计数传 string → error 态（后端是裸 i64 的 number；string 形态归 api 层处理）', async () => {
    listUsersMock.mockResolvedValue(makeResult({ total: '1' }));

    const { scope, comp } = mountHook({ params: ref(baseParams()), enabled: true });
    await sleep(30);

    expect(comp.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });
});