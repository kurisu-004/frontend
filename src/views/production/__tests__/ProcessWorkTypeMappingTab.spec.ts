// @vitest-environment happy-dom
// src/views/production/__tests__/ProcessWorkTypeMappingTab.spec.ts
//
// 2026-10-02 新增：工序映射 Tab 的**「静默清空整组映射」最后一道闸**回归守卫
// （照搬 src/views/shelves/__tests__/ShelfList.processMapping.spec.ts 的 P1/P1b/
// P2/P3/P4 五条 —— 那份是同一类缺陷在货架域的姊妹实现，形态、理由、断言粒度
// 全部可对照；本域更危险：ShelfList 的失败态还能靠「关闭弹窗」自然恢复，本域是
// 同屏常驻 Tab，失败态会一直摆在用户面前）。
//
// 背景：本端点走**整组替换**（后端 service 先 `soft_delete_all_for_work_type` →
// `bulk_insert`，`items: []` = 清空）。旧实现的危险组合：
//   ① 加载失败时 `initialProcessIds` **残留上一个工种的 id**（catch 里直接 return，
//      不清零）；
//   ② dirty watcher 拿它当基线 → 切到加载失败的工种时立刻把 dirty 置 true；
//   ③ 保存按钮只判 `!dirty` → 直接可点；
//   ④ onSave 毫无失败判断 → 用「加载失败时看到的空/残缺勾选」整组覆盖真实映射，
//      后端返 200 + 「已保存」，用户完全无从察觉映射被清掉。
// 修法：onSave 开头用 query 的 `isError` / `!data` 硬拦 + 按钮 disabled。
//
// 2026-10-02 追加 P8：同文件的**渲染守卫**用例（未选工种时右侧不渲染勾选区）。
// 与 P1~P7 的写路径守卫是两个独立缺陷 —— 前者防「保存时把映射清空」，后者防
// 「未选工种时右侧一直转圈」；两者只共用这份脚手架（EP 模板桩 + api 桩）。
//
// 为什么直接调 vm.onSelectWT / vm.onSave 而不点 DOM 按钮：
//   表格行点击最终就是调 onSelectWT(row)，但要让它可点就得复刻 Element Plus 的
//   el-table ↔ el-table-column 插槽作用域协议（column 的 `{row}` 是 EP 从 table
//   上下文注入的）。这里被测的是**守卫逻辑**而不是点击链路，setup 暴露的函数是
//   同一条路径的入口，直接调更稳、噪声更低（与 ShelfList.processMapping.spec.ts
//   的「直接调 vm.editShelf / vm.saveShelf」同款理由）。
//
// element-plus：CLAUDE.md 架构条目 §9 —— ElMessage 在 vitest env 会碰 document /
// 内部 normalizeAppendTo，桩成 no-op 记断言。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
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
  ElTag: {
    name: 'ElTag',
    props: ['type', 'size', 'effect'],
    template: '<span class="mock-tag"><slot /></span>',
  },
}));

// ---------------------------------------------------------------- api 桩
const listWorkTypesMock = vi.fn();
const getWorkTypeProcessesMock = vi.fn();
const setWorkTypeProcessesMock = vi.fn();
const listProcessesMock = vi.fn();

// importOriginal：两个纯函数 toWorkTypeProcessIds / toWorkTypeProcessesPayload 走真
// 实现（已被 src/api/workType.spec.ts 逐字钉死），只桩发请求的函数 —— 保证
// 「读形态 → 写形态」两端仍是真代码。
vi.mock('@/api/workType', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkTypeModule>()),
  listWorkTypes: (...args: unknown[]) => listWorkTypesMock(...args),
  getWorkTypeProcesses: (...args: unknown[]) => getWorkTypeProcessesMock(...args),
  setWorkTypeProcesses: (...args: unknown[]) => setWorkTypeProcessesMock(...args),
}));

// 工序走共享 useProcessesQuery，queryFn 走 processListResultSchema.parse 守门 ——
// 所以这里的 mock 必须是**后端真实形态**（ProcessOut 12 字段，2026-10-02 review 第 1
// 轮订正：原注释写 11 是抄自 schemas.ts 的旧误数，漏了 is_cnc），不能是「够用就行」
// 的半截对象。
vi.mock('@/api/process', () => ({
  listProcesses: (...args: unknown[]) => listProcessesMock(...args),
}));

import ProcessWorkTypeMappingTab from '../components/ProcessWorkTypeMappingTab.vue';

