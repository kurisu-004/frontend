// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryDriverPickerDialog.spec.ts
//
// 2026-10-16 新增：一键送货确认 + 指定司机对话框的守卫。
//
// 钉的是三条业务硬约束：
//   1. 单据**没有**司机名 → 「确认送货」disabled（服务端 POST /{id}/pickup 只吃 version、
//      司机从单据上读，没司机必 21409）；
//   2. 单据**已有**司机名 → 回显「本单已指定：X」且允许不选直接确认；
//   3. confirm emit 的 driverId 语义：非空 = 本次要改绑的司机 id；**空串 = 沿用本单司机**
//      （调用方据此决定要不要先发 POST /{id}/driver）。
// 另钉两条关闭语义：「取消」与右上角 × 都不发 confirm 且清掉本地选中态；el-dialog 的
// `closed` 透传给调用方（单据快照在那之后才清，见 store 的 onDeliverDialogClosed）。
// 以及提示行的四格组合（`hasDriverOnNote` × `driverId` 全部有文案、无空白窗口）与清空
// 可达性（clearable + valueOnClear 钉成空串；收到 undefined 不算「选好」）。
//
// 组件自身零写端点：两条 POST 的编排在 store（见 useDeliveryNoteListStore.spec.ts）。
//
// EP 组件一律走 global.stubs（vitest 不挂 unplugin-vue-components，kebab 标签不会被
// 自动 import 成具名组件）；element-plus 的 ElMessage 桩成 no-op（node/happy-dom 下
// 真实实现会污染输出）。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type * as HttpModule from '@/api/http';
import { default as Dialog } from '../DeliveryDriverPickerDialog.vue';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>(async () => ({
    data: { items: [] },
  })),
  apiPostMock: vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>(async () => ({
    data: null,
  })),
}));

vi.mock('@/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, api: { ...actual.api, get: apiGetMock, post: apiPostMock } };
});

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const app = createApp({ render: () => null });
app.use(createPinia());
app.use(VueQueryPlugin, {
  queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
});

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    // `closed` 由用例显式 $emit（模拟真实 el-dialog「leave 过渡结束后」那一刻）：
    // 桩里若跟着 modelValue 一起发，就测不出「关闭开始但过渡未结束」的窗口。
    emits: ['update:modelValue', 'closed'],
    template:
      '<div class="mock-el-dialog" :data-title="title"><slot /><slot name="footer" /></div>',
  },
  'el-button': {
    name: 'ElButtonStub',
    props: ['type', 'size', 'disabled', 'loading'],
    emits: ['click'],
    template:
      '<button class="mock-el-button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  'el-select': {
    name: 'ElSelectStub',
    // 声明类型（不是数组形式）：`clearable` 是裸属性，只有 Boolean 类型的 prop 才会被
    // Vue 归一成 true，用例才能断言「清空口子在」而不是断言一个属性值字符串。
    props: {
      modelValue: String,
      loading: Boolean,
      disabled: Boolean,
      clearable: Boolean,
      valueOnClear: String,
    },
    emits: ['update:modelValue', 'change'],
    template: '<div class="mock-el-select"><slot /></div>',
  },
  'el-option': { name: 'ElOptionStub', template: '<div><slot /></div>' },
};

/** 司机候选（GET /com/delivery/drivers）。 */
function withDriverOptions(): void {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/drivers')) {
      return {
        data: {
          items: [
            { id: 'W1', name: '李四', badge_code: 'S001' },
            { id: 'W2', name: '王五', badge_code: 'S002' },
          ],
        },
      };
    }
    return { data: { items: [] } };
  });
}

async function mountDialog(over: Record<string, unknown> = {}): Promise<VueWrapper> {
  const w = app.runWithContext(() =>
    mount(Dialog, {
      props: {
        modelValue: true,
        noteNo: 'DN-001',
        partCount: 3,
        driverWorkerName: null,
        ...over,
      },
      global: { stubs },
    }),
  );
  await flush();
  return w;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 等司机候选回流（query 是异步链）。 */
async function waitDrivers(w: VueWrapper): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (w.findAllComponents({ name: 'ElOptionStub' }).length === 2) return;
    await nextTick();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('等待超时：司机候选回流');
}

