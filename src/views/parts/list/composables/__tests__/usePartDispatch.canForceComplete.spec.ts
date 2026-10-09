// src/views/parts/list/composables/__tests__/usePartDispatch.canForceComplete.spec.ts
//
// 2026-09-30 新增：MANAGER 专属「完成」按钮守卫 canForceComplete 单测
// （vitest node 环境）。
//
// 背景：零件一览操作列有 MANAGER 专属「完成」按钮，零件打
// POST /api/v2/parts/{part_id}/force-complete、装配件打
// POST /api/v2/prod/assemblies/{id}/force-complete，把工单 + 所有非取消批次强推为
// COMPLETED。本 spec 覆盖两个正交面：
//
// 一、守卫 canForceComplete（可见性）—— isManager && 非子件行 && 非 COMPLETED &&
//    非 CANCELLED：
//   R1 MANAGER + PART + 非终态       → true
//   R2 非 MANAGER（CLERK 等）         → false（即便行状态合法）
//   R3 ASSEMBLY row_type             → true（装配件走自己的 force-complete 端点）
//   R4 COMPLETED / CANCELLED 终态    → false（避免重复强制 + 与 cancelPart 冲突）
//   R5 __is_child 子件行              → false（装配件整体完成只走父行入口）
//
// 二、点击路径 onForceComplete（端点分流与确认文案）—— 守卫只回答「按钮可不可见」，
//    「这一行打哪条 URL」由 mutationFn 的 rowType 分发决定，分流失效时上面 5 条守卫
//    用例仍全绿，只有这一层拦得住：
//   R6 ASSEMBLY 行                    → 只打 forceCompleteAssembly
//   R7 PART 行                        → 只打 forceCompletePart
//   R8 装配件确认文案带子件数；child_count 缺省时退成不带数字的整句
//   R9 零件行确认文案不含子件提示
//      + 确认框取消 ⇒ 两条端点都不打
//
// 依赖处理：
// - usePartDispatch 内部调 useRouter + useQueryClient，需要在 Vue setup 上下文中
//   执行 —— 用 createApp + app.runWithContext() 提供 inject context；
// - useAuthStore（Pinia setup store）内含 useMutation → 需要注册 VueQueryPlugin +
//   QueryClient；
// - useProcessesQuery 跑前会触发 queryFn，mock listProcesses 返空数据让 query 快速
//   resolve，避免 watch(errorMsg) 桥接 → ElMessage.error → node env document is
//   not defined 污染输出；
// - ElMessage / ElMessageBox 桩成 no-op；
// - R6~R9 依赖桩件**必须保留可观测性**：`ElMessageBox.confirm` 既要让 dangerous()
//   resolve true（它只把 reject 当「取消」，resolve undefined 即视为确认），又要能
//   读到入参文案；两个 force-complete api 桩成 `vi.fn()` 后即可断言「调了哪个、
//   没调哪个」；
// - @/api/parts / @/api/shelves / @/api/process 全部 mock，避免 axios 网络请求。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  ElMessageBox: {
    confirm: vi.fn(async () => undefined),
  },
}));

vi.mock('@/api/parts', () => ({
  placeOnShelf: vi.fn(),
  forceCompletePart: vi.fn(),
}));

// 2026-10-11：装配件行同一条「完成」按钮走 assembly 域端点，必须一并桩掉，
// 否则 canForceComplete 以外的路径（mutationFn）会发出真实 axios 请求。
vi.mock('@/api/assembly', () => ({
  forceCompleteAssembly: vi.fn(),
}));

vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 0, offset: 0 })),
}));

