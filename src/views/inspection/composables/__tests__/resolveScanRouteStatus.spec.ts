// src/views/inspection/composables/__tests__/resolveScanRouteStatus.spec.ts
//
// 2026-10-03 新增：待品检页「扫码命中 0 行」分流的穷举回归守卫。
//
// 判据本身只有三条出口，但它是本次 VO 收口**唯一改了用户可见行为**的地方：
// 列表命中的快路径改成「恒 INSPECTION → 直接弹二选一」后，fallback 这条
// getPartBySerial 路径成了唯一还读 status / location 的地方，读错一个分支就会
// 出现「拿 part 级形态冒充批次行 → 打成 /prod/batches/undefined/...」的必失败请求。
// 抽成纯函数就是为了能把 3 条出口 × 全状态枚举穷举掉，不必挂载那个挂 5 个弹窗 +
// 扫码订阅 + timer 的视图。

import { describe, expect, it } from 'vitest';
import { resolveScanRouteStatus } from '../resolveScanRouteStatus';

describe('resolveScanRouteStatus', () => {
  // ---- inspection-out-of-range ----
  it('INSPECTION → inspection-out-of-range（不管 location 是什么）', () => {
    expect(resolveScanRouteStatus('INSPECTION', 'INSPECTION_SHELF')).toBe(
      'inspection-out-of-range',
    );
    // 该批次被筛选 / 分页挡在列表外，弹二选一必然打成 /prod/batches/undefined/...。
    expect(resolveScanRouteStatus('INSPECTION', null)).toBe('inspection-out-of-range');
    expect(resolveScanRouteStatus('INSPECTION', 'PRODUCTION_SHELF')).toBe(
      'inspection-out-of-range',
    );
  });

  // ---- scan-inspect ----
  it('PENDING / PROGRAMMING → scan-inspect（与 location 无关）', () => {
    expect(resolveScanRouteStatus('PENDING', null)).toBe('scan-inspect');
    expect(resolveScanRouteStatus('PENDING', 'PRODUCTION_SHELF')).toBe('scan-inspect');
    expect(resolveScanRouteStatus('PROGRAMMING', null)).toBe('scan-inspect');
    expect(resolveScanRouteStatus('PROGRAMMING', 'WORKER')).toBe('scan-inspect');
  });

  it('IN_PROCESS 只有在 PRODUCTION_SHELF 上才是 scan-inspect；WORKER 上落 locate', () => {
    expect(resolveScanRouteStatus('IN_PROCESS', 'PRODUCTION_SHELF')).toBe('scan-inspect');
    // 已被工人领走：零件不在货架上，快捷品检的起点不成立。
    expect(resolveScanRouteStatus('IN_PROCESS', 'WORKER')).toBe('locate');
    expect(resolveScanRouteStatus('IN_PROCESS', null)).toBe('locate');
  });

  // ---- locate（其余全部降级）----
  it('其余状态一律 locate（不做任何写操作）', () => {
    for (const status of [
      'READY_TO_SHIP',
      'DELIVERED',
      'REPAIRING',
      'OUTSOURCE',
      'COMPLETED',
      'CANCELLED',
    ]) {
      expect(resolveScanRouteStatus(status, 'PRODUCTION_SHELF')).toBe('locate');
      expect(resolveScanRouteStatus(status, null)).toBe('locate');
    }
  });

  it('未知 / 缺失状态不抛错，落 locate（后端加枚举时前端降级而不是崩）', () => {
    expect(resolveScanRouteStatus(null, null)).toBe('locate');
    expect(resolveScanRouteStatus(undefined, undefined)).toBe('locate');
    expect(resolveScanRouteStatus('', null)).toBe('locate');
    expect(resolveScanRouteStatus('SOME_FUTURE_STATUS', 'PRODUCTION_SHELF')).toBe('locate');
    // 大小写敏感：后端枚举是大写，小写形态按未知处理。
    expect(resolveScanRouteStatus('pending', null)).toBe('locate');
  });
});
