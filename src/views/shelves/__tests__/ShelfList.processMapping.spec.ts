// @vitest-environment happy-dom
// src/views/shelves/__tests__/ShelfList.processMapping.spec.ts
//
// 2026-10-02 review I-1 新增：BUG-2（静默清空整组工序映射）的**最后一道闸**的
// 回归守卫 —— 「已映射工序加载失败后点保存，映射不得被清空」。
//
// 背景：ShelfList.vue 的编辑弹窗走
//   点「编辑」→ GET /shelves/{id}/processes → 填 el-select multiple → 点「保存」
//     → POST /shelves/{id}/processes（**整组替换**，items: [] 即清空）
// 而 `@closed="resetForm"`（ShelfList.vue:77）会在弹窗关闭时把 selectedProcessIds
// 清成 []。于是「catch 里不覆盖 = 保持原状」在「加载失败后不关弹窗直接点保存」这条
// 路径上等于「留空」⇒ setShelfProcesses(id, {items: []}) ⇒ 该货架全部工序映射被清空。
// warning 文案「请关闭后重试」只是建议，拦不住保存动作。
// ⇒ 必须用状态位（processLoadFailed）在 saveShelf 里硬拦。
//
// 为什么这个文件放在 views/shelves/__tests__ 而不是 api/：
//   被测的守卫是**视图层**的（ref 状态位 + saveShelf 早退），api 层拿不到
//   processLoadFailed；反过来 src/api/shelfProcesses.spec.ts 已把两个纯函数
//   （toShelfProcessIds / toShelfProcessesPayload）逐字钉死，本文件复用它们
//   （importOriginal，不桩成假实现），保证「读形态 → 写形态」两端仍是真代码。
//
// 为什么直接调 vm.editShelf / vm.saveShelf 而不点 DOM 按钮：
//   表格行内的「编辑」按钮最终就是调 editShelf(row)，但要让它可点就得复刻
//   Element Plus 的 el-table ↔ el-table-column 插槽作用域协议（column 的
//   `{row}` 是 EP 从 table 上下文注入的，仓内既有的轻量 stub —— 见
//   dashboard/components/__tests__/UpcomingDeliveryListDrawer.spec.ts 的
//   `<slot :row="{}" />` —— 只能给空对象）。这里被测的是**守卫逻辑**而不是
//   点击链路，setup 暴露的函数是同一条路径的入口，直接调更稳、噪声更低。
//
// element-plus：CLAUDE.md 架构条目 §9 —— ElMessage 在 vitest env 会碰
// document / 内部 normalizeAppendTo，桩成 no-op 记断言。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick, reactive, ref } from 'vue';
// 供 vi.mock 的 importOriginal 泛型使用（@typescript-eslint/consistent-type-imports
// 禁止 `import()` 形式类型注解；沿 usePendingDispatch.spec.ts:42 同款）
import type * as ShelvesModule from '@/api/shelves';
import type { Shelf } from '@/types/shelf';
// ---------------------------------------------------------------- element-plus
// ElMessage 桩成可断言 spy；ElTag 必须是真组件（ShelfList 的 columnDefs cellRender
// 走 h(ElTag, ...)，模板渲染列时会真调）。
// vi.hoisted：vi.mock 工厂被提升到文件顶部，普通 const 声明在工厂求值时尚未初始化。
const elMessage = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock('element-plus', () => ({
  ElMessage: elMessage,
  ElTag: {
    name: 'ElTag',
    props: ['type', 'size', 'effect'],
    template: '<span class="mock-tag"><slot /></span>',
  },
  // ElForm 必须带 validate()：ShelfList.saveShelf 第一步就是
  // `await shelfFormRef.value?.validate()`，缺这个方法会 TypeError 而不是断在守卫上。
  // 注意它必须在这里给全 —— ShelfList.vue:143 用 `<script setup>` 显式 import 了
  // ElForm，模板里的 `<el-form>` 会优先解析到这个**局部绑定**，
  // global.components['el-form'] 根本轮不到。
  ElForm: {
    name: 'ElForm',
    props: ['model', 'rules'],
    methods: { validate: () => Promise.resolve(true) },
    template: '<form class="mock-form"><slot /></form>',
  },
}));

// ---------------------------------------------------------------- api 桩
const listShelvesMock = vi.fn();
const createShelfMock = vi.fn();
const updateShelfMock = vi.fn();
const deactivateShelfMock = vi.fn();
const getShelfProcessesMock = vi.fn();
const setShelfProcessesMock = vi.fn();
const listProcessesMock = vi.fn();

