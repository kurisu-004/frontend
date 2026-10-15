// src/views/hr/schedule/hrScheduleSchema.ts
//
// 2026-10-19 新建：人事排班域的 Zod schema，与两个 query hook 同居（CLAUDE.md「域 schema 与
// query hook 同居」），两组用途（形态照 `views/wecom/webhooks/weComWebhookSchema.ts`）：
//
//   1. **守门**：三条读端点的行 VO 与 `{items:[...]}` 信封。**刻意放在域内而不是
//      `src/composables/queries/schemas.ts`** —— 那个仓级文件装的是跨域共享的通用形状，
//      本域的日型枚举、派生字段（`cross_day` / `overflow_minutes` / `is_workday`）与段值
//      语义只在本域有意义，塞进共享文件会让它反向依赖 `@/types/hr`。
//   2. **表单校验**：`shiftFormSchema` —— 班次新增 / 编辑弹窗的前置校验，把后端
//      21903（时段非法）/ 21908（跨度 > 24:00）提前到浏览器，并给出聚焦到具体字段的提示。
//
// ⚠️ **写端点的回显不做 Zod 守门**（与 wecom 域的取舍不同，那边建档/改档的返回行要在 api 层
//   parse）：本域七条写端点里只有建 / 改 / 停用班次三条有行出参，而 store **一行都不消费**
//   ——它只用 `mutateAsync` 的 resolve / reject 表示成败，随后 `invalidate` 让读端点重新取。
//   为一个不读的字段再 parse 一遍（parse 返回深拷贝）纯属白干，所以这三条的出参只在
//   `api/hr.contract.ts` 有类型标注、不过 Zod。
//
// wire 约定：
//   - **雪花 ID 一律 JSON string**（`id: z.string()`，19 位 ID 在 JS Number 下丢精度）；
//   - **version / 计数 / 分钟数一律 JSON number**；
//   - 段值的 `HH ∈ 0..48` **不在这里校验**：那是「值域」问题，由 `utils/absTime.ts` 的
//     V1–V6 镜像一次性管（表单校验里以 `superRefine` 调它）。本文件只守**形状**（是
//     `HH:MM` 串、seq 是整数），两层职责不重叠。
//   - `.strict()`：后端给本域加派生字段时会被这里挡住、需要显式决策，而不是被 Zod 默认的
//     strip 静默吞掉。

import { z } from 'zod';
import { HR_DAY_TYPES } from '@/types/hr';
import { validateSegments } from './utils/absTime';

/** 日型枚举的守门形态（真源仍是 `@/types/hr` 的 `HR_DAY_TYPES`，两处不各写一份）。 */
const hrDayTypeSchema = z.enum(HR_DAY_TYPES);

// ============================================================
// GET /api/v2/hr/calendar/days
// ============================================================

/** 全局日历日行（`CalendarDayOut`）。 */
export const hrCalendarDaySchema = z
  .object({
    cal_date: z.string(),
    day_type: hrDayTypeSchema,
    /** 节假日名。`CUSTOM_LEAVE` 必填非空，其余档可空。 */
    name: z.string().nullable(),
    /** 推导标记：true = 无显式行、按星期兜底。渲染据此弱化，编辑器据此禁用「恢复默认」。 */
    derived: z.boolean(),
  })
  .strict();

export type HrCalendarDayData = z.infer<typeof hrCalendarDaySchema>;

/** `GET /hr/calendar/days` 的信封 `{items:[...]}`。⚠️ **不是裸数组** —— queryFn 里 parse
 *  完必须再取 `.items`，否则每一屏都在 `.map` 上炸（症状：列表恒空 + 控制台
 *  `.map is not a function`）。 */
export const hrCalendarDaysResultSchema = z
  .object({ items: z.array(hrCalendarDaySchema) })
  .strict();

// ============================================================
// GET /api/v2/hr/shifts、POST /api/v2/hr/shifts[/{id}[/deactivate]]
// ============================================================

/** 班次时段（入参与出参同形，见 `types/hr.ts::ShiftSegmentOut`）。 */
const shiftSegmentSchema = z
  .object({
    /** 从 1 起、连续递增（后端据此判乱序）。 */
    seq: z.number(),
    /** `'HH:MM'`，绝对时钟轴（`HH ∈ 0..48`）。形状守门，值域由 `validateSegments` 管。 */
    start: z.string(),
    end: z.string(),
  })
  .strict();

