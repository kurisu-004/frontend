// src/composables/__tests__/useBarcodeScanner.routeGate.spec.ts
//
// 2026-10-09 新增：覆盖「活跃路由闸门」—— 扫码分发只投递给「当前路由就是它」的
// 订阅者。缺陷现象：顶部标签栏同时开着「待品检」和「扫码入单」时，扫码一次两个
// 对话框一起弹（keep-alive 缓存的页面 onBeforeUnmount 不触发，退订永不执行）。
//
// 用例矩阵（与实现里的 isGatedOut 一一对应）：
//   1. 当前路由 == 订阅路径        → 收到
//   2. 当前路由切走（模拟切标签）  → 不再收到
//   3. 两个订阅者：命中的收、未命中的不收（过滤是逐条判定，不是一刀切）
//   4. 订阅时取不到路由（非组件上下文）→ 照旧全量分发（退化语义，宁可不拦）
//   5. 退订后彻底移除
//   6. 被过滤时 lastScan / lastScanAt 仍更新（副作用先于过滤，见实现的 dispatch）
//
// 隔离策略：模块状态是**模块级单例**，所以静态 import（只装一次 window.keydown 监听），
// 靠 afterEach 逐条退订 + 卸载组件来复位。刻意**不用** vi.resetModules() —— 那会让
// 每次 import 都往 window 上再挂一个永不移除的 keydown 监听，旧模块的缓冲与订阅表
// 继续活着，反而更容易串味。enabled / 缓冲状态本文件不改动（每次扫码以 Enter 收尾，
// 内部会 resetBuffer），无需额外复位。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useBarcodeScanner, type Unsubscribe } from '../useBarcodeScanner';

// vi.mock 的工厂被提升到 import 之上，里面的 mockRoute 必须用 vi.hoisted 造，
// 否则引用未初始化的 const（TDZ）。
const { mockRoute } = vi.hoisted(() => ({ mockRoute: { path: '/inspection/pending' } }));

// 整个 vue-router 换成一个可变 route 对象：改 mockRoute.path 即「切标签」。
// useBarcodeScanner 只用到 useRoute，本文件不引真 router，桩掉整个模块是安全的。
vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
}));

const PENDING = '/inspection/pending';
const SCAN_IN = '/com/delivery/scan';

interface Sub {
  spy: ReturnType<typeof vi.fn>;
  scanner: ReturnType<typeof useBarcodeScanner>;
  unsubscribe: Unsubscribe;
}

let wrappers: VueWrapper[] = [];
let subs: Sub[] = [];

/** 挂一个最小组件，在 setup() 里订阅（等价于业务页面 onMounted 里 onScan 的效果：
 *  订阅发生在「有组件上下文」的时刻，useRoute() 拿得到 route）。 */
function subscribe(): Sub {
  const spy = vi.fn();
  const collected: Sub[] = [];
  const wrapper = mount(
    defineComponent({
      setup() {
        const scanner = useBarcodeScanner();
        const unsubscribe = scanner.onScan(spy);
        collected.push({ spy, scanner, unsubscribe });
        return () => h('div');
      },
    }),
  );
  const sub = collected[0]!;
  wrappers.push(wrapper);
  subs.push(sub);
  return sub;
}

/** 模拟一次扫码枪：连续按键（间隔 0ms < 30ms 窗口）后按 Enter 收尾。 */
function typeScan(code: string): void {
  for (const key of code) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}

beforeEach(() => {
  mockRoute.path = PENDING;
  // dispatch 里的 console.log 是生产诊断输出，单测里静音
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // 非组件上下文调用 composable 时 Vue 会 warn「onBeforeUnmount 无实例」，
  // 那是 composable 既有的 HMR 友好写法，不属于本用例关心面
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // 顺序要紧：先退订（清 handlers），再卸载组件。
  for (const s of subs) s.unsubscribe();
  for (const w of wrappers) w.unmount();
  subs = [];
  wrappers = [];
  vi.restoreAllMocks();
});

describe('useBarcodeScanner 活跃路由闸门', () => {
  it('当前路由 == 订阅时的路径 → handler 收到扫码', () => {
    const a = subscribe();
    typeScan('AB-001');

    expect(a.spy).toHaveBeenCalledTimes(1);
    expect(a.spy).toHaveBeenCalledWith('AB-001');
  });

  it('切到别的路由（keep-alive 页面被缓存、onBeforeUnmount 未跑）→ 该 handler 不再收到', () => {
    const a = subscribe();
    typeScan('AB-001');
    expect(a.spy).toHaveBeenCalledTimes(1);

    // 模拟切标签：组件仍活着（未退订），但 route.path 已变
    mockRoute.path = SCAN_IN;
    typeScan('AB-002');

    expect(a.spy).toHaveBeenCalledTimes(1);
    expect(a.spy).not.toHaveBeenCalledWith('AB-002');
  });

  it('两个订阅者：只有路径匹配当前路由的那个收到（过滤逐条判定）', () => {
    // 复刻缺陷现场：待品检先订阅并激活，扫码入单后订阅，随后切到扫码入单
    const inspection = subscribe();
    mockRoute.path = SCAN_IN;
    const delivery = subscribe();

    typeScan('CD-100');
    expect(inspection.spy).not.toHaveBeenCalled();
    expect(delivery.spy).toHaveBeenCalledWith('CD-100');

    // 切回待品检：角色互换，另一个继续收
    mockRoute.path = PENDING;
    typeScan('CD-200');
    expect(delivery.spy).toHaveBeenCalledTimes(1);
    expect(inspection.spy).toHaveBeenCalledWith('CD-200');
  });

  it('订阅时取不到路由（非组件上下文）→ 照旧全量分发', () => {
    // 直接在测试体里调 composable：没有组件实例 ⇒ route 取不到 ⇒ 不设闸门。
    // 退化方向只有一个：宁可不拦，也不能让所有 handler 静默失效。
    const spy = vi.fn();
    const scanner = useBarcodeScanner();
    const unsubscribe = scanner.onScan(spy);

    typeScan('EF-300');

    expect(spy).toHaveBeenCalledWith('EF-300');
    unsubscribe();
  });

  it('退订后 handler 被彻底移除', () => {
    const a = subscribe();
    typeScan('GH-001');
    expect(a.spy).toHaveBeenCalledTimes(1);

    a.unsubscribe();
    typeScan('GH-002');

    expect(a.spy).toHaveBeenCalledTimes(1);
    expect(a.spy).not.toHaveBeenCalledWith('GH-002');
  });

  it('被闸门过滤掉的那次扫码，lastScan / lastScanAt 仍被更新', () => {
    const a = subscribe();
    mockRoute.path = SCAN_IN;
    typeScan('IJ-001');

    // 可观测契约：过滤只决定「谁收到回调」，不改动全局扫码流水记录 ——
    // 实现里 lastScan / lastScanAt 写在分发入口的过滤之前（见实现的 dispatch 注释），
    // 本用例钉住「被全部过滤掉也照样记账」这一侧。
    expect(a.spy).not.toHaveBeenCalled();
    expect(a.scanner.lastScan.value).toBe('IJ-001');
    expect(a.scanner.lastScanAt.value).toBeGreaterThan(0);
  });
});
