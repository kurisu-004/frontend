// dashboard 域 WebSocket 层（2026-09-28 重写）。
//
// 数据流（与 frontend/CLAUDE.md 2026-09-28 新增的「dashboard 域 HTTP 全量 +
// WS 事件 invalidate」架构对齐）：
//   1. 消费者通过 useDashboardSnapshot()（views/dashboard/composables/）订阅大屏快照。
//      该 composable 内部用 TanStack Query 拉一次 GET /api/v2/dashboard/snapshot
//      取全量（fetchDashboardSnapshot），之后不依赖本模块推送 snapshot。
//   2. 本模块仍是 WebSocket 单例层：持有唯一长连接 + 按频道分发事件给订阅者。
//      WS 首帧 snapshot 仍会到达（后端行为不变），但前端消费方已切到 HTTP 全量，
//      故首帧 snapshot 仅作「连接就绪信号」（通过 onConnected 标记 isReady）。
//   3. 业务事件（PICKED_UP / RELEASED / PART_TO_SHIP 等）继续通过 onDashboardEvent
//      派发给 NotificationBanner.vue / useDashboardSnapshot.invalidate 等消费者。
//
// 实现要点：
//   - 用 VueUse useWebSocket + createGlobalState 包单例（替代原 258 行手写 socket 管理）；
//   - URL computed 依赖模块级 tokenVersion ref，'auth:tokens-refreshed' CustomEvent
//     触发 tokenVersion++ → VueUse watch(urlRef, open) 自动重连；
//   - autoReconnect 指数退避 1s→10s 封顶，无限重试（对齐原 1s/2s/4s/8s/10s 行为）；
//   - 不再发送 subscribe/unsubscribe 控制帧 —— 后端 v2 ws_hub 不消费这俩文本帧
//     （2026-09-25 注释 + 2026-09-28 决策删除），后端默认行为是按连接初始订阅集合
//     推 snapshot + events，删控制帧后逻辑等价；
//   - heartbeat 选项不启用 —— VueUse heartbeat 是「客户端主动 ping」，与本场景
//     「服务端 30s 推 {type:'heartbeat'} text 帧」无关，收到也只在 onMessage
//     分发层丢包。
//
// 子任务锚点：本次改造后 dashboard 域 snapshot 数据流是 HTTP 全量首取 + WS 事件
// invalidate 重取，WS 层不复用 server-pushed snapshot 的业务数据。

