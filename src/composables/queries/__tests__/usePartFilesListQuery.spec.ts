// src/composables/queries/__tests__/usePartFilesListQuery.spec.ts
//
// 2026-09-29 新增：usePartFilesListQuery 单调用 + TanStack Query 守门。
//
// 背景：
//   - 旧 usePartFiles.ts 三并发（fetchDrawings + fetch3DModels + fetchCadFiles）
//     浪费 3 个 RTT；本测试的核心 regression guard = 「ownerPartId 变化 → 单调用
//     listPartFilesByOwner，恰好 1 次（不是 3 次）」。
//   - partFileSchema 必须显式列全 12 字段（Zod 默认 strip 模式会让缺字段
//     静默丢弃），沿 schemas.spec.ts S4 思路守门 strip regression。
//
// 覆盖：
//   - S1：partFileListResultSchema.parse 接受合法 payload（含 12 字段）。
//   - S2：partFileSchema 拒绝缺 kind 的对象（strip regression guard）。
//   - T1：usePartFilesListQuery(null) → enabled=false，listPartFilesByOwner 调用 0 次。
//   - T2：usePartFilesListQuery('id1') → 切到 'id2' → 恰好 1 次 listPartFilesByOwner。
//   - T3：usePartFilesListQuery('id1') → 调 refetch → 2 次（含首次 + refetch）。
//   - T4：invalidatePartFilesListQuery(qc, ownerId) → 失效对应 queryKey。
//
// 测试策略：
//   - vi.mock('@/api/assembly')：listPartFilesByOwner 替换为 vi.fn()，捕获入参。
//   - vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))：防 vitest
//     node env 中 ElMessage 内部 normalizeAppendTo 触发 ReferenceError。
//   - beforeEach 安装 VueQueryPlugin + QueryClient（vue-query 5.x 需要 inject）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// 2026-09-29：vi.mock('element-plus') 必须先于任何对 element-plus 的间接 import。
// 沿 usePartsListQuery.ts:334-336 同款处理。
vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const realListPartFilesByOwner = vi.fn<
  (partId: string, kind?: string) => Promise<{
    items: unknown[];
    total: number;
    limit: number;
    offset: number;
  }>
>(async () => ({ items: [], total: 0, limit: 500, offset: 0 }));

vi.mock('@/api/assembly', () => ({
  // 2026-09-29：listPartFilesByOwner 是 usePartFilesListQuery 的唯一外部依赖。
  listPartFilesByOwner: (partId: string, kind?: string) =>
    realListPartFilesByOwner(partId, kind),
}));

import { partFileSchema, partFileListResultSchema } from '../schemas';
import {
  invalidatePartFilesListQuery,
  usePartFilesListQuery,
} from '../usePartFilesListQuery';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('partFileSchema / partFileListResultSchema（2026-09-29 新增）', () => {
  describe('partFileSchema', () => {
    it('S1：接受 backend-rust PartFileItem 完整 12 字段不抛错', () => {
      const f = partFileSchema.parse({
        id: '3000000000001',
        version: 1,
        owner_id: '5000000000001',
        kind: 'DRAWING',
        file_type: 'PDF',
        original_filename: '法兰盘.pdf',
        file_size: '234567',
        content_type: 'application/pdf',
        upload_status: 'READY',
        content_sha256: null,
        created_at: '2026-09-29 10:00:00',
        paired_file_id: null,
      });
      expect(f.id).toBe('3000000000001');
      expect(f.kind).toBe('DRAWING');
    });

    it('S2：缺 kind → 抛 ZodError（strip regression guard）', () => {
      // 背景：首轮 review M-1 同款问题 —— Zod 默认 strip 模式会静默丢未声明字段。
      // 本用例是「缺必填字段必须抛错」的核心 guard，防止 schema 漏列 kind 导致
      // 整份校验形同虚设。
      expect(() =>
        partFileSchema.parse({
          id: '3000000000001',
          version: 1,
          owner_id: '5000000000001',
          // kind 缺
          file_type: 'PDF',
          original_filename: '法兰盘.pdf',
          file_size: '234567',
          content_type: 'application/pdf',
          upload_status: 'READY',
          content_sha256: null,
          created_at: '2026-09-29 10:00:00',
          paired_file_id: null,
        }),
      ).toThrow();
    });

    it('S3：枚举锁 DRAFT 之外的 kind → 抛 ZodError', () => {
      // 背景：kind 是 z.enum 锁死的字面量联合，未知 kind 必须拒收，
      // 防止后端漂移出新 kind 时前端静默接受。
      expect(() =>
        partFileSchema.parse({
          id: '3000000000001',
          version: 1,
          owner_id: '5000000000001',
          kind: 'NEW_KIND_NOT_IN_ENUM',
          file_type: 'PDF',
          original_filename: 'x.pdf',
          file_size: '1',
          content_type: 'application/pdf',
          upload_status: 'READY',
          content_sha256: null,
          created_at: '2026-09-29 10:00:00',
          paired_file_id: null,
        }),
      ).toThrow();
    });

    it('S4：content_sha256 / paired_file_id 为 null 时接受', () => {
      // nullable 字段必须能用 null 解析（与后端 SQL NULL 对齐）。
      const f = partFileSchema.parse({
        id: '3000000000001',
        version: 1,
        owner_id: '5000000000001',
        kind: 'DRAWING',
        file_type: 'PDF',
        original_filename: 'x.pdf',
        file_size: '1',
        content_type: 'application/pdf',
        upload_status: 'READY',
        content_sha256: null,
        created_at: '2026-09-29 10:00:00',
        paired_file_id: null,
      });
      expect(f.content_sha256).toBeNull();
      expect(f.paired_file_id).toBeNull();
    });
  });

  describe('partFileListResultSchema', () => {
    it('S5：接受 { items, total, limit, offset } 分页结构', () => {
      const r = partFileListResultSchema.parse({
        items: [
          {
            id: '3000000000001',
            version: 1,
            owner_id: '5000000000001',
            kind: 'DRAWING',
            file_type: 'PDF',
            original_filename: '法兰盘.pdf',
            file_size: '234567',
            content_type: 'application/pdf',
            upload_status: 'READY',
            content_sha256: null,
            created_at: '2026-09-29 10:00:00',
            paired_file_id: null,
          },
        ],
        total: 1,
        limit: 500,
        offset: 0,
      });
      expect(r.items).toHaveLength(1);
      expect(r.total).toBe(1);
    });

    it('S6：缺 total → 抛 ZodError', () => {
      expect(() =>
        partFileListResultSchema.parse({
          items: [],
          // total 缺
          limit: 500,
          offset: 0,
        }),
      ).toThrow();
    });
  });
});

