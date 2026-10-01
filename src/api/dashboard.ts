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
//   - 2026-10-01：URL 从 `computed + tokenVersion` 改为模块级 `shallowRef` + 显式
//     syncWsUrl()，并由 'auth:session-changed' 事件驱动（覆盖 login / logout / token
//     刷新三条路径）。详见下方 wsUrl 注释。URL 为 undefined（无 token）时零连接尝试。
//   - autoReconnect 指数退避 1s→10s 封顶，**不封顶重试次数**（WS 是 dashboard 唯一
//     更新通道，放弃重连会让页面静默停止刷新）；失败日志做降频处理，见 reportFailure。
//   - 2026-10-02：后端补完主动 Close 帧（此前所有断开都是裸 drop，浏览器只见 1006），
//     关闭码有语义了。其中 **4001「会话在连接期间失效」是唯一的终止性关闭码**，本层
//     停重连 + 清 session + 派发 'auth:session-lost' 交 app 层走登出；其余关闭码
//     （1011 内部错误 / 1012 服务重启 / 4003 慢消费方 / 1006 裸 drop）仍按无限重试
//     处理，其中 **4003 额外派发 'dashboard:full-refetch'** 要求上层立即全量 HTTP
//     重取（丢的事件重连补不回来）。1001 后端**不主动发**（写失败路径已改裸断 → 实际
//     落 1006），保留在码表里仅作对照。关闭码表见后端
//     ~/Code/hsh-erp/backend-rust/docs/api/websocket.md（唯一权威来源）。
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
import { shallowRef, watch, type ShallowRef } from 'vue';
import { api } from '@/api/http';
import type {
  ConnectionStatus,
  DashboardEvent,
  DashboardEventType,
  DashboardServerMessage,
} from '@/types/dashboard';
import type { DashboardSnapshotData } from '@/views/dashboard/composables/dashboardSnapshotSchema';
import { decodeJwt } from '@/utils/jwt';

