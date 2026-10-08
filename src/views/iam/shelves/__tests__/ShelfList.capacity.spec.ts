// @vitest-environment happy-dom
// src/views/iam/shelves/__tests__/ShelfList.capacity.spec.ts
//
// 2026-10-10 新增：货架负载展示与容量配置的三组回归守卫。
//
// 背景：目标货架改由**后端按负载自动选择**（`current_load / capacity` 升序，capacity
// 为 null = 不限，超载不拒）。前端侧只剩两件事：货架管理页把这两个输入展示出来、
// 让管理员能改 capacity。
//
// 覆盖：
//   C 组：列表三列渲染 —— 在架件数 / 容量 / 负载率。
//     ⚠️ 断言渲染结果而不是断言 columnDefs 的字面量：`cellRender` 返回 VNode，
//     真正的输出（百分比位数、「不限」/「—」的取舍、超载档色）只有跑一遍才算数。
//   D 组：负载率上色 —— ≥100% 走 danger 且 effect=dark，<100% 走 info/plain。
//   E 组：容量编辑往返 —— 弹窗回显、保存 payload（三态）、留空发 null。
//
// 为什么不复用 ShelfList.processMapping.spec.ts 的挂载脚手架：那个文件把
// `useColumnDrag` 桩成 `orderedDefs: ref([])`（列模板不渲染，它只关心 saveShelf 的
// 守卫链路）；本文件要断言的正是列模板渲染出来的内容，得让 `orderedDefs` 真的带上
// defs。两组断言面向的面不同，各挂各的。
//
// element-plus：ElMessage 桩成 no-op 记断言；ElTag 必须真组件（columnDefs 的
// cellRender 走 h(ElTag, ...)）。vi.hoisted：vi.mock 工厂被提升，
// 普通 const 在工厂求值时尚未初始化。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, reactive, ref, type PropType } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type * as ShelvesModule from '@/api/shelves';
import type { Shelf } from '@/types/shelf';

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
    // type / effect 透出成 data-*：颜色断言不能依赖 happy-dom 里的 computed style，
    // 类名与 data-* 才是这条规则的唯一载体。
    template:
      '<span class="mock-tag" :data-type="type" :data-effect="effect ?? \'\'"><slot /></span>',
  },
  ElForm: {
    name: 'ElForm',
    props: ['model', 'rules'],
    methods: { validate: () => Promise.resolve(true) },
    template: '<form class="mock-form"><slot /></form>',
  },
}));

const listShelvesMock = vi.fn();
const createShelfMock = vi.fn();
const updateShelfMock = vi.fn();
const deactivateShelfMock = vi.fn();
const getShelfProcessesMock = vi.fn();
const setShelfProcessesMock = vi.fn();
const listProcessesMock = vi.fn();

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

// 与 processMapping spec 同款桩：列可见性 / 拖动都依赖 Pinia + Sortable，与本组无关。
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

// **关键差异**：`orderedDefs` 真的带上 defs（processMapping spec 里是空数组），
// 列模板才会渲染、cellRender 才会被调。
vi.mock('@/composables/useColumnDrag', () => ({
  useColumnDrag: (defs: unknown[]) => ({
    orderedKeys: ref<string[]>([]),
    orderedDefs: ref(defs),
    applyDrag: vi.fn(),
    dragLabelClass: () => '',
    reset: vi.fn(),
    clear: vi.fn(),
    isBound: () => false,
  }),
  columnIdentifier: (def: { key: string }) => def.key,
}));

import ShelfList from '../ShelfList.vue';

