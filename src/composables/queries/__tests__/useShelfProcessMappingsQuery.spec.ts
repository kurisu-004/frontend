// src/composables/queries/__tests__/useShelfProcessMappingsQuery.spec.ts
//
// 2026-10-02 新增：货架↔工序映射全集共享 query 单测（Phase C 迁 useShelfProcessFilter
// 的核心交付物 = 这层 Zod 守门）。
//
// 覆盖：
//   - S1：`GET /prod/shelf-processes` 真契约（只有 items 一个顶层字段、元素 4 字段、
//     **不返** sort_order）能 parse —— 锁死「schema 不多要字段」（多要 ⇒ parse 100%
//     失败 ⇒ 8 个页面下拉全量不过滤，是 2026-09-30 pool 域踩过的同一个坑）。
//   - S2：**缺 shelf_code → 抛 ZodError**。这是守门「有牙」的直接证明：
//     shelfProcessMappingItemSchema 4 字段全声明（CLAUDE.md §M-4 strip 陷阱 ——
//     Zod 默认 strip 模式漏声明的字段会被静默丢弃、parse 不报错，regroup 只读
//     shelf_id / process_id ⇒ 守门形同虚设，漂移要到 UI 渲染出空白 chip 才暴露）。
//   - S3：多余字段（如单架 VO 才有的 sort_order）被 strip，不报错（向后兼容）。
//   - Q1：常量 queryKey 落库形态 = ['shelf-process-mappings']，且与 qk 同源。
//   - Q2：enabled 闸门关着时**零请求**（各调用点的下拉源还没就绪时不该白拉）。
//   - Q3：闸门由 ref 开合后自动放行一次请求（getter 形态 enabled 的回归守卫）。
//   - Q4：守门失败 → query 进 error 态（isError=true，error 里能看到缺哪个字段），
//     data 保持 undefined —— 消费侧（useShelfProcessFilter）据此 loaded=false 走全量兜底。
//   - Q5：两个实例（模拟 10 处调用点）共用同一 queryKey ⇒ 只发一次请求（去重收益，
//     也是「10 处共用一份映射缓存」的契约固化）。
//
// 测试策略（沿 useWorkerPoolCountsQuery.spec.ts 范本）：
//   - vi.mock('@/api/shelves')：getAllShelfProcessMappings 替换为可控 vi.fn()；
//   - createApp + VueQueryPlugin + QueryClient(queries.retry: 0)：useQuery 内部
//     useQueryClient() 走 inject，必须在 app.runWithContext + effectScope 内调；
//   - vi.mock('element-plus', ...)：本文件不碰 ElMessage，桩它只是与仓内其它
//     composable spec 保持一致的防御（import 图里可能带入组件库）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

interface MappingPayload {
  items: Array<{
    shelf_id?: string;
    shelf_code?: string;
    process_id?: string;
    process_code?: string;
  }>;
}

const getAllShelfProcessMappingsMock = vi.fn(async (): Promise<MappingPayload> => ({ items: [] }));

vi.mock('@/api/shelves', () => ({
  getAllShelfProcessMappings: () => getAllShelfProcessMappingsMock(),
}));

import { shelfProcessMappingsResultSchema } from '../schemas';
import { qk } from '../keys';
import { useShelfProcessMappingsQuery } from '../useShelfProcessMappingsQuery';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;
let scope: EffectScope;

