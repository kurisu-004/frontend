// src/views/dashboard/__tests__/rowClickRoute.spec.ts
//
// routeRowClick（交期面板「点行去哪」的分流判据）纯函数契约。
//
// 覆盖三条互斥分支 + 与判据同源的 isRowClickable 语义：
//   - R1：零件行（row_type='PART'）→ 'preview'（进零件预览弹窗）
//   - R2：装配件行（row_type='ASSEMBLY'）+ 有权 → 'children'（进子件列表弹窗）
//   - R3：装配件行 + 无权（SHELF_ACCOUNT）→ 'blocked'（静默忽略，不弹任何东西）
//   - R4：零件行**不**受角色闸门约束（既有的不对称取舍，钉住不被顺手改掉）
//   - R5：'blocked' 与其它值互斥（穷举 2×2 组合，不漏格）

import { describe, expect, it } from 'vitest';
import { routeRowClick } from '../rowClickRoute';

/** 只带分流需要的字段 —— 真实行是 SystemDeliveryOrderData，其余字段与判据无关。 */
function makeRow(row_type: 'PART' | 'ASSEMBLY'): { row_type: 'PART' | 'ASSEMBLY' } {
  return { row_type };
}

describe('routeRowClick — 交期面板行点击分流', () => {
  it('R1：零件行 → preview（无论角色权限）', () => {
    expect(routeRowClick(makeRow('PART'), true)).toBe('preview');
  });

  it('R2：装配件行 + 有权 → children（进子件列表弹窗）', () => {
    expect(routeRowClick(makeRow('ASSEMBLY'), true)).toBe('children');
  });

  it('R3：装配件行 + 无权（SHELF_ACCOUNT）→ blocked（不弹任何东西）', () => {
    expect(routeRowClick(makeRow('ASSEMBLY'), false)).toBe('blocked');
  });

  it('R4：零件行不受角色闸门约束 —— 两个分支的不对称是被记录的取舍', () => {
    // 零件行进 PartPreviewDialog 是既有行为（该弹窗的读端点自己管权限），不借这次
    // 改动扩大或收窄。此用例钉住它，防止后来人看到 R3 就「顺手统一」掉。
    expect(routeRowClick(makeRow('PART'), false)).toBe('preview');
  });

  it('R5：2×2 组合穷举，三个去向互斥且无第四种', () => {
    const routes = new Set([
      routeRowClick(makeRow('PART'), true),
      routeRowClick(makeRow('PART'), false),
      routeRowClick(makeRow('ASSEMBLY'), true),
      routeRowClick(makeRow('ASSEMBLY'), false),
    ]);
    expect(routes).toEqual(new Set(['preview', 'children', 'blocked']));
  });

  it('blocked 判定与 isRowClickable 语义同源（DashboardView 用 !blocked 判可点性）', () => {
    // DashboardView 的 rowClickable 谓词就是 `routeRowClick(...) !== 'blocked'`，
    // 这条钉住「判可点性」与「判去向」不会出现两处口径漂移。
    const isClickable = (row: { row_type: 'PART' | 'ASSEMBLY' }, can: boolean) =>
      routeRowClick(row, can) !== 'blocked';

    expect(isClickable(makeRow('PART'), false)).toBe(true);
    expect(isClickable(makeRow('PART'), true)).toBe(true);
    expect(isClickable(makeRow('ASSEMBLY'), true)).toBe(true);
    expect(isClickable(makeRow('ASSEMBLY'), false)).toBe(false);
  });
});
