// 扫码找件弹窗的三类写动作的**失败文案收口**（取件 / 接管 / 外协收回）。
//
// 2026-10-15 新增。存在的理由：这三个端点的错误码在 HTTP 层**不统一**（同一批里
// 400 / 404 / 409 / 422 四种都有，而 `40001` 是 HTTP 422 的**纯文本**失败、不进
// `{code,message,data}` 信封），按「业务错一律 400」或「一律走通用 500 提示」处理都会
// 让工人读到一句与真因无关的话。本模块把 `ApiError.code`（**信封业务码**，不是 HTTP
// 状态码）映射成一句人话，缺码回落成 `e.message`。
//
// 为什么按 `ApiError.code` 而不是 HTTP status：`src/api/http.ts` 的响应拦截器对**有
// 信封**的失败统一抛 `new ApiError(code, message)`，`code` 取自信封；只有**无信封**的
// 失败（axum 提取器的 400 / 422 纯文本）才由 axios 路径产生，那两种落到本函数的兜底分支。
//
// 取舍：无码 / 非 `ApiError` 异常一律回落到「原始 message 缺省 fallback」，**不**在这里
// 猜后端语义 —— 本模块的职责是把「已知码」说成人话，不是把「未知码」也编成人话。

import { ApiError } from '@/api/http';

/** 三类写动作的标识（与 `LocateBatchItem.action` 的三个可写取值逐字一致）。 */
export type LocateWriteAction = 'PICK_UP' | 'TAKE_OVER' | 'RECEIVE_FROM_OUTSOURCE';

/** 三条写路径**共有**的失败码 → 人话。
 *
 *  ⚠️ 这张表与下面的 `ACTION_CODE_TEXT` **必须是两张表**：码 `20103` 在接管与外协收回
 *  两条路径上是**两个不同的真因**（前者 = 「位置是 WORKER 却无持有人」的数据异常，后者
 *  = 「状态迁移非法」），写成同一张表里的两个同键字面量时后者会静默覆盖前者。 */
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
  /** 缺 `next_process_id`（链位置推不出下一道且前端没手填）—— HTTP 422 纯文本。 */
  40001: '请选择下一道工序',
  /** 有链但指定的工序不在链内。 */
  20702: '所选工序不在该零件的工序链上，请改选链内工序',
};

/** 各动作**独有**的失败码（原因码在每条路径上只有一个含义）。 */
const ACTION_CODE_TEXT: Readonly<Record<LocateWriteAction, Readonly<Record<number, string>>>> = {
  /** 取件端点的失败码全部落在共有表里（`20702` 链首无活跃 step / `20104` 链首 ∉ 工种 /
   *  容量两条），本域没有自有码。 */
  PICK_UP: {},
  /** 接管：位置是 WORKER 却无持有人 —— 没有对象可接管（数据异常）。 */
  TAKE_OVER: { 20103: '该批次的位置数据异常，无法接管，请联系管理员' },
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
