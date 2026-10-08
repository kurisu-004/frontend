// src/views/scan/chainAccent.ts
//
// 2026-10-09 新建：报工台（`views/scan/`）批次卡片的**左边框**着色规则，供三页列表
// （取件 / 放回 / 送检）与同域的 `BatchPickerDialog` 共用。
//
// 左边框整条只表达「这条批次有制定工序链且链指针未漂移」这一个语义（语义与判据见
// `src/types/batchCard.ts::BatchCardModel.has_process_chain`）。**流程区分不进边框** ——
// 那是顶栏标题 + 路由的职责，而边框是卡片上最显眼、也最适合承载批次级语义的位置：
// 同一个字段在三页被解释成三件事，工人无从建立「绿边框 = 有链」这个预期。
//
// 加急不用边框表达：红底（`.part-row.is-urgent`）+「加急」tag 已在位，边框让位给链。
// 绿色用 EP 语义绿的字面值（`#67c23a`），与生产队列 / 外协看板的 BatchCard 同色。
//
// 三个页面与 BatchPickerDialog 都在本目录 / 子目录下，同域自持；不是跨域工具
// （生产队列与外协看板的着色在各自的 BatchCard 适配层里）。

/** 有链且指针未漂移时的左边框色（EP 语义绿的字面值）。 */
export const CHAIN_BORDER_COLOR = '#67c23a';

/** 无链时的中性边框色：与卡片其余三边同色，让左边框恒定可见（不取 transparent）。 */
export const NO_CHAIN_BORDER_COLOR = '#e4e7ed';

/**
 * 行数据 → 左边框色。判据用 `=== true` 而不是真值判断：本组件（BatchPickerDialog）被
 * 送货单 / 品检两个域复用，它们的行 VO **没有**这个字段（键不存在 ⇒ undefined），
 * 真值判断下 `undefined` 恰好也落中性色，但一旦某个域把它当可空布尔传 null 就会得到
 * 「无链」与「未知」同色 —— 显式判 true 让「只有明确的 true 才亮绿」成为唯一口径。
 */
export function chainBorderColor(hasProcessChain: boolean | null | undefined): string {
  return hasProcessChain === true ? CHAIN_BORDER_COLOR : NO_CHAIN_BORDER_COLOR;
}