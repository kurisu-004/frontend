// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryScanTreeDialog.spec.ts
//
// 2026-10-08 新增：扫码三层树对话框的渲染守卫。
//
// 最重要的一条是「**入单按钮的位置**」—— 它是业务硬约束不是样式选择：
// 装配件在 assembly 行、普通零件在 part 行、批次行**没有**按钮（批次是服务端 DP
// 分配的结果，前端不选批次）。位置错了会让用户以为「入单 = 选批次」，进而做出
// 后端必然 21405 的请求。
//
// 用 EP 模板桩而不是真 el-table（理由同 src/views/inspection/__tests__/InspectionTable.spec.ts）：
// 桩 el-table 把**真实**的 :data 逐行喂给列插槽，断言按 [data-col=…][data-row-id] 定位。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
import type { DeliveryScanTreeData } from '../../composables/deliveryScanTreeSchema';

// 只 mock 命令式 API（ElMessage 在 node 环境会碰 document）。
// ⚠️ **EP 组件一律走 `global.stubs` 而不是这里**：vitest.config.ts 不挂
// unplugin-vue-components，模板里的 kebab 标签（<el-tag> / <el-button>）在测试里不会被
// 自动 import 成具名组件，只能由 VTU 的 stubs 按标签名拦下来（ElementPlus 组件名
// 全局注册在 main.ts，组件 spec 不经过它）。
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn() },
}));

/** el-table 桩把自己的 :data 摊到这里，列桩按行渲染单元格。
 *
 *  tree data 的 rows 是**嵌套**的（装配件的 children 是子件，子件的 children 是批次），
 *  桩递归摊平成一张扁平列表 —— 真 el-table 也是把三层都渲染成行（只是带缩进）。 */
let scopeRows: Record<string, unknown>[] = [];

function flattenRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.flatMap((r) => [r, ...flattenRows((r.children as Record<string, unknown>[]) ?? [])]);
}

