// partsPermissions.ts 单元测试（2026-10-03 打印链路转发 v2）。
//
// 验证 utils/partsPermissions.canPrintPartDrawing：单件图纸打印入口的角色闸门
// 必须与后端 rust v2 转发端点的 require_any_role 白名单逐角色对齐
// （MANAGER / CLERK / INSPECTOR / CNC_PROGRAMMER 放行）。
//
// 用 it.each 覆盖每个角色的正负两侧，防止将来有人把闸门改回 `!isInspector`
// 之类的近似式（那会让 INSPECTOR 看不到按钮、货架账号点下去 403）。

import { describe, expect, it } from 'vitest';
import { canPrintPartDrawing, type PartRoleMapLike } from '../partsPermissions';

describe('canPrintPartDrawing', () => {
  it.each<[string, PartRoleMapLike]>([
    ['MANAGER', { MANAGER: true }],
    ['CLERK', { CLERK: true }],
    ['INSPECTOR', { INSPECTOR: true }],
    ['CNC_PROGRAMMER', { CNC_PROGRAMMER: true }],
  ])('%s 可见入口（后端放行）', (_role, map) => {
    expect(canPrintPartDrawing(map)).toBe(true);
  });

  it('空角色集（未登录 / 无角色）不可见', () => {
    expect(canPrintPartDrawing({})).toBe(false);
  });

  it('多角色账号按「命中任一放行角色」放行（MANAGER + CLERK）', () => {
    expect(canPrintPartDrawing({ MANAGER: true, CLERK: true })).toBe(true);
  });

  it('PART 域其它角色一律不可见（防止新增角色被默认放行）', () => {
    expect(canPrintPartDrawing({ INSPECTOR: false, CLERK: false })).toBe(false);
  });
});
