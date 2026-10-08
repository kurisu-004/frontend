// dashboard 域 WebSocket 层（2026-09-28 重写；2026-10-07 随 VO 重构同步 HTTP 面）。
//
// 数据流（与 frontend/CLAUDE.md 2026-09-28 新增的「dashboard 域 HTTP 全量 +
// WS 事件 invalidate」架构对齐）：
//   1. 消费者通过 views/dashboard/composables/ 下的三个 composable 订阅大屏数据：
//      useDashboardSnapshot（快照）/ useDashboardUpcoming（交期分桶）/
//      useDashboardDeliveryOrders（柱状图下钻）。三者都走 HTTP 首取 + WS 事件
//      invalidate 重取，不依赖本模块推送的业务数据。
//   2. 本模块仍是 WebSocket 单例层：持有唯一长连接 + 按频道分发事件给订阅者。
//      WS 首帧 snapshot 仍会到达（后端行为不变），但前端消费方已切到 HTTP 全量，
//      故首帧 snapshot 仅作「连接就绪信号」（通过 onConnected 标记 isReady）。
//   3. 业务事件（PICKED_UP / RELEASED / PART_TO_SHIP 等）继续通过 onDashboardEvent
//      派发给 NotificationBanner.vue / useDashboardInvalidation 等消费者。
//
// 实现要点：
//   - 用 VueUse useWebSocket + createGlobalState 包单例（替代原 258 行手写 socket 管理）；
//   - 2026-10-01：URL 从 `computed + tokenVersion` 改为模块级 `shallowRef` + 显式
//     syncWsUrl()，并由 'auth:session-changed' 事件驱动（覆盖 login / logout / token
//     刷新三条路径）。详见下方 wsUrl 注释。URL 为 undefined（无 token）时零连接尝试。
//   - autoReconnect 指数退避 1s→10s 封顶，**不封顶重试次数**（WS 是 dashboard 唯一
//     更新通道，放弃重连会让页面静默停止刷新）；失败日志做降频处理，见 reportFailure。
//   - 后端补完主动 Close 帧，关闭码有语义了。**4001 是唯一的终止性关闭码**：本层停
//     重连（wsUrl 置 undefined）+ 派发 'auth:session-lost' 交 app 层按 reason 分流；
//     其余关闭码（1011 内部错误 / 1012 服务重启 / 4003 慢消费方 / 1006 裸 drop）仍按
//     无限重试处理，其中 **4003 额外派发 'dashboard:full-refetch'** 要求上层立即全量
//     HTTP 重取（丢的事件重连补不回来）。
//     关闭码语义的权威来源：后端 `docs/api/dashboard.md` §7.1 关闭码表（前后端联合契约）
//     + 后端 `src/modules/dashboard/handler.rs` 的纯函数 `reauth_close_code`（码 ↔ reason
//     的映射真源）；`1006` 的成因、4001 的两段 reason 契约见下方各自常量注释。
//   - 不再发送 subscribe/unsubscribe 控制帧 —— 后端 v2 ws_hub 不消费这俩文本帧
//     （2026-09-25 注释 + 2026-09-28 决策删除），后端默认行为是按连接初始订阅集合
//     推 snapshot + events，删控制帧后逻辑等价；
//   - heartbeat 选项不启用 —— VueUse heartbeat 是「客户端主动 ping」，与本场景
//     「服务端 30s 推 {type:'heartbeat'} text 帧」无关，收到也只在 onMessage
//     分发层丢包。
//
// 子任务锚点：dashboard 域的数据流是 HTTP 全量首取 + WS 事件 invalidate 重取，
// WS 层不复用 server-pushed snapshot 的业务数据。HTTP 面共 3 个只读端点
// （snapshot / upcoming-delivery / delivery-orders），见文件末尾「HTTP 端点」段。

