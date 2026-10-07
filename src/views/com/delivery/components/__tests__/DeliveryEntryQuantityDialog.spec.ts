// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryEntryQuantityDialog.spec.ts
//
// 2026-10-08 新增：入单数量对话框的守卫。
//
// 钉的是三条业务硬约束：
//   1. 零件行输**件数**、装配件行输**套数**（同一个组件两种形态，由 kind 决定）；
//   2. 默认值 = 可入单上限（用户多数时候就是要全量入单）+ 上界校验（超出后端一律
//      21405 `BIZ_DELIVERY_NOTE_PART_NOT_READY`，前端拦一道省一次往返）；
//   3. 装配件展示 `per_set_parts` 的「每套需 F1001-01 3 件」。
//
// EP 组件一律走 global.stubs（vitest.config.ts 不挂 unplugin-vue-components，
// kebab 标签不会被自动 import 成具名组件）。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DeliveryEntryQuantityDialog from '../DeliveryEntryQuantityDialog.vue';

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    template:
      '<div class="mock-el-dialog" :data-title="title"><slot /><slot name="footer" /></div>',
  },
  'el-form': { template: '<form><slot /></form>' },
  'el-form-item': {
    name: 'ElFormItemStub',
    props: ['label'],
    template: '<div class="mock-el-form-item" :data-label="label"><slot /></div>',
  },
  'el-input-number': { name: 'ElInputNumberStub', props: ['modelValue', 'min', 'max'], template: '<input class="mock-el-input-number" :max="max" :min="min" />' },
  'el-button': {
    name: 'ElButtonStub',
    props: ['type', 'size', 'disabled'],
    emits: ['click'],
    template: '<button class="mock-el-button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-el-tag"><slot /></span>' },
};

const partProps = {
  modelValue: true,
  kind: 'PART' as const,
  nodeId: 'P1',
  nodeName: '铝电解电容',
  maxQuantity: 5,
  perSetParts: [],
  partSerials: {},
};

const asmProps = {
  modelValue: true,
  kind: 'ASSEMBLY' as const,
  nodeId: 'A1',
  nodeName: '总装',
  maxQuantity: 2,
  perSetParts: [
    { part_id: 'P1', per_set_quantity: 3 },
    { part_id: 'P2', per_set_quantity: 2 },
  ],
  partSerials: { P1: 'F1001-01', P2: 'F1001-02' },
};

describe('DeliveryEntryQuantityDialog', () => {
  it('零件形态：标题带零件名、标签是「入单件数」、默认 = 可入单上限', () => {
    const w = mount(DeliveryEntryQuantityDialog, { props: partProps, global: { stubs } });
    expect(w.attributes('data-title')).toBe('零件入单 — 铝电解电容');
    expect(w.find('[data-label="入单件数"]').exists()).toBe(true);
    expect(w.text()).toContain('可入单上限 5 件');
    expect(w.find('.mock-el-input-number').attributes('max')).toBe('5');
  });

  it('装配件形态：标签是「入单套数」、默认 = entry_max_sets、单位套', () => {
    const w = mount(DeliveryEntryQuantityDialog, { props: asmProps, global: { stubs } });
    expect(w.attributes('data-title')).toBe('装配件入单 — 总装');
    expect(w.find('[data-label="入单套数"]').exists()).toBe(true);
    expect(w.text()).toContain('可入单上限 2 套');
    expect(w.find('.mock-el-input-number').attributes('max')).toBe('2');
  });

  it('装配件展示 per_set_parts（part_id 翻成子件序列号 + 每套件数）', () => {
    const w = mount(DeliveryEntryQuantityDialog, { props: asmProps, global: { stubs } });
    expect(w.text()).toContain('F1001-01 3 件');
    expect(w.text()).toContain('F1001-02 2 件');
  });

  it('per_set_parts 为空 → 明说没有子件用量信息（不留空白）', () => {
    const w = mount(DeliveryEntryQuantityDialog, {
      props: { ...asmProps, perSetParts: [] },
      global: { stubs },
    });
    expect(w.text()).toContain('没有子件用量信息');
  });

  it('零件形态不展示「每套用量」行', () => {
    const w = mount(DeliveryEntryQuantityDialog, { props: partProps, global: { stubs } });
    expect(w.find('[data-label="每套用量"]').exists()).toBe(false);
  });

  it('确认时 emit 的 kind / nodeId / quantity 跟着形态走', async () => {
    const part = mount(DeliveryEntryQuantityDialog, { props: partProps, global: { stubs } });
    await part.findAll('button.mock-el-button').at(-1)!.trigger('click');
    expect(part.emitted('submit')![0]).toEqual([
      { kind: 'PART', nodeId: 'P1', quantity: 5 },
    ]);

    const asm = mount(DeliveryEntryQuantityDialog, { props: asmProps, global: { stubs } });
    await asm.findAll('button.mock-el-button').at(-1)!.trigger('click');
    expect(asm.emitted('submit')![0]).toEqual([
      { kind: 'ASSEMBLY', nodeId: 'A1', quantity: 2 },
    ]);
  });

  it('可入单上限为 0 的节点 → 「确定」disabled（默认 1 已越界；发出去后端必 21405）', () => {
    const w = mount(DeliveryEntryQuantityDialog, {
      props: { ...partProps, maxQuantity: 0 },
      global: { stubs },
    });
    expect(w.findAll('button.mock-el-button').at(-1)!.attributes('disabled')).toBeDefined();
    expect(w.emitted('submit')).toBeUndefined();
  });

  it('取消不 emit submit', async () => {
    const w = mount(DeliveryEntryQuantityDialog, { props: partProps, global: { stubs } });
    await w.findAll('button.mock-el-button').at(-2)!.trigger('click');
    expect(w.emitted('submit')).toBeUndefined();
  });
});
