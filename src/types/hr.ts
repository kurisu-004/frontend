// 人事（hr）域的**入参侧** wire 类型与日型枚举（2026-10-19 新增）。
//
// 分层口径：出参侧的 wire 契约（行 VO + 信封）在 `src/api/hr.contract.ts`（types only、
// 零 runtime），本文件只放**请求体 / 查询参数**与**日型枚举**——枚举带 runtime 值
// （const 数组 + META 表），视图层与守门 schema 都要引它，故不放进只放 types 的
// contract 文件。出参类型从 `api/hr.ts` 标注返回类型时直接引 contract，两侧不互相抄。
//
// ⚠️ **零 PUT / PATCH / DELETE**：本仓后端全站只允许 GET / POST。改档走
// `POST /hr/shifts/{id}`、停用走 `POST /hr/shifts/{id}/deactivate`、删日历行走
// `POST /hr/calendar/days/delete`（独立 action 路径而非 HTTP 动词，理由同 wecom 的软删）。
//
// ⚠️ **本域零绑定**：本期只做「日历表 + 班次表」配置，**不做班次与实际工人的绑定**。

/** 2026-10-19 新增：6 档日型的**唯一真源**（后端 `HrDayType` 枚举原文）。
 *
 *  收成 const 数组而不是散落的联合类型字面量，是为了让守门 schema（`z.enum`）
 *  与 TS 类型同源——两处各写一遍，将来只改一处。
 *
 *  语义逐档：
 *  - `WORKDAY` 正常工作日；
 *  - `MAKEUP_WORKDAY` 调休上班（周末 / 节假日期间的补班日）；
 *  - `REST_DAY` 正常周末（**按星期推导兜底**的默认日型，不落显式行也是它）；
 *  - `STATUTORY_HOLIDAY` 法定节假日；
 *  - `MAKEUP_HOLIDAY` 调休放假（为补班而挪出来的休息日）；
 *  - `CUSTOM_LEAVE` 自定义休息日，**必填 `name`**（缺名后端拒 21907）。 */
export const HR_DAY_TYPES = [
  'WORKDAY',
  'MAKEUP_WORKDAY',
  'REST_DAY',
  'STATUTORY_HOLIDAY',
  'MAKEUP_HOLIDAY',
  'CUSTOM_LEAVE',
] as const;

export type HrDayType = (typeof HR_DAY_TYPES)[number];

/** 2026-10-19 新增：日型 → 中文标签 / 色板 key / 是否工作日。**三档职责不可合并**：
 *  - `label` 是图例、单元格标题、弹层下拉的文案源；
 *  - `colorKey` 是**色板键**（`'workday'` / `'rest'` / …），具体颜色映射在页面样式里
 *    （本仓主题色藏青 `#1e4d8b` / 蓝 `#2c6cb8` / 浅蓝 `#4a8fd6` 定义在
 *    `src/styles/variables.scss` 的 `:root`）——**types 层不放颜色字面量**，那会让纯类型
 *    文件反向依赖样式口径；
 *  - `isWorkday` 是**前端本地判定**（拖选浮条与图例渲染都要用，见下方 `isHrWorkday`）。 */
export const HR_DAY_TYPE_META: Record<
  HrDayType,
  { label: string; colorKey: string; isWorkday: boolean }
> = {
  WORKDAY: { label: '工作日', colorKey: 'workday', isWorkday: true },
  MAKEUP_WORKDAY: { label: '调休上班', colorKey: 'makeup-work', isWorkday: true },
  REST_DAY: { label: '休息日', colorKey: 'rest', isWorkday: false },
  STATUTORY_HOLIDAY: { label: '法定节假日', colorKey: 'holiday', isWorkday: false },
  MAKEUP_HOLIDAY: { label: '调休放假', colorKey: 'makeup-rest', isWorkday: false },
  CUSTOM_LEAVE: { label: '自定义休息', colorKey: 'custom', isWorkday: false },
};

/** 2026-10-19 新增：算作「上班」的 2 档日型（`WORKDAY` / `MAKEUP_WORKDAY`）。
 *  与后端 `is_workday` 判定**同源**，两处改一处即可，别各判一遍。 */
export const HR_WORKDAY_DAY_TYPES: readonly HrDayType[] = ['WORKDAY', 'MAKEUP_WORKDAY'];

/** 该日型是否算上班（拖选浮条的判定、图例分组的判定都用它）。
 *
 *  ⚠️ **前端必须保留这一份本地判定**，不能只读出参的 `is_workday`：拖选浮条在**请求发出前**
 *  就要判断当天能不能上班（那时还没有任何后端数据），图例渲染同理。两者同源，因此不会打架。 */
export function isHrWorkday(dayType: HrDayType): boolean {
  return HR_DAY_TYPE_META[dayType].isWorkday;
}

