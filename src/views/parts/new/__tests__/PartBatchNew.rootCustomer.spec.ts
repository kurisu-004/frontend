// src/views/parts/new/__tests__/PartBatchNew.rootCustomer.spec.ts
//
// `/parts/new` 装配壳把「申请人搜索」的两个 Tab 接到一起的那条**根客户解析**接线守卫
// （2026-10-17 客户无限层级改造补）。
//
// 为什么不能用 `usePartBatchShared.spec.ts` 里的 `resolveRootCustomerId` 用例顶替：
// 那条守的是**纯函数**跨任意深度上溯，而真正的回归风险在**接线** —— 装配壳原先内联了
// 一份「只上溯一层」的副本（`picked.parent_id === null ? picked.id : picked.parent_id`）。
// 纯函数测得再对，接线那行没换，申请人下拉照样按 L3 车间去过滤（多半直接空）。
// 本 spec 真挂载 shell、扣住传给 `useApplicantSearch` 的那个 resolver，再用四层树的
// 末层 id 调它 —— 只看**结果是不是 L1**，不看实现。
//
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { ref } from 'vue';
import type { Customer } from '@/api/customer';

// —— 依赖桩 ——
const customersData = ref<{ items: Customer[]; total: number; limit: number; offset: number }>();
/** 扣住 `useApplicantSearch` 收到的配置，测试直接调它的 resolver。 */
let capturedResolver: ((pickedId: string | null) => string | null) | null = null;

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/composables/queries/useCustomersQuery', () => ({
  useCustomersQuery: () => ({ data: customersData, error: ref(null) }),
}));
vi.mock('@/composables/useApplicantSearch', () => ({
  useApplicantSearch: (opts: { resolveRootCustomerId: (id: string | null) => string | null }) => {
    capturedResolver = opts.resolveRootCustomerId;
    return { querySearch: vi.fn() };
  },
}));
// 两个 Tab 的 composable 与这里无关（壳只是把结果 v-bind 下去），桩掉省掉一堆状态机。
vi.mock('../composables/usePartBatchManual', () => ({ usePartBatchManual: () => ({}) }));
vi.mock('../composables/usePartBatchPdf', () => ({
  usePartBatchPdf: () => ({}),
}));
// 两个 Tab 组件本身也要桩：它们静态 import pdfjs / Element Plus 等一大票依赖，
// 跟本用例要验的那条接线毫无关系，装载它们会让本 spec 直接跑不起来。
vi.mock('../components/PartBatchManualTab.vue', () => ({
  default: { name: 'PartBatchManualTab', template: '<div />' },
}));
vi.mock('../components/PartBatchPdfTab.vue', () => ({
  default: { name: 'PartBatchPdfTab', template: '<div />' },
}));

import PartBatchNew from '../PartBatchNew.vue';

/** 四层树：某某集团（L1） ▸ 终端BG（L2） ▸ 手机部（L3） ▸ 影像组（L4 叶子）。 */
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
  node('l1', '某某集团', null),
  node('l2', '终端BG', 'l1'),
  node('l3', '手机部', 'l2'),
  node('l4', '影像组', 'l3'),
];

beforeEach(() => {
  capturedResolver = null;
  customersData.value = { items: TREE, total: TREE.length, limit: 500, offset: 0 };
});

describe('PartBatchNew：申请人搜索的根客户解析接线', () => {
  it('R1：末层（L4）叶子解析到 L1 根，不是它的直接父（L3）', () => {
    shallowMount(PartBatchNew);
    expect(
      capturedResolver,
      'useApplicantSearch 没拿到 resolveRootCustomerId：接线断了',
    ).not.toBeNull();
    const resolve = capturedResolver as (id: string | null) => string | null;
    expect(resolve('l4')).toBe('l1');
    // 显式断掉旧写法：只上溯一层会给出 'l3'
    expect(resolve('l4')).not.toBe('l3');
  });

  it('R2：中间层（L2 / L3）与 L1 自身都解析到 L1', () => {
    shallowMount(PartBatchNew);
    const resolve = capturedResolver as (id: string | null) => string | null;
    expect(resolve('l2')).toBe('l1');
    expect(resolve('l3')).toBe('l1');
    expect(resolve('l1')).toBe('l1');
  });

  it('R3：null / 空串 / 查无此 id ⇒ null（不制造假的根 id）', () => {
    shallowMount(PartBatchNew);
    const resolve = capturedResolver as (id: string | null) => string | null;
    expect(resolve(null)).toBeNull();
    expect(resolve('')).toBeNull();
    expect(resolve('no-such')).toBeNull();
  });
});
