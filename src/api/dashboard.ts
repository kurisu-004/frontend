// 大屏 WebSocket：单例连接 + 按频道订阅。
//
// 用法：
//   const off = onDashboardSnapshot(snap => ...)
//   onDashboardEvent(ev => ...)
//   onDashboardStatus(s => ...)
//   // 组件卸载时调 off()；off 只取消对应频道订阅，不关闭长连接。
//
// 2026-09-15 Phase 5：WS URL 改为 `${proto}://${location.host}/ws/dashboard`（不带
// `/api/v1` 前缀），与 backend-rust `ws_hub` 模块的 `WsEvent::DashboardEvent`
// 路由对齐。token 通过 query string 携带（`?token=...`）—— v2 后端 ws_hub 在
// upgrade 阶段从 query 取 token 校验 Redis session。
//
// 【2026-09-25 协议对齐注释】subscribe / unsubscribe 文本帧：服务端当前不消费
// 这两个文本帧（v2 后端 ws_hub 仅按连接初始订阅集合默认推 snapshot / events），
// subscribe 仅作为 client-side 控制帧 —— 连接成功后发送是为了在客户端维护
// 「我已声明订阅」的视图（供日志 / 调试 / 重连后 syncSubscriptions 复用）。
// sendSubscriptionCommand 调用必须保留，避免大改；行为正确即可。

import type {
  ConnectionStatus,
  DashboardEvent,
  DashboardServerMessage,
  DashboardSnapshot,
} from '@/types/dashboard';

