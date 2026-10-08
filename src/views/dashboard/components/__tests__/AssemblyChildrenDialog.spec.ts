// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/AssemblyChildrenDialog.spec.ts
//
// AssemblyChildrenDialog.vue（交期面板点装配件行 → 子件列表弹窗）渲染契约。
// 取数走 useAssemblyChildrenQuery（有 enabled 闸门的真 query），故测试必须带
// QueryClient —— 形态照 UpcomingDeliveryListDrawer.spec.ts（含 vi.mock('element-plus')
// 的 ElMessage 桩 + 显式 new QueryClient({ queries.retry: 0 }) + 显式全局 stub）。
//
// 覆盖：
//   - C1：modelValue=true + assemblyId 非空 → getAssembly 被调、表格渲染 N 行子件
//   - C2：assemblyId=null → enabled=false，请求不发、渲染空态
//   - C3：子件为空数组 → el-empty 空态
//   - C4：点行 → emit('childClick', child)，**不** emit update:modelValue（两级叠开）
//   - C5：5 列表格基础列渲染（序列号 / 名称 / 数量 / 状态 / 系统交期），不含已交量
//   - C6：append-to-body + width=1200（嵌套弹窗硬约束，不能回退）
//   - C7：查询失败 → **error 态**（不落空态）+ ElMessage.error 桥接不抛
//   - C8：换 assemblyId → 重新取数并换一份子件（key 带 id，不串缓存）
//   - C9：装配 qk.assemblyPrefix 的 dashboard WS 失效订阅（staleTime 20min 的新鲜度通道）
//   - C10：system_delivery_date 为 null → 交期列「—」占位（t_part 该列可空）
//   - C11：关闭过渡期（modelValue=false + assemblyId 已清）→ 不出空态 / 错误态占位
//
// ElTable stub 照抄真实 Element Plus 的做法：按 :data 渲染 .mock-row，行内 provide 出
// 当前行（MockTableRow），列 stub inject 后按该行喂自己的 scoped slot ⇒ 列断言真的绑定
// 到 :data 的行上（:data 为空时列内容一个都不渲染，C3 有对应的反向断言）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { h, inject, nextTick, provide, toRef, type Ref, type VNode } from 'vue';

/** 行上下文的 provide key（与真实 el-table 的 table store 同一层语义）。 */
const ROW_KEY = Symbol('mock-el-table-row');

interface MockRow {
  id: string;
  [k: string]: unknown;
}
interface Slots {
  default?: (props?: Record<string, unknown>) => VNode[] | undefined;
}

/** 单行的上下文壳：provide 出当前行，内部照常渲染 el-table 的默认 slot。 */
const MockTableRow = {
  name: 'MockTableRow',
  props: ['row'],
  setup(props: { row: MockRow }, ctx: { slots: Slots }) {
    provide(ROW_KEY, toRef(props, 'row'));
    return () => ctx.slots['default']?.() ?? [];
  },
};

/** 行感知版 el-table：按 :data 渲染 .mock-row，每行内重新求值默认 slot（= 各列）。 */
const ElTableStub = {
  name: 'ElTable',
  props: ['data', 'stripe'],
  emits: ['row-click'],
  setup(props: { data?: MockRow[] }, ctx: { slots: Slots }) {
    return () =>
      h(
        'div',
        { class: 'mock-table' },
        (props.data ?? []).map((r) =>
          h('div', { class: 'mock-row', key: r.id }, [
            String(r.id),
            h(MockTableRow, { row: r }, { default: () => ctx.slots['default']?.() ?? [] }),
          ]),
        ),
      );
  },
};

/** 行感知版 el-table-column：inject 出 MockTableRow 提供的当前行喂 scoped slot；
 *  没有 default slot 时按 prop 渲染该字段（真实 el-table 的行为，否则 prop 型单元格
 *  在桩里恒为空，名称 / 数量两列就断言不到）。 */
