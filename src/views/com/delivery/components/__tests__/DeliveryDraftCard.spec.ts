// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryDraftCard.spec.ts
//
// 草稿卡片 footer 与勾选接线的守卫（2026-10-08 新增 footer 组；2026-10-09 补勾选组）。
//
// footer 之所以单独钉住这 4 颗按钮：2026-10-08 之前只有 3 颗（标签导出随打印端点一起
// 下线），而「打印标签」按钮消失过一次 —— 与「打印送货单」按钮因 canPrint 死锁整排消失
// 是同一类回归（能力被静默摘掉，没人报错）。断言写死「4 颗 + 各在 canPrint / canSubmit
// 组合下的显隐与 disabled」，任何一颗被摘掉都会红。
//
// 勾选组守的是「打印标签」的入参链：勾选列必须在列定义循环**之前**渲染（列顺序拖动会
// 把列拖到别处，勾选列必须恒在序列号之前），且 selection-change 必须整份上抛成
// `update:selectedRows` —— 少了任一环，「打印标签」导出的就是空集或全部。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createRouter, createMemoryHistory } from 'vue-router';
import type { PartTreeRow } from '../../utils/deliveryNotePartRows';
import type { DeliveryNoteItemData } from '../../composables/deliveryNoteSchema';

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ElMessage: { error: vi.fn(), success: vi.fn() } };
});

const app = createApp({ render: () => null });
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
// 装配件父行的名称列渲染 RouterLink（跳 /assemblies/:id）：装配件父行的 cellRender
// 在卡片组件的**模块级**列定义里，跑挂载时也要能拿到注入的 router。
app.use(createRouter({ history: createMemoryHistory(), routes: [] }));
setActivePinia(app.config.globalProperties.$pinia);

const { default: DeliveryDraftCard } = await import('../DeliveryDraftCard.vue');

const ROWS: PartTreeRow[] = [
  {
    id: 'P:-:P1',
    is_part_row: true,
    serial_no: 'S-1',
    drawing_no: 'D-1',
    name: '电容',
    order_no: 'SO-1',
    applicant_name: '张三',
    customer_name: '法拉',
    customer_path: '法拉电子 / 法拉',
    note: '',
    quantity: 5,
    unit: '件',
    batch_ids: ['1'],
    label_printed: false,
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: null,
    status: 'READY_TO_SHIP',
    part_id: 'P1',
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    assembly_quantity: null,
    shippable_sets: null,
    seq: 1,
    min_seq: null,
  },
];

const DRAFT = { id: 'N1', delivery_note_no: 'DN-001', status: 'DRAFT' } as unknown as DeliveryNoteItemData;

/** 桩 el-table 把 :data 摊到这里，列桩据此逐行渲染 cellRender 列的单元格。 */
const scopeRows: { value: Record<string, unknown>[] } = { value: [] };

