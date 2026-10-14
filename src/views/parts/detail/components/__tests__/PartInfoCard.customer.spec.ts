// src/views/parts/detail/components/__tests__/PartInfoCard.customer.spec.ts
// @vitest-environment happy-dom
//
// 「客户」行的展示守卫（2026-10-17 客户无限层级改造）。
//
// 这行文案改过两次，两次都是因为**前端自己拼的路径在无限层级下必然缺层**：
//   1. 最初读 `part.customer_path` —— 后端 `PartDetailOut` 从不返它，恒空白；
//   2. 2026-10-10 改读 `l1_customer_name` + `customer_name` 手工拼「一级 / 二级」——
//      树 `某某集团 / 终端BG / 手机部 / 影像组` 的第 4 层叶子会被拼成「手机部 / 影像组」；
//   3. 现在读后端新补的 `customer_path`（第 2 层到叶子、不含 L1）。
//
// 详情卡每行只有「标签 : 值」一格，所以这里**刻意不渲染 L1 次行**（L1 在零件一览的
// 客户列里作为次行可见）—— 本用例把这个取舍钉住，别有人日后又往这里塞两段。
//
// 挂载手法沿同目录其它 spec：最小 stub。

import { describe, it, expect } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import PartInfoCard from '../PartInfoCard.vue';
import type { PartDetailDto } from '@/api/parts/crud';

const ElCardStub = defineComponent({
  name: 'ElCardStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-card-stub' }, slots.default?.());
  },
});

const ElDescriptionsStub = defineComponent({
  name: 'ElDescriptionsStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-descriptions-stub' }, slots.default?.());
  },
});

const ElDescriptionsItemStub = defineComponent({
  name: 'ElDescriptionsItemStub',
  props: ['label'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'el-descriptions-item-stub', label: props.label }, [slots.default?.()]);
  },
});

const ElTagStub = defineComponent({
  name: 'ElTagStub',
  setup(_, { slots }) {
    return () => h('span', { class: 'el-tag-stub' }, slots.default?.());
  },
});

const ElInputStub = defineComponent({
  name: 'ElInputStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        class: 'el-input-stub',
        value: props.modelValue ?? '',
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      });
  },
});

function part(over: Partial<PartDetailDto> = {}): PartDetailDto {
  // 非本 spec 关心的字段用 `as` 收窄：`PartDetailDto` 近 30 个字段，逐个列出来只会
  // 让「这里断言的到底是什么」更难看清（eslint 的 consistent-type-assertions 同样要求
  // 对象字面量不要写成 `expr as T` 的表达式形态，故单独一行 const 再 cast）。
  const base = {
    id: 'p1',
    name: '连杆',
    drawing_no: 'D-1',
    serial_no: 'S-1',
    applicant_name: '张三',
    quantity: 1,
    request_date: '2026-10-01',
    planned_delivery_date: '2026-10-20',
    customer_id: 'c1',
    customer_name: '影像组',
    l1_customer_name: '某某集团',
    // 2026-10-17 新增：第 2 层到叶子的 ` / ` 拼接，不含 L1
    customer_path: '终端BG / 手机部 / 影像组',
    ...over,
  };
  return base as PartDetailDto;
}

/**
 * 本卡片的 props 是一整组（part 之外还有编辑态与状态映射函数），全给最小值即可 ——
 * 本 spec 只关心「客户」那一格，不该被别的分支带偏。
 */
function mountCard(p: PartDetailDto | null) {
  return mount(PartInfoCard, {
    props: {
      part: p,
      editing: false,
      saving: false,
      // 最小编辑表单：本 spec 不走编辑分支，给一份合法的空表单即可
      form: {
        name: p?.name ?? '',
        drawing_no: p?.drawing_no ?? '',
        quantity: p?.quantity ?? 1,
        is_urgent: false,
        planned_delivery_date: p?.planned_delivery_date ?? '2026-10-20',
        order_no: null,
        system_delivery_date: null,
        note: null,
      },
      infoLoading: false,
      canEditPart: false,
      statusLabel: (s: string) => s,
      statusTagType: () => 'info',
    },
    global: {
      components: {
        ElCard: ElCardStub,
        ElDescriptions: ElDescriptionsStub,
        ElDescriptionsItem: ElDescriptionsItemStub,
        ElInput: ElInputStub,
        ElTag: ElTagStub,
      },
    },
  });
}

/** 取「客户」那一格的文案。 */
function customerCellText(p: PartDetailDto | null): string {
  const wrapper = mountCard(p);
  const item = wrapper
    .findAll('.el-descriptions-item-stub')
    .find((n) => n.attributes('label') === '客户');
  const text = item?.text() ?? '';
  wrapper.unmount();
  return text;
}

describe('PartInfoCard 客户行', () => {
  it('X1：读 customer_path（任意深度的 ` / ` 拼接），不再前端拼 L1 + 单段名', () => {
    expect(customerCellText(part())).toBe('终端BG / 手机部 / 影像组');
    // 旧实现给的是「某某集团 / 影像组」；显式断掉那个形态
    expect(customerCellText(part())).not.toBe('某某集团 / 影像组');
  });

  it('X2：customer_path 为空串时退回 customer_name（客户软删 / 父链成环）', () => {
    expect(customerCellText(part({ customer_path: '' }))).toBe('影像组');
    expect(customerCellText(part({ customer_path: null }))).toBe('影像组');
  });

  it('X3：两个字段都空 → 模板落占位破折号（不是空白格）', () => {
    // computed 返空串，占位由模板的 `|| '—'` 兜住 —— 断言渲染结果而不是内部值。
    expect(customerCellText(part({ customer_path: null, customer_name: null }))).toBe('—');
  });

  it('X4：详情卡不塞 L1 次行（每行只有「标签 : 值」一格；L1 在零件一览可见）', () => {
    expect(customerCellText(part())).not.toContain('某某集团');
  });

  it('X5：part 为 null 时不抛（详情未加载完的那一帧）', () => {
    expect(customerCellText(null)).toBe('');
  });
});
