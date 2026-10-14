// @vitest-environment happy-dom
// src/views/production/scan/components/__tests__/ProcessPickerDialog.processQuery.spec.ts
//
// 2026-10-20 新增：工序选择弹窗的**数据源契约** —— 工序字典必须来自共享基础数据层
// `useProcessesQuery`，不再由组件内裸调 `listProcesses`。
//
// 为什么值得单独立一个文件：改造前弹窗每开一次打一次 `GET /prod/processes?limit=200`
// （零缓存零去重），而工序字典是跨域基础数据 —— 生产队列看板 `QueueBoard.vue` 读的是同一条
// queryKey。同屏两处（看板 + 弹窗）本该只发一次往返，改成裸调后必然发两次。
// 「放回 → 换一道工序」是工人高频路径，车间网络下每次开弹窗白等一个 200 行字典往返是
// 不可接受的。这条不变量在运行期只能靠 queryKey 相等来兑现，故本文件按「同一个
// QueryClient 下两次挂载只发一次请求」来断言，而不是断言源码里有没有某个字面量。
//
// 覆盖：
//   - Q1（源码守卫）：组件内不再有裸 `listProcesses`（含 import）。防止有人图省事把
//     `await listProcesses(...)` 加回来 —— 那样同屏去重当场失效，而功能测试全绿。
//   - Q2（enabled 闸门）：弹窗不可见时零请求；可见后才发。
//   - Q3（同屏共享 queryKey ⇒ 去重）：看板形态的 `useProcessesQuery({ limit: 200 })` 与
//     弹窗同时挂在**同一个** QueryClient 上，`listProcesses` 全程只被调一次，且弹窗
//     直接渲染出卡片（零等待、无 loading 骨架）。
//   - Q4（缓存热 ⇒ 打开即渲染）：同一个 QueryClient 内关窗再开窗，请求数仍为 1。
//
// 测试策略（沿 ProcessPickerDialog.spec.ts 同款）：
//   - `vi.mock('@/api/process')` 桩住唯一的出网口（共享 hook 内部调的正是它），桩返回值
//     必须带 `processListResultSchema` 声明的 limit / offset 两个必填键；
//   - `vi.mock('element-plus')` 把 ElMessage 桩成 no-op（node/happy-dom 下真实 ElMessage
//     会污染输出）；
//   - 每个用例自建 QueryClient 并显式 `queries.retry: 0`（照 main.ts 全局默认），否则
//     失败路径要等 3 次退避重试；
//   - 看板形态用一个内联的宿主组件模拟（照 `QueueBoard.vue` 的调用形态：恒启用、
//     `{ limit: 200 }`），不去 mount 整个看板。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

