// @vitest-environment happy-dom
// src/views/production/__tests__/WorkTypeTab.spec.ts
//
// 2026-10-16 新增：工种 CRUD Tab 里「自动补料上限」（`auto_allocate_limit`）的单测。
//
// 为什么值得单独立一个文件：这个字段要改**八个地方**才能真正生效（form 类型声明 /
// 初值 / onNew / onEdit / onDialogClosed / create payload / update payload / 列定义），
// 而这八处里**任何一处漏掉都是静默 bug** ——
//   · 漏 form 类型声明 ⇒ 编译期红（这条由 `vue-tsc` 兜，不归本文件）；
//   · 漏初值 / onNew / onDialogClosed ⇒ 打开弹窗时上个工种的值残留，或新增时带着上一条；
//   · 漏 onEdit ⇒ 编辑时永远是空的，用户改了没反应；
//   · 漏任一 payload ⇒ **保存成功、后端存的是旧值**，用户以为配好了；
//   · 漏列定义 ⇒ 表里看不见，只能靠猜。
// 本文件守后三类「不报错、只是没生效」的形态。
//
// 校验口径：后端 `validate_held_limits` 有同一套规则（失败返业务码 `20104`），前端把它
// 放在请求之前是为了给一句能照着改的话。断言的是「不发请求 + 给出可读提示」这个外部可
// 观测事实，不是在断言某个内部函数被调了。
//
// element-plus：CLAUDE.md 架构条目 §9 —— ElMessage 在 vitest env 会碰 document /
// 内部 normalizeAppendTo，桩成 no-op 记断言。写路径直接调 vm.onSave（不点 DOM 按钮）：
// 被测的是「提交体里有没有这个字段」，不是 el-dialog 的 v-model 协议。
// 读列定义则必须走渲染 —— 那一列存在与否只有 DOM 说了算。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { Directive } from 'vue';
// 供 vi.mock 的 importOriginal 泛型使用（@typescript-eslint/consistent-type-imports
// 禁止 `import()` 形式类型注解）
import type * as WorkTypeModule from '@/api/workType';
import type { WorkType } from '@/types/workType';

const elMessage = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock('element-plus', () => ({
  ElMessage: elMessage,
  ElMessageBox: { confirm: vi.fn() },
}));

// ---------------------------------------------------------------- api 桩
const listWorkTypesMock = vi.fn();
const createWorkTypeMock = vi.fn();
const updateWorkTypeMock = vi.fn();
const softDeleteWorkTypeMock = vi.fn();

// importOriginal：toWorkTypeProcessesPayload / toWorkTypeProcessIds 两个纯函数走真实现
// （已被 src/api/__tests__/workType.spec.ts 逐字钉死），只桩发请求的四个函数。
vi.mock('@/api/workType', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkTypeModule>()),
  listWorkTypes: (...args: unknown[]) => listWorkTypesMock(...args),
  createWorkType: (...args: unknown[]) => createWorkTypeMock(...args),
  updateWorkType: (...args: unknown[]) => updateWorkTypeMock(...args),
  softDeleteWorkType: (...args: unknown[]) => softDeleteWorkTypeMock(...args),
}));

import WorkTypeTab from '@/views/production/components/WorkTypeTab.vue';

// ---------------------------------------------------------------- EP 模板桩
const loadingDirective: Directive<HTMLElement, boolean> = {
  mounted() {},
  updated() {},
};

const globalConfig = {
  directives: { loading: loadingDirective },
  stubs: {
    'el-card': { name: 'ElCardStub', template: '<div class="mock-card"><slot /></div>' },
    'el-form': { name: 'ElFormStub', template: '<form><slot /></form>' },
    'el-form-item': {
      name: 'ElFormItemStub',
      props: ['label', 'required'],
      // label 透成 data-* ：表单里的两个数字控件只能靠各自 placeholder / 顺序区分。
      template: '<div class="mock-form-item"><slot /></div>',
    },
    'el-input': {
      name: 'ElInputStub',
      props: ['modelValue', 'placeholder', 'disabled', 'type', 'rows'],
      template: '<input class="mock-input" :placeholder="placeholder" />',
    },
    'el-input-number': {
      name: 'ElInputNumberStub',
      props: ['modelValue', 'min', 'max', 'valueOnClear', 'disabled', 'placeholder'],
      emits: ['update:modelValue'],
      template:
        '<div class="mock-input-number" :data-placeholder="placeholder" :data-disabled="String(disabled)" :data-max="max === undefined ? \'\' : String(max)" />',
    },
    // 只在 v-model 为真时渲染，否则「弹窗开没开」断言不了。
    'el-dialog': {
      name: 'ElDialogStub',
      props: ['modelValue', 'title'],
      template: '<div v-if="modelValue" class="mock-dialog"><slot /><slot name="footer" /></div>',
    },
    'el-table': {
      name: 'ElTableStub',
      props: ['data', 'rowKey', 'stripe', 'border', 'size'],
      template: '<div class="mock-table"><slot /></div>',
    },
    // 列 vnode 由 el-table 的默认插槽逐个给出；本文件不断言表格行内容，只用
    // 「渲染了几条 el-table-column + 各自的 label」钉列定义。
    'el-table-column': {
      name: 'ElTableColumnStub',
      props: ['label', 'prop', 'width', 'minWidth', 'align', 'type', 'fixed'],
      template: '<div class="mock-column" :data-label="label" :data-prop="prop"><slot /></div>',
    },
    'el-button': {
      name: 'ElButtonStub',
      props: ['link', 'type', 'size'],
      emits: ['click'],
      template: '<button class="mock-button" :data-type="type"><slot /></button>',
    },
    'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon" />' },
    'el-empty': { name: 'ElEmptyStub', template: '<div class="mock-empty" />' },
    'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
    // 本组件自己的两个辅助件与被测行为无关，桩掉省掉它们的内部依赖
    // （后者会拉 sortablejs + MutationObserver）。
    ColumnVisibilityPopover: {
      name: 'ColumnVisibilityPopoverStub',
      props: ['defs', 'modelValue'],
      template: '<div class="mock-col-vis" />',
    },
    ColumnDragHandle: {
      name: 'ColumnDragHandleStub',
      props: ['title'],
      template: '<span class="mock-drag-handle" />',
    },
  },
};