const ElTableColumnStub = {
  name: 'ElTableColumn',
  props: ['prop', 'label', 'width', 'minWidth', 'align'],
  setup(props: Record<string, unknown>, ctx: { slots: Slots }) {
    const row = inject<Ref<MockRow | undefined> | undefined>(ROW_KEY, undefined);
    return () => {
      const current = row?.value;
      const slot = ctx.slots['default'];
      if (!slot) {
        const value = props.prop && current ? current[String(props.prop)] : undefined;
        return h(
          'div',
          { class: 'mock-column' },
          value === null || value === undefined ? '' : String(value),
        );
      }
      return h('div', { class: 'mock-column' }, slot({ row: current }));
    };
  },
};

// vi.mock('element-plus') 的 factory 被提升到文件顶部、且在静态 import 的 SFC 之前求值
// ⇒ factory 内不能引用本文件的顶层 const（TDZ）。factory 里只桩 ElMessage（真实
// ElMessage 在 node/happy-dom 下会因 document 缺失污染输出），el-* 组件一律由
// makeMountOpts 的 global.components 解析。
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElTable: {},
  ElTableColumn: {},
}));

const getAssemblyMock = vi.fn();

vi.mock('@/api/assembly', () => ({
  getAssembly: (id: string) => getAssemblyMock(id),
}));

// useDashboardInvalidation 桩成「记录传入的键」：它是个注册副作用的 composable
//（订阅 WS 事件集 + 挂 window 监听），桩掉既隔离了 api/dashboard 的 WS 单例，又让
// C9 能直接断言「本弹窗注册的失效键是 qk.assemblyPrefix」—— 即 staleTime 20min 之下
// 子件列表的新鲜度通道真的存在。用 vi.hoisted 因为 mock factory 早于本模块的
// 顶层 const 求值（TDZ，见上面 element-plus 那条注释）。
const { invalidationKeys } = vi.hoisted(() => ({ invalidationKeys: [] as unknown[] }));

vi.mock('@/views/dashboard/composables/useDashboardInvalidation', () => ({
  useDashboardInvalidation: (key: unknown) => {
    invalidationKeys.push(key);
    return undefined;
  },
}));

import { ElMessage } from 'element-plus';
import { qk } from '@/composables/queries/keys';
import AssemblyChildrenDialog from '../AssemblyChildrenDialog.vue';

/** 装配件子件（后端 AssemblyChildOut 18 字段，本测试只需 api mapper 会保留的那几个）。 */
function makeChild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000001',
    version: 1,
    serial_no: 'C1016',
    name: '前桥左半轴',
    drawing_no: 'DWG-201',
    status: 'IN_PROCESS',
    quantity: 4,
    planned_delivery_date: '2026-10-09',
    applicant_name: '李四',
    request_date: '2026-09-01',
    order_no: null,
    system_delivery_date: '2026-10-08',
    is_urgent: false,
    note: null,
    current_batch_id: null,
    ...overrides,
  };
}

/** getAssembly 的响应（api 层 mapper 的嵌套契约 { assembly, children, files }）。 */
function makeDetail(children: Record<string, unknown>[]): Record<string, unknown> {
  return { assembly: { id: '190000000000001', name: '前桥总成' }, children, files: [] };
}

