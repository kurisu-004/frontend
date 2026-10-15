// src/constants/mime.ts —— 跨域共用的 MIME 常量（2026-10-15 新增）
//
// 为什么放在这里：`XLSX_MIME` 有两类互不相干的消费方 ——
//   ① 送货单域（`views/com/delivery/` 的打印 / 标签工作簿、打印对话框下载）；
//   ② 上传直传链路（`utils/fileContentType.ts::normalizeUploadContentType`，六个上传
//      场景共用；`views/printTemplates/` 的模板上传经它算 content_type）。
// 定义在送货单域内会让 `utils/` 反向依赖 `views/`（层次倒挂），定义在 `utils/` 又让
// 「值真源」跟着工具走 —— `src/constants/` 是仓内既有的中性位置（`partStatus.ts` 同居），
// 两条边都正。
//
// ⚠️ **这里是该字面量的唯一真源**（`application/vnd.openxmlformats-officedocument
// .spreadsheetml.sheet`）：后端 `part_file::policy::expected_content_types_for_ext` 对
// `xlsx` 只收这一种、**没有** `application/octet-stream` 兜底，而
// `grant_upload_intents` **不**校验 content_type ⇒ 一旦某处抄了字面量、或者干脆落进
// octet-stream 兜底，流程会走成「签发成功 → XHR PUT 成功 → confirm 被拒」，并在对象
// 存储桶里留一个孤儿对象（用户侧只看到一句报错，桶里多一份没人认领的字节）。
// 守卫见 `src/api/__tests__/printTemplates.contract.spec.ts` 的 E2 / E3 组。

/**
 * xlsx 的规范 MIME（Blob / 下载 / 上传声明三处共用）。
 *
 * ⚠️ **不能用浏览器的 `file.type`**：Windows Chrome 常给空串或
 * `application/octet-stream`，部分环境给 `application/vnd.ms-excel`；直传链路里它还会
 * 被签进 SigV4 的 SignedHeaders，错了就是 403 SignatureDoesNotMatch。
 */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