import { createGlobalState, useWebSocket } from '@vueuse/core';
import { shallowRef, watch, type ShallowRef } from 'vue';
import { api, cleanParams } from '@/api/http';
import type { OrderStatus } from '@/types/parts';
import type {
  ConnectionStatus,
  DashboardEvent,
  DashboardEventType,
  DashboardServerMessage,
  DeliveryBasis,
} from '@/types/dashboard';
import type {
  DashboardSnapshotData,
  DeliveryOrderDetailOutData,
  UpcomingBucketsData,
} from '@/views/dashboard/composables/dashboardSnapshotSchema';
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

/** 后端主动关闭码 4001 = 「连接期间的周期性 re-auth 失败」。
 *
 *  语义真源是后端 `src/modules/dashboard/handler.rs` 的纯函数 `reauth_close_code`
 *  （完整的前后端联合契约表见 `docs/api/dashboard.md` §7.1「关闭码表」，逐行给出
 *  code × reason × 发出点 × 前端应做什么）：
 *    - 1011 `re-auth unavailable` / 1011 `pong timeout` / 1012 服务重启 / 4003 慢消费方
 *      → 瞬时或可自愈，**必须继续无限重试**；
 *    - 4001 → 重试再多次也一样失败，属于必须终止的死路；
 *    - 1006 浏览器侧的「异常关闭」兜底码（没收到任何 Close 帧），原因未知
 *      （nginx 掐断 / 休眠唤醒 / 代理配置缺失），同样按无限重试处理。
 *
 *  **4001 带两段 reason，含义完全不同（2026-10-09 起）** —— 两段都由后端
 *  `reauth_close_code` 产出（**不是前端自造**；字面量与该函数逐字节对齐，契约见
 *  `docs/api/dashboard.md` §7.1 的 4001 两行）：
 *    - `access token expired`（`code::TOKEN_EXPIRED` 40102）：钉在这条连接上的那枚
 *      access JWT 自然过期。会话本身可能还活着，refresh token 仍是好的；
 *    - `auth expired`（`code::UNAUTHORIZED` 40100 / `code::SESSION_REVOKED` 40105）：
 *      真·会话被吊销（登出 / 改密 / 管理员停用 / refresh rotation reuse detection）。
 *  本层**不解释**这两段的区别（WS 层不得 import stores/auth），把 reason 原样透传，
 *  由 app 层（`src/router/index.ts` 的 'auth:session-lost' listener）分流：过期 →
 *  refreshOrLogout + 重连；吊销 → forceLogout。*/
const WS_CLOSE_SESSION_LOST = 4001;

/** 后端主动关闭码 4003 = 「慢消费方（广播队列溢出，永久丢了 n 条事件）」。
 *
 *  与 4001 的处理**不同**：4001 是终止性的（重连是死路），4003 必须
 *  「重连 + 全量 HTTP 重取」（后端 `docs/api/dashboard.md` §7.1 慢消费方条的规定动作）。
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
  // ws_hub（rust）走 /ws/dashboard。
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

// 「紧随其后的 close 是我们自己触发的」标记为什么必须存在（实现见工厂内的
// `expectedClosingWs` —— 标记本体是「待关闭的 socket 实例」而不是布尔量）：
// VueUse 的 `useWebSocket` 在 `ws.onclose` 里**无条件**调 `onDisconnected(ws, ev)`，
// `explicitlyClosed` 只挡紧随其后的 `autoReconnect` 分支 —— 也就是说 `close()` /
// `open()` 触发的主动关闭（`code = 1000`）会照常流进 onDisconnected。主动关闭的典型
// 来源是 token 被刷新：`persistTokens` 派发 'auth:session-changed' → syncWsUrl() 改
// URL → 换连接。若不区分，控制台每次刷新都会多一条「第 N 次连接失败」的假告警，并让
// attempt 计数虚增（叠加 watch(wsUrl) 同 flush 内把计数清零，表现为「第 1 次」刷不停）。
//
// **禁止退化成「无条件吞掉 code === 1000」**：code 1000 也可能由服务端 / 中间层主动
// 发出，那属于真实断开，必须照常走 reportFailure。只有带本标记的才跳过记账。

/** 按 localStorage 里的当前 token 重算 WS URL。
 *  值不变则不写入 —— 避免触发本层的 `watch(wsUrl, …)` 做无谓重连。
 *  **本函数只写 URL，不负责换连接**：换连接统一走工厂内的 `reopenConnection` /
 *  `closeConnection`（那里才能保证「先捕获旧 socket 实例」）。 */
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