// importOriginal：两个纯函数 toShelfProcessIds / toShelfProcessesPayload 走真实现
// （它们已被 src/api/shelfProcesses.spec.ts 逐字钉死），只桩 4 个发请求的函数。
vi.mock('@/api/shelves', async (importOriginal) => ({
  ...(await importOriginal<typeof ShelvesModule>()),
  listShelves: (...args: unknown[]) => listShelvesMock(...args),
  createShelf: (...args: unknown[]) => createShelfMock(...args),
  updateShelf: (...args: unknown[]) => updateShelfMock(...args),
  deactivateShelf: (...args: unknown[]) => deactivateShelfMock(...args),
  getShelfProcesses: (...args: unknown[]) => getShelfProcessesMock(...args),
  setShelfProcesses: (...args: unknown[]) => setShelfProcessesMock(...args),
}));

vi.mock('@/api/process', () => ({
  listProcesses: (...args: unknown[]) => listProcessesMock(...args),
}));

// ---------------------------------------------------------------- 列可见性 / 列拖动桩
// 真实实现依赖 Pinia（useColumnVisibility → useAuthStore）与 Sortable
// （useColumnDrag → vue-draggable-plus），与本用例的被测逻辑无关，整体桩掉，
// 顺带避免 localStorage 残留把列可见性断言搅乱。
vi.mock('@/composables/useColumnVisibility', () => ({
  useColumnVisibility: () => ({
    currentMap: reactive<Record<string, boolean>>({}),
    isVisible: () => true,
    toggle: vi.fn(),
    update: vi.fn(),
    showAll: vi.fn(),
    hideAll: vi.fn(),
    allKeys: [] as string[],
  }),
  resolveDraggable: (def: { draggable?: boolean; type?: string; fixed?: unknown }) =>
    def.draggable ?? (def.type === undefined && def.fixed === undefined),
}));

vi.mock('@/composables/useColumnDrag', () => ({
  useColumnDrag: () => ({
    orderedKeys: ref<string[]>([]),
    orderedDefs: ref<unknown[]>([]),
    applyDrag: vi.fn(),
    dragLabelClass: () => '',
    reset: vi.fn(),
    clear: vi.fn(),
    isBound: () => false,
  }),
  columnIdentifier: (def: { key: string }) => def.key,
}));

import ShelfList from '../ShelfList.vue';

// ---------------------------------------------------------------- EP 模板桩
// 沿 UpcomingDeliveryListDrawer.spec.ts 同款做法：`vi.mock('element-plus')` 替换
// 的 module export 不会进组件表，需手动用 kebab-case 注册。
// el-form 必须带 `validate()` —— ShelfList.saveShelf 第一步就是
// `await shelfFormRef.value?.validate()`，没这个方法会 TypeError 而不是断在守卫上。
const globalConfig = {
  stubs: {
    ColumnVisibilityPopover: { template: '<div class="stub-colvis" />' },
    ColumnDragHandle: { template: '<span class="stub-drag-handle" />' },
  },
  directives: {
    // v-loading（EP 指令）在模板里以 v-loading 形式出现，这里给个 no-op 免得刷警告
    loading: {},
  },
  components: {
    'el-button': {
      name: 'ElButton',
      emits: ['click'],
      template: '<button class="mock-button" @click="$emit(\'click\')"><slot /></button>',
    },
    'el-table': {
      name: 'ElTable',
      props: ['data', 'rowKey', 'emptyText', 'stripe', 'defaultSort'],
      // 只渲染默认插槽（列定义）；#empty 槽不还原（用例不依赖空态）。
      template: '<div class="mock-table"><slot /></div>',
    },
    'el-table-column': {
      name: 'ElTableColumn',
      props: ['prop', 'label', 'width', 'minWidth', 'align', 'sortable', 'columnKey'],
      // 作用域给空对象：cellRender 读 row 全部走 ?? 兜底，不会抛。
      template: '<div class="mock-column"><slot :row="{}" /></div>',
    },
    'el-dialog': {
      name: 'ElDialog',
      props: ['modelValue', 'title', 'width', 'top', 'fullscreen'],
      emits: ['closed', 'update:modelValue'],
      template:
        '<div class="mock-dialog" v-if="modelValue"><slot /><div class="mock-footer"><slot name="footer" /></div></div>',
    },
    'el-form-item': {
      name: 'ElFormItem',
      props: ['label', 'prop'],
      template:
        '<div class="mock-form-item"><span class="mock-label">{{ label }}</span><slot /></div>',
    },
    'el-input': {
      name: 'ElInput',
      props: ['modelValue'],
      template: '<input class="mock-input" />',
    },
    'el-input-number': {
      name: 'ElInputNumber',
      props: ['modelValue'],
      template: '<i class="mock-num" />',
    },
    'el-select': {
      name: 'ElSelect',
      props: ['modelValue', 'multiple'],
      template: '<div class="mock-select"><slot /></div>',
    },
    'el-option': {
      name: 'ElOption',
      props: ['label', 'value'],
      template: '<i class="mock-option" />',
    },
    'el-popconfirm': {
      name: 'ElPopconfirm',
      props: ['title'],
      template: '<div class="mock-popconfirm"><slot name="reference" /></div>',
    },
    'el-empty': { name: 'ElEmpty', props: ['description'], template: '<div class="mock-empty" />' },
  },
};

