// src/utils/__tests__/contractDriftError.spec.ts
//
// 2026-10-10 新增：跨域文案收口 `contractDriftErrorText` 的行为锁定。
//
// 锁的是三条真值表：**ZodError ⇒ 固定人话 + console.error（细节）**、普通 Error ⇒ message
// 逐字透传、无 message ⇒ 回落 fallback。这条收口替两个域挡着（`views/scan` 报工台列表、
// `views/users` 账号列表 / 企微绑定），一旦行为漂移，两边都是把 issues 的 JSON 甩给用户。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { contractDriftErrorText } from '../contractDriftError';

const OPTS = {
  driftText: '固定人话',
  fallback: '兜底文案',
  logTag: '[test] 响应未通过 Zod 契约守门',
};

const zodError = new ZodError([{ code: 'custom', path: ['data', 'id'], message: 'boom' }]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contractDriftErrorText（Zod 契约漂移文案收口）', () => {
  it('ZodError ⇒ 固定人话，且原始 error（含 issues）进 console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(contractDriftErrorText(zodError, OPTS)).toBe('固定人话');
    expect(spy).toHaveBeenCalledTimes(1);
    // 第一个参数是带域标签的可 grep 串，第二个是原始 ZodError（排障细节不能丢）。
    expect(spy.mock.calls[0]?.[0]).toContain('[test]');
    expect(spy.mock.calls[0]?.[1]).toBe(zodError);
  });

  it('普通 Error ⇒ message 逐字透传（后端业务文案不能被改写）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(contractDriftErrorText(new Error('后端 20601'), OPTS)).toBe('后端 20601');
    // 非漂移失败不该刷 console（错误码分支的排障靠后端 message 本身）。
    expect(spy).not.toHaveBeenCalled();
  });

  it('message 为空串 ⇒ 逐字透传空串（不回落 fallback，与调用点原先的 ?? 行为一致）', () => {
    expect(contractDriftErrorText(new Error(''), OPTS)).toBe('');
  });

  it('无 message（裸对象 / null / undefined）⇒ 回落 fallback，不抛 TypeError', () => {
    expect(contractDriftErrorText({}, OPTS)).toBe('兜底文案');
    expect(contractDriftErrorText(null, OPTS)).toBe('兜底文案');
    expect(contractDriftErrorText(undefined, OPTS)).toBe('兜底文案');
  });

  it('AxiosError 这类「像 Error 的实例」⇒ 仍取 message（不因 instanceof ZodError 而误判）', () => {
    const axiosLike = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
    expect(contractDriftErrorText(axiosLike, OPTS)).toBe('Network Error');
  });
});
