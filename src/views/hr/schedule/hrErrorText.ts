// src/views/hr/schedule/hrErrorText.ts
//
// 2026-10-19 新建：人事排班域的**文案收口**，两个消费方共用 —— 读端点的 error 桥接
// （`composables/useScheduleQueries.ts`）与页面级 store 的统一写错误入口
// （`composables/useScheduleStore.ts::handleWriteError`）。形态照
// `views/wecom/webhooks/weComWebhookErrorText.ts`：
//
//   - 本文件是**域内口吻**：21901–21909 九个业务码各配一句「用户该做什么」的话；
//   - 机制（识别 ZodError + console.error + fallback）是跨域的，收在
//     `src/utils/contractDriftError.ts`。
//
// ⚠️ **裸码值只许出现在本文件与 `__tests__` 里**（单测钉死映射表，它就是要让「码值变了」
//   红起来的那一处）。视图与 store 一律引 `HR_SCHEDULE_ERROR_CODES` 的具名常量。
//
// ⚠️ **40901（OCC 冲突）也在表里但不走本函数的默认分支**：store 的 `handleWriteError` 单独
//   分支 —— 它是 warning 而非 error，且必须顺带重拉列表（照 `useWeComWebhooksStore` 的同款
//   处置）。表里这一条只服务「别的调用方直接问本函数」的场景。

import { contractDriftErrorText } from '@/utils/contractDriftError';

/** 契约漂移时给管理员看的固定文案：不含 Zod 的 issues 结构，细节只进 console。 */
export const HR_SCHEDULE_CONTRACT_DRIFT_TEXT = '服务端返回的数据格式不符合预期，请联系管理员';

/** 2026-10-19 冻结的错误码（后端 hr 域），**全仓前端唯一一处码值来源**。 */
export const HR_SCHEDULE_ERROR_CODES = {
  /** 班次不存在或已软删。 */
  SHIFT_NOT_FOUND: 21901,
  /** 班次编码重复。 */
  SHIFT_CODE_DUPLICATED: 21902,
  /** 时段格式非法 / 零长段 / 乱序 / 重叠 / 首段 ≥ 24:00 / 超 48:00 / 空数组 / 超 6 段。 */
  SHIFT_SEGMENT_INVALID: 21903,
  /** `from > to` 或跨度 > 366 天。 */
  CALENDAR_RANGE_INVALID: 21904,
  /** 未知日型。 */
  DAY_TYPE_INVALID: 21905,
  /** 班次已停用（重复停用，或往停用班次写覆盖行）。 */
  SHIFT_INACTIVE: 21906,
  /** `CUSTOM_LEAVE` 未填名称。 */
  CALENDAR_LEAVE_NAME_REQUIRED: 21907,
  /** 班次总跨度 > 24:00。 */
  SHIFT_SPAN_EXCEEDS_DAY: 21908,
  /** 必填项 trim 后为空白，或某字段超 `varchar` 列宽（2026-10-19 后端新增；守卫细节与列宽表见
   *  `docs/api/hr.md` §5.7）。⚠️ **当前 UI 走不到**：班次表单按 `.trim().min(1)` 与三条长度
   *  上限守着，日历名称输入框的 `maxlength`（30）又远小于后端列宽（50）⇒ 空白与超长都在提交
   *  之前就被卡住。它今天是「这一码真落下来时给用户一句人话」的兜底，不是死条目；跨仓集合对账
   *  （`hrContractShape.spec.ts::H8`）保证后端再加码时前端不会漏。 */
  FIELD_INVALID: 21909,
  /** OCC 版本冲突（**通用段非本域专有**）。 */
  VERSION_CONFLICT: 40901,
} as const;

/** 业务码 → 人话。⚠️ 后端 message 是给日志看的，「操作失败：xxx」对操作员没有指导性。 */
export const HR_SCHEDULE_ERROR_TEXT: Partial<Record<number, string>> = {
  [HR_SCHEDULE_ERROR_CODES.SHIFT_NOT_FOUND]: '班次不存在或已删除，请刷新后重试',
  [HR_SCHEDULE_ERROR_CODES.SHIFT_CODE_DUPLICATED]: '班次编码重复，请换一个编码',
  [HR_SCHEDULE_ERROR_CODES.SHIFT_SEGMENT_INVALID]:
    '时段不合法：需 1–6 段、起点早于 24:00、终点不超 48:00、按时序排列且不重叠',
  [HR_SCHEDULE_ERROR_CODES.CALENDAR_RANGE_INVALID]:
    '日期区间不合法：起始日不能晚于结束日，且跨度不能超过 366 天',
  [HR_SCHEDULE_ERROR_CODES.DAY_TYPE_INVALID]: '未知日型，请重新选择',
  [HR_SCHEDULE_ERROR_CODES.SHIFT_INACTIVE]: '班次已停用，请先启用或换一个班次',
  [HR_SCHEDULE_ERROR_CODES.CALENDAR_LEAVE_NAME_REQUIRED]: '自定义休息日必须填写名称',
  [HR_SCHEDULE_ERROR_CODES.SHIFT_SPAN_EXCEEDS_DAY]: '班次跨度超过 24 小时，与相邻工作日会冲突',
  [HR_SCHEDULE_ERROR_CODES.FIELD_INVALID]:
    '有必填项留空或内容超长（只打空格按留空算）：请检查编码、名称、颜色与备注的长度',
  [HR_SCHEDULE_ERROR_CODES.VERSION_CONFLICT]: '配置已被他人修改，请刷新后重试',
};

/**
 * 把本域请求抛出的异常转成可直接展示的文案（供 `ElMessage` toast）。
 *
 * 分流顺序：
 *   1. 命中业务码表 ⇒ 返表里的人话；
 *   2. 其余异常交给 `contractDriftErrorText`（ZodError ⇒ 固定文案 + console.error 原始
 *      issues；普通 Error ⇒ `e.message`，缺 message 时回落到 `fallback`）。
 */
export function hrErrorText(e: unknown, fallback: string): string {
  const code = (e as { code?: number } | null | undefined)?.code;
  if (typeof code === 'number') {
    const mapped = HR_SCHEDULE_ERROR_TEXT[code];
    if (mapped) return mapped;
  }
  return contractDriftErrorText(e, {
    driftText: HR_SCHEDULE_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[hr] 排班日历响应未通过 Zod 契约守门',
  });
}
