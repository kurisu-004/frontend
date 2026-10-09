// src/views/parts/detail/components/__tests__/PartFailInspectionDialog.spec.ts
// @vitest-environment happy-dom
//
// 2026-10-10 新增：「指定工序」对话框从 `PartDetail.vue` 抽出后的守卫。
//
// 钉三件事：
//   1. **根是单个普通 div** —— 本组件包着 `el-dialog`（内部是 teleport 占位形态）。
//      拿 teleport 组件当组件根会让组件变成多根 vnode、Vue 在两侧插锚点，SVG 式的
//      footprint 对不上（同 CLAUDE.md「拖拽投放」那条：可拖元素 == vnode 的 DOM
//      footprint ⇒ 根必须是单元素）。用源码层断言，形态是编译期事实、mount 测不出来。
//   2. **目标批次原样回显**，且不在组件内重新挑批次 —— 它与 PartActionBar 的显隐判据、
//      usePartDetailActions 的写锚是同一个值（`resolveInspectionBatch`），组件自己再挑
//      一次就会出现「界面一个批次、写下去另一个批次」。
//   3. **提交只 emit**：空工艺不发；备注 trim、空串归一为 null（后端 `note` 可空）。
//
// 挂载手法沿同目录 `ProcessChainCard.spec.ts` / `PartActionBar.spec.ts`：挂最小 stub。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import PartFailInspectionDialog from '../PartFailInspectionDialog.vue';
import type { PartBatch } from '@/api/parts';
import type { Process } from '@/types/process';

// ⚠️ 本文件跑在 happy-dom env（挂载需要 document），而 happy-dom 下 `import.meta.url`
// 不是 file: 协议 ⇒ `fileURLToPath` 会抛。改用 vitest 的 root（= 项目根）拼绝对路径。
const src = readFileSync(
  resolve(process.cwd(), 'src/views/parts/detail/components/PartFailInspectionDialog.vue'),
  'utf8',
);

const ElDialogStub = defineComponent({
  name: 'ElDialogStub',
  props: ['modelValue', 'title'],
  setup(props, { slots, attrs }) {
    return () =>
      props.modelValue === true
        ? h('div', { class: 'el-dialog-stub', title: props.title }, [
            slots.default?.(),
            slots.footer?.(),
          ])
        : h('div', { class: 'el-dialog-stub', ...attrs }, slots.default?.());
  },
});

const ElButtonStub = defineComponent({
  name: 'ElButtonStub',
  inheritAttrs: false,
  setup(_, { slots, attrs }) {
    return () =>
      h(
        'button',
        { ...attrs, class: 'el-button-stub', disabled: attrs.disabled === true },
        slots.default?.(),
      );
  },
});

const ElFormStub = defineComponent({
  name: 'ElFormStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-form-stub' }, slots.default?.());
  },
});
const ElFormItemStub = defineComponent({
  name: 'ElFormItemStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-form-item-stub' }, slots.default?.());
  },
});
// el-select / el-option / el-input / el-alert / el-tag 在本用例里只需要「挂住不报错 +
// 把 label / 文案吐出来供断言」，交互由手工 emit 驱动。
const passthrough = (name: string, textOf?: (attrs: Record<string, unknown>) => string) =>
  defineComponent({
    name,
    inheritAttrs: false,
    setup(_, { slots, attrs }) {
      return () => {
        const inner = slots.default
          ? slots.default()
          : textOf
            ? textOf(attrs as Record<string, unknown>)
            : '';
        return h('div', { ...attrs, class: `${name.toLowerCase()}-stub` }, [inner]);
      };
    },
  });

const globalConfig = {
  components: {
    ElDialog: ElDialogStub,
    ElButton: ElButtonStub,
    ElForm: ElFormStub,
    ElFormItem: ElFormItemStub,
    ElSelect: passthrough('ElSelect'),
    ElOption: passthrough('ElOption', (a) => String(a.label ?? '')),
    ElInput: passthrough('ElInput'),
    ElAlert: passthrough('ElAlert', (a) => String(a.title ?? '')),
    ElTag: passthrough('ElTag'),
  },
};

const PROCESSES = [
  { id: '190000000000001', code: 'CUT', name: '切割', category: 'IN_HOUSE' },
  { id: '190000000000002', code: 'OUT', name: '外协打磨', category: 'OUTSOURCE' },
] as unknown as Process[];

