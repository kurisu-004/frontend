// utils/jwt.ts
//
// 纯解析：base64url 解码 JWT payload（不做签名校验 —— 服务端 enforce）。
// 仅用于 axios 响应拦截器读 exp 字段做 proactive refresh（http.ts:279 / :307）。
//
// 不引入 jwt-decode 等第三方依赖，10 行代码搞定。
//
// 2026-09-23 重构：JwtClaims 收敛到 backend-rust AccessTokenClaims 实际 8 字段；
// 删除 username/roles/shelf_ids/type/ver（业务字段来自 CurrentUser，不走 JWT；
// ver 是 RefreshTokenClaims 的 refresh_version，前端不读 refresh payload）；
// 删除 [k: string]: unknown 索引签名（Rust schema 是闭集，正向安全优先）；
// 删除 tokenExpiresIn 死代码（全仓 0 caller）。

export interface JwtClaims {
  /** 雪花 ID 字符串（与 CurrentUser.id 一致；不丢精度） */
  sub: string;
  /** 接收方；backend-rust 设为本服务标识 */
  aud: string;
  /** 签发时刻（epoch seconds） */
  iat: number;
  /** 生效时刻（epoch seconds） */
  nbf: number;
  /** 过期时刻（epoch seconds）—— http.ts 唯一消费点 */
  exp: number;
  /** 签发方；backend-rust 设为本服务标识 */
  iss: string;
  /** JWT 唯一标识（UUID v4 字符串） */
  jti: string;
  /** token 类型；access token 恒为 'access'（refresh payload 不经此函数） */
  typ: string;
}

/** 解 JWT payload；任何解析失败返回 null（不抛错，避免破坏拦截器主流程）。 */
export function decodeJwt(token: string): JwtClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url → base64
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const decoded = atob(padded + '='.repeat(padLen));
    return JSON.parse(decoded) as JwtClaims;
  } catch {
    return null;
  }
}
