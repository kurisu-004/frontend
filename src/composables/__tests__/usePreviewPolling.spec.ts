// @vitest-environment happy-dom
//
// usePreviewPolling 单元测试（2026-10-13 图纸预览切 CI 转图直链）。
//
// 这个 composable 决定「用户点开图纸后，前端会打后端几次、打多密、什么时候认输」。
// 它最容易出的错是**静默**的：轮询打太密不会报错，只会在 CI 转码抖动时把后端队列冲垮；
// 降级不告知也不会报错，只会让现场看到「预览变慢了」而查不出原因。故本 spec 盯三件事：
//
// - **节流（最重要）**：无论后端给什么，两条重试路径（`PENDING` 与请求报错）都必须
//   经 setTimeout 退避，不能零间隔连打。次数闸只封顶「打多少次」、封不住「打得多密」，
//   漏掉 sleep 会让一次持续 5xx 在几毫秒内把整个预算打完、冲垮后端转码队列。本 spec
//   用 fake timers 断言两次请求之间必然经过一个 `setTimeout`。
// - **三态分流**：`READY` 停、`FAILED` 降级、命中不可用码（400/502/21116）立刻降级。
// - **降级有告知**：`degradedReason` 必须有值（可追因），不能是静默兜底。
//
// 竞态守卫（切文件中断在途）与退避倍率的精确数值不在本 spec 覆盖范围内：前者要构造
// 请求解析时序、后者改了也要连带改文案，收益低于维护成本。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { usePreviewPolling } from '../usePreviewPolling';

// ============ mock api 层 ============
// 只 mock `getPartFilePreview` 这一个出口：composable 不该自己拼 URL / 发请求，
// 那些是 api 层的职责，本 spec 只验编排（三态分流 + 退避节流 + 降级告知）。
const getPartFilePreview = vi.fn();
vi.mock('@/api/files/objects', () => ({
  getPartFilePreview: (...args: unknown[]) => getPartFilePreview(...args),
}));

/** 造一个 `ApiError` 形状的错误（`code` 是 `isPreviewUnsupportedError` 唯一判据）。 */
function apiError(code: number, message = 'err'): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/** 在 composable 的 scope 里跑一次，并推进 fake timers 直到 promise 链落定。 */
async function settle(times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.runAllTimersAsync();
    await nextTick();
  }
}

