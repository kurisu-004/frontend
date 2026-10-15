// @vitest-environment happy-dom
// src/views/hr/schedule/components/__tests__/ShiftTimeAxis.spec.ts
//
// 2026-10-19 新建：双日时间轴的**交互契约**守卫。三组：
//
//  1. **已占用区间禁选**：已提交段渲染成实心块、`cursor: not-allowed`、带 `data-occupied`；
//     `mousedown` 打在块上**直接 return**（点击与拖拽都忽略）——这是「禁止选中已覆盖的时间
//     范围」的落点。
//  2. **拖到已占用区间被拒**：空白处拖出一个与既有段相交的新段 ⇒ 松手转红（`is-conflict`）
//     并**丢弃**，不进 `modelValue`（邻接不算相交，所以 12:00 那一刀是合法的）。
//  3. **跨度超 24:00 ⇒ 保存禁用**：`ShiftTimeAxis` 顶部红字 + `ShiftEditDialog` 的「保存」
//     按钮 disabled（21908 的前端版）。
//
// 测试策略说明：
//   - happy-dom 里**没有布局**（`getBoundingClientRect()` 恒 0×0），所以本文件显式 stub 两处
//     几何：`vi.spyOn(laneEl, 'getBoundingClientRect')` 给出行宽，`document.elementFromPoint`
//     桩成「命中哪一行」——后者正是组件在 `mousemove` 里判定跨行位置用的那个 API。
//   - `ShiftTimeAxis` 刻意**零 Element Plus 控件**（原生 input/select/button），所以挂载不需要
//     EP 桩；只有第三组的 `ShiftEditDialog` 需要 el-dialog / el-form 等桩（照
//     `views/users/components/__tests__/WxBindDialog.spec.ts` 的桩法）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ShiftTimeAxis from '../ShiftTimeAxis.vue';
import ShiftEditDialog from '../ShiftEditDialog.vue';
import type { ShiftSegmentOut } from '@/types/hr';

/** 一行 24h 映射到 480px ⇒ 1 分钟 = 1/3 px，15 分钟吸附 = 5px。 */
const LANE_WIDTH = 480;
const PX_PER_MIN = LANE_WIDTH / 1440;

function seg(seq: number, start: string, end: string): ShiftSegmentOut {
  return { seq, start, end };
}

/** 两条已占用段：08:00–12:00（当日）与 13:00–17:00（当日）。 */
const OCCUPIED: ShiftSegmentOut[] = [seg(1, '08:00', '12:00'), seg(2, '13:00', '17:00')];

function mountAxis(
  props: { modelValue: ShiftSegmentOut[]; readonly?: boolean } = { modelValue: OCCUPIED },
) {
  let latest = props.modelValue;
  const wrapper = mount(ShiftTimeAxis, {
    props: {
      modelValue: props.modelValue,
      readonly: props.readonly ?? false,
      baseDate: '2026-10-16',
      'onUpdate:modelValue': (next: ShiftSegmentOut[]) => {
        latest = next;
      },
    },
  });
  return { wrapper, latest: () => latest };
}

/** 给两行 lane 都装上 480px 行宽，并让 `elementFromPoint` 按 `clientY` 落到对应行。 */
function stubGeometry(wrapper: ReturnType<typeof mount>, opts: { hoverLane?: number | null } = {}) {
  const lanes = wrapper.findAll('[data-lane]');
  expect(lanes).toHaveLength(2);
  // 行矩形：宽 480px（一天 24h）、高 56px，与组件里 `.lane` 的 CSS 尺寸对应。
  for (const lane of lanes) {
    const el = lane.element as HTMLElement;
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, LANE_WIDTH, 56));
  }
  const hover = opts.hoverLane ?? null;
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() =>
    hover === null ? null : (lanes[hover]!.element as HTMLElement),
  );
  return lanes;
}

function minuteToPx(minute: number): number {
  return Math.round(minute * PX_PER_MIN);
}

beforeEach(() => {
  vi.restoreAllMocks();
  // 用例 D3 自己装假定时器推进红闪；这里兜底复位，避免一个用例的假定时器漏到下一个。
  vi.useRealTimers();
});