// ---------------------------------------------------------------- EP 模板桩
const globalConfig = {
  stubs: {
    // v-loading（EP 指令）在模板里以 v-loading 形式出现，这里给个 no-op 免得刷警告
  },
  directives: {
    loading: {},
  },
  components: {
    'el-button': {
      name: 'ElButton',
      emits: ['click'],
      template: '<button class="mock-button"><slot /></button>',
    },
    'el-table': {
      name: 'ElTable',
      props: ['data', 'rowKey', 'emptyText', 'stripe'],
      template: '<div class="mock-table"><slot /></div>',
    },
    'el-table-column': {
      name: 'ElTableColumn',
      props: ['prop', 'label', 'minWidth', 'align'],
      // 作用域给空对象：列定义渲染时不读 row。
      template: '<div class="mock-column"><slot :row="{}" /></div>',
    },
    'el-checkbox-group': {
      name: 'ElCheckboxGroup',
      props: ['modelValue'],
      // 勾选项由 el-checkbox 的默认插槽渲染；用例直接改 vm.selectedProcessIds
      // 模拟用户勾选，不复刻 EP 的 v-model 双向协议（与 ShelfList 那份同款理由）。
      template: '<div class="mock-checkbox-group"><slot /></div>',
    },
    'el-checkbox': {
      name: 'ElCheckbox',
      props: ['value', 'label', 'border'],
      template: '<div class="mock-checkbox"><slot /></div>',
    },
  },
};

/** `<script setup>` 的顶层绑定经 VTU proxy 解包后可直接当普通值访问。 */
interface TabVm {
  onSelectWT: (w: WorkType) => void;
  onSave: () => Promise<void>;
  selectedProcessIds: string[];
  workTypes: WorkType[];
  dirty: boolean;
}

const WT: WorkType = {
  id: '8800000000001',
  version: 1,
  code: 'WELDER',
  name: '焊工',
  description: null,
  sort_order: 1,
  max_held_batches: null,
  process_ids: ['190000000000001', '190000000000002'],
  created_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-01 10:00:00',
};

/** 后端 GET /prod/work-types/{id}/processes 的真实响应形态（4 字段全必填）。 */
const EXISTING = {
  items: [
    {
      work_type_id: '8800000000001',
      process_id: '190000000000001',
      process_code: 'CUT',
      sort_order: 0,
    },
    {
      work_type_id: '8800000000001',
      process_id: '190000000000002',
      process_code: 'WELD',
      sort_order: 1,
    },
  ],
};

