// views/outsource/composables/__tests__/outsourceQueueErrorMessage.spec.ts
//
// 守 `outsourceQueueErrorText` 的两条契约（2026-10-09 新增）：
//   1. ZodError（契约漂移）⇒ 固定人话 + 细节只进 console。旧后端漏发
//      `has_process_chain` 时这条分支是外协域唯一的兜底；
//   2. 其它异常 ⇒ 原样 message、缺 message 回落 fallback（网络 500 / 后端信封文案
//      一字不变，不能被这个收口改写）。
//
// 环境用默认 node：纯函数，不碰 DOM。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import {
  OUTSOURCE_QUEUE_CONTRACT_DRIFT_TEXT,
  outsourceQueueErrorText,
} from '../outsourceQueueErrorMessage';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('outsourceQueueErrorText', () => {
  it('ZodError：收口成固定文案，原始 error（含 issues）只进 console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const zodError = (() => {
      try {
        // 真造一个契约漂移的 ZodError（缺必填键），别手搓 issue 对象
        return z.object({ has_process_chain: z.boolean() }).parse({});
      } catch (e) {
        return e;
      }
    })();

    expect(zodError).toBeInstanceOf(ZodError);
    expect(outsourceQueueErrorText(zodError, '外协看板加载失败')).toBe(
      OUTSOURCE_QUEUE_CONTRACT_DRIFT_TEXT,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(zodError);
  });

  it('非 ZodError：原样返回 message（后端信封文案一字不改）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(outsourceQueueErrorText(new Error('网络异常'), '外协看板加载失败')).toBe('网络异常');
    expect(spy).not.toHaveBeenCalled();
  });

  it('message 为 null / undefined ⇒ 回落 fallback；空串原样返回（`??` 只兜 nullish）', () => {
    expect(outsourceQueueErrorText(null, '外协看板加载失败')).toBe('外协看板加载失败');
    expect(outsourceQueueErrorText(undefined, '外协看板加载失败')).toBe('外协看板加载失败');
    expect(outsourceQueueErrorText(new Error(''), '外协看板加载失败')).toBe('');
  });
});