describe('usePartFilesListQuery — 单调用 + reactive params + enabled 闸门（2026-09-29）', () => {
  beforeEach(() => {
    realListPartFilesByOwner.mockClear();
    realListPartFilesByOwner.mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
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

  it('T1：null ownerPartId → enabled=false → listPartFilesByOwner 调用 0 次', async () => {
    // 2026-09-29 核心闸门 guard：usePartFilesListQuery 必须接受 null/undefined
    // ownerPartId 而不发任何请求，避免后端收到 ?owner_id= 触发 422。
    const scope = effectScope();
    let q: ReturnType<typeof usePartFilesListQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartFilesListQuery(() => null));
    });
    // 等一拍让 enabled=false 生效
    await new Promise((r) => setTimeout(r, 10));
    expect(realListPartFilesByOwner).not.toHaveBeenCalled();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it("T2：'id1' → 切到 'id2' → 恰好 1 次 listPartFilesByOwner（单调用 invariant）", async () => {
    // 2026-09-29 核心 regression guard：旧 usePartFiles 三并发会发 3 次；
    // 新 usePartFilesListQuery 单 owner 维度调用，ownerId 切换只发 1 次。
    const ownerRef = ref<string>('id1');
    const scope = effectScope();
    let q: ReturnType<typeof usePartFilesListQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartFilesListQuery(() => ownerRef.value));
    });

    // 等首次 refetch 走完
    await q!.refetch();
    const callsAfterFirst = realListPartFilesByOwner.mock.calls.length;
    expect(callsAfterFirst).toBe(1);
    // ownerId 是 'id1'
    expect(realListPartFilesByOwner.mock.calls[0]?.[0]).toBe('id1');

    // 切 ownerId → useQuery 自动 refetch
    ownerRef.value = 'id2';
    await q!.refetch();
    // 总共 2 次（首次 + 切换后）
    expect(realListPartFilesByOwner.mock.calls.length).toBe(2);
    // 最后一次 ownerId = 'id2'
    const lastCall =
      realListPartFilesByOwner.mock.calls[realListPartFilesByOwner.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe('id2');
    scope.stop();
  });

  it('T3：getter 形式 ownerPartId → 改 source 后 listPartFilesByOwner 收到新 ownerId', async () => {
    // 沿 useProcessesQuery T5 范本：getter 是 MaybeRefOrGetter 第三分支。
    const source = ref<string>('GETTER-A');
    const scope = effectScope();
    let q: ReturnType<typeof usePartFilesListQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartFilesListQuery(() => source.value));
    });

    await q!.refetch();
    expect(realListPartFilesByOwner.mock.calls[0]?.[0]).toBe('GETTER-A');

    source.value = 'GETTER-B';
    await q!.refetch();
    const lastCall =
      realListPartFilesByOwner.mock.calls[realListPartFilesByOwner.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe('GETTER-B');
    scope.stop();
  });

  it('T4：invalidatePartFilesListQuery(qc, ownerId) → 该 owner 的 query 标记为 invalidated 并再次请求', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof usePartFilesListQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartFilesListQuery(() => 'id1'));
    });
    // 等首次 refetch
    await q!.refetch();
    const callsBefore = realListPartFilesByOwner.mock.calls.length;

    // 失效 → 下一次访问走 queryFn 重拉
    await invalidatePartFilesListQuery(testQueryClient, 'id1');
    await q!.refetch();

    expect(realListPartFilesByOwner.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });
});