// 2026-10-09 移除 `clearStoredSession()`：4001 不再由本层删 localStorage。
// 见 onDisconnected 的 4001 分支与 WS_CLOSE_SESSION_LOST 上方的 reason 契约注释。

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

  /** 「本次 close 是我们自己发的」的标记：**待关闭的 socket 实例**（不是布尔量）。
   *
   *  2026-10-09 变更缘由（布尔标记为什么必然滞留）：对照 VueUse 的实现 ——
   *   - `onDisconnected` 是从 `ws.onclose` 里调的，此刻 socket 已经是 CLOSED，此时我们
   *     再 `close()` 打在它身上，**真实浏览器不会再派发 close 事件**（桩里若无条件
   *     派发反而制造了「标记一定会被消费」的假象）；
   *   - `_init()` 首行因 URL 已是 undefined 直接 return，`onConnected` 也不会来；
   *   ⇒ 标记留到下一次真实断开（1006 / 4003）时被消费掉：不打 warn、不推进 attempt，
   *     `pendingError` 被清零，连 4003 的 `dashboard:full-refetch` 补数据信号也一起跳过。
   *
   *  改成按**实例同一性**判定后，滞留也无害：一个 WebSocket 只会派发一次 close 事件，
   *  标记绑在具体实例上就**不可能**吞掉别的连接的失败 —— 这是结构性保证，不是概率性
   *  改善。也是为什么 `onConnected` 里不再需要（也不应该）清它。
   */
  let expectedClosingWs: WebSocket | null = null;

  /** 记录「接下来这次 close 由我们发出」，必须**紧挨着** close() / open() 调用。
   *  顺序敏感：必须先取 `ws.value` —— `open()` 内部先 `close()` 再同步 `_init()`，
   *  之后 `ws.value` 已经是**新** socket 了。 */
  function armExpectedClose(): void {
    expectedClosingWs = ws.value ?? null;
  }

  /** 主动停连（登出 / 4001 停重连）。 */
  function closeConnection(): void {
    armExpectedClose();
    close();
  }

  /** 主动换连接（URL 变化 / 显式重连）：先关旧再开新。 */
  function reopenConnection(): void {
    armExpectedClose();
    open();
  }

  /** URL 变化后的换连接；当前连接已经是这个 URL 就不重复换。
   *
   *  这道守卫不是省流量的小优化，而是正确性要求：VueUse 只在 `close()` 里清空
   *  wsRef，真实断开（1006 / 4003）后 `ws.value` 仍指着那条死连接，此时若无条件换，
   *  会与 autoReconnect 定时器（1s 后按**当前** URL 重建）撞出一条多余的连接抖动。
   *  URL 为 undefined（无 token / 4001 停连）时守卫不放行 —— 正是要把连接关掉。 */
  function reopenForUrlChange(): void {
    const current = ws.value;
    if (current !== undefined && wsUrl.value !== undefined && current.url === wsUrl.value) return;
    reopenConnection();
  }

  /** 会话失效（4001）诊断。
   *
   *  与 reportFailure 分开走：4001 是**终止性**事件而不是一次可重试的失败，
   *  既不进 attempt 计数（否则会污染后续登录后的失败编号），也不走降频逻辑
   *  （一个会话只该打一条）。文案带 reason：两段 reason（access token expired /
   *  auth expired）指向完全不同的 app 层处置，一眼可辨。 */
  function reportSessionLost(ev: CloseEvent): void {
    console.warn('[dashboard WS] 收到后端关闭码 4001（连接期间 re-auth 失败）：已停止重连', {
      closeCode: ev.code,
      closeReason: ev.reason || null,
      处置:
        ev.reason === 'access token expired'
          ? '仅 access JWT 过期：本地会话保持不变，由 app 层 refresh 后重连'
          : '会话已吊销：本地会话清理由 app 层完成（teardownSession 会删 auth_session）',
    });
  }

  /** 连接失败诊断。
   *
   *  2026-10-02 起后端补完主动 Close 帧，close code 本身带语义（1011 内部错误 /
   *  1012 服务重启 / 4001 re-auth 失败 / 4003 慢消费方；1006 是原因未知的兜底码），
   *  **关闭码语义的后端权威来源是 `src/modules/dashboard/handler.rs` 的
   *  `reauth_close_code`**（逐行契约表见 `docs/api/dashboard.md` §7.1「关闭码表」）：
   *  排查应先按 closeCode 查这张表。**1006 仍是「原因未知」的兜底** —— 鉴权失败是
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
        tokenExpired: token ? exp !== null && exp * 1000 <= Date.now() : null,
        排查提示:
          '先按 closeCode 查后端 handler.rs 的 reauth_close_code 关闭码表（1011 内部错误 / 1012 服务重启 / 4001 re-auth 失败 / 4003 慢消费方；1006 是原因未知的兜底码）；4003 已额外派发全量重取信号（丢的事件重连补不回来）；仅 1006 才需再查握手期 HTTP status（Network 面板 / 直连后端 curl）',
      },
    );
  }

  const { status, close, open, ws } = useWebSocket(wsUrl, {
    // 2026-10-09：关掉 VueUse 自己的 `watch(urlRef, open)`，改由本文件的
    // `watch(wsUrl, …)` 走 `reopenForUrlChange`。`autoConnect: false` **只**影响那一句
    // `watch`，`immediate` 的首次建连照旧（工厂里先 syncWsUrl() 再建实例）。
    // 换掉的原因：VueUse 的 watch 注册更早、与本文件的 watch 落在同一个 flush，它会先跑
    // `open()` —— 而 `open()` 里同步 `_init()` 把 wsRef 换成**新** socket，那时我们再想
    // 「记下即将关闭的旧实例」已经取不到了。改成自己驱动后，顺序由我们说了算。
    autoConnect: false,
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
      // 这里**不**碰主动关闭标记（2026-10-09）：标记绑在具体 socket 实例上，滞留也无害。
      // 而且旧实现的「onConnected 里清标记」本身是个反向乱序竞争 —— reconnectDashboard
      // 的顺序是「置位 → open()」，真实浏览器里旧 socket 的 close 事件与新 socket 的
      // open 事件**无顺序保证**：新连接握手更快时 onConnected 先跑 → 清掉标记 → 随后旧
      // socket 的 close 到达，被记成一次真实失败。改成实例匹配后这个竞争自然消失。
      notifyStatus('open');
    },
    onDisconnected(_ws, ev) {
      // 主动关闭判定必须放在最前面。判定依据是「**实例同一性**」，不是 code：code 1000
      // 也可能由服务端 / 中间层主动发出，那是真实断开，必须照常走 reportFailure。
      if (expectedClosingWs !== null && expectedClosingWs === _ws) {
        expectedClosingWs = null;
        pendingError = false;
        notifyStatus('closed');
        return;
      }
      // 4001「连接期间 re-auth 失败」是**唯一需要终止重连**的关闭码。少了这个分支，
      // autoReconnect.retries:-1 会拿着已死 token 无限重试 → 每次握手都被后端判
      // 401/4001 → 控制台永不停歇。
      if (ev.code === WS_CLOSE_SESSION_LOST) {
        pendingError = false;
        reportSessionLost(ev);
        // ① 停重连：URL 置 undefined，复用已有的「无 token 不连」哨兵。时序说明 ——
        //    VueUse 的 `ws.onclose` 是先调 onDisconnected（本函数）、返回后才
        //    `setTimeout(_init, 1s)`；这里的写入触发本文件的 `watch(wsUrl, …)` →
        //    `closeConnection()` → `close()` → `resetRetry()` 掐掉那个定时器（Vue
        //    scheduler 走微任务，早于 1s 定时器）。就算没掐掉，`_init()` 首行的
        //    undefined 守卫也不会 `new WebSocket(...)` —— 两道闸，缺一不成立。
        //    标记也在那里置位（统一入口负责「先捕获旧实例」），这次 close 不会被
        //    记成「第 N 次连接失败」（那句文案「仍会持续重试」与已停重连的事实也矛盾）。
        wsUrl.value = undefined;
        // ② 通知 app 层按 reason 分流。本模块**不能**反向 import stores/auth / vue-router
        //    （auth ↔ api 循环依赖 + WS 层分层禁令），沿用 CLAUDE.md 既定 CustomEvent
        //    解耦范式，接收方是 `src/router/index.ts`（持有 router 实例 +
        //    useAuthStore）。reason 两段语义见 WS_CLOSE_SESSION_LOST 上方注释。
        //
        //    **本层不删 localStorage**：4001 有两段 reason，而「删会话」这一步只能由
        //    app 层按 reason 决定 —— `access token expired` 时 refresh token 仍然有效，
        //    删掉等于把用户踢去登录页。真正需要清会话时 app 层走
        //    `forceLogout` → `teardownSession()`，那里本来就会
        //    `localStorage.removeItem('auth_session')`，不需要 WS 层抢跑。
        //
        //    与 'auth:session-changed' 的区别：那个是「token 变了，WS 重算 URL
        //    并重连」，本事件是「后端 re-auth 失败了，请上层处置会话」，方向相反。
        window.dispatchEvent(
          new CustomEvent('auth:session-lost', {
            detail: { code: ev.code, reason: ev.reason || null },
          }),
        );
        notifyStatus('closed');
        return;
      }
      if (ev.code === WS_CLOSE_LAGGED) {
        // 慢消费方丢了 n 条事件，重连本身补不回来 —— 新连接的订阅集合从此刻起算，
        // 错过的 n 条永久丢失，而 dashboard 域只认「WS 事件 → invalidate → HTTP
        // 重取」，没有别的补偿通道。所以这里补发一次「全量重取」信号，由 views 层
        // 立即 invalidate 对应 query。
        //
        // 本层**不 import useQueryClient**：api 层引入 TanStack Query 依赖是分层倒置
        // （CLAUDE.md 的 api ↔ stores 解耦范式同源）。沿用既有 CustomEvent 解耦，
        // 接收方是 useDashboardInvalidation（已持有 qk + queryClient）→ 立即
        // （不防抖）invalidate。
        //
        // 与 'auth:session-lost' 的区别：那个是「会话出问题，终止/恢复会话」，这个是
        // 「会话没事，但数据可能已经缺了，补一次全量重取」。
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
        // WS 帧壳已在 types/dashboard.ts 用 discriminated union
        // （DashboardEvent | WsSnapshotMsg | WsHeartbeatMsg）描述，无需
        // `as DashboardServerMessage` 强转；TS 在 dispatch 内的 if/else if 分支
        // 能按 msg.type 字面量正确 narrow。
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
    // union 补全后这里用 discriminated union narrowing；msg.type 字面量在每个分支被
    // 精确收窄到对应 interface，TS 不再把 snapshot/heartbeat 帧硬塞到
    // DashboardEvent 类型里。显式三分支，snapshot 与 heartbeat 的 no-op 行为保留
    // （HTTP 全量首取已替代 snapshot；heartbeat 是后端 30s 保活 text 帧，前端无需消费）。
    if (msg.type === 'event') {
      // 未来形态：若日后落地真增量（DASHBOARD_ITEM_UPSERT / REMOVE 等），在此分支内
      // 加二级分发（例：按 msg.event_type 走 query cache patcher，default 仍走事件
      // invalidate 兜底）。当前架构走「WS 事件 → HTTP 重取」，二级分发只区分
      // 「影响 dashboard 大屏的事件集」一个维度（AFFECTS_DASHBOARD，详见
      // useDashboardSnapshot.ts），所以此分支仅做 fan-out + 错误隔离。
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
  // 'closed' 写 switch。immediate: true 让模块首次实例化时初始 CONNECTING 状态
  // 也能触发 status handler。
  watch(
    status,
    (s) => {
      if (s === 'CONNECTING') notifyStatus('connecting');
    },
    { immediate: true },
  );

  // token 变了就把失败计数清零，并按新 URL 换连接。
  //
  // 这是**唯一**驱动「URL 变化 → 重连」的地方（`useWebSocket` 的 `autoConnect: false`
  // 关掉了它自己那条 `watch(urlRef, open)`），这样才能保证换连接时先捕获旧 socket
  // 实例再 open，见 armExpectedClose / reopenForUrlChange 那组函数的注释。
  watch(wsUrl, () => {
    attempt = 0;
    pendingError = false;
    reopenForUrlChange();
  });

  return {
    eventSubs,
    statusSubs,
    closeConnection,
    reopenConnection,
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
  // 走统一入口：主动关闭不记失败（VueUse 的 onclose 不看 explicitlyClosed，必须在
  // 调 close 前把「即将关闭的那个 socket 实例」记下来）。
  getSocket().closeConnection();
}

/**
 * 强制发起一次重连。
 *
 * 常规路径不需要手动调用 —— `auth:session-changed` 监听器会自动 syncWsUrl()，
 * URL 变化时本层的 `watch(wsUrl, …)` 自己重连。此处保留供
 * 「4001 的 reason 是 access token expired，app 层 refresh 成功后要立刻恢复长连接」
 * 以及测试使用。
 *
 * URL 真的变了就交给那个 watcher（那时还没有按新 URL 建好的连接，不会重复换）；URL 没
 * 变时必须显式换一次，否则长连接停在已关闭态。
 *
 * 无有效 token 时（storage 里没有 auth_session）`open()` 不会建连
 * （`_init()` 首行的 undefined 守卫），保持静默。
 */