/** `<script setup>` 的顶层绑定经 VTU proxy 解包后可直接当普通值访问。 */
interface WorkTypeTabVm {
  form: {
    code: string;
    name: string;
    description: string;
    sort_order: number;
    max_held_batches: number | null;
    auto_allocate_limit: number | null;
  };
  onNew: () => void;
  onEdit: (row: WorkType) => void;
  onSave: () => Promise<void>;
  dialogVisible: boolean;
}

/** 一行合法工种（后端 `WorkTypeOut` 11 字段，键集即网络契约）。 */
function wt(over: Partial<WorkType> = {}): WorkType {
  return {
    id: '8800000000001',
    version: 1,
    code: 'WELDER',
    name: '焊工',
    description: null,
    sort_order: 1,
    max_held_batches: 5,
    auto_allocate_limit: 2,
    process_ids: ['190000000000001'],
    created_at: '2026-10-01 10:00:00',
    updated_at: '2026-10-01 10:00:00',
    ...over,
  };
}

async function mountTab() {
  const pinia = createPinia();
  setActivePinia(pinia);
  // VueQueryPlugin：`useColumnVisibility` 内部的 `useAuthStore()` 要 `useQueryClient()`，
  // 缺了会留一条注入告警（与被测行为无关，但会让输出脏）。
  const w = mount(WorkTypeTab, {
    global: {
      ...globalConfig,
      plugins: [
        pinia,
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) },
        ],
      ],
    },
  });
  await flushPromises();
  return w;
}

/** 弹窗里的数字控件按 placeholder 定位（表单里一共有三个 el-input-number：排序 /
 *  可领取上限 / 自动补料上限，靠下标会随表单加字段而整体错位）。 */
function inputByPlaceholder(w: VueWrapper, placeholder: string): DOMWrapper<Element> {
  const hit = w
    .findAll('.mock-input-number')
    .find((el) => el.attributes('data-placeholder') === placeholder);
  expect(hit, `找不到 placeholder 为「${placeholder}」的数字控件`).toBeTruthy();
  return hit!;
}

beforeEach(() => {
  localStorage.clear();
  listWorkTypesMock
    .mockReset()
    .mockResolvedValue({ items: [wt()], total: 1, limit: 200, offset: 0 });
  createWorkTypeMock.mockReset().mockResolvedValue(wt());
  updateWorkTypeMock.mockReset().mockResolvedValue(wt());
  softDeleteWorkTypeMock.mockReset().mockResolvedValue(undefined);
  elMessage.error.mockReset();
  elMessage.success.mockReset();
  elMessage.warning.mockReset();
  elMessage.info.mockReset();
});

