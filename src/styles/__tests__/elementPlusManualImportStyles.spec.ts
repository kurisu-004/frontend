// src/styles/__tests__/elementPlusManualImportStyles.spec.ts
//
// 回归守卫单测：扫描 src/**/*.vue，断言「脚本里手动 import 的 Element Plus 组件」
// 都由本文件自己 import 了对应样式。
//
// 2026-10-03 踩坑记录（`/parts/new` Tab 2「PDF 批量上传」el-select 错位 + 点不中）：
//   unplugin-vue-components 的 ElementPlusResolver 只处理**模板**里用到的标签；
//   脚本作用域里已经显式绑定了同名组件时，resolver 认为该组件由本文件自行负责，
//   直接跳过 → 不再注入 `element-plus/es/components/<name>/style/css` 副作用 import。
//   而 `PartBatchPdfTab.vue` 的 9 个 EP 组件（autocomplete / date-picker / input /
//   input-number / link / option / select / switch / tag）都要传 `h()` 渲染函数，
//   必须显式 import，于是模板版本也一并拿不到样式。
//   漏注入的表现：`.el-select__wrapper` 退回 display:block（正确应为 inline-flex +
//   position:relative），placeholder 与 caret 掉到原生 input 下方 / 第三行并被下一行
//   单元格内容盖住 → 点 caret 打不开下拉（事件落到下一行元素上）。
//
// 本守卫的判据：某组件的 kebab 名既要能被「本文件直接 import 的样式」覆盖，也要能被
// 「这些样式的传递闭包」覆盖。闭包**运行时读** `node_modules/element-plus/es/components/
// <name>/style/css.mjs` 里的 `import "../../<x>/style/css.mjs"` 行递归求解 —— 不自造映射
// 表，EP 升级改了闭包本守卫会跟着变。
//
// 覆盖面盲区（已知、本轮不扩范围）：本守卫只扫 `src/**/*.vue`。`.ts` 文件里为 `h()`
// 渲染函数手动 import EP 组件是同一类问题（`src/views/inspection/inspectionColumnDefs.ts` /
// `src/views/parts/list/partsListColumnDefs.ts` /
// `src/views/cnc/pendingProgrammingColumnDefs.ts`
// 都是），今天靠消费它们的 `.vue` 顺带注入样式、视觉正常，故未纳入扫描。

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = join(ROOT, 'src');
/** EP 组件样式入口（es/components/<name>/style/css.mjs）。运行时读它的传递闭包。 */
const EP_STYLE_ENTRY = join(ROOT, 'node_modules/element-plus/es/components');

/** 命令式 API（ElMessage / ElMessageBox / …）：无组件样式，由 main.ts 统一 import
 *  theme-chalk，不在本守卫范围。 */
const IMPERATIVE_APIS = new Set(['ElMessage', 'ElMessageBox', 'ElNotification', 'ElLoading']);

interface Violation {
  /** 相对 src/ 的路径（正斜杠）。 */
  file: string;
  /** 文件里**第一条**裸 `from 'element-plus'` 值 import 所在行（1-based），后续同类
   *  import 不覆盖它 —— 报错文案里作为「去这个文件的哪一行看」的锚点。 */
  line: number;
  /** 该文件未覆盖样式的 kebab 组件名。 */
  missing: string[];
}

