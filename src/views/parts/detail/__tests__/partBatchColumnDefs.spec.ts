// src/views/parts/detail/__tests__/partBatchColumnDefs.spec.ts
//
// 2026-10-10 新增：批次监控 5 列 ColumnDef 工厂的回归守卫。
//
// 为什么要有：列定义从 `PartBatchMonitorCard.vue` 内联数组搬进
// `partBatchColumnDefs.ts`（域根单域专用文件）。搬运的风险有三处，各钉一条：
//   1. **列 key 集合变了** —— `useColumnVisibility` / `useColumnDrag` 两侧都按
//      `listKey = 'part_batch_monitor'` 存用户本地的可见性 / 列序快照，改 key 等于
//      让存量快照失配（后果：列回到默认可见、排到其余列之后）；
//   2. **「操作」列被顺手搬进来** —— 它受 `canManageBatches` 控制且必须
//      `fixed="right"`，两种形态都不进 defs（模板里是字面量 `<el-table-column>`）；
//   3. **cellRender 的行为变了** —— 状态列的标签类型 / 文案来自注入的 helper，空值列的
//      「—」占位、`batch_label` 的等宽 class 都得原样。
//
// 断言手法：不 mount，直接读 `cellRender` 产出的 VNode —— `h(ElTag, …)` 的
// `vnode.props.type` 与函数式插槽的返回值都可直接读，不需要真渲染 element-plus
// （同 `views/cnc/__tests__/pendingProgrammingColumnDefs.spec.ts`）。

import { describe, expect, it, vi } from 'vitest';
import { ElTag } from 'element-plus';
import type { VNode } from 'vue';
import { buildPartBatchColumnDefs } from '../partBatchColumnDefs';
import type { PartBatch } from '@/api/parts';
import type { OrderStatus } from '@/types/parts';

const statusTagType = vi.fn(
  (s: OrderStatus) => (s === 'INSPECTION' ? 'warning' : 'info') as 'warning' | 'info',
);
const statusLabelOf = vi.fn((s: string | null | undefined) => `标签:${s ?? ''}`);

function defs() {
  return buildPartBatchColumnDefs({ statusTagType, statusLabelOf });
}

function makeBatch(over: Partial<PartBatch> = {}): PartBatch {
  return {
    id: '190000000000001',
    version: 1,
    part_id: '42',
    batch_no: 1,
    batch_label: 'L1',
    quantity: 10,
    status: 'INSPECTION',
    is_repairing: false,
    location: 'INSPECTION_SHELF',
    current_holder_id: '8800000000001',
    current_holder_display: '',
    current_process_step_id: null,
    next_process_name: null,
    delivery_note_id: null,
    delivery_note_no: '',
    parent_batch_id: null,
    created_at: '2026-10-10 08:00:00',
    updated_at: '2026-10-10 08:00:00',
    ...over,
  };
}

function cell(key: string, row: PartBatch): VNode {
  const def = defs().find((d) => d.key === key);
  if (!def?.cellRender) throw new Error(`${key} 列缺 cellRender`);
  return def.cellRender({ row, column: {}, $index: 0 }) as VNode;
}

/** vnode 的文本内容。`h()` 对字符串 children 原样保留、对数字会先 String 化。 */
function textOf(vnode: VNode): string {
  const c = vnode.children;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'object' ? '' : String(x))).join('');
  return c === null || c === undefined ? '' : String(c);
}

/** 函数式插槽 `() => vnode` 的返回值（未渲染时 children 是 `{ default: fn }`）。 */
function slotText(vnode: VNode): string {
  const slots = vnode.children as unknown as { default?: () => VNode | VNode[] | string };
  const out = slots.default?.();
  if (typeof out === 'string') return out;
  const child = (Array.isArray(out) ? out[0]! : out)!;
  return typeof child === 'string' ? child : (child.children as string);
}

describe('buildPartBatchColumnDefs', () => {
  it('B1：列 key 集合与顺序恰为 5 列（快照键 part_batch_monitor 依赖它）', () => {
    expect(defs().map((d) => d.key)).toEqual([
      'batch_label',
      'quantity',
      'status',
      'current_holder_display',
      'delivery_note_no',
    ]);
    expect(defs().map((d) => d.label)).toEqual(['批次', '数量', '状态', '所在位置', '送货单']);
  });

  it('B2：「操作」列不进 defs（受 canManageBatches 控制 + fixed="right"，模板里是字面量）', () => {
    expect(defs().some((d) => d.key === 'actions')).toBe(false);
    expect(defs().every((d) => d.fixed !== 'right')).toBe(true);
  });

  it('B3：batch_label 渲染进 .batch-label 且值为原样（不加任何前后缀）', () => {
    const node = cell('batch_label', makeBatch({ batch_label: 'L7' }));
    expect(node.props?.class).toBe('batch-label');
    expect(textOf(node)).toBe('L7');
  });

  it('B4：batch_label 为空串时渲染空文本而不是 "undefined"', () => {
    const node = cell('batch_label', makeBatch({ batch_label: '' }));
    expect(textOf(node)).toBe('');
  });

  it('B5：quantity 渲染裸数字（不带千分位 / 单位等格式化）', () => {
    const node = cell('quantity', makeBatch({ quantity: 128 }));
    expect(textOf(node)).toBe('128');
  });

  it('B6：status 渲染 ElTag，类型与文案都来自注入的 helper', () => {
    statusTagType.mockClear();
    statusLabelOf.mockClear();
    const node = cell('status', makeBatch({ status: 'INSPECTION' }));
    expect(node.type).toBe(ElTag);
    expect(node.props?.type).toBe('warning');
    expect(node.props?.size).toBe('small');
    expect(node.props?.effect).toBe('plain');
    expect(statusTagType).toHaveBeenCalledWith('INSPECTION');
    // 文案在函数式插槽里求值 ⇒ 先取文本再断言被调用的参数
    expect(slotText(node)).toBe('标签:INSPECTION');
    expect(statusLabelOf).toHaveBeenCalledWith('INSPECTION');
  });

  it('B7：所在位置 / 送货单的空值回落为「—」，有值时原样渲染', () => {
    expect(textOf(cell('current_holder_display', makeBatch({ current_holder_display: '' })))).toBe(
      '—',
    );
    expect(
      textOf(cell('current_holder_display', makeBatch({ current_holder_display: '工人 A' }))),
    ).toBe('工人 A');
    expect(textOf(cell('delivery_note_no', makeBatch({ delivery_note_no: '' })))).toBe('—');
    expect(textOf(cell('delivery_note_no', makeBatch({ delivery_note_no: 'DN-9' })))).toBe('DN-9');
  });

  it('B8：两个文本列都开 showOverflowTooltip（长持有人名 / 送货单号靠气泡看全）', () => {
    const byKey = new Map(defs().map((d) => [d.key, d]));
    expect(byKey.get('current_holder_display')?.showOverflowTooltip).toBe(true);
    expect(byKey.get('delivery_note_no')?.showOverflowTooltip).toBe(true);
  });
});
