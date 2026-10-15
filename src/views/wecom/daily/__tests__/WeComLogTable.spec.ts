// @vitest-environment happy-dom
// src/views/wecom/daily/__tests__/WeComLogTable.spec.ts
//
// 2026-10-17 新建：`WeComLogTable.vue` 的守卫。本文件是**源码契约 + D 组挂载**两种形态：
// 源码契约那几组读 `?raw`（不挂载），D 组挂载组件、只断言表头的**渲染结果**。
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
//  4. **「N 日内」表头由 prop 驱动**（`upcomingDays` ← 壳的 `store.query.form.upcoming_days`）：
//    这一列数的是管理员可配的 `upcoming_days`（后端下发 1..60、默认 3），表头写死「3日内」在
//    改成 7 天之后就成了一句假话。C1 只守「不写死」，真正的取值与回落由 D 组**挂载**用例守 ——
//    源码正则看不出 computed 的求值结果。
//
// ⚠️ 本文件一半是源码契约（不挂载）、一半是挂载用例（D 组）。挂载只为了断言表头的**渲染结果**
// （label 是纯 computed，与 el-table 的列插槽作用域无关），所以 EP 组件桩到「只吐 label」就够，
// 复刻 el-table ↔ el-table-column 的行作用域协议反而会让断点变得不清晰（照
// `views/inspection/__tests__/InspectionTable.spec.ts` 的同款取舍）。

import { describe, expect, it } from 'vitest';
import { defineComponent, h, type Directive } from 'vue';
import { mount } from '@vue/test-utils';
// `?raw` 拿组件源码（不用 `readFileSync(new URL(…, import.meta.url))` —— 本文件跑在 happy-dom
// 环境里，那个 URL 不是 file: scheme，readFileSync 会抛；照
// `views/mail/digest/__tests__/MailLogTable.spec.ts` 的同款做法）。
import WeComLogTableSource from '../components/WeComLogTable.vue?raw';
import WeComLogTable from '../components/WeComLogTable.vue';
import type { WeComDailyLogData } from '../weComDailySchema';