vi.mock('@/api/process', () => ({
  listProcesses: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

vi.mock('@/api/iam', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}));

import { usePartDispatch } from '../usePartDispatch';
import { useAuthStore } from '@/stores/auth';
import { ElMessageBox } from 'element-plus';
import { forceCompletePart } from '@/api/parts';
import { forceCompleteAssembly } from '@/api/assembly';
import type { CurrentUser } from '@/types/user';
import type { PartListItem } from '@/types/parts';

/** 最小行：canForceComplete 只读 row_type / status，其它字段用 cast 兜底。 */
function makeRow(overrides: Partial<PartListItem> = {}): PartListItem {
  const row = {
    id: '213102505968533504',
    version: 1,
    row_type: 'PART' as const,
    status: 'IN_PROCESS' as const,
    serial_no: 'SN-TEST',
    drawing_no: 'D-TEST',
    name: '零件 测试',
    quantity: 1,
    unit_price: '0.00',
    is_urgent: false,
    ...overrides,
  };
  return row as PartListItem;
}

/** usePartDispatch 的最小 deps（canForceComplete 不读这些，但函数签名要求给齐）。 */
/** 注入一个 MANAGER 测试用户到 auth store。 */
function loginAsManager(): void {
  const auth = useAuthStore();
  const user: CurrentUser = {
    id: '1',
    username: 'mgr',
    full_name: '管理员',
    is_active: true,
    roles: ['MANAGER'],
    shelf_ids: [],
    menus: [],
  };
  auth.user = user;
}

function loginAsClerk(): void {
  const auth = useAuthStore();
  const user: CurrentUser = {
    id: '2',
    username: 'clerk',
    full_name: '文员',
    is_active: true,
    roles: ['CLERK'],
    shelf_ids: [],
    menus: [],
  };
  auth.user = user;
}

describe('usePartDispatch.canForceComplete', () => {
  let app: App;

  beforeEach(() => {
    // setup context：useRouter / useQueryClient 需要在 app.runWithContext() 内调用，
    // 因为它们依赖 Vue 的 inject 机制；createPinia + VueQueryPlugin 给 store + QueryClient
    // 上下文。setActivePinia 让后续 useAuthStore() 命中这里。
    app = createApp({});
    app.use(createPinia());
    app.use(VueQueryPlugin, {
      queryClient: new QueryClient({ defaultOptions: { mutations: { retry: 0 } } }),
    });
    setActivePinia(app.config.globalProperties.$pinia);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // R1：MANAGER + PART + 非终态 → true
  it('returns true for MANAGER + PART + active status', () => {
    loginAsManager();
    const dispatch = app.runWithContext(() => usePartDispatch());
    expect(dispatch.canForceComplete(makeRow({ status: 'IN_PROCESS' }))).toBe(true);
    expect(dispatch.canForceComplete(makeRow({ status: 'PENDING' }))).toBe(true);
    expect(dispatch.canForceComplete(makeRow({ status: 'INSPECTION' }))).toBe(true);
    expect(dispatch.canForceComplete(makeRow({ status: 'READY_TO_SHIP' }))).toBe(true);
  });

  // R2：非 MANAGER → false（即便行状态合法）
  it('returns false for non-MANAGER role', () => {
    loginAsClerk();
    const dispatch = app.runWithContext(() => usePartDispatch());
    expect(dispatch.canForceComplete(makeRow({ status: 'IN_PROCESS' }))).toBe(false);
  });

  // R3：ASSEMBLY row_type → true（装配件有自己的 force-complete 端点）
  it('returns true for ASSEMBLY row_type', () => {
    loginAsManager();
    const dispatch = app.runWithContext(() => usePartDispatch());
    expect(dispatch.canForceComplete(makeRow({ row_type: 'ASSEMBLY', status: 'IN_PROCESS' }))).toBe(
      true,
    );
  });

  // R4：COMPLETED / CANCELLED 终态 → false
  it('returns false for terminal COMPLETED / CANCELLED status', () => {
    loginAsManager();
    const dispatch = app.runWithContext(() => usePartDispatch());
    expect(dispatch.canForceComplete(makeRow({ status: 'COMPLETED' }))).toBe(false);
    expect(dispatch.canForceComplete(makeRow({ status: 'CANCELLED' }))).toBe(false);
  });

  // R5：__is_child 子件行 → false（PartListItem 顶层没有该字段，构造时需 cast；
  // 子件行的 row_type 被 mapper 强制成 'PART'，只能靠 __is_child 区分）
  it('returns false for __is_child rows', () => {
    loginAsManager();
    const dispatch = app.runWithContext(() => usePartDispatch());
    const child = makeRow({ status: 'IN_PROCESS' }) as PartListItem & { __is_child: true };
    child.__is_child = true;
    expect(dispatch.canForceComplete(child)).toBe(false);
    // 装配件父行同样可点 —— 两者不构成互斥的权限判断，只是入口去重
    expect(dispatch.canForceComplete(makeRow({ row_type: 'ASSEMBLY', status: 'IN_PROCESS' }))).toBe(
      true,
    );
  });

  // 暴露字段契约：forceCompletingMap 是 Record<string, boolean>，初值空对象
  it('exposes forceCompletingMap as an empty reactive Record<string, boolean>', () => {
    loginAsManager();
    const dispatch = app.runWithContext(() => usePartDispatch());
    expect(dispatch.forceCompletingMap).toBeDefined();
    expect(typeof dispatch.forceCompletingMap).toBe('object');
    expect(Object.keys(dispatch.forceCompletingMap)).toEqual([]);
    expect(typeof dispatch.onForceComplete).toBe('function');
  });

  // ==========================================================================
  // R6 ~ R9：onForceComplete 的端点分流与确认文案（2026-10-11 新增）
  //
  // 这一层与 canForceComplete 是正交的：守卫只回答「按钮可不可见」，真正决定
  // 「这一行打哪条 URL」的是 mutationFn 里的 rowType 分发。分流接错时（装配件行
  // 打 /parts/{assembly_id}/force-complete）上面 5 条守卫用例仍然全绿 —— 必须
  // 驱动一次真实点击路径才拦得住。
  // ==========================================================================

  it('R6：ASSEMBLY 行只打 forceCompleteAssembly（零件端点一次都不许碰）', async () => {
    loginAsManager();
    vi.mocked(forceCompleteAssembly).mockClear();
    vi.mocked(forceCompletePart).mockClear();
    const dispatch = app.runWithContext(() => usePartDispatch());
    const row = makeRow({ row_type: 'ASSEMBLY', child_count: 7 });

    await dispatch.onForceComplete(row);

    // mutate() 不 await mutationFn ⇒ 用 waitFor 等它 settle，而不是赌一个 tick
    await vi.waitFor(() => {
      expect(forceCompleteAssembly).toHaveBeenCalledTimes(1);
      expect(forceCompletePart).not.toHaveBeenCalled();
    });
    expect(forceCompleteAssembly).toHaveBeenCalledWith(row.id, { note: null });
  });

  it('R7：PART 行只打 forceCompletePart（装配件端点一次都不许碰）', async () => {
    loginAsManager();
    vi.mocked(forceCompleteAssembly).mockClear();
    vi.mocked(forceCompletePart).mockClear();
    const dispatch = app.runWithContext(() => usePartDispatch());
    const row = makeRow({ row_type: 'PART' });

    await dispatch.onForceComplete(row);

    await vi.waitFor(() => {
      expect(forceCompletePart).toHaveBeenCalledTimes(1);
      expect(forceCompleteAssembly).not.toHaveBeenCalled();
    });
    expect(forceCompletePart).toHaveBeenCalledWith(row.id, { note: null });
  });

  it('R8：装配件确认文案带上子件数；child_count 缺省时退成不带数字的整句', async () => {
    loginAsManager();
    vi.mocked(ElMessageBox.confirm).mockClear();
    const dispatch = app.runWithContext(() => usePartDispatch());

    await dispatch.onForceComplete(makeRow({ row_type: 'ASSEMBLY', child_count: 7 }));
    await dispatch.onForceComplete(makeRow({ row_type: 'ASSEMBLY', child_count: null }));

    const messages = vi.mocked(ElMessageBox.confirm).mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('该装配件的 7 个子件将一并完成。');
    expect(messages[1]).toContain('该装配件的全部子件将一并完成。');
    // 模板字符串插 null / 未声明值会把字面量印进文案，两条分支都不许出现
    for (const m of messages) {
      expect(m).not.toContain('NaN');
      expect(m).not.toContain('null');
    }
  });

  it('R9：零件行的确认文案不含任何子件提示', async () => {
    loginAsManager();
    vi.mocked(ElMessageBox.confirm).mockClear();
    const dispatch = app.runWithContext(() => usePartDispatch());

    await dispatch.onForceComplete(makeRow({ row_type: 'PART', child_count: 7 }));

    const messages = vi.mocked(ElMessageBox.confirm).mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(1);
    // child_count 即便有值，零件行也不该提子件（子件提示是装配件路径专属）
    expect(messages[0]).not.toContain('子件');
  });

  it('确认框取消 ⇒ 两条端点都不许被打', async () => {
    loginAsManager();
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce(new Error('cancel'));
    vi.mocked(forceCompleteAssembly).mockClear();
    vi.mocked(forceCompletePart).mockClear();
    const dispatch = app.runWithContext(() => usePartDispatch());

    await dispatch.onForceComplete(makeRow({ row_type: 'ASSEMBLY' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(forceCompleteAssembly).not.toHaveBeenCalled();
    expect(forceCompletePart).not.toHaveBeenCalled();
  });
});
