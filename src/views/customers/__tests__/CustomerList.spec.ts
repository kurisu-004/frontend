// @vitest-environment happy-dom
// src/views/customers/__tests__/CustomerList.spec.ts
//
// 2026-10-17 新增：客户树从「最多两级」改成任意深度后，`views/customers/` 域的首份
// 组件 spec（该域此前零测试）。断的是「无限层级」这一轮真正改掉 / 改坏的东西：
//
//  1. **树组装**：`buildCustomerTree` 的结果真的进了 `el-tree` 的 `data`，且 5 层节点
//     不再消失（改前本页内联「硬编码两层」的拼树，第 3 层往下的节点既不在 roots 也不
//     在任何 root 的 children 里）。逐层下钻到 depth === 5 是这一条的核心断言 ——
//     只断言「树非空」的话，把拼树退回两层也是全绿的。
//  2. **关键字过滤是递归的**：命中中层节点时，它的后代（子树整体）与祖先链都留在
//     结果里；命中深层叶子时整条链都在。祖先链这条尤其关键：剪掉父节点后命中节点在
//     el-tree 里就成了孤儿，层级位置全错而数组长度看着仍「非空」。
//  3. **「+ 子客户」在任意深度都渲染**（改前只有一级节点有那个按钮，`onAddChild` 里
//     还有一句 `if (parent.parent_id !== null) return`）。
//  4. **编辑非根客户不再带 `parent_id` 进 update payload** —— 本页的存量 bug：改前
//     edit 分支无条件带 `parent_id: form.parentId || null`，而后端 update 见该键非缺省
//     即拒（「不支持修改 parent_id」）⇒ 编辑任何非根客户必然失败。这条是它的回归守卫，
//     必须真跑一次「点编辑 → 改名字 → 保存」看 payload，不能只读源码。
//  5. **删除确认框的后代计数覆盖任意深度**，文案不再出现「二级」。
//
// 为什么 el-tree 用递归桩而不是真实 EP 组件：本 spec 要断的是「CustomerList 喂进
// el-tree 的 data 形状 + 节点插槽里的按钮 + 表单读值」，不是 EP 内部渲染。桩按
// data 递归把 #default 节点插槽逐节点调一遍（与真实 el-tree 的插槽协议一致），并
// 把 `data` prop 原样暴露出来 —— 断言 1/2 直接读 prop，断言 3/4/5 读渲染出来的行。
//
// 桩的另一半是 el-form：本页 `onSave` 首行就 `await formRef.value.validate()`，桩必须
// expose 出这个方法，否则保存路径根本走不到 mutation。桩恒 resolve(true)（校验规则本身
// 不在本 spec 的范围内），所以用例 4 需要先把「客户名」填上。

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import {
  defineComponent,
  h,
  type FunctionalComponent,
  type VNode,
  type VNodeArrayChildren,
} from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomerTreeNode } from '@/api/customer.tree';

/** 被测组件的源文件（T8 的样式守卫要读它）。
 *  ⚠️ 不能用 `new URL(rel, import.meta.url)`：happy-dom 会把全局 `URL` 换成它自己的
 *  实现，相对路径被解析到 `http://localhost:3000/...` ⇒ `fileURLToPath` 抛
 *  「URL must be of scheme file」。这里只把 `import.meta.url`（是字符串，不受影响）
 *  交给 fileURLToPath，之后一律走 node:path。 */
const COMPONENT_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'CustomerList.vue'),
  'utf8',
);

// ---------------------------------------------------------------- EP 桩
// 本页只从 element-plus 取值导入 ElMessage / ElMessageBox（组件全走 main.ts 的全局
// 注册，见下方 global.components）；桩成 no-op —— node 环境下真实 ElMessage 会因
// `document is not defined` 污染输出（CLAUDE.md「ElMessage 错误桥接」）。
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn() },
}));

