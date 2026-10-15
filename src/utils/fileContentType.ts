// utils/fileContentType.ts —— 上传 `content_type` 归一（2026-10-15 新增）
//
// 2026-10-15：从 `api/files/objects.ts` 搬出来。搬家的原因是**签发时机**变了 ——
// 旧链路里 content_type 只在构造 multipart 段时用得到（随 `File` 一起发给后端，由
// 后端按 policy 判），新链路里它必须在**调 upload-intents 之前**算好：它会被签进
// SigV4 的 SignedHeaders，PUT 时必须原样回填。放在 api 层会诱使后来者「等要发请求了
// 再去 api 层找这个函数」，而它其实是所有调用方在拼 intent 入参时都要用的纯函数。
//
// 归一口径按**扩展名**分两档，与后端的 `expected_content_types_for_ext` 白名单同源：
//   `.pdf` → `application/pdf`；其余（step / stp / iges / igs / stl / obj / 3mf /
//   dwg / dxf / nc / tap …）→ `application/octet-stream`。
//
// ⚠️ **不能直接用 `file.type`**：.step / .stp / .igs 在多数浏览器上是空串或怪值
// （部分环境给 .igs 报 text/plain），照抄会被后端 policy 挡回 40001；而且直传链路里
// 一个错的 content_type 还会顺带把签名作废（403），比 40001 更难查。
//
// ⚠️ **新增扩展名必须同时改三处，缺一即被拒**：本函数的两档映射、后端
// `part_file::policy::allowed_exts`（kind → 允许的扩展名）、后端
// `part_file::policy::expected_content_types_for_ext`（扩展名 → 允许的
// content_type）。本函数是**按扩展名分两档**而不是逐个映射，所以图片类扩展名
// （png / jpg / heic …）会落进 `application/octet-stream` 分支 —— 后端一旦放开
// 图片图纸（当前 `allowed_exts("DRAWING")` **只有 `["pdf"]`**）而没有同时在
// `expected_content_types_for_ext` 里放行该扩展名的 `application/octet-stream`，
// 上传就会被 40001 挡回。

/** PDF 的 content_type：后端对 `.pdf` 只接受这一种。 */
export const PDF_CONTENT_TYPE = 'application/pdf';
/** 非 PDF（3D 模型 / CAD 源文件 / G 代码）的 content_type：统一接受这一种二进制流。 */
export const BINARY_CONTENT_TYPE = 'application/octet-stream';

/**
 * 上传 `content_type` 归一：按**扩展名**分两档。
 *
 * 用在**调 upload-intents 之前**（它会被签进签名），PUT 时把结果原样回填给
 * `utils/presignedPut.ts::xhrPut`。
 */
export function normalizeUploadContentType(file: File): string {
  return file.name.toLowerCase().endsWith('.pdf') ? PDF_CONTENT_TYPE : BINARY_CONTENT_TYPE;
}
