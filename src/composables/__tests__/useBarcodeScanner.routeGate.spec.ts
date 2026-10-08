// src/composables/__tests__/useBarcodeScanner.routeGate.spec.ts
//
// 2026-10-09 新增：覆盖「活跃路由闸门」—— 扫码分发只投递给「当前路由就是它」的订阅者。
// 缺陷现象：顶部标签栏同时开着「待品检」和「扫码入单」时，扫码一次两个对话框一起弹
// （keep-alive 缓存的页面 onBeforeUnmount 不触发，退订永不执行）。
//
// 用例矩阵（与实现里的 isGatedOut 一一对应）：
//   1. 当前路由 == 订阅路径        → 收到
//   2. 当前路由切走（模拟切标签）  → 不再收到
//   3. 两个订阅者：命中的收、未命中的不收（过滤是逐条判定，不是一刀切）
//   4. 退订后彻底移除
//   5. 被过滤时 lastScan / lastScanAt 仍更新（副作用先于过滤，见实现的 dispatch）
//
// fail-open 四条（闸门是增强项，取不到路由时必须**照旧分发**，绝不能让 handler 静默失效）：
//   6. 非组件上下文订阅（单测直接调 composable）        → 收到
//   7. 组件上下文但**没装 router**（仓内既有组件 spec 的挂载形态）→ 收到，且不打 Vue 警告
//   8. 组件上下文、provider 存在但值是 undefined          → 收到
//   9. 取不到 route 的订阅不擦掉此前已捕获的路由锚        → 已闸掉的订阅者仍被闸掉
//
// 另外两条钉住公开 API 的语义不变：
//  10. onMounted 里注册的订阅形态（真实调用点 DeliveryNoteScan / CandidatePool /
//       RepairReceive / ScanBadgeGate 都是这个形态，不是 setup 里直接 onScan）
//  11. setEnabled(false) 后不分发 / clearBuffer() 清缓冲后同码可再次分发
//
// 隔离策略：模块状态是**模块级单例**，所以静态 import（只装一次 window.keydown 监听），
// 靠 afterEach 逐条退订 + 卸载组件 + 复位 enabled / 缓冲来还原。刻意**不用**
// vi.resetModules() —— 那会让每次 import 都往 window 上再挂一个永不移除的 keydown 监听，
// 旧模块的缓冲与订阅表继续活着，反而更容易串味。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, onMounted, type Plugin } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useBarcodeScanner, type Unsubscribe } from '../useBarcodeScanner';

// vi.mock 的工厂被提升到 import 之上，里面的 mockRoute / key 必须用 vi.hoisted 造，
// 否则引用未初始化的 const（TDZ）。
const { mockRoute, routeLocationKeyMock } = vi.hoisted(() => ({
  mockRoute: { path: '/inspection/pending' as string },
  routeLocationKeyMock: Symbol('route location'),
}));

