// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryGroupEditor.leafCandidates.spec.ts
//
// 2026-10-17（客户无限层级改造，review 第 3 轮）：送货单扫码台**分组编辑器候选**的守卫。
//
// 守的是一个真实死锁，不是措辞：零件只挂在**叶子**客户上（后端入单叶子闸门 20104），
// 而送货车台原先把编辑器候选写成「所选 L1 的**直接子**」。三层树上直接子是中间层 ⇒
//   1. 面板按后端回的 `ungrouped_customers`（= 该 L1 的**全部后代**）渲染「未分组」tag，
//      里面会出现 L3 叶子，但进编辑器后 `el-option` 里根本没有它 ⇒ 看得到、加不进；
//   2. 送货分组唯一的消费方是**打印分页**：分组映射按成员的 `customer_id` 建表，而打印
//      行项用自己的**叶子 `customer_id`** 去查 ⇒ 中间层（分组里只有 L2、零件在 L3）成员
//      匹配不到任何行项，选进分组也只是白占一个成员位。
// 两层树（当前生产数据）下这两条都无感，所以只能靠测试钉住。
//
// 用 EP 模板桩而不是真 el-select（理由同 `DeliveryScanTreeDialog.spec.ts`：vitest 配置
// 不挂 unplugin-vue-components，kebab 标签只能由 VTU 的 stubs 按标签名拦下来）。
// 另加三条源码断言守**接线**（候选从页面算好后一路透传、中间不再按 parent_id 过滤）——
// 只挂编辑器组件的话，把页面的候选改回「直接子」这一改不会有任何测试变红。

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount } from '@vue/test-utils';
import { leafCustomersUnder } from '@/api/customer.tree';
import type { Customer } from '@/api/customer';

// 只 mock 命令式 API（真实 ElMessage 在 node 环境会碰 document）。
// ⚠️ EP 组件一律走 global.stubs（见文件头）；唯一的例外是 `ElForm` —— 它在组件里是
// **值导入的 setup 绑定**，`<el-form>` 会被编译成对该绑定的引用而不是字符串标签，
// 所以桩必须按导出名给，光靠 stubs 的标签名拦不住。
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn() },
  ElForm: { name: 'ElFormStub', template: '<form><slot /></form>' },
}));

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    template: '<div class="mock-el-dialog"><slot /><slot name="footer" /></div>',
  },
  'el-form-item': {
    name: 'ElFormItemStub',
    props: ['label', 'prop'],
    template: '<div class="mock-el-form-item" :data-label="label"><slot /></div>',
  },
  'el-input': { name: 'ElInputStub', props: ['modelValue'], template: '<input />' },
  'el-select': {
    name: 'ElSelectStub',
    props: ['modelValue', 'multiple', 'filterable', 'placeholder'],
    template: '<div class="mock-el-select"><slot /></div>',
  },
  'el-option': {
    name: 'ElOptionStub',
    props: ['label', 'value'],
    template: '<span class="mock-el-option" :data-value="value">{{ label }}</span>',
  },
  'el-button': {
    name: 'ElButtonStub',
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
};

/** 构造一条客户 wire 记录（customer_path 走后端「第 2 层到叶子、不含 L1」的口径）。 */
function customer(id: string, name: string, parentId: string | null, path: string): Customer {
  return {
    id,
    name,
    parent_id: parentId,
    parent_name: parentId,
    serial_prefix: parentId === null ? 'H' : null,
    customer_path: path,
    version: 1,
    created_at: '',
    updated_at: '',
  };
}

/** 三层树：华强 / 终端BG / 手机部 / 影像组、L4 光学组、传真BG / 冲压组；
 *  另加另一个根 民信 / 分厂A / 车间A1（用来守「不泄漏别的根的子树」）。 */
const TREE: Customer[] = [
  customer('l1', '华强', null, '华强'),
  customer('l2a', '终端BG', 'l1', '终端BG'),
  customer('l3a', '手机部', 'l2a', '终端BG / 手机部'),
  customer('l4a', '影像组', 'l3a', '终端BG / 手机部 / 影像组'),
  customer('l4b', '光学组', 'l3a', '终端BG / 手机部 / 光学组'),
  customer('l2b', '传真BG', 'l1', '传真BG'),
  customer('l3b', '冲压组', 'l2b', '传真BG / 冲压组'),
  customer('x1', '民信', null, '民信'),
  customer('x2', '分厂A', 'x1', '分厂A'),
  customer('x3', '车间A1', 'x2', '分厂A / 车间A1'),
];

