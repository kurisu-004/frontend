// @vitest-environment happy-dom
// src/views/production/components/__tests__/PartPickerList.spec.ts
//
// 2026-10-05 新增：左栏零件选择器组件单测（仓内第二例组件单测，先例 LoginCard.spec.ts）。
//
// 覆盖：
//   C1（rowKey 回归守卫，B bugfix）：`:current-row-key` 传裸 id 时，待制定 / 已制定
//        两张表的对应行**真的**带 `current-row` 类（改前永不高亮）。
//   C2：EP 侧的匹配契约 —— prop 侧 `setCurrentRowKey(`${key}`)` 总是字符串化、
//        而函数型 rowKey 在 `getRowIdentity` 里原样返回 ⇒ 只有「裸 id」两侧才相等。
//        同一份断言对带前缀的旧写法必须为 false（把被修掉的 bug 钉在测试里）。
//   C3：截断提示（total 是全量口径，> 已取行数时明示「仅显示前 N / 共 M」）。
//   C4：装配件子件角标（assembly_id 非空 → 序列号列前置「子」标记）。
//
// 为什么能挂真组件：数据层整块 mock 掉 `useProcessDesignStore`（只给 query 侧的
// 读接口），组件其余部分（el-card / el-input / el-tag / el-table / el-table-column /
// el-tooltip / v-loading）走 **真 Element Plus**。rowKey 是不是裸 id 只有真表格
// 才能证伪 —— 桩掉 el-table 就等于把待测契约一起桩掉。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import ElementPlus, { ElTable, ElTableColumn } from 'element-plus';
// EP 内部工具函数（走 package.json exports 的 `./es/*.mjs` 子路径公开可达）：
// 表格内部就是用它把行对象折成 identity 字符串并与 currentRowKey 做 `===` 比较。
import { getRowIdentity } from 'element-plus/es/components/table/src/util.mjs';
import type { ProcessDesignPartSchema } from '@/composables/queries/schemas';

// 组件内 `useProcessDesignStore()` 换成手搓对象：只有 query 侧只读接口会被用到。
// （pinia / VueQueryPlugin / 真实端点都不必接，组件单测只关心渲染与 prop 接线。）
const { storeMock } = vi.hoisted(() => ({
  storeMock: {
    query: {
      parts: [] as ProcessDesignPartSchema[],
      loading: false,
      total: 0,
      onSortChange: vi.fn(),
    },
  },
}));

vi.mock('../../composables/useProcessDesignStore', () => ({
  useProcessDesignStore: () => storeMock,
}));

import PartPickerList from '../PartPickerList.vue';

function part(
  overrides: Partial<ProcessDesignPartSchema> & { id: string },
): ProcessDesignPartSchema {
  return {
    version: 0,
    serial_no: 'SN-001',
    name: '零件',
    drawing_no: 'DWG-1',
    process_chain_id: null,
    assembly_id: null,
    ...overrides,
  };
}

const PENDING_ROW = part({ id: '5000000000002', name: '齿轮' });
const DESIGNED_ROW = part({
  id: '5000000000001',
  name: '法兰盘',
  process_chain_id: '7000000000001',
});
const CHILD_ROW = part({ id: '5000000000006', name: '轴承座', assembly_id: '8000000000001' });

/** 所有 tr.el-table__row（两张表各若干行）。 */
function rowsOf(wrapper: VueWrapper): ReturnType<VueWrapper['findAll']> {
  return wrapper.findAll('tr.el-table__row');
}

/** el-table 的 tbody 行是挂载后再渲染的（onMounted → store.updateColumns），
 *  单个 nextTick 只能拿到高亮类、单元格文本还是空 ⇒ 等一帧定时器再断言。 */
async function flush(): Promise<void> {
  await nextTick();
  await new Promise((r) => setTimeout(r, 50));
  await nextTick();
}

let wrapper: VueWrapper | null = null;

function mountPicker(selectedPartId: string | null): VueWrapper {
  storeMock.query.parts = [PENDING_ROW, DESIGNED_ROW, CHILD_ROW];
  storeMock.query.loading = false;
  storeMock.query.total = storeMock.query.parts.length;
  wrapper = mount(PartPickerList, {
    props: { selectedPartId },
    global: { plugins: [ElementPlus] },
  });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.clearAllMocks();
});