// ---------------------------------------------------------------- 数据夹具
// 一棵 5 层的链 + 一条 4 层的链 + 两个兄弟根：
//   c1 华强集团 (L1, H)
//   ├─ c2 终端BG (L2)
//   │  ├─ c3 手机部 (L3)
//   │  │  ├─ c4 影像组 (L4)
//   │  │  │  └─ c5 镜头班组 (L5)
//   │  │  └─ c6 电池组 (L4)
//   │  └─ c7 平板部 (L3)
//   └─ c8 穿戴BG (L2)
//   c9 另一集团 (L1, A)      —— 无子节点
//   c10 待配置集团 (L1, 无前缀) —— 走树行「未设置」灰 tag 分支
//
// customer_path 按 2026-10-17 锁定的后端口径给：第 2 层到叶子用 ' / ' 拼接、不含 L1，
// 根节点等于自己的 name（守门 schema `customerSchema` 里它是必填键）。
function customer(
  id: string,
  name: string,
  parentId: string | null,
  extra?: {
    path: string;
    prefix?: string | null;
  },
) {
  return {
    id,
    name,
    parent_id: parentId,
    parent_name: null, // 展示层不读；真值由后端给，本 spec 不依赖
    serial_prefix: extra?.prefix ?? null,
    customer_path: extra?.path ?? name,
    version: 1,
    created_at: '2026-10-17 00:00:00',
    updated_at: '2026-10-17 00:00:00',
  };
}

const CUSTOMERS = [
  customer('c1', '华强集团', null, { path: '华强集团', prefix: 'H' }),
  customer('c2', '终端BG', 'c1', { path: '终端BG' }),
  customer('c3', '手机部', 'c2', { path: '终端BG / 手机部' }),
  customer('c4', '影像组', 'c3', { path: '终端BG / 手机部 / 影像组' }),
  customer('c5', '镜头班组', 'c4', { path: '终端BG / 手机部 / 影像组 / 镜头班组' }),
  customer('c6', '电池组', 'c3', { path: '终端BG / 手机部 / 电池组' }),
  customer('c7', '平板部', 'c2', { path: '终端BG / 平板部' }),
  customer('c8', '穿戴BG', 'c1', { path: '穿戴BG' }),
  customer('c9', '另一集团', null, { path: '另一集团', prefix: 'A' }),
  customer('c10', '待配置集团', null, { path: '待配置集团' }),
];

/** 顶层根节点：三个 L1（c9 是无子节点的独立根）。 */
const ROOT_IDS = ['c1', 'c9', 'c10'];

/** c1 的后代数（任意深度）：c2 c8 c3 c7 c4 c6 c5 = 7。 */
const C1_DESCENDANTS = 7;

/** 写路径的 mock 用 `vi.hoisted` 声明：`vi.mock` 的 factory 在模块图解析期就被调用
 *  （早于文件里任何一条普通 const），直接引用顶层 const 会拿到
 *  「Cannot access ... before initialization」。实现体同样挪到 beforeEach 里设 ——
 *  那时候 CUSTOMERS 早就初始化好了。 */
const mocks = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  softDeleteCustomer: vi.fn(),
}));

vi.mock('@/api/customer', () => ({
  listCustomers: mocks.listCustomers,
  getCustomer: vi.fn(),
  createCustomer: mocks.createCustomer,
  updateCustomer: mocks.updateCustomer,
  softDeleteCustomer: mocks.softDeleteCustomer,
}));

import CustomerList from '../CustomerList.vue';

// ---------------------------------------------------------------- 组件桩
/** 把本页的节点插槽（#default="{ data }"）按节点调一遍，返回值直接当 vnode 数组用。 */
type RenderRow = (node: CustomerTreeNode) => VNodeArrayChildren;