beforeEach(() => {
  vi.clearAllMocks();
  getAllShelfProcessMappingsMock.mockResolvedValue({ items: [] });
  scope = effectScope();
  // queries.retry: 0 —— 与 src/main.ts 全局默认一致：守门抛错时不该被重试放大
  // （守门的意义就是「立刻报错」，不是「安静重试三次」）。
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

afterEach(() => {
  scope.stop();
  testQueryClient.unmount();
  testApp = null as unknown as ReturnType<typeof createApp>;
  testQueryClient = null as unknown as QueryClient;
  vi.restoreAllMocks();
});

function mountQuery(enabled?: Ref<boolean>) {
  let q: ReturnType<typeof useShelfProcessMappingsQuery> | undefined;
  scope.run(() => {
    q = testApp.runWithContext(() => useShelfProcessMappingsQuery(enabled));
  });
  return q!;
}

describe('shelfProcessMappingsResultSchema — 契约守门（2026-10-02）', () => {
  it('S1：真契约（只有 items；元素 4 字段；不返 sort_order）能 parse', () => {
    // 逐字复刻 backend-rust AllShelfProcessMappingOut（vo.rs:44-56）
    const parsed = shelfProcessMappingsResultSchema.parse({
      items: [
        {
          shelf_id: '8800000000001',
          shelf_code: 'SH-P01',
          process_id: '190000000000001',
          process_code: 'CUT',
        },
      ],
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].shelf_code).toBe('SH-P01');
  });

  it('S2：缺 shelf_code → 抛 ZodError（4 字段全声明，守门有牙）', () => {
    // 若 schema 漏声明 shelf_code（Zod 默认 strip 模式不报错），本用例会失败；
    // 反过来若有人为了「宽容」给它加 .optional()，本用例也会失败 —— 两个方向都守住。
    expect(() =>
      shelfProcessMappingsResultSchema.parse({
        items: [{ shelf_id: '8800000000001', process_id: '190000000000001' }],
      }),
    ).toThrow();
    // 错误信息里能看到具体缺哪个字段（真·有牙，不是笼统 parse 失败）
    expect(() =>
      shelfProcessMappingsResultSchema.parse({
        items: [{ shelf_id: '8800000000001', process_id: '190000000000001' }],
      }),
    ).toThrow(/shelf_code/);
  });

  it('S2b：缺 process_code / shelf_id / process_id 同样抛错（4 字段逐个守卫）', () => {
    const full = {
      shelf_id: '8800000000001',
      shelf_code: 'SH-P01',
      process_id: '190000000000001',
      process_code: 'CUT',
    };
    for (const key of ['shelf_id', 'shelf_code', 'process_id', 'process_code'] as const) {
      const broken: Record<string, unknown> = { ...full };
      delete broken[key];
      expect(() => shelfProcessMappingsResultSchema.parse({ items: [broken] })).toThrow();
    }
  });

  it('S3：多传单架 VO 才有的 sort_order → 被 strip，不报错（向后兼容）', () => {
    const parsed = shelfProcessMappingsResultSchema.parse({
      items: [
        {
          shelf_id: '8800000000001',
          shelf_code: 'SH-P01',
          process_id: '190000000000001',
          process_code: 'CUT',
          sort_order: 1,
        },
      ],
    });
    expect(parsed.items[0].shelf_id).toBe('8800000000001');
  });
});

describe('useShelfProcessMappingsQuery — 常量 queryKey + 闸门 + 守门（2026-10-02）', () => {
  it('Q1：queryKey 落库形态 = qk.shelfProcessMappings（常量、无 params 维度）', async () => {
    const q = mountQuery();
    await q.refetch();
    const keys = testQueryClient.getQueryCache().getAll().map((one) => one.queryKey);
    expect(keys).toContainEqual(['shelf-process-mappings']);
    expect(qk.shelfProcessMappings).toEqual(['shelf-process-mappings']);
  });

  it('Q2：闸门关着 → 零请求', async () => {
    const gate = ref(false);
    const q = mountQuery(gate);
    await new Promise((r) => setTimeout(r, 20));
    await nextTick();
    expect(getAllShelfProcessMappingsMock).not.toHaveBeenCalled();
    expect(q.data.value).toBeUndefined();
    // 闸门关着时 status 恒 pending（= 「还没拿到」，不是失败）
    expect(q.status.value).toBe('pending');
    expect(q.isFetching.value).toBe(false);
  });

  it('Q3：闸门由 ref 开合 → 自动放行一次请求（getter 形态 enabled 回归守卫）', async () => {
    const gate = ref(false);
    const q = mountQuery(gate);
    await new Promise((r) => setTimeout(r, 20));
    expect(getAllShelfProcessMappingsMock).not.toHaveBeenCalled();

    gate.value = true;
    await vi.waitFor(() => {
      expect(q.isSuccess.value).toBe(true);
    });
    expect(getAllShelfProcessMappingsMock).toHaveBeenCalledTimes(1);
  });

  it('Q4（守门有牙）：响应缺 shelf_code → query 进 error 态，data 保持 undefined', async () => {
    getAllShelfProcessMappingsMock.mockResolvedValue({
      items: [{ shelf_id: '8800000000001', process_id: '190000000000001' }],
    });
    const q = mountQuery();

    await vi.waitFor(() => {
      expect(q.isError.value).toBe(true);
    });
    expect(q.data.value).toBeUndefined();
    // 错误来自 parse（ZodError），不是网络
    expect(String(q.error.value)).toMatch(/shelf_code/);
    // 守门只发一次请求：retry: 0 生效，不会把一次契约漂移放大成 4 次重试
    expect(getAllShelfProcessMappingsMock).toHaveBeenCalledTimes(1);
  });

  it('Q5：两个实例（模拟 10 处调用点）共用同一 queryKey → 只发一次请求', async () => {
    getAllShelfProcessMappingsMock.mockResolvedValue({
      items: [
        {
          shelf_id: '8800000000001',
          shelf_code: 'SH-P01',
          process_id: '190000000000001',
          process_code: 'CUT',
        },
      ],
    });
    const a = mountQuery();
    const b = mountQuery();

    await vi.waitFor(() => {
      expect(a.isSuccess.value).toBe(true);
      expect(b.isSuccess.value).toBe(true);
    });
    expect(getAllShelfProcessMappingsMock).toHaveBeenCalledTimes(1);
    // 两个 observer 看到同一份数据（共用缓存的实质）
    expect(a.data.value?.items[0]?.process_code).toBe('CUT');
    expect(b.data.value?.items[0]?.process_code).toBe('CUT');
  });
});