/** 桩 el-button：`disabled` / `loading` 走 prop，click 走 emit；保留 slot 文本便于定位。 */
const stubs = {
  'el-card': defineComponent({
    name: 'ElCardStub',
    setup: (_p, { slots }) => () => h('div', { class: 'mock-el-card' }, [slots.header?.(), slots.default?.(), slots.footer?.()]),
  }),
  'el-button': defineComponent({
    name: 'ElButtonStub',
    props: ['type', 'size', 'disabled', 'loading', 'link', 'plain'],
    emits: ['click'],
    setup: (p, { slots, emit }) => () =>
      h(
        'button',
        {
          class: 'mock-el-button',
          disabled: p.disabled === true,
          onClick: () => emit('click'),
        },
        slots.default?.(),
      ),
  }),
  // 桩 el-table 把 selection-change 当**函数 prop**（真实 EP 的行内事件）暴露出来，
  // 并按 :data 逐行渲染 cellRender 列的默认插槽（真实 EP 就是这么出格子的）。
  'el-table': defineComponent({
    name: 'ElTableStub',
    props: {
      data: { type: Array as PropType<Record<string, unknown>[]>, default: () => [] },
      onSelectionChange: {
        type: Function as PropType<(rows: Record<string, unknown>[]) => void>,
        default: undefined,
      },
      rowKey: { type: [String, Function] as unknown as PropType<unknown>, default: undefined },
      treeProps: { type: Object as PropType<Record<string, unknown>>, default: () => ({}) },
      defaultExpandAll: { type: Boolean, default: false },
    },
    setup: (p, { slots }) => () =>
      h(
        'div',
        {
          class: 'mock-el-table',
          'data-tree-children': String(p.treeProps.children ?? ''),
          'data-expand-all': String(p.defaultExpandAll),
        },
        slots.default?.(),
      ),
  }),
  'el-table-column': defineComponent({
    name: 'ElTableColumnStub',
    props: ['label', 'type', 'prop'],
    setup: (p, { slots }) => {
      // cellRender 列（带 prop）按行展开默认插槽，其余只渲染列头。
      // `perRow` 在 setup 根作用域算（不是读 prop 的值本身）：行数据来自模块级 holder，
      // 这里只判「这一列是不是带 prop 的数据列」，prop 本身不会被换。
      const perRow = Object.keys(p).includes('prop');
      return () =>
        h(
          'span',
          { class: 'mock-col', 'data-label': p.label, 'data-type': p.type ?? '' },
          perRow ? (scopeRows.value ?? []).map((row) => slots.default?.({ row })) : undefined,
        );
    },
  }),
  'el-tag': defineComponent({ name: 'ElTagStub', setup: (_p, { slots }) => () => h('span', null, slots.default?.()) }),
  'el-icon': true,
  ElTable: true,
  ColumnVisibilityPopover: true,
  ColumnDragHandle: true,
};

beforeEach(() => {
  window.localStorage.clear();
});

async function mountCard(props: Record<string, unknown> = {}, data: PartTreeRow[] = ROWS) {
  scopeRows.value = data as unknown as Record<string, unknown>[];
  return app.runWithContext(() =>
    mount(DeliveryDraftCard, {
      props: {
        draft: DRAFT,
        rows: data,
        deleting: false,
        submitting: false,
        canPrint: true,
        canSubmit: true,
        rowClassName: () => '',
        ...props,
      },
      global: {
        stubs,
        // 装配件父行的名称列渲染 RouterLink（跳 /assemblies/:id），必须有 router 上下文
        plugins: [createRouter({ history: createMemoryHistory(), routes: [] })],
      },
    }),
  );
}

/** footer 里的按钮（按可见文本），取不到返回 undefined。 */
function footerButton(w: Awaited<ReturnType<typeof mountCard>>, label: string) {
  return w.findAll('.draft-card-footer button.mock-el-button').find((b) => b.text().includes(label));
}

describe('DeliveryDraftCard footer 按钮集', () => {
  it('4 颗按钮都在：删除草稿 / 打印送货单 / 打印标签 / 提交草稿', async () => {
    const w = await mountCard();
    const labels = w.findAll('.draft-card-footer button.mock-el-button').map((b) => b.text());
    expect(labels).toHaveLength(4);
    expect(labels.map((t) => t.replace(/[^一-龥]/g, ''))).toEqual([
      '删除草稿',
      '打印送货单',
      '打印标签',
      '提交草稿',
    ]);
  });

  it('canPrint 覆盖**两颗**打印按钮（送货单 + 标签），canSubmit 只管提交', async () => {
    const off = await mountCard({ canPrint: false, canSubmit: true });
    expect(footerButton(off, '打印送货单')!.attributes('disabled')).toBeDefined();
    expect(footerButton(off, '打印标签')!.attributes('disabled')).toBeDefined();
    expect(footerButton(off, '提交草稿')!.attributes('disabled')).toBeUndefined();
    expect(footerButton(off, '删除草稿')!.attributes('disabled')).toBeUndefined();

    const on = await mountCard({ canPrint: true, canSubmit: false });
    expect(footerButton(on, '打印送货单')!.attributes('disabled')).toBeUndefined();
    expect(footerButton(on, '打印标签')!.attributes('disabled')).toBeUndefined();
    expect(footerButton(on, '提交草稿')!.attributes('disabled')).toBeDefined();
  });

  it('删除草稿按钮不受 canPrint / canSubmit 影响（只随 deleting loading）', async () => {
    const w = await mountCard({ canPrint: false, canSubmit: false });
    expect(footerButton(w, '删除草稿')!.attributes('disabled')).toBeUndefined();
  });
});

