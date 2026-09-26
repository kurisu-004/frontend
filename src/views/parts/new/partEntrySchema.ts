// 2026-09-24 新增：录入 Tab「添加/编辑零件」对话框 Zod schema。
// 与 PartEntryFormDialog.vue + usePartBatchManual.ts 一对一绑定。
//
// 校验规则（DDL 长度对齐 schema_ddl.sql:948 t_part）：
//   - drawingNo  varchar(100) 必填 + trim + max(100)
//   - name       varchar(200) 必填 + trim + max(200)
//   - customerId cascader emitPath:false → 选中的客户 id（Customer.id 雪花字符串）
//                 必填（null/空 → '请选择客户'）。存在性校验依赖动态 customers 列表，
//                 不进 schema，留在 onAddConfirm 业务层写 formErrors.customerId。
//   - applicantName varchar(50) 必填 + trim + max(50)；可能来自 applicantSearch
//                 缓存命中（applicantId 已填），也可能用户手敲需自动新增。
//   - quantity   int 默认 1 必填；int + min(1)。
//   - isUrgent   boolean。
//   - requestDate/plannedDeliveryDate YYYY-MM-DD（el-date-picker value-format）；
//                 用 z.iso.date() 校验格式 + 自定义 error 兜底空值文案。
//   - orderNo    varchar(30) 可空；trim + max(30)；空字符串与 null 等价（caller 端
//                 `value || null` 归一化）。
//   - systemDeliveryDate 可空 date；初始 null，与 el-date-picker clear 行为对齐。
//   - note       varchar(500) 可空；trim + max(500)。
//
// 链式顺序：trim 必须在 min 之前，否则前后空字符串绕过 min(1)。
//
// schema 只覆盖「校验字段」；applicantId / drawingFile / drawingName / drawingUrl /
// drawingBinding 不进 schema —— 这些由图纸上传 / 申请人选择 handler 维护，
// zod 默认 strip 未知键（safeParse 后 result.data 只含 schema 字段）。
//
// 客户存在性校验等依赖动态状态的检查不进 schema（与 auth 范本一致）。
import type { ZodIssue } from 'zod';
import { z } from 'zod';

export const partEntrySchema = z.object({
  drawingNo: z
    .string()
    .trim()
    .min(1, '请输入图号')
    .max(100, '图号长度不能超过 100 个字符'),
  name: z
    .string()
    .trim()
    .min(1, '请输入名称')
    .max(200, '名称长度不能超过 200 个字符'),
  // 2026-09-24：cascader 选中后回填 customerId（string）。空值（含 null）走
  // { error: '请选择客户' } 兜底文案，比 zod 默认「Invalid input: expected string」
  // 友好。v4 中 z.string({ error }) 对 invalid_type 也生效；保留 .min(1) 兜底校验。
  customerId: z
    .string({ error: '请选择客户' })
    .min(1, '请选择客户'),
  applicantName: z
    .string()
    .trim()
    .min(1, '请选择或输入申请人')
    .max(50, '申请人姓名长度不能超过 50 个字符'),
  quantity: z
    .number({ error: '请输入数量' })
    .int('数量必须为整数')
    .min(1, '数量至少为 1'),
  isUrgent: z.boolean(),
  // 2026-09-24：el-date-picker 清空给空字符串 ''（value-format YYYY-MM-DD 时）；
  // 非空时必须是 YYYY-MM-DD。min(1) 拦截空字符串优先，错误信息更明确。
  requestDate: z
    .string({ error: '请选择请购日期' })
    .min(1, '请选择请购日期')
    .regex(/^\d{4}-\d{2}-\d{2}$/, '请购日期格式错误'),
  plannedDeliveryDate: z
    .string({ error: '请选择计划交期' })
    .min(1, '请选择计划交期')
    .regex(/^\d{4}-\d{2}-\d{2}$/, '计划交期格式错误'),
  orderNo: z
    .string()
    .trim()
    .max(30, '订单号长度不能超过 30 个字符')
    .nullable(),
  systemDeliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '系统交期格式错误')
    .nullable(),
  note: z
    .string()
    .trim()
    .max(500, '备注长度不能超过 500 个字符')
    .nullable(),
});

export type PartEntryInput = z.infer<typeof partEntrySchema>;
export type PartEntryFieldErrors = Partial<Record<keyof PartEntryInput, string>>;

/** 把 ZodIssue 列表按字段聚合到 PartEntryFieldErrors；同字段多 issue 只取第一条。 */
export function toFieldErrors(issues: ZodIssue[]): PartEntryFieldErrors {
  const out: PartEntryFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] as keyof PartEntryInput | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