// 实现用的是 `inject(routeLocationKey, null)`（useRoute 是 inject(key) 不带默认值，
// router 缺失时会打 `injection "Symbol(route location)" not found.` dev warning）。
// 这里桩掉整个 vue-router 模块并给出同名 key：用例要么 provide 它、要么不 provide。
vi.mock('vue-router', () => ({
  routeLocationKey: routeLocationKeyMock,
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

/**
 * provide routeLocationKey 的最小插件（等价于 app.use(router) 提供的那个路由对象）。
 *
 * ⚠️ 形参**不能**用 ES 默认参数（`value: unknown = mockRoute`）：实参为 `undefined` 时
 * 默认值会生效 ⇒ 「provider 存在但值是 undefined」那条用例实际 provide 了一个有效 route，
 * 测的是 `if (route)` 的真分支、只是重复了用例 1，钉不住 fail-open 守卫。
 * 调用侧一律用 `'routeValue' in opts` 判存在（见 subscribe），undefined 才真的透传出去。
 */
function routerPlugin(value: unknown): Plugin {
  return {
    install(app) {
      app.provide(routeLocationKeyMock, value);
    },
  };
}

/** 在组件里订阅并把 handler / 退订收走；`inMounted` 决定订阅发生在 setup 还是 onMounted。 */
function subscribe(opts: { withRouter?: boolean; routeValue?: unknown; inMounted?: boolean } = {}): Sub {
  const spy = vi.fn();
  const collected: Sub[] = [];
  const wrapper = mount(
    defineComponent({
      setup() {
        // composable 一律在 setup 里调（真实调用点也是如此），只是**注册**的时机分两种
        const scanner = useBarcodeScanner();
        const register = (): void => {
          const unsubscribe = scanner.onScan(spy);
          collected.push({ spy, scanner, unsubscribe });
        };
        if (opts.inMounted) onMounted(register);
        else register();
        return () => h('div');
      },
    }),
    opts.withRouter === false
      ? {}
      : {
          global: {
            // 用 `in` 判存在而不是 `??` / 默认参数：'routeValue' 显式给 undefined 时
            // 必须真的把 undefined provide 出去（否则测到的是有效 route 那条分支）。
            plugins: [routerPlugin('routeValue' in opts ? opts.routeValue : mockRoute)],
          },
        },
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

/** 只按普通键、不按 Enter（留半个扫码在缓冲里）。 */
function typePartial(code: string): void {
  for (const key of code) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  }
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
  // 顺序要紧：先退订（清 handlers），再卸载组件，最后复位 enabled / 缓冲（都是模块级单例）。
  for (const s of subs) s.unsubscribe();
  for (const w of wrappers) w.unmount();
  subs = [];
  wrappers = [];
  useBarcodeScanner().setEnabled(true);
  useBarcodeScanner().clearBuffer();
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

describe('useBarcodeScanner 取不到路由时 fail-open（宁可不拦，也不让 handler 静默失效）', () => {
  it('非组件上下文订阅 → 照旧全量分发', () => {
    // 直接在测试体里调 composable：没有组件实例 ⇒ inject 拿不到 ⇒ 不设闸门。
    const spy = vi.fn();
    const scanner = useBarcodeScanner();
    const unsubscribe = scanner.onScan(spy);

    typeScan('EF-300');

    expect(spy).toHaveBeenCalledWith('EF-300');
    unsubscribe();
  });

  it('组件上下文但没装 router → 仍收到扫码，且不打 Vue 的 inject 缺失警告', () => {
    // 仓内既有组件 spec（CandidatePool / RepairReceive / DeliveryScanBar …）的挂载点
    // 正是这种形态。闸门是增强项：这条路径必须照旧收到扫码。
    const a = subscribe({ withRouter: false });
    typeScan('EF-301');

    expect(a.spy).toHaveBeenCalledWith('EF-301');
    // 实现用 `inject(routeLocationKey, null)`（带默认值）而不是 useRoute()
    // （= inject(key) 无默认值）—— 后者在没装 router 时每次 mount 都打这一句 dev warning。
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(warned.flat().join(' ')).not.toContain('route location');
  });

  it('组件上下文、provider 存在但值是 undefined → 仍收到扫码（取不到 route 就不过滤）', () => {
    const a = subscribe({ routeValue: undefined });
    typeScan('EF-302');

    expect(a.spy).toHaveBeenCalledWith('EF-302');
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(warned.flat().join(' ')).not.toContain('route location');
  });

  it('取不到 route 的订阅**不擦掉**此前已捕获的路由锚 → 已闸掉的订阅者仍被闸掉', () => {
    // 钉住实现里 `if (route) currentRoute = route;` 那个 fail-open 守卫：**取不到路由的订阅
    // 只能「不设自己的闸门」，不能把全局锚置空**。锚被置空 ⇒ isGatedOut 里 activePath 为
    // undefined ⇒ 全员放行，之前被闸掉（非活跃标签）的订阅者又会收到扫码 —— 闸门静默失效。
    //
    // 顺序即语义：先让一个带有效锚的订阅者被闸掉，再用「拿不到 route」的订阅制造压力。
    const gated = subscribe(); // 锚在 PENDING
    mockRoute.path = SCAN_IN;
    typeScan('EF-303');
    expect(gated.spy).not.toHaveBeenCalled();

    const noRoute = subscribe({ withRouter: false }); // route = null，不该改全局锚
    typeScan('EF-304');

    // 自己照旧收到（fail-open 那一半）
    expect(noRoute.spy).toHaveBeenCalledWith('EF-304');
    // 关键是这条：锚没被擦掉，被闸掉的那位仍然不收
    expect(gated.spy).not.toHaveBeenCalledWith('EF-304');
  });
});

describe('useBarcodeScanner 公开 API 语义不变', () => {
  it('onMounted 里注册的订阅形态同样受闸门约束（真实调用点都是这个形态）', () => {
    // DeliveryNoteScan / CandidatePool / RepairReceive / ScanBadgeGate 都在 onMounted 里
    // onScan（等看板数据到位再订阅），而 useBarcodeScanner 本身在 setup 里调 ——
    // Vue 的 injectHook 在调用钩子前会 setCurrentInstance，所以 onMounted 时刻
    // getCurrentInstance() 仍为真、inject 仍拿得到路由，闸门不会退化成 fail-open。
    const a = subscribe({ inMounted: true });
    typeScan('KL-001');
    expect(a.spy).toHaveBeenCalledWith('KL-001');

    mockRoute.path = SCAN_IN;
    typeScan('KL-002');
    expect(a.spy).not.toHaveBeenCalledWith('KL-002');
  });

  it('setEnabled(false) → 整条链路静默（连缓冲区都不吃按键），恢复后照常分发', () => {
    const a = subscribe();
    a.scanner.setEnabled(false);
    typeScan('MN-001');
    expect(a.spy).not.toHaveBeenCalled();

    a.scanner.setEnabled(true);
    typeScan('MN-002');
    expect(a.spy).toHaveBeenCalledTimes(1);
    expect(a.spy).toHaveBeenCalledWith('MN-002');
  });

  it('clearBuffer() 清掉半截缓冲 → 同码可再次完整分发（不与上一次残留拼接）', () => {
    const a = subscribe();
    // 打了一半就停（没有 Enter）：什么都不该分发
    typePartial('PQ-');
    expect(a.spy).not.toHaveBeenCalled();

    a.scanner.clearBuffer();
    // 同一个码重新完整扫一遍
    typeScan('PQ-001');
    expect(a.spy).toHaveBeenCalledTimes(1);
    // 拼接会得到 'PQ-PQ-001'，逐字对上即证明缓冲是真清空而不是追加
    expect(a.spy).toHaveBeenCalledWith('PQ-001');
  });
});