/** 「确认送货」按钮的 disabled 态。 */
function confirmDisabled(w: VueWrapper): boolean {
  return w.find('button[data-role="confirm"]').attributes('disabled') !== undefined;
}

/** 在下拉里选中 id（走 v-model 的 update:modelValue，与用户点选同一条路径）。 */
async function selectDriver(w: VueWrapper, id: string): Promise<void> {
  await waitDrivers(w);
  w.findComponent({ name: 'ElSelectStub' }).vm.$emit('update:modelValue', id);
  await flush();
}

/** 点下拉上的「清空」（走 el-select 的 clearable 路径：`update:modelValue` 发出
 *  `valueOnClear`，模板已把它钉成空串；这里显式发空串，与真机同值）。 */
async function clearDriver(w: VueWrapper): Promise<void> {
  const sel = w.findComponent({ name: 'ElSelectStub' });
  sel.vm.$emit('update:modelValue', sel.props('valueOnClear'));
  await flush();
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue({ data: { items: [] } });
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({ data: null });
});

describe('DeliveryDriverPickerDialog', () => {
  it('单据上已有司机 → 回显「本单已指定：X」且不选也能确认（emit 空串 = 沿用）', async () => {
    withDriverOptions();
    const w = await mountDialog({ driverWorkerName: '李四' });
    expect(w.text()).toContain('本单已指定：李四');
    expect(confirmDisabled(w)).toBe(false);
    await w.find('button[data-role="confirm"]').trigger('click');
    expect(w.emitted('confirm')).toEqual([['']]);
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });

  it('单据上没有司机 → 「确认」disabled（后端 pickup 必 21409），点不动', async () => {
    withDriverOptions();
    const w = await mountDialog();
    expect(w.text()).toContain('本单尚未指定司机');
    expect(confirmDisabled(w)).toBe(true);
    await w.find('button[data-role="confirm"]').trigger('click');
    expect(w.emitted('confirm')).toBeUndefined();
  });

  it('单据上没有司机 + 选了司机 → 可确认，emit 选中的 id', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await selectDriver(w, 'W2');
    expect(confirmDisabled(w)).toBe(false);
    await w.find('button[data-role="confirm"]').trigger('click');
    expect(w.emitted('confirm')).toEqual([['W2']]);
  });

  it('单据上已有司机 + 重选了别人 → emit 新 id（调用方据此先发 driver POST）', async () => {
    withDriverOptions();
    const w = await mountDialog({ driverWorkerName: '李四' });
    await selectDriver(w, 'W2');
    await w.find('button[data-role="confirm"]').trigger('click');
    expect(w.emitted('confirm')).toEqual([['W2']]);
  });

  // ⚠️ 「已有司机 + 又选了别人」这一格曾经渲染成空 div（两个分支都不命中），唯一那条
  // 「不选则沿用」的指引凭空消失；而下拉当时又没有 clearable，用户再也回不到沿用模式。
  // 四态文案 + 清空可达性由下面这三条钉。
  it('已有司机 + 又选了别人 → 提示「本次将改绑为 X；清空下拉即退回沿用 Y」，不留空白窗口', async () => {
    withDriverOptions();
    const w = await mountDialog({ driverWorkerName: '李四' });
    await selectDriver(w, 'W2');
    const note = w.find('.driver-note').text();
    expect(note).toContain('本次将改绑为 王五');
    expect(note).toContain('退回沿用');
    expect(note).toContain('李四');
    // 四态都要有文案：这一格绝不能渲染成空 div
    expect(note.trim().length).toBeGreaterThan(0);
  });

  // ⚠️ 「原本没司机 + 已经选了人」这一格原本仍停在「请先选择后再确认」——把用户刚做完的
  // 事重新要求一遍、且从头到尾不点名选了谁（与「已有司机 + 选了别人」那一格不对称）。
  it('单据上没有司机 + 选了司机 → 提示「本次将指定为 王五」，不再说「请先选择后再确认」', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await selectDriver(w, 'W2');
    const note = w.find('.driver-note').text();
    expect(note).toContain('本次将指定为 王五');
    expect(note).not.toContain('请先选择后再确认');
    // 确认按钮此时已解禁（提示与按钮状态必须说同一件事）
    expect(confirmDisabled(w)).toBe(false);
  });

  it('单据上没有司机 + 选了又清空 → 提示退回「请先选择后再确认」，确认按钮重新 disabled', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await selectDriver(w, 'W2');
    await clearDriver(w);
    const note = w.find('.driver-note').text();
    expect(note).toContain('请先选择后再确认');
    expect(confirmDisabled(w)).toBe(true);
  });

  it('下拉 clearable + 清空值钉成空串（清空即退回「沿用」，不是 undefined）', async () => {
    withDriverOptions();
    const w = await mountDialog({ driverWorkerName: '李四' });
    const sel = w.findComponent({ name: 'ElSelectStub' });
    expect(sel.props('clearable')).toBe(true);
    expect(sel.props('valueOnClear')).toBe('');
  });

  it('误选别人后清空下拉 → 回到沿用模式：提示复原、emit 空串（不重发 driver POST）', async () => {
    withDriverOptions();
    const w = await mountDialog({ driverWorkerName: '李四' });
    await selectDriver(w, 'W2');
    await clearDriver(w);
    expect(w.find('.driver-note').text()).toContain('本单已指定：李四');
    await w.find('button[data-role="confirm"]').trigger('click');
    expect(w.emitted('confirm')).toEqual([['']]);
  });

  // 清空值若漏成 undefined，「单据本来没司机」那一格会被 canConfirm 的 `!== ''` 误判成
  // 「选好了」⇒ emit undefined 当司机 id 去发 POST /{id}/driver。
  it('单据上没有司机 + 下拉收到 undefined ⇒ 仍算「没选」，「确认」保持 disabled', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await waitDrivers(w);
    w.findComponent({ name: 'ElSelectStub' }).vm.$emit('update:modelValue', undefined);
    await flush();
    expect(confirmDisabled(w)).toBe(true);
    await w.find('button[data-role="confirm"]').trigger('click');
    expect(w.emitted('confirm')).toBeUndefined();
  });

  it('点「取消」→ 只关对话框，不发 confirm（零请求）', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await selectDriver(w, 'W2');
    await w
      .findAll('button.mock-el-button')
      .find((b) => b.text().includes('取消'))!
      .trigger('click');
    expect(w.emitted('confirm')).toBeUndefined();
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  // 右上角 × 由 el-dialog 自己 emit update:modelValue（不经组件的取消按钮），这里钉它的
  // 两条行为：同样只关不发 confirm；且本地选中态由 props.modelValue 的 watch 清掉
  // （不回显一个从未落库的幽灵选中项）。
  it('右上角 ×（el-dialog 自己 emit update:modelValue）→ 同样只关不发 confirm，本地选中态清掉', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await selectDriver(w, 'W2');
    w.findComponent({ name: 'ElDialogStub' }).vm.$emit('update:modelValue', false);
    await flush();
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
    expect(w.emitted('confirm')).toBeUndefined();
    expect(apiPostMock).not.toHaveBeenCalled();
    // 父组件把 modelValue 落到 false（真实场景就是这样跟着 × 走的）⇒ 选中态复位
    await w.setProps({ modelValue: false });
    await flush();
    expect(w.findComponent({ name: 'ElSelectStub' }).props('modelValue')).toBe('');
  });

  // 单据快照由调用方在 `closed` 才清：close 是带 leave 过渡的，关闭开始到过渡结束之间
  // 对话框内容仍在 DOM 里可见，此刻清快照会让标题闪成「一键送货 — 」。这一条钉的是本
  // 组件把 el-dialog 的 closed 透传出去（调用方拿它挂清单据快照）。
  it('透传 el-dialog 的 closed（调用方在关闭过渡结束后才清单据快照）', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await w.find('button[data-role="confirm"]').trigger('click');
    await flush();
    w.findComponent({ name: 'ElDialogStub' }).vm.$emit('closed');
    await flush();
    expect(w.emitted('closed')).toHaveLength(1);
  });

  it('关掉再打开 → 选中态复位（不留从未落库的幽灵选中项）', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await selectDriver(w, 'W2');
    await w.setProps({ modelValue: false });
    await flush();
    await w.setProps({ modelValue: true });
    await flush();
    expect(w.findComponent({ name: 'ElSelectStub' }).props('modelValue')).toBe('');
  });

  it('组件自身零写端点：司机落库与 pickup 都归 store', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await selectDriver(w, 'W2');
    await w.find('button[data-role="confirm"]').trigger('click');
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