describe('PartPickerList', () => {
  // ============ C1：rowKey 回归守卫 ============
  it('C1：选中零件在「待制定」表高亮，且不会误高亮另一张表', async () => {
    const w = mountPicker(PENDING_ROW.id);
    await flush();
    const rows = rowsOf(w);
    // 渲染顺序：待制定 3 行（齿轮 / 轴承座 / 装配件子件同表）… 实际按 process_chain_id 分组
    expect(rows.length).toBe(3);
    const highlighted = rows.filter((tr) => tr.classes().includes('current-row'));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.text()).toContain('齿轮');
  });

  it('C1b：选中已制定零件时，高亮落在「已制定」表那一行', async () => {
    const w = mountPicker(DESIGNED_ROW.id);
    await flush();
    const highlighted = rowsOf(w).filter((tr) => tr.classes().includes('current-row'));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.text()).toContain('法兰盘');
  });

  it('C1c：未选中任何零件时没有 current-row 行', async () => {
    const w = mountPicker(null);
    await flush();
    expect(rowsOf(w).filter((tr) => tr.classes().includes('current-row'))).toHaveLength(0);
  });

  // ============ C2：EP 侧匹配契约（裸 id 才相等）============
  it('C2：函数型 rowKey 返回裸 id，与 prop 侧字符串化后的 current-row-key 相等', () => {
    const row = PENDING_ROW;
    // 函数分支：getRowIdentity 原样返回调用结果（util.mjs 的 isFunction 分支）
    expect(getRowIdentity(row, (r) => r.id)).toBe(row.id);
    // prop 侧：style-helper 用 `setCurrentRowKey(`${key}`)` 字符串化
    const propSide = `${row.id}`;
    expect(getRowIdentity(row, (r) => r.id)).toBe(propSide);
    // 对照：带前缀的旧写法两侧恒不相等 ⇒ currentRow 恒 null ⇒ 永不高亮
    const prefixed = (r: ProcessDesignPartSchema): string => `PART_${r.id}`;
    expect(getRowIdentity(row, prefixed)).not.toBe(propSide);
  });

  it('C2b：带前缀的 rowKey 挂在真 el-table 上确实不高亮（复现被修掉的 bug）', async () => {
    // 与 PartPickerList 相同的接线（highlight-current-row + current-row-key + row-key），
    // 只把 rowKey 换成旧的 `PART_` 前缀写法 ⇒ 行拿不到 current-row 类。
    // rowKey 由闭包注入（不走 props），免得跟 el-table 的 `(row: DefaultRow) => string`
    // 泛型签名在测试里打架 —— 组件侧 `:row-key` 传的是同一个函数形状。
    const harnessWith = (rowKey: (row: Record<string, unknown>) => string) => {
      const Harness = defineComponent({
        props: {
          data: { type: Array as () => ProcessDesignPartSchema[], required: true },
          currentRowKey: { type: String, required: true },
        },
        setup(props) {
          return () =>
            h(
              ElTable,
              {
                data: props.data,
                rowKey,
                currentRowKey: props.currentRowKey,
                highlightCurrentRow: true,
              },
              () => [h(ElTableColumn, { prop: 'serial_no', label: '序列号' })],
            );
        },
      });
      return Harness;
    };

    const prefixed = mount(
      harnessWith((r) => `PART_${String(r.id)}`),
      {
        props: { data: [PENDING_ROW], currentRowKey: PENDING_ROW.id },
        global: { plugins: [ElementPlus] },
      },
    );
    await flush();
    const prefixedRows = prefixed.findAll('tr.el-table__row');
    expect(prefixedRows).toHaveLength(1);
    expect(prefixedRows[0]?.classes()).not.toContain('current-row');
    prefixed.unmount();

    // 换成裸 id 的同一张表 ⇒ 高亮（这就是本次修复的净效果）
    const bare = mount(
      harnessWith((r) => String(r.id)),
      {
        props: { data: [PENDING_ROW], currentRowKey: PENDING_ROW.id },
        global: { plugins: [ElementPlus] },
      },
    );
    await flush();
    expect(bare.findAll('tr.el-table__row')[0]?.classes()).toContain('current-row');
    bare.unmount();
  });

  // ============ C3：截断提示 ============
  it('C3：total 大于已取行数时明示「仅显示前 N / 共 M」', async () => {
    storeMock.query.parts = [PENDING_ROW, DESIGNED_ROW, CHILD_ROW];
    storeMock.query.total = 42; // 后端 COUNT 全量口径，一页只取 limit 条
    wrapper = mount(PartPickerList, {
      props: { selectedPartId: null },
      global: { plugins: [ElementPlus] },
    });
    await flush();
    expect(wrapper.find('.picker-truncated').text()).toContain('仅显示前 3 / 共 42');
  });

  it('C3b：total 不超过已取行数时不显示截断提示', async () => {
    const w = mountPicker(null);
    await flush();
    expect(w.find('.picker-truncated').exists()).toBe(false);
  });

  // ============ C4：子件标记 ============
  it('C4：assembly_id 非空的行带「子」角标，独立零件不带', async () => {
    const w = mountPicker(null);
    await flush();
    const childRow = rowsOf(w).find((tr) => tr.text().includes('轴承座'));
    expect(childRow?.find('.child-flag').exists()).toBe(true);
    const plainRow = rowsOf(w).find((tr) => tr.text().includes('齿轮'));
    expect(plainRow?.find('.child-flag').exists()).toBe(false);
  });
});
