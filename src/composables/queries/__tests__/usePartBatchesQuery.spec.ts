// src/composables/queries/__tests__/usePartBatchesQuery.spec.ts
//
// 2026-10-10 新增（review 第 1 轮 重要 4）：`staleTimeMs` 覆盖形参的回归保护，
// 以及零件详情页「回到缓存页时补刷批次列表」这条链的静态守卫。
//
// 背景（review 的根因诊断）：批次行在零件详情页**不是只读展示** —— 行状态决定
// `inspectionBatch`，也就是「品检通过 / 指定工序」两个按钮的可点性。看到过期的
// INSPECTION 会让人去点一个后端已经用 20103 拒掉的流转。而其它域（送检 / 工人放回 /
// 扫码送检 / 外协回收）改的是批次成员资格，那些写点只失效 `qk.partsPrefix`，**不会**
// 碰 `qk.partBatchesPrefix`（CLAUDE.md「缓存定位」明确不做跨页面精确失效补齐）⇒
// 本页的新鲜度只能靠 staleTime，共享档 20min 太长。
//
// 修法两条（缺一条都回到原病灶）：
//   1. 详情页把本 observer 的 staleTime 覆盖成 30s（共享档仍是 20min，
//      dashboard 的 PartPreviewDialog 是纯展示，不受影响）；
//   2. keep-alive 下组件**不卸载** ⇒ observer 不重新订阅 ⇒ `shouldFetchOnMount`
//      那条路在切回来时压根不触发 ⇒ 补刷必须挂 `onActivated`（原来挂在 `onMounted`，
//      只覆盖得了第一次进入）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const h = vi.hoisted(() => ({ listPartBatches: vi.fn() }));

vi.mock('@/api/parts/batch', () => ({ listPartBatches: h.listPartBatches }));

import { usePartBatchesQuery } from '../usePartBatchesQuery';
import { qk } from '../keys';

const PART_ID = '219276974948876288';
const MINUTE = 60 * 1000;

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mount(staleTimeMs?: number) {
  const scope = effectScope();
  let q: ReturnType<typeof usePartBatchesQuery> | undefined;
  scope.run(() => {
    q = testApp.runWithContext(() => usePartBatchesQuery(() => PART_ID, staleTimeMs));
  });
  return { scope, q: q! };
}

/**
 * 按 staleTime 判新鲜度。
 *
 * ⚠️ 走 `query.isStaleByTime(ms)` 而不是 `q.isStale` —— 后者是 vue-query 里的
 * **computed**，只在响应式依赖变化时重算，而推进 fake timer 不是响应式触发，断言会
 * 读到上一次的缓存值。`isStaleByTime` 是 query-core 的纯函数（`Date.now() -
 * dataUpdatedAt > staleTime`），正是 observer 内部判定新鲜度用的那一个（query-core
 * `isStale(query, options)` 直接调它）。
 */
function isStaleAt(staleTimeMs: number): boolean {
  const qy = testQueryClient.getQueryCache().find({ queryKey: qk.partBatchesList(PART_ID) });
  expect(qy, '批次 query 应已建立').toBeDefined();
  return qy!.isStaleByTime(staleTimeMs);
}

beforeEach(() => {
  h.listPartBatches.mockReset().mockResolvedValue([]);
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

afterEach(() => {
  testQueryClient.unmount();
  testApp = null as unknown as ReturnType<typeof createApp>;
  testQueryClient = null as unknown as QueryClient;
  vi.restoreAllMocks();
});

describe('B1：staleTimeMs 覆盖形参', () => {
  it('B1a：默认仍是共享档 20min（PartPreviewDialog 不受影响）', async () => {
    vi.useFakeTimers();
    try {
      const { scope, q } = mount();
      await q.refetch();
      vi.advanceTimersByTime(19 * MINUTE);
      expect(isStaleAt(20 * MINUTE), '19min 时仍新鲜').toBe(false);
      vi.advanceTimersByTime(2 * MINUTE);
      expect(isStaleAt(20 * MINUTE), '21min 时已过期').toBe(true);
      scope.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B1b：传 30s 时按 30s 判新鲜度（详情页那一档）', async () => {
    vi.useFakeTimers();
    try {
      const { scope, q } = mount(30_000);
      await q.refetch();
      vi.advanceTimersByTime(20_000);
      expect(isStaleAt(30_000), '20s 时仍新鲜').toBe(false);
      expect(isStaleAt(20 * MINUTE), '20s 时按共享档更是新鲜').toBe(false);
      vi.advanceTimersByTime(15_000);
      expect(isStaleAt(30_000), '35s 时已过期（= 详情键同档，不再是 20min）').toBe(true);
      expect(isStaleAt(20 * MINUTE), '35s 时按共享档仍新鲜 —— 两条档位确实被分开').toBe(false);
      scope.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('B2：详情页的接线（静态守卫）', () => {
  const src = readFileSync(
    fileURLToPath(
      new URL('../../../views/parts/detail/composables/usePartDetail.ts', import.meta.url),
    ),
    'utf8',
  );

  it('B2a：详情页把 staleTime 覆盖成 30s（覆盖形参真的被用上了）', () => {
    expect(src).toMatch(/usePartBatchesQuery\(\(\) => toValue\(partId\),\s*30_000\)/);
  });

  it('B2b：补刷挂 onActivated 而不是 onMounted（keep-alive 下 onMounted 只跑一次）', () => {
    expect(src).toContain('onActivated(() => {');
    // 挂 onMounted 会让「切走再回来」彻底不刷新 —— 这正是原病灶。
    expect(src).not.toMatch(/onMounted\(/);
  });

  it('B2c：补刷前先判 isStale（新鲜时不发无谓请求），且首次激活放行给 observer', () => {
    // 首次激活放行：那一刻 observer 自己正在按 staleTime 判新鲜度（冷缓存自动首调 /
    // 暖缓存已过期同样自动重取），再补一次就是两次往返。
    expect(src).toMatch(/if \(!activatedOnce\) \{\s*activatedOnce = true;\s*return;/);
    expect(src).toContain('if (batchesQuery.isStale.value) void batchesQuery.refetch();');
  });
});
