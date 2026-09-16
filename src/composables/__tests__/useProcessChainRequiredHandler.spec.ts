// 2026-09-16 PR-3 新增：20706 BIZ_PROCESS_CHAIN_REQUIRED 兜底单测。
//
// 覆盖：
// - isProcessChainRequiredError：true / false / 非 ApiError 三分支
// - handleProcessChainRequired：弹框确认 → 跳路由；弹框取消 → 不跳；非 20706 → 不弹框不跳
// - part_id 缺省时：不带 ?part_id= deep link

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/http';

const mockConfirm = vi.fn();

vi.mock('element-plus', () => ({
  ElMessageBox: {
    confirm: mockConfirm,
  },
}));

const routerPush = vi.fn(async () => undefined);

const { BIZ_PROCESS_CHAIN_REQUIRED, isProcessChainRequiredError, handleProcessChainRequired } =
  await import('../useProcessChainRequiredHandler');

beforeEach(() => {
  vi.clearAllMocks();
  routerPush.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BIZ_PROCESS_CHAIN_REQUIRED 常量', () => {
  it('常量值 === 20706', () => {
    expect(BIZ_PROCESS_CHAIN_REQUIRED).toBe(20706);
  });
});

describe('isProcessChainRequiredError', () => {
  it('ApiError(code=20706) → true', () => {
    const e = new ApiError(20706, '请先制定工序链');
    expect(isProcessChainRequiredError(e)).toBe(true);
  });

  it('ApiError(code=20103) → false', () => {
    const e = new ApiError(20103, 'INVALID_TRANSITION');
    expect(isProcessChainRequiredError(e)).toBe(false);
  });

  it('普通 Error → false（无 code 字段）', () => {
    const e = new Error('boom');
    expect(isProcessChainRequiredError(e)).toBe(false);
  });

  it('null / undefined → false', () => {
    expect(isProcessChainRequiredError(null)).toBe(false);
    expect(isProcessChainRequiredError(undefined)).toBe(false);
  });

  it('空对象 / 非 object → false', () => {
    expect(isProcessChainRequiredError(20706)).toBe(false);
    expect(isProcessChainRequiredError('BIZ_PROCESS_CHAIN_REQUIRED')).toBe(false);
    expect(isProcessChainRequiredError({})).toBe(false);
  });

  it('code 字段类型不匹配 → false', () => {
    expect(isProcessChainRequiredError({ code: '20706' })).toBe(false);
  });
});

describe('handleProcessChainRequired', () => {
  it('20706 + 用户确认 → router.push 带 part_id 深链', async () => {
    mockConfirm.mockResolvedValueOnce('confirm');
    const e = new ApiError(20706, '请先制定工序链');
    const r = await handleProcessChainRequired(e, '1900000000001', {
      push: routerPush,
    });
    expect(r).toBe(true);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/production/process-design?part_id=1900000000001');
  });

  it('20706 + 用户确认 + partId=null → router.push 不带 ?part_id', async () => {
    mockConfirm.mockResolvedValueOnce('confirm');
    const e = new ApiError(20706, '请先制定工序链');
    const r = await handleProcessChainRequired(e, null, { push: routerPush });
    expect(r).toBe(true);
    expect(routerPush).toHaveBeenCalledWith('/production/process-design');
  });

  it('20706 + 用户确认 + partId=undefined → 不带 ?part_id', async () => {
    mockConfirm.mockResolvedValueOnce('confirm');
    const e = new ApiError(20706, '请先制定工序链');
    const r = await handleProcessChainRequired(e, undefined, { push: routerPush });
    expect(r).toBe(true);
    expect(routerPush).toHaveBeenCalledWith('/production/process-design');
  });

  it('20706 + 用户取消 → 不跳路由，return true（已处理）', async () => {
    mockConfirm.mockRejectedValueOnce(new Error('cancel'));
    const e = new ApiError(20706, '请先制定工序链');
    const r = await handleProcessChainRequired(e, '1900000000001', {
      push: routerPush,
    });
    expect(r).toBe(true);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('非 20706 → 不弹框、不跳路由，return false', async () => {
    const e = new ApiError(20103, 'INVALID_TRANSITION');
    const r = await handleProcessChainRequired(e, '1900000000001', {
      push: routerPush,
    });
    expect(r).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('20706 + 弹框消息取 e.message', async () => {
    mockConfirm.mockResolvedValueOnce('confirm');
    const e = new ApiError(20706, '请先制定工序链');
    await handleProcessChainRequired(e, '1900000000001', { push: routerPush });
    expect(mockConfirm).toHaveBeenCalledWith(
      '请先制定工序链，是否前往工序制定页？',
      '需要先制定工序链',
      expect.objectContaining({
        type: 'warning',
        confirmButtonText: '前往制定',
        cancelButtonText: '取消',
      }),
    );
  });

  it('20706 + e.message 缺失 → 回退文案', async () => {
    mockConfirm.mockResolvedValueOnce('confirm');
    const e = new ApiError(20706, '');
    await handleProcessChainRequired(e, '1900000000001', { push: routerPush });
    expect(mockConfirm).toHaveBeenCalledWith(
      '请先制定工序链，是否前往工序制定页？',
      '需要先制定工序链',
      expect.any(Object),
    );
  });
});
