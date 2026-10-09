// src/views/parts/detail/composables/__tests__/inspectionBatch.spec.ts
//
// 2026-10-10 新增（review 第 1 轮 重要 3）：品检锚批次派生的三种情形。
//
// 这条派生同时喂三处：按钮显隐、「目标批次 X」标识 / 弹窗回显、两个品检写动作的
// 锚。任一处与其它不一致，用户就会在「界面上一个批次、写下去另一个批次」上翻车。
//
// 口径演进（都留着，因为两条都是真 bug）：
//   - 改之前：品检通过按 `find(INSPECTION)`，指定工序按 shell 传的 `selectedBatchId`
//     ⇒ **两个按钮锚不同批次**（多批次工单上真实发生；后端
//     `fix(batch): find_current_inspection_batch_id 遇多 INSPECTION 批次改返 id 不返 500`
//     说明多 INSPECTION 批次是真实场景）。
//   - 改成只按 `find(INSPECTION)`：两个按钮同批了，但变成了**忽略用户选择** ——
//     用户选中 B2、点「指定工序」却打在 B1 上。
//   - 现行：选中的批次是品检中就用它，否则回落 `find(INSPECTION)`。两条同时成立。

import { describe, expect, it } from 'vitest';
import { resolveInspectionBatch } from '../inspectionBatch';
import type { PartBatch } from '@/api/parts';

function makeBatch(over: Partial<PartBatch> = {}): PartBatch {
  return {
    id: '3000000000001',
    version: 1,
    part_id: '219276974948876288',
    batch_no: 1,
    batch_label: 'B1',
    quantity: 5,
    status: 'INSPECTION',
    is_repairing: false,
    location: null,
    current_holder_id: null,
    current_holder_display: null,
    next_process_name: null,
    delivery_note_id: null,
    delivery_note_no: null,
    parent_batch_id: null,
    created_at: '2026-10-01 08:00:00',
    updated_at: '2026-10-01 08:00:00',
    ...over,
  };
}

const PENDING = makeBatch({ id: 'B_PENDING', batch_label: 'B1', status: 'PENDING' });
const INSPECT_A = makeBatch({ id: 'B_A', batch_label: 'B2', status: 'INSPECTION' });
const INSPECT_B = makeBatch({ id: 'B_B', batch_label: 'B3', status: 'INSPECTION' });

describe('I1：resolveInspectionBatch 的三种派生', () => {
  it('I1a：没选中 → 回落列表序第一个 INSPECTION', () => {
    expect(resolveInspectionBatch([PENDING, INSPECT_A, INSPECT_B], null)?.id).toBe('B_A');
  });

  it('I1b：选中的那条**是**品检批次 → 用它（尊重选择，不是 find 的第一条）', () => {
    expect(resolveInspectionBatch([PENDING, INSPECT_A, INSPECT_B], 'B_B')?.id).toBe('B_B');
    // 选中的就是列表第一条时结果不变（口径一致，不引入分叉）
    expect(resolveInspectionBatch([PENDING, INSPECT_A, INSPECT_B], 'B_A')?.id).toBe('B_A');
  });

  it('I1c：选中的**不是**品检批次 → 静默回落到 find(INSPECTION)（界面上有锚批次标识）', () => {
    expect(resolveInspectionBatch([PENDING, INSPECT_A, INSPECT_B], 'B_PENDING')?.id).toBe('B_A');
    // 选中一个不存在的 id（批次刚被别的标签页删掉）也走回落，不返回 undefined 让按钮崩
    expect(resolveInspectionBatch([PENDING, INSPECT_A, INSPECT_B], 'GONE')?.id).toBe('B_A');
  });

  it('I1d：没有任何 INSPECTION 批次 → null（按钮整排隐藏 / 动作拒发 + 警告）', () => {
    expect(resolveInspectionBatch([], null)).toBeNull();
    expect(resolveInspectionBatch([PENDING], 'B_PENDING')).toBeNull();
    expect(resolveInspectionBatch([], 'B_A')).toBeNull();
  });
});
