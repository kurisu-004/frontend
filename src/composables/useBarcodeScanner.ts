// composables/useBarcodeScanner.ts
//
// 全局扫码枪监听：以单例方式挂到 window.keydown；只接收"快速连击"按键序列，
// 以 Enter 结尾。识别到完整扫码后通过订阅者回调分发。
//
// 用法（在 App.vue 或具体业务页面）：
//   const { onScan, setEnabled, clearBuffer, lastScan, lastScanAt } = useBarcodeScanner()
//   onScan((code) => { ... })
//
// 设计要点：
// - 模块级单例：listener 只挂一次，避免 HMR/多次调用造成重复监听。
// - Enter 必须先判断：event.key === 'Enter' 长度是 5，被早 return 过滤掉就废了。
// - 输入框/可编辑区域不拦截：让用户在搜索、表单里正常打字，不会被误当成扫码。
// - 扫码前缀后必须 preventDefault：避免 Enter 同时触发 form submit。
// - 订阅者抛错要 try/catch：单个页面报错不应让全局监听崩。
//
// 2026-10-09 新增「活跃路由闸门」：分发只投递给当前路由下的订阅者。
// - 症状：顶部标签栏同时开着「待品检」和「扫码入单」时，扫一次码两个对话框一起弹。
// - 原因：MainLayout 用 <keep-alive :include="tags.cachedViewNames"> 缓存路由组件，
//   切标签只走 onDeactivated、组件不卸载 ⇒ 页面在 onBeforeUnmount 里注册的退订
//   永不触发，被缓存的非激活页面仍留在订阅表里，而分发是无条件的。
// - 做法：订阅时记下当时的 route.path（Map 的 value），分发时只投给 path 相同的
//   订阅者。用 path 而非 fullPath —— query 变化不该让页面失去扫码能力。路径在
//   订阅那一刻读一次并锁进 Map，分发时现读会让两个页面都读到当前路径、闸门失效。
// - null 的含义：订阅时不在组件上下文（useRoute() 走 inject，拿不到）⇒ 不设闸门，
//   照旧全量分发。宁可不拦，也不能让所有 handler 静默失效。
// - 已知边界：同一 path 同时存在两个订阅者时两个都会收到。路由层保证同一 path
//   只有一个组件实例，故实践中不发生。
// - 不改成逐页 onActivated / onDeactivated：那要改全部 8 个订阅页并维护两套生命周期
//   记账；闸门在 composable 内部一处即可，调用点零改动、公开 API 形状不变。

import { getCurrentInstance, onBeforeUnmount, ref, type Ref } from 'vue';
import { useRoute } from 'vue-router';

export type ScanHandler = (code: string) => void;
export type Unsubscribe = () => void;

/** 两次按键的最大间隔；超过这个值认为是"人工打字"而非扫码枪（ms） */
const SCAN_INTERVAL_MS = 30;
/** 缓冲区最大长度；超过则丢弃，防止异常状态下无限累积 */
const SCAN_MAX_LENGTH = 50;
/** 缓冲区空闲超时（ms）；超过则清空（兜底，正常扫码枪会带 Enter 结束） */
const BUFFER_IDLE_MS = 500;

// ============ 单例状态（模块级） ============
// 2026-10-09：Set 改 Map。key 是 handler，value 是订阅那一刻的 route.path；
// null = 订阅时取不到路由 ⇒ 不设闸门。
const handlers = new Map<ScanHandler, string | null>();
/** 2026-10-09：最近一次在组件上下文里 useRoute() 拿到的 route。vue-router 注入的
 *  是应用级同一个响应式对象，任意组件拿到的都是它 ⇒ dispatch 时读它的 .path 就是
 *  「当前路由」。保持 null 表示至今没有任何组件上下文订阅过（此时不过滤）。 */
let currentRoute: { readonly path: string } | null = null;
const enabled = ref(true);
const lastScan = ref<string>('');
const lastScanAt = ref<number>(0);
let codeBuffer = '';
let lastTime = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let listenerInstalled = false;