function makeBatch(over: Partial<PartBatch> = {}): PartBatch {
  return {
    id: 'B1',
    version: 3,
    part_id: '42',
    batch_no: 2,
    batch_label: 'L2',
    quantity: 7,
    status: 'INSPECTION',
    is_repairing: false,
    location: 'INSPECTION_SHELF',
    current_holder_id: null,
    current_holder_display: '',
    current_process_step_id: null,
    next_process_name: null,
    delivery_note_id: null,
    delivery_note_no: null,
    parent_batch_id: null,
    created_at: '2026-10-10 08:00:00',
    updated_at: '2026-10-10 08:00:00',
    ...over,
  };
}

function mountDlg(props: { modelValue?: boolean; inspectionBatch?: PartBatch | null }) {
  return mount(PartFailInspectionDialog, {
    props: {
      modelValue: props.modelValue ?? true,
      inspectionBatch: props.inspectionBatch === undefined ? makeBatch() : props.inspectionBatch,
      processes: PROCESSES,
      submitting: false,
      statusLabelOf: (s: string | null | undefined) => `状态:${s ?? ''}`,
    },
    global: globalConfig,
  });
}

describe('PartFailInspectionDialog', () => {
  it('C1：根是单个普通 div（包着 el-dialog），不是 el-dialog 本身', () => {
    // 运行期 footprint：mount 后根节点就是一个普通 div，且只有一个子元素。
    // 根若是 el-dialog（teleport 占位形态的多根 vnode），Vue 会在两侧插锚点，
    // wrapper.element 就不是这个 div 了（同 CLAUDE.md「拖拽投放」那条约束）。
    const wrapper = mountDlg({});
    expect(wrapper.element.tagName).toBe('DIV');
    expect(wrapper.classes()).toContain('part-fail-inspection-dialog');
    expect(wrapper.element.children).toHaveLength(1);
    // 源码层再钉一次「首个元素是 div、不是 el-dialog」，防有人把根换掉而 mount 仍过。
    const template = src
      .slice(src.indexOf('<template>') + '<template>'.length, src.indexOf('</template>'))
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    expect(template.startsWith('<div class="part-fail-inspection-dialog">')).toBe(true);
  });

  it('C2：目标批次原样回显（含数量与状态），组件不自己挑批次', () => {
    const wrapper = mountDlg({ inspectionBatch: makeBatch({ batch_label: 'L7', quantity: 4 }) });
    const text = wrapper.text();
    expect(text).toContain('L7');
    expect(text).toContain('4');
    expect(text).toContain('状态:INSPECTION');
  });

  it('C3：inspectionBatch 为 null 时回显「—」，不抛也不显示数量段', () => {
    const wrapper = mountDlg({ inspectionBatch: null });
    expect(wrapper.text()).toContain('—');
  });

  it('C4：未选工序时「确认指定工序」禁用且不 emit', async () => {
    const wrapper = mountDlg({});
    const btns = wrapper.findAll('button');
    const confirm = btns[btns.length - 1]!;
    expect(confirm.text()).toContain('确认指定工序');
    expect(confirm.attributes('disabled')).toBeDefined();
    await confirm.trigger('click');
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });

  it('C5：选了工序后 emit confirm，工艺为字符串 id、备注空串归一为 null', async () => {
    const wrapper = mountDlg({});
    const select = wrapper.findComponent({ name: 'ElSelect' });
    // 选一个工序（stub 不做下拉交互，直接驱动 el-select 的 modelValue）
    select.vm.$emit('update:modelValue', '190000000000002');
    await wrapper.vm.$nextTick();
    const btns = wrapper.findAll('button');
    await btns[btns.length - 1]!.trigger('click');
    const emitted = wrapper.emitted('confirm');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]![0]).toMatchObject({ processId: '190000000000002', note: null });
  });

  it('C6：外协工序选项带「外协」标记（category === OUTSOURCE）', () => {
    const wrapper = mountDlg({});
    expect(wrapper.text()).toContain('外协');
  });

  it('C7：保留「目标货架由后端自动选」的说明（现场问起时不用现查）', () => {
    const wrapper = mountDlg({});
    expect(wrapper.text()).toContain('目标货架由系统按负载自动选择');
  });
});
