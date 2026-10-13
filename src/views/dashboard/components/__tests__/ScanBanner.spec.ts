// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/ScanBanner.spec.ts
//
// 报工台业务事件条（消费 SCAN_BANNER）的回归守卫。
//
// 这批用例守两件容易静默坏掉的事：
//
//   1. **守门真的接在返回路径上**（S3 / S4）。`onEvent` 里那行 `safeParse` 一旦被摘掉，
//      组件不会报任何错 —— 坏事件的 `data` 会原样流进 `composeText`，渲染出
//      「张三领取 undefined x undefined」这种垃圾文案。这正是 CLAUDE.md 登记过的
//      教训（api 层 parse 摘掉时全部用例仍绿、线上崩）：把 parse 整段删掉，本文件的
//      S3 / S4 必须变红，否则这次 Zod 守门是零测试信号。
//   2. **文案组装口径**（S1 / S2）：序列号兜底图纸号、交期空则整段连括号省略。
//
// 桩的取舍：`@/api/dashboard` 整模块桩掉（只留 onDashboardEvent，本用例直接拿到
// 注册进去的 handler 手动喂帧），`el-button` / `el-icon` 挂真 EP 组件。组件根是
// Teleport，所以断言一律走 `document.body.querySelectorAll`，不看 wrapper.html()。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ElButton, ElIcon } from 'element-plus';

interface WsEvent {
  type: 'event';
  event_type: string;
  data: Record<string, unknown>;
  ts: string;
}

const h = vi.hoisted(() => ({
  handlers: new Set<(ev: WsEvent) => void>(),
  off: vi.fn(),
}));

vi.mock('@/api/dashboard', () => ({
  onDashboardEvent: (cb: (ev: WsEvent) => void) => {
    h.handlers.add(cb);
    return () => {
      h.handlers.delete(cb);
      h.off();
    };
  },
}));

import ScanBanner from '../ScanBanner.vue';

/** 造一条 SCAN_BANNER 帧。 */
function bannerEvent(data: Record<string, unknown>, eventType = 'SCAN_BANNER'): WsEvent {
  return { type: 'event', event_type: eventType, data, ts: '2026-10-13T10:00:00+08:00' };
}

function goodPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'PICKED_UP',
    worker_name: '张三',
    serial_no: 'F1234',
    drawing_no: 'DWG-9',
    quantity: 20,
    system_delivery_date: '2026-10-27',
    ...over,
  };
}

/** 把一帧推进 WS 层（全部订阅者都会收到）。 */
async function pushEvent(ev: WsEvent): Promise<void> {
  for (const cb of h.handlers) cb(ev);
  await nextTick();
}

function banners(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('.scan-banner')) as HTMLElement[];
}

function texts(): string[] {
  return banners().map((el) => (el.querySelector('.scan-banner-text')?.textContent ?? '').trim());
}

function mountBanner(): VueWrapper {
  return mount(ScanBanner, {
    attachTo: document.body,
    global: { components: { ElButton, ElIcon } },
  });
}

