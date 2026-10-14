// src/views/statistics/__tests__/chartContract.spec.ts
//
// 回归守卫单测：锁「statistics 域的图表一律走全局 <v-chart>（vue-echarts）」这条契约。
//
// 为什么用源码断言而不是 mount 断言：
//   图表渲染要真 canvas（node / happy-dom 都没有布局引擎与 canvas 后端），
//   mount 后量到的只有一具空壳，什么都验不出。真正能测出回归的是「渲染方式 +
//   option 更新语义 + 逐格高度」这几条静态契约，任一被删掉本守卫当场变红。
//
// 高度为什么也要锁：图表高度是纯 CSS（canvas 会自适应容器），改高度不会让任何
// 运行时断言变红，但页面观感会直接变形；它是迁移必须逐字保留的东西。
//
// ⚠️ 扫描范围只取 `<template>` 与 `<script>` 两个顶层块（见下方 block /
// stripJsComments）。全文正则会被 `//` 注释里的 `<v-chart>` 字面量喂成开标签，
// `[\s\S]*?` 再向后惰性吃到别处的 `/>`，凭空多出一个指不到位置的断言失败 ——
// 这个文件自己的头注释就含 `<v-chart>` 字面量，是活的雷。
//
// 范围：本域三个 tab。两条**跨域**不变量（兜底壳归零、echarts.use 只有一个落点）
// 不在这里断言，归 src/plugins/__tests__/echartsContract.spec.ts。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** 三个 tab → 该 tab 内每张图应有的高度（CSS 长度，逐字沿用迁移前的值）。 */
const TABS: { file: string; height: string }[] = [
  { file: 'src/views/statistics/OverviewTab.vue', height: '320px' },
  { file: 'src/views/statistics/WorkerStatsTab.vue', height: '360px' },
  { file: 'src/views/statistics/WorkerDetailTab.vue', height: '280px' },
];

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** 取 SFC 顶层块的行数组（根 <template> / <script>）。
 *  开闭标签都要求在行首第 0 列：prettier 把根块写成顶格，缩进的 <template #slot> /
 *  </template> 是嵌套槽位，不会被误当成顶层块的结束（否则会被提前截断）。 */
function block(src: string, tag: 'template' | 'script'): string[] {
  const lines = src.split('\n');
  const open = new RegExp(`^<${tag}(\\s[^>]*)?>\\s*$`);
  const start = lines.findIndex((l) => open.test(l));
  if (start < 0) return [];
  const close = new RegExp(`^</${tag}>\\s*$`);
  const end = lines.findIndex((l, i) => i > start && close.test(l));
  return lines.slice(start, end < 0 ? undefined : end + 1);
}

/** 模板段：剥掉 HTML 注释（注释里提到组件名不算结构用法）。 */
function markup(src: string): string {
  return block(src, 'template')
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** 逻辑段：剥掉 JS 行注释与块注释（尊重字符串字面量，免得把 'https://x' 的 // 当注释）。 */
function logic(src: string): string {
  const s = block(src, 'script').join('\n');
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          out += s[i] + (s[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += s[i];
        const closed = s[i] === c;
        i++;
        if (closed) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 取全部 <v-chart ...> 开标签的原文数组（自闭合与非自闭合都认）。
 *  属性段用 [^>]*? 而非 [\s\S]*? ⇒ 标签永不跨越下一个尖括号，注释里的字面量无从混入。 */
function chartTags(src: string): string[] {
  return markup(src).match(/<v-chart\b[^>]*?>/g) ?? [];
}

describe('statistics 域图表契约', () => {
  it('三个 tab 都至少有一张 <v-chart> 图', () => {
    for (const tab of TABS) {
      expect(chartTags(readSource(tab.file)).length, tab.file).toBeGreaterThan(0);
    }
  });

  it('每张图都显式 notMerge 整份替换 + autoresize + 锁 v5 主题 + canvas 渲染', () => {
    for (const tab of TABS) {
      for (const tag of chartTags(readSource(tab.file))) {
        // notMerge：把 option 的更新语义钉死成整份替换，不依赖 vue-echarts 结构签名
        // planner 的启发式判断（结构变了它自己会翻 notMerge，只有纯数值变才合并）。
        expect(tag, `${tab.file} 的 <v-chart> 缺 :update-options="{ notMerge: true }"`).toContain(
          `:update-options="{ notMerge: true }"`,
        );
        // autoresize：vue-echarts 内建 ResizeObserver，少了它容器尺寸变化不再自适应。
        expect(tag, `${tab.file} 的 <v-chart> 缺 autoresize`).toContain('autoresize');
        expect(tag, `${tab.file} 的 <v-chart> 缺 theme="v5"`).toContain('theme="v5"');
        expect(tag, `${tab.file} 的 <v-chart> 缺 canvas 渲染`).toContain(
          `:init-options="{ renderer: 'canvas' }"`,
        );
      }
    }
  });

  it('图高度与迁移前逐格相同', () => {
    for (const tab of TABS) {
      const tags = chartTags(readSource(tab.file));
      expect(tags.length, tab.file).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, `${tab.file} 的 <v-chart> 高度应为 ${tab.height}`).toContain(
          `height: '${tab.height}'`,
        );
      }
    }
  });

  it('不再消费历史兜底壳 EChart.vue（模板里不出现、脚本里不 import）', () => {
    for (const tab of TABS) {
      expect(markup(readSource(tab.file)), `${tab.file} 的模板仍引用 EChart`).not.toMatch(
        /\bEChart\b/,
      );
      expect(logic(readSource(tab.file)), `${tab.file} 的脚本仍引用 EChart`).not.toMatch(
        /\bEChart\b/,
      );
    }
  });

  it('不在业务组件内值导入 echarts/core 或自行 init / use（type-only 不受限）', () => {
    for (const tab of TABS) {
      const code = logic(readSource(tab.file));
      // 非 type 的 echarts 值导入（type-only import 被这条的正则排除）。
      expect(code, `${tab.file} 有非 type 的 echarts 值导入`).not.toMatch(
        /import\s+(?!type\b)[^;]*?from\s+['"]echarts(?:\/core)?['"]/,
      );
      expect(code, `${tab.file} 自行调用了 echarts.init`).not.toMatch(/echarts\s*\.\s*init\s*\(/);
      expect(code, `${tab.file} 自行调用了 echarts.use`).not.toMatch(/echarts\s*\.\s*use\s*\(/);
    }
  });
});