function isInTextField(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function resetBuffer(): void {
  codeBuffer = '';
  lastTime = 0;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleClear(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    resetBuffer();
  }, BUFFER_IDLE_MS);
}

/** 2026-10-09 活跃路由闸门：该订阅者此刻是否已不是当前路由。
 *  订阅时取不到路由（value 为 null）或分发时取不到当前路由，一律不过滤。 */
function isGatedOut(subscribePath: string | null): boolean {
  if (subscribePath === null) return false;
  const activePath = currentRoute?.path;
  if (activePath === undefined) return false;
  return subscribePath !== activePath;
}

function dispatch(code: string): void {
  if (!code) return;
  // 2026-10-09：lastScan / lastScanAt 与 console.log 记的是「识别到一次完整扫码」，
  // 刻意放在路由过滤之前 —— 过滤只决定「谁收到回调」，不改动全局扫码流水记录。
  lastScan.value = code;
  lastScanAt.value = Date.now();

  console.log(`[barcode] ${code}`);
  for (const [h, subscribePath] of handlers) {
    if (isGatedOut(subscribePath)) continue;
    try {
      h(code);
    } catch (e) {
      console.error('[barcode] handler threw', e);
    }
  }
}

function handleKeyDown(event: KeyboardEvent): void {
  if (!enabled.value) return;

  // 1) Enter 必须先判断 —— key 长度 5，会被后面的 length>1 过滤掉
  if (event.key === 'Enter') {
    if (codeBuffer.length > 0) {
      const code = codeBuffer;
      resetBuffer();
      // 阻止默认行为：避免 Enter 同时提交表单/插入换行
      event.preventDefault();
      dispatch(code);
    }
    return;
  }

  // 2) 用户正在输入框/可编辑区域打字，不拦截
  if (isInTextField(event.target)) return;

  // 3) 其他特殊键（Shift/Ctrl/方向键等）忽略
  if (event.key.length > 1) return;

  // 4) 时间窗判定
  const now = Date.now();
  if (lastTime === 0 || now - lastTime < SCAN_INTERVAL_MS) {
    codeBuffer += event.key;
  } else {
    // 间隔太长，认为是新一轮输入（或误触）
    codeBuffer = event.key;
  }
  lastTime = now;
  scheduleIdleClear();

  // 5) 超长保护
  if (codeBuffer.length > SCAN_MAX_LENGTH) {
    codeBuffer = '';
  }
}

function installListener(): void {
  if (listenerInstalled) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', handleKeyDown);
  listenerInstalled = true;
}

// ============ 公开 API ============
/** 2026-09-21 显式返回类型。 */
export interface UseBarcodeScannerReturn {
  onScan: (handler: ScanHandler) => Unsubscribe;
  setEnabled: (value: boolean) => void;
  clearBuffer: () => void;
  enabled: Ref<boolean>;
  lastScan: Ref<string>;
  lastScanAt: Ref<number>;
}

export function useBarcodeScanner(): UseBarcodeScannerReturn {
  installListener();

  // 2026-10-09：活跃路由闸门的锚。useRoute() 走 inject，只在组件上下文可用；
  // 非组件上下文（单测直接调本 composable）⇒ null，退化成改动前的全量分发。
  const route = getCurrentInstance() ? useRoute() : null;
  if (route) currentRoute = route;

  function onScan(handler: ScanHandler): Unsubscribe {
    // 路径在订阅那一刻读一次并锁进 Map
    handlers.set(handler, route?.path ?? null);
    return () => {
      handlers.delete(handler);
    };
  }

  function setEnabled(value: boolean): void {
    enabled.value = value;
  }

  function clearBuffer(): void {
    resetBuffer();
  }

  // HMR 友好：在每次调用时挂个 onBeforeUnmount，没实际副作用，
  // 主要为了让 useBarcodeScanner 仍按"composable 规则"出现在 setup() 里。
  onBeforeUnmount(() => {
    /* listener 跟随模块单例，不随组件卸载 */
  });

  return {
    onScan,
    setEnabled,
    clearBuffer,
    enabled,
    lastScan,
    lastScanAt,
  };
}
