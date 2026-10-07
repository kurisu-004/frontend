// src/views/com/delivery/composables/__tests__/deliveryScanTreeSchema.spec.ts
//
// 2026-10-08 新增：扫码三层树 schema 的**可空性**回归。
//
// 本文件钉的核心不变量：`deliveryScanPartSchema.serial_no` **必须能接 null**。它一旦被
// 写成 `z.string()`（键必填），扫到含无序列号子件的装配件时整棵树 parse 抛、扫码入单弹窗
// 打不开 —— 而「没有序列号的子件」是**常态**而非边缘情况：
//   · `t_part.serial_no` 可空，且 migration `007_serial_release` 把终态（COMPLETED /
//     CANCELLED）行的序列号**主动置 NULL**、已对存量跑过；
//   · 后端 `repo/scan_tree.rs::list_parts_by_assembly` 不过滤状态，排序特意写
//     `serial_no ASC NULLS LAST, id ASC`，注释原文是「让没序列号的手工子件排在末尾」。
// ⇒ 后端**明确预期** NULL 存在，前端 schema 把它当合法态而不是异常态（同一故障形态此前
// 已经真出现过：行项 `version` / `assembly_id` 两个必填炸弹让详情页与草稿看板永久空白）。
//
// 「字段名 / 可空性 ↔ 后端 VO」的整体对账在 `deliveryNoteSchema.spec.ts` 的
// `BACKEND_VO_*` / `BACKEND_VO_NULLABLE_FIELDS` 清单里；本文件只钉**行为态**
// （真实 wire 上真的会出现的形状能 parse，且 null 原样保留不被折叠成空串 / 0）。

import { describe, expect, it } from 'vitest';
import { deliveryScanTreeSchema } from '../deliveryScanTreeSchema';

function batch(over: Record<string, unknown> = {}) {
  return {
    id: 'B1',
    batch_no: 1,
    quantity: 5,
    status: 'READY_TO_SHIP',
    version: 3,
    is_repairing: false,
    location: 'PRODUCTION_SHELF',
    current_holder_display: null,
    process_name: null,
    is_scanned: false,
    occupied_by_note_no: null,
    ...over,
  };
}

function part(over: Record<string, unknown> = {}) {
  return {
    id: 'P1',
    // ⚠️ 默认就是 null —— 本文件钉的就是这个形态（手工子件 / 终态工单）。
    serial_no: null,
    name: '子件',
    drawing_no: 'D-1',
    status: 'READY_TO_SHIP',
    quantity: 9,
    is_urgent: false,
    system_delivery_date: null,
    customer_name: '法拉',
    version: 1,
    customer_id: '11',
    entry_max_quantity: 5,
    children: [batch()],
    ...over,
  };
}

/** 一棵装配件树：assembly + 一个**无序列号**子件。 */
function tree(over: Record<string, unknown> = {}) {
  return {
    hit_kind: 'ASSEMBLY',
    scanned_serial_no: 'F1001',
    draft: null,
    assembly: {
      id: 'A1',
      serial_no: 'F1001',
      name: '总装',
      drawing_no: 'ASM-1',
      status: 'READY_TO_SHIP',
      quantity: 3,
      is_urgent: false,
      system_delivery_date: null,
      customer_name: '法拉',
      customer_id: '11',
      entry_max_sets: 2,
      per_set_parts: [{ part_id: 'P1', per_set_quantity: 3 }],
    },
    children: [part()],
    ...over,
  };
}

describe('deliveryScanTreeSchema —— 无序列号子件（本轮 blocker 的回归）', () => {
  it('零件节点 serial_no: null 能 parse，且 null 原样保留', () => {
    const parsed = deliveryScanTreeSchema.parse(tree());
    expect(parsed.children[0]!.serial_no).toBeNull();
    // 其余字段一个不少：nullable 只放宽 serial_no，不许顺手把别的字段也改成可空。
    expect(parsed.children[0]!.name).toBe('子件');
    expect(parsed.children[0]!.entry_max_quantity).toBe(5);
    expect(parsed.children[0]!.children[0]!.batch_no).toBe(1);
  });

  it('装配件节点 serial_no: null 同样接（同一口径：终态装配件也被释放序列号）', () => {
    const t = tree();
    (t.assembly as Record<string, unknown>).serial_no = null;
    expect(deliveryScanTreeSchema.parse(t).assembly?.serial_no).toBeNull();
  });

  it('独立件树（assembly: null）+ 无序列号子件：同样能 parse', () => {
    const parsed = deliveryScanTreeSchema.parse(tree({ assembly: null }));
    expect(parsed.assembly).toBeNull();
    expect(parsed.children[0]!.serial_no).toBeNull();
  });

  it('后端其它 Option 字段显式 null 一并接（draft / 交期 / 客户 / 批次持有者 / 占用单号）', () => {
    // 一次点过整条链的可空态，避免「只测了 serial_no、下一条 Option 又漏」这种逐个漏。
    const t = tree({
      draft: null,
      assembly: {
        ...(tree().assembly as Record<string, unknown>),
        serial_no: null,
        system_delivery_date: null,
        customer_name: null,
      },
      children: [
        part({
          serial_no: null,
          system_delivery_date: null,
          customer_name: null,
          children: [batch({ location: null, current_holder_display: null, process_name: null })],
        }),
      ],
    });
    const parsed = deliveryScanTreeSchema.parse(t);
    expect(parsed.draft).toBeNull();
    expect(parsed.assembly?.customer_name).toBeNull();
    expect(parsed.children[0]!.children[0]!.location).toBeNull();
    expect(parsed.children[0]!.children[0]!.occupied_by_note_no).toBeNull();
  });

  it('serial_no 仍是键必填（后端恒发该键）—— 键消失要红，可空不等于可缺', () => {
    const raw = tree();
    delete (raw.children[0] as Record<string, unknown>).serial_no;
    expect(() => deliveryScanTreeSchema.parse(raw)).toThrow();
  });
});