export function reconnectDashboard(): void {
  const prev = wsUrl.value;
  syncWsUrl();
  if (wsUrl.value === prev) getSocket().reopenConnection();
}

// ============================================================
// HTTP 端点（2026-10-07 收敛为 3 个，与 WS snapshot 帧并行；WS 首帧不再消费）
//
// 契约来源：backend-rust docs/api/dashboard.md
//   1. GET /dashboard/snapshot          —— 无 query 参数
//   2. GET /dashboard/upcoming-delivery —— basis? / days?
//   3. GET /dashboard/delivery-orders   —— date / statuses 必填，basis?
// 三个端点都是只读聚合，返回值已由 http.ts 响应拦截器解封（response.data = payload.data），
// 即 api.get 返回的 resp.data 已经是内层 VO，不再是 R<T> 信封。
//
// 快照与分桶拆成两个端点的理由：分桶的 days / basis 是**可变**入参，与快照主体的
// 刷新节奏、缓存身份都不同 —— 放一起会导致切口径 / 切天数时整个快照换键重取。
// ============================================================

/** GET /api/v2/dashboard/snapshot —— 拉一次大屏全量快照（无 query 参数）。
 *  后端不接受任何 query（交期分桶已拆到 /dashboard/upcoming-delivery），多传会被忽略
 *  但语义上已无意义，故本函数不暴露 params。 */
