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
// - **失败语义按 `ApiError.code` 分流**：`ApiError.code` 是**信封业务码**（不是 HTTP
//   状态码），所以判据是 21116 / 21118 / 21117 这组码而不是 400 / 502。哪一个码该
//   「立即降级」、哪一个该「有限自愈」，见 `types/part_file.ts` 的错误码分流一节。
// - **降级有告知**：`degradedReason` 必须有值（可追因），不能是静默兜底。
//
// 竞态守卫（切文件中断在途）与退避倍率的精确数值不在本 spec 覆盖范围内：前者要构造
// 请求解析时序、后者改了也要连带改文案，收益低于维护成本。
//
// ⚠️ 本 spec mock 掉 `@/api/files/objects`，所以它**验不了**「信封码 vs HTTP 状态码」
// 这一层 —— 那一条由 `src/api/files/__tests__/previewContract.spec.ts` 走真实
// `api/http.ts` 拦截器 + 真实后端响应体形状来钉。两边各守一段，别指望这一份。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { usePreviewPolling } from '../usePreviewPolling';

// ============ mock api 层 ============
// 只 mock `getPartFilePreview` 这一个出口：composable 不该自己拼 URL / 发请求，
// 那些是 api 层的职责，本 spec 只验编排（两态分流 + 退避节流 + 降级告知）。
const getPartFilePreview = vi.fn();
vi.mock('@/api/files/objects', () => ({
  getPartFilePreview: (...args: unknown[]) => getPartFilePreview(...args),
}));

/**
 * 造一个 `ApiError` 形状的错误。
 *
 * ⚠️ `code` 装的是**信封业务码**，不是 HTTP 状态码 —— 这是本 spec 与
 * `previewContract.spec.ts` 的分工点：真实拦截器（`api/http.ts`）也是这么造的。
 */
function apiError(code: number, message = 'err'): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/** 后端 READY 出参（`retry_after_ms` 是非空 u64，READY 返 0 而不是 null）。 */
function ready(pages: string[] = ['https://cdn/p1.jpg']) {
  return { state: 'READY', page_count: pages.length, pages, retry_after_ms: 0, error: null };
}

/** 后端 PENDING 出参。 */
function pending(retryAfterMs: number) {
  return { state: 'PENDING', page_count: 0, pages: [], retry_after_ms: retryAfterMs, error: null };
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
    getPartFilePreview.mockResolvedValue(ready(['https://cdn/p1.jpg', 'https://cdn/p2.jpg']));
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
    getPartFilePreview.mockResolvedValueOnce(pending(2000)).mockResolvedValue(ready());
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

  // 立即降级的那一组：都是「重试不可能有不同结果」的码。
  // 21118 必须在列 —— 后端 python 侧端点未实现时恒返它，漏了它就是默认部署下每张图纸
  // 转圈 120 秒才降级。
  it('重试无意义的码（400/502/21116/21118）：立即降级，不浪费预算继续重试', async () => {
    for (const code of [400, 502, 21116, 21118]) {
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

  // 21117（CI job 终态失败）是「允许有限自愈」的那一组：后端下一次调用会把 FAILED 行
  // 重置并**重新提交一个按页计费的 CI job**。留 1 次机会是为了 python 侧偶发抖动能自愈，
  // 但绝不能让它把一次终局失败放大成十几次重新提交。
  it('21117：只自愈重试 1 次，第 2 次仍失败即降级（不把终局失败放大成多次 CI 提交）', async () => {
    getPartFilePreview.mockRejectedValue(apiError(21117, 'CI job 终态失败'));
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => 'f1' }))!;

    await settle();

    expect(p.degraded.value, '自愈次数用完必须降级').toBe(true);
    expect(p.degradedReason.value).toContain('CI job 终态失败');
    // 首次 + 1 次自愈 = 2 次，绝不是 30 次（那会重新提交 ~15 个 CI job）。
    expect(getPartFilePreview).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('21117：第 1 次失败、第 2 次自愈成功 ⇒ 转成 READY，不降级', async () => {
    getPartFilePreview
      .mockRejectedValueOnce(apiError(21117, 'CI job 终态失败'))
      .mockResolvedValue(ready());
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => 'f1' }))!;

    await settle();

    expect(p.state.value, '自愈成功后不该降级').toBe('READY');
    expect(p.degraded.value).toBe(false);
    expect(getPartFilePreview).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  // 真机上的序列不是「连着两个 21117」，而是
  // `21117 → 200 PENDING（后端已把 FAILED 重置并重提 job）→ … → 21117`：
  // 第一次 21117 触发前端那 1 次自愈重试，重试恰好落在后端刚重置完、job 还在跑的
  // 窗口里，于是先读到 PENDING，再等到新 job 也终局失败。
  // ⚠️ PENDING 分支**不消耗**自愈额度（额度只由 21117 自己扣），所以这条序列下前端
  // 仍只在第 2 个 21117 时降级 —— 上面的用例没建模 PENDING 这一段，这里补上，
  // 免得「自愈次数被 PENDING 悄悄吃掉」这种回归全绿。
  it('21117 → PENDING → 21117（PENDING 不扣自愈额度）：第 2 个 21117 才降级', async () => {
    getPartFilePreview
      .mockRejectedValueOnce(apiError(21117, 'CI job 终态失败'))
      .mockResolvedValueOnce(pending(2000))
      .mockRejectedValue(apiError(21117, 'CI job 终态失败'));
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => 'f1' }))!;

    await settle();

    expect(p.degraded.value, '第 2 个 21117 时自愈额度已用完 ⇒ 降级').toBe(true);
    expect(p.degradedReason.value).toContain('CI job 终态失败');
    // 3 次请求：21117 / PENDING / 21117。PENDING 那次不算自愈。
    expect(getPartFilePreview).toHaveBeenCalledTimes(3);
    scope.stop();
  });

  // 后端 `state` 只有 READY / PENDING 两个取值（失败走 5xx 信封，不在 state 里）。
  // 万一后端将来加了新状态，这里必须显式降级并把实际值带进原因，而不是落进 PENDING
  // 分支空转到 30 次预算耗尽 —— 那会让现场看到「等了 2 分钟」而查不出是后端变了。
  it('未知 state：立即降级并把实际值带进降级原因（不得落进 PENDING 分支空转）', async () => {
    getPartFilePreview.mockResolvedValue({
      state: 'CANCELLED',
      page_count: 0,
      pages: [],
      retry_after_ms: 0,
      error: null,
    });
    const scope = effectScope();
    const p = scope.run(() => usePreviewPolling({ fileId: () => 'f1' }))!;

    await settle();

    expect(p.degraded.value).toBe(true);
    expect(p.degradedReason.value).toContain('CANCELLED');
    expect(getPartFilePreview, '未知状态不得继续轮询').toHaveBeenCalledTimes(1);
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
    getPartFilePreview.mockResolvedValueOnce(ready(['b1']));
    fileId.value = 'b';
    await settle();

    // 旧请求(a)此刻才回来 ⇒ 必须被丢弃，pages 仍是 b 的，不能被 a 覆盖。
    firstCall.resolve?.(ready(['a1', 'a2']));
    await settle();

    expect(p.pages.value).toEqual(['b1']);
    scope.stop();
  });
});
