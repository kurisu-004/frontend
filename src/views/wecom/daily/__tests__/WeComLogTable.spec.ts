// src/views/wecom/daily/__tests__/WeComLogTable.spec.ts
//
// 2026-10-17 新建：`WeComLogTable.vue` 的**源码契约**守卫（本文件不挂载组件）。
//
// 守的是三组很容易被改坏、而症状要么看不出来要么需要现场才复现的东西：
//
//  1. **「条数」列的三条渲染规则**（已逐条确认）：`chunk_count === 0` → `—` + title；`chunk_sent
//    < chunk_count` → `.error-text`；其余 → 默认。三者都要在源码里各占一条分支。
//  2. **零 el-tag + :deep 整行标红**：失败行已由 `:row-class-name` → `:deep(.el-table__row
//    .is-failed > td.el-table__cell)` 整行标红（`el-table` 的 row-class-name 只能整行上色、
//    没法只染一格），再套一枚红 tag 是双重编码且撑宽度。
//  3. **两组「刻意不做」的列**：日报的 6 个计数字段 + `report_date`（恒等于 `sent_at` 的日期
//    部分）。它们「很有用」的直觉正是本域的判断依据 —— 一旦有人按邮件域那张表补齐，表就从
//    「投递流水」退化成「内容快照」，两者混在一起会让内容口径问题看起来像投递故障。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../components/WeComLogTable.vue', import.meta.url), 'utf8');

/** 剥掉**注释**后的源码（HTML 块注释 + 脚本块注释 + 整行 `//` 注释）—— 本组件的文件头**刻意
 *  在列出那些「刻意不做的列」**，那些字段名会原样出现在注释里；不剥的话下面的负向断言会被自己
 *  的文件头判红。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(SRC);

/** 8 个 `el-table-column` 的模板块（按出现顺序）。 */
const columns = CODE.match(/<el-table-column[\s\S]*?(?:\/>|<\/el-table-column>)/g) ?? [];

describe('WeComLogTable.vue — 8 列齐全', () => {
  it('C1：恰好 8 列，列序 = 时间 / 来源 / 状态 / 条数 / 推送对象 / 逾期 / 3日内 / 错误信息', () => {
    expect(columns).toHaveLength(8);
    const labels = columns.map((c) => {
      const m = c.match(/label="([^"]*)"/);
      return m ? m[1] : (c.match(/prop="([^"]*)"/)?.[1] ?? '');
    });
    expect(labels).toEqual(['时间', '触发来源', '状态', '条数', '推送对象', '逾期', '3日内', '错误信息']);
  });

  it('C2：min-width 逐条对齐契约（160/100/90/90/180/80/80/240）', () => {
    const widths = columns.map((c) => Number(c.match(/min-width="(\d+)"/)?.[1]));
    expect(widths).toEqual([160, 100, 90, 90, 180, 80, 80, 240]);
  });

  it('C3：错误信息列带 show-overflow-tooltip（长报错不必换行）', () => {
    const errCol = columns[7]!;
    expect(errCol).toMatch(/show-overflow-tooltip/);
  });

  it('C4：推送对象列的 title 是 `webhook_masked`（完整地址永不出参，掩码才是能给人看的）', () => {
    expect(columns[4]).toMatch(/:title="row\.webhook_masked"/);
    expect(columns[4]).toMatch(/\{\{ row\.webhook_name \}\}/);
  });
});