export async function fetchDashboardSnapshot(): Promise<DashboardSnapshotData> {
  const resp = await api.get<DashboardSnapshotData>('/dashboard/snapshot');
  return resp.data;
}

/** 2026-10-07：GET /dashboard/upcoming-delivery 的可选查询参数。
 *  全部 optional，缺省由后端决定（basis 缺省 system、days 缺省 14 并 clamp 到 1..60）。
 *  前端调用点一律显式传全两个（口径 / 天数是页面级可见状态，走 cleanParams 后
 *  undefined 才不会被发出去）。 */
export interface FetchUpcomingDeliveryParams {
  /** 交期统计口径：planned（计划交期）/ system（系统交期）。 */
  basis?: DeliveryBasis;
  /** 窗口天数（未来 N 天）；后端 clamp 1..60。 */
  days?: number;
}

/** GET /api/v2/dashboard/upcoming-delivery —— 交期分桶（柱状图数据源 + 今日/窗口 KPI）。
 *  响应含后端判定的 today，前端一律用它做「今天」锚点，不再 new Date()。 */
export async function fetchUpcomingDelivery(
  params: FetchUpcomingDeliveryParams,
): Promise<UpcomingBucketsData> {
  const resp = await api.get<UpcomingBucketsData>('/dashboard/upcoming-delivery', {
    params: cleanParams(params),
  });
  return resp.data;
}

