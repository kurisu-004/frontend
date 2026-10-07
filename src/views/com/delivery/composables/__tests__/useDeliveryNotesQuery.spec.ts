// src/views/com/delivery/composables/__tests__/useDeliveryNotesQuery.spec.ts
//
// 2026-10-08 新增：列表主查询 hook 的守卫。
//
// mock 策略照 usePendingProgrammingStore.spec.ts：**下移到 axios 层**
// （vi.mock('@/api/http') 只替换 api.get，importOriginal 保留 cleanParams /
// normalizeListResult / ApiError）。不整体 mock 掉 '@/api/com/deliveryNote' ——
// 守门 parse 在 queryFn 里，整体 mock 会把守门一起短路。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApp, nextTick, ref } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type * as HttpModule from '@/api/http';
import { qk } from '@/composables/queries/keys';
import { useDeliveryNotesQuery } from '../useDeliveryNotesQuery';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>(async () => ({
    data: { items: [], total: 0, limit: 50, offset: 0 },
  })),
}));

vi.mock('@/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, api: { ...actual.api, get: apiGetMock } };
});

function okPage(items: unknown[] = []) {
  return { data: { items, total: items.length, limit: 50, offset: 0 } };
}

/** vue-query hook 需要注入上下文（node 单测无组件）。 */
const app = createApp({ render: () => null });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
app.use(VueQueryPlugin, { queryClient });

function inSetup<T>(fn: () => T): T {
  return app.runWithContext(fn);
}

beforeEach(() => {
  queryClient.clear();
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue(okPage());
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await nextTick();
  await new Promise((r) => setTimeout(r, 0));
}

describe('useDeliveryNotesQuery', () => {
  it('enabled=false 时不发请求；置 true 后发一次（闸门避免「默认参数 + 持久化参数」双 fetch）', async () => {
    const enabled = ref(false);
    const hook = inSetup(() =>
      useDeliveryNotesQuery({ params: () => ({ limit: 50, offset: 0 }), enabled, autoRefresh: false }),
    );
    await settle();
    expect(apiGetMock).not.toHaveBeenCalled();
    enabled.value = true;
    await settle();
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    void hook;
  });

  it('queryKey 走 qk 工厂（不在调用点拼字面量数组）', async () => {
    const params = ref({ limit: 50, offset: 0, keyword: 'DN-1' });
    inSetup(() => useDeliveryNotesQuery({ params, enabled: true, autoRefresh: false }));
    await settle();
    // queryClient 缓存里的键就是 queryKey（键的唯一真相源是 qk 工厂，不是调用点拼的数组）
    expect(queryClient.getQueryCache().getAll()[0]?.queryKey).toEqual(
      qk.deliveryNotesList(params.value),
    );
  });

  it('reactive params：改 params 换 queryKey 并重发（queryFn 从 queryKey 读最新值）', async () => {
    const params = ref({ limit: 50, offset: 0 });
    inSetup(() => useDeliveryNotesQuery({ params, enabled: true, autoRefresh: false }));
    await settle();
    params.value = { limit: 20, offset: 40 };
    await settle();
    const lastCall = apiGetMock.mock.calls.at(-1)!;
    const sentParams = (lastCall[1] as { params: Record<string, unknown> }).params;
    expect(sentParams.limit).toBe(20);
    expect(sentParams.offset).toBe(40);
  });

  it('Zod 守门承重字段：响应缺 part_count → 进 error 态、data 为 undefined', async () => {
    apiGetMock.mockResolvedValue(okPage([{ id: '1', delivery_note_no: 'DN-1' }]));
    const hook = inSetup(() =>
      useDeliveryNotesQuery({ params: () => ({}), enabled: true, autoRefresh: false }),
    );
    await settle();
    expect(hook.data.value).toBeUndefined();
    expect(hook.error.value).not.toBeNull();
  });

  it('URL 与 query 参数经 api 层序列化（路径硬切到 /com/delivery/note）', async () => {
    inSetup(() =>
      useDeliveryNotesQuery({
        params: () => ({ statuses: ['DRAFT'], keyword: 'DN', limit: 10, offset: 0 }),
        enabled: true,
        autoRefresh: false,
      }),
    );
    await settle();
    expect(apiGetMock.mock.calls[0]![0]).toBe('/com/delivery/note');
  });

  it('fetchList 是 refetch 的包装（供视图「刷新」与测试零改动驱动）', async () => {
    const hook = inSetup(() =>
      useDeliveryNotesQuery({ params: () => ({}), enabled: true, autoRefresh: false }),
    );
    await settle();
    await hook.fetchList();
    expect(apiGetMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