import { createGlobalState, useWebSocket } from '@vueuse/core';
import { computed, ref, watch, type Ref } from 'vue';
import { api } from '@/api/http';
import type {
  ConnectionStatus,
  DashboardEvent,
  DashboardEventType,
  DashboardServerMessage,
} from '@/types/dashboard';
import type { DashboardSnapshotData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

type EventHandler = (ev: DashboardEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;

/** 指数退避 1s/2s/4s/8s/10s 封顶，无限重试（对齐原手写 retryDelay 行为）。 */
function reconnectDelay(retries: number): number {
  return Math.min(1000 * 2 ** (retries - 1), 10000);
}

// ============================================================
// URL 构造（响应式）：tokenVersion 变化触发 VueUse 自动重连
// ============================================================

/** 模块级 ref：bump 一次触发 URL 重算 → VueUse watch(urlRef, open) 自动重连。
 *  listenAuthTokensRefreshed() 首次调用时挂 'auth:tokens-refreshed' CustomEvent
 *  listener，拦截器刷新成功后 dispatch → tokenVersion++ → 重连。 */
const tokenVersion: Ref<number> = ref(0);

function buildWsUrl(token: string | null): string {
  // 2026-09-15 Phase 5：去掉 /api/v1 前缀；ws_hub（rust）走 /ws/dashboard。
  // 同源策略：浏览器只接触 frontend nginx（dev 5173 / prod 8080 / stage 443），
  // nginx 模板已把 /ws/* 反代到 rust-backend:3000。
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${proto}://${location.host}/ws/dashboard`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function readTokenFromStorage(): string | null {
  try {
    const raw = localStorage.getItem('auth_session');
    if (!raw) return null;
    const s = JSON.parse(raw) as { token?: string };
    return s?.token ?? null;
  } catch {
    return null;
  }
}

// createGlobalState 在模块顶层跑 effectScope(true)，useWebSocket 内部的
// tryOnScopeDispose 注册到 detached scope，永不 dispose → 单例语义正确（组件
// 卸载不会误关共享 socket，模块顶层无 scope 概念）。
const useDashboardWebSocketInternal = createGlobalState(() => {
  const eventSubs = new Set<EventHandler>();
  const statusSubs = new Set<StatusHandler>();

  // URL computed：依赖 tokenVersion，每次 bump 都重算。
  const wsUrl = computed(() => {
    // 显式读 tokenVersion.value 以建立依赖（computed 体内仅访问 token 不会触发 ref 收集）。
    void tokenVersion.value;
    return buildWsUrl(readTokenFromStorage());
  });

  const { status, close, open } = useWebSocket(wsUrl, {
    autoReconnect: { retries: -1, delay: reconnectDelay },
    onConnected() {
      notifyStatus('open');
    },
    onDisconnected() {
      notifyStatus('closed');
    },
    onError(_ws, e) {
      console.error('dashboard WS error', e);
    },
    onMessage(_ws, e) {
      try {
        const msg = JSON.parse(e.data) as DashboardServerMessage;
        dispatch(msg);
      } catch (err) {
        // 后端 30s 心跳 {type:'heartbeat'} text 帧正常不抛错；其它解析失败仅记日志。
        console.error('dashboard WS parse error', err);
      }
    },
  });

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
    // 2026-09-28 review 第 1 轮修复：显式三分支（plan 3.10 字面要求），保留
    // snapshot 与 heartbeat 的 no-op 行为不变（HTTP 全量首取已替代 snapshot；
    // heartbeat 是后端 30s 保活 text 帧，前端无需消费）。
    if (msg.type === 'event') {
      // 【B1 预留】若日后落地真增量（DASHBOARD_ITEM_UPSERT / REMOVE 等），
      // 在此 switch (msg.event_type) 二级分发到 query cache patcher，
      // default 仍走事件 invalidate 兜底。当前架构走「WS 事件 → HTTP 重取」，
      // 二级分发只区分「影响 dashboard 大屏的事件集」一个维度（AFFECTS_DASHBOARD）。
      for (const h of eventSubs) {
        try {
          h(msg);
        } catch (e) {
          console.error('dashboard event handler error', e);
        }
      }
    } else if (msg.type === 'snapshot' || msg.type === 'heartbeat') {
      // snapshot 帧不再分发（HTTP 全量首取已替代）；heartbeat 帧直接忽略。
      return;
    }
  }

  // 把 VueUse 'CONNECTING' / 'OPEN' / 'CLOSED' 翻译成 ConnectionStatus（保持
  // 现有 public 类型语义不变，外部 status handler 仍按 'connecting' | 'open' |
  // 'closed' 写 switch）。
  // 2026-09-28 review 第 1 轮修复：加 immediate: true，让模块首次实例化时
  // 初始 CONNECTING 状态也能触发 status handler（原手写代码在 connect() 顶部
  // 同步 notifyStatus('connecting')，语义对齐）。
  watch(
    status,
    (s) => {
      if (s === 'CONNECTING') notifyStatus('connecting');
    },
    { immediate: true },
  );

  return {
    eventSubs,
    statusSubs,
    close,
    open,
  };
});

function getSocket(): ReturnType<typeof useDashboardWebSocketInternal> {
  return useDashboardWebSocketInternal();
}

// ============================================================
// 公共 API：订阅 / 关闭 / 重连（保持既有 contract）
// ============================================================

/** 订阅业务事件（横幅通知消费 + 大屏 invalidate 触发）。
 *  频道「events」与「dashboard snapshot」语义对齐：后端每条新连接默认推 events。 */
export function onDashboardEvent(h: EventHandler): () => void {
  const { eventSubs } = getSocket();
  eventSubs.add(h);
  return () => {
    eventSubs.delete(h);
  };
}

/** 订阅连接状态。状态订阅本身不影响 socket 生命周期。 */
export function onDashboardStatus(h: StatusHandler): () => void {
  const { statusSubs } = getSocket();
  statusSubs.add(h);
  return () => {
    statusSubs.delete(h);
  };
}

/** 显式关闭长连接（一般不调用，保留供登出 / 测试使用）。 */
export function closeDashboard(): void {
  const { close } = getSocket();
  close();
}

/**
 * 强制发起一次重连，主要用于 JWT 刷新后手动触发。
 * 实际线上不需要手动调用 —— 'auth:tokens-refreshed' CustomEvent 监听器会自动
 * bump tokenVersion 触发 VueUse 重连；此处保留供登出后重新登录等手动场景兜底。
 */
export function reconnectDashboard(): void {
  const { open } = getSocket();
  open();
}

// ============================================================
// HTTP 全量首取（2026-09-28 新增，与 WS snapshot 帧并行；WS 首帧不再消费）
// ============================================================

/** GET /api/v2/dashboard/snapshot —— 拉一次大屏全量快照。
 *  返回值已由 http.ts 响应拦截器解封（response.data = payload.data），
 *  即 api.get 返回的 resp.data 已经是 DashboardSnapshotData，不再是 R<T> 信封。 */
export async function fetchDashboardSnapshot(): Promise<DashboardSnapshotData> {
  const resp = await api.get<DashboardSnapshotData>('/dashboard/snapshot');
  return resp.data;
}

// ============================================================
// 'auth:tokens-refreshed' CustomEvent 监听 → bump tokenVersion → 自动重连
// ============================================================
// 用 module-level flag 保证只注册一次监听（HMR 下模块可能被重复求值）。
let refreshListenerBound = false;
if (typeof window !== 'undefined' && !refreshListenerBound) {
  refreshListenerBound = true;
  window.addEventListener('auth:tokens-refreshed', () => {
    // wsUrl computed 每次重新计算时现读 localStorage，新 token 已就位；
    // bump tokenVersion 让 VueUse watch(urlRef, open) 自动重连。
    tokenVersion.value++;
  });
}

// ============================================================
// 兼容导出（部分 spec 仍可能 import 类型）
// ============================================================
// 显式 re-export 事件类型别名方便上层按事件名集合过滤（views/dashboard/
// composables/useDashboardSnapshot.ts 的 AFFECTS_DASHBOARD 常量会用到类型）。
export type { DashboardEventType };
