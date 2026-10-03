// src/views/scan/composables/__tests__/resolveWorkingShelf.spec.ts
//
// 2026-10-04 新增：resolveWorkingShelfId 的守卫判定与文案。
//
// 为什么值得单测：它是取件 / 送检两页**唯一**的「不发请求」出口，后果分别是
// 「worker-scan 省略 shelf_id → 422」与「填品检架 → 20501」，都是工人看不懂的
// 烂错误。守卫一旦放行了不该放行的组合，这两个故障就回来了。
//
// ElMessage 按仓内既有做法桩成 no-op（node/happy-dom 下真实 ElMessage 走
// normalizeAppendTo 会污染输出，见 CLAUDE.md 的 ElMessage 错误桥接条目）。
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

import { listShelves } from '@/api/shelves';
import { useScanShelfStore } from '@/stores/scanShelf';
import { resolveWorkingShelfId, workingShelfProblem } from '../resolveWorkingShelf';
import type { CurrentUser } from '@/types/user';
import type { Shelf } from '@/types/shelf';

function makeUser(shelfIds: string[]): CurrentUser {
  return {
    id: 'u1',
    username: 'hmi1',
    full_name: '工位一号',
    is_active: true,
    roles: ['SHELF_ACCOUNT'],
    shelf_ids: shelfIds,
    menus: [],
  };
}

function mockShelves(rows: Array<Pick<Shelf, 'id' | 'code' | 'zone'>>): void {
  vi.mocked(listShelves).mockResolvedValue({
    items: rows.map((r) => ({
      version: 1,
      name: r.code,
      location: null,
      is_active: true,
      display_order: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...r,
    })),
    total: rows.length,
    limit: 200,
    offset: 0,
  });
}

function bootstrap(user: CurrentUser): void {
  localStorage.setItem('auth_session', JSON.stringify({ token: 'tok', refresh_token: null, user }));
  const app = createApp({});
  app.use(createPinia());
  app.use(VueQueryPlugin, {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }),
  });
  setActivePinia(app.config.globalProperties.$pinia);
}

describe('resolveWorkingShelfId', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(ElMessage.error).mockClear();
    vi.mocked(ElMessage.warning).mockClear();
    vi.mocked(listShelves).mockClear();
  });

  it('G1：单架 PRODUCTION 账号返回该架 id，且不弹提示', async () => {
    bootstrap(makeUser(['8800000000001']));
    mockShelves([{ id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' }]);
    await useScanShelfStore().initShelves();

    expect(resolveWorkingShelfId()).toBe('8800000000001');
    expect(ElMessage.error).not.toHaveBeenCalled();
  });

  it('G2：wildcard 账号 → 返回 null 并指向「账号管理」绑定货架', async () => {
    bootstrap(makeUser([]));
    await useScanShelfStore().initShelves();

    expect(resolveWorkingShelfId()).toBeNull();
    expect(ElMessage.error).toHaveBeenCalledWith(
      '当前账号未绑定作业货架，请联系管理员在「账号管理」为本账号绑定生产货架',
    );
  });

  it('G3：多架未选 → 返回 null 并指向「指定唯一作业货架」（不是「去选一下」）', async () => {
    bootstrap(makeUser(['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);
    await useScanShelfStore().initShelves();

    expect(resolveWorkingShelfId()).toBeNull();
    expect(ElMessage.error).toHaveBeenCalledWith(
      '本账号绑定了多个货架，无法确定当前作业货架，请联系管理员为本账号指定唯一作业货架',
    );
  });

  it('G4：选中的架在品检区 → 返回 null，且文案不叫工人「改选」（页面上没有选架入口）', async () => {
    bootstrap(makeUser(['8800000000002']));
    mockShelves([{ id: '8800000000002', code: 'SH-I02', zone: 'INSPECTION' }]);
    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    expect(resolveWorkingShelfId()).toBeNull();
    expect(ElMessage.error).toHaveBeenCalledWith(
      '本账号当前绑定的货架在品检区，缺少生产区作业货架，请联系管理员为本账号绑定生产货架',
    );
  });

  it('G5：zone 未知 → 返回 null，且不冒充成「品检区」也不冒充成「生产区」', async () => {
    bootstrap(makeUser(['8800000000001']));
    // 后端真返回一个既非 PRODUCTION 也非 INSPECTION 的 zone
    mockShelves([{ id: '8800000000001', code: 'SH-X01', zone: 'STAGING' }]);
    await useScanShelfStore().initShelves();

    expect(resolveWorkingShelfId()).toBeNull();
    expect(ElMessage.error).toHaveBeenCalledWith(
      '无法识别当前货架所属区域，不能作为作业货架，请联系管理员核对本账号的货架绑定',
    );
  });

  it('G6：workingShelfProblem 只返回文案不弹提示（供进页提示自选级别）', async () => {
    bootstrap(makeUser([]));
    await useScanShelfStore().initShelves();

    expect(workingShelfProblem()).toBe(
      '当前账号未绑定作业货架，请联系管理员在「账号管理」为本账号绑定生产货架',
    );
    expect(ElMessage.error).not.toHaveBeenCalled();
    expect(ElMessage.warning).not.toHaveBeenCalled();
  });
});