describe('2026-10-16：工种页的「自动补料上限」（WorkTypeTab）', () => {
  it('W1：新增工种 → create payload 带 auto_allocate_limit（漏了就是「保存成功但没生效」）', async () => {
    const w = await mountTab();
    const vm = w.vm as unknown as WorkTypeTabVm;

    vm.onNew();
    vm.form.code = 'PAINTER';
    vm.form.name = '漆工';
    vm.form.max_held_batches = 5;
    vm.form.auto_allocate_limit = 2;
    await vm.onSave();
    await flushPromises();

    expect(createWorkTypeMock).toHaveBeenCalledTimes(1);
    expect(createWorkTypeMock).toHaveBeenCalledWith({
      code: 'PAINTER',
      name: '漆工',
      description: null,
      sort_order: 0,
      max_held_batches: 5,
      auto_allocate_limit: 2,
    });
  });

  // 真三态：表单恒带值，`null` 就是「清空、回到兜底补到可领取上限」。这条钉住
  // 「清空」这条路真的通 —— 把 `auto_allocate_limit` 从 payload 里删掉（或写成
  // `?? undefined`），用户就再也撤不掉已配的上限，且没有任何报错。
  it('W2：编辑工种 → update payload 带 auto_allocate_limit，清空发的是显式 null', async () => {
    const w = await mountTab();
    const vm = w.vm as unknown as WorkTypeTabVm;

    vm.onEdit(wt());
    // onEdit 必须把服务端基线填进表单（漏了就永远是空的，用户改了没反应）
    expect(vm.form.auto_allocate_limit).toBe(2);

    vm.form.auto_allocate_limit = 4;
    await vm.onSave();
    await flushPromises();

    expect(updateWorkTypeMock).toHaveBeenCalledTimes(1);
    expect(updateWorkTypeMock).toHaveBeenCalledWith('8800000000001', {
      name: '焊工',
      description: null,
      sort_order: 1,
      max_held_batches: 5,
      auto_allocate_limit: 4,
    });

    // 清空：仍是这个键、值是 null（不是 undefined —— 键缺省在后端是「不修改」）
    vm.onEdit(wt());
    vm.form.auto_allocate_limit = null;
    await vm.onSave();
    await flushPromises();
    const [, body] = updateWorkTypeMock.mock.calls[1] as [string, Record<string, unknown>];
    expect('auto_allocate_limit' in body).toBe(true);
    expect(body.auto_allocate_limit).toBeNull();
  });

  it('W3：交叉校验失败 → 零请求 + 一句能照着改的提示（auto > max）', async () => {
    const w = await mountTab();
    const vm = w.vm as unknown as WorkTypeTabVm;

    vm.onNew();
    vm.form.code = 'PAINTER';
    vm.form.name = '漆工';
    vm.form.max_held_batches = 3;
    vm.form.auto_allocate_limit = 5;
    await vm.onSave();
    await flushPromises();

    expect(createWorkTypeMock, '校验没过就不该发请求').not.toHaveBeenCalled();
    expect(elMessage.warning).toHaveBeenCalledWith('自动补料上限不能超过可领取上限');
    expect(vm.dialogVisible, '留在弹窗里让用户改').toBe(true);
  });

  it('W3b：可领取上限为空时不允许配自动补料上限（自动补料没有兜底目标）', async () => {
    const w = await mountTab();
    const vm = w.vm as unknown as WorkTypeTabVm;

    vm.onNew();
    vm.form.code = 'PAINTER';
    vm.form.name = '漆工';
    vm.form.max_held_batches = null;
    vm.form.auto_allocate_limit = 3;
    await vm.onSave();
    await flushPromises();

    expect(createWorkTypeMock).not.toHaveBeenCalled();
    expect(elMessage.warning).toHaveBeenCalledWith('配置自动补料上限前，请先配置可领取上限');
  });

  it('W3c：下界校验（auto < 1）同样零请求', async () => {
    // 控件的 `:min="1"` 只挡正常点选，挡不住直调 onSave —— 后端那边是同一个 `20104`。
    const w = await mountTab();
    const vm = w.vm as unknown as WorkTypeTabVm;

    vm.onNew();
    vm.form.code = 'PAINTER';
    vm.form.name = '漆工';
    vm.form.max_held_batches = 3;
    vm.form.auto_allocate_limit = 0;
    await vm.onSave();
    await flushPromises();

    expect(createWorkTypeMock).not.toHaveBeenCalled();
    expect(elMessage.warning).toHaveBeenCalledWith('自动补料上限必须大于等于 1');
  });

  it('W4：可领取上限为空 → 自动补料上限控件禁用并说明原因；有值时启用且上界跟随它', async () => {
    const w = await mountTab();
    const vm = w.vm as unknown as WorkTypeTabVm;

    vm.onNew();
    vm.form.max_held_batches = null;
    vm.form.auto_allocate_limit = null;
    await flushPromises();

    const auto = inputByPlaceholder(w, '留空则自动补料到可领取上限');
    expect(auto.attributes('data-disabled')).toBe('true');
    // 上界取可领取上限；未配上限时不设上界（而不是把 max 写成 0）
    expect(auto.attributes('data-max')).toBe('');
    expect(w.find('.field-hint').text()).toContain('需先配置「可领取上限」');
    // 顺手钉住 placeholder 的语义：null 是「不可领取」，不是「不限」
    expect(inputByPlaceholder(w, '留空表示该工种不可领取').exists()).toBe(true);

    vm.form.max_held_batches = 6;
    await flushPromises();
    expect(inputByPlaceholder(w, '留空则自动补料到可领取上限').attributes('data-disabled')).toBe(
      'false',
    );
    expect(inputByPlaceholder(w, '留空则自动补料到可领取上限').attributes('data-max')).toBe('6');
    expect(w.findAll('.field-hint')).toHaveLength(0);
  });

  it('W5：列表里有一列「自动补料上限」（列定义漏了就没人知道这个字段配了没有）', async () => {
    const w = await mountTab();

    const labels = w.findAll('.mock-column').map((c) => c.attributes('data-label'));
    expect(labels).toContain('自动补料上限');
    // 两个上限字段必须各自成列（都漏会把两个数字挤成同一个单元格）
    expect(labels).toContain('可领取上限');
  });
});
