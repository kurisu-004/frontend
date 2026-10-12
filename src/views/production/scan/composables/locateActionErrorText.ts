// 扫码找件弹窗的三类写动作的**失败文案收口**（取件 / 接管 / 外协收回）。
//
// 2026-10-15 新增。存在的理由：这三个端点的错误码在 HTTP 层**不统一**（同一批里
// 400 / 404 / 409 / 422 四种都有），按「业务错一律 400」或「一律走通用 500 提示」处理都会
// 让工人读到一句与真因无关的话。本模块把 `ApiError.code`（**信封业务码**，不是 HTTP
// 状态码）映射成一句人话，缺码回落成 `e.message`。
//
// ⚠️ **`40001` 是「带信封的 HTTP 422」，走 `ApiError.code` 分流** —— 本模块最容易
// 被后人推错的一条判据，故在此写死：
//   - 后端 `AppError::Validation(_)` 的 `into_response` **一律手工拼 `{code,message,data}`
//     信封**（不走泛型 `R<T>`），HTTP 状态取 `422`；`40001` 正是这条路径出来的
//     ⇒ `src/api/http.ts` 的响应错误拦截器 `isEnvelope` 判定通过 ⇒ 抛
//     `new ApiError(40001, message)` ⇒ 命中下面两张表。`LocateDialog.submitTakeOver`
//     里「吃 `40001` 就降级弹手填框」那条分支正是靠这个事实才可达（它判的
//     就是 `e.code === 40001`），它不是死码。
//   - 真正**无信封**（axum 提取器直接拒、body 是纯文本）的是另两类**入参形态**错误：
//     ① body 里的雪花 id 发成 number（后端 `deserialize_i64` 只解 `String`）；
//     ② `version` 缺省（Json 提取器的必填校验）。这两类在 `api/http.ts` 里走
//     `!isEnvelope` 分支，抛的是 `ApiError(HTTP 状态码 400 / 422, axios 的 message)`
//     ⇒ **code 是 HTTP 状态码、不是业务码** ⇒ 下面两张表都查不到 ⇒ 落 `e.message` /
//     FALLBACK 兜底分支。
//
// 为什么按 `ApiError.code` 而不是 HTTP status：带信封的失败 `code` 取自信封里的业务码
// （`40001` / `20702` / `40901` …），无信封的失败 `code` 退化成 HTTP 状态码。同一批端点
// 里两者混用 ⇒ 只有按 `code` 分流，才能把「缺 `next_process_id`」与「`version` 缺省」
// 讲成两句不同的人话。
//
// 取舍：无码 / 非 `ApiError` 异常一律回落到「原始 message 缺省 fallback」，**不**在这里
// 猜后端语义 —— 本模块的职责是把「已知码」说成人话，不是把「未知码」也编成人话。

import { ApiError } from '@/api/http';

/** 三类写动作的标识（与 `LocateBatchItem.action` 的三个可写取值逐字一致）。 */
export type LocateWriteAction = 'PICK_UP' | 'TAKE_OVER' | 'RECEIVE_FROM_OUTSOURCE';

/** 三条写路径**共有**的失败码 → 人话。
 *
 *  ⚠️ 这张表与下面的 `ACTION_CODE_TEXT` **必须是两张表**：同一个码在不同动作上是不同
 *  真因时，合成一张表会**静默覆盖**。已拆开的两处：
 *   - `20103` —— 接管是「位置是 WORKER 却无持有人」（数据异常），外协收回是「状态迁移
 *     非法」；
 *   - `20104` —— 接管的真因之一是「批次已在你手上，无需接管」（工人根本没选过工序），
 *     而本表这句「所选工序不在你的工种范围内」在这条路径上会把人指到完全无关的方向；
 *     接管的文案见 `ACTION_CODE_TEXT.TAKE_OVER`。 */
const SHARED_CODE_TEXT: Readonly<Record<number, string>> = {
  /** 工牌码反查不到工人。 */
  20201: '工牌未识别，请重新扫码确认工牌',
  /** 工人在库但已停用。 */
  20202: '该工牌已停用，无法操作',
  /** 工人未绑定工种（`work_type_id` 为空）。 */
  20206: '你的工牌未分配工种，请联系管理员指派后再操作',
  /** 批次不存在 / 已软删。 */
  20109: '该批次已不存在，请重新扫码',
  /** 工单不存在 / 已软删。 */
  20101: '该零件不存在或已删除',
  /** OCC 版本冲突：批次已被别人处置过。 */
  40901: '这批已被他人处理，请重新扫码',
  /** 工序不在该工种的活跃映射里（含取件端点 PENDING 链首 ∉ 工种）。 */
  20104: '所选工序不在你的工种范围内，请改选其他工序',
  /** 工种未配 `max_held_batches`。 */
  20904: '你的工种未配置持有上限，请联系管理员配置后再领取',
  /** 容量触顶：已达 `max_held_batches`。 */
  20204: '你手上已达持有上限，请先放回已完成的件',
  /** 缺 `next_process_id`（链位置推不出下一道且前端没手填）—— HTTP 422，**带信封**
   *  （后端 `AppError::Validation`）⇒ 走 `ApiError.code` 分流，见文件头。 */
  40001: '请选择下一道工序',
  /** 有链但指定的工序不在链内。 */
  20702: '所选工序不在该零件的工序链上，请改选链内工序',
};