/** 2026-10-19 新增：班次的一个时段。**同一形态既是入参也是出参**（请求的 `segments` 与
 *  响应的 `ShiftOut.segments` 同形），故命名沿用出参侧。
 *
 *  ⚠️ **段值是 `cal_date 00:00` 起算的绝对时钟轴**，`HH ∈ 0..48`（分钟 `MM` ∈ 0..59）：
 *    - 夜班 22:00 → 次日 02:00 = `{ start: '22:00', end: '26:00' }`；
 *    - 24h 连做 = `{ start: '08:00', end: '32:00' }`。
 *  由此**「跨天班次的日期归属 = 工作开始时间所在日」由数据结构本身保证**，前端**不做任何
 *  跨天推断**（不要按 `end` 反推归属日，也不要在这里做「end < start ⇒ +1 天」的处理）。
 *  末段 `end > '24:00'` 即跨天，后端另给 `cross_day` / `overflow_minutes` 两个派生字段。 */
export interface ShiftSegmentOut {
  /** 段序号，从 1 起、连续递增（后端据此判乱序，重叠判据是按 seq 排完再比相邻区间）。 */
  seq: number;
  /** 段起点，`'HH:MM'`，`HH ∈ 0..48`。 */
  start: string;
  /** 段终点，`'HH:MM'`，`HH ∈ 0..48`。**大于 `start`**（零长段后端拒 21903）。 */
  end: string;
}

/** `POST /hr/shifts` 请求体（建班次）。全量给定，无 OCC 字段。 */
export interface CreateShiftPayload {
  /** 班次编码（唯一，重复后端拒 21902）。 */
  code: string;
  /** 班次名称。 */
  name: string;
  /** 班次色（`#rrggbb` 语义），可空 = 走页面默认色。 */
  color?: string | null;
  /** 时段列表，1..6 段（超段数后端拒 21903）。 */
  segments: ShiftSegmentOut[];
  /** 排序权重，页面按它排班次栏。 */
  sort_order?: number;
  /** 备注。 */
  remark?: string | null;
}

/** `POST /hr/shifts/{id}` 请求体（改档，**全量覆写**，不是 PATCH）。
 *
 *  ⚠️ `version` **必填**（OCC 锚，取该行当前的 `version`；缺省是 axum 的 HTTP 422 纯文本，
 *  连业务码都拿不到）。
 *
 *  ⚠️ `code` / `name` / `color` 可选是**后端显式契约**：缺省键 = 「不改这一列」，而**显式传
 *  `null`** 才是「把可空列清空」（`color` / `remark`）。所以前端表单提交时要区分
 *  「字段没动」与「用户显式清空」，不要统一传 `null`。 */
export interface UpdateShiftPayload {
  version: number;
  code?: string;
  name?: string;
  color?: string | null;
  segments?: ShiftSegmentOut[];
  sort_order?: number;
  remark?: string | null;
}

/** `POST /hr/shifts/{id}/deactivate` 请求体（停用，非物理删）。`version` 必填（同上）。 */
export interface ShiftDeactivatePayload {
  version: number;
}

/** `GET /hr/shifts` 查询参数。 */
export interface ListHrShiftsParams {
  /** 是否连**已停用**班次一起返（缺省 = 只返启用的）。停用是软删：行还在库里，
   *  只是不再出现在新建考勤的选择项里。 */
  include_inactive?: boolean;
}

/** 日历行写入项（`POST /hr/calendar/days` 的 `items[]` 元素）。 */
export interface HrCalendarDayInput {
  /** 日历日，`'YYYY-MM-DD'`。 */
  cal_date: string;
  day_type: HrDayType;
  /** 节假日名。**`CUSTOM_LEAVE` 必填**（缺名后端拒 21907），其余档可空。 */
  name?: string | null;
}

/** 班次日历行写入项（`POST /hr/shifts/{id}/calendar/days` 的 `items[]` 元素）。
 *  与全局日历的差别只有备注列：本域行带 `remark`，全局日历行带 `name`。 */
export interface HrShiftCalendarDayInput {
  cal_date: string;
  day_type: HrDayType;
  remark?: string | null;
}

/** 删日历行的请求体（全局 / 班次两条 delete 端点同形）。
 *  两种删除口径：按 `dates` 点删若干天，或按 `from`/`to` 删整个区间。
 *
 *  ⚠️ 区间口径受后端区间约束：`from <= to` 且跨度 ≤ 366 天（越界 21904）——**前端也要照此
 *  夹紧**，别把用户随手拉出来的三年区间直接发出去。 */
export interface HrCalendarDaysDeletePayload {
  /** 点删清单（与 `from`/`to` 二选一或并用，后端按两者并集处理）。 */
  dates?: string[];
  from?: string;
  to?: string;
}

/** 区间型日历查询参数（`GET /hr/calendar/days` 与 `GET /hr/shifts/{id}/calendar` 共用）。
 *  两个键**必填**，且受后端区间约束（`from <= to` 且跨度 ≤ 366 天，越界 21904）——
 *  月历翻页时前端自己夹紧，别让越界区间发出去。 */
export interface HrCalendarRangeQuery {
  from: string;
  to: string;
}
