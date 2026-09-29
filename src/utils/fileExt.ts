// 2026-09-29 新增：解析文件扩展名为 STS grant 端口契约所用的 `ext` 字段。
//
// 背景：后端 STS schema 把 `content_sha256` 升级为 required 64 hex + 新增
// required `ext` 字段（小写字母数字、1-7 字符）。前端在调 grantStsTmpKey*
// 之前必须先按文件名解析出 ext，与 SHA-256 同等作为"完整指纹"派生唯一
// tmp_key —— 2026-09-29 之前仅靠 (purpose, filename, content_sha256) 派生，
// 现加入 ext 后命名冲突概率进一步降低。
//
// 设计要点：
// - 仅取文件名的最后一段「.ext」（不识别路径分隔符；caller 传 File.name 即可，
//   File.name 不含路径）；
// - 大小写归一化为小写（rust `ext` schema 是 lowercase 约束）；
// - 不允许空扩展名 / 点开头 / 含分隔符；
// - 长度 1-7 字符（rust schema `length(min=1, max=7)`）。
// 解析失败 → 抛 Error('invalid ext')，caller 接住后走 ElMessage 错误通道。
//
// 注意：本函数只解 ext，**不**做 MIME / 类型白名单校验——白名单走
// uploadPlan.pickPlan.accept（CosUploader 组件层）。这里仅承担「文件名末段
// → 后端 ext 字段」的字面转换。

/** 从文件名解析扩展名（小写字母数字、1-7 字符）。
 *
 *  @param filename 任意文件名（推荐 File.name，无路径）
 *  @returns 归一化后的小写扩展名（不含前导 `.`）
 *  @throws Error 当文件名不含合法扩展名 / 长度越界
 *
 *  @example
 *  parseFileExt('a.pdf')            // 'pdf'
 *  parseFileExt('part.step')        // 'step'
 *  parseFileExt('no.ext')           // 'ext'
 *  parseFileExt('weird.NAME')       // 'name'
 *  parseFileExt('multi.dot.name')   // 'name'（取最后一段）
 *  parseFileExt('no-dot')           // Error: invalid ext
 *  parseFileExt('.hidden')          // Error: invalid ext
 */
export function parseFileExt(filename: string): string {
  // 取最后一个 '.' 之后到字符串末尾的连续 [a-zA-Z0-9] 段
  // 例如 'part.step' → 'step'；'weird.NAME' → 'NAME'（再 toLowerCase → 'name'）
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename);
  if (!m) {
    throw new Error(`invalid ext: ${filename}`);
  }
  const ext = m[1]!.toLowerCase();
  if (ext.length < 1 || ext.length > 7) {
    throw new Error(`ext too long: ${ext}`);
  }
  return ext;
}
