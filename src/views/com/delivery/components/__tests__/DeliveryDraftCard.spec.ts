// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryDraftCard.spec.ts
//
// 草稿卡片 footer 的守卫（2026-10-08 新增；此前该组件零覆盖）。
//
// 之所以单独钉住这 4 颗按钮：2026-10-08 之前 footer 只有 3 颗（标签导出随打印端点一起
// 下线），而「打印标签」按钮消失过一次 —— 与「打印送货单」按钮因 canPrint 死锁整排消失
// 是同一类回归（能力被静默摘掉，没人报错）。断言写死「4 颗 + 各在 canPrint / canSubmit
// 组合下的显隐与 disabled」，任何一颗被摘掉都会红。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { MergedDraftRow } from '../../composables/useDeliveryDraftBoard';
import type { DeliveryNoteItemData } from '../../composables/deliveryNoteSchema';

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ElMessage: { error: vi.fn(), success: vi.fn() } };
});

const app = createApp({ render: () => null });
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
setActivePinia(app.config.globalProperties.$pinia);

const { default: DeliveryDraftCard } = await import('../DeliveryDraftCard.vue');

const ROWS: MergedDraftRow[] = [
  {
    serial_no: 'S-1',
    drawing_no: 'D-1',
    name: '电容',
    quantity: 5,
    system_delivery_date: null,
    batch_ids: ['1'],
    label_printed: false,
  },
];

const DRAFT = { id: 'N1', delivery_note_no: 'DN-001', status: 'DRAFT' } as unknown as DeliveryNoteItemData;

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
  'el-table': defineComponent({
    name: 'ElTableStub',
    props: { data: { type: Array as PropType<unknown[]>, default: () => [] } },
    setup: (_p, { slots }) => () => h('div', { class: 'mock-el-table' }, slots.default?.()),
  }),
  'el-table-column': defineComponent({
    name: 'ElTableColumnStub',
    props: ['label'],
    setup: (p) => () => h('span', { class: 'mock-col', 'data-label': p.label }),
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

async function mountCard(props: Record<string, unknown> = {}) {
  return app.runWithContext(() =>
    mount(DeliveryDraftCard, {
      props: {
        draft: DRAFT,
        rows: ROWS,
        deleting: false,
        submitting: false,
        canPrint: true,
        canSubmit: true,
        rowClassName: () => '',
        ...props,
      },
      global: { stubs },
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

describe('DeliveryDraftCard 已打印标签绿底接线', () => {
  it('rowClassName 由父组件传入（绿底判据在 board 侧，不在卡片里硬编）', async () => {
    const rowClassName = vi.fn(() => 'row-printed');
    const w = await mountCard({ rowClassName });
    // 桩 el-table 不调用 row-class-name，这里只钉「函数被当 prop 传下去」这件事
    expect(w.props('rowClassName')).toBe(rowClassName);
    expect(rowClassName).not.toHaveBeenCalled();
  });
});