// @vitest-environment happy-dom
// src/views/scan/components/__tests__/BatchPickerDialog.spec.ts
//
// 2026-10-03 新增：holder 文本与 meta 行的渲染契约守卫。本组件是**跨域共享组件**
// （views/scan/ 三页 + views/delivery/PartPickerDialog + views/inspection/InspectionPending），
// 2026-10-03 给它加了「3 个判据键一个都不在的窄 VO ⇒ holderText 返空 ⇒ meta 行整行隐藏」
// 这条分支。两头都要钉住：
//   - views/scan/ 三页（`PartListItem` 形态）行为**一字未变**，否则报工台卡片静默少一行信息；
//   - views/delivery/（`DeliveryNoteCandidatePart` 形态）**确实变了**：meta 行整行不再渲染。
//     它消掉的是恒显的「未知位置」无信息量文案，属本次一并接受的观感变化，用例把它钉死，
//     免得后来人误判成回归又改回去。
//
// 判据是「键在不在」而不是「值是否 null」，理由与脆弱点见 BatchPickerDialog.holderText 注释。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import BatchPickerDialog from '../BatchPickerDialog.vue';
import type { PartItem } from '@/api/parts';
import type { DeliveryNoteCandidatePart } from '@/types/deliveryNote';

/** 前端 `PartItem` 宽形态（判据键显式全带上）的最小子集。
 *
 *  2026-10-03 注意：这是**前端 TS 形态**的 fixture，不是运行时形态。后端 `PartListItem`
 *  的 3 个判据键里只有 `location` 存在（另两个键不在该 VO 内）⇒ 真实数据恒走 default 分支、
 *  holder 文本恒取 `location`。下面的三分支用例测的是 `PartItem` 声明的契约，不是当前
 *  生产数据会走的路径。 */
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

/** 15 字段窄 VO（送货单候选入单 DeliveryNoteCandidatePart，cast 进 props）。
 *
 *  显式标上类型是有意的：这条用例的全部价值就是「证明 3 个判据键一个都不在」，
 *  一旦后端给该 VO 加了 `location` / `current_holder_*` 字段，`tsc` 就会因缺字段报错，
 *  逼着改用例而不是让它静默继续通过。 */
const DELIVERY_ROW: DeliveryNoteCandidatePart = {
  id: '190000000000201',
  batch_id: '190000000000301',
  batch_no: 2,
  batch_label: 'L2',
  serial_no: 'SN-D',
  drawing_no: 'DWG-D',
  name: '零件 D',
  quantity: 4,
  applicant_name: null,
  status: 'INSPECTION',
  planned_delivery_date: null,
  order_no: 'SO-1',
  customer_name: '二级客户',
  parent_customer_name: '一级客户',
  customer_path: null,
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
    // ⚠️ 本用例的断言对象是**运行时数据**，而 fixture 自己显式带上了 3 个键 ⇒ 它证明不了
    // 「键真的在」。那条不变量完全依赖后端 `PartListItem.location` 不加
    // `skip_serializing_if`：后端一旦加上，`'location' in p` 转 false、holderText 返空、
    // 报工台卡片静默少掉这一行，而本用例仍绿。views/scan/ 三页零 spec，这个盲区是既存的。
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

  it('送货单候选 VO（DeliveryNoteCandidatePart，15 字段无 holder 键）：meta 行不渲染', () => {
    // 2026-10-03：这条路径在空串分支落地时**行为变了**（原本恒显「未知位置」），
    // 消掉的是无信息量文案，属一并接受的观感变化。钉在这里是为了让后来人知道这是有意为之，
    // 不是回归 —— 真要恢复那行的话，改本用例而不是改 holderText。
    const w = render([DELIVERY_ROW]);
    expect(w.text()).not.toContain('未知位置');
    expect(w.find('.batch-meta').exists()).toBe(false);
    expect(w.find('.holder').exists()).toBe(false);
    // 卡片首行照常渲染（这条路径的实质收益：不再多一行空文案，但信息没丢）。
    expect(w.text()).toContain('SN-D');
    expect(w.text()).toContain('零件 D');
    expect(w.text()).toContain('批次2');
  });

  it('送货单候选 VO + 显式带上 location 键：判据立刻转 true、meta 行回来（守 `in` 而非值）', () => {
    // 守住判据本身是「键在不在」：只要运行时对象带上了 3 个判据键中的任意一个，
    // 就该走 default 分支显示兜底，而不是继续隐藏。
    const w = render([{ ...DELIVERY_ROW, location: null } as unknown as PartItem]);
    expect(w.text()).toContain('未知位置');
    expect(w.find('.batch-meta').exists()).toBe(true);
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
