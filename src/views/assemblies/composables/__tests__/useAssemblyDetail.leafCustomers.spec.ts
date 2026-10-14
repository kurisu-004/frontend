// src/views/assemblies/composables/__tests__/useAssemblyDetail.leafCustomers.spec.ts
//
// 装配件**新建 / 编辑弹窗客户下拉的候选集**守卫（2026-10-17 客户无限层级改造补）。
//
// 为什么必须有：后端 `assembly/service/crud.rs` 的「客户必须是叶子」判据在 2026-10-17
// 从「L2 叶子 = `parent_id IS NOT NULL`」改成了「`has_children == false`」，而前端这条
// 判据当时还停在旧写法。旧写法在**两层树**上恰好等价于「叶子」，客户放开任意深度后
// 它等价于「**除根以外的一切**」—— 第 3 层分厂、第 4 层车间都会进下拉，操作员选中即被
// 后端业务码拒，且前端零提示（后端的拒绝文案要到提交后才出现）。
//
// 用例只守一件事：**候选集里不含任何中间层节点**。挂载整个 composable 而不是断言
// `leafCustomersOf` 本身（后者在 `api/__tests__/customerTree.spec.ts` 已有），因为
// 真正的回归风险在「composable 有没有用这个判据」—— 纯函数测对了、调用点接错，
// 线上照样出中间层。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { Customer } from '@/api/customer';

// —— 依赖桩（composable 只用到这几条；桩掉比真跑 query / router / http 稳）——
const customersData = ref<{ items: Customer[]; total: number; limit: number; offset: number }>();

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/composables/usePermissions', () => ({
  usePermissions: () => ({ isManager: ref(false), isClerk: ref(false) }),
}));
vi.mock('@/composables/useApplicantSearch', () => ({
  useApplicantSearch: () => ({ querySearch: vi.fn() }),
}));
vi.mock('@/composables/queries/useCustomersQuery', () => ({
  useCustomersQuery: () => ({
    data: customersData,
    isFetching: ref(false),
    error: ref(null),
    refetch: vi.fn(),
  }),
}));
vi.mock('@/api/assembly', () => ({
  addAssemblyChild: vi.fn(),
  cancelAssembly: vi.fn(),
  enrichAssemblyItem: vi.fn((a: unknown) => a),
  getAssembly: vi.fn(),
  softDeleteAssembly: vi.fn(),
  updateAssembly: vi.fn(),
  uploadAssemblyPdf: vi.fn(),
}));
vi.mock('@/api/http', () => ({ api: { get: vi.fn() } }));

import { useAssemblyDetail } from '../useAssemblyDetail';

/** 一棵三层树 + 一个孤立的单层根：
 *   华强集团（L1）
 *     ├ 终端BG（L2，中间层）
 *     │    └ 手机部（L3，中间层）
 *     │         └ 影像组（L4，叶子）
 *     └ 显示BG（L2，叶子 —— 该分支下再无子节点）
 *   某某厂（L1 孤立根，也是叶子）
 */
function node(id: string, name: string, parentId: string | null): Customer {
  return {
    id,
    name,
    parent_id: parentId,
    parent_name: null,
    serial_prefix: null,
    customer_path: name,
    version: 1,
    created_at: '',
    updated_at: '',
  };
}

const TREE: Customer[] = [
  node('c-root', '华强集团', null),
  node('c-bg', '终端BG', 'c-root'),
  node('c-dept', '手机部', 'c-bg'),
  node('c-leaf', '影像组', 'c-dept'),
  node('c-bg2', '显示BG', 'c-root'),
  node('c-solo', '某某厂', null),
];

beforeEach(() => {
  customersData.value = { items: TREE, total: TREE.length, limit: 500, offset: 0 };
});

describe('useAssemblyDetail.leafCustomers —— 候选必须是真叶子', () => {
  it('L1：3 层树上只留下真正的叶子，中间层与根一个都不在', () => {
    const { leafCustomers } = useAssemblyDetail(ref('190000000000001'));
    const ids = leafCustomers.value.map((c) => c.id);
    expect(ids.sort()).toEqual(['c-bg2', 'c-leaf', 'c-solo'].sort());
  });

  it('L2：中间层节点（终端BG / 手机部）与根（华强集团）都不在候选里', () => {
    const { leafCustomers } = useAssemblyDetail(ref('190000000000001'));
    const ids = leafCustomers.value.map((c) => c.id);
    // 旧写法 `parent_id !== null` 会把这三个全放进下拉（等价于「除根以外的一切」）
    expect(ids).not.toContain('c-bg');
    expect(ids).not.toContain('c-dept');
    expect(ids).not.toContain('c-root');
  });

  it('L3：孤立的单层根也是合法叶子（旧写法会把 `parent_id === null` 的根全排掉）', () => {
    const { leafCustomers } = useAssemblyDetail(ref('190000000000001'));
    expect(leafCustomers.value.map((c) => c.id)).toContain('c-solo');
  });

  it('L4：客户数据未到达（undefined）⇒ 空数组，不抛错', () => {
    customersData.value = undefined as never;
    const { leafCustomers } = useAssemblyDetail(ref('190000000000001'));
    expect(leafCustomers.value).toEqual([]);
  });
});
