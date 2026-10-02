// @vitest-environment happy-dom
// src/views/scan/components/__tests__/BatchPickerDialog.spec.ts
//
// 2026-10-03 新增：holder 文本与 meta 行的渲染契约守卫。本组件是**跨域共享组件**
// （views/scan/ 三页 + views/delivery/PartPickerDialog + views/inspection/），2026-10-03
// 给它加了「窄 VO（无 holder 键）⇒ holderText 返空 ⇒ meta 行整行隐藏」这条分支，
// 必须钉住「宽 VO 调用方行为一字未变」，否则会静默让报工台的卡片少一行信息。
//
// 判据是「键在不在」而不是「值是否 null」：28 字段 VO 的 location 可合法为 null
// （尚未上架的 PENDING 批次），那种场景仍要显示兜底文案「未知位置」。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import BatchPickerDialog from '../BatchPickerDialog.vue';
import type { PartItem } from '@/api/parts';

/** 28 字段宽 VO 的最小子集（holder 相关的键恒在，值可为 null）。 */
function wideRow(over: Partial<PartItem> = {}): PartItem {
  const row: PartItem = {
    id: 'P1',
    version: 1,
    serial_no: 'SN-1',
    name: '零件 1',
    drawing_no: 'DWG-1',
    quantity: 5,
    planned_delivery_date: '2026-10-01',
    is_urgent: false,
    status: 'IN_PROCESS',
    order_no: null,
    system_delivery_date: null,
    note: null,
    customer_name: null,
    parent_customer_name: null,
    customer_path: null,
    assembly_id: null,
    current_holder_kind: null,
    shelf_code: null,
    worker_name: null,
    outsource_company_name: null,
    location: 'PRODUCTION_SHELF',
    next_process_id: null,
    next_process_name: null,
    ...over,
  };
  return row;
}

/** 13 字段窄 VO（待品检 InspectionQueueItem，cast 进 props）——一个 holder 键都没有。 */
const NARROW_ROW = {
  batch_id: '190000000000001',
  batch_no: 3,
  quantity: 10,
  version: 7,
  part_id: '190000000000101',
  serial_no: 'SN-A',
  drawing_no: 'DWG-A',
  name: '零件 A',
  system_delivery_date: '2026-10-20',
  is_urgent: false,
  customer_id: '9000000000001',
  customer_name: '二级客户',
  l1_customer_name: '一级客户',
};

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title', 'width'],
    template: '<div class="mock-dialog" :data-title="title"><slot /><slot name="footer" /></div>',
  },
  'el-card': { name: 'ElCardStub', template: '<div class="mock-card"><slot /></div>' },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  'el-button': { name: 'ElButtonStub', template: '<button><slot /></button>' },
};

function render(rows: unknown[]) {
  return mount(BatchPickerDialog, {
    props: { modelValue: true, code: 'SN-1', rows: rows as PartItem[] },
    global: { stubs },
  });
}

describe('BatchPickerDialog / holder 文本与 meta 行', () => {
  it('宽 VO：current_holder_kind 三分支各自取对应名字', () => {
    const shelf = render([wideRow({ current_holder_kind: 'shelf', shelf_code: 'A-01' })]);
    expect(shelf.text()).toContain('货架 A-01');
    const worker = render([wideRow({ current_holder_kind: 'worker', worker_name: '张三' })]);
    expect(worker.text()).toContain('工人 张三');
    const outsource = render([
      wideRow({ current_holder_kind: 'outsource_company', outsource_company_name: '恒信' }),
    ]);
    expect(outsource.text()).toContain('外协 恒信');
  });

  it('宽 VO：kind 已知但名字为 null 时显示「货架 —」这类占位（不是空）', () => {
    const w = render([wideRow({ current_holder_kind: 'shelf', shelf_code: null })]);
    expect(w.text()).toContain('货架 —');
  });

  it('宽 VO：kind 为 null 时回退 current_holder_display → location', () => {
    expect(render([wideRow({ current_holder_display: '品检 A-01' })]).text()).toContain(
      '品检 A-01',
    );
    // current_holder_display 为 null 时落到 location。
    expect(
      render([wideRow({ current_holder_display: null, location: 'PRODUCTION_SHELF' })]).text(),
    ).toContain('PRODUCTION_SHELF');
  });

  it('宽 VO：holder 三个键全为 null 时仍显示兜底「未知位置」（报工台行为未变）', () => {
    const w = render([
      wideRow({ current_holder_display: null, location: null, current_holder_kind: null }),
    ]);
    expect(w.text()).toContain('未知位置');
    expect(w.find('.batch-meta').exists()).toBe(true);
  });

  it('窄 VO（13 字段，无 holder 键）：不显示「未知位置」，holder 也不占 meta 行', () => {
    const w = render([NARROW_ROW]);
    expect(w.text()).not.toContain('未知位置');
    // holder 与 next_process_name 都没有 ⇒ meta 行整行不渲染（不留空行）。
    expect(w.find('.batch-meta').exists()).toBe(false);
    // 其余卡片信息照常渲染。
    expect(w.text()).toContain('SN-A');
    expect(w.text()).toContain('批次3');
  });

  it('窄 VO + 有下一工序：meta 行保留（只去掉 holder 那一段）', () => {
    const w = render([{ ...NARROW_ROW, next_process_name: '车削' }]);
    expect(w.find('.batch-meta').exists()).toBe(true);
    expect(w.text()).toContain('下一工序：车削');
    expect(w.find('.holder').exists()).toBe(false);
    expect(w.text()).not.toContain('未知位置');
  });

  it('卡片按 batch_no 升序展示', () => {
    const w = render([
      { ...NARROW_ROW, batch_id: 'B2', batch_no: 9 },
      { ...NARROW_ROW, batch_id: 'B1', batch_no: 2 },
    ]);
    const tags = w.findAll('.mock-tag').map((t) => t.text());
    expect(tags).toEqual(['批次2', '批次9']);
  });
});