async function mountTab() {
  const wrapper = mount(ProcessWorkTypeMappingTab, {
    global: { ...globalConfig, plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
  });
  await flushPromises();
  return wrapper;
}

let testQueryClient: QueryClient;

beforeEach(() => {
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  listWorkTypesMock.mockReset();
  getWorkTypeProcessesMock.mockReset();
  setWorkTypeProcessesMock.mockReset();
  listProcessesMock.mockReset();
  elMessage.error.mockReset();
  elMessage.success.mockReset();
  elMessage.warning.mockReset();
  elMessage.info.mockReset();

  // 左表 + 工序源：默认都成功。
  listWorkTypesMock.mockResolvedValue({ items: [WT], total: 1, limit: 200, offset: 0 });
  listProcessesMock.mockResolvedValue({
    items: [
      {
        id: '190000000000001',
        version: 1,
        code: 'CUT',
        name: '切割',
        category: 'INHOUSE',
        sort_order: 0,
        requires_approval: false,
        is_cnc: true,
        created_at: '2026-10-01 10:00:00',
        updated_at: '2026-10-01 10:00:00',
      },
    ],
    total: 1,
    limit: 200,
    offset: 0,
  });
  getWorkTypeProcessesMock.mockResolvedValue(EXISTING);
  setWorkTypeProcessesMock.mockResolvedValue(undefined);
});

describe('2026-10-02：映射加载失败后保存不得清空整组映射（ProcessWorkTypeMappingTab）', () => {
  it('P1：加载失败后点保存 → setWorkTypeProcesses 零调用（映射不被清空）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getWorkTypeProcessesMock.mockRejectedValue(new Error('500 boom'));

    const wrapper = await mountTab();
    const vm = wrapper.vm as unknown as TabVm;

    vm.onSelectWT(WT);
    await flushPromises();

    // 失败时勾选保持空（watcher 在 isError 态下不写勾选）
    expect(vm.selectedProcessIds).toEqual([]);

    await vm.onSave();
    await flushPromises();

    // 核心断言：绝不能发出整组替换请求 —— 发了就等于清空该工种全部映射。
    expect(setWorkTypeProcessesMock).not.toHaveBeenCalled();
    expect(elMessage.error).toHaveBeenCalledWith(
      '工序映射加载失败，未做任何保存：请重新选择该工种后再试',
    );
    consoleError.mockRestore();
  });

  it('P1b：加载失败后用户手动改过勾选 → 保存仍被拦（不信任未知态）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getWorkTypeProcessesMock.mockRejectedValue(new Error('500 boom'));

    const wrapper = await mountTab();
    const vm = wrapper.vm as unknown as TabVm;
    vm.onSelectWT(WT);
    await flushPromises();

    // 模拟用户在失败态下手动勾了两个工序再点保存：即便有值也不能提交 ——
    // 提交 = 用「加载失败时看到的不完整快照」整组覆盖真实映射。
    vm.selectedProcessIds = ['190000000000001', '190000000000003'];
    expect(vm.dirty).toBe(true);

    await vm.onSave();
    await flushPromises();

    expect(setWorkTypeProcessesMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('P2（对照组）：加载成功 → 正常发出整组替换，items 逐字等于已有映射', async () => {
    const wrapper = await mountTab();
    const vm = wrapper.vm as unknown as TabVm;
    vm.onSelectWT(WT);
    await flushPromises();

    // 守卫没误伤正常路径；勾选由 toWorkTypeProcessIds 从 query data 派生
    expect(vm.selectedProcessIds).toEqual(['190000000000001', '190000000000002']);
    expect(vm.dirty).toBe(false);

    // 改一个勾选后保存 → 整组替换（不是增量）。
    // 未改动时不点保存：按钮是 `:disabled="!dirty"`，onSave 在无改动时不可达
    //（组件不额外加 dirty 守卫 —— 硬闸的语义是「不知道现状时禁止写」，
    //  「没改动」不是未知态）。
    vm.selectedProcessIds = ['190000000000002', '190000000000001', '190000000000003'];
    expect(vm.dirty).toBe(true);
    await vm.onSave();
    await flushPromises();

    expect(setWorkTypeProcessesMock).toHaveBeenCalledTimes(1);
    expect(setWorkTypeProcessesMock).toHaveBeenCalledWith('8800000000001', {
      items: [
        { process_id: '190000000000002', sort_order: 0 },
        { process_id: '190000000000001', sort_order: 1 },
        { process_id: '190000000000003', sort_order: 2 },
      ],
    });
    expect(elMessage.error).not.toHaveBeenCalled();
    expect(elMessage.success).toHaveBeenCalledWith('已保存');
  });

  it('P3（对照组）：加载成功 + 用户主动清空 → items: [] 照发（清空只在成功态才是用户意图）', async () => {
    const wrapper = await mountTab();
    const vm = wrapper.vm as unknown as TabVm;
    vm.onSelectWT(WT);
    await flushPromises();

    vm.selectedProcessIds = [];
    await vm.onSave();
    await flushPromises();

    expect(setWorkTypeProcessesMock).toHaveBeenCalledWith('8800000000001', { items: [] });
  });

  it('P4：加载失败 → 重新选择该工种且加载成功 → 保存恢复正常（错误态必须复位）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getWorkTypeProcessesMock.mockRejectedValueOnce(new Error('500 boom'));

    const wrapper = await mountTab();
    const vm = wrapper.vm as unknown as TabVm;
    vm.onSelectWT(WT);
    await flushPromises();

    // 失败态：保存被拦
    await vm.onSave();
    await flushPromises();
    expect(setWorkTypeProcessesMock).not.toHaveBeenCalled();

    // 重新选择同一工种（用户重试路径），这次加载成功
    getWorkTypeProcessesMock.mockResolvedValue(EXISTING);
    vm.onSelectWT(WT);
    await flushPromises();

    // 错误态已复位：勾选被服务端基线重新填上，dirty 回到 false
    expect(vm.selectedProcessIds).toEqual(['190000000000001', '190000000000002']);
    expect(vm.dirty).toBe(false);

    vm.selectedProcessIds = ['190000000000001'];
    await vm.onSave();
    await flushPromises();

    expect(setWorkTypeProcessesMock).toHaveBeenCalledTimes(1);
    expect(setWorkTypeProcessesMock).toHaveBeenCalledWith('8800000000001', {
      items: [{ process_id: '190000000000001', sort_order: 0 }],
    });
    consoleError.mockRestore();
  });

  it('P6（2026-10-02 review 第 1 轮 MINOR-2）：A 加载成功 → 切 B 且 B 加载失败 → 勾选不残留 A', async () => {
    // 覆盖「失败态下残留上一个工种的勾选」这条路径。P1 只覆盖**全新 mount**（selectedWT
    // 为 null，勾选本来就是空），压根没经过 A→B 这段状态迁移。
    // 现象：onSelectWT 切到 B 时 B 的请求在飞 —— 标题已经写「B」，勾选框里却还是 A 的
    // 两道工序。写路径已被 onSave 硬闸 + 按钮 disabled 双重封死（不丢数据），但把
    // 未知态渲染成「另一个工种的真实映射」本身就是误导。修法是 onSelectWT 在 **id
    // 变化**时清零勾选。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const WT_B: WorkType = { ...WT, id: '8800000000002', code: 'PAINTER', name: '漆工' };
    listWorkTypesMock.mockResolvedValue({
      items: [WT, WT_B],
      total: 2,
      limit: 200,
      offset: 0,
    });

    const wrapper = await mountTab();
    const vm = wrapper.vm as unknown as TabVm;

    // A 加载成功：勾选被服务端基线填上
    vm.onSelectWT(WT);
    await flushPromises();
    expect(vm.selectedProcessIds).toEqual(['190000000000001', '190000000000002']);
    expect(vm.dirty).toBe(false);

    // 切 B，且 B 的加载失败
    getWorkTypeProcessesMock.mockRejectedValue(new Error('500 boom'));
    vm.onSelectWT(WT_B);
    await flushPromises();

    // 核心断言：**不得**残留 A 的勾选
    expect(vm.selectedProcessIds).toEqual([]);

    // 写路径仍然封死（不因清零而放松任何一道闸）
    await vm.onSave();
    await flushPromises();
    expect(setWorkTypeProcessesMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('P7（2026-10-02 review 第 1 轮 MINOR-1）：B 加载**中**点保存 → 早退且文案说「加载中」', async () => {
    // 区分两种「不知道现状」：加载中 vs 加载失败。合并成一句「加载失败…请重新选择
    // 该工种」在「其实只是还在加载」时是假提示。
    // 构造：让 B 的请求挂起（永不 resolve），isPending 恒 true。
    const WT_B: WorkType = { ...WT, id: '8800000000002', code: 'PAINTER', name: '漆工' };
    listWorkTypesMock.mockResolvedValue({
      items: [WT, WT_B],
      total: 2,
      limit: 200,
      offset: 0,
    });

    const wrapper = await mountTab();
    const vm = wrapper.vm as unknown as TabVm;

    vm.onSelectWT(WT);
    await flushPromises();
    expect(vm.selectedProcessIds).toEqual(['190000000000001', '190000000000002']);

    // B 加载中：onSelectWT 已把勾选清零，baseline 也是 [] ⇒ dirty 恒 false。
    // 按钮的 disabled 判据已把 isPending 计入，这里直接调 onSave 是为了覆盖
    // 「按钮 disabled 与 onSave 之间状态翻转」的兜底分支。
    getWorkTypeProcessesMock.mockImplementation(() => new Promise(() => undefined));
    vm.onSelectWT(WT_B);
    await flushPromises();

    await vm.onSave();
    await flushPromises();

    expect(setWorkTypeProcessesMock).not.toHaveBeenCalled();
    expect(elMessage.error).toHaveBeenCalledWith('工序映射仍在加载中，未做任何保存：请稍候再试');
  });

  it('P5：保存成功后失效 work-types 域（键走 qk，不在调用点拼字面量）', async () => {
    // 映射一改，后端 WorkTypeOut.process_ids 就变（list 端点批量补全该字段），
    // 所以左表的映射快照必须连带失效，否则留下「左表旧 + 右表新」的分裂状态。
    const wrapper = await mountTab();
    const vm = wrapper.vm as unknown as TabVm;
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    vm.onSelectWT(WT);
    await flushPromises();
    vm.selectedProcessIds = ['190000000000001'];
    await vm.onSave();
    await flushPromises();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['work-types', 'processes'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['work-types'] });
  });

  it('P8：未选工种时不渲染勾选区；选中工种后才渲染（v-if 渲染守卫）', async () => {
    // 钉死 `el-checkbox-group` 上的 `v-if="selectedWT"`。未选工种时标题已经是
    // 「请选择工种」，此时摆一屏全量工序复选框 + 永久 loading 遮罩是纯误导；
    // 这条 v-if 是 loading 判据（isFetching）之外的第二道防线，删掉它遮罩 bug 就会
    // 以「遮罩盖在看不见的语境上」的形式回归。断言只认渲染与否，不认遮罩样式 ——
    // `v-loading` 在本 spec 里是 no-op 指令桩，测不了遮罩本身。
    const wrapper = await mountTab();

    expect(wrapper.find('.mock-checkbox-group').exists()).toBe(false);

    const vm = wrapper.vm as unknown as TabVm;
    vm.onSelectWT(WT);
    await flushPromises();

    expect(wrapper.find('.mock-checkbox-group').exists()).toBe(true);
  });
});