describe('ScanBanner — SCAN_BANNER 事件条（2026-10-13）', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.handlers.clear();
    h.off.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('S1：文案按「工人 + 动作 + 序列号 x 数量 (交期)」组装', async () => {
    mountBanner();
    await pushEvent(bannerEvent(goodPayload()));

    expect(texts()).toEqual(['张三领取 F1234 x 20 (10-27)']);
  });

  it('S1b：serial_no 为 null 时回落 drawing_no', async () => {
    mountBanner();
    await pushEvent(bannerEvent(goodPayload({ serial_no: null })));

    expect(texts()).toEqual(['张三领取 DWG-9 x 20 (10-27)']);
  });

  it('S1c：交期为空则整段连括号一起省略（不留空括号）', async () => {
    mountBanner();
    await pushEvent(bannerEvent(goodPayload({ system_delivery_date: null })));

    expect(texts()).toEqual(['张三领取 F1234 x 20']);
  });

  it('S1d：交期带时刻（NaiveDateTime 形态）也只取 M-DD', async () => {
    mountBanner();
    await pushEvent(bannerEvent(goodPayload({ system_delivery_date: '2026-10-27T00:00:00' })));

    expect(texts()).toEqual(['张三领取 F1234 x 20 (10-27)']);
  });

  it.each([
    ['PICKED_UP', '领取'],
    ['RETURNED', '放回'],
    ['INSPECTED', '送检'],
  ])('S2：action=%s 的动作词是「%s」', async (action, word) => {
    mountBanner();
    await pushEvent(bannerEvent(goodPayload({ action })));

    expect(texts()[0]).toContain(word);
  });

  it('S3（守门守卫）：payload 不合契约 → 丢弃这一条并 warn，不崩', async () => {
    const wrapper = mountBanner();

    await expect(
      pushEvent(bannerEvent(goodPayload({ quantity: '20' as unknown as number }))),
    ).resolves.toBeUndefined();

    expect(banners()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('SCAN_BANNER');
    // 订阅仍然活着：下一条好事件照常渲染（证明没有把整个订阅链带走）
    await pushEvent(bannerEvent(goodPayload()));
    expect(texts()).toEqual(['张三领取 F1234 x 20 (10-27)']);
    expect(wrapper.exists()).toBe(true);
  });

  it('S4（守门守卫）：必填键缺失 → 丢弃（schema 少声明一个字段时这里就会红）', async () => {
    mountBanner();

    const missingWorker = goodPayload();
    delete missingWorker.worker_name;
    await pushEvent(bannerEvent(missingWorker));
    expect(banners()).toHaveLength(0);

    const missingDrawing = goodPayload();
    delete missingDrawing.drawing_no;
    await pushEvent(bannerEvent(missingDrawing));
    expect(banners()).toHaveLength(0);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('S5：非 SCAN_BANNER 事件一律不弹条（本组件只消费带展示字段的那一个 kind）', async () => {
    mountBanner();

    await pushEvent(bannerEvent(goodPayload(), 'PART_TO_SHIP'));
    await pushEvent(bannerEvent(goodPayload(), 'WORKER_SCAN_RETURNED'));

    expect(banners()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('S6：最多堆叠 3 条，新的在上', async () => {
    mountBanner();
    for (const i of [1, 2, 3, 4]) {
      await pushEvent(bannerEvent(goodPayload({ quantity: i })));
    }

    expect(texts()).toEqual([
      '张三领取 F1234 x 4 (10-27)',
      '张三领取 F1234 x 3 (10-27)',
      '张三领取 F1234 x 2 (10-27)',
    ]);
  });

  it('S7：4s 自动消失；悬停暂停、离开恢复', async () => {
    vi.useFakeTimers();
    try {
      mountBanner();
      await pushEvent(bannerEvent(goodPayload()));
      expect(banners()).toHaveLength(1);

      // 悬停暂停：推到 10s 也不该消失
      const el = banners()[0]!;
      el.dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(10_000);
      await nextTick();
      expect(banners()).toHaveLength(1);

      // 离开恢复计时：再过 4s 消失
      el.dispatchEvent(new MouseEvent('mouseleave'));
      vi.advanceTimersByTime(4_000);
      await nextTick();
      expect(banners()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('S8：卸载时退订并清掉全部定时器', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountBanner();
      await pushEvent(bannerEvent(goodPayload()));
      expect(banners()).toHaveLength(1);

      wrapper.unmount();

      expect(h.handlers.size).toBe(0);
      expect(h.off).toHaveBeenCalledTimes(1);
      // 定时器已清：再推 10s 不会有任何残留回调炸掉（无未捕获异常即通过）
      vi.advanceTimersByTime(10_000);
      await nextTick();
    } finally {
      vi.useRealTimers();
    }
  });

  it('S9：语义色走类绑定而不是模板 inline :style', async () => {
    // CLAUDE.md 硬约束：inline :style 优先于任何非 !important 规则，会盖掉后续任何
    // 按状态改 border-color 的规则（同仓 BatchCard / PartRowCard 踩过）。
    const wrapper = mountBanner();
    await pushEvent(bannerEvent(goodPayload({ action: 'RETURNED' })));

    const el = banners()[0]!;
    expect(el.className).toContain('is-returned');
    expect(el.getAttribute('style')).toBeNull();
    expect(wrapper.html()).not.toContain('border-left-color');
  });
});