/** el-tree 节点桩：按 data 递归渲染。根元素带 `data-node-id` 便于定位某一层。
 *
 *  用**渲染函数**而不是模板写转发：模板里「把外层插槽一路转递到任意深度、且每层重绑
 *  data」需要两层 `#default="s"` + `v-bind`，漏一层就会静默转错（转错时子树里每一行都
 *  渲染成同一个祖先的内容，节点数对得上、内容全错 —— 这种错比直接抛异常难查）。
 *  写成函数组件（而不是 defineComponent）是刻意的：自引用出现在自己的函数体里，
 *  不会有 TS7022「在自己的初始化式里被间接引用」的循环推断。 */
const mockTreeNode: FunctionalComponent<{
  nodeData: CustomerTreeNode;
  renderRow: RenderRow;
}> = (props) =>
  h(
    'div',
    {
      class: 'mock-tree-node',
      'data-node-id': props.nodeData.id,
      'data-depth': String(props.nodeData.depth),
    },
    [
      props.renderRow(props.nodeData),
      h(
        'div',
        { class: 'mock-tree-children' },
        props.nodeData.children.map((c) =>
          h(mockTreeNode, { nodeData: c, renderRow: props.renderRow }),
        ),
      ),
    ],
  );

const ElTreeStub = defineComponent({
  name: 'ElTree',
  props: ['data', 'props', 'nodeKey', 'indent'],
  setup(props, { slots }) {
    const renderRow: RenderRow = (node) => slots.default?.({ data: node }) ?? [];
    return (): VNode =>
      h(
        'div',
        { class: 'mock-tree' },
        (props.data as CustomerTreeNode[]).map((n: CustomerTreeNode) =>
          h(mockTreeNode, { nodeData: n, renderRow }),
        ),
      );
  },
});

const ElFormStub = {
  name: 'ElForm',
  props: ['model', 'rules', 'inline', 'labelWidth', 'labelPosition'],
  // 本页 onSave 首行就 validate()，桩必须 expose 出它；恒 resolve(true)（校验规则本身
  // 不在本 spec 范围内，用例 4 自己把「客户名」填上）。
  methods: {
    validate: async () => true,
    clearValidate: () => {},
  },
  template: `<form class="mock-form"><slot /></form>`,
};

const globalConfig = {
  components: {
    'el-card': { template: `<div class="mock-card"><slot /></div>` },
    'el-form': ElFormStub,
    'el-form-item': {
      props: ['label'],
      template: `<div class="mock-form-item" :data-label="label"><slot /></div>`,
    },
    'el-input': {
      name: 'ElInput',
      props: ['modelValue', 'disabled'],
      emits: ['update:modelValue'],
      template: `<input class="mock-input" :value="modelValue ?? ''" :disabled="disabled" @input="$emit('update:modelValue', $event.target.value)" />`,
    },
    'el-select': {
      name: 'ElSelect',
      props: ['modelValue', 'disabled', 'placeholder'],
      emits: ['update:modelValue'],
      template: `<div class="mock-select" :data-value="modelValue ?? ''">{{ modelValue ?? '' }}</div>`,
    },
    'el-option': { template: `<div class="mock-option" />` },
    'el-button': {
      name: 'ElButton',
      props: ['type', 'size', 'link', 'loading'],
      emits: ['click'],
      template: `<button class="mock-button" :data-type="type" @click="$emit('click')"><slot /></button>`,
    },
    'el-tag': { template: `<span class="mock-tag"><slot /></span>` },
    'el-icon': { template: `<i class="mock-icon"><slot /></i>` },
    'el-empty': { template: `<div class="mock-empty" />` },
    'el-dialog': {
      name: 'ElDialog',
      props: ['modelValue', 'title', 'width', 'top', 'closeOnClickModal'],
      emits: ['update:modelValue', 'closed'],
      // 内容恒渲染（不按 modelValue 摘掉）：让用例能直接查弹窗里的表单项。
      template: `<div class="mock-dialog" :data-title="title"><slot /><slot name="footer" /></div>`,
    },
    'el-tree': ElTreeStub,
  },
  directives: { loading: {} },
};

