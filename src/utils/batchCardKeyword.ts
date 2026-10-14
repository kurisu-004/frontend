// src/utils/batchCardKeyword.ts
//
// 2026-10-20 新增：批次卡片的**关键词本地过滤**，一条口径三处消费（生产队列「待下发」
// 与工序候选池 + 外协看板「可发送候选池」）。
//
// **为什么是纯前端本地过滤**：这三个端点**都不接任何筛选参数** ——
// `GET /prod/queue/pending` 只有 limit / offset，`GET /prod/queue/processes/{id}` 与
// `GET /outsource-queue/processes/{id}` 连 query 都没有。搜索只影响**显示**，口径是
// 「全量数据不动、可见集变小」，所以 schema / api / queryKey / queryFn / 后端一律零改动：
// 加筛选参数会同时牵动缓存键与失效链，而这里要的并不是那件事。
//
// **判据（为什么放 `src/utils/` 而不是各域各写一份）**：CLAUDE.md 对 `utils/` 的要求是
// 「零个域内依赖 + 多域复用」，本文件两条都满足 ——
//   - **零域内依赖**：入参只有 `BatchCardModel`（来自 `src/types/batchCard.ts`，是共享
//     view-model，不属 `views/` 或 `api/`），不 import 任何域内类型；
//   - **多域复用**：生产队列域两个组件 + 外协域一个组件跨 2 个域共用这一份判定。
//
// **四个匹配字段**（任一命中即通过）：`serial_no`（工单序列号，搜索的主目标）/
// `drawing_no`（图号）/ `batch_no`（批次号，展示串已带 B 前缀）/ `part_name`（名称）。
// 四个都在 `BatchCardModel` 上、且都被三个适配层从各自的 wire DTO 填好（外协候选行的
// 源字段名是 `part_serial_no` / `part_drawing_no`，差异由各域适配层消化），组件侧零映射。
//
// **四个字段都可能为空**：`serial_no` 的类型就是 `string | null`（工单未派号 / 流水号被
// 释放后是 NULL），另三个虽声明为非空串，但外协侧适配层对可空的零件字段做过 `?? ''`
// 兜底。⇒ 统一按 `?? ''` 取 haystack：空值既不该抛错，也不该让一个非空关键词命中。
//
// **两个导出的主从关系（别把 `matches` 当死代码删掉）**：
//   - `filterBatchCardsByKeyword`（**生产路径**：三个卡片列的唯一消费方）**委托**
//     `matchesBatchCardKeyword` —— 归一化（trim / 忽略大小写）只有一份实现；
//   - `matchesBatchCardKeyword` 是那条规则的实现基元，单独导出使它有单一实现点、并能被
//     直接单测（四个匹配字段各自命中那条，只有直接喂一张只有单字段不同的卡片才有判定力）。
// 若两边各写一份归一化，生产路径与单卡判定会悄悄分叉，而「条码枪尾部空格」「小写序列号」
// 这类退化**只在带空白 / 混合大小写的输入上显形**，其余用例照绿。

import type { BatchCardModel } from '@/types/batchCard';

/** 一张卡片的四个匹配字段（小写形态）。可空值按空串处理，不抛错也不误命中。 */
function haystacks(card: BatchCardModel): string[] {
  return [card.serial_no, card.drawing_no, card.batch_no, card.part_name].map((v) =>
    (v ?? '').toLowerCase(),
  );
}

/** 关键词 trim 后是否为空（空关键词 = 不过滤）。 */
function isBlankKeyword(keyword: string): boolean {
  return keyword.trim().length === 0;
}

/** 这张卡片是否命中关键词：trim + 忽略大小写的模糊包含，四个字段任一命中即通过。 */
export function matchesBatchCardKeyword(card: BatchCardModel, keyword: string): boolean {
  // 空关键词（全通过）必须在做任何 toLowerCase 之前短路：它是三个搜索框的初始态，
  // 也是用户清空输入框后的常态，没必要为此付一遍字段遍历。
  if (isBlankKeyword(keyword)) return true;
  const needle = keyword.trim().toLowerCase();
  return haystacks(card).some((hay) => hay.includes(needle));
}

/** 按关键词过滤卡片数组，**保持原顺序**、不改传入数组（返回新数组；空关键词原样返回）。
 *
 *  判定委托给 `matchesBatchCardKeyword`（规则只有一份实现，见文件头的主从关系一节）。
 *  代价是 needle 的 trim / toLowerCase 每张卡各算一遍 —— 卡片量级几十到几百、调用方一律
 *  用 `computed` 包着（不在渲染热路径上），换「规则只有一份」这笔交易很划算，不要为省这点
 *  重复计算把归一化再抄一份回来。 */
export function filterBatchCardsByKeyword<T extends BatchCardModel>(
  cards: T[],
  keyword: string,
): T[] {
  if (isBlankKeyword(keyword)) return cards;
  return cards.filter((card) => matchesBatchCardKeyword(card, keyword));
}
