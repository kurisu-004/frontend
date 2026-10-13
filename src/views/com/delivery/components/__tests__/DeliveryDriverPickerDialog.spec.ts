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
    props: ['modelValue', 'loading', 'disabled'],
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

  it('取消 / 右上角 × → 只关对话框，不发 confirm（零请求）', async () => {
    withDriverOptions();
    const w = await mountDialog();
    await selectDriver(w, 'W2');
    await w.findAll('button.mock-el-button').find((b) => b.text().includes('取消'))!.trigger('click');
    expect(w.emitted('confirm')).toBeUndefined();
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false]);
    expect(apiPostMock).not.toHaveBeenCalled();
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