/** 各动作**独有**的失败码（原因码在每条路径上只有一个含义）。 */
const ACTION_CODE_TEXT: Readonly<Record<LocateWriteAction, Readonly<Record<number, string>>>> = {
  /** 取件端点的失败码全部落在共有表里（`20702` 链首无活跃 step / `20104` 链首 ∉ 工种 /
   *  容量两条），本域没有自有码。 */
  PICK_UP: {},
  /**
   * 接管：`20103` 位置数据异常；`20104` 在这条路径上**有两个真因** ——
   * 「批次已在你手上，无需接管」（持有人是我自己）与「接管目标工序不在你的工种范围内」。
   * 两者都可能发生在工人**根本没选过工序**的那条链上（前者）与选过的那条链上（后者），
   * 故文案取两条真因的并集、刻意不预设「所选工序」。
   */
  TAKE_OVER: {
    20103: '该批次的位置数据异常，无法接管，请联系管理员',
    20104: '接管未完成：这批可能已不在别人手上，或接管后的工序不在你的工种范围内',
  },
  /** 外协收回：状态迁移非法 / 外协归属数据异常 / 链推不出下一道 / 无可用生产架。 */
  RECEIVE_FROM_OUTSOURCE: {
    20103: '该批次当前状态不能执行收回，请重新扫码确认',
    20122: '该批次的外协归属数据异常，无法收回，请联系管理员',
    20706: '该零件的工序链推不出下一道，请手工选择工序',
    20508: '该工序当前没有可用的生产架，无法收回，请稍后再试或联系管理员',
  },
};

/** `disabled_reason`（`locate` 行的 9 个 wire 字面量）→ 给人看的指引。
 *
 *  逐条对应后端决策表的分组：状态类（后端一个按钮都给不出）／资格类（工种与工序映射）／
 *  容量类。`UNKNOWN` 是保守出口 —— 后端出现它说明有状态 / 位置组合没被决策表覆盖，
 *  前端不给具体指引、只请人找管理员，避免编一个错的说法。 */
export const LOCATE_DISABLED_REASON_TEXT: Readonly<Record<string, string>> = {
  PROGRAMMING: '该件待编程，请先找 CNC 编程员编程',
  INSPECTION: '该件在品检区，请找品检员处理',
  TERMINAL: '该批次已完结（终态），无可执行操作',
  WORK_TYPE_NOT_SET: '你的工牌未分配工种，无法领取或转手，请联系管理员指派工种',
  PROCESS_NOT_IN_WORK_TYPE: '这道工序不在你的工种范围内，无法由你执行',
  PROCESS_CHAIN_STEP_NOT_FOUND: '该零件的工序链里没有可用工序，无法继续流转',
  WORKER_HOLD_LIMIT_EXCEEDED: '你手上已达工种持有上限，请先放回已完成的件',
  WORK_TYPE_MAX_HELD_NOT_SET: '你的工种未配置持有上限，暂不能领取新件',
  UNKNOWN: '该批次状态暂不支持自助操作，请联系管理员或品检员',
};

/** `action === null` 时行内展示的指引文案；未知 / 缺失 reason 也落到保守档。 */
export function locateDisabledReasonText(reason: string | null | undefined): string {
  if (!reason) return LOCATE_DISABLED_REASON_TEXT.UNKNOWN!;
  return LOCATE_DISABLED_REASON_TEXT[reason] ?? LOCATE_DISABLED_REASON_TEXT.UNKNOWN!;
}

/** 三个写动作各自的兜底文案（无已知码、也读不出 message 时用）。 */
const FALLBACK: Readonly<Record<LocateWriteAction, string>> = {
  PICK_UP: '领取失败，请重试或联系管理员',
  TAKE_OVER: '接管失败，请重试或联系管理员',
  RECEIVE_FROM_OUTSOURCE: '收回失败，请重试或联系管理员',
};

/**
 * 把写动作抛出的异常转成可直接 `ElMessage.error` 的文案。
 *
 * @param e        mutation 抛出的异常（`ApiError` / 普通 Error / 未知值）
 * @param action   这次点的按钮（取件 / 接管 / 外协收回），只影响无码时的兜底文案
 */
export function locateWriteErrorText(e: unknown, action: LocateWriteAction): string {
  if (e instanceof ApiError) {
    const own = ACTION_CODE_TEXT[action][e.code];
    if (own) return own;
    const shared = SHARED_CODE_TEXT[e.code];
    if (shared) return shared;
  }
  const msg = e instanceof Error ? e.message : '';
  return msg || FALLBACK[action];
}