// 存量豁免表（2026-10-03）：这些文件同样手动 import 了 EP 组件，但当前样式由**同路由
// 其它文件**经 resolver 顺带注入，视觉正常；逐一补 style import 属预防性改动，本轮不做
// （用户明确决定）。**补齐后请从表里删掉对应行**，否则豁免会长期掩盖后续新引入的同类漏洞。
//
// 键 = 相对 src/ 的路径，值 = 该文件尚未覆盖样式的 kebab 组件名。
const EXEMPT: Record<string, string[]> = {
  'components/FileListCard.vue': ['el-upload'],
  'components/UploadStatusCellView.vue': ['el-button', 'el-progress'],
  'views/assemblies/components/AssemblyChildrenTable.vue': ['el-link', 'el-tag'],
  'views/delivery/DeliveryNoteList.vue': ['el-tag'],
  'views/delivery/DeliveryNoteScan.vue': ['el-table'],
  'views/delivery/components/BatchInspectionConfirmDialog.vue': ['el-tag', 'el-table'],
  'views/delivery/components/DeliveryDraftCard.vue': ['el-table'],
  'views/delivery/components/DeliveryGroupEditor.vue': ['el-form'],
  'views/delivery/components/DeliveryNoteLineItemsTable.vue': ['el-tag'],
  'views/delivery/components/PartPickerDialog.vue': ['el-tag'],
  'views/delivery/components/PrintPreviewDialog.vue': ['el-tag', 'el-table'],
  'views/parts/detail/components/PartBatchMonitorCard.vue': ['el-tag'],
  'views/parts/list/components/PurchaseOrderImportDialog.vue': ['el-tag', 'el-tooltip'],
  'views/parts/new/components/PartBatchManualTab.vue': ['el-button', 'el-tag'],
  'views/production/components/ProcessTab.vue': ['el-tag'],
  'views/repair/RepairReceive.vue': ['el-tag'],
  'views/shelves/ShelfList.vue': ['el-tag', 'el-form'],
  'views/statistics/PickupSkipTab.vue': ['el-tag'],
  'views/statistics/WorkerDetailTab.vue': ['el-tag'],
  'views/statistics/WorkerStatsTab.vue': ['el-progress', 'el-tag'],
  'views/users/UserList.vue': ['el-tag', 'el-form'],
  'views/production/WorkerList.vue': ['el-tag', 'el-table'],
};

/** 递归收集 .vue，跳过 node_modules / __tests__ / .git。 */
function collectVueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectVueFiles(full, out);
      continue;
    }
    if (entry.endsWith('.vue')) out.push(full);
  }
  return out;
}

/** ElTableColumn → el-table-column；ElDatePicker → el-date-picker；ElInputNumber → el-input-number。
 *  保留 `el-` 前缀（与豁免表 / 报错文案一致），去掉前缀才能与 EP 目录名对齐，故在
 *  `styleClosure` / `direct` 侧统一补前缀。 */
function epNameToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** 样式入口 css.mjs 的传递闭包：解析 `import "../../<x>/style/css.mjs"` 行递归求解。
 *  入参与返回值都是带 `el-` 前缀的组件名。 */
function styleClosure(names: string[], seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.add(name);
    // 目录名不带 el- 前缀（element-plus/es/components/select/style/css.mjs）
    const dir = name.replace(/^el-/, '');
    const entry = join(EP_STYLE_ENTRY, dir, 'style/css.mjs');
    if (!existsSync(entry)) continue;
    const src = readFileSync(entry, 'utf8');
    for (const m of src.matchAll(/import\s+"\.\.\/\.\.\/([a-z0-9-]+)\/style\/css\.mjs"/g)) {
      for (const dep of styleClosure([`el-${m[1] as string}`], seen)) out.add(dep);
    }
  }
  return out;
}

