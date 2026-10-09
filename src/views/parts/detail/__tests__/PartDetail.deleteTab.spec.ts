// src/views/parts/detail/__tests__/PartDetail.deleteTab.spec.ts
//
// 2026-10-10 新增（review 第 1 轮 次要 10）：软删成功后必须**连标签页一起关掉**。
//
// 为什么：零件详情页这一轮第一次进了 `<keep-alive :include>`（路由名 `PartDetail`
// = 组件文件名）。删除后只 `router.push('/parts')` 不关 tab，被删工单就留在缓存里 ——
// 组件不卸载（`onUnmounted` 不跑、`reset()` 不触发），用户点回去看到一份「还在」的旧
// 工单，而它上面的任何写都会 404（软删后 `GET /parts/{id}` 带 `deleted_at IS NULL`
// 过滤）。这是「引入 keep-alive」的直接副作用，不是既有缺陷。
//
// 为什么是静态守卫：断言点是「删除分支里在 push 之前摘掉当前 tab」这段**接线**，真实
// 行为要跑起来必须挂载整页（详情 / 事件 / 批次 / 工序链 / 文件 / 装配件 六条读 +
// 两个 pinia store + vue-query），成本与收益不成比例。同 `usePartDetailActions.spec.ts`
// 的 A9 静态守卫（composable 不 import vue-router）—— 宁可弱一点也不留无保护的那段。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../PartDetail.vue', import.meta.url)), 'utf8');

/** 软删分支（`onConfirmAction` 里 `confirmAction === 'delete'` 的 else 分支）。 */
const deleteBranch = src.slice(
  src.indexOf('if (await onDeletePart()) {'),
  src.indexOf('async function onConfirmAction()') === -1
    ? src.length
    : src.indexOf('// ============ 品检通过（shell 包一层 passSubmitting loading）============'),
);

describe('D1：软删成功后的收尾（导航 + 关标签）', () => {
  it('D1a：delete 分支摘掉当前标签页（removeView，不是只刷新）', () => {
    expect(deleteBranch).toContain('tags.removeView(selfTab)');
    // refreshSelectedView 只临时摘缓存再挂回（换实例、tab 还在）—— 本页要的是
    // 「这张 tab 不该再存在」。比对**调用**形态：注释里提到它是有意的取舍说明。
    expect(deleteBranch).not.toContain('tags.refreshSelectedView(');
  });

  it('D1b：摘 tab 在导航**之前**（沿 TagsView.vue::closeView 的顺序）', () => {
    expect(deleteBranch.indexOf('tags.removeView(selfTab)')).toBeGreaterThanOrEqual(0);
    expect(deleteBranch.indexOf('tags.removeView(selfTab)')).toBeLessThan(
      deleteBranch.indexOf("router.push('/parts')"),
    );
  });

  it('D1c：摘的是**当前** tab（按 route.path 从 visitedViews 里找，不是硬编码一个 view）', () => {
    expect(deleteBranch).toContain('tags.visitedViews.find((v) => v.path === route.path)');
    // affix tab 不删（store 内判定）：本页不是 affix，但沿用 store 的既有语义，
    // 找不到 tab 时也只跳过、不抛。
    expect(deleteBranch).toContain('if (selfTab) tags.removeView(selfTab)');
  });
});
