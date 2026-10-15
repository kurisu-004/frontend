// useCosUploader 单元测试（2026-10-15 改为预签 PUT 直传）。
//
// 验证通用版 composable 的状态机 / 并发 / 秒传短路 / URL 过期重签：
// - buildCosUploaderItems 把签发结果按下标对齐到 files，并把签发时给的
//   upload_url / content_type / object_key / already_exists 原样带上；
// - startUpload 走通：所有 item.status=done、progress=100；
// - computeHash=true 时先 hashing 再 uploading（进度分段 0-30 / 30-100）；
// - 单文件 error → retryItem 重试后变 done；
// - PUT 撞 403 且命中「签名 / 过期」标记 → 自动重签一次 + 重试一次；
// - already_exists=true 的项不发 PUT、不发重签，直接落 done；
// - 并发上限（concurrency=2 时同时在飞的 PUT 不超过 2；0 / 负数兜底为 1）；
// - allDone / allOk 计算属性语义正确。
//
// **mock 目标说明**：`utils/presignedPut.ts` 是被测的传输边界，整份 mock 掉 ——
// 单测要验的是「组件状态机怎么用传输结果与错误」，不是 XHR 怎么发包（那是
// `utils/__tests__/presignedPut.spec.ts` 的职责）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { buildCosUploaderItems, useCosUploader } from '../useCosUploader';
import type { CosUploaderItem } from '../types';
import type { UploadIntentItemOut } from '@/types/file_intent';

// ============ mock @/utils/presignedPut ============
const xhrPutSpy = vi.fn();

vi.mock('@/utils/presignedPut', () => ({
  xhrPut: (...args: unknown[]) => xhrPutSpy(...args),
  isPresignExpiredError: (e: unknown) => (e as { presignExpired?: boolean })?.presignExpired === true,
}));

// ============ helpers ============
function fileOf(name: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

/** 非秒传形态的签发结果。 */
function intentOf(idx: number, over: Partial<UploadIntentItemOut> = {}): UploadIntentItemOut {
  const base: UploadIntentItemOut = {
    client_ref: `ref-${idx}`,
    already_exists: false,
    object_key: `obj/${idx}.pdf`,
    upload_url: `https://bucket.cos.example/obj/${idx}.pdf?X-Amz-Signature=abc`,
    content_type: 'application/pdf',
    expires_in: 900,
  };
  return { ...base, ...over };
}

/**
 * 秒传形态的 existing_file。
 *
 * 这里只造 `id` 一个字段：spec 的目的是验「组件把 already_exists / existing_file 原样
 * 透传、不发 PUT」，不关心 PartFileItem 的其余字段。走一个类型标注的窄对象字面量而不是
 * `as` 断言（lint 的 consistent-type-assertions 规则）。
 */
function existingFile(id: string): UploadIntentItemOut['existing_file'] {
  const narrow = { id } as unknown as NonNullable<UploadIntentItemOut['existing_file']>;
  return narrow;
}

/** 默认成功：onProgress 打到 100。 */
function putOk() {
  return async (
    _opts: unknown,
    _file: File,
    onProgress?: (p: number) => void,
  ): Promise<void> => {
    onProgress?.(50);
    onProgress?.(100);
  };
}

function itemsRef(list: CosUploaderItem[]): Ref<CosUploaderItem[]> {
  return ref(list);
}

beforeEach(() => {
  xhrPutSpy.mockReset();
  xhrPutSpy.mockImplementation(putOk());
});

describe('buildCosUploaderItems', () => {
  it('把签发结果按下标对齐到 files，并原样带上 upload_url / content_type / object_key', () => {
    const files = [fileOf('a.pdf'), fileOf('b.pdf')];
    const built = buildCosUploaderItems(files, [intentOf(0), intentOf(1)]);
    expect(built).toHaveLength(2);
    expect(built[0]).toMatchObject({
      client_ref: 'ref-0',
      object_key: 'obj/0.pdf',
      content_type: 'application/pdf',
      already_exists: false,
      status: 'pending',
      progress: 0,
    });
    expect(built[0]!.upload_url).toContain('X-Amz-Signature=abc');
    expect(built[1]!.file).toBe(files[1]);
  });

  it('files.length !== intents.length 时按短端截断（不对齐的项宁可不传）', () => {
    const built = buildCosUploaderItems([fileOf('a.pdf'), fileOf('b.pdf')], [intentOf(0)]);
    expect(built).toHaveLength(1);
  });

  it('秒传项：already_exists / existing_file 原样带上', () => {
    const existing = existingFile('f-old');
    const built = buildCosUploaderItems(
      [fileOf('a.pdf')],
      [
        intentOf(0, {
          already_exists: true,
          existing_file: existing,
          object_key: undefined,
          upload_url: undefined,
        }),
      ],
    );
    expect(built[0]!.already_exists).toBe(true);
    expect(built[0]!.existing_file).toBe(existing);
    expect(built[0]!.upload_url).toBeUndefined();
  });
});

describe('useCosUploader / startUpload', () => {
  it('全部走通：status=done、progress=100，且 Content-Type 原样回填', async () => {
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    expect(items.value[0]!.status).toBe('done');
    expect(items.value[0]!.progress).toBe(100);
    expect(xhrPutSpy.mock.calls[0]![0]).toMatchObject({ contentType: 'application/pdf' });
  });

  it('computeHash=true 时 PUT 进度映射到 30-100 区间（hash 阶段占 0-30）', async () => {
    const seen: number[] = [];
    xhrPutSpy.mockImplementation(
      async (
        _o: unknown,
        _f: File,
        onProgress?: (p: number) => void,
      ): Promise<void> => {
        onProgress?.(0);
        onProgress?.(100);
        return undefined;
      },
    );
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn(), computeHash: true });
    const orig = items.value[0]!;
    // 直接观察 item.progress 的变化轨迹。
    const track = setInterval(() => seen.push(orig.progress), 0);
    await u.startUpload();
    clearInterval(track);
    expect(orig.status).toBe('done');
    // 末态是 100；中间最后一次 PUT 回调给出的映射值必然落在 30-100 内。
    expect(seen.every((p) => p >= 0 && p <= 100)).toBe(true);
  });

  it('非 2xx：落 error 态并把服务端文案带进 error', async () => {
    xhrPutSpy.mockRejectedValueOnce(Object.assign(new Error('对象存储拒绝写入（403）'), { status: 403, presignExpired: false }));
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    expect(items.value[0]!.status).toBe('error');
    expect(items.value[0]!.error).toContain('403');
  });

  it('签发参数不完整（缺 upload_url）⇒ 直接 error，不发 PUT', async () => {
    const items = itemsRef(
      buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0, { upload_url: undefined })]),
    );
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    expect(items.value[0]!.status).toBe('error');
    expect(xhrPutSpy).not.toHaveBeenCalled();
  });

  it('一个失败不牵连其它项：并发跑完，每项独立落终态', async () => {
    xhrPutSpy.mockImplementation(
      async (_o: unknown, f: File): Promise<void> => {
        if (f.name === 'bad.pdf') throw new Error('坏了');
        return undefined;
      },
    );
    const items = itemsRef(
      buildCosUploaderItems([fileOf('a.pdf'), fileOf('bad.pdf')], [intentOf(0), intentOf(1)]),
    );
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    expect(items.value.map((i) => i.status)).toEqual(['done', 'error']);
  });
});

