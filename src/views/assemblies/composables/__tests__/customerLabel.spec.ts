// src/views/assemblies/composables/__tests__/customerLabel.spec.ts
//
// 装配体域两处「客户可读名」的守卫（2026-10-17 客户无限层级改造新增）：
//   1. `api/assembly.ts::enrichAssemblyItem` —— 详情 / 列表客户三字段的补全点；
//   2. `useAssemblyDetail.ts::formatCustomerOptionLabel` —— 编辑弹窗客户下拉的 option 文案。
//
// 两者改前都是前端手工拼「parent_name / name」。客户改成任意深度（集团 / 分厂 / 车间 /
// 班组…）后那条拼法必然缺层：树 `某某集团 / 终端BG / 手机部 / 影像组` 的第 4 层叶子会
// 被拼成「手机部 / 影像组」，中间那层「终端BG」整层消失，而客户名恰恰是重名的主要维度。
//
// 为什么单独一个 spec 而不是并进某个组件 spec：这两处都是**纯函数**（enrich 不挂组件、
// option label 不挂 el-select），挂载只会把断言淹没在渲染细节里。

import { describe, expect, it } from 'vitest';
import { enrichAssemblyItem } from '@/api/assembly';
import { formatCustomerOptionLabel } from '../useAssemblyDetail';
import type { Customer } from '@/api/customer';
import type { AssemblyItem } from '@/types/assembly';

function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: 'c-leaf',
    name: '影像组',
    parent_id: 'c-mid',
    parent_name: '手机部',
    serial_prefix: null,
    // 第 2 层到叶子的 ` / ` 拼接，不含 L1（后端口径）
    customer_path: '终端BG / 手机部 / 影像组',
    version: 1,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

/** 一条装配体行（只关心 enrich 会碰的三个客户字段，其余给最小值）。 */
function assembly(over: Partial<AssemblyItem> = {}): AssemblyItem {
  // 非客户字段用 `as` 收窄：`AssemblyItem` 有二十几个字段，本 spec 一个都不读，
  // 逐个列出来只会让「这里断言的到底是什么」更难看清（eslint 的 consistent-type-assertions
  // 要求对象字面量写成「先 const 再 cast」而不是 `expr as T` 的表达式形态）。
  const base = {
    customer_id: 'c-leaf',
    customer_name: null,
    parent_customer_name: null,
    customer_path: null,
    ...over,
  };
  return base as AssemblyItem;
}

describe('enrichAssemblyItem —— 客户三字段的补全', () => {
  it('A1：customer_path 取本地 customers 的 customer_path（不再前端拼 parent/name）', () => {
    const out = enrichAssemblyItem(assembly(), [customer()]);
    expect(out.customer_path).toBe('终端BG / 手机部 / 影像组');
    // 显式断掉旧拼法：旧实现给的是「手机部 / 影像组」，中间层被跳过
    expect(out.customer_path).not.toBe('手机部 / 影像组');
    expect(out.customer_name).toBe('影像组');
    expect(out.parent_customer_name).toBe('手机部');
  });

  it('A2：后端 VO 带了 customer_path 时优先用它（本地 customers 只作兜底）', () => {
    // 2026-10-17：`AssemblyOut.customer_path` **已经**是后端必填键，mapper 在
    // `parseAssemblyOutToItemCore` 里透传 ⇒ 这一支是**正常路径**，不是「将来」。
    // 本用例钉的是「本地算出的串不覆盖后端值」这条优先级。
    const out = enrichAssemblyItem(assembly({ customer_path: '后端给的路径' }), [customer()]);
    expect(out.customer_path).toBe('后端给的路径');
  });

  it('A3：后端落空串（客户软删 / 父链成环）时用本地算出的串，不留空白', () => {
    const out = enrichAssemblyItem(assembly({ customer_path: '' }), [customer()]);
    expect(out.customer_path).toBe('终端BG / 手机部 / 影像组');
  });

  it('A4：根客户（自身即 L1）的 customer_path 等于自己的名字', () => {
    const root = customer({
      id: 'c-root',
      name: '某某集团',
      parent_id: null,
      parent_name: null,
      customer_path: '某某集团',
    });
    const out = enrichAssemblyItem(assembly({ customer_id: 'c-root' }), [root]);
    expect(out.customer_path).toBe('某某集团');
  });

  // 2026-10-17（review 第 2 轮 N-6）：查不到客户的那一支**只覆盖两个名字字段**。
  // 旧实现把 `customer_path` 一起置 null，而 `useAssemblyDetail.fetchData` 与
  // `usePartDetail.fetchAssembly` 都在 `await getAssembly()` 之后立刻调 enrich ——
  // 那一刻 `useCustomersQuery` 常常还没回来（`customers = []`）⇒ 后端下发的那条必填路径
  // 在**首帧**被抹成 null，靠 `watchEffect` 二次补回来；客户软删时则永久为 null。
  it('A5：customers 未到达（空数组）/ 查无此客户 ⇒ 两个名字字段置 null，customer_path 保留后端值', () => {
    expect(enrichAssemblyItem(assembly(), [])).toMatchObject({
      customer_name: null,
      parent_customer_name: null,
    });
    // mapper 透传下来的后端路径原样保留（首帧即完整，不等第二次 enrich）
    expect(enrichAssemblyItem(assembly({ customer_path: '后端给的路径' }), []).customer_path).toBe(
      '后端给的路径',
    );
    // 入参本身没有路径（mapper 之前的旧形态）时也不会被编造出值
    expect(enrichAssemblyItem(assembly(), []).customer_path).toBeNull();
    expect(
      enrichAssemblyItem(assembly({ customer_id: 'no-such' }), [customer()]).customer_path,
    ).toBeNull();
  });

  it('A6：不 mutate 入参（纯函数，调用方负责把返回值赋回）', () => {
    const item = assembly();
    const out = enrichAssemblyItem(item, [customer()]);
    expect(item.customer_path).toBeNull();
    expect(out).not.toBe(item);
  });
});

describe('formatCustomerOptionLabel —— 客户下拉 option 文案', () => {
  it('F1：取 customer_path（任意深度的 ` / ` 拼接）', () => {
    expect(formatCustomerOptionLabel(customer())).toBe('终端BG / 手机部 / 影像组');
    expect(formatCustomerOptionLabel(customer())).not.toBe('手机部 / 影像组');
  });

  it('F2：customer_path 为空串时退回单段名（下拉里一条空白 option 等于没有 option）', () => {
    expect(formatCustomerOptionLabel(customer({ customer_path: '' }))).toBe('影像组');
  });

  it('F3：根客户取自己（customer_path 恒等于 name）', () => {
    expect(
      formatCustomerOptionLabel(
        customer({
          name: '某某集团',
          parent_id: null,
          parent_name: null,
          customer_path: '某某集团',
        }),
      ),
    ).toBe('某某集团');
  });
});