async function mountEditor(leafCandidates: Customer[]) {
  const { default: Editor } = await import('../DeliveryGroupEditor.vue');
  return mount(Editor, {
    props: { l1Id: 'l1', initial: null, leafCustomerOptions: leafCandidates },
    global: { stubs },
  });
}

/** 编辑器里渲染出来的候选（id / 显示名），顺序即 `el-option` 渲染序。 */
function renderedOptions(wrapper: Awaited<ReturnType<typeof mountEditor>>): {
  id: string;
  label: string;
}[] {
  return wrapper
    .findAll('.mock-el-option')
    .map((o) => ({ id: o.attributes('data-value') ?? '', label: o.text() }));
}

describe('送货分组编辑器：候选 = 所选 L1 子树内的叶子', () => {
  it('三层树上只有 L4 / L3 叶子进得了编辑器，中间层与根本身都不在', async () => {
    const candidates = leafCustomersUnder(TREE, 'l1');
    const w = await mountEditor(candidates);
    const options = renderedOptions(w);

    // 零件只可能挂在叶子上（后端入单叶子闸门 20104），且打印分组按**行项自己的叶子
    // customer_id** 匹配 ⇒ 中间层进了分组匹配不到任何行项；根本身更不可能（分组键就是
    // 它，后端显式剔除）。
    expect(options.map((o) => o.id).sort()).toEqual(['l3b', 'l4a', 'l4b']);
    for (const mid of ['l1', 'l2a', 'l3a', 'l2b', 'x1', 'x2', 'x3']) {
      expect(options.some((o) => o.id === mid)).toBe(false);
    }
    w.unmount();
  });

  it('用户能把「面板上看得见的 L4 叶子」选成成员（看得到就必须加得进）', async () => {
    const w = await mountEditor(leafCustomersUnder(TREE, 'l1'));
    // 面板的「未分组」tag 用的正是后端 `ungrouped_customers`（全部后代），其中会有 L4 叶子
    expect(renderedOptions(w).some((o) => o.id === 'l4a')).toBe(true);
    w.unmount();
  });

  it('换一个根时候选只含它自己那一支（不泄漏上一个根的子树）', async () => {
    const w = await mountEditor(leafCustomersUnder(TREE, 'x1'));
    expect(renderedOptions(w).map((o) => o.id)).toEqual(['x3']);
    w.unmount();
  });

  it('没选 L1（null）时候选为零、编辑器不报错', async () => {
    const w = await mountEditor(leafCustomersUnder(TREE, null));
    expect(renderedOptions(w)).toEqual([]);
    w.unmount();
  });

  it('文案不再出现「L2」（任意深度下 L2 只是一次偶然的层数）', async () => {
    const w = await mountEditor(leafCustomersUnder(TREE, 'l1'));
    const text = w.text();
    for (const stale of ['L2 成员', 'L2 客户', '工件的 L2']) {
      expect(text, `分组编辑器还留着带层级数的文案「${stale}」`).not.toContain(stale);
    }
    expect(text).toContain('打印送货单时，同一分组的成员归入同一组打印页');
    w.unmount();
  });
});

describe('接线：候选一路透传，页面不得再按「直接子」过滤', () => {
  const ROOT = process.cwd();
  const SCAN_SRC = readFileSync(join(ROOT, 'src/views/com/delivery/DeliveryNoteScan.vue'), 'utf8');
  const PANEL_SRC = readFileSync(
    join(ROOT, 'src/views/com/delivery/components/DeliveryGroupPanel.vue'),
    'utf8',
  );

  it('DeliveryNoteScan 的候选走 leafCustomersUnder（共享叶子口径）', () => {
    expect(
      SCAN_SRC,
      '页面里的候选又退回就地过滤 `parent_id === l1`：三层树上编辑器只列得到中间层，' +
        '「面板看得见的成员加不进分组」+「中间层成员在打印分组里匹配不到任何行项」' +
        '两条死锁一起回来',
    ).toMatch(/leafCustomersUnder\(allCustomers\.value, scanState\.l1CustomerId\.value\)/);
    expect(SCAN_SRC).not.toMatch(/parent_id === scanState\.l1CustomerId\.value/);
  });

  it('DeliveryGroupPanel 原样下传候选（不在组件里二次过滤）', () => {
    expect(PANEL_SRC).toMatch(/:leaf-customer-options="leafCustomerOptions"/);
    expect(PANEL_SRC).not.toContain('all-l2-customers');
    expect(PANEL_SRC).not.toContain('allL2Customers');
  });
});