type Wrapper = VueWrapper<InstanceType<typeof CustomerList>>;

async function mountPage() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(CustomerList, {
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
  // 等 useCustomersQuery 首取 settle（listCustomers 已被桩成同步返回）。
  await flushPromises();
  return wrapper;
}

/** el-tree 喂进去的 data。 */
function treeData(wrapper: Wrapper): CustomerTreeNode[] {
  return wrapper.findComponent({ name: 'ElTree' }).props('data') as CustomerTreeNode[];
}

/** 某节点的行元素（`.tree-row`）。先按 `data-node-id` 定位节点根，再取它的第一个
 *  `.tree-row` —— 直接在节点根里 findAll('button') 会连它自己后代的按钮一起收进来。 */
function rowOf(wrapper: Wrapper, id: string) {
  const node = wrapper.findAll('.mock-tree-node').find((n) => n.attributes('data-node-id') === id);
  expect(node, `树上找不到节点 ${id}`).toBeDefined();
  return node!.find('.tree-row');
}

function buttonOf(wrapper: Wrapper, id: string, label: string) {
  const btn = rowOf(wrapper, id)
    .findAll('button')
    .find((b) => b.text() === label);
  expect(btn, `节点 ${id} 上找不到「${label}」按钮`).toBeDefined();
  return btn!;
}

function dialogOf(wrapper: Wrapper) {
  return wrapper.findComponent({ name: 'ElDialog' });
}

function findFormItem(wrapper: Wrapper, label: string) {
  return dialogOf(wrapper)
    .findAll('.mock-form-item')
    .find((el) => el.attributes('data-label') === label);
}

function formItemIn(wrapper: Wrapper, label: string) {
  const item = findFormItem(wrapper, label);
  expect(item, `弹窗里找不到「${label}」表单项`).toBeDefined();
  return item!;
}

/** 顶部筛选卡里的关键词输入框（弹窗里也有 el-input，不能用 wrapper.find('.mock-input')）。 */
function keywordInput(wrapper: Wrapper) {
  return wrapper.find('.filter-card').find('.mock-input');
}

describe('CustomerList · 无限层级客户树', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 本页 `useListStatePersist` 走 localStorage（key `myerp.list.<user>.customer_list`），
    // 且 onBeforeUnmount 会同步写一次 ⇒ 不清会让上一个用例的关键词渗进下一个用例。
    localStorage.clear();
    mocks.listCustomers.mockImplementation(async () => ({
      items: CUSTOMERS,
      total: CUSTOMERS.length,
      limit: 0,
      offset: 0,
    }));
    mocks.createCustomer.mockImplementation(async () => ({}));
    mocks.updateCustomer.mockImplementation(async () => ({}));
    mocks.softDeleteCustomer.mockImplementation(async () => undefined);
  });

  it('T1：5 层树进 el-tree 的 data，逐层下钻到 depth === 5', async () => {
    const wrapper = await mountPage();
    const data = treeData(wrapper);
    // 顶层就是三个 L1（c2 / c3 这类有父的节点不算顶层）。
    expect(data.map((n) => n.id)).toEqual(ROOT_IDS);

    const c2 = data[0]?.children.find((n) => n.id === 'c2');
    const c3 = c2?.children.find((n) => n.id === 'c3');
    const c4 = c3?.children.find((n) => n.id === 'c4');
    const c5 = c4?.children.find((n) => n.id === 'c5');
    expect(c5?.name).toBe('镜头班组');
    expect(c5?.depth).toBe(5);
    // 5 层节点也真的渲染出了一行（不是只进了 data）。
    expect(rowOf(wrapper, 'c5').text()).toContain('镜头班组');
    expect(wrapper.findAll('.mock-tree-node')).toHaveLength(CUSTOMERS.length);
    wrapper.unmount();
  });

  it('T1b：序列号前缀 tag 只出现在根节点（判据是 parent_id === null，与深度无关）', async () => {
    const wrapper = await mountPage();
    const prefixOf = (id: string) =>
      rowOf(wrapper, id)
        .findAll('.tree-row__prefix')
        .map((t) => t.text());

    expect(prefixOf('c1')).toEqual(['H']);
    expect(prefixOf('c9')).toEqual(['A']);
    // 根但没配前缀 → 灰 tag「未设置」
    expect(prefixOf('c10')).toEqual(['未设置']);
    // 非根一律没有 tag（c2 是 L2、c5 是 L5）
    expect(prefixOf('c2')).toEqual([]);
    expect(prefixOf('c5')).toEqual([]);
    wrapper.unmount();
  });

  it('T2：过滤递归 —— 命中中层节点时后代全在、祖先链也在；不相关的支被剪掉', async () => {
    const wrapper = await mountPage();

    // 命中 L3「手机部」⇒ 它自己 + 它的**全部后代**（影像组 / 电池组 / 镜头班组），
    // 祖先链（华强集团 / 终端BG）必须留着，否则命中节点在 el-tree 里成了孤儿。
    await keywordInput(wrapper).setValue('手机部');
    let data = treeData(wrapper);
    expect(data.map((n) => n.id)).toEqual(['c1']);
    const c2 = data[0]?.children;
    expect(c2?.map((n) => n.id)).toEqual(['c2']);
    const c3 = c2?.[0]?.children;
    expect(c3?.map((n) => n.id)).toEqual(['c3']);
    // 命中节点的后代整支保留（电池组本身没命中关键词）
    expect(c3?.[0]?.children.map((n) => n.id)).toEqual(['c4', 'c6']);
    expect(c3?.[0]?.children[0]?.children.map((n) => n.id)).toEqual(['c5']);
    // 同一根下的另一支（平板部 / 穿戴BG）与另一个根都被剪掉
    expect(c2?.[0]?.children.map((n) => n.id)).not.toContain('c7');
    expect(data[0]?.children.map((n) => n.id)).not.toContain('c8');

    // 命中最深叶子 ⇒ 整条 5 层链都在
    await keywordInput(wrapper).setValue('镜头班组');
    data = treeData(wrapper);
    expect(data).toHaveLength(1);
    expect(data[0]?.children[0]?.children[0]?.children[0]?.children[0]?.id).toBe('c5');

    // 命中的是根 ⇒ 整棵子树全留（改前只有一层 children，改前 c5 这类会消失）
    await keywordInput(wrapper).setValue('华强集团');
    data = treeData(wrapper);
    expect(data).toHaveLength(1);
    expect(data[0]?.children.map((n) => n.id)).toEqual(['c2', 'c8']);

    // 清空 ⇒ 回全树（与改前一致：空关键词直接返回整棵树）
    await keywordInput(wrapper).setValue('');
    expect(treeData(wrapper)).toHaveLength(ROOT_IDS.length);
    wrapper.unmount();
  });

  it('T3：「+ 子客户」在任意深度的节点上都渲染', async () => {
    const wrapper = await mountPage();
    // 每一行（含 L2 / L3 / L4 / L5 与叶子）都有这个按钮。
    expect(rowOf(wrapper, 'c2').text()).toContain('+ 子客户');
    expect(rowOf(wrapper, 'c4').text()).toContain('+ 子客户');
    expect(rowOf(wrapper, 'c5').text()).toContain('+ 子客户');
    expect(rowOf(wrapper, 'c9').text()).toContain('+ 子客户');
    // 逐行点一遍，确认没有任何一层被 onAddChild 的早退挡掉：按钮数 = 节点数。
    const addButtons = wrapper.findAll('.mock-tree-node').flatMap((n) =>
      n
        .find('.tree-row')
        .findAll('button')
        .filter((b) => b.text() === '+ 子客户'),
    );
    expect(addButtons).toHaveLength(CUSTOMERS.length);
    wrapper.unmount();
  });

  it('T4：L4 节点上点「+ 子客户」→ 父客户只读展示完整祖先路径（含 L1）', async () => {
    const wrapper = await mountPage();
    await buttonOf(wrapper, 'c4', '+ 子客户').trigger('click');
    await flushPromises();

    expect(dialogOf(wrapper).props('title')).toBe('新增子客户');
    // 关键：给的是**从 L1 起的完整链**，不是末段名字「影像组」。
    const parentInput = formItemIn(wrapper, '父客户').find('input');
    expect((parentInput.element as HTMLInputElement).value).toBe(
      '华强集团 / 终端BG / 手机部 / 影像组',
    );
    expect(parentInput.attributes('disabled')).toBeDefined();
    // 子客户不设序列号前缀（整项隐藏）
    expect(findFormItem(wrapper, '序列号前缀')).toBeUndefined();

    // 保存 ⇒ create 带的就是被点的那个节点 id（不是它的父）
    await formItemIn(wrapper, '客户名').find('input').setValue('影像二组');
    await dialogOf(wrapper)
      .findAll('button')
      .find((b) => b.text() === '保存')!
      .trigger('click');
    await flushPromises();
    expect(mocks.createCustomer).toHaveBeenCalledWith({
      name: '影像二组',
      parent_id: 'c4',
      serial_prefix: null,
    });
    wrapper.unmount();
  });

  it('T5（存量 bug 回归守卫）：编辑非根客户，update payload 不带 parent_id', async () => {
    const wrapper = await mountPage();
    // 编辑 L4 的「影像组」
    await buttonOf(wrapper, 'c4', '编辑').trigger('click');
    await flushPromises();

    expect(dialogOf(wrapper).props('title')).toBe('编辑客户');
    // 父客户改只读：显示父节点（c3 手机部）的完整祖先路径，并带上「层级不可移动」提示
    expect((formItemIn(wrapper, '父客户').find('input').element as HTMLInputElement).value).toBe(
      '华强集团 / 终端BG / 手机部',
    );
    expect(wrapper.text()).toContain('客户层级不可移动');
    // 弹窗里只剩序列号前缀那一个 el-select —— 父客户不再有可改的下拉。
    // （findComponent 若找到父客户的 select，disabled 会是 false，这里立刻红。）
    expect(dialogOf(wrapper).findAllComponents({ name: 'ElSelect' })).toHaveLength(1);
    // 非一级客户 ⇒ 序列号前缀不可改
    expect(dialogOf(wrapper).findComponent({ name: 'ElSelect' }).props('disabled')).toBe(true);

    await formItemIn(wrapper, '客户名').find('input').setValue('影像组 A');
    await dialogOf(wrapper)
      .findAll('button')
      .find((b) => b.text() === '保存')!
      .trigger('click');
    await flushPromises();

    expect(mocks.updateCustomer).toHaveBeenCalledTimes(1);
    const [id, payload] = (mocks.updateCustomer as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe('c4');
    // 后端 update 见 parent_id 非缺省即拒 ⇒ 这一行以前让「编辑任何非根客户」必然失败。
    expect(payload).not.toHaveProperty('parent_id');
    expect(payload).toEqual({ name: '影像组 A' });
    wrapper.unmount();
  });

  it('T5b：编辑一级客户 ⇒ 父客户显示「无上级」，序列号前缀仍可改并进 payload', async () => {
    const wrapper = await mountPage();
    await buttonOf(wrapper, 'c1', '编辑').trigger('click');
    await flushPromises();

    expect((formItemIn(wrapper, '父客户').find('input').element as HTMLInputElement).value).toBe(
      '（无上级 · 一级客户）',
    );
    const select = dialogOf(wrapper).findComponent({ name: 'ElSelect' });
    expect(select.props('disabled')).toBe(false);
    expect(select.props('modelValue')).toBe('H');
    select.vm.$emit('update:modelValue', 'Z');
    await flushPromises();

    await formItemIn(wrapper, '客户名').find('input').setValue('华强集团（改名）');
    await dialogOf(wrapper)
      .findAll('button')
      .find((b) => b.text() === '保存')!
      .trigger('click');
    await flushPromises();

    const [id, payload] = (mocks.updateCustomer as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe('c1');
    expect(payload).toEqual({ name: '华强集团（改名）', serial_prefix: 'Z' });
    wrapper.unmount();
  });

  it('T6：删除确认框按任意深度统计后代，且文案不再出现「二级」', async () => {
    const { ElMessageBox } = await import('element-plus');
    const confirmMock = ElMessageBox.confirm as Mock;
    confirmMock.mockResolvedValue(undefined);

    const wrapper = await mountPage();

    // (1) 根节点：7 个后代（c2 c8 c3 c7 c4 c6 c5，跨 4 层）—— 改前只数一层得 2
    await buttonOf(wrapper, 'c1', '删除').trigger('click');
    await flushPromises();
    const rootMsg = confirmMock.mock.calls[0]?.[0] as string;
    expect(rootMsg).toContain(`仍有 ${C1_DESCENDANTS} 个子节点`);
    expect(rootMsg).not.toContain('二级');
    expect(mocks.softDeleteCustomer).toHaveBeenCalledWith('c1');

    // (2) L4 节点：它自己也有 1 个后代 —— 改前 childCount 恒 0（一律当叶子），提示不出现
    confirmMock.mockClear();
    await buttonOf(wrapper, 'c4', '删除').trigger('click');
    await flushPromises();
    const deepMsg = confirmMock.mock.calls[0]?.[0] as string;
    expect(deepMsg).toContain('仍有 1 个子节点');
    expect(deepMsg).not.toContain('二级');

    // (3) 叶子：不加任何后缀
    confirmMock.mockClear();
    await buttonOf(wrapper, 'c5', '删除').trigger('click');
    await flushPromises();
    const leafMsg = confirmMock.mock.calls[0]?.[0] as string;
    expect(leafMsg).toBe('确认软删除客户「镜头班组」？');
    expect(leafMsg).not.toContain('子节点');
    wrapper.unmount();
  });

  it('T7：删除被用户取消时不发软删请求', async () => {
    const { ElMessageBox } = await import('element-plus');
    (ElMessageBox.confirm as Mock).mockRejectedValue(new Error('cancel'));

    const wrapper = await mountPage();
    await buttonOf(wrapper, 'c1', '删除').trigger('click');
    await flushPromises();
    expect(mocks.softDeleteCustomer).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('T8：深层缩进被压过 EP 默认值（长名字靠 CSS 省略，不横向溢出）', async () => {
    const wrapper = await mountPage();
    const tree = wrapper.findComponent({ name: 'ElTree' });
    const indent = tree.props('indent') as number;
    // el-tree 的 indent 是每层固定值、没有「深层压缩」档位；不显式压小的话 5~6 层
    // 会把名字挤到卡片右边。只钉「小于默认 18」，不钉死具体数值（那是审美选择）。
    expect(typeof indent).toBe('number');
    expect(indent).toBeLessThan(18);
    // 配套的 CSS（scoped 选择器带 :deep() 前缀，正则容忍那对括号）：
    // 名字省略（min-width:0 是 flex 子项省略号的前提）、按钮不被挤没。
    expect(COMPONENT_SRC).toMatch(/\.tree-row__name\)?\s*\{[^}]*min-width:\s*0/);
    expect(COMPONENT_SRC).toMatch(/\.tree-row__name\)?\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(COMPONENT_SRC).toMatch(/\.tree-row__actions\)?\s*\{[^}]*flex-shrink:\s*0/);
    wrapper.unmount();
  });
});