describe('WeComLogTable.vue — 「条数」列的三条渲染规则', () => {
  const chunkCol = columns[3]!;

  it('K1：`chunk_count === 0` → `—` + 说明 title', () => {
    expect(chunkCol).toMatch(/v-if="row\.chunk_count === 0"/);
    expect(chunkCol).toMatch(/title="发送前准备失败，未进入分片渲染"/);
    expect(chunkCol).toMatch(/class="muted"/);
    expect(chunkCol).toMatch(/>—</);
  });

  it('K2：`chunk_sent < chunk_count` → `.error-text`', () => {
    expect(chunkCol).toMatch(/v-else-if="row\.chunk_sent < row\.chunk_count"/);
    expect(chunkCol).toMatch(/class="error-text"/);
  });

  it('K3：其余 → 默认样式（不套 class）', () => {
    expect(chunkCol).toMatch(/v-else>\{\{ chunkText\(row as WeComDailyLogData\) \}\}/);
  });

  it('K4：三条分支的顺序就是判定优先级（0 条 → 部分失败 → 全部发出）', () => {
    const iZero = chunkCol.indexOf('v-if="row.chunk_count === 0"');
    const iPartial = chunkCol.indexOf('v-else-if="row.chunk_sent < row.chunk_count"');
    const iRest = chunkCol.indexOf('v-else>');
    expect(iZero).toBeGreaterThanOrEqual(0);
    expect(iPartial).toBeGreaterThan(iZero);
    expect(iRest).toBeGreaterThan(iPartial);
  });

  it('K5：**零 el-tag**（失败行已整行标红，再套红 tag 是双重编码）', () => {
    expect(chunkCol).not.toMatch(/el-tag/);
    // ⚠️ 反向：整行标红必须还在（去掉它就只剩「条数」这一格有信号了）。
    expect(CODE).toMatch(/row-class-name="rowClassName"/);
    expect(CODE).toMatch(/row\.status === 'FAILED' \? 'is-failed' : ''/);
  });
});

describe('WeComLogTable.vue — 整行标红必须走 :deep', () => {
  it('R1：`:deep(.el-table__row.is-failed > td.el-table__cell)` 上 danger-light-9', () => {
    // EP 把 row-class-name 加在 `<tr>` 上（不在本组件模板里渲染）⇒ scoped 选择器带不上
    // scopeId，必须 :deep 才命中。少了 :deep 的症状是「失败行不标红」且零报错。
    expect(CODE).toMatch(
      /:deep\(\.el-table__row\.is-failed > td\.el-table__cell\)\s*\{\s*background: var\(--el-color-danger-light-9\) !important;/,
    );
  });

  it('R2：`.muted` / `.error-text` 也走 :deep（它们渲染在列的默认槽里，属 el-table 的子树）', () => {
    expect(CODE).toMatch(/:deep\(\.muted\)/);
    expect(CODE).toMatch(/:deep\(\.error-text\)/);
  });
});

describe('WeComLogTable.vue — 刻意不做的东西', () => {
  it('N1：日报的 6 个计数字段一律**不做列**', () => {
    // 理由：企业微信的日报在群里还看得到，重复存储没意义；且内容口径问题与投递故障混在
    // 一张表里会互相干扰排查。
    for (const field of [
      'overview_batch_count',
      'overview_quantity',
      'note_count',
      'note_part_count',
      'worker_row_total',
      'markdown_bytes',
    ]) {
      expect(CODE, `${field} 不该做列`).not.toMatch(new RegExp(`prop="${field}"`));
    }
  });

  it('N2：report_date **不建「统计日」列**（恒等于 sent_at 的日期部分，纯冗余）', () => {
    expect(CODE).not.toMatch(/prop="report_date"/);
    expect(CODE).not.toMatch(/label="统计日"/);
  });

  it('N3：不挂 ColumnVisibilityPopover / 拖拽（8 列都是排查必需信息）', () => {
    expect(CODE).not.toMatch(/ColumnVisibilityPopover|vuedraggable|Sortable/);
  });

  it('N4：naive timestamp 走**字符串切片**，不走 utils/date.ts（会整体平移 8 小时）', () => {
    expect(CODE).toMatch(/raw\.replace\('T', ' '\)/);
    expect(CODE).toMatch(/normalized\.slice\(0, 16\)/);
    expect(CODE).not.toMatch(/from '@\/utils\/date'/);
  });
});
