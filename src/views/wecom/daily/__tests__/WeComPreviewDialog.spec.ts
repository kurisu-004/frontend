// src/views/wecom/daily/__tests__/WeComPreviewDialog.spec.ts
//
// 2026-10-17 新建：`WeComPreviewDialog.vue` 的**源码契约**守卫 + 字节数口径守卫。
//
// 守的三条不变量，每一条都是「渲染后的 DOM 里查不出来 / 行为上很容易被改坏」的那类：
//
//  1. **零 XSS 面**：本组件**不许**出现 `v-html` / `<iframe>` / `srcdoc` / 任何 HTML 字符串
//     拼接。载荷是 markdown 纯文本，`<pre>` 插值渲染天然按文本处理。邮件预览那条路
//     （`MailPreviewDialog.vue` 的 `<iframe sandbox="" :srcdoc>`）是**邮件 HTML** 才需要的，
//     搬过来只会凭空多一个注入面。
//  2. **逐片渲染**、源码里**不含** `chunks.join`：分片不是截断 —— 后端把超出单条消息上限的
//     内容按块拆成多条。拼成一段展示，管理员就看不到「这次要发几条」，而那恰恰是他点预览唯一
//     要预判的事。
//  3. **字节数用 `TextEncoder`** 而不是 `chunk.length`：后者是 UTF-16 码元数，中文一条只算 1
//     （UTF-8 算 3）⇒ 用它显示的「3000 / 4096 字节」其实已经 9000 字节、发不出去，管理员据此
//     判断「要不要调 max_chunks」会被彻底误导。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
  new URL('../components/WeComPreviewDialog.vue', import.meta.url),
  'utf8',
);

/**
 * 剥掉**注释**后的源码（HTML 块注释 `<!-- -->` + 脚本块注释 `/* *\/` + 整行 `//` 注释）。
 *
 * ⚠️ **为什么必须剥**：这些组件的文件头**刻意在讲「为什么不这么写」**，那些被禁止的写法会
 * 原样出现在注释里（连 JSDoc 块注释里都有）。不剥注释的话下面那几条负向断言会被自己的注释
 * 判红，于是每次改注释都要来改测试（或者更糟：有人为了让测试绿而把文件头里那段解释删掉）。
 * 剥掉之后断言只对**真正的模板与脚本**生效，守的东西与它宣称的完全一致。
 *
 * 副作用（刻意接受）：本 spec 不检查注释内容是否正确 —— 那是 review 的事，不是测试的事。
 */
function stripComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(SRC);

describe('WeComPreviewDialog.vue — 零 XSS 面（第一性质）', () => {
  it('S1：模板与脚本里不出现 v-html / iframe / srcdoc / innerHTML', () => {
    expect(CODE).not.toMatch(/v-html/);
    expect(CODE).not.toMatch(/<iframe/i);
    expect(CODE).not.toMatch(/srcdoc/i);
    expect(CODE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(CODE).not.toMatch(/document\.write/);
  });

  it('S2：用只读 <pre> 渲染每一片（white-space: pre-wrap 保住换行）', () => {
    expect(CODE).toMatch(/<pre class="chunk-text">\{\{ chunk \}\}<\/pre>/);
    expect(CODE).toMatch(/white-space: pre-wrap/);
  });
});

describe('WeComPreviewDialog.vue — 逐片渲染（不许拼成一段）', () => {
  it('S3：模板用 v-for 遍历 chunks，并逐片渲染「第 i / N 条」', () => {
    expect(CODE).toMatch(/v-for="\(chunk, idx\) in result\.chunks"/);
    expect(CODE).toMatch(/第 \{\{ idx \+ 1 \}\} \/ \{\{ result\.chunks\.length \}\} 条/);
  });

  it('S4：模板与脚本里**不含** chunks.join（这是「预览显示成一段」那条路的唯一形态）', () => {
    expect(CODE).not.toMatch(/chunks\.join/);
  });

  it('S5：每片上方有一行字节数（管理员判断「会不会发不出去」的渠道）', () => {
    expect(CODE).toMatch(/\{\{ byteLength\(chunk\) \}\} \/ 4096 字节/);
  });
});

describe('WeComPreviewDialog.vue — 字节数口径', () => {
  it('B1：用 TextEncoder 而不是 chunk.length', () => {
    expect(CODE).toMatch(/new TextEncoder\(\)\.encode\(chunk\)\.length/);
    // `chunk.length` 出现即错（那是 UTF-16 码元数）。
    expect(CODE).not.toMatch(/byteLength[\s\S]{0,120}?chunk\.length/);
  });

  it('B2：口径真的不同 —— 一段中文的 UTF-8 字节数远大于码元数', () => {
    // 用真实的 TextEncoder 跑一遍，证明这两个口径在中文上确实不同（否则 B1 只是洁癖）。
    const chunk = '今日生产日报：批次 12、件数 340';
    const bytes = new TextEncoder().encode(chunk).length;
    expect(bytes).toBeGreaterThan(chunk.length);
    expect(bytes).toBeGreaterThan(chunk.length * 2);
  });
});

describe('WeComPreviewDialog.vue — 顶部汇总 tag', () => {
  it('T1：overview_* / note_count / overdue_count / upcoming_count / chunk_count 都在顶部露出来', () => {
    for (const field of [
      'result.chunk_count',
      'result.overdue_count',
      'result.upcoming_count',
      'result.overview_batch_count',
      'result.overview_quantity',
      'result.note_count',
      'result.worker_row_total',
    ]) {
      expect(CODE, `顶部汇总缺 ${field}`).toContain(field);
    }
  });

  it('T2：契约里没有 markdown 单字段，组件也不该引用它（避免第二个真相源复活）', () => {
    expect(CODE).not.toMatch(/\bresult\.markdown\b/);
  });
});
