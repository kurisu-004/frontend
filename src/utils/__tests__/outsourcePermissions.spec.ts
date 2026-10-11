// src/utils/__tests__/outsourcePermissions.spec.ts
//
// 2026-10-15 新增：外协域权限点常量逐字锁定（防拼写漂移），理由同
// productionPermissions.spec.ts 文件头。

import { describe, expect, it } from 'vitest';
import * as permissionConstants from '../outsourcePermissions';

describe('outsourcePermissions 常量表', () => {
  it('5 个权限点 code 与后端 seeds 逐字一致', () => {
    expect(permissionConstants.OUTSOURCE_VIEW_PERMISSION).toBe('outsource.view');
    expect(permissionConstants.OUTSOURCE_QUOTE_EDIT_PERMISSION).toBe('outsource.quote.edit');
    expect(permissionConstants.OUTSOURCE_QUOTE_APPROVE_PERMISSION).toBe('outsource.quote.approve');
    expect(permissionConstants.OUTSOURCE_MOVE_PERMISSION).toBe('outsource.move');
    expect(permissionConstants.OUTSOURCE_COMPANY_MANAGE_PERMISSION).toBe(
      'outsource.company.manage',
    );
  });

  it('导出面恰为 5 个常量（防止改名 / 误删）', () => {
    expect(Object.keys(permissionConstants).sort()).toEqual(
      [
        'OUTSOURCE_VIEW_PERMISSION',
        'OUTSOURCE_QUOTE_EDIT_PERMISSION',
        'OUTSOURCE_QUOTE_APPROVE_PERMISSION',
        'OUTSOURCE_MOVE_PERMISSION',
        'OUTSOURCE_COMPANY_MANAGE_PERMISSION',
      ].sort(),
    );
  });
});
