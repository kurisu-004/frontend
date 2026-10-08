// src/views/production/scan/chainAccent.ts
//
// 2026-10-09 新建：报工台（`views/production/scan/`）批次卡的**左边框**着色规则，供三页列表
// （取件 / 放回 / 送检）与共享的 `BatchPickerDialog` 共用。
//
// 左边框整条只表达「这条批次有制定工序链且链指针未漂移」这一个语义（语义与判据见
// `src/types/batchCard.ts::BatchCardModel.has_process_chain`）。**流程区分不进边框** ——
// 那是顶栏标题 + 路由的职责，而边框是卡片上最显眼、也最适合承载批次级语义的位置：
// 同一个字段在三页被解释成三件事，工人无从建立「绿边框 = 有链」这个预期。
//
// **着色走类绑定，不走模板 inline `:style`**：inline 样式优先于任何非 `!important`
// 规则，各页 `.part-row.is-selected` / `.part-row.is-urgent` 的 `border-color` 简写盖不住
// 它，表现是「选中行的左边框从中性色退回、其余三边仍是状态色」，读起来像渲染坏了。
// 类绑定与既有状态类同档特异度（0,2,0），把 `.has-chain` 规则写在状态类**之后**、
// 靠源码顺序取胜即可让左边框恒由链语义决定。各消费方在自己的 scoped CSS 里落
// `.part-row.has-chain` / `.batch-row.has-chain`（色值与该文件既有色板放在一起），
// 本模块只统一**类名与判据**。
//
// 加急不用边框表达：红底（`.part-row.is-urgent`）+「加急」tag 已在位，边框让位给链。
// 注意 `.is-urgent` 红底是**报工台行**的样式，`BatchCard`（队列看板 / 外协看板）没有。
//
// 消费方：报工台三页与 `components/BatchPickerDialog.vue` 全在本目录内。本模块自身零域内依赖、
// 判据只有一条 `=== true`，故留在域内不被上提成 utils —— 它回答的是「批次链语义」
// （`BatchCardModel.has_process_chain` 的口径），不是通用着色工具：生产队列与外协看板的竖条
// 着色在各自适配层 + `BatchCard.vue` 的 `accentVar` 里，机制也不同（那边是 v-bind 变量）。

/** 有链且指针未漂移时挂到行根上的类名：`.part-row.has-chain` / `.batch-row.has-chain`。 */
export const CHAIN_ROW_CLASS = 'has-chain';

/**
 * 行数据 → 类名。判据用 `=== true` 而不是真值判断：只有明确的 true 才算「有链」，
 * 键缺失（`undefined`）与 null / 0 一律落无类 ⇒ 左边框走 `.part-row` 的中性底色，
 * 「只有明确的 true 才亮绿」是唯一口径。
 */
export function chainRowClass(hasProcessChain: boolean | null | undefined): string {
  return hasProcessChain === true ? CHAIN_ROW_CLASS : '';
}