/** 2026-10-07：GET /dashboard/delivery-orders 的查询参数。
 *  date / statuses 必填（缺失或非法走 AppError::validation / 40001），basis 缺省 system。
 *  statuses 在 wire 上是逗号分隔单值（后端 axum Query 反序列化为逗号分隔），故本函数
 *  内部把数组 join(',')，调用方只给数组。 */
export interface FetchDeliveryOrdersParams {
  /** 命中的交期日期（'YYYY-MM-DD'），必填。 */
  date: string;
  /** 该柱层覆盖的 OrderStatus 集合，必填（不能为空数组）。 */
  statuses: readonly OrderStatus[];
  /** 交期统计口径：planned（计划交期）/ system（系统交期）。 */
  basis?: DeliveryBasis;
}

/** GET /api/v2/dashboard/delivery-orders —— 柱状图按层下钻的工单明细。
 *  total 是匹配总数、不受 items 截断（200 行）影响。 */
export async function fetchDeliveryOrders(
  params: FetchDeliveryOrdersParams,
): Promise<DeliveryOrderDetailOutData> {
  const resp = await api.get<DeliveryOrderDetailOutData>('/dashboard/delivery-orders', {
    params: cleanParams({ ...params, statuses: params.statuses.join(',') }),
  });
  return resp.data;
}