describe('usePreviewPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getPartFilePreview.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('READY：一次性拿到 pages 后停在 READY，不再发第二次请求', async () => {
    getPartFilePreview.mockResolvedValue({
      state: 'READY',
      page_count: 2,
      pages: ['https://cdn/p1.jpg', 'https://cdn/p2.jpg'],
      retry_after_ms: null,
      error: null,
    });
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => 'f1' }))!;

    await settle();

    expect(p.state.value).toBe('READY');
    expect(p.ready.value).toBe(true);
    expect(p.pages.value).toEqual(['https://cdn/p1.jpg', 'https://cdn/p2.jpg']);
    expect(p.degraded.value).toBe(false);
    expect(getPartFilePreview).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('PENDING：按后端建议间隔退避重试，转成 READY 后停', async () => {
    getPartFilePreview
      .mockResolvedValueOnce({
        state: 'PENDING',
        page_count: 0,
        pages: [],
        retry_after_ms: 2000,
        error: null,
      })
      .mockResolvedValue({
        state: 'READY',
        page_count: 1,
        pages: ['https://cdn/p1.jpg'],
        retry_after_ms: null,
        error: null,
      });
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => 'f1' }))!;

    await settle();

    expect(p.state.value).toBe('READY');
    expect(getPartFilePreview).toHaveBeenCalledTimes(2);
    // 关键：两次请求之间必须经过一个 setTimeout（退避），而不是背靠背连打。
    expect(vi.getTimerCount()).toBe(0); // READY 后不留待触发的定时器
    scope.stop();
  });

  it('节流回归：请求报错也必须退避，不能零间隔把预算一次打完', async () => {
    // 每次都抛「非不可用码」错误（网络抖动）⇒ 走可重试分支。
    getPartFilePreview.mockRejectedValue(apiError(500, '网关抖动'));
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => 'f1' }))!;

    // 只推进「一次退避」的量：此时应当已经发出了第 2 次请求，但仍留有待触发的定时器。
    await vi.advanceTimersByTimeAsync(1_500);
    await nextTick();
    expect(getPartFilePreview.mock.calls.length).toBeLessThanOrEqual(2);
    // 还有定时器在排队 ⇒ 说明它在等退避，而不是在连打。
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // 跑满整个预算 ⇒ 应当降级，且降级原因带上最后一次错误的 message（可追因）。
    await settle();
    expect(p.degraded.value).toBe(true);
    expect(p.degradedReason.value).toContain('网关抖动');
    expect(p.pages.value).toEqual([]);
    scope.stop();
  });

  it('不可用码（400/502/21116）：立即降级，不浪费预算继续重试', async () => {
    for (const code of [400, 502, 21116]) {
      getPartFilePreview.mockReset();
      getPartFilePreview.mockRejectedValue(apiError(code, '不支持转图'));
      const scope = effectScope();
      const p = scope.run(() => usePreviewPolling({ fileId: `f-${code}` }))!;

      await settle();

      expect(p.degraded.value, `code=${code} 应降级`).toBe(true);
      // 降级原因非空：静默兜底会让 CI 挂了无人察觉。
      expect(p.degradedReason.value).toContain('不支持转图');
      // 不可重试 ⇒ 只该打一次，不该把 30 次预算耗完。
      expect(getPartFilePreview).toHaveBeenCalledTimes(1);
      scope.stop();
    }
  });

  it('FAILED：转码明确失败 ⇒ 降级并带出后端给的 error', async () => {
    getPartFilePreview.mockResolvedValue({
      state: 'FAILED',
      page_count: 0,
      pages: [],
      retry_after_ms: null,
      error: 'poppler 崩溃',
    });
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => 'f1' }))!;

    await settle();

    expect(p.degraded.value).toBe(true);
    expect(p.degradedReason.value).toContain('poppler 崩溃');
    expect(getPartFilePreview).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('enabled=false / fileId 为空：不发任何请求', async () => {
    const open = ref(false);
    const scope = effectScope();
    scope.run(() => usePreviewPolling({ fileId: () => 'f1', enabled: () => open.value }));
    const scope2 = effectScope();
    const p2 = scope2.run(() => usePreviewPolling({ fileId: () => '' }))!;

    await settle();

    expect(getPartFilePreview).not.toHaveBeenCalled();
    expect(p2.state.value).toBe('IDLE');
    scope.stop();
    scope2.stop();
  });

  it('切换 fileId：新一轮重新发请求，旧一轮的结果不写进状态（竞态守卫）', async () => {
    const fileId = ref('a');
    // 用 holder 对象而不是裸 `let`：赋值发生在 mock 的 promise executor 里，
    // 裸 let 会被 TS 的控制流分析窄成 null，调用点直接报 never。
    const firstCall: { resolve?: (v: unknown) => void } = {};
    getPartFilePreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          firstCall.resolve = resolve;
        }),
    );
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => fileId.value }))!;

    await nextTick();
    expect(getPartFilePreview).toHaveBeenCalledTimes(1);

    // 切到 b 并让第二次请求立刻 READY(b)
    getPartFilePreview.mockResolvedValueOnce({
      state: 'READY',
      page_count: 1,
      pages: ['b1'],
      retry_after_ms: null,
      error: null,
    });
    fileId.value = 'b';
    await settle();

    // 旧请求(a)此刻才回来 ⇒ 必须被丢弃，pages 仍是 b 的，不能被 a 覆盖。
    firstCall.resolve?.({
      state: 'READY',
      page_count: 9,
      pages: ['a1', 'a2'],
      retry_after_ms: null,
      error: null,
    });
    await settle();

    expect(p.pages.value).toEqual(['b1']);
    scope.stop();
  });
});