describe('ShiftTimeAxis — 已占用区间禁选', () => {
  it('O1：两条已占用段渲染成实心块，且带 `not-allowed` 与 `data-occupied`', () => {
    const { wrapper } = mountAxis();
    // 当日行两片（08–12 / 13–17），次日行没有（两段都不跨午夜）。
    const pieces = wrapper.findAll('.seg-piece');
    expect(pieces).toHaveLength(2);
    for (const p of pieces) {
      expect(p.attributes('style')).toContain('cursor: not-allowed');
      expect(p.attributes('data-occupied')).toBeTruthy();
    }
    expect(pieces.map((p) => p.attributes('data-occupied'))).toEqual(['08:00', '13:00']);
  });

  it('O2：在**已占用块上** mousedown 被忽略（既不预览也不新增）', async () => {
    const { wrapper, latest } = mountAxis();
    stubGeometry(wrapper);
    const piece = wrapper.find('.seg-piece');

    await piece.trigger('mousedown', { button: 0, clientX: minuteToPx(480), clientY: 10 });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.seg-piece.is-ghost').exists()).toBe(false);
    expect(latest()).toHaveLength(2);
  });

  it('O3：只读态下空白处也拖不动（整轴只读）', async () => {
    const { wrapper, latest } = mountAxis({ modelValue: OCCUPIED, readonly: true });
    stubGeometry(wrapper);
    const lane = wrapper.findAll('[data-lane]')[0]!;

    await lane.trigger('mousedown', { button: 0, clientX: minuteToPx(60), clientY: 10 });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.seg-piece.is-ghost').exists()).toBe(false);
    expect(latest()).toHaveLength(2);
  });

  it('O4：跨天段渲染成**两行两片**且接缝无圆角（`touch-end` + `touch-start`）', () => {
    const { wrapper } = mountAxis({ modelValue: [seg(1, '22:00', '26:00')] });
    const pieces = wrapper.findAll('.seg-piece');
    expect(pieces).toHaveLength(2);
    // 当日 22:00→24:00：贴行尾 ⇒ 无右侧圆角
    expect(pieces[0]!.classes()).toContain('touch-end');
    expect(pieces[0]!.classes()).not.toContain('touch-start');
    // 次日 00:00→02:00：贴行首 ⇒ 无左侧圆角
    expect(pieces[1]!.classes()).toContain('touch-start');
    expect(pieces[1]!.classes()).not.toContain('touch-end');
    expect(pieces[1]!.attributes('style')).toContain('left: 0%');
  });
});

describe('ShiftTimeAxis — 拖拽新建与冲突拒绝', () => {
  it('D1：空白处拖出一段**进列表**并重编 `seq`（升序）', async () => {
    const { wrapper, latest } = mountAxis({ modelValue: [seg(1, '08:00', '12:00')] });
    stubGeometry(wrapper, { hoverLane: 0 });
    const lane = wrapper.findAll('[data-lane]')[0]!;

    await lane.trigger('mousedown', { button: 0, clientX: minuteToPx(60), clientY: 10 }); // 01:00
    await window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: minuteToPx(240), clientY: 10 }),
    );
    await window.dispatchEvent(
      new MouseEvent('mouseup', { clientX: minuteToPx(240), clientY: 10 }),
    );
    await wrapper.vm.$nextTick();

    expect(latest()).toEqual([seg(1, '01:00', '04:00'), seg(2, '08:00', '12:00')]);
  });

  it('D2：跨行拖拽（当日 18:00 → 次日 02:00）折成绝对偏移 `18:00→26:00`', async () => {
    const { wrapper, latest } = mountAxis({ modelValue: [] });
    stubGeometry(wrapper, { hoverLane: 1 });
    const lane = wrapper.findAll('[data-lane]')[0]!;

    await lane.trigger('mousedown', { button: 0, clientX: minuteToPx(1080), clientY: 10 }); // 18:00
    await window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: minuteToPx(120), clientY: 60 }),
    );
    await window.dispatchEvent(
      new MouseEvent('mouseup', { clientX: minuteToPx(120), clientY: 60 }),
    );
    await wrapper.vm.$nextTick();

    expect(latest()).toEqual([seg(1, '18:00', '26:00')]);
  });

  it('D3：与已占用区间相交 ⇒ **转红并丢弃**，不进列表', async () => {
    // ⚠️ 假定时器必须在**拖拽之前**装：`setTimeout` 是拖拽过程中挂上的，事后再 `useFakeTimers`
    // 换不掉那个已在真实队列里的定时器（本文件初版就栽在这里，红闪永远消不掉）。
    vi.useFakeTimers();
    try {
      const { wrapper, latest } = mountAxis();
      stubGeometry(wrapper, { hoverLane: 0 });
      const lane = wrapper.findAll('[data-lane]')[0]!;

      await lane.trigger('mousedown', { button: 0, clientX: minuteToPx(420), clientY: 10 }); // 07:00
      await window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: minuteToPx(600), clientY: 10 }),
      );
      await window.dispatchEvent(
        new MouseEvent('mouseup', { clientX: minuteToPx(600), clientY: 10 }),
      );
      await wrapper.vm.$nextTick();

      expect(latest()).toHaveLength(2); // 没有第三段被塞进去
      const ghost = wrapper.find('.seg-piece.is-ghost');
      expect(ghost.exists()).toBe(true);
      expect(ghost.classes()).toContain('is-conflict');

      vi.advanceTimersByTime(700);
      await wrapper.vm.$nextTick();
      expect(wrapper.find('.seg-piece.is-ghost').exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('D4：**邻接不算相交**（12:00 那一刀能建出来）', async () => {
    const { wrapper, latest } = mountAxis({ modelValue: [seg(1, '08:00', '12:00')] });
    stubGeometry(wrapper, { hoverLane: 0 });
    const lane = wrapper.findAll('[data-lane]')[0]!;

    await lane.trigger('mousedown', { button: 0, clientX: minuteToPx(720), clientY: 10 }); // 12:00
    await window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: minuteToPx(1020), clientY: 10 }),
    );
    await window.dispatchEvent(
      new MouseEvent('mouseup', { clientX: minuteToPx(1020), clientY: 10 }),
    );
    await wrapper.vm.$nextTick();

    expect(latest()).toEqual([seg(1, '08:00', '12:00'), seg(2, '12:00', '17:00')]);
    expect(wrapper.find('.seg-piece.is-conflict').exists()).toBe(false);
  });

  it('D5：只点一下没拖出长度 ⇒ 不当成新段', async () => {
    const { wrapper, latest } = mountAxis();
    stubGeometry(wrapper, { hoverLane: 0 });
    const lane = wrapper.findAll('[data-lane]')[0]!;

    await lane.trigger('mousedown', { button: 0, clientX: minuteToPx(300), clientY: 10 });
    await window.dispatchEvent(
      new MouseEvent('mouseup', { clientX: minuteToPx(300), clientY: 10 }),
    );
    await wrapper.vm.$nextTick();

    expect(latest()).toHaveLength(2);
    expect(wrapper.find('.seg-piece.is-ghost').exists()).toBe(false);
  });

  it('D6：段数满 6 时「新增」禁用', async () => {
    const six: ShiftSegmentOut[] = [];
    for (let i = 0; i < 6; i += 1) {
      six.push(
        seg(
          i + 1,
          `${String(i * 2).padStart(2, '0')}:00`,
          `${String(i * 2 + 1).padStart(2, '0')}:00`,
        ),
      );
    }
    const { wrapper } = mountAxis({ modelValue: six });
    const add = wrapper.find('.seg-add');
    expect(add.attributes('disabled')).toBeDefined();
    expect(add.text()).toContain('6/6');
  });

  it('D7：只读态没有「新增」与「删除」', () => {
    const { wrapper } = mountAxis({ modelValue: OCCUPIED, readonly: true });
    expect(wrapper.find('.seg-add').exists()).toBe(false);
    expect(wrapper.find('.seg-del').exists()).toBe(false);
    expect(
      wrapper.findAll('input.seg-time').every((i) => i.attributes('disabled') !== undefined),
    ).toBe(true);
  });
});

