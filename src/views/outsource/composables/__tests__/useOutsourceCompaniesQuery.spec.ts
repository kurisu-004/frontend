// src/views/outsource/composables/__tests__/useOutsourceCompaniesQuery.spec.ts
//
// 外协公司一览主查询（`GET /api/v2/outsource-companies`）的接线 guard：reactive params
// + enabled 闸门 + queryFn 从 queryKey 读 params + Zod 守门 + **前缀**失效。
//
// 覆盖：
//   - CQ1：传静态 params → api 收到该组筛选。
//   - CQ2：传 Ref → 改 ref.value 后 refetch，收到新筛选（reactive params guard：queryFn
//     从 queryKey 读最新值，不闭包捕获 stale 值）。
//   - CQ3：enabled=false → 零请求（store 在 restoreState() 末尾开闸，避免双 fetch）。
//   - CQ4：queryKey 走 qk.outsourceCompanies 工厂（禁止调用点拼字面量数组）。
//   - CQ5：出参缺 `version` → query 进 error 态（守门承重字段：它是 update / soft-delete
//     的 OCC 锚，漏声明后编辑与删除恒 422 而前端毫无察觉）。
//   - CQ6：信封多出的两个公司时间字段被 strip（2026-10-09 后端已删，前端不许依赖）。
//   - CQ7：invalidateOutsourceCompaniesAll 走前缀键（任意 params 形态一把全失效）。
//
// 测试形态沿 `useOutsourceQueueProcessQuery.spec.ts`：vi.mock('element-plus') +
// vi.mock('@/api/outsource') + createApp({}) + app.use(VueQueryPlugin) + effectScope。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** 后端 `OutsourceCompanyOut` 全字段（7）。 */
function makeCompany(id: string, name: string) {
  return {
    id,
    name,
    contact_name: '张三',
    contact_phone: '0591-8888',
    address: '福州市仓山区',
    is_active: true,
    version: 3,
  };
}

const realList = vi.fn<(params: unknown) => Promise<unknown>>(async (params) => ({
  items: [makeCompany('190000000000900', JSON.stringify(params ?? {}))],
  total: 1,
  limit: 100,
  offset: 0,
}));

vi.mock('@/api/outsource', () => ({
  listOutsourceCompanies: (params: unknown) => realList(params),
}));

import {
  invalidateOutsourceCompaniesAll,
  useOutsourceCompaniesQuery,
} from '../useOutsourceCompaniesQuery';
import { qk } from '@/composables/queries/keys';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useOutsourceCompaniesQuery — 外协公司一览主查询', () => {
  beforeEach(() => {
    realList.mockClear();
    realList.mockImplementation(async (params) => ({
      items: [makeCompany('190000000000900', JSON.stringify(params ?? {}))],
      total: 1,
      limit: 100,
      offset: 0,
    }));
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    vi.restoreAllMocks();
  });

  it('CQ1：传静态 params → api 收到该组筛选', async () => {
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceCompaniesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceCompaniesQuery({
          params: () => ({ name_like: '福州', is_active: true, limit: 100, offset: 0 }),
          enabled: true,
        }),
      );
    });
    await q.query.refetch();
    expect(realList).toHaveBeenCalledWith({
      name_like: '福州',
      is_active: true,
      limit: 100,
      offset: 0,
    });
    scope.stop();
  });

  it('CQ2：传 Ref → 改值后 refetch 收到新筛选（queryFn 从 queryKey 读最新值）', async () => {
    const paramsRef: Ref<{ name_like: string; limit: number; offset: number }> = ref({
      name_like: '福州',
      limit: 100,
      offset: 0,
    });
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceCompaniesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceCompaniesQuery({ params: paramsRef, enabled: true }),
      );
    });
    await q.query.refetch();
    expect(realList).toHaveBeenLastCalledWith({ name_like: '福州', limit: 100, offset: 0 });

    paramsRef.value = { name_like: '厦门', limit: 20, offset: 40 };
    await q.query.refetch();
    // 若 queryFn 闭包捕获了入参快照，这里会拿到上一个筛选的响应
    expect(realList).toHaveBeenLastCalledWith({ name_like: '厦门', limit: 20, offset: 40 });
    scope.stop();
  });

  it('CQ3：enabled=false → 零请求', async () => {
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() =>
        useOutsourceCompaniesQuery({
          params: () => ({ limit: 100, offset: 0 }),
          enabled: false,
        }),
      );
    });
    await Promise.resolve();
    expect(realList).not.toHaveBeenCalled();
    scope.stop();
  });

  it('CQ4：queryKey 走 qk 工厂（含 params 维度）', () => {
    expect(qk.outsourceCompanies({ limit: 100, offset: 0 })).toEqual([
      'outsource',
      'companies',
      { limit: 100, offset: 0 },
    ]);
    expect(qk.outsourceCompaniesPrefix).toEqual(['outsource', 'companies']);
  });

  it('CQ5：出参缺 version → query 进 error 态（守门承重字段：OCC 锚）', async () => {
    realList.mockImplementation(async () => {
      const company = makeCompany('190000000000900', '福州精工外协') as Record<string, unknown>;
      delete company.version;
      return { items: [company], total: 1, limit: 100, offset: 0 };
    });
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceCompaniesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceCompaniesQuery({
          params: () => ({ limit: 100, offset: 0 }),
          enabled: true,
        }),
      );
    });
    await q.query.refetch();
    expect(q.query.error.value).toBeTruthy();
    scope.stop();
  });

  it('CQ6：信封多出的 created_at / updated_at 被 strip（后端已删，前端不许依赖）', async () => {
    realList.mockImplementation(async () => ({
      items: [{ ...makeCompany('190000000000900', '福州精工外协'), created_at: 'x', updated_at: 'y' }],
      total: 1,
      limit: 100,
      offset: 0,
    }));
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceCompaniesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceCompaniesQuery({
          params: () => ({ limit: 100, offset: 0 }),
          enabled: true,
        }),
      );
    });
    await q.query.refetch();
    const row = q.query.data.value?.items[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('created_at');
    expect(row).not.toHaveProperty('updated_at');
    expect(row.version).toBe(3);
    scope.stop();
  });

  it('CQ7：invalidateOutsourceCompaniesAll 走前缀键（任意 params 一把全失效）', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourceCompaniesAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource', 'companies'] });
  });

  it('CQ8：fetchList 别名 = refetch 的 async 包装（视图刷新按钮 / 写后刷新入口）', async () => {
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceCompaniesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceCompaniesQuery({
          params: () => ({ limit: 100, offset: 0 }),
          enabled: true,
        }),
      );
    });
    await q.fetchList();
    expect(realList).toHaveBeenCalledTimes(1);
    expect(q.data.value?.total).toBe(1);
    scope.stop();
  });
});