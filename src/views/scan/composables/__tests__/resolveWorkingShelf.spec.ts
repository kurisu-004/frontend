// src/views/scan/composables/__tests__/resolveWorkingShelf.spec.ts
//
// 2026-10-04 新增：resolveWorkingShelfId 的守卫判定与文案。
//
// 为什么值得单测：它是送检页（/scan/inspect）**唯一**的「不发请求」出口，后果是
// 「worker-scan 省略 shelf_id → 裸 422」与「填品检架 → 20501」，都是工人看不懂的
// 烂错误。守卫一旦放行了不该放行的组合，这两个故障就回来了。
//
// 2026-10-04 收窄到只服务送检：取件页已解绑（后端把 pick-up 的 shelf_id 改成可选、
// 缺省不做任何校验），那里不再有任何货架守卫，本文件不再替它背书。
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

  // 2026-10-04 语义反转：多架账号的出路从「找管理员收窄绑定」改成了「工人自己在
  // /scan/action 顶部的「当前作业货架」区选一次」。文案必须指向那个入口 —— 指错了工人
  // 会去找管理员做一件管理员根本不用做的事。
  it('G3：多架未选 → 返回 null，文案指向「操作选择」页的选架入口', async () => {
    bootstrap(makeUser(['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);
    await useScanShelfStore().initShelves();

    expect(resolveWorkingShelfId()).toBeNull();
    expect(ElMessage.error).toHaveBeenCalledWith(
      '本账号绑定了多个货架，请先在「操作选择」页选择当前作业货架',
    );
  });

  // 守住「文案指向的入口真的存在且能解除这个状态」：worker 照 G3 的文案退回操作选择页
  // 选一个架，同一份候选集下守卫就必须放行了。少这条，G3 的文案与
  // ScanActionPicker 的选架 UI 可能各说各话而无人发现。
  it('G3b：按 G3 文案选完架（selectShelf）后守卫放行，不再弹 error', async () => {
    bootstrap(makeUser(['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);
    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();
    expect(resolveWorkingShelfId()).toBeNull();
    vi.mocked(ElMessage.error).mockClear();

    expect(scanShelf.selectShelf('8800000000002')).toBe(true);

    expect(resolveWorkingShelfId()).toBe('8800000000002');
    expect(ElMessage.error).not.toHaveBeenCalled();
  });

  it('G4：选中的架在品检区 → 返回 null，文案说清「候选里没有生产架、只能找管理员」', async () => {
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

  it('G7：单架账号但货架端点失败 → zone 未解析 → 拦下，不拿猜出来的架发请求', async () => {
    bootstrap(makeUser(['8800000000001']));
    // store 按绑定 id 兜底出候选，但 zone 无从得知（UNKNOWN）
    vi.mocked(listShelves).mockRejectedValueOnce(new Error('boom'));
    await useScanShelfStore().initShelves();

    expect(resolveWorkingShelfId()).toBeNull();
    expect(ElMessage.error).toHaveBeenCalledWith(
      '无法识别当前货架所属区域，不能作为作业货架，请联系管理员核对本账号的货架绑定',
    );
  });

  // 2026-10-04：多架沿用 sessionStorage 里上次选定的架 → 照常放行。选架入口已经存在，
  // 沿用不再需要「不该拦但该让工人知道」那条 warning：那条提示的存在理由是「拦了就是
  // 死路」，现在工人自己就能换，重复提示只会变成噪音（守卫因此不再有任何 warning 分支）。
  it('G8：多架沿用上次会话选定的架 → 照常放行，且不弹任何提示', async () => {
    bootstrap(makeUser(['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);
    sessionStorage.setItem('active_shelf_selection:u1', '8800000000002');
    await useScanShelfStore().initShelves();

    expect(resolveWorkingShelfId()).toBe('8800000000002');
    expect(ElMessage.error).not.toHaveBeenCalled();
    expect(ElMessage.warning).not.toHaveBeenCalled();
  });

  it('G12：阻断问题的 error 每次都弹（「这次提交被拦」是逐次事实）', async () => {
    bootstrap(makeUser([]));
    await useScanShelfStore().initShelves();

    expect(resolveWorkingShelfId()).toBeNull();
    expect(resolveWorkingShelfId()).toBeNull();
    // 压掉第二条工人会以为第二次成了
    expect(ElMessage.error).toHaveBeenCalledTimes(2);
  });
});