const ElTableStub = defineComponent({
  name: 'ElTableStub',
  props: {
    data: { type: Array as PropType<Record<string, unknown>[]>, default: () => [] },
    selectable: { type: Function as PropType<(row: unknown) => boolean>, default: undefined },
  },
  setup(props, { slots }) {
    return () => {
      scopeRows = flattenRows(props.data);
      return h('div', { class: 'mock-el-table' }, slots.default?.());
    };
  },
});

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    template: '<div class="mock-el-dialog"><slot /><slot name="footer" /></div>',
  },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-el-tag"><slot /></span>' },
  'el-tooltip': {
    name: 'ElTooltipStub',
    props: ['content', 'disabled'],
    template: '<span class="mock-el-tooltip"><slot /></span>',
  },
  'el-input-number': { name: 'ElInputNumberStub', template: '<input class="mock-el-input-number" />' },
  'el-form': { name: 'ElFormStub', template: '<form><slot /></form>' },
  'el-form-item': { name: 'ElFormItemStub', template: '<div><slot /></div>' },
  'el-button': {
    name: 'ElButtonStub',
    props: ['type', 'size', 'disabled', 'loading'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: ElTableStub,
  ElTableColumn: defineComponent({
    name: 'ElTableColumnStub',
    props: { label: { type: String, default: '' } },
    setup(props, { slots }) {
      return () =>
        h(
          'div',
          { class: 'mock-el-table-column', 'data-col': props.label },
          scopeRows.map((row) =>
            h(
              'div',
              { class: 'mock-cell', 'data-row-id': String(row.id ?? '') },
              slots.default ? slots.default({ row }) : [],
            ),
          ),
        );
    },
  }),
};

function tree(over: Partial<DeliveryScanTreeData> = {}): DeliveryScanTreeData {
  const t: DeliveryScanTreeData = {
    hit_kind: 'ASSEMBLY',
    scanned_serial_no: 'F1001',
    draft: { note_id: 'N1', note_no: 'DN-001', version: 5, status: 'DRAFT' },
    assembly: {
      id: 'A1',
      serial_no: 'F1001',
      name: '总装',
      drawing_no: 'ASM-1',
      status: 'READY_TO_SHIP',
      quantity: 3,
      is_urgent: false,
      system_delivery_date: null,
      customer_name: '法拉',
      customer_id: '11',
      entry_max_sets: 2,
      per_set_parts: [{ part_id: 'P1', per_set_quantity: 3 }],
    },
    children: [
      {
        id: 'P1',
        serial_no: 'F1001-01',
        name: '子件',
        drawing_no: 'D-1',
        status: 'READY_TO_SHIP',
        quantity: 9,
        is_urgent: false,
        system_delivery_date: null,
        customer_name: '法拉',
        version: 1,
        customer_id: '11',
        entry_max_quantity: 5,
        children: [
          {
            id: 'B1',
            batch_no: 1,
            quantity: 5,
            status: 'READY_TO_SHIP',
            version: 3,
            is_repairing: false,
            location: 'PRODUCTION_SHELF',
            current_holder_display: null,
            process_name: null,
            is_scanned: false,
            occupied_by_note_no: 'DN-20260101-0002',
          },
          {
            id: 'B2',
            batch_no: 2,
            quantity: 4,
            status: 'READY_TO_SHIP',
            version: 1,
            is_repairing: false,
            location: null,
            current_holder_display: null,
            process_name: null,
            is_scanned: false,
            occupied_by_note_no: null,
          },
        ],
      },
    ],
    ...over,
  };
  return t;
}

async function mountDialog(t: DeliveryScanTreeData | null): Promise<VueWrapper> {
  const { default: Dialog } = await import('../DeliveryScanTreeDialog.vue');
  return mount(Dialog, { props: { modelValue: true, tree: t }, global: { stubs } });
}

/** 某行在「操作」列里的按钮文字数组。 */
function actionsOf(wrapper: VueWrapper, rowId: string): string[] {
  return wrapper
    .findAll(`[data-col="操作"] [data-row-id="${rowId}"] button`)
    .map((b) => b.text());
}

beforeEach(() => {
  scopeRows = [];
});

describe('DeliveryScanTreeDialog 三层树', () => {
  it('装配件 / 子件 / 批次三层都渲染出表格行（4 行）', async () => {
    await mountDialog(tree());
    expect(scopeRows.map((r) => r.id)).toEqual(['A1', 'P1', 'B1', 'B2']);
    expect(scopeRows.map((r) => r.node_kind)).toEqual(['ASSEMBLY', 'PART', 'BATCH', 'BATCH']);
  });

  it('入单按钮在 assembly 行与 part 行，**不在 batch 行**', async () => {
    const wrapper = await mountDialog(tree());
    expect(actionsOf(wrapper, 'A1')).toEqual(['入单']); // 装配件行有
    expect(actionsOf(wrapper, 'P1')).toEqual(['入单']); // 子件（零件）行有
    expect(actionsOf(wrapper, 'B1')).toEqual([]); // 批次行没有
    expect(actionsOf(wrapper, 'B2')).toEqual([]);
  });

  it('独立件树（assembly 为 null）：只有零件行的入单按钮', async () => {
    const t = tree({ assembly: null });
    const wrapper = await mountDialog(t);
    expect(scopeRows.map((r) => r.id)).toEqual(['P1', 'B1', 'B2']);
    expect(actionsOf(wrapper, 'P1')).toEqual(['入单']);
    expect(actionsOf(wrapper, 'B1')).toEqual([]);
  });

  it('可入单量：零件行 entry_max_quantity 件；装配件行 entry_max_sets 套', async () => {
    const wrapper = await mountDialog(tree());
    expect(wrapper.find('[data-col="可入单"] [data-row-id="P1"]').text()).toBe('5 件');
    expect(wrapper.find('[data-col="可入单"] [data-row-id="A1"]').text()).toBe('2 套');
    expect(wrapper.find('[data-col="可入单"] [data-row-id="B1"]').text()).toBe('—');
  });

  it('occupied_by_note_no 非空 → 标「已被 DN-xxx 占用」；空 → 「未占用」', async () => {
    const wrapper = await mountDialog(tree());
    expect(wrapper.find('[data-col="占用"] [data-row-id="B1"]').text()).toContain('已被');
    expect(wrapper.find('[data-col="占用"] [data-row-id="B1"]').text()).toContain('DN-20260101-0002');
    expect(wrapper.find('[data-col="占用"] [data-row-id="B2"]').text()).toBe('未占用');
    expect(wrapper.find('[data-col="占用"] [data-row-id="A1"]').text()).toBe('—');
  });

  it('已被占用的批次行不可选（el-table selectable 闸门）', async () => {
    const wrapper = await mountDialog(tree());
    const selectables = wrapper
      .findComponent(ElTableStub)
      .props('selectable') as (row: Record<string, unknown>) => boolean;
    expect(selectables({ node_kind: 'BATCH', occupied_by_note_no: 'DN-1' })).toBe(false);
    expect(selectables({ node_kind: 'BATCH', occupied_by_note_no: null })).toBe(true);
    expect(selectables({ node_kind: 'PART', occupied_by_note_no: null })).toBe(true);
  });

  it('draft 存在 → 横幅显示加入哪张草稿；draft 为 null → 明说会新建', async () => {
    const withDraft = await mountDialog(tree());
    expect(withDraft.text()).toContain('加入草稿 DN-001');
    const noDraft = await mountDialog(tree({ draft: null }));
    expect(noDraft.text()).toContain('暂无草稿');
  });

  it('「确认入单」在未选任何条目时 disabled', async () => {
    const wrapper = await mountDialog(tree());
    expect(wrapper.find('button[data-role="submit"]').attributes('disabled')).toBeDefined();
  });

  it('tree 为 null 时渲染空表（不闪上一棵树的残留）', async () => {
    await mountDialog(null);
    expect(scopeRows).toEqual([]);
  });
});