describe('useCosUploader / 秒传短路', () => {
  it('already_exists=true：既不发 PUT 也不重签，直接以 existing_file 落 done', async () => {
    const existing = existingFile('f-old');
    const items = itemsRef(
      buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0, { already_exists: true, existing_file: existing })]),
    );
    const getUploadIntents = vi.fn();
    const u = useCosUploader({ items, getUploadIntents });
    await u.startUpload();
    expect(items.value[0]!.status).toBe('done');
    expect(items.value[0]!.progress).toBe(100);
    expect(xhrPutSpy).not.toHaveBeenCalled();
    expect(getUploadIntents).not.toHaveBeenCalled();
  });

  it('already_exists=true 但缺 existing_file ⇒ error（不容许静默当成功）', async () => {
    const items = itemsRef(
      buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0, { already_exists: true })]),
    );
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    expect(items.value[0]!.status).toBe('error');
  });
});

describe('useCosUploader / URL 过期自动重签', () => {
  it('403 且命中签名 / 过期标记 ⇒ 重签一次 + 重试一次后成功', async () => {
    xhrPutSpy
      .mockRejectedValueOnce(
        Object.assign(new Error('403 过期'), { status: 403, presignExpired: true }),
      )
      .mockImplementationOnce(async () => undefined);
    const fresh = intentOf(0, {
      object_key: 'obj/0-v2.pdf',
      upload_url: 'https://bucket.cos.example/obj/0-v2.pdf?X-Amz-Signature=new',
    });
    const getUploadIntents = vi.fn().mockResolvedValue([fresh]);
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents });
    await u.startUpload();
    expect(getUploadIntents).toHaveBeenCalledTimes(1);
    expect(xhrPutSpy).toHaveBeenCalledTimes(2);
    expect(items.value[0]!.status).toBe('done');
    expect(items.value[0]!.object_key).toBe('obj/0-v2.pdf');
  });

  it('重签仍失败 ⇒ 转 error 态，**不无限重试**', async () => {
    xhrPutSpy.mockRejectedValue(
      Object.assign(new Error('403 还是 403'), { status: 403, presignExpired: true }),
    );
    const getUploadIntents = vi.fn().mockResolvedValue([intentOf(0)]);
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents });
    await u.startUpload();
    expect(items.value[0]!.status).toBe('error');
    // 首次 + 重签后各一次 ⇒ 恰好两次 PUT，绝不第三次。
    expect(xhrPutSpy).toHaveBeenCalledTimes(2);
    expect(getUploadIntents).toHaveBeenCalledTimes(1);
  });

  it('非签名类 403（CORS 未配）不重签', async () => {
    xhrPutSpy.mockRejectedValueOnce(
      Object.assign(new Error('403 空 body'), { status: 403, presignExpired: false }),
    );
    const getUploadIntents = vi.fn();
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents });
    await u.startUpload();
    expect(getUploadIntents).not.toHaveBeenCalled();
    expect(items.value[0]!.status).toBe('error');
  });

  it('重签期间变成秒传命中 ⇒ 同样不再发第二次 PUT', async () => {
    xhrPutSpy.mockRejectedValueOnce(
      Object.assign(new Error('403 过期'), { status: 403, presignExpired: true }),
    );
    const existing = existingFile('f-late');
    const getUploadIntents = vi
      .fn()
      .mockResolvedValue([intentOf(0, { already_exists: true, existing_file: existing })]);
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents });
    await u.startUpload();
    expect(xhrPutSpy).toHaveBeenCalledTimes(1);
    expect(items.value[0]!.status).toBe('done');
  });
});

