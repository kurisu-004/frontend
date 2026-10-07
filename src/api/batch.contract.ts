// 2026-10-08 新建：批次（t_part_batch）跨域共用的写端点 wire 契约（types only，无 runtime）。
//
// 端点（baseURL `/api/v2`，前缀 `/batches/*`）：
//   POST /api/v2/batches/split   ← splitBatch
//
// 分层取舍（照 `productionQueue.contract.ts` 两级切分的同款形态）：本文件只放 types，
// 零 runtime 依赖；请求发送在 `./batch.ts`，且**不做 Zod 守门**（守门点在有 queryFn /
// mutationFn 承载的调用方，见 CLAUDE.md「api 层引域内 schema 的口径」）。
//
// wire 层形态约定：
//   - 后端标了 `#[serde(deserialize_with = "deserialize_i64")]` 的字段 → JSON **字符串**。
//     本端点只有 `batch_id` 走这一档（雪花 ID，防 JS 精度截断）。⚠️ 发数字 → **HTTP 422
//     纯文本**，响应里**没有 `code` 字段**，调用方不要按业务错误码分支解析；
//   - 没标该反序列化器的计数 / OCC 字段（`version` / `quantity`）走**裸 JSON 数字**，
//     前端照常用 number。⚠️ 反过来发字符串同样吃 422 纯文本；
//   - 同一份请求体里 `batch_id` 发字符串、`version` / `quantity` 发数字，**混用是刻意的**
//     —— 后端逐字段挂了各自的反序列化器。不要把一档的口径套到另一档；
//   - 2026-10-08：`batch_id` 是 **body 字段**而非路径参数（split 与 cancel 同形，
//     都是「以批次为锚」的写端点，前端不拼路径）。

/** `POST /api/v2/batches/split` 请求（rust SplitBatchRequest）。
 *  角色：Manager + Clerk。
 *  ⚠️ **无 version 时后端返 HTTP 422 纯文本**（serde 无 `#[serde(default)]`，缺字段
 *  直接反序列化失败），不是业务信封 —— 调用方必须自己保证 version 非空，不要指望
 *  从错误信封里解析 code。 */
export interface SplitBatchByBodyRequest {
  /** 雪花 ID 字符串（JS Number 会丢精度；且后端 `deserialize_i64` 只吃字符串，发数字 → 422）。 */
  batch_id: string;
  /** OCC 锚：源批次 `t_part_batch.version`。裸 i32 → JSON integer。 */
  version: number;
  /** 拆出数量，∈ [1, 源批次 quantity - 1]（后端按此新建子批次，源批次原地减量）。
   *
   *  **裸 JSON 数字**（后端 `pub quantity: i32`，不挂 `deserialize_i64`）：发字符串会被
   *  serde 拒在反序列化阶段 ⇒ **HTTP 422 纯文本**。与同一结构里 `batch_id` 必须发字符串
   *  **正好相反** —— 两个字段各自挂了不同的反序列化器，不要互相套用口径。 */
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
  /** **实际拆走量**（= 新批次数量），不是源批次余量。
   *
   *  ⚠️ 源批次余量**不在出参里** —— 源批次原地减量、id 不变，但它的新数量要自行用
   *  `源批次.quantity - 本字段` 算。把本字段当余量读会让「拆 4 / 剩 10」显示成
   *  「拆 4 / 剩 4」。 */
  quantity: number;
  /** 源批次 version（拆批后 = 原 version + 1）。 */
  source_version: number;
}