const SRC = WeComLogTableSource;

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
  it('C1：恰好 8 列，列序 = 时间 / 来源 / 状态 / 条数 / 推送对象 / 逾期 / N日内 / 错误信息', () => {
    expect(columns).toHaveLength(8);
    const labels = columns.map(
      // ⚠️ 顺序有讲究：`/label="([^"]*)"/` 连 `:label="…"` 也会命中（前者是后者的子串），
      // 所以绑定式表头在这一步就已经取到了 —— **不要再叠一个 `:label=` 分支**，那是永远走不到的
      // 死分支。`prop=` 是唯一的兜底：某个列连 `label` 属性都没有时，用它的锚名让报错可读
      //（C1 随后拿它与 8 项字面量比对，缺 label 的列照样当场红）。
      (c) => c.match(/label="([^"]*)"/)?.[1] ?? c.match(/prop="([^"]*)"/)?.[1] ?? '',
    );
    expect(labels).toEqual([
      '时间',
      '触发来源',
      '状态',
      '条数',
      '推送对象',
      '逾期',
      'upcomingLabel',
      '错误信息',
    ]);
    // ⚠️ **「N 日内」这一格不许是字面量**：`upcoming_days` 是管理员可配的（后端下发 1..60、
    // 默认 3），表头写死「3日内」在改成 7 天之后就在说谎。绑定到 computed 是唯一的合法形态；
    // 渲染出来的值由下面的 D 组用例守。
    expect(columns[6]).toMatch(/:label="upcomingLabel"/);
    expect(columns[6]).toMatch(/prop="upcoming_count"/);
    expect(CODE).not.toMatch(/label="3日内"/);
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

  it('N4：naive timestamp 走**跨域共用的字符串切片**，不走 utils/date.ts（会整体平移 8 小时）', () => {
    // 切片函数是 `utils/naiveDateTime.ts` 全仓唯一一份（与「Webhook 配置」tab 那张表、
    // 账号管理的「最后登录」列共用：一处 `2026-10-17 08:30:00`、另一处 `2026-10-17 08:30`
    // 没法让人判断两处是不是同一次操作）。
    expect(CODE).toMatch(/import \{ formatNaiveDateTime \} from '@\/utils\/naiveDateTime'/);
    expect(CODE).not.toMatch(/from '@\/utils\/date'/);
    // `prop` 仍是列的锚（EP 的 row-key / 排序域），但**单元格渲染必须过切片** —— 只留
    // `prop` 不给插槽，EP 就直接渲染原始字符串，秒与小数会原样怼进格子。
    expect(columns[0]).toMatch(/prop="sent_at"/);
    expect(columns[0]).toMatch(/\{\{ formatNaiveDateTime\(row\.sent_at\) \}\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D 组：「N 日内」表头的**渲染结果**（唯一需要挂载的一组）
// ═══════════════════════════════════════════════════════════════════════════

const LOG_ROW: WeComDailyLogData = {
  log_id: '9000000000000900',
  config_version: 3,
  trigger_source: 'SCHEDULED',
  status: 'SUCCESS',
  webhook_name: '生产群',
  webhook_masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
  report_date: '2026-10-17',
  markdown_bytes: 5120,
  chunk_count: 2,
  chunk_sent: 2,
  overview_batch_count: 12,
  overview_quantity: 340,
  note_count: 0,
  note_part_count: 56,
  overdue_count: 2,
  upcoming_count: 7,
  worker_row_total: 22,
  error_message: null,
  sent_at: '2026-10-17 08:00:00',
};

const loadingDirective: Directive<HTMLElement, unknown> = {
  mounted(el, binding) {
    el.dataset.loading = String(binding.value);
  },
  updated(el, binding) {
    el.dataset.loading = String(binding.value);
  },
};

/** `el-table-column` 桩**只吐 label**（不渲染默认槽）：本组断言的表头与列作用域协议无关，
 *  复刻它只会让断点变糊。`data-label` 就是 EP 真实的表头取值。 */
const ElTableColumnStub = defineComponent({
  name: 'ElTableColumn',
  props: ['label', 'prop', 'minWidth', 'align', 'showOverflowTooltip'],
  setup(props) {
    return () =>
      h('div', {
        class: 'mock-col',
        'data-label': props.label ?? '',
        'data-prop': props.prop ?? '',
      });
  },
});

const globalConfig = {
  directives: { loading: loadingDirective },
  components: {
    'el-table': {
      name: 'ElTable',
      props: ['data', 'rowKey'],
      template: '<div class="mock-table"><slot /></div>',
    },
    'el-table-column': ElTableColumnStub,
    'el-tag': { name: 'ElTag', template: '<span class="mock-tag"><slot /></span>' },
  },
};

/** 第 7 列（0-based 6）渲染出来的表头。 */
function renderedUpcomingLabel(upcomingDays?: number | string): string {
  const wrapper = mount(WeComLogTable, {
    props: { items: [LOG_ROW], upcomingDays },
    global: globalConfig,
  });
  const cols = wrapper.findAll('.mock-col');
  const label = cols[6]?.attributes('data-label') ?? '';
  wrapper.unmount();
  return label;
}

describe('WeComLogTable.vue — 「N 日内」表头跟着配置走（D 组，挂载）', () => {
  it('D1：prop 为 7 时表头渲染成 `7日内`（写死「3日内」的守卫信号）', () => {
    expect(renderedUpcomingLabel(7)).toBe('7日内');
    expect(renderedUpcomingLabel(30)).toBe('30日内');
  });

  it('D2：字符串数字照样采用（输入组件与 v-model 之间的类型边界不该让表头说谎）', () => {
    expect(renderedUpcomingLabel('7')).toBe('7日内');
  });

  it('D3：空 / 非数字回落成后端默认的 `3日内`（表头宁可给合法值也不能是空标签）', () => {
    expect(renderedUpcomingLabel(undefined)).toBe('3日内');
    expect(renderedUpcomingLabel('')).toBe('3日内');
    expect(renderedUpcomingLabel(Number.NaN)).toBe('3日内');
  });

  it('D4：8 列一个不少，且第 7 列的 prop 仍是 upcoming_count（表头换了、数没换）', () => {
    const wrapper = mount(WeComLogTable, {
      props: { items: [LOG_ROW], upcomingDays: 7 },
      global: globalConfig,
    });
    const cols = wrapper.findAll('.mock-col');
    expect(cols).toHaveLength(8);
    expect(cols[6]!.attributes('data-prop')).toBe('upcoming_count');
    wrapper.unmount();
  });
});
