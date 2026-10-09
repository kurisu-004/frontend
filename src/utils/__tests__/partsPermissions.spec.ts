// partsPermissions.ts 单元测试（2026-10-03 打印链路转发 v2）。
//
// 验证 utils/partsPermissions.canPrintPartDrawing：单件图纸打印入口的角色闸门
// 必须与后端 rust v2 转发端点的 require_any_role 白名单逐角色对齐
// （MANAGER / CLERK / INSPECTOR / CNC_PROGRAMMER 放行）。
//
// 用 it.each 覆盖每个角色的正负两侧：正向锁住白名单角色表，负向锁住「值为 false
// 即不可见」。防止闸门被写成按单一角色排除的近似式（那会让 INSPECTOR 看不到按钮、
// 货架账号点下去 403）。

import { describe, expect, it } from 'vitest';
import {
  canDownloadPartFile,
  canPrintPartDrawing,
  type PartRoleMapLike,
} from '../partsPermissions';

describe('canPrintPartDrawing', () => {
  it.each<[string, PartRoleMapLike]>([
    ['MANAGER', { MANAGER: true }],
    ['CLERK', { CLERK: true }],
    ['INSPECTOR', { INSPECTOR: true }],
    ['CNC_PROGRAMMER', { CNC_PROGRAMMER: true }],
  ])('%s 可见入口（后端放行）', (_role, map) => {
    expect(canPrintPartDrawing(map)).toBe(true);
  });

  // 负向逐角色：白名单里每个角色的值为 false 时不可见，锁住「读值不读键存在性」
  // （写成 `'MANAGER' in role` 之类的存在性判断会让这些用例全红）。
  it.each<[string, PartRoleMapLike]>([
    ['MANAGER', { MANAGER: false }],
    ['CLERK', { CLERK: false }],
    ['INSPECTOR', { INSPECTOR: false }],
    ['CNC_PROGRAMMER', { CNC_PROGRAMMER: false }],
  ])('%s 为 false 时不可见', (_role, map) => {
    expect(canPrintPartDrawing(map)).toBe(false);
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

// 2026-10-11 新增：图纸文件下载入口（`GET /part-files/{id}/url`）的角色闸门。
//
// 与打印不同一条端点，闸门却**恰好同集合**：后端把 part_file 的列表 / content 对
// SHELF_ACCOUNT 放开了（工控机预览打这两条），`/url` 刻意没放开（直链可外传）。
// 这里逐角色钉死白名单，并单独钉住「纯 SHELF_ACCOUNT 不可见」——
// 那正是工控机账号（报工台路由守卫角色）的形状，漏了它就等于漏了本次改动本身。
describe('canDownloadPartFile', () => {
  const ALLOWED: [string, PartRoleMapLike][] = [
    ['MANAGER', { MANAGER: true }],
    ['CLERK', { CLERK: true }],
    ['INSPECTOR', { INSPECTOR: true }],
    ['CNC_PROGRAMMER', { CNC_PROGRAMMER: true }],
  ];
  const DENIED: [string, PartRoleMapLike][] = [
    ['MANAGER', { MANAGER: false }],
    ['CLERK', { CLERK: false }],
    ['INSPECTOR', { INSPECTOR: false }],
    ['CNC_PROGRAMMER', { CNC_PROGRAMMER: false }],
  ];

  it.each(ALLOWED)('%s 可见下载入口（后端放行）', (_role, map) => {
    expect(canDownloadPartFile(map)).toBe(true);
  });

  // 负向逐角色：白名单里每个角色的值为 false 时不可见，锁住「读值不读键存在性」
  // （写成 `'MANAGER' in role` 之类的存在性判断会让这些用例全红）。
  it.each(DENIED)('%s 为 false 时不可见', (_role, map) => {
    expect(canDownloadPartFile(map)).toBe(false);
  });

  // `PartRoleMapLike` 里**没有** SHELF_ACCOUNT 这个键，纯货架账号天然落在 false 分支
  it('纯 SHELF_ACCOUNT（工控机）不可见下载入口', () => {
    expect(canDownloadPartFile({})).toBe(false);
  });

  it('多角色账号（MANAGER + SHELF_ACCOUNT 形状的白名单腿）按命中任一放行', () => {
    expect(canDownloadPartFile({ MANAGER: true })).toBe(true);
  });

  // 与打印闸门**同集合**：两条端点都只认那 4 个角色。哪天后端只改了其中一条，这条
  // 用例会立刻红，提醒同步拆成两个判据而不是悄悄让两边分叉。
  it('与 canPrintPartDrawing 同集合（逐角色同进同出）', () => {
    const cases: PartRoleMapLike[] = [
      {},
      { MANAGER: true },
      { CLERK: true },
      { INSPECTOR: true },
      { CNC_PROGRAMMER: true },
      { MANAGER: true, CNC_PROGRAMMER: false },
      { INSPECTOR: false, CLERK: false },
    ];
    for (const c of cases) expect(canDownloadPartFile(c)).toBe(canPrintPartDrawing(c));
  });
});
