// src/plugins/__tests__/echartsContract.spec.ts
//
// 全仓级图表不变量守卫（跨域，不属于任何单一业务域）。
//
// 两条断言，都是「整个仓只有这一处」的形状：
//   1. 兜底薄壳 src/components/EChart.vue 归零消费方后已删除，全仓不再有第二种图表
//      承载壳 —— 新增图表一律用全局 <v-chart>（CLAUDE.md「图表」一节）。
//   2. echarts.use() 的唯一落点是 src/plugins/echarts.ts：模块化注册与
//      `import 'echarts/theme/v5'` 副作用导入都绑在那一个文件里，业务组件只消费
//      全局 <v-chart>、不各自 use、不值导入 echarts/core、不自行 echarts.init。
//
// 为什么放这里而不放域内 spec：这两条断言的对象是全仓，挂在某个业务域的
// __tests__ 下会让「别的域合理新增图表壳」时红一个不相干的域（域内 spec 只守本域，
// 见 views/statistics/__tests__/chartContract.spec.ts）。
//
// 将来真的要引入第二种图表承载形态（例如一个自管 dispose 的域内壳），先改这里，
// 不要绕过。

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = join(ROOT, 'src');

/** 兜底薄壳：归零消费方后即死代码。 */
const LEGACY_SHELL = 'src/components/EChart.vue';

/** 允许出现 echarts.use() / echarts.init() 的唯一文件。 */
const REGISTRATION_POINT = 'src/plugins/echarts.ts';

/** 递归列出 src/ 下全部 .vue / .ts（跳过 __tests__：断言自身带字面量，扫自己没意义）。 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name !== '__tests__') sourceFiles(abs, acc);
      continue;
    }
    if (name.endsWith('.vue') || name.endsWith('.ts')) acc.push(relative(ROOT, abs));
  }
  return acc;
}

/** 去掉 JS 行注释与块注释（尊重字符串字面量，免得把 'https://x' 里的 // 当注释起点）。 */
function stripJsComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        const closed = src[i] === c;
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

describe('全仓图表承载不变量', () => {
  it(`兜底薄壳 ${LEGACY_SHELL} 不存在（全仓只有 <v-chart> 一种承载）`, () => {
    expect(existsSync(join(ROOT, LEGACY_SHELL)), `${LEGACY_SHELL} 应已删除`).toBe(false);
  });

  it('echarts.use() / echarts.init() / echarts 值导入只出现在注册点一个文件里', () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles(SRC)) {
      if (rel === REGISTRATION_POINT) continue;
      const code = stripJsComments(readFileSync(join(ROOT, rel), 'utf8'));
      const hit =
        /echarts\s*\.\s*init\s*\(/.test(code) ||
        /echarts\s*\.\s*use\s*\(/.test(code) ||
        /import\s+(?!type\b)[^;]*?from\s+['"]echarts(?:\/core)?['"]/.test(code) ||
        /import\s+(?!type\b)[^;]*?from\s+['"]vue-echarts['"]/.test(code);
      if (hit) offenders.push(rel);
    }
    expect(
      offenders,
      `只有 ${REGISTRATION_POINT} 可以碰 echarts 实例与注册；越界文件：${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('注册点本身确实注册了 v5 主题与 CanvasRenderer（不是空壳文件）', () => {
    const code = stripJsComments(readFileSync(join(ROOT, REGISTRATION_POINT), 'utf8'));
    expect(code, `${REGISTRATION_POINT} 缺 v5 主题导入`).toContain("import 'echarts/theme/v5'");
    expect(code, `${REGISTRATION_POINT} 缺 CanvasRenderer 注册`).toContain('CanvasRenderer');
  });
});