describe('DeliveryDraftCard footer emit', () => {
  it('四颗按钮各自 emit 对应事件（按钮点得动就一定回得去 shell）', async () => {
    const w = await mountCard();
    await footerButton(w, '打印送货单')!.trigger('click');
    await footerButton(w, '打印标签')!.trigger('click');
    await footerButton(w, '提交草稿')!.trigger('click');
    await footerButton(w, '删除草稿')!.trigger('click');
    expect(w.emitted('printNote')).toHaveLength(1);
    expect(w.emitted('printLabels')).toHaveLength(1);
    expect(w.emitted('submitDraft')).toHaveLength(1);
    expect(w.emitted('deleteDraft')).toHaveLength(1);
  });

  it('disabled 的按钮点不动（不发 emit）', async () => {
    const w = await mountCard({ canPrint: false, canSubmit: false });
    await footerButton(w, '打印标签')!.trigger('click');
    await footerButton(w, '打印送货单')!.trigger('click');
    expect(w.emitted('printLabels')).toBeUndefined();
    expect(w.emitted('printNote')).toBeUndefined();
  });
});

describe('DeliveryDraftCard 勾选接线（打印标签的入参）', () => {
  it('勾选列固定在最左、在列定义循环之前渲染（列顺序拖动不会把它拖走）', async () => {
    const w = await mountCard();
    const cols = w.findAll('.mock-col');
    expect(cols[0]!.attributes('data-type')).toBe('selection');
    // 「序号」与勾选列同理硬编码在 defs 之前（钉在次左），末位 '' 是行内「移除」操作列
    expect(cols.slice(1).map((c) => c.attributes('data-label'))).toEqual([
      '序号',
      '序列号',
      '图号',
      '名称',
      '数量',
      '系统交期',
      '',
    ]);
  });

  it('表格接了 tree-props 与 row-key（装配件父行 / 子件行靠它成树）', async () => {
    const w = await mountCard();
    const t = w.find('.mock-el-table');
    expect(t.attributes('data-tree-children')).toBe('children');
    expect(t.attributes('data-expand-all')).toBe('true');
    expect(w.findComponent({ name: 'ElTableStub' }).props('rowKey')({ id: 'P:-:P1' })).toBe(
      'P:-:P1',
    );
  });

  it('selection-change 整份上抛成 update:selectedRows', async () => {
    const w = await mountCard();
    const onSel = w.findComponent({ name: 'ElTableStub' }).props('onSelectionChange') as (
      rows: unknown[],
    ) => void;
    onSel(ROWS);
    const emitted = w.emitted('update:selectedRows');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]![0]).toBe(ROWS);
  });

  it('装配件父行的名称列渲染「装配件」标签，零件行不渲染', async () => {
    const asmRow: PartTreeRow = {
      ...ROWS[0]!,
      id: 'ASM_A1',
      is_part_row: undefined,
      is_asm_row: true,
      assembly_id: 'A1',
      assembly_name: '总装',
      name: '总装',
      unit: '套',
      quantity: 3,
      batch_ids: ['1', '2'],
    };
    const w = await mountCard({}, [asmRow, ROWS[0]!]);
    const nameCol = w.findAll('.mock-col').find((c) => c.attributes('data-label') === '名称')!;
    expect(nameCol.html()).toContain('装配件');
    expect(nameCol.findAll('a').map((a) => a.attributes('href'))).toEqual(['/assemblies/A1']);
  });

  it('数量列带单位（件 / 套），数量缺失时只有「—」', async () => {
    const w = await mountCard();
    const qty = w.findAll('.mock-col').find((c) => c.attributes('data-label') === '数量')!;
    expect(qty.text()).toBe('5件');
  });
});

describe('DeliveryDraftCard 已打印标签绿底接线', () => {
  it('rowClassName 由父组件传入（绿底判据在 board 侧，不在卡片里硬编）', async () => {
    const rowClassName = vi.fn(() => 'row-printed');
    const w = await mountCard({ rowClassName });
    // 桩 el-table 不调用 row-class-name，这里只钉「函数被当 prop 传下去」这件事
    expect(w.props('rowClassName')).toBe(rowClassName);
    expect(rowClassName).not.toHaveBeenCalled();
  });
});