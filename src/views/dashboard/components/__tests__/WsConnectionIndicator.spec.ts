// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/WsConnectionIndicator.spec.ts
//
// WS 连接状态指示器的四态回归守卫。
//
// 核心守卫是 W4：`closed` 必须按 `expected` 分流。主动关闭（登出 / token 刷新换连接）
// 与真实断开在 ConnectionStatus 上是同一个 'closed'，但对 UI 含义完全相反 ——
// 标红主动关闭会养成「无视红点」的习惯，真断线时也就没人看了；而反过来把真断线
// 显示成灰点，dashboard 域零轮询 + gcTime 无限 ⇒ 大屏静默停更没人知道。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { ElTooltip } from 'element-plus';
import type { DashboardConnectionState } from '@/types/dashboard';

const h = vi.hoisted(() => ({
  handler: null as null | ((s: unknown) => void),
  off: vi.fn(),
}));

// 回放语义与真实实现一致：注册瞬间先回调一次当前状态（onDashboardConnection 的
// 「订阅即刻回放」）。这里把初始状态固定成 open，让「后挂的组件也能拿到当前状态」
// 这条纪律在组件侧也被覆盖到。
vi.mock('@/api/dashboard', () => ({
  onDashboardConnection: (cb: (s: unknown) => void) => {
    h.handler = cb;
    cb({ status: 'open', expected: false, retries: 0, lastError: null });
    return () => {
      h.handler = null;
      h.off();
    };
  },
}));

import WsConnectionIndicator from '../WsConnectionIndicator.vue';

function mountIndicator() {
  return mount(WsConnectionIndicator, {
    attachTo: document.body,
    global: { components: { ElTooltip } },
  });
}

/** 推进一条连接状态并等重渲染。 */
async function emit(state: DashboardConnectionState): Promise<void> {
  h.handler?.(state);
  await nextTick();
}

function indicator(): HTMLElement {
  return document.body.querySelector('.ws-indicator') as HTMLElement;
}

function label(): string {
  return indicator().querySelector('.ws-label')?.textContent?.trim() ?? '';
}

describe('WsConnectionIndicator — 四态连接指示器（2026-10-13）', () => {
  beforeEach(() => {
    h.handler = null;
    h.off.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('W1：open → 绿点 + 「已连接」', async () => {
    mountIndicator();
    await emit({ status: 'open', expected: false, retries: 0, lastError: null });

    expect(indicator().className).toContain('is-open');
    expect(label()).toBe('已连接');
  });

  it('W2：connecting → 黄点 + 「重连中…」（带呼吸动画）', async () => {
    mountIndicator();
    await emit({ status: 'connecting', expected: false, retries: 3, lastError: null });

    expect(indicator().className).toContain('is-connecting');
    expect(label()).toBe('重连中…');
    expect(label()).toContain('重连中');
  });

  it('W3：closed 且非 expected（真断线）→ 红点 + 「已断开」', async () => {
    mountIndicator();
    await emit({
      status: 'closed',
      expected: false,
      retries: 2,
      lastError: { code: 1006, reason: '' },
    });

    expect(indicator().className).toContain('is-disconnected');
    expect(label()).toBe('已断开');
  });

  it('W4：closed 且 expected（token 刷新换连接）→ 灰点 + 「已连接」，不 alarming', async () => {
    mountIndicator();
    await emit({ status: 'closed', expected: true, retries: 0, lastError: null });

    expect(indicator().className).toContain('is-expected-closed');
    expect(indicator().className).not.toContain('is-disconnected');
    expect(label()).toBe('已连接');
  });

  it('W5：诊断信息（重试次数 / close code / reason）留在 tooltip 里，header 只显示四态文案', async () => {
    const wrapper = mountIndicator();
    await emit({
      status: 'closed',
      expected: false,
      retries: 5,
      lastError: { code: 4003, reason: 'lagged' },
    });

    // content 走 prop（不 hover 时 ElTooltip 不渲染 popper），从组件 prop 上断言。
    const content = String(wrapper.findComponent(ElTooltip).props('content'));
    expect(content).toContain('已断开');
    expect(content).toContain('已重试 5 次');
    expect(content).toContain('4003');
    expect(content).toContain('lagged');

    // header 里只有四态那一句，诊断信息不外泄
    expect(label()).toBe('已断开');
    expect(indicator().textContent).not.toContain('4003');
  });

  it('W6：卸载时退订', () => {
    const wrapper = mountIndicator();
    wrapper.unmount();

    expect(h.off).toHaveBeenCalledTimes(1);
    expect(h.handler).toBeNull();
  });
});
