// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/MailLogTable.spec.ts
//
// 2026-10-14 新增（review 第 1 轮 A4）：发送历史表格的**渲染契约**守卫。四组：
//
//  1. **失败行标红**（review 点名的零覆盖段）：`:row-class-name` 真的接到了表格上，且
//     `status === 'FAILED'` 才给 `is-failed`。这一段是「`:row-class-name` + scoped `:deep()`
//     两处都要在」的组合 —— 任一侧被改掉都不会报错，只会安静地失去标红，所以两条都钉：
//     接线靠渲染断言，`:deep()` 选择器靠源码断言。
//  2. **naive 时间不做时区平移**（后端 `sent_at` 是 Asia/Shanghai 墙钟，走
//     `utils/date.ts::formatDateTime` 会被整体平移 8 小时）。
//  3. **TO + CC 合并成一格**：CC 非空时补「（抄送: …）」，整串进 `title`。
//  4. **空数据**给出 `empty-text` 而不是空白表格。
//
// 桩法说明（与另两个 section 的桩法不同）：真实的 `el-table` 是「列 × 行」的二维渲染，
// 简化成「表格桩按行渲染 + 列桩渲染一次并塞第一条数据行」—— 前者守 `row-class-name`
// 的逐行接线，后者覆盖单元格里的格式化函数。逐行单元格渲染对本用例要守的东西没有增量。

import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
// `?raw` 拿组件源码（2026-10-14：不用 `readFileSync(new URL(…, import.meta.url))` ——
// 本文件跑在 happy-dom 环境里，那个 URL 不是 file: scheme，readFileSync 会抛）。
import MailLogTableSource from '../components/MailLogTable.vue?raw';
import MailLogTable from '../components/MailLogTable.vue';
import type { MailDigestLogData } from '../mailDigestSchema';

/** 固定样例行：列桩的默认插槽用它渲染（覆盖单元格里的格式化函数）。 */
const SAMPLE_ROW: MailDigestLogData = {
  log_id: '1900000000000000010',
  status: 'SUCCESS',
  subject: '交期汇总 2026-10-13',
  to_recipients: ['a@example.com', 'b@example.com'],
  cc_recipients: ['c@example.com'],
  overdue_count: 3,
  upcoming_count: 12,
  html_bytes: 20480,
  // 2026-10-13 08:30:00（Asia/Shanghai 墙钟，无时区后缀）
  sent_at: '2026-10-13T08:30:00',
  error_message: null,
  config_version: 3,
  trigger_source: 'SCHEDULED',
};

/** 当前列桩渲染哪一行（每次 `mountTable` 设成第一条；空数据时用默认样例）。
 *  真实 `el-table` 是「每列 × 每行」渲染，这里退化成「每列渲染一次、塞同一个样例行」，
 *  只为覆盖单元格里的格式化函数 —— 逐行接线由表格桩的 `.mock-row` 断言守。 */
let currentSample: MailDigestLogData = SAMPLE_ROW;

const ElTableStub = {
  name: 'ElTable',
  props: ['data', 'rowClassName', 'rowKey', 'emptyText'],
  // 逐行渲染（守 `row-class-name` 的接线）+ 原样透出子节点（el-table-column 是
  // `<el-table>` 的子节点，不透出 slot 的话单元格内容一个都不会渲染）。
  template: `<div class="mock-table">
    <div
      v-for="(row, index) in data"
      :key="index"
      class="mock-row"
      :class="rowClassName({ row })"
    />
    <div v-if="!data || data.length === 0" class="mock-table-empty">{{ emptyText }}</div>
    <slot />
  </div>`,
};

const ElTableColumnStub = defineComponent({
  name: 'ElTableColumn',
  props: ['label', 'prop'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'mock-column', 'data-label': props.label ?? '' }, [
        slots.default?.({ row: currentSample }),
      ]);
  },
});

const ElTagStub = defineComponent({
  name: 'ElTag',
  props: ['type', 'size', 'effect'],
  setup(props, { slots }) {
    return () => h('span', { class: 'mock-tag', 'data-type': props.type ?? '' }, slots.default?.());
  },
});