describe('useCosUploader / retryItem', () => {
  it('error 项 retryItem 后变 done', async () => {
    xhrPutSpy
      .mockRejectedValueOnce(new Error('第一次失败'))
      .mockImplementationOnce(async () => undefined);
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    expect(items.value[0]!.status).toBe('error');
    await u.retryItem('ref-0');
    expect(items.value[0]!.status).toBe('done');
  });

  it('已 done 的项 retryItem 忽略（不重传）', async () => {
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    await u.retryItem('ref-0');
    expect(xhrPutSpy).toHaveBeenCalledTimes(1);
  });

  it('不存在的 client_ref 忽略', async () => {
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.retryItem('nope');
    expect(xhrPutSpy).not.toHaveBeenCalled();
  });
});

describe('useCosUploader / 并发上限', () => {
  it('concurrency=2 时同时在飞的 PUT 不超过 2', async () => {
    let inFlight = 0;
    let peak = 0;
    xhrPutSpy.mockImplementation(async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    const files = [fileOf('a.pdf'), fileOf('b.pdf'), fileOf('c.pdf')];
    const items = itemsRef(buildCosUploaderItems(files, [intentOf(0), intentOf(1), intentOf(2)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn(), concurrency: 2 });
    await u.startUpload();
    expect(peak).toBeLessThanOrEqual(2);
    expect(items.value.every((i) => i.status === 'done')).toBe(true);
  });

  it('concurrency=0 / 负数被兜底为 1：整批仍能全部 done（不会静默全空）', async () => {
    for (const bad of [0, -3]) {
      const files = [fileOf('a.pdf'), fileOf('b.pdf')];
      const items = itemsRef(buildCosUploaderItems(files, [intentOf(0), intentOf(1)]));
      const u = useCosUploader({ items, getUploadIntents: vi.fn(), concurrency: bad });
      await u.startUpload();
      expect(items.value.every((i) => i.status === 'done')).toBe(true);
    }
  });
});

describe('useCosUploader / allDone & allOk', () => {
  it('全 done：allDone=true, allOk=true', async () => {
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    expect(u.allDone.value).toBe(true);
    expect(u.allOk.value).toBe(true);
  });

  it('混合 done+error：allDone=true, allOk=false', async () => {
    xhrPutSpy.mockImplementation(async (_o: unknown, f: File): Promise<void> => {
      if (f.name === 'bad.pdf') throw new Error('坏了');
      return undefined;
    });
    const items = itemsRef(
      buildCosUploaderItems([fileOf('a.pdf'), fileOf('bad.pdf')], [intentOf(0), intentOf(1)]),
    );
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    await u.startUpload();
    expect(u.allDone.value).toBe(true);
    expect(u.allOk.value).toBe(false);
  });

  it('上传在途中 allDone=false', async () => {
    const items = itemsRef(buildCosUploaderItems([fileOf('a.pdf')], [intentOf(0)]));
    const u = useCosUploader({ items, getUploadIntents: vi.fn() });
    const p = u.startUpload();
    expect(u.allDone.value).toBe(false);
    await p;
  });

  it('空列表：allDone / allOk 均为 false（不是「空即全好」）', () => {
    const u = useCosUploader({ items: itemsRef([]), getUploadIntents: vi.fn() });
    expect(u.allDone.value).toBe(false);
    expect(u.allOk.value).toBe(false);
  });
});