describe('AssemblyChildrenDialog — 子件列表渲染', () => {
  let testQueryClient: QueryClient;

  beforeEach(() => {
    getAssemblyMock.mockReset();
    invalidationKeys.length = 0;
    (ElMessage.error as ReturnType<typeof vi.fn>).mockClear();
    // queries.retry: 0 与生产 main.ts 的全局默认对齐，否则错误态用例要等 1s+2s+4s。
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testQueryClient = null as unknown as QueryClient;
    vi.clearAllMocks();
  });

  function makeMountOpts(
    overrides: Partial<{ modelValue: boolean; assemblyId: string | null }> = {},
  ) {
    const opts: Parameters<typeof mount>[1] = {
      props: {
        modelValue: true,
        assemblyId: '190000000000001',
        ...overrides,
      },
      global: {
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
        components: {
          'el-dialog': {
            name: 'ElDialog',
            props: [
              'modelValue',
              'width',
              'top',
              'fullscreen',
              'title',
              'appendToBody',
              'showClose',
            ],
            emits: ['update:modelValue'],
            template: '<div class="mock-dialog"><slot /></div>',
          },
          'el-table': ElTableStub,
          'el-table-column': ElTableColumnStub,
          'el-tag': {
            name: 'ElTag',
            props: ['type', 'size', 'effect'],
            template: '<span class="mock-tag"><slot /></span>',
          },
          'el-empty': {
            name: 'ElEmpty',
            props: ['imageSize', 'description'],
            template: '<div class="mock-empty">{{ description }}</div>',
          },
          'el-icon': {
            name: 'ElIcon',
            template: '<i class="mock-icon"><slot /></i>',
          },
        },
        directives: {
          loading: {
            mounted() {},
            updated() {},
          },
        },
      },
    };
    return opts;
  }

  it('C1：assemblyId 非空 → getAssembly 被调一次，表格渲染 N 行子件', async () => {
    getAssemblyMock.mockResolvedValue(
      makeDetail([
        makeChild({ id: 'c1', serial_no: 'C1', name: '前桥左半轴', quantity: 4 }),
        makeChild({ id: 'c2', serial_no: 'C2', name: '前桥右半轴', quantity: 4 }),
      ]),
    );

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();

    expect(getAssemblyMock).toHaveBeenCalledTimes(1);
    expect(getAssemblyMock).toHaveBeenCalledWith('190000000000001');
    expect(wrapper.findAll('.mock-row')).toHaveLength(2);
    expect(wrapper.text()).toContain('前桥左半轴');
    wrapper.unmount();
  });

  it('C2：assemblyId=null（弹窗开着）→ enabled 闸门拦掉请求、渲染空态', async () => {
    getAssemblyMock.mockResolvedValue(makeDetail([makeChild()]));

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts({ assemblyId: null }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();

    expect(getAssemblyMock).not.toHaveBeenCalled();
    expect(wrapper.findAll('.mock-row')).toHaveLength(0);
    expect(wrapper.find('.mock-empty').text()).toBe('该装配件暂无子件');
    wrapper.unmount();
  });

  it('C3：children 为空数组 → 空态；列内容一个都不渲染（列断言绑在 :data 的行上）', async () => {
    getAssemblyMock.mockResolvedValue(makeDetail([]));

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();

    expect(wrapper.findAll('.mock-row')).toHaveLength(0);
    expect(wrapper.find('.mock-empty').exists()).toBe(true);
    expect(wrapper.find('.mock-column').exists()).toBe(false);
    wrapper.unmount();
  });

  it('C11：关闭过渡期（modelValue=false + assemblyId 已清）→ 不出空态 / 错误态占位', async () => {
    // 父组件在关闭时把 assemblyId 置 null（闸门随弹窗开关走），queryKey 落到空串占位键
    // ⇒ children 立刻变空。若占位文案不按 modelValue 门控，el-dialog 的 leave 动画
    // 途中会闪一句「该装配件暂无子件」，看着像数据被清掉了。
    getAssemblyMock.mockResolvedValue(makeDetail([makeChild({ id: 'c1' })]));

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();
    expect(wrapper.find('.mock-empty').exists()).toBe(false);

    await wrapper.setProps({ modelValue: false, assemblyId: null });
    await nextTick();

    expect(wrapper.find('.dialog-empty').exists()).toBe(false);
    expect(wrapper.find('.dialog-error').exists()).toBe(false);
    wrapper.unmount();
  });

  it('C4：点行 → emit childClick(child)，且不 emit update:modelValue（两级弹窗叠开）', async () => {
    const child = makeChild({ id: 'c1', serial_no: 'C1' });
    getAssemblyMock.mockResolvedValue(makeDetail([child]));

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();

    const table = wrapper.findComponent({ name: 'ElTable' });
    expect(table.exists()).toBe(true);
    table.vm.$emit('row-click', {
      id: 'c1',
      serial_no: 'C1',
      name: '前桥左半轴',
      quantity: 4,
      status: 'IN_PROCESS',
      system_delivery_date: '2026-10-08',
    });
    await nextTick();

    expect(wrapper.emitted('childClick')?.[0]?.[0]).toMatchObject({ id: 'c1', serial_no: 'C1' });
    // 关键契约：子件列表弹窗保持开启，不因点行而关闭
    expect(wrapper.emitted('update:modelValue')).toBeFalsy();
    wrapper.unmount();
  });

  it('C5：5 列基础列渲染（序列号 / 名称 / 数量 / 状态 / 系统交期），不含已交量', async () => {
    getAssemblyMock.mockResolvedValue(
      makeDetail([
        makeChild({
          id: 'c1',
          serial_no: null,
          name: '前桥左半轴',
          quantity: 4,
          status: 'READY_TO_SHIP',
          system_delivery_date: '2026-10-08',
        }),
      ]),
    );

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();

    // 5 列基础列（序列号 / 名称 / 数量 / 状态 / 系统交期）
    expect(wrapper.findAll('.mock-column')).toHaveLength(5);
    expect(wrapper.text()).toContain('前桥左半轴'); // 名称
    expect(wrapper.text()).toContain('4'); // 数量
    expect(wrapper.text()).toContain('待送货'); // 状态文案
    expect(wrapper.text()).toContain('10/08'); // 系统交期（MM/DD）
    // 序列号为空 → 破折号兜底
    expect(wrapper.findAll('.mock-row')[0]?.text()).toContain('—');
    // **不显示已交量**：装配件的「部分已交」是套级口径，子件级已交量与之不同源也不同单位
    expect(wrapper.text()).not.toContain('已送');
    wrapper.unmount();
  });

  it('C6：append-to-body + width=1200（嵌套弹窗硬约束，与 PartPreviewDialog 的 960 区分）', () => {
    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    const dialog = wrapper.findComponent({ name: 'ElDialog' });

    expect(dialog.exists()).toBe(true);
    expect(dialog.props('appendToBody')).toBe(true);
    expect(dialog.props('width')).toBe(1200);
    wrapper.unmount();
  });

  it('C7：请求失败 → 出 error 态（不落空态）+ ElMessage.error 桥接不抛', async () => {
    getAssemblyMock.mockRejectedValue(new Error('装配件不存在'));

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();

    expect(ElMessage.error).toHaveBeenCalledWith('装配件不存在');
    expect(wrapper.findAll('.mock-row')).toHaveLength(0);
    // 失败态与空态必须可区分：取不到 ≠ 没有子件，否则用户会以为该装配件真的没子件。
    expect(wrapper.find('.dialog-error').exists()).toBe(true);
    expect(wrapper.find('.dialog-error').text()).toContain('装配件不存在');
    expect(wrapper.find('.mock-empty').exists()).toBe(false);
    wrapper.unmount();
  });

  it('C9：注册 qk.assemblyPrefix 的 dashboard WS 失效订阅（staleTime 20min 的新鲜度通道）', () => {
    // 注册发生在组件 setup 顶层，与弹窗开关无关，所以不传任何前置条件就该有一笔。
    // 少了这一行，子件列表在 20 分钟 staleTime 内不会因他人改动装配件而刷新。
    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());

    expect(invalidationKeys).toEqual([qk.assemblyPrefix]);
    wrapper.unmount();
  });

  it('C10：system_delivery_date 为 null → 交期列「—」占位（t_part 该列可空）', async () => {
    getAssemblyMock.mockResolvedValue(
      makeDetail([makeChild({ id: 'c1', name: '前桥左半轴', system_delivery_date: null })]),
    );

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();

    expect(wrapper.find('.mock-row').text()).toContain('—');
    wrapper.unmount();
  });

  it('C8：换 assemblyId → 换键重取、渲染新子件（不串上一份缓存）', async () => {
    getAssemblyMock.mockImplementation((id: string) =>
      Promise.resolve(
        makeDetail([
          makeChild({
            id: `${id}-c1`,
            name: id === '190000000000001' ? '前桥左半轴' : '前桥右半轴',
          }),
        ]),
      ),
    );

    const wrapper = mount(AssemblyChildrenDialog, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();
    expect(wrapper.text()).toContain('前桥左半轴');

    await wrapper.setProps({ assemblyId: '190000000000002' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await nextTick();

    expect(getAssemblyMock).toHaveBeenCalledTimes(2);
    expect(getAssemblyMock).toHaveBeenLastCalledWith('190000000000002');
    expect(wrapper.text()).toContain('前桥右半轴');
    expect(wrapper.text()).not.toContain('前桥左半轴');
    wrapper.unmount();
  });
});