describe('ShiftTimeAxis + ShiftEditDialog — 跨度超 24:00 时保存禁用', () => {
  const ElDialogStub = {
    name: 'ElDialog',
    props: ['modelValue', 'title'],
    template: '<div class="mock-dialog"><slot /><slot name="footer" /></div>',
  };
  const ElFormStub = { name: 'ElForm', template: '<form><slot /></form>' };
  const ElFormItemStub = {
    name: 'ElFormItem',
    props: ['label', 'error'],
    template: '<div><slot /></div>',
  };
  const ElRowStub = { name: 'ElRow', template: '<div><slot /></div>' };
  const ElColStub = { name: 'ElCol', template: '<div><slot /></div>' };
  const ElInputStub = {
    name: 'ElInput',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input class="mock-input" :value="modelValue" />',
  };
  const ElInputNumberStub = {
    name: 'ElInputNumber',
    props: ['modelValue'],
    template: '<input class="mock-input-number" />',
  };
  const ElColorPickerStub = { name: 'ElColorPicker', template: '<i class="mock-color" />' };
  const ElButtonStub = {
    name: 'ElButton',
    props: ['disabled', 'loading'],
    template: '<button class="mock-button" :disabled="disabled"><slot /></button>',
  };

  const globalConfig = {
    components: {
      'el-dialog': ElDialogStub,
      'el-form': ElFormStub,
      'el-form-item': ElFormItemStub,
      'el-row': ElRowStub,
      'el-col': ElColStub,
      'el-input': ElInputStub,
      'el-input-number': ElInputNumberStub,
      'el-color-picker': ElColorPickerStub,
      'el-button': ElButtonStub,
    },
  };

  function mountDialog(segments: ShiftSegmentOut[]) {
    return mount(ShiftEditDialog, {
      props: {
        modelValue: true,
        mode: 'create',
        form: { code: 'N', name: '夜班', color: null, segments, sort_order: 1, remark: null },
        errors: {},
        loading: false,
        canEdit: true,
      },
      global: globalConfig,
    });
  }

  function saveButton(wrapper: ReturnType<typeof mountDialog>) {
    return wrapper.findAll('.mock-button').find((b) => b.text() === '保存');
  }

  it('E1：跨度 ≤ 24:00 ⇒ 保存可点（不误伤合法班次）', () => {
    const wrapper = mountDialog([seg(1, '08:00', '32:00')]); // 恰好 24h
    expect(saveButton(wrapper)!.attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).not.toContain('班次跨度超过 24 小时');
  });

  it('E2：跨度 **超 1 分钟** ⇒ 顶部红字 + 人话解释 + 保存禁用', () => {
    const wrapper = mountDialog([seg(1, '08:00', '32:01')]);
    expect(wrapper.text()).toContain('班次跨度超过 24 小时，与相邻工作日会冲突');
    expect(saveButton(wrapper)!.attributes('disabled')).toBeDefined();
  });
});