type EventHandler = (ev: DashboardEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;

/** 指数退避 1s/2s/4s/8s/10s 封顶，无限重试（对齐原手写 retryDelay 行为）。 */
function reconnectDelay(retries: number): number {
  return Math.min(1000 * 2 ** (retries - 1), 10000);
}

/** 前 3 次失败打完整诊断，之后每 N 次打一行摘要（见 reportFailure 注释）。 */
const FAIL_LOG_DETAIL_TIMES = 3;
const FAIL_LOG_THROTTLE_EVERY = 30;

/** 后端主动关闭码 4001 = 「会话在连接期间失效」（2026-10-02 起前端特殊处理）。
 *
 *  关闭码表的唯一权威来源是后端 `~/Code/hsh-erp/backend-rust/docs/api/websocket.md`：
 *    - 1011 内部错误（`snapshot build failed` / `send snapshot failed` /
 *      `re-auth unavailable` / `pong timeout`）/ 1012 服务重启 / 4003 慢消费方
 *      → 瞬时或可自愈，**必须继续无限重试**；
 *    - 4001 会话失效 → 重试再多次也一样是 401，属于必须终止的死路；
 *    - 1006 浏览器侧的「异常关闭」兜底码（没收到任何 Close 帧），原因未知，
 *      同样按无限重试处理；
 *    - 1001 保留行仅作对照：后端 2026-10-02 起**不主动发 1001**（写失败路径改为
 *      裸断，浏览器侧落 1006）。真收到也不需要特判，与 1006 同走无限重连。 */
const WS_CLOSE_SESSION_LOST = 4001;

/** 后端主动关闭码 4003 = 「慢消费方（广播队列溢出，永久丢了 n 条事件）」。
 *
 *  与 4001 的处理**不同**：4001 是终止性的（会话没了，重试是死路），4003 必须
 *  「重连 + 全量 HTTP 重取」（后端 websocket.md 关闭码表 4003 行的规定动作）。
 *  单纯重连是不够的 —— 本仓 dashboard 域是「HTTP 全量首取 + WS 事件 invalidate
 *  重取」，**重连后的首帧 snapshot 被本层显式 no-op 丢弃**（见 dispatch() 的
 *  `msg.type === 'snapshot'` 分支），且 TanStack Query 无轮询、staleTime 30s 只是
 *  「下次取数是否放行」而不是定时自取 ⇒ 丢掉的 n 个事件没有任何补偿通道，
 *  「丢 1 个事件 = 对应区块永不刷新」。后端文档里 4003 动作成立的前提是「重连时
 *  自然重新收到首帧 snapshot」，那个前提对本前端不成立，必须自己补 invalidate。 */
const WS_CLOSE_LAGGED = 4003;

// ============================================================
// URL 构造 + token 生命周期
// ============================================================

/** 当前 WS URL；`undefined` 是「无 token，不要连」的哨兵值。
 *
 *  哨兵值能天然实现「零连接尝试」：VueUse `useWebSocket` 内部 `_init()` 第一行就是
 *  `if (explicitlyClosed || typeof urlRef.value === "undefined") return;`
 *  （node_modules/@vueuse/core/dist/index.js:8420），URL 为 undefined 时直接返回，
 *  根本不会 `new WebSocket(...)`。旧实现无 token 时仍拿裸 URL 去握手，后端必然回
 *  `40100 缺少 token 查询参数`，于是控制台被无意义的 401 重试刷满。
 *
 *  2026-10-01：从 `computed` + `tokenVersion` 改为显式 `syncWsUrl()` 重算。
 *  旧实现的 computed 唯一响应式依赖是 tokenVersion，而 tokenVersion 只被
 *  `auth:tokens-refreshed` bump —— 该事件仅由 http.ts 的 persistTokens() 在「token
 *  被刷新」时派发。login / logout / dummy-auth 三条路径都不 bump，computed 算过一次
 *  就把旧 URL 缓存死，导致：
 *    1. logout → 不刷新页面 → 重新登录：URL 仍是登出前那个已被吊销的 token → 40105 死循环；
 *    2. `npm run dev:dummy`：initDummyAuth（stores/auth.ts）只写内存不写 localStorage
 *       → 裸 URL → 必然 40100；
 *    3. 空闲超过 access TTL（默认 900s）后：dashboard query 原为 staleTime 无限，
 *       零 HTTP 流量 → maybeProactiveRefresh（只在响应拦截器里调）永不触发
 *       → URL 冻结在已过期 token 上。
 *  现在改为每个 auth 转换点显式 syncWsUrl()；且 VueUse 的 `_init()` 每次重试都会重读
 *  `urlRef.value`，重连天然拿到最新 token。 */
const wsUrl: ShallowRef<string | undefined> = shallowRef(undefined);

function buildWsUrl(token: string): string {
  // 2026-09-15 Phase 5：去掉 /api/v1 前缀；ws_hub（rust）走 /ws/dashboard。
  // 同源策略：浏览器只接触 frontend nginx（dev 5173 / prod 8080 / stage 443）。
  // dev 由 vite.config.ts server.proxy 的 '/ws' 反代到 3000；nginx 模板
  // （nginx.conf / nginx.http-only.conf 的 `location ^~ /ws/`）负责 prod/stage。
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/dashboard?token=${encodeURIComponent(token)}`;
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

/** 按 localStorage 里的当前 token 重算 WS URL。
 *  值不变则不写入 —— 避免触发 VueUse `watch(urlRef, open)` 做无谓重连。 */
function syncWsUrl(): void {
  const token = readTokenFromStorage();
  const next = token ? buildWsUrl(token) : undefined;
  if (wsUrl.value === next) return;
  wsUrl.value = next;
}

/** 日志脱敏：JWT 会进 nginx access log / 报错截图 / 遥测上报，一律替换掉。 */
function redactWsUrl(url: string | undefined): string {
  if (url === undefined) return '(未构造 URL：当前无 token)';
  return url.replace(/([?&]token=)[^&]*/, '$1***');
}

/** 清掉 localStorage 里的会话（仅 4001 分支用）。
 *  后端已判定会话失效，本地留着只会让下一次握手继续拿吊销 token 撞 401。 */
function clearStoredSession(): void {
  try {
    localStorage.removeItem('auth_session');
  } catch {
    // localStorage 不可用（隐私模式 / 被策略禁用）时忽略：真正决定「不再重连」的是
    // 把 wsUrl 置为 undefined，不是这行。
  }
}

// createGlobalState 在模块顶层跑 effectScope(true)，useWebSocket 内部的
// tryOnScopeDispose 注册到 detached scope，永不 dispose → 单例语义正确（组件
// 卸载不会误关共享 socket，模块顶层无 scope 概念）。
const useDashboardWebSocketInternal = createGlobalState(() => {
  const eventSubs = new Set<EventHandler>();
  const statusSubs = new Set<StatusHandler>();

  // 工厂首次执行时同步一次 URL（此时若尚无 token 则保持 undefined，不连接）。
  syncWsUrl();

  let attempt = 0;
  /** 上一次是否收到 error 事件（失败握手必先 error 后 close）。
   *  **只在 closeCode=1006 时有判别力** —— 其余关闭码都是后端主动发的 Close 帧，
   *  不伴随 error 事件且自身已带语义（见 WS_CLOSE_SESSION_LOST 上方注释）：
   *  1006 + true ≈ 握手/网络层失败；1006 + false ≈ 已建立连接后被中间层掐断
   *  （nginx proxy_read_timeout 到期、休眠唤醒、backend 重启）。 */
  let pendingError = false;

  /** 会话失效（4001）诊断（2026-10-02 新增）。
   *
   *  与 reportFailure 分开走：4001 是**终止性**事件而不是一次可重试的失败，
   *  既不进 attempt 计数（否则会污染后续登录后的失败编号），也不走降频逻辑
   *  （一个会话只该打一条）。 */
  function reportSessionLost(ev: CloseEvent): void {
    console.warn(
      '[dashboard WS] 收到后端关闭码 4001（会话在连接期间失效）：已停止重连并清除本地会话，请重新登录',
      { closeCode: ev.code, closeReason: ev.reason || null },
    );
  }

  /** 连接失败诊断（2026-10-01 新增）。
   *
   *  为什么需要它：2026-10-01 之前后端所有断开都是**裸 drop**（全仓零
   *  `sender.send(Message::Close(..))`），浏览器侧只能看到 code 1006 ——
   *  401 / 502 / 代理没配长得一模一样，这正是当时控制台只刷「dashboard WS error」
   *  而查不出原因的原因。
   *
   *  2026-10-02 起后端补完主动 Close 帧，close code 本身带语义（1011 内部错误 /
   *  1012 服务重启 / 4001 会话失效 / 4003 慢消费方；1001 后端不主动发、仅作对照），
   *  **关闭码表见后端 `~/Code/hsh-erp/backend-rust/docs/api/websocket.md`**：
   *  排查应先按 closeCode 查表。**1006 仍是「原因未知」的兜底** —— 鉴权失败是
   *  upgrade 之前就回 HTTP 401（不是 WS Close 帧），浏览器 WS API 不暴露握手期
   *  HTTP status，只有落到 1006 时才需要再去 Network 面板 / 直连后端 curl 查真实
   *  status（4001 走的是 Close 帧，40100「缺少 token」这类根本到不了 close 侧）。
   *
   *  这里打四项 app 内可判定的信息：脱敏 URL / 第几次尝试 / CloseEvent code+reason /
   *  token 是否已过期（decodeJwt 读 exp）。
   *
   *  降噪策略：前 FAIL_LOG_DETAIL_TIMES 次打完整对象，之后每 FAIL_LOG_THROTTLE_EVERY
   *  次打一行。**不封顶重试**（autoReconnect.retries 仍为 -1）—— WS 是 dashboard 唯一
   *  的更新通道，封顶会让页面静默停止刷新，比刷屏更糟。 */
  function reportFailure(stage: 'close', ev?: CloseEvent, hadErrorEvent = false): void {
    attempt += 1;
    if (attempt > FAIL_LOG_DETAIL_TIMES && attempt % FAIL_LOG_THROTTLE_EVERY !== 0) {
      return;
    }
    const token = readTokenFromStorage();
    const exp = token ? (decodeJwt(token)?.exp ?? null) : null;
    console.warn(
      `[dashboard WS] 第 ${attempt} 次连接失败（${stage}），仍会持续重试（退避 1s→10s 封顶）`,
      {
        url: redactWsUrl(wsUrl.value),
        closeCode: ev?.code ?? null,
        closeReason: ev?.reason || null,
        hadErrorEvent,
        tokenExpired: token ? (exp !== null && exp * 1000 <= Date.now()) : null,
        排查提示:
          '先按 closeCode 查后端 docs/api/websocket.md 关闭码表（1011 内部错误 / 1012 服务重启 / 4001 会话失效 / 4003 慢消费方；1001 后端不主动发、仅作对照）；4003 已额外派发全量重取信号（丢的事件重连补不回来）；仅 1006 才需再查握手期 HTTP status（Network 面板 / 直连后端 curl）',
      },
    );
  }

  const { status, close, open } = useWebSocket(wsUrl, {
    autoReconnect: {
      retries: -1,
      delay: reconnectDelay,
      onFailed() {
        // retries: -1 时永不触发（保留作安全网：若日后改成封顶重试，这里会兜住）。
        console.error('[dashboard WS] 重试已耗尽，dashboard 将不再自动刷新，请刷新页面');
      },
    },
    onConnected() {
      attempt = 0;
      notifyStatus('open');
    },
    onDisconnected(_ws, ev) {
      // 2026-10-02 新增：4001「会话在连接期间失效」是**唯一需要终止重连**的关闭码。
      // 少了这个分支，autoReconnect.retries:-1 会拿着已死 token 无限重试 → 每次握手
      // 都被后端判 401/4001 → 控制台永不停歇 —— 正是 2026-10-01 刚修掉的那类 bug
      // （logout 后拿吊销 token 死循环）的另一面。
      if (ev.code === WS_CLOSE_SESSION_LOST) {
        pendingError = false;
        reportSessionLost(ev);
        // ① 停重连：URL 置 undefined，复用已有的「无 token 不连」哨兵。时序说明 ——
        //    VueUse 的 `ws.onclose` 是先调 onDisconnected（本函数）、返回后才
        //    `setTimeout(_init, 1s)`；这里的写入触发 `watch(urlRef, open)` →
        //    `close()` → `resetRetry()` 掐掉那个定时器（Vue scheduler 走微任务，
        //    早于 1s 定时器）。就算没掐掉，`_init()` 首行的 undefined 守卫也不会
        //    `new WebSocket(...)` —— 两道闸，缺一不成立。
        wsUrl.value = undefined;
        // ② 清 session：后端已判定失效，本地留着只会让下一次握手继续 401。
        clearStoredSession();
        // ③ 通知 app 层踢去登录页。本模块**不能**反向 import stores/auth（auth ↔ api
        //    循环依赖），沿用 CLAUDE.md 既定 CustomEvent 解耦范式，接收方是
        //    `src/router/index.ts`（持有 router 实例 + useAuthStore）→ forceLogout(router)。
        //    注意与 'auth:session-changed' 的区别：那个是「token 变了，WS 重算 URL
        //    并重连」，本事件是「后端判定会话已死，请上层终止会话」，方向相反。
        window.dispatchEvent(
          new CustomEvent('auth:session-lost', {
            detail: { code: ev.code, reason: ev.reason || null },
          }),
        );
        notifyStatus('closed');
        return;
      }
      if (ev.code === WS_CLOSE_LAGGED) {
        // 2026-10-02 修复（review Major 2）：慢消费方丢了 n 条事件，重连本身补不回来
        // —— 新连接的订阅集合从此刻起算，错过的 n 条永久丢失，而 dashboard 域只认
        // 「WS 事件 → invalidate → HTTP 重取」，没有别的补偿通道。所以这里补发一次
        // 「全量重取」信号，由 views 层立即 invalidate 对应 query。
        //
        // 本层**不 import useQueryClient**：api 层引入 TanStack Query 依赖是分层倒置
        // （CLAUDE.md 的 api ↔ stores 解耦范式同源）。沿用既有 CustomEvent 解耦，
        // 接收方是 useDashboardInvalidation（已持有 qk + queryClient）→ 立即
        // （不防抖）invalidate。
        //
        // 与 'auth:session-lost' 的区别：那个是「会话已死，终止会话」，这个是
        // 「会话没死，但数据可能已经缺了，补一次全量重取」。
        //
        // 注意：重连本身仍按通用路径走（下面 reportFailure + autoReconnect），4003
        // 只是额外挂一个补数据的信号。其余关闭码（1006/1011/1012）同样会因
        // 断连丢事件，那是既有架构的已知缺口（TanStack Query 无轮询），本轮不扩范围。
        window.dispatchEvent(
          new CustomEvent('dashboard:full-refetch', {
            detail: { code: ev.code, reason: ev.reason || null },
          }),
        );
      }
      // 一次失败会先 fire error 再 fire close，只在 close 侧计一次，避免重复计数。
      reportFailure('close', ev, pendingError);
      pendingError = false;
      notifyStatus('closed');
    },
    onError() {
      // 失败握手的 error 事件不携带任何信息（无 status / 无 code），只置标记，
      // 由紧随其后的 onDisconnected 统一出日志。
      pendingError = true;
    },
    onMessage(_ws, e) {
      try {
        // 2026-09-28 review 第 2 轮修复（N3）：WS 帧壳已在 types/dashboard.ts 用
        // discriminated union（DashboardEvent | WsSnapshotMsg | WsHeartbeatMsg）
        // 描述，无需 `as DashboardServerMessage` 强转；TS 在 dispatch 内的
        // if/else if 分支能按 msg.type 字面量正确 narrow。
        const msg: DashboardServerMessage = JSON.parse(e.data);
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
    // 2026-09-28 review 第 2 轮修复（N3）：union 补全后这里用 discriminated union
    // narrowing；msg.type 字面量在每个分支被精确收窄到对应 interface，
    // TS 不再把 snapshot/heartbeat 帧硬塞到 DashboardEvent 类型里。
    // 2026-09-28 review 第 1 轮修复：显式三分支（plan 3.10 字面要求），保留
    // snapshot 与 heartbeat 的 no-op 行为不变（HTTP 全量首取已替代 snapshot；
    // heartbeat 是后端 30s 保活 text 帧，前端无需消费）。
    if (msg.type === 'event') {
      // 【B1 预留】未来形态：若日后落地真增量（DASHBOARD_ITEM_UPSERT / REMOVE 等），
      // 在此分支内加二级分发（例：按 msg.event_type 走 query cache patcher，
      // default 仍走事件 invalidate 兜底）。当前架构走「WS 事件 → HTTP 重取」，
      // 二级分发只区分「影响 dashboard 大屏的事件集」一个维度
      // （AFFECTS_DASHBOARD，详见 useDashboardSnapshot.ts），所以此分支
      // 仅做 fan-out + 错误隔离，未来 B1 落地时再内嵌二级分发。
      for (const h of eventSubs) {
        try {
          h(msg);
        } catch (e) {
          console.error('dashboard event handler error', e);
        }
      }
    } else if (msg.type === 'snapshot') {
      // 2026-09-28 新架构下不再消费首帧 snapshot 业务字段（HTTP 全量首取
      // 已替代）；保留分支显式 no-op 便于日后落地真增量 patch。
      return;
    } else if (msg.type === 'heartbeat') {
      // 30s 保活 text 帧直接忽略。
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

  // 2026-10-01 新增：token 变了就把失败计数清零，避免 logout→login 之后第一条失败
  // 就因为继承了旧计数而被降频逻辑静默吞掉。
  watch(wsUrl, () => {
    attempt = 0;
    pendingError = false;
  });

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
 * 强制发起一次重连。
 * 常规路径不需要手动调用 —— `auth:session-changed` 监听器会自动 syncWsUrl()，
 * URL 变化时 VueUse `watch(urlRef, open)` 自己重连。此处保留供测试与
 * 「已知连接已死、想立刻重来一次」的手动兜底。
 *
 * 2026-10-02：4001（会话失效）之后调用它也**不会**建连 —— 那一分支已清掉
 * localStorage 会话并把 URL 置 undefined，syncWsUrl() 读不到 token，只能等用户
 * 重新登录（重新登录会派发 auth:session-changed 带新 token，URL 随之恢复）。
 */
export function reconnectDashboard(): void {
  syncWsUrl();
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
// 'auth:session-changed' CustomEvent 监听 → syncWsUrl() → 自动重连 / 关闭
// ============================================================
// 2026-10-01：统一 auth 转换事件，取代原先只订阅 'auth:tokens-refreshed' 的做法。
// 派发方共 3 处，覆盖全部 token 生命周期：
//   - api/http.ts    persistTokens()：access token 被刷新（原本就 dispatch）
//   - stores/auth.ts loginMutation.onSuccess：登录成功写入新 token
//   - stores/auth.ts logout()：登出，detail.token = null → WS 主动断开
// 沿用 CLAUDE.md 既定解耦：事件派发方不 import 本模块，本模块也不 import
// stores/auth（避免 auth ↔ api 循环依赖）。
// 仍然只保留 auth:tokens-refreshed 供 useAuthStore 同步自身 state —— 那是另一件事
// （store 的 token/user/refreshToken 状态），不归 WS 层管。
//
// 用 module-level flag 保证只注册一次监听（模块顶层代码在 HMR 下可能被重复求值；
// 重复注册会导致同一事件触发多次 syncWsUrl，虽有值相等短路兜底但仍应避免）。
let sessionListenerBound = false;
if (typeof window !== 'undefined' && !sessionListenerBound) {
  sessionListenerBound = true;
  window.addEventListener('auth:session-changed', () => {
    // 现读 localStorage（登录 / 刷新后新 token 已就位；登出后 key 已删）。
    // 值变化 → VueUse watch(urlRef, open) 触发重连；
    // 变为 undefined → open() 内 close() 后 _init() 因 url undefined 直接返回，连接关闭。
    syncWsUrl();
  });
}

// ============================================================
// 本层派发的两个 CustomEvent（2026-10-02 新增，方向与上面相反）
// ============================================================
// 上面的 'auth:session-changed' 是「本层**听** auth 层说话」；下面两个是
// 「本层**告诉**上层发生了什么」，派发点都在 onDisconnected，各自一处，无 HMR
// 重复注册问题。之所以都绕开直接 import：
//   - 'auth:session-lost' 不 import stores/auth（否则 auth ↔ api 循环依赖）；
//   - 'dashboard:full-refetch' 不 import @tanstack/vue-query（api 层引入
//     TanStack Query 依赖是分层倒置）。
// 两者接收方与语义：
//   1. 'auth:session-lost'（4001 会话失效，终止性）
//      `CustomEvent<{ code: number; reason: string | null }>`，接收方是
//      `src/router/index.ts` → auth.forceLogout(router)（无条件终止会话 +
//      router.replace('/login')）。语义：**会话没了，别再连**。
//   2. 'dashboard:full-refetch'（4003 慢消费方丢了 n 条事件，非终止性）
//      `CustomEvent<{ code: number; reason: string | null }>`，接收方是
//      `src/views/dashboard/composables/useDashboardInvalidation.ts` → 立即
//      （不防抖）invalidate 本 composable 持有的全部 queryKey。
//      语义：**会话还在，但数据可能已经缺了，补一次全量重取**。

// ============================================================
// 兼容导出（部分 spec 仍可能 import 类型）
// ============================================================
// 显式 re-export 事件类型别名方便上层按事件名集合过滤（views/dashboard/
// composables/useDashboardSnapshot.ts 的 AFFECTS_DASHBOARD 常量会用到类型）。
export type { DashboardEventType };
