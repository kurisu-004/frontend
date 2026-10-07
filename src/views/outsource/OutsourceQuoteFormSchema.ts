// src/views/outsource/OutsourceQuoteFormSchema.ts
//
// 2026-10-09 新增：新建外协报价表单的 Zod schema，替换 `useOutsourceQuoteForm` 里手写的
// `FormRules`（el-form 的 validator 回调）与 `el-form.validate()` 那一跳。形态照
// `views/auth/loginSchema.ts` / `views/parts/new/partEntrySchema.ts`：schema + `z.infer`
// 类型 + 同文件内的 `toFieldErrors` 错误聚合。
//
// 为什么不用 el-form 的 `rules`：
//   el-form 的校验是「组件 ref 上的 Promise + validator 回调」，业务规则（`price > 0`）
//   与提交逻辑分散在两处，且规则无法被单测直接引用 —— 报价单价 > 0 这条约束此前只存在
//   于一个 validator 回调里。Zod 后规则与类型同源，`useOutsourceQuoteForm::onCreate`
//   一句 `safeParse` 就完成「校验 + 错误聚合 + 拿到已 trim 的值」。
//
// 链式顺序：**trim 在 min 之前**（`z.string().trim().min(1)`）—— 反序会让前后全空白的
// 字符串先被 trim 掉再判长度才对的写法必须显式对齐；写成 `.min(1).trim()` 时
// `'   '` 会在 min 处被判「长度 3 ≥ 1」通过、trim 后变空串 ⇒ 建出无名字的报价。
//
// 字段与后端 `OutsourceQuoteCreateRequest` 的对应：
//   part_id / outsource_company_id / process_id / price 四项必填（无 `#[serde(default)]`
//   ⇒ 缺字段是 HTTP 422 纯文本）；note 可空。
//   `price` 收字符串且要求 > 0：后端入参是 `String`（Decimal），前端输入框也是
//   `<el-input type="number">` 交上来的字符串。校验用 `Number()` 换算后比较，但**原样
//   传出**字符串（不转 number / 不补小数位）—— 后端 Decimal 解析自己负责精度。
import type { ZodIssue } from 'zod';
import { z } from 'zod';

export const outsourceQuoteFormSchema = z.object({
  /** 零件雪花 ID 字符串；空串 = 未选。禁止 Number()（19 位雪花 ID 会丢精度）。 */
  part_id: z.string().trim().min(1, '请选择零件'),
  /** 外协公司雪花 ID 字符串（由工序级联加载的候选集里选）。 */
  outsource_company_id: z.string().trim().min(1, '请选择外协公司'),
  /** 外协工序雪花 ID 字符串（picker 无工序线索，一律手选）。 */
  process_id: z.string().trim().min(1, '请选择工序'),
  /**
   * 单价（字符串形态，与 `<el-input type="number">` 的 model 值同形）。
   * 必须 > 0 —— 镜像后端 `OutsourceQuoteCreateRequest.price` 的 Decimal 校验（0 价报价
   * 在可发送列表里永远匹配不上审批价，等于静默沉没）。
   */
  price: z
    .string()
    .trim()
    .min(1, '请填写单价')
    .refine((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0;
    }, '单价必须大于 0'),
  /** 备注；空串归一成 `null`（后端 `Option<String>`，空串与 null 语义相同但不归一
   *  会让列表里出现「备注是一个空格」的行）。 */
  note: z.string().trim(),
});

export type OutsourceQuoteFormInput = z.infer<typeof outsourceQuoteFormSchema>;
export type OutsourceQuoteFieldErrors = Partial<Record<keyof OutsourceQuoteFormInput, string>>;

/** 把 ZodIssue 列表按字段聚合到字段错误表；同字段多 issue 只取第一条。 */
export function toFieldErrors(issues: ZodIssue[]): OutsourceQuoteFieldErrors {
  const out: OutsourceQuoteFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] as keyof OutsourceQuoteFormInput | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