// 名叫 `mocks` 而不是 `h`：Vue 的 `h` 也要用，两者同名必有一个被遮蔽。
const mocks = vi.hoisted(() => ({
  listProcesses: vi.fn(),
  ElMessage: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

vi.mock('@/api/process', () => ({ listProcesses: mocks.listProcesses }));
vi.mock('element-plus', () => ({ ElMessage: mocks.ElMessage }));

import ProcessPickerDialog from '../ProcessPickerDialog.vue';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';

/** 组件源文件（Q1 的守卫对象）。
 *  ⚠️ 用 `import.meta.url` **字符串** + `node:url` 的 `fileURLToPath`，不要写
 *  `new URL('../x.vue', import.meta.url)`：本 spec 跑在 happy-dom 下，全局 `URL` 是它自己
 *  那个实现，会把 base 解析到 `http://localhost:3000/` 上（**忽略传入的 base**），
 *  `readFileSync` 随即抛「The URL must be of scheme file」。 */
const COMPONENT_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../ProcessPickerDialog.vue'),
  'utf8',
);

/** 把三类注释逐字符换成空格（换行保留）—— 位置不变，判定只跑在真实代码上。
 *  本组件的文档注释里点名了「此前裸调 listProcesses」这段历史，守卫要判的是**代码**里
 *  有没有那条调用，不是注释里有没有那个词。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    template: '<div class="mock-dialog"><slot /><slot name="footer" /></div>',
  },
  'el-alert': { name: 'ElAlertStub', props: ['title'], template: '<i class="mock-alert" />' },
  'el-tabs': { name: 'ElTabsStub', template: '<div class="mock-tabs"><slot /></div>' },
  'el-tab-pane': { name: 'ElTabPaneStub', template: '<div><slot /></div>' },
  'el-button': { name: 'ElButtonStub', template: '<button><slot /></button>' },
  'el-icon': { name: 'ElIconStub', template: '<i><slot /></i>' },
  HmiPickerCard: {
    name: 'HmiPickerCardStub',
    props: ['code', 'name'],
    template: '<div class="stub-card" :data-code="code" />',
  },
};

/** 后端 `ProcessOut` 的完整行。 */
function process(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '190000000000001',
    version: 1,
    code: 'CUT',
    name: '切割',
    category: 'INHOUSE',
    sort_order: 0,
    description: null,
    requires_approval: false,
    color: null,
    is_cnc: false,
    created_at: '2026-10-01 10:00:00',
    updated_at: '2026-10-01 10:00:00',
    ...over,
  };
}

const PROCESSES = [
  process(),
  process({ id: '190000000000002', code: 'WELD', name: '焊接', sort_order: 1 }),
  process({ id: '190000000000003', code: 'SUB', name: '委外喷涂', category: 'OUTSOURCE' }),
];

function listResult(items: Record<string, unknown>[]) {
  return { items, total: items.length, limit: 200, offset: 0 };
}

let qc: QueryClient;

function mountDialog(modelValue = true) {
  return mount(ProcessPickerDialog, {
    props: { modelValue },
    global: { stubs, plugins: [[VueQueryPlugin, { queryClient: qc }]] },
  });
}

/** 生产队列看板的调用形态：恒启用（无 enabled 闸门）、`{ limit: 200 }`。 */
const BoardLike = defineComponent({
  name: 'BoardLike',
  setup() {
    const q = useProcessesQuery({ limit: 200 });
    return () => h('div', { class: 'board' }, String(q.data.value?.items.length ?? -1));
  },
});

beforeEach(() => {
  mocks.listProcesses.mockReset().mockResolvedValue(listResult(PROCESSES));
  mocks.ElMessage.error.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
});

describe('ProcessPickerDialog / 工序字典走共享查询层', () => {
  // Q1：源码里出现裸 listProcesses（哪怕只是注释里提一句）都要红。守卫读的是 .vue 源文本，
  // 因为「有没有绕过共享层」在运行期观察不到 —— 裸调与走 hook 的运行期表现完全一样，
  // 区别只在网络往返次数，而那正是本文件 Q3/Q4 用同一 QueryClient 断言的东西。
  it('Q1：组件内不再出现裸 listProcesses（import 与调用都算）', () => {
    const code = stripComments(COMPONENT_SRC);
    expect(code).not.toMatch(/\blistProcesses\b/);
    expect(code).toContain("from '@/composables/queries/useProcessesQuery'");
  });

  it('Q2：弹窗不可见时零请求，可见后才发', async () => {
    const w = mountDialog(false);
    await flushPromises();
    expect(mocks.listProcesses, '弹窗关着就不该为它拉字典').not.toHaveBeenCalled();

    await w.setProps({ modelValue: true });
    await flushPromises();
    expect(mocks.listProcesses).toHaveBeenCalledTimes(1);
    // 入参与生产队列看板逐字相同（queryKey 由 params 决定，两处必须完全一致）
    expect(mocks.listProcesses.mock.calls[0]![0]).toMatchObject({ limit: 200 });
  });

  it('Q3：与看板形态共享同一条 queryKey ⇒ 同屏只发一次请求，弹窗零等待直出卡片', async () => {
    mount(BoardLike, { global: { plugins: [[VueQueryPlugin, { queryClient: qc }]] } });
    await flushPromises();
    expect(mocks.listProcesses, '看板先取到的就是那一次').toHaveBeenCalledTimes(1);

    const w = mountDialog(true);
    await flushPromises();

    // 关键断言：弹窗挂上后**没有第二次**请求（同一条 queryKey 被 TanStack 去重）。
    expect(mocks.listProcesses).toHaveBeenCalledTimes(1);
    // 且弹窗不再是 loading 骨架 —— 缓存已热，同帧直接出卡片。
    expect(w.find('.loading-state').exists()).toBe(false);
    expect(w.findAll('.stub-card').map((c) => c.attributes('data-code'))).toEqual([
      'CUT',
      'WELD',
      'SUB',
    ]);
  });

  it('Q4：缓存热时关窗再开窗，请求数仍为 1（30s staleTime 窗口内的短时复用）', async () => {
    const w = mountDialog(true);
    await flushPromises();
    expect(mocks.listProcesses).toHaveBeenCalledTimes(1);

    await w.setProps({ modelValue: false });
    await flushPromises();
    await w.setProps({ modelValue: true });
    await flushPromises();

    expect(mocks.listProcesses).toHaveBeenCalledTimes(1);
    expect(w.findAll('.stub-card')).toHaveLength(3);
  });
});
