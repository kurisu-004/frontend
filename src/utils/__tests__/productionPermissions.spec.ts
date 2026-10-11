// src/utils/__tests__/productionPermissions.spec.ts
//
// 2026-10-15 新增：生产域权限点常量逐字锁定（防拼写漂移）。
//
// 为什么逐个断言字面量而不是 import 常量互相比较：常量与后端 seeds 的一致性只能靠
// 「把期望值写死在测试里」守住 —— 用常量比常量等于恒真。拼错 code 的症状是「RBAC 面板
// 里配了权限但入口不出现」，前端零报错、后端 403 也不会出现（压根没发请求），极难定位。
//
// 导出面全集也钉死：改名 / 误删会让消费侧编译失败（那是好事），但常量表本身仍值得一条
// 显式防漂移断言。注：读点（`production.view` 等）与 `batch.deliver` 目前无前端消费方，
// 也一并收录 —— 本文件的 12 个常量是**生产域**的完整清单，不按「有无消费方」裁剪；
// 其它域的码（零件 / 送货单 / 外协）在同目录各自的常量文件里，勿在此处补。

import { describe, expect, it } from 'vitest';
import * as permissionConstants from '../productionPermissions';

describe('productionPermissions 常量表', () => {
  it('12 个权限点 code 与后端 seeds 逐字一致', () => {
    expect(permissionConstants.PRODUCTION_VIEW_PERMISSION).toBe('production.view');
    expect(permissionConstants.PRODUCTION_CONFIG_PERMISSION).toBe('production.config');
    expect(permissionConstants.QUEUE_VIEW_PERMISSION).toBe('queue.view');
    expect(permissionConstants.QUEUE_DISPATCH_PERMISSION).toBe('queue.dispatch');
    expect(permissionConstants.QUEUE_RECALL_PERMISSION).toBe('queue.recall');
    expect(permissionConstants.QUEUE_ALLOCATE_PERMISSION).toBe('queue.allocate');
    expect(permissionConstants.BATCH_SPLIT_PERMISSION).toBe('batch.split');
    expect(permissionConstants.BATCH_TRANSITION_PERMISSION).toBe('batch.transition');
    expect(permissionConstants.BATCH_DELIVER_PERMISSION).toBe('batch.deliver');
    expect(permissionConstants.BATCH_CANCEL_PERMISSION).toBe('batch.cancel');
    expect(permissionConstants.BATCH_REPAIR_PERMISSION).toBe('batch.repair');
    expect(permissionConstants.INSPECTION_VIEW_PERMISSION).toBe('inspection.view');
  });

  it('导出面恰为 12 个常量（防止改名 / 误删）', () => {
    expect(Object.keys(permissionConstants).sort()).toEqual(
      [
        'PRODUCTION_VIEW_PERMISSION',
        'PRODUCTION_CONFIG_PERMISSION',
        'QUEUE_VIEW_PERMISSION',
        'QUEUE_DISPATCH_PERMISSION',
        'QUEUE_RECALL_PERMISSION',
        'QUEUE_ALLOCATE_PERMISSION',
        'BATCH_SPLIT_PERMISSION',
        'BATCH_TRANSITION_PERMISSION',
        'BATCH_DELIVER_PERMISSION',
        'BATCH_CANCEL_PERMISSION',
        'BATCH_REPAIR_PERMISSION',
        'INSPECTION_VIEW_PERMISSION',
      ].sort(),
    );
  });
});
