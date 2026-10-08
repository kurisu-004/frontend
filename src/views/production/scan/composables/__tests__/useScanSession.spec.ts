// @vitest-environment happy-dom
// src/views/production/scan/composables/__tests__/useScanSession.spec.ts
//
// 报工台跨路由 session（`useScanSession`）的回归保护，重点是 2026-10-10 的类型切换：
// `worker` 从账号管理页那个 12 字段的 `WorkerOut` 镜像（`@/types/worker::Worker`）
// 换成后端 `prod::scan` 域的 **`ScanWorkerBrief`（4 字段）**。
//
// 为什么要单独守：这两个 VO 在运行时都是「扫工牌拿回来的那个对象」，切换是**纯类型层**
// 改动 —— `ScanWorkerBrief` 的 4 个字段（id / badge_code / name / work_type_id）全部是
// `Worker` 的子集，赋值在 TS 与运行时都合法，所以「换成 4 字段版之后三页还读得到
// `worker.name` / `worker.badge_code` / `worker.id` / `worker.work_type_id`」这条不会在
// 编译期报错也不会在运行时炸，只会在有人日后误读某个被砍掉的字段时才炸。故把「三页 +
// 徽章用到的字段集合」钉成显式断言。
//
// 同时守 session 的三条既有职责：跨路由共享（模块级单例）、`reset()` 清空、
// `requireWorker` / `requireWorkerAndAction` 两条守卫的跳转目标。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.hoisted(() => vi.fn());
vi.mock('vue-router', () => ({ useRouter: () => ({ replace }) }));

import type { Router } from 'vue-router';

import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import type { ScanWorkerBriefDto } from '@/api/productionScan.contract';

/** 后端 `ScanWorkerBrief` 的完整 4 字段形态。 */
const BRIEF: ScanWorkerBriefDto = {
  id: '190000000000900',
  badge_code: 'W-001',
  name: '张三',
  work_type_id: '190000000000901',
};

/** 报工台三页 + 徽章从 `worker` 上真正读到的字段集合。 */
const FIELDS_READ_BY_SCAN_UI = ['id', 'badge_code', 'name', 'work_type_id'] as const;

describe('useScanSession', () => {
  beforeEach(() => {
    replace.mockReset();
    // 模块级单例：每个用例从空 session 起步，否则会串到上一个用例
    useScanSession().reset();
  });

  it('S1：setWorker 存的是后端 ScanWorkerBrief 的 4 字段版（不是 WorkerOut 的宽版）', () => {
    const s = useScanSession();
    s.setWorker(BRIEF);
    expect(s.worker.value).toEqual(BRIEF);
    // 键集恰为后端 `ScanWorkerBrief` 的 4 个：多一个就说明误用了别的 VO
    expect(Object.keys(s.worker.value!).sort()).toEqual([...FIELDS_READ_BY_SCAN_UI].sort());
  });

  it('S2：三页 + 徽章用到的 4 个字段在 session 上全部可读（worker 无工种时 work_type_id 为 null）', () => {
    const s = useScanSession();
    s.setWorker({ ...BRIEF, work_type_id: null });
    const w = s.worker.value!;
    // 顶栏：worker?.name / worker?.badge_code；徽章 v-if 与取件入参：worker?.id
    expect(w.name).toBe('张三');
    expect(w.badge_code).toBe('W-001');
    expect(w.id).toBe('190000000000900');
    // 取件页的 params 闸门判它：null ⇒ 不发 pickable 请求、显示「未分配工种」
    expect(w.work_type_id).toBeNull();
  });

  it('S3：跨路由共享同一个模块级单例（两个 useScanSession() 实例读到同一个 worker）', () => {
    const a = useScanSession();
    const b = useScanSession();
    a.setWorker(BRIEF);
    expect(b.worker.value).toEqual(BRIEF);
    // action 同理：ScanActionPicker 选的动作要给 ScanPickParts / ScanReturnParts 读
    b.setAction('RETURN');
    expect(a.action.value).toBe('RETURN');
  });

  it('S4：requireWorker —— 有 worker 放行；缺 worker 跳 /scan/badge', () => {
    const s = useScanSession();
    // 守卫只用到 router.replace；给一个最小可用的 Router 桩（未实现的方法用不到）。
    const router = { replace } as unknown as Router;
    expect(s.requireWorker(router)).toBe(false);
    expect(replace).toHaveBeenCalledWith('/scan/badge');

    replace.mockReset();
    s.setWorker(BRIEF);
    expect(s.requireWorker(router)).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it('S5：requireWorkerAndAction —— 缺 worker 跳 /scan/badge，缺 action 跳 /scan/action', () => {
    const s = useScanSession();
    // 守卫只用到 router.replace；给一个最小可用的 Router 桩（未实现的方法用不到）。
    const router = { replace } as unknown as Router;
    expect(s.requireWorkerAndAction(router)).toBe(false);
    expect(replace).toHaveBeenCalledWith('/scan/badge');

    replace.mockReset();
    s.setWorker(BRIEF);
    expect(s.requireWorkerAndAction(router)).toBe(false);
    expect(replace).toHaveBeenCalledWith('/scan/action');

    replace.mockReset();
    s.setAction('PICK_UP');
    expect(s.requireWorkerAndAction(router)).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it('S6：reset 清空 worker 与 action（重扫工牌 / 退至首页的入口）', () => {
    const s = useScanSession();
    s.setWorker(BRIEF);
    s.setAction('INSPECT');
    s.reset();
    expect(s.worker.value).toBeNull();
    expect(s.action.value).toBeNull();
  });

  it('S7：slug ↔ action 互转；未知 slug 返 null 让调用方自己 redirect', () => {
    const s = useScanSession();
    expect(s.slugToAction('pickup')).toBe('PICK_UP');
    expect(s.slugToAction('return')).toBe('RETURN');
    expect(s.slugToAction('inspect')).toBe('INSPECT');
    expect(s.slugToAction('deliver')).toBeNull();
    expect(s.slugToAction(undefined)).toBeNull();
    expect(s.actionToSlug('PICK_UP')).toBe('pickup');
    expect(s.actionToSlug('RETURN')).toBe('return');
    expect(s.actionToSlug('INSPECT')).toBe('inspect');
  });
});