/** `<script setup>` 的顶层绑定经 VTU proxy 解包后可直接当普通值访问。 */
interface ShelfListVm {
  editShelf: (s: Shelf) => Promise<void>;
  saveShelf: () => Promise<void>;
  resetForm: () => void;
  showCreate: boolean;
  editingShelf: Shelf | null;
  selectedProcessIds: string[];
  processLoadFailed: boolean;
}

const SHELF: Shelf = {
  id: '8800000000001',
  version: 2,
  code: 'SH-P01',
  name: '生产架 01',
  zone: 'PRODUCTION',
  location: null,
  is_active: true,
  display_order: 1,
  created_at: '2026-09-01 10:00:00',
  updated_at: '2026-09-30 11:00:00',
};

/** 后端 GET /shelves/{id}/processes 的真实响应形态（sort_order 必返）。 */
const EXISTING = {
  items: [
    {
      shelf_id: '8800000000001',
      shelf_code: 'SH-P01',
      process_id: '190000000000001',
      process_code: 'CUT',
      sort_order: 0,
    },
    {
      shelf_id: '8800000000001',
      shelf_code: 'SH-P01',
      process_id: '190000000000002',
      process_code: 'WELD',
      sort_order: 1,
    },
  ],
};

async function mountShelfList() {
  const wrapper = mount(ShelfList, { global: globalConfig });
  await flushPromises();
  return wrapper;
}

/** 模拟用户「关闭弹窗」：先 v-model 置 false（@update:model-value），再走
 *  `@closed="resetForm"`（ShelfList.vue:77）。两步都要发 —— resetForm 只清表单与
 *  选中态，不碰 showCreate（真正关闭是弹窗自己的 v-model 干的）。 */
async function closeDialog(wrapper: Awaited<ReturnType<typeof mountShelfList>>) {
  wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('update:modelValue', false);
  await flushPromises();
  wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('closed');
  await flushPromises();
}

beforeEach(() => {
  listShelvesMock.mockReset();
  createShelfMock.mockReset();
  updateShelfMock.mockReset();
  deactivateShelfMock.mockReset();
  getShelfProcessesMock.mockReset();
  setShelfProcessesMock.mockReset();
  listProcessesMock.mockReset();
  elMessage.error.mockReset();
  elMessage.success.mockReset();
  elMessage.warning.mockReset();
  elMessage.info.mockReset();

  // onMounted 里的两个拉取：默认都成功。
  listShelvesMock.mockResolvedValue({ items: [SHELF], total: 1, limit: 200, offset: 0 });
  listProcessesMock.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
  createShelfMock.mockImplementation(async (p: { code: string }) => ({
    ...SHELF,
    ...p,
    id: 'NEW1',
  }));
  updateShelfMock.mockResolvedValue(SHELF);
  deactivateShelfMock.mockResolvedValue(SHELF);
  setShelfProcessesMock.mockResolvedValue(undefined);
});