/** 把注释逐字符替换成空格（换行保留）—— 行号、列号全部不变，正则只在这些位置上
 *  「看不见」注释。
 *
 *  匹配前必须剥：样式 import 一旦被注释掉（`// import '.../select/style/css';`），
 *  裸文本正则照样会命中注释里的字面量，把「注释掉的 import」误判成「已覆盖」而放行。
 *
 *  这里是刻意的粗粒度剥除（不区分字符串里的 `//`）：本守卫只匹配 import 说明符，
 *  这些字面量在 .vue 文件里不会出现在字符串或正则量词内部，误伤面为零。 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/.*$/gm, blank);
}

function scanFile(full: string): Violation | null {
  // 先剥注释再匹配：注释掉的 import 不算真的 import。
  const src = stripComments(readFileSync(full, 'utf8'));
  const rel = relative(SRC, full).split(sep).join('/');

  // 1. 裸 'element-plus' 的命名 import（跳过整条 import 就是 type-only 的）
  const components = new Set<string>();
  let line = 0;
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'element-plus'/g)) {
    if (m[1]) continue;
    if (line === 0) line = src.slice(0, m.index).split('\n').length;
    for (const spec of (m[2] as string).split(',')) {
      const name = spec.trim();
      // 内联 `type Xxx` 也是纯类型（UploadFile / TableInstance / FormInstance / FormRules…）
      if (!name || /^type\s/.test(name)) continue;
      if (IMPERATIVE_APIS.has(name)) continue;
      components.add(epNameToKebab(name));
    }
  }
  if (components.size === 0) return null;

  // 2. 本文件已 import 的 EP 样式（三种形态）+ 其传递闭包
  const direct = new Set<string>();
  for (const m of src.matchAll(
    /element-plus\/es\/components\/([a-z0-9-]+)\/style\/(?:css|index)/g,
  )) {
    direct.add(`el-${m[1] as string}`);
  }
  for (const m of src.matchAll(/element-plus\/theme-chalk\/el-([a-z0-9-]+)\.css/g)) {
    direct.add(`el-${m[1] as string}`);
  }
  const covered = styleClosure([...direct]);
  const missing = [...components].filter((c) => !covered.has(c)).sort();
  if (missing.length === 0) return null;
  return { file: rel, line, missing };
}

describe('手动 import 的 EP 组件必须自带样式 import', () => {
  const violations: Violation[] = [];
  for (const f of collectVueFiles(SRC)) {
    const v = scanFile(f);
    if (v) violations.push(v);
  }

  it('违规项（扣除存量豁免后）为 0', () => {
    // 逐项按豁免表扣减：只放行豁免表里点名的 kebab 名，同文件其它未覆盖名仍算违规。
    const effective: Violation[] = [];
    for (const v of violations) {
      const allowed = new Set(EXEMPT[v.file] ?? []);
      const left = v.missing.filter((m) => !allowed.has(m));
      if (left.length > 0) effective.push({ ...v, missing: left });
    }
    if (effective.length > 0) {
      const list = effective
        .map((v) => `  src/${v.file}:${v.line}  缺样式：${v.missing.join('、')}`)
        .join('\n');
      throw new Error(
        `发现 ${effective.length} 个文件手动 import 了 EP 组件却没 import 对应样式` +
          `（unplugin-vue-components 遇脚本已绑定的同名组件会跳过 style 注入，样式丢失）：\n${list}\n` +
          '修复：在该文件的 import 区加副作用 import，例如\n' +
          "  import 'element-plus/es/components/select/style/css';\n" +
          '每个入口的传递闭包会连带覆盖 option / tag / popper / input 等，不必逐个列。' +
          '若该文件确属已知的存量豁免，请在 EXEMPT 表里登记对应 kebab 名。',
      );
    }
    expect(effective.length).toBe(0);
  });

  // 豁免表是「按组件名」放行的，所以某个已豁免文件将来新引入的未覆盖组件照样会红。
  // 唯一的慢性风险是反向的：某文件补齐样式后忘了删表项 → 该名字静默长期豁免。
  // 这条断言把「补齐」和「删表项」绑成一次改动。
  it('豁免表无陈旧登记：登记的每个名字仍须是该文件实际未覆盖的组件', () => {
    const stale: string[] = [];
    const byFile = new Map(violations.map((v) => [v.file, v]));
    for (const file of Object.keys(EXEMPT)) {
      const v = byFile.get(file);
      // 文件已完全合规 → 整条登记都过期
      if (!v) {
        stale.push(`src/${file} → 登记的 ${EXEMPT[file].join('、')}（该文件已不再违规）`);
        continue;
      }
      for (const name of EXEMPT[file]) {
        if (!v.missing.includes(name)) stale.push(`src/${file} → ${name}`);
      }
    }
    if (stale.length > 0) {
      throw new Error(
        `EXEMPT 表里有 ${stale.length} 条陈旧登记（对应组件已覆盖样式，登记变成永久豁免）：\n` +
          stale.map((s) => `  ${s}`).join('\n') +
          '\n修复：删掉 EXEMPT 里对应的条目。',
      );
    }
    expect(stale.length).toBe(0);
  });
});
