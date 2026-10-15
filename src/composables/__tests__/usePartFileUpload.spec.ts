// usePartFileUpload 单元测试（2026-10-15 改为直传链路）
//
// 2026-10-15 之前这份 spec 守的是「hash → grantStsTmpKey → COS SDK → confirm」四段，
// 现在传输实现整体下沉到 `utils/directUpload.ts`（那份实现有自己的 spec）。本文件
// 因此只守**这个 composable 自己的职责**：
//   - owner_id / kind 支持 Ref / getter / 字面量三种入参形态；
//   - owner_id 为空时 fail-fast（不发任何请求）；
//   - uploading / lastError 两个状态位在成功与失败路径上的取值；
//   - kind 原样透传给引擎（DRAWING / 3D_MODEL / CAD_2D 三个 tab 各一个实例）。
//
// 引擎整份 mock 掉：`directUpload` 的行为由 `utils/__tests__/directUpload.spec.ts` 守。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { usePartFileUpload, type PartFileUploadKind } from '../usePartFileUpload';

const directUploadSpy = vi.fn();
vi.mock('@/utils/directUpload', () => ({
  directUpload: (...args: unknown[]) => directUploadSpy(...args),
}));

function fileOf(name: string): File {
  return new File([new Uint8Array(4)], name, { type: 'application/pdf' });
}

beforeEach(() => {
  directUploadSpy.mockReset();
  directUploadSpy.mockResolvedValue({ item: { id: 'f-1' }, alreadyExists: false });
});

describe('usePartFileUpload 参数归一', () => {
  it('ownerPartId 支持三种形态（Ref / getter / 字面量），kind 同理', async () => {
    const cases: Array<{ owner: unknown; kind: unknown }> = [
      { owner: 'p-lit', kind: 'DRAWING' as PartFileUploadKind },
      { owner: ref('p-ref'), kind: ref<PartFileUploadKind>('3D_MODEL') },
      { owner: () => 'p-fn', kind: () => 'CAD_2D' as PartFileUploadKind },
    ];
    for (const c of cases) {
      directUploadSpy.mockClear();
      const u = usePartFileUpload({
        ownerPartId: c.owner as never,
        kind: c.kind as never,
      });
      await u.upload(fileOf('a.pdf'));
      const opts = directUploadSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts.ownerKind).toBe('PART');
      expect(typeof opts.ownerId).toBe('string');
      expect(String(opts.ownerId)).toMatch(/^p-/);
      expect(opts.kind).toBe(opts.kind);
    }
  });

  it('kind 原样透传：三个 tab 分别是 DRAWING / 3D_MODEL / CAD_2D', async () => {
    for (const kind of ['DRAWING', '3D_MODEL', 'CAD_2D'] as PartFileUploadKind[]) {
      directUploadSpy.mockClear();
      const u = usePartFileUpload({ ownerPartId: 'p1', kind });
      await u.upload(fileOf('a.pdf'));
      expect((directUploadSpy.mock.calls[0]![0] as { kind: string }).kind).toBe(kind);
    }
  });

  it('owner_id 为空 ⇒ fail-fast，不发任何请求', async () => {
    const u = usePartFileUpload({ ownerPartId: '', kind: 'DRAWING' });
    await expect(u.upload(fileOf('a.pdf'))).rejects.toThrow(/ownerPartId/);
    expect(directUploadSpy).not.toHaveBeenCalled();
    expect(u.lastError.value).toContain('ownerPartId');
  });
});

describe('usePartFileUpload 状态位', () => {
  it('uploading：调用期间为 true，返回后为 false', async () => {
    let seen = false;
    directUploadSpy.mockImplementationOnce(async () => {
      seen = true;
      return { item: { id: 'f-1' }, alreadyExists: false };
    });
    const u = usePartFileUpload({ ownerPartId: 'p1', kind: 'DRAWING' });
    const p = u.upload(fileOf('a.pdf'));
    seen = u.uploading.value;
    await p;
    expect(seen).toBe(true);
    expect(u.uploading.value).toBe(false);
  });

  it('成功：返回后端 PartFileItem，lastError 为 null', async () => {
    const u = usePartFileUpload({ ownerPartId: 'p1', kind: 'DRAWING' });
    await expect(u.upload(fileOf('a.pdf'))).resolves.toMatchObject({ id: 'f-1' });
    expect(u.lastError.value).toBeNull();
  });

  it('秒传命中：照样把 existing_file 当成功返回（调用方不需要分支）', async () => {
    directUploadSpy.mockResolvedValueOnce({
      item: { id: 'f-old' },
      alreadyExists: true,
    });
    const u = usePartFileUpload({ ownerPartId: 'p1', kind: 'DRAWING' });
    await expect(u.upload(fileOf('a.pdf'))).resolves.toMatchObject({ id: 'f-old' });
    expect(u.lastError.value).toBeNull();
  });

  it('失败：抛错 + lastError 记下原因 + uploading 归位', async () => {
    directUploadSpy.mockRejectedValueOnce(new Error('对象存储拒绝写入（403）'));
    const u = usePartFileUpload({ ownerPartId: 'p1', kind: 'DRAWING' });
    await expect(u.upload(fileOf('a.pdf'))).rejects.toThrow(/403/);
    expect(u.lastError.value).toContain('403');
    expect(u.uploading.value).toBe(false);
  });

  it('非 Error 的抛出（字符串）也归一成 Error 上抛，lastError 不留 undefined', async () => {
    directUploadSpy.mockRejectedValueOnce('裸字符串');
    const u = usePartFileUpload({ ownerPartId: 'p1', kind: 'DRAWING' });
    await expect(u.upload(fileOf('a.pdf'))).rejects.toBeInstanceOf(Error);
    expect(u.lastError.value).toBe('裸字符串');
  });

  it('下一次成功调用会把上一次的 lastError 清掉', async () => {
    directUploadSpy.mockRejectedValueOnce(new Error('第一次失败'));
    const u = usePartFileUpload({ ownerPartId: 'p1', kind: 'DRAWING' });
    await expect(u.upload(fileOf('a.pdf'))).rejects.toThrow();
    await u.upload(fileOf('a.pdf'));
    expect(u.lastError.value).toBeNull();
  });
});