describe('2026-10-02 review I-1：映射加载失败后保存不得清空整组映射（ShelfList）', () => {
  it('P1：加载失败后点保存 → setShelfProcesses 零调用（映射不被清空），且基本字段也不落盘', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getShelfProcessesMock.mockRejectedValue(new Error('500 boom'));

    const wrapper = await mountShelfList();
    const vm = wrapper.vm as unknown as ShelfListVm;

    await vm.editShelf(SHELF);
    await flushPromises();

    // 失败态确实被记录（这是 saveShelf 早退的唯一依据）
    expect(vm.processLoadFailed).toBe(true);
    // 失败时 selectedProcessIds 保持原状（不被清成 []，这是上一轮 review 已修的部分）
    expect(vm.selectedProcessIds).toEqual([]);
    expect(elMessage.warning).toHaveBeenCalledTimes(1);

    await vm.saveShelf();
    await flushPromises();

    // 核心断言：绝不能发出整组替换请求 —— 发了就等于清空该架全部映射。
    expect(setShelfProcessesMock).not.toHaveBeenCalled();
    // 选「整单早退」而非「只存基本字段」：半截保存会造出「名字改了、映射没改」的
    // 新状态，且用户在成功提示里无从分辨自己改的哪部分生效了。
    expect(updateShelfMock).not.toHaveBeenCalled();
    expect(createShelfMock).not.toHaveBeenCalled();
    expect(elMessage.error).toHaveBeenCalledWith(
      '工序映射加载失败，未做任何保存：请关闭弹窗后重新进入再试',
    );
    // 弹窗保持打开（用户能看见失败态，不会以为已保存）
    expect(vm.showCreate).toBe(true);
    consoleError.mockRestore();
  });

  it('P1b：加载失败后的「已选工序」即使被用户手动改过，保存仍被拦（不信任未知态）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getShelfProcessesMock.mockRejectedValue(new Error('500 boom'));

    const wrapper = await mountShelfList();
    const vm = wrapper.vm as unknown as ShelfListVm;
    await vm.editShelf(SHELF);
    await flushPromises();

    // 模拟用户在失败弹窗里手动勾了 2 个工序再点保存：即便有值也不能提交 ——
    // 提交 = 用「加载失败时看到的不完整快照」整组覆盖真实映射。
    vm.selectedProcessIds = ['190000000000001', '190000000000003'];

    await vm.saveShelf();
    await flushPromises();

    expect(setShelfProcessesMock).not.toHaveBeenCalled();
    expect(updateShelfMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('P2（对照组）：加载成功 → 保存照常发出整组替换，items 逐字等于已有映射', async () => {
    getShelfProcessesMock.mockResolvedValue(EXISTING);

    const wrapper = await mountShelfList();
    const vm = wrapper.vm as unknown as ShelfListVm;
    await vm.editShelf(SHELF);
    await flushPromises();

    // 守卫没误伤正常路径
    expect(vm.processLoadFailed).toBe(false);
    expect(vm.selectedProcessIds).toEqual(['190000000000001', '190000000000002']);

    await vm.saveShelf();
    await flushPromises();

    expect(updateShelfMock).toHaveBeenCalledTimes(1);
    expect(setShelfProcessesMock).toHaveBeenCalledTimes(1);
    expect(setShelfProcessesMock).toHaveBeenCalledWith('8800000000001', {
      items: [
        { process_id: '190000000000001', sort_order: 0 },
        { process_id: '190000000000002', sort_order: 1 },
      ],
    });
    expect(elMessage.error).not.toHaveBeenCalled();
  });

  it('P3（对照组）：加载成功 + 用户主动清空 → items: [] 照发（空 items 只在成功态才是用户意图）', async () => {
    getShelfProcessesMock.mockResolvedValue(EXISTING);

    const wrapper = await mountShelfList();
    const vm = wrapper.vm as unknown as ShelfListVm;
    await vm.editShelf(SHELF);
    await flushPromises();

    vm.selectedProcessIds = [];
    await vm.saveShelf();
    await flushPromises();

    expect(setShelfProcessesMock).toHaveBeenCalledWith('8800000000001', { items: [] });
  });

  it('P4：加载失败 → 关闭弹窗 → 重新进入编辑且加载成功 → 保存正常（失败状态位必须复位）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getShelfProcessesMock.mockRejectedValueOnce(new Error('500 boom'));

    const wrapper = await mountShelfList();
    const vm = wrapper.vm as unknown as ShelfListVm;
    await vm.editShelf(SHELF);
    await flushPromises();
    expect(vm.processLoadFailed).toBe(true);

    await closeDialog(wrapper);
    expect(vm.showCreate).toBe(false);

    getShelfProcessesMock.mockResolvedValue(EXISTING);
    await vm.editShelf(SHELF);
    await flushPromises();
    // editShelf 开头复位 —— 上一次会话的失败态不得残留
    expect(vm.processLoadFailed).toBe(false);

    await vm.saveShelf();
    await flushPromises();

    expect(setShelfProcessesMock).toHaveBeenCalledTimes(1);
    expect(setShelfProcessesMock).toHaveBeenCalledWith('8800000000001', {
      items: [
        { process_id: '190000000000001', sort_order: 0 },
        { process_id: '190000000000002', sort_order: 1 },
      ],
    });
    consoleError.mockRestore();
  });

  it('P5：加载失败 → 关闭弹窗 → 新增货架 → 保存不被拦（resetForm 复位，不误伤新增路径）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getShelfProcessesMock.mockRejectedValue(new Error('500 boom'));

    const wrapper = await mountShelfList();
    const vm = wrapper.vm as unknown as ShelfListVm;
    await vm.editShelf(SHELF);
    await flushPromises();

    await closeDialog(wrapper);

    // 新增路径压根没加载过映射，processLoadFailed 必须已被 resetForm 清掉，
    // 否则「编辑失败 → 关闭 → 新增 → 保存」会被上一个会话的失败态误伤。
    // 等一拍让 el-form 重新挂上：saveShelf 第一步要调 shelfFormRef.validate()。
    vm.showCreate = true;
    await nextTick();
    await vm.saveShelf();
    await flushPromises();

    expect(createShelfMock).toHaveBeenCalledTimes(1);
    expect(setShelfProcessesMock).toHaveBeenCalledTimes(1);
    expect(setShelfProcessesMock).toHaveBeenCalledWith('NEW1', { items: [] });
    expect(elMessage.error).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
