// 2026-10-08 新建：批次（t_part_batch）跨域共用的写端点 wire 契约（types only，无 runtime）。
//
// 端点（baseURL `/api/v2`，前缀 `/batches/*`）：
//   POST /api/v2/batches/split   ← splitBatch
//
// 分层取舍（照 `productionQueue.contract.ts` 两级切分的同款形态）：本文件只放 types，
// 零 runtime 依赖；请求发送在 `./batch.ts`，且**不做 Zod 守门**（守门点在有 queryFn /
// mutationFn 承载的调用方，见 CLAUDE.md「api 层引域内 schema 的口径」）。
//
// wire 层形态约定（与 `productionQueue.contract.ts` 逐字一致）：
//   - i64 主键 → JSON **字符串**（雪花 ID 防 JS 精度截断）。⚠️ **请求体**里的雪花 ID
//     同样必须发字符串 —— 后端 `deserialize_i64` 只接受字符串，发数字返 40001；
//   - 计数 / version 是 JSON integer，前端 number；
//   - 2026-10-08：`batch_id` 是 **body 字段**而非路径参数（split 与 cancel 同形，
//     都是「以批次为锚」的写端点，前端不拼路径）。

/** `POST /api/v2/batches/split` 请求（rust SplitBatchRequest）。
 *  角色：Manager + Clerk。
 *  ⚠️ **无 version 时后端返 HTTP 422 纯文本**（serde 无 `#[serde(default)]`，缺字段
 *  直接反序列化失败），不是业务信封 —— 调用方必须自己保证 version 非空，不要指望
 *  从错误信封里解析 code。 */
export interface SplitBatchByBodyRequest {
  /** 雪花 ID 字符串（JS Number 会丢精度，发数字后端返 40001）。 */
  batch_id: string;
  /** OCC 锚：源批次 `t_part_batch.version`。 */
  version: number;
  /** 拆出数量，∈ [1, 源批次 quantity - 1]（后端按此新建子批次，源批次原地减量）。 */
  quantity: number;
  /** 可选，写入事件 `note`。 */
  note?: string | null;
}

/** `POST /api/v2/batches/split` 出参（rust SplitBatchOut）。5 字段。
 *
 *  2026-10-08：出参此前在前端声明成 `PartBatch[]`（前端侧的**类型谎言** —— 后端返回的
 *  是这个对象，不是批次数组），调用方 `usePartDetail.onSplitBatch` 也照着它标注。
 *  改成契约真形：`new_batch_id` 是字符串（雪花 ID），声明成 number 会在 JS 侧丢精度。 */
export interface BatchSplitDto {
  /** 被拆的源批次 id（雪花 ID 字符串）。 */
  batch_id: string;
  /** 新立出来的子批次 id（雪花 ID 字符串）。 */
  new_batch_id: string;
  part_id: string;
  /** 源批次拆后余量（源批次原地减量、id 不变）。 */
  quantity: number;
  /** 源批次 version（拆批后 = 原 version + 1）。 */
  source_version: number;
}