type SnapshotHandler = (snap: DashboardSnapshot) => void;
type EventHandler = (ev: DashboardEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;

type SubscriptionChannel = 'dashboard' | 'events';
type SubscriptionAction = 'subscribe' | 'unsubscribe';

// —— 模块级单例状态 ——
let ws: WebSocket | null = null;
let closed = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;

const snapSubs = new Set<SnapshotHandler>();
const eventSubs = new Set<EventHandler>();
const statusSubs = new Set<StatusHandler>();

function url(): string {
  // 2026-09-15 Phase 5：去掉 /api/v1 前缀；ws_hub（rust）走 /ws/dashboard。
  // 同源策略：浏览器只接触 frontend nginx（dev 5173 / prod 8080 / stage 443），
  // nginx 模板已把 /ws/* 反代到 rust-backend:3000。
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${proto}://${location.host}/ws/dashboard`;
  const raw = localStorage.getItem('auth_session');
  if (raw) {
    try {
      const s = JSON.parse(raw);
      if (s.token) return `${base}?token=${encodeURIComponent(s.token)}`;
    } catch {
      /* ignore */
    }
  }
  return base;
}

function notifyStatus(s: ConnectionStatus): void {
  for (const h of statusSubs) {
    try {
      h(s);
    } catch (e) {
      console.error('dashboard status handler error', e);
    }
  }
}

function dispatch(msg: DashboardServerMessage): void {
  if (msg.type === 'snapshot') {
    for (const h of snapSubs) {
      try {
        h(msg);
      } catch (e) {
        console.error('dashboard snapshot handler error', e);
      }
    }
  } else if (msg.type === 'event') {
    for (const h of eventSubs) {
      try {
        h(msg);
      } catch (e) {
        console.error('dashboard event handler error', e);
      }
    }
  }
}

function sendSubscriptionCommand(
  action: SubscriptionAction,
  channel: SubscriptionChannel,
  socket: WebSocket | null = ws,
): void {
  if (!socket || socket !== ws || socket.readyState !== WebSocket.OPEN) return;
  try {
    // 2026-09-25 注释：后端当前不消费此文本帧，仅维护 client-side 订阅视图。
    // 连接成功后发送 subscribe 是为了日志一致 / 调试用。重连 / 新订阅时
    // syncSubscriptions 调用是必要的（维护本地 channelHandlers → 订阅意图的映射）。
    socket.send(JSON.stringify({ type: action, channel }));
  } catch (e) {
    console.error('dashboard WS subscription command error', e);
  }
}

function syncSubscriptions(socket: WebSocket): void {
  if (snapSubs.size > 0) {
    sendSubscriptionCommand('subscribe', 'dashboard', socket);
  }
  if (eventSubs.size > 0) {
    sendSubscriptionCommand('subscribe', 'events', socket);
  }
}

function teardown(socket: WebSocket): void {
  // 拆掉旧 socket 的所有回调后再 close，确保它的 onclose 不会回过头来
  // 清掉刚建立的新 socket / 触发多余重连（多连接堆叠 → 大屏收到重复推送）。
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  try {
    socket.close();
  } catch {
    /* ignore */
  }
}

function connect(): void {
  if (closed) return;
  // 旧 socket 还在握手（CONNECTING）期间不允许 teardown——close() 会让浏览器报
  // "WebSocket is closed before the connection is established"。所有调用方共用同一
  // 单例 URL，等这次握手完成即可，无需 close。
  if (ws && ws.readyState === WebSocket.CONNECTING) return;
  // 保证同一时刻只有一条活连接：建新连接前先拆掉旧的。
  if (ws) {
    teardown(ws);
    ws = null;
  }
  notifyStatus('connecting');
  const socket = new WebSocket(url());
  ws = socket;
  socket.onopen = () => {
    if (socket !== ws) return;
    retryDelay = 1000;
    notifyStatus('open');
    // 后端每条新连接默认没有订阅；按当前 handlers 恢复频道。
    syncSubscriptions(socket);
  };
  socket.onmessage = (ev) => {
    if (socket !== ws) return;
    try {
      const msg = JSON.parse(ev.data) as DashboardServerMessage;
      dispatch(msg);
    } catch (e) {
      console.error('dashboard WS parse error', e);
    }
  };
  socket.onerror = () => {
    // onclose 紧随其后
  };
  socket.onclose = () => {
    // 陈旧 socket（已被新连接取代）的 onclose 直接忽略，避免误清新 ws / 误重连。
    if (socket !== ws) return;
    notifyStatus('closed');
    ws = null;
    if (closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  };
}

function ensureConnected(): void {
  if (ws || closed) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  connect();
}

// ============================================================
// 公共 API：订阅 / 反订阅
// ============================================================

/** 订阅 Dashboard snapshot；最后一个 handler 移除时只取消频道订阅，不断开 socket。 */
export function onDashboardSnapshot(h: SnapshotHandler): () => void {
  const wasEmpty = snapSubs.size === 0;
  snapSubs.add(h);
  ensureConnected();
  if (wasEmpty) sendSubscriptionCommand('subscribe', 'dashboard');
  return () => {
    if (!snapSubs.delete(h) || snapSubs.size > 0) return;
    sendSubscriptionCommand('unsubscribe', 'dashboard');
  };
}

/** 订阅业务事件（PICKED_UP / RELEASED），由横幅通知组件消费。 */
export function onDashboardEvent(h: EventHandler): () => void {
  const wasEmpty = eventSubs.size === 0;
  eventSubs.add(h);
  ensureConnected();
  if (wasEmpty) sendSubscriptionCommand('subscribe', 'events');
  return () => {
    if (!eventSubs.delete(h) || eventSubs.size > 0) return;
    sendSubscriptionCommand('unsubscribe', 'events');
  };
}

/** 订阅连接状态。状态订阅本身只确保长连接存在，不会订阅业务频道。 */
export function onDashboardStatus(h: StatusHandler): () => void {
  statusSubs.add(h);
  ensureConnected();
  return () => statusSubs.delete(h);
}

/** 显式关闭长连接（一般不调用，保留供登出/测试使用）。 */
export function closeDashboard(): void {
  closed = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (ws) teardown(ws);
  ws = null;
  snapSubs.clear();
  eventSubs.clear();
  statusSubs.clear();
}

/**
 * 强制发起一次重连，主要用于 JWT 刷新。
 *
 * 旧连接会被替换，但当前 snapshot/events 订阅意图会在新连接 onopen 时恢复。
 */
export function reconnectDashboard(): void {
  closed = false;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelay = 1000;
  connect();
}

// —— JWT 自动刷新后顺势重连，避免陈旧 token 卡住 socket ——
// 用 module-level flag 保证只注册一次监听（HMR 下模块可能被重复求值）。
let refreshListenerBound = false;
if (typeof window !== 'undefined' && !refreshListenerBound) {
  refreshListenerBound = true;
  window.addEventListener('auth:tokens-refreshed', () => {
    // url() 内每次现读 localStorage，新 token 已就位；强制 socket 切到新握手。
    reconnectDashboard();
  });
}
