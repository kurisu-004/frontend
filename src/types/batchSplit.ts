// src/types/batchSplit.ts
//
// 2026-10-09 新建：`BatchSplitDialog`（拆批对话框，共享组件）的入参类型。
//
// 为什么独立成文件而不是塞进 `batchCard.ts`：本类型不是「一张卡片长什么样」，而是
// 「一次拆批要提交什么」—— 五字段全部取自卡片 model（batch_id / version / quantity）
// 加两个展示字段，形状与卡片解耦。放在 `batchCard.ts` 会让读类型的人以为它是卡片
// 的字段集。
//
// 域中立性：`POST /api/v2/batches/split` 是**全仓共享**的批次写端点（生产队列的
// 待下发 / 工序池 / 工人列 与外协候选池 / 公司列五处都在用），入参也不带任何领域概念，
// 故类型归共享层而不是某个 `views/<域>/`。

/** 拆批对话框的被拆目标 —— 由右键的那张卡片带进来的最小信息。
 *
 *  刻意保持「五个域中立字段」的窄接口：对话框不关心批次在哪个容器、当前是什么状态，
 * 只按 `quantity` 算拆出数量的上下界（后端要求 ∈ [1, quantity - 1]），按 `version`
 * 做 OCC 乐观锁。 */
export interface BatchSplitSource {
  /** 源批次 id（雪花 ID 字符串）。 */
  batch_id: string;
  /** `t_part_batch.version` —— `POST /batches/split` 必填的 OCC 锚。
   *  后端 serde 无 `#[serde(default)]`，缺它返 HTTP 422 **纯文本**（不是业务信封），
   *  故派生前必须先判它是不是有限数。 */
  version: number;
  /** 当前余量，决定拆出数量的 `:max = quantity - 1`（拆光没有意义）。 */
  quantity: number;
  /** 展示用（卡片 model 已带 'B' 前缀，适配层拼好）。 */
  batch_no: string;
  part_name: string;
}