// ============================================================
// 'auth:session-changed' CustomEvent 监听 → syncWsUrl() → 自动重连 / 关闭
// ============================================================
// 统一 auth 转换事件，取代原先只订阅 'auth:tokens-refreshed' 的做法。
// 派发方共 3 处，覆盖全部 token 生命周期：
//   - api/http.ts    persistTokens()：access token 被刷新
//   - stores/auth.ts loginMutation.onSuccess：登录成功写入新 token
//   - stores/auth.ts teardownSession()：会话终止，detail.token = null → WS 主动断开
//     （logout / forceLogout / refreshOrLogout 失败分支 / auth:logout 事件共 4 条
//      终止路径全部汇入 teardownSession，全文件唯一一处 detail: { token: null }
//      派发。上方「3 处」计数 = 3 个派发点 ⇒ 1 条派发语句，与 CLAUDE.md
//      「auth:session-changed」表一致。）
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
    // 值变化 → 本层 watch(wsUrl, …) 换连接；
    // 变为 undefined → closeConnection() 内 close() 后 _init() 因 url undefined
    // 直接返回，连接关闭。
    syncWsUrl();
  });
}

// ============================================================
// 本层派发的两个 CustomEvent（方向与上面相反）
// ============================================================
// 上面的 'auth:session-changed' 是「本层**听** auth 层说话」；下面两个是
// 「本层**告诉**上层发生了什么」，派发点都在 onDisconnected，各自一处，无 HMR
// 重复注册问题。之所以都绕开直接 import：
//   - 'auth:session-lost' 不 import stores/auth / vue-router（否则 auth ↔ api
//     循环依赖，且 WS 层有分层禁令）；
//   - 'dashboard:full-refetch' 不 import @tanstack/vue-query（api 层引入
//     TanStack Query 依赖是分层倒置）。
// 两者接收方与语义：
//   1. 'auth:session-lost'（4001 re-auth 失败，终止性 —— 本层不再自行删会话）
//      `CustomEvent<{ code: number; reason: string | null }>`，接收方是
//      `src/router/index.ts`，按 reason 三路分流（reason 契约见
//      WS_CLOSE_SESSION_LOST 上方注释）：
//        - `access token expired` → `auth.refreshOrLogout(router)`；成功则
//          `reconnectDashboard()` 恢复长连接，失败则由 refreshOrLogout 内部
//          forceLogout（session 真没了才会失败）；
//        - `auth expired` → `auth.forceLogout(router)` 直接终止；
//        - `null` / 未知 → null 按「可能只是 token 过期」走 refresh 分支，
//          其它非空未知值保守 forceLogout。
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