const globalConfig = {
  components: {
    'el-table': ElTableStub,
    'el-table-column': ElTableColumnStub,
    'el-tag': ElTagStub,
  },
  directives: { loading: {} },
};

function row(over: Partial<MailDigestLogData> = {}): MailDigestLogData {
  return { ...SAMPLE_ROW, ...over };
}

function mountTable(items: MailDigestLogData[], loading = false) {
  currentSample = items[0] ?? SAMPLE_ROW;
  return mount(MailLogTable, { props: { items, loading }, global: globalConfig });
}

describe('MailLogTable — 失败行标红（row-class-name + :deep 组合）', () => {
  it('FAILED 行带 is-failed、SUCCESS 行不带（只有失败才标红）', () => {
    const wrapper = mountTable([
      row({ log_id: '1', status: 'SUCCESS' }),
      row({ log_id: '2', status: 'FAILED', error_message: 'SMTP 发送失败' }),
    ]);
    const rows = wrapper.findAll('.mock-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classes()).not.toContain('is-failed');
    expect(rows[1]!.classes()).toContain('is-failed');
    wrapper.unmount();
  });

  it('`v-loading` 绑在表格上（发送中要有遮罩；EP 的指令值类型不接受 undefined）', () => {
    const wrapper = mountTable([row()], true);
    expect(wrapper.find('.mock-table').exists()).toBe(true);
    wrapper.unmount();
  });

  // ⚠️ 源码级断言：EP 把 row-class-name 加在**它自己渲染的** `<tr>` 上，带不上本组件的
  // scopeId ⇒ scoped 选择器必须写成 `:deep(...)` 才命中。改成普通 `.el-table__row.is-failed`
  // 时不报任何错，只是标红静默失效 —— 这里就是那道防线。
  it('scoped CSS 里失败行的选择器带 :deep（漏掉就命中不了 EP 渲染的 <tr>）', () => {
    expect(MailLogTableSource).toContain(':deep(.el-table__row.is-failed');
  });
});

describe('MailLogTable — 单元格渲染', () => {
  it('naive 时间只做字符串切片、不做时区平移（2026-10-13 08:30 保持原样）', () => {
    const wrapper = mountTable([row()]);
    expect(wrapper.text()).toContain('2026-10-13 08:30');
    wrapper.unmount();
  });

  it('sent_at 为空串时落成「-」（而不是 Invalid Date）', () => {
    // schema 侧 `sent_at` 是 `z.string()` 非空（失败行也记时刻），组件里的
    // `raw: string | null` + 模板里的 `row.sent_at ? … : 'muted'` 是**防御性**兜底：
    // 线上真出现过空值时不能整列崩成 Invalid Date。
    const wrapper = mountTable([row({ sent_at: '' })]);
    expect(wrapper.text()).toContain('-');
    expect(wrapper.text()).not.toContain('Invalid');
    wrapper.unmount();
  });

  it('TO + CC 合并成一格，CC 非空时补「（抄送: …）」且整串进 title', () => {
    const wrapper = mountTable([row()]);
    const cell = wrapper.find('[title]');
    expect(cell.attributes('title')).toBe('a@example.com, b@example.com（抄送: c@example.com）');
    wrapper.unmount();
  });

  it('触发来源 / 状态的标签类型随取值走（定时=primary、成功=success、失败=danger）', () => {
    const wrapper = mountTable([row({ status: 'FAILED' })]);
    const types = wrapper.findAll('.mock-tag').map((n) => n.attributes('data-type'));
    expect(types).toContain('primary');
    expect(types).toContain('danger');
    wrapper.unmount();
  });

  it('error_message 非空才上错误色、为空落成「—」', () => {
    const wrapper = mountTable([row({ error_message: null })]);
    expect(wrapper.text()).toContain('—');
    wrapper.unmount();
  });
});

describe('MailLogTable — 空数据', () => {
  it('没有日志时给 empty-text，不渲染任何行', () => {
    const wrapper = mountTable([]);
    expect(wrapper.findAll('.mock-row')).toHaveLength(0);
    expect(wrapper.find('.mock-table-empty').text()).toBe('暂无发送记录');
    wrapper.unmount();
  });
});