const globalConfig = {
  stubs: {
    ColumnVisibilityPopover: { template: '<div class="stub-colvis" />' },
    ColumnDragHandle: { template: '<span class="stub-drag-handle" />' },
  },
  directives: { loading: {} },
  components: {
    'el-button': {
      name: 'ElButton',
      emits: ['click'],
      template: '<button class="mock-button" @click="$emit(\'click\')"><slot /></button>',
    },
    // 本组的核心：真实 el-table 才是「把 data 的每一行喂给每个 column 的默认插槽」的
    // 那个组件，桩里不做的话 column 只会被渲染一次、且拿到空 row ⇒ cellRender 读到的
    // capacity 恒 undefined，全部断言都会假绿成「—」。这里用 provide / inject 把 data
    // 传给列，列自己逐行渲染默认插槽。
    'el-table': defineComponent({
      name: 'ElTable',
      // computed 而非直接给数组：provide 只在创建时求值一次，而 data 初始为空、
      // fetchData 之后才填上 —— 直接给值会把「空数组」永久固化下去。
      provide() {
        return { rows: computed(() => this.data) };
      },
      props: { data: { type: Array as PropType<Shelf[]>, default: () => [] } },
      template: '<div class="mock-table"><slot /></div>',
    }),
    'el-table-column': {
      name: 'ElTableColumn',
      props: ['prop', 'label', 'width', 'minWidth', 'align', 'sortable', 'columnKey'],
      inject: { rows: { default: () => [] } },
      // label 落在 data-label 上（不放文本里，否则「列名」和「单元格内容」在同一段
      // text() 里，按 label 找列会误匹配到别的列去）。
      template:
        '<div class="mock-column" :data-label="label">' +
        '<div class="mock-cell" v-for="(r, i) in rows" :key="i"><slot :row="r" :$index="i" /></div>' +
        '</div>',
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
      emits: ['change', 'update:modelValue'],
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
    'el-empty': {
      name: 'ElEmpty',
      props: ['description'],
      template: '<div class="mock-empty" />',
    },
  },
};

interface ShelfListVm {
  editShelf: (s: Shelf) => Promise<void>;
  saveShelf: () => Promise<void>;
  resetForm: () => void;
  showCreate: boolean;
  shelfForm: {
    code: string;
    name: string;
    zone: string;
    location: string;
    capacity: number | undefined;
  };
}

/** 造一个货架行（只写本组关心的字段，其余给合法默认值）。 */
function shelf(over: Partial<Shelf> & { id: string; code: string }): Shelf {
  return {
    version: 1,
    name: over.code,
    zone: 'PRODUCTION',
    location: null,
    is_active: true,
    capacity: null,
    current_load: 0,
    display_order: 0,
    created_at: '2026-09-01 10:00:00',
    updated_at: '2026-09-30 11:00:00',
    ...over,
  };
}

/** 某一列（按列 label 找，不靠下标 —— 加列会让下标错位）逐行渲染出的文本。 */
function columnCells(w: VueWrapper, label: string): string[] {
  const col = w.findAll('.mock-column').find((n) => n.attributes('data-label') === label);
  if (!col) throw new Error(`模板里找不到列「${label}」`);
  return col.findAll('.mock-cell').map((n) => n.text());
}

/**
 * 负载率列第 `i` 行渲染出的标签：文案 + ElTag 的 type / effect。
 * 颜色断言只能看 data-*（happy-dom 里没有 computed style，vitest 也不处理 SFC 的
 * `<style>`），type / effect 就是这条规则的唯一载体。
 */
function loadRatioCells(w: VueWrapper): { text: string; type?: string; effect?: string }[] {
  const col = w.findAll('.mock-column').find((n) => n.attributes('data-label') === '负载率');
  if (!col) throw new Error('模板里找不到「负载率」列');
  return col.findAll('.mock-cell').map((cell) => {
    const tag = cell.find('.mock-tag');
    return {
      text: cell.text(),
      type: tag.exists() ? (tag.attributes('data-type') ?? undefined) : undefined,
      effect: tag.exists() ? (tag.attributes('data-effect') ?? undefined) : undefined,
    };
  });
}

async function mountShelfList(items: Shelf[]) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  listShelvesMock.mockResolvedValue({ items, total: items.length, limit: 200, offset: 0 });
  const w = mount(ShelfList, {
    global: { ...globalConfig, plugins: [[VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return w;
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
  listProcessesMock.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
  getShelfProcessesMock.mockResolvedValue({ items: [] });
  setShelfProcessesMock.mockResolvedValue(undefined);
  updateShelfMock.mockImplementation(async (_id: string, p: object) => ({
    ...shelf({ id: 'X', code: 'X' }),
    ...p,
  }));
  createShelfMock.mockImplementation(async (p: { code: string }) => ({
    ...shelf({ id: 'NEW1', code: p.code }),
    ...p,
  }));
});

describe('货架管理页 · 负载列渲染', () => {
  // 「不限」与「—」是两处不同的取舍，别混：
  //   容量列对无上限架显示「不限」（= 有意不限，是配置结论）；
  //   负载率列对无上限架显示「—」（= 没有百分比这个量，不是 0%）。
  // 写成「不限 / 0%」会让管理员以为那个架是空的 —— 而它可能是全场最满的。
  it('C1：capacity 为 null → 容量列「不限」、负载率列「—」（不染 ElTag）', async () => {
    const w = await mountShelfList([
      shelf({ id: '1', code: 'A1', capacity: null, current_load: 80 }),
    ]);

    expect(columnCells(w, '容量')).toEqual(['不限']);
    const ratio = loadRatioCells(w);
    expect(ratio[0]!.text).toBe('—');
    expect(ratio[0]!.type, '无容量不该染 ElTag（否则读成一个具体档位）').toBeUndefined();
  });

  it('C2：capacity <= 0 同样按「不限」处理（后端口径：<= 0 即不限）', async () => {
    const w = await mountShelfList([shelf({ id: '1', code: 'A1', capacity: 0, current_load: 5 })]);
    expect(columnCells(w, '容量')).toEqual(['不限']);
    expect(loadRatioCells(w)[0]!.text).toBe('—');
  });

  // 用户给的例子：A1 80/100、A2 100/200、A3 100/150 ⇒ 80% / 50% / 66.7%，
  // 后端选 A2（最空的那一档）。前端只负责把这三个百分比如实渲染出来。
  it('C3：多架逐行渲染「在架件数 + 容量 + 负载率」', async () => {
    const w = await mountShelfList([
      shelf({ id: '1', code: 'A1', capacity: 100, current_load: 80 }),
      shelf({ id: '2', code: 'A2', capacity: 200, current_load: 100 }),
      shelf({ id: '3', code: 'A3', capacity: 150, current_load: 100 }),
    ]);

    expect(columnCells(w, '在架')).toEqual(['80 件', '100 件', '100 件']);
    expect(columnCells(w, '容量')).toEqual(['100', '200', '150']);
    expect(loadRatioCells(w).map((r) => r.text)).toEqual(['80.0%', '50.0%', '66.7%']);
  });

  // 超载不是错误（后端不拒），但它是「该扩货架 / 调 capacity」的信号 ⇒ 醒目色。
  // 恰在 100%（100/100）也算：那一刻已经满了，下一次投放就会超。
  it('D1：恰好 100% 与超过 100% 都走 danger 档（effect=dark）', async () => {
    const w = await mountShelfList([
      shelf({ id: '1', code: 'A1', capacity: 100, current_load: 100 }),
      shelf({ id: '2', code: 'A2', capacity: 100, current_load: 150 }),
      shelf({ id: '3', code: 'A3', capacity: 100, current_load: 99 }),
    ]);
    const cells = loadRatioCells(w);
    expect(cells[0]).toMatchObject({ text: '100.0%', type: 'danger', effect: 'dark' });
    expect(cells[1]).toMatchObject({ text: '150.0%', type: 'danger', effect: 'dark' });
    // 99% 还不到警戒线：走普通档，effect 也是 plain
    expect(cells[2]).toMatchObject({ text: '99.0%', type: 'info', effect: 'plain' });
  });

  // 边界：current_load 为 0 的**有容量**架是货真价实的 0.0%（空架），
  // 与「无容量 → —」是两回事，别被 null 兜底吃掉。
  it('D2：有容量 + 在架 0 件 → 0.0%（不是「—」）', async () => {
    const w = await mountShelfList([
      shelf({ id: '1', code: 'A1', capacity: 100, current_load: 0 }),
    ]);
    expect(loadRatioCells(w)[0]).toMatchObject({ text: '0.0%', type: 'info' });
  });
});
describe('货架管理页 · 容量编辑往返', () => {
  it('E1：编辑态回显 capacity；保存时 payload 带 capacity', async () => {
    const s = shelf({ id: '8800000000001', code: 'A1', capacity: 120, current_load: 30 });
    const w = await mountShelfList([s]);
    const vm = w.vm as unknown as ShelfListVm;

    await vm.editShelf(s);
    await flushPromises();

    expect(vm.shelfForm.capacity).toBe(120);
    // 弹窗里真的有「容量」表单项
    expect(w.findAll('.mock-label').map((n) => n.text())).toContain('容量');

    await vm.saveShelf();
    await flushPromises();

    expect(updateShelfMock).toHaveBeenCalledTimes(1);
    expect(updateShelfMock.mock.calls[0]![1]).toMatchObject({ capacity: 120 });
  });

  // 编辑路径上「留空」必须发 `null`（= 清空上限）而不是省略字段：省略会命中
  // updateShelf 的「不传 = 不改」，用户明明清空了容量却什么都没改，而 capacity 是
  // 选架分母，留个陈旧上限比留空更糟。
  it('E2：capacity 为 null 的架 → 表单留空，保存发 capacity: null', async () => {
    const s = shelf({ id: '8800000000001', code: 'A1', capacity: null, current_load: 30 });
    const w = await mountShelfList([s]);
    const vm = w.vm as unknown as ShelfListVm;

    await vm.editShelf(s);
    await flushPromises();
    expect(vm.shelfForm.capacity).toBeUndefined();

    await vm.saveShelf();
    await flushPromises();

    expect(updateShelfMock.mock.calls[0]![1]).toHaveProperty('capacity', null);
  });

  // capacity <= 0 落成「留空」：后端把 <= 0 读作不限，输入框里摆一个 0 会让
  // 管理员以为「上限 0 件」（= 一个都放不下），与实际语义相反。
  it('E3：capacity = 0 的架 → 表单落成留空（不显示 0）', async () => {
    const s = shelf({ id: '8800000000001', code: 'A1', capacity: 0, current_load: 30 });
    const w = await mountShelfList([s]);
    const vm = w.vm as unknown as ShelfListVm;

    await vm.editShelf(s);
    await flushPromises();
    expect(vm.shelfForm.capacity).toBeUndefined();
  });

  it('E4：新增路径同样带 capacity（留空发 null）', async () => {
    const w = await mountShelfList([]);
    const vm = w.vm as unknown as ShelfListVm;
    vm.showCreate = true;
    await flushPromises();

    vm.shelfForm.code = 'A9';
    vm.shelfForm.name = '新架';
    await vm.saveShelf();
    await flushPromises();

    expect(createShelfMock).toHaveBeenCalledTimes(1);
    expect(createShelfMock.mock.calls[0]![0]).toMatchObject({ code: 'A9', capacity: null });

    // 复位：否则「编辑一个有容量的架 → 关闭 → 新增」会把上一个架的 capacity 带进来
    vm.resetForm();
    expect(vm.shelfForm.capacity).toBeUndefined();
  });

  it('E5：用户在表单里改容量后保存走新值', async () => {
    const s = shelf({ id: '8800000000001', code: 'A1', capacity: 120, current_load: 30 });
    const w = await mountShelfList([s]);
    const vm = w.vm as unknown as ShelfListVm;

    await vm.editShelf(s);
    await flushPromises();
    vm.shelfForm.capacity = 250;
    await vm.saveShelf();
    await flushPromises();

    expect(updateShelfMock.mock.calls[0]![1]).toMatchObject({ capacity: 250 });
  });
});
