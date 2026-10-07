// src/views/outsource/composables/__tests__/useOutsourceColumnFilters.spec.ts
//
// 2026-10-09 新增：外协三页共用的表头筛选状态机（`useOutsourceColumnFilters` +
// `makeNativeMultiFilter` / `makeNativeBoolFilter`）的语义守卫。
//
// 三类筛选各自的失败形态都是**静默**的，所以必须逐条钉：
//   · 文本列：confirm 不写 search（或写了带空白的串）⇒ 筛选看着生效、请求参数却是
//     旧值 / 带尾随空格的子串；reset 只清 search 不清 draft ⇒ popover 正开着时点重置，
//     下次点「确定」把旧值写回去；
//   · 日期区间：confirm 不写 from/to ⇒ 区间 UI 显示已选但请求不带区间；
//   · 原生枚举：翻译器没把 `filter-change` 的 payload 写回 search ⇒ 表头勾选亮着、
//     列表却是全量（这是本页「状态筛选恒不生效」那类故障的复现形态）。

import { describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';

import {
  makeNativeBoolFilter,
  makeNativeMultiFilter,
  useOutsourceColumnFilters,
} from '../useOutsourceColumnFilters';

/** 造一份 deps（onSearch 是 vi.fn，便于断言「点了确定要重新查一次」）。 */
function makeDeps<T extends Record<string, unknown>>(search: T) {
  const onSearch = vi.fn();
  return { search: reactive(search), onSearch };
}

describe('文本筛选（makeTextFilter）', () => {
  it('F1：confirm 把 trim 后的 draft 写进 search 并触发一次 onSearch', () => {
    const deps = makeDeps({ drawing_no: '' });
    const { makeTextFilter } = useOutsourceColumnFilters(deps);
    const f = makeTextFilter('drawing_no');

    f.draft.value = '  DWG-1  ';
    expect(f.active.value).toBe(false); // 还没 confirm：active 只看已确认值
    f.confirm();

    expect(deps.search.drawing_no).toBe('DWG-1');
    expect(f.active.value).toBe(true);
    expect(deps.onSearch).toHaveBeenCalledTimes(1);
    expect(f.visible.value).toBe(false); // confirm 顺手关掉 popover
  });

  it('F2：sync 把已确认值回写草稿（二次打开看到原状，不是空草稿）', () => {
    const deps = makeDeps({ drawing_no: 'DWG-1' });
    const { makeTextFilter } = useOutsourceColumnFilters(deps);
    const f = makeTextFilter('drawing_no');

    f.sync();
    expect(f.draft.value).toBe('DWG-1');
  });

  // 只清 search 不清 draft 是本页「重置筛选后又被旧值写回来」的成因。
  it('F3：reset 同时清已确认值 / 草稿 / popover 打开态，并触发一次 onSearch', () => {
    const deps = makeDeps({ drawing_no: 'DWG-1' });
    const { makeTextFilter } = useOutsourceColumnFilters(deps);
    const f = makeTextFilter('drawing_no');
    f.sync();
    f.visible.value = true;

    f.reset();

    expect(deps.search.drawing_no).toBe('');
    expect(f.draft.value).toBe('');
    expect(f.visible.value).toBe(false);
    expect(f.active.value).toBe(false);
    expect(deps.onSearch).toHaveBeenCalledTimes(1);
  });

  it('F4：confirm 一个空白 draft 等价于清空该列筛选', () => {
    const deps = makeDeps({ drawing_no: 'DWG-1' });
    const { makeTextFilter } = useOutsourceColumnFilters(deps);
    const f = makeTextFilter('drawing_no');
    f.sync();

    f.draft.value = '   ';
    f.confirm();

    expect(deps.search.drawing_no).toBe('');
    expect(f.active.value).toBe(false);
  });
});

describe('日期区间筛选（makeDateRangeFilter）', () => {
  it('F5：confirm 把区间的两端分别写进 from / to 两键', () => {
    const deps = makeDeps({ sent_from: '', sent_to: '' });
    const { makeDateRangeFilter } = useOutsourceColumnFilters(deps);
    const f = makeDateRangeFilter('sent_from', 'sent_to');

    f.range.value = ['2026-10-01T00:00:00', '2026-10-09T23:59:59'];
    f.confirm();

    expect(deps.search.sent_from).toBe('2026-10-01T00:00:00');
    expect(deps.search.sent_to).toBe('2026-10-09T23:59:59');
    expect(f.active.value).toBe(true);
  });

  it('F6：只填一端也是激活态（闭区间单边筛是合法用法）', () => {
    const deps = makeDeps({ received_from: '2026-10-01T00:00:00', received_to: '' });
    const { makeDateRangeFilter } = useOutsourceColumnFilters(deps);
    const f = makeDateRangeFilter('received_from', 'received_to');
    expect(f.active.value).toBe(true);
  });

  it('F7：sync 从已确认值回填区间草稿', () => {
    const deps = makeDeps({ sent_from: 'A', sent_to: 'B' });
    const { makeDateRangeFilter } = useOutsourceColumnFilters(deps);
    const f = makeDateRangeFilter('sent_from', 'sent_to');

    f.sync();
    expect(f.range.value).toEqual(['A', 'B']);
  });

  it('F8：reset 清两端 + 草稿 + 打开态', () => {
    const deps = makeDeps({ sent_from: 'A', sent_to: 'B' });
    const { makeDateRangeFilter } = useOutsourceColumnFilters(deps);
    const f = makeDateRangeFilter('sent_from', 'sent_to');
    f.sync();
    f.visible.value = true;

    f.reset();

    expect(deps.search.sent_from).toBe('');
    expect(deps.search.sent_to).toBe('');
    expect(f.range.value).toBeNull();
    expect(f.visible.value).toBe(false);
  });

  it('F9：清空区间后 confirm 也把两端归零（不是「保留上次的值」）', () => {
    const deps = makeDeps({ sent_from: 'A', sent_to: 'B' });
    const { makeDateRangeFilter } = useOutsourceColumnFilters(deps);
    const f = makeDateRangeFilter('sent_from', 'sent_to');
    f.sync();

    f.range.value = null;
    f.confirm();

    expect(deps.search.sent_from).toBe('');
    expect(deps.search.sent_to).toBe('');
  });
});

describe('原生多选枚举（makeNativeMultiFilter）', () => {
  it('F10：filteredValue / active / count 全由 search 派生（不是独立状态）', () => {
    const deps = makeDeps({ statuses: ['DRAFT'] as string[] });
    const { filter } = makeNativeMultiFilter(deps, {
      key: 'statuses',
      options: [{ text: '草稿', value: 'DRAFT' }],
    });
    expect(filter.filteredValue.value).toEqual(['DRAFT']);
    expect(filter.active.value).toBe(true);
    expect(filter.count.value).toBe(1);
  });

  it('F11：filter-change 把选中的值写回 search 并触发一次 onSearch', () => {
    const deps = makeDeps({ statuses: [] as string[] });
    const { applyNativeChange } = makeNativeMultiFilter(deps, {
      key: 'statuses',
      options: [{ text: '草稿', value: 'DRAFT' }],
    });

    expect(applyNativeChange({ statuses: ['DRAFT', 'SUBMITTED'] })).toBe(true);
    expect(deps.search.statuses).toEqual(['DRAFT', 'SUBMITTED']);
    expect(deps.onSearch).toHaveBeenCalledTimes(1);
  });

  // EP 只上报**本次变更的那一列**：payload 里没有本列时不能误触发查询。
  it('F12：payload 里没有本列 → 不改 search、不触发 onSearch', () => {
    const deps = makeDeps({ statuses: ['DRAFT'] as string[] });
    const { applyNativeChange } = makeNativeMultiFilter(deps, {
      key: 'statuses',
      options: [{ text: '草稿', value: 'DRAFT' }],
    });

    expect(applyNativeChange({ is_billed: ['true'] })).toBe(false);
    expect(deps.search.statuses).toEqual(['DRAFT']);
    expect(deps.onSearch).not.toHaveBeenCalled();
  });

  it('F13：全清（[]）= 不筛（而不是「什么都不匹配」）', () => {
    const deps = makeDeps({ statuses: ['DRAFT'] as string[] });
    const { applyNativeChange } = makeNativeMultiFilter(deps, {
      key: 'statuses',
      options: [{ text: '草稿', value: 'DRAFT' }],
    });

    applyNativeChange({ statuses: [] });

    expect(deps.search.statuses).toEqual([]);
  });
});

describe('两态布尔枚举（makeNativeBoolFilter）', () => {
  it('F14：search 侧 boolean ↔ EP 侧字符串双向翻译', () => {
    const deps = makeDeps({ is_billed: true as boolean | undefined });
    const { filter, applyNativeChange } = makeNativeBoolFilter(deps, {
      key: 'is_billed',
      trueLabel: '已对账',
      falseLabel: '未对账',
    });

    expect(filter.filteredValue.value).toEqual(['true']);
    expect(filter.options).toEqual([
      { text: '已对账', value: 'true' },
      { text: '未对账', value: 'false' },
    ]);
    expect(filter.toValue('false')).toBe(false);

    applyNativeChange({ is_billed: ['false'] });
    expect(deps.search.is_billed).toBe(false);
  });

  it('F15：active 在 undefined / true / false 三态下分别是 false / true / true', () => {
    const deps = makeDeps({ is_active: undefined as boolean | undefined });
    const { filter, applyNativeChange } = makeNativeBoolFilter(deps, {
      key: 'is_active',
      trueLabel: '启用',
      falseLabel: '停用',
    });
    expect(filter.active.value).toBe(false);
    expect(filter.count.value).toBe(0);

    applyNativeChange({ is_active: ['false'] });
    expect(deps.search.is_active).toBe(false);
    expect(filter.active.value).toBe(true);
  });

  // 两个值都选 = 后端收到 undefined（不过滤）；这是本列唯一的「无法表达」的组合，
  // 显式登记，免得后来人以为漏实现了。
  it('F16：两个值都被勾上 → 归一成 undefined（不筛）', () => {
    const deps = makeDeps({ is_active: true as boolean | undefined });
    const { applyNativeChange } = makeNativeBoolFilter(deps, {
      key: 'is_active',
      trueLabel: '启用',
      falseLabel: '停用',
    });

    applyNativeChange({ is_active: ['true', 'false'] });
    expect(deps.search.is_active).toBeUndefined();
  });

  it('F17：全清 = 回到不过滤', () => {
    const deps = makeDeps({ is_active: false as boolean | undefined });
    const { applyNativeChange } = makeNativeBoolFilter(deps, {
      key: 'is_active',
      trueLabel: '启用',
      falseLabel: '停用',
    });

    applyNativeChange({ is_active: [] });
    expect(deps.search.is_active).toBeUndefined();
  });
});