/** 班次行（`ShiftOut`）。⚠️ `overflow_minutes` 是**分钟**不是小时（段值允许带分钟）。 */
export const hrShiftSchema = z
  .object({
    id: z.string(),
    version: z.number(),
    code: z.string(),
    name: z.string(),
    /** 可空 = 走页面默认色。 */
    color: z.string().nullable(),
    segments: z.array(shiftSegmentSchema),
    is_active: z.boolean(),
    sort_order: z.number(),
    remark: z.string().nullable(),
    /** 派生：任一段 `end > '24:00'`。 */
    cross_day: z.boolean(),
    /** 派生：`max(end) - 24:00` 的分钟数。 */
    overflow_minutes: z.number(),
    /** 派生：`Σ(end - start)` 的分钟数（跨天段按绝对差算）。 */
    daily_minutes: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type HrShiftData = z.infer<typeof hrShiftSchema>;

/** `GET /hr/shifts` 的信封。 */
export const hrShiftListResultSchema = z.object({ items: z.array(hrShiftSchema) }).strict();

// ============================================================
// GET /api/v2/hr/shifts/{id}/calendar
// ============================================================

/** 班次日历行（`ShiftCalendarDayOut`）。 */
export const hrShiftCalendarDaySchema = z
  .object({
    cal_date: z.string(),
    /** 全局日历推导出来的日型（未叠加本班次覆盖）。 */
    global_day_type: hrDayTypeSchema,
    /** 叠加覆盖后的最终日型（渲染与判定都读它）。 */
    effective_day_type: hrDayTypeSchema,
    /** 最终日型是否算上班（后端已算好，前端不重复判）。 */
    is_workday: z.boolean(),
    /** 该天是否有本班次的覆盖行。 */
    is_override: z.boolean(),
  })
  .strict();

export type HrShiftCalendarDayData = z.infer<typeof hrShiftCalendarDaySchema>;

/** `GET /hr/shifts/{id}/calendar` 的信封。 */
export const hrShiftCalendarResultSchema = z
  .object({ items: z.array(hrShiftCalendarDaySchema) })
  .strict();

// ============================================================
// 班次表单（新增 / 编辑弹窗共用）
// ============================================================

/**
 * 控件侧的长度上限。
 *
 * ⚠️ **这是前端兜底上限、不是后端约束的复刻**：后端对本域三个短文本列只判空 / 唯一、没给
 *   长度上限。这些值取「够用且防止超长串进请求体」的量级；真收到更长的合法数据时是
 *   **编辑框显示截断但原值仍随 `modelValue` 提交**（所以它们只绑 `maxlength` 这个输入期
 *   闸门，不参与 `parse` 的拒绝）。想收紧改这里一处。
 */
export const HR_SHIFT_CODE_MAX = 32;
export const HR_SHIFT_NAME_MAX = 50;
export const HR_SHIFT_REMARK_MAX = 200;

/** 班次色的形态（`#rrggbb`）。空串 / null 一律归一成 null（走页面默认色）。 */
export const HR_SHIFT_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** 表单模型。`color` / `remark` 用 `null` 而不是空串表达「清空」——
 *  与后端「显式 `null` = 清空可空列」一一对应。 */
export interface ShiftFormModel {
  code: string;
  name: string;
  color: string | null;
  segments: z.infer<typeof shiftSegmentSchema>[];
  sort_order: number;
  remark: string | null;
}

export type ShiftFormField = 'code' | 'name' | 'color' | 'segments' | 'sort_order' | 'remark';

export type ShiftFormFieldErrors = Partial<Record<ShiftFormField, string>>;

/** 新建时的初值。⚠️ `segments` 给一条默认白班（`08:00~12:00` + `13:00~17:00`）：弹窗刚打开
 *  时刻轴是空的，用户看不到「时段」到底长什么样，而时段又是本域最容易填错的一项。 */
export function initialShiftForm(): ShiftFormModel {
  return {
    code: '',
    name: '',
    color: null,
    segments: [
      { seq: 1, start: '08:00', end: '12:00' },
      { seq: 2, start: '13:00', end: '17:00' },
    ],
    sort_order: 0,
    remark: null,
  };
}

/**
 * 班次表单校验（新增与编辑**同款**：两个模式的请求体字段集一样，差别只在「哪些键要发」，
 * 由 store 的 `submit` 处理，不是校验问题）。
 *
 * `segments` 上挂 `superRefine` 调 `validateSegments`（V1–V6 镜像）：把 21903 / 21908 的
 *  拒绝提前到浏览器，并在 `segments` 字段上给出**一条**聚合红字（时段问题往往牵连多段，
 *  逐段拆成多个字段位反而不像人话）。
 */
export const shiftFormSchema = z.object({
  // 链式顺序 **trim 在前**：el-input 的前后空格必须在长度校验之前归一。
  code: z
    .string()
    .trim()
    .min(1, '请填写班次编码')
    .max(HR_SHIFT_CODE_MAX, `编码长度不能超过 ${HR_SHIFT_CODE_MAX} 个字符`),
  name: z
    .string()
    .trim()
    .min(1, '请填写班次名称')
    .max(HR_SHIFT_NAME_MAX, `名称长度不能超过 ${HR_SHIFT_NAME_MAX} 个字符`),
  // preprocess 兜住 el-color-picker 清空时的 null/undefined（归一成 null = 用默认色）。
  color: z.preprocess(
    (v) => (v === null || v === undefined || v === '' ? null : v),
    z
      .string()
      .refine((v) => HR_SHIFT_COLOR_RE.test(v), '颜色格式应为 #rrggbb，或留空用默认色')
      .nullable(),
  ),
  segments: z
    .array(shiftSegmentSchema)
    .min(1, '至少需要 1 个时段')
    .superRefine((segs, ctx) => {
      const res = validateSegments(segs);
      for (const message of res.errors) {
        ctx.addIssue({ code: 'custom', message });
      }
    }),
  sort_order: z
    .number({ error: '排序权重必须是数字' })
    .int('排序权重必须是整数')
    .min(0, '排序权重不能为负')
    .max(9999, '排序权重不能超过 9999'),
  remark: z.preprocess(
    (v) => (v === null || v === undefined ? null : String(v)),
    z
      .string()
      .trim()
      .max(HR_SHIFT_REMARK_MAX, `备注长度不能超过 ${HR_SHIFT_REMARK_MAX} 个字符`)
      .nullable(),
  ),
});

/** 把 ZodIssue 列表按字段聚合到字段错误表；同字段多 issue 只取第一条。 */
export function toShiftFieldErrors(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): ShiftFormFieldErrors {
  const out: ShiftFormFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] as ShiftFormField | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
