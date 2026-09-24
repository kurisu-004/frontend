// 2026-09-24 新增：登录表单 Zod schema，与 LoginView.vue 一对一绑定。
// 派生类型 `LoginInput` 用于表单 ref 与 useMutation 入参类型对齐，
// `LoginFieldErrors` 用于单字段错误聚合（Partial<Record<...>>）。
//
// 校验规则：
//   - username：必填 + 去前后空白（前端唯一 trim 入口，避免重输体验被破坏）；
//                长度上限 64，与后端 users.username VARCHAR(64) 对齐；
//   - password：必填 + 不 trim（前后空格密码可能是真实凭据）；
//                长度上限 128，与后端 users.password_hash 入参长度对齐。
//
// 链式顺序：trim 必须在 min 之前，否则前后空字符串绕过 min(1)。
import type { ZodIssue } from 'zod';
import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入账号').max(64, '账号长度不能超过 64 个字符'),
  password: z.string().min(1, '请输入密码').max(128, '密码长度不能超过 128 个字符'),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type LoginFieldErrors = Partial<Record<keyof LoginInput, string>>;

/** 把 ZodIssue 列表按字段聚合到 LoginFieldErrors；同字段多 issue 只取第一条。 */
export function toFieldErrors(issues: ZodIssue[]): LoginFieldErrors {
  const out: LoginFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] as keyof LoginInput | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}