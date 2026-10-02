// src/views/parts/list/composables/__tests__/usePartInlineEdit.spec.ts
//
// 2026-09-28 新增：行内编辑 OCC 契约单测（vitest node 环境）。
//
// 背景（真实故障）：后端 `PartUpdateRequest.version` / `AssemblyUpdateRequest.version`
// 均**无 `#[serde(default)]`**（backend-rust `part/dto_crud.rs` / `assembly/dto.rs`），
// 缺字段时 axum `Json` extractor 在 service 之前直接拒 → HTTP 422
// `missing field version`（非项目统一信封）。前端 payload 从不带 version →
// 列表行内编辑的 part / assembly 两条分支**恒 422**，保存功能完全不可用。
//
// 本 spec 锁住的 regression：
//   R1 两条分支的 payload 都必须带 `version`（= row.version，t_part/t_assembly）。
//   R2 assembly 分支绝不能发 `unit_price: null` / `total_price: null`——后端是三态
//      `Option<Option<Decimal>>`，`null` 解成 `Some(None)` → SQL `col = NULL`，
//      而 t_assembly 这两列 NOT NULL → Postgres 23502 → HTTP 500。
//   R3 `unit_price` 空串 / 非法串归一为 '0'（后端 `Decimal::from_str("")` → 40001），
//      且 `total_price` 由前端按 quantity * unit_price 派生下发（后端不重算）。
//   R4 onSuccess **失效 parts 域**（后端每次 UPDATE version + 1 + total_price 由
//      前端派生下发，失效回流才能让两者可见，否则同一行第二次保存必撞 40901
//      假冲突 / 总价列显示旧值）。
//   R5 2026-10-02 根因回归：rows 用 `readonly()` 包装（模拟 vue-query 的深只读
//      代理）后跑一次 saveEdit —— console.warn **不得**收到任何
//      `Set operation on key` 调用，且 invalidateQueries 必须被调一次。
//      ⚠️ 本文件此前用 `ref(rows)`（可写 reactive 代理）当数据源，所以线上那个
//      `[Vue warn] Set operation on key "version" failed: target is readonly`
//      在 CI 里**测不出来** —— 断言的对象可写，任何就地回填都能「通过」。
//      2026-10-02 起 setup() 改用 `readonly(rows)`，让测试目标与生产一致。
//
// 依赖处理：useMutation / useQueryClient 需 VueQueryPlugin + QueryClient；
// ElMessage 桩成 no-op（node env 无 document，EP 内部 normalizeAppendTo 会抛
// ReferenceError 污染输出）；@/api/parts / @/api/assembly / @/api/applicant 全部 mock。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, readonly, ref, type ComputedRef } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { PartListItem } from '@/types/parts';
import type { CustomerCascaderNode } from '@/composables/useCustomerTree';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const updatePart = vi.fn();
const updateAssembly = vi.fn();

vi.mock('@/api/parts', () => ({
  updatePart: (...args: unknown[]) => updatePart(...args),
}));

vi.mock('@/api/assembly', () => ({
  updateAssembly: (...args: unknown[]) => updateAssembly(...args),
}));

vi.mock('@/api/applicant', () => ({
  searchApplicants: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

import { usePartInlineEdit } from '../usePartInlineEdit';
import { ElMessage } from 'element-plus';

/** 后端 PartListOut 真实形态的最小行（2026-09-27 前后端字段对齐：价格为 string）。 */
function makeRow(overrides: Partial<PartListItem> = {}): PartListItem {
  const row: PartListItem = {
    id: '213102505968533504',
    version: 3,
    serial_no: 'HSH20260928001',
    name: '老化电极板-10',
    drawing_no: 'E42703FZJ282800-10',
    applicant_name: null,
    quantity: 3,
    unit_price: '10.00',
    total_price: '30.00',
    request_date: '2026-08-12',
    planned_delivery_date: '2026-08-19',
    is_urgent: false,
    status: 'PENDING',
    order_no: null,
    system_delivery_date: null,
    note: null,
    customer_name: null,
    l1_customer_name: null,
    location: null,
    // 2026-09-29 新增：PartListItem 必填 has_cnc_program 字段（沿 chain 派生）。
    has_cnc_program: false,
    ...overrides,
  };
  return row;
}

/** 2026-09-29 review 第 1 轮 C3 修复：后端 AssemblyOut 真实响应是 19 字段平铺
 * （无 children / files 嵌套，无 assembly 外层包装）。用 makeRow() 做基础
 * 字段复用，强制只取 AssemblyOut 19 字段 → mock 形态与 production 完全对齐。 */
function makeAssemblyOut(overrides: Partial<PartListItem> = {}): Record<string, unknown> {
  const base = makeRow(overrides);
  return {
    id: base.id,
    version: base.version,
    serial_no: base.serial_no,
    drawing_no: base.drawing_no,
    name: base.name,
    applicant_name: base.applicant_name,
    customer_id: '180000000000001',
    request_date: base.request_date,
    planned_delivery_date: base.planned_delivery_date,
    is_urgent: base.is_urgent,
    status: base.status,
    quantity: base.quantity,
    unit_price: base.unit_price,
    total_price: base.total_price,
    order_no: base.order_no,
    system_delivery_date: base.system_delivery_date,
    note: base.note,
    created_at: '2026-09-29 10:00:00',
    updated_at: '2026-09-29 11:00:00',
  };
}

// vue-query 的 `useQueryClient()` 走 Vue `inject()` 拿客户端，vitest node env 没有
// 组件 setup 上下文，必须在 `app.runWithContext(() => ...)` 里调 usePartInlineEdit，
// 让 Vue 把 currentApp 临时切到本测试 app，inject 才能在 app._context.provides 里
// 命中 VueQueryPlugin 注册的 client。该 app 不挂组件、不 mount，仅作 provide channel。
let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/**
 * 装配 composable，并返回**只读代理下的那个行对象**。
 *
 * 2026-10-02 改两处形态，都是为了让测试目标与生产一致：
 *   ① `ref(rows)` → `readonly(rows)`。生产数据源是 @tanstack/vue-query 的 useQuery
 *      data，vue-query 对它套 `readonly(state)` **深**只读代理
 *      （useBaseQuery.js:77-78，本仓未开 shallow: true）。原用例用 ref() 产生
 *      **可写**代理，于是 2026-10-02 修掉的 `Object.assign(row, …)` 静默失效 +
 *      `[Vue warn] Set operation on key …` 在 CI 里测不出来 —— 断言对象可写，
 *      任何就地回填都能「通过」。
 *   ② 返回值从 edit 句柄变成 `{ edit, row }`，`row` 是**只读代理**下的元素。
 *      只包数组不够：生产里 el-table 传给 startEdit / saveEdit 的 row 就是
 *      deps.items.value 里的那个元素（只读代理），如果测试仍把 makeRow() 的
 *      **裸对象**喂给 saveEdit，那么写操作打在裸对象上、不可能触发 readonly
 *      warn —— 2026-10-02 首次写这组用例时正是这个坑（R5 变异测试未失败）。
 */
function setup(src: PartListItem): {
  edit: ReturnType<typeof usePartInlineEdit>;
  row: PartListItem;
} {
  const rows = readonly([src]);
  const edit = testApp.runWithContext(() =>
    usePartInlineEdit({
      items: rows as unknown as ComputedRef<PartListItem[]>,
      customerTree: ref<CustomerCascaderNode[]>([]) as unknown as never,
      canEdit: true,
      isBatchMode: () => false,
    }),
  );
  // 走一次数组下标取值，拿到的是 readonly 代理后的元素（与生产 el-table 的 row 同形）。
  // cast 理由：`readonly()` 的返回类型是 `DeepReadonly<T>`，与本 composable deps 上
  // 声明的 `PartListItem`（可变）结构不兼容 —— 这正是**运行时**只读、**类型层**仍
  // 声明可写的分歧点本身（生产侧同样靠 el-table 的 row 协议绕过，vue-query 的
  // data 类型也是 T 而非 DeepReadonly<T>）。测试要模拟的正是这个分歧。
  return { edit, row: rows[0] as unknown as PartListItem };
}

/** 等 mutation 走完（mutate 是 fire-and-forget，isPending 翻转 + onSuccess 同步执行）。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('usePartInlineEdit — OCC version 契约（2026-09-28）', () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    updatePart.mockReset();
    updateAssembly.mockReset();
    vi.clearAllMocks();
  });

  // R1：part 分支必须带 version（缺则后端 422）
  it('R1a: part 分支 payload 带 version（= row.version）', async () => {
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    const { edit, row } = setup(makeRow());

    edit.startEdit(row);
    await edit.saveEdit(row);

    expect(updatePart).toHaveBeenCalledTimes(1);
    const [id, payload] = updatePart.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe(row.id);
    expect(payload.version).toBe(3);
  });

  // R1：assembly 分支同样必须带 version
  it('R1b: assembly 分支 payload 带 version（= row.version）', async () => {
    // 2026-09-29 review 第 1 轮 C3 修复：mock 响应形态对齐后端真实契约
    // AssemblyOut 19 字段平铺（旧实现错误地走 AssemblyDetail 嵌套形态）。
    updateAssembly.mockResolvedValue(makeAssemblyOut({ version: 4 }));
    const { edit, row } = setup(makeRow({ row_type: 'ASSEMBLY' }));

    edit.startEdit(row);
    await edit.saveEdit(row);

    expect(updatePart).not.toHaveBeenCalled();
    expect(updateAssembly).toHaveBeenCalledTimes(1);
    const [, payload] = updateAssembly.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.version).toBe(3);
  });

  // R2：assembly 分支不能发 null 价格（t_assembly NOT NULL → 23502 → 500）
  it('R2: assembly 分支不下发 null 价格（三态 Some(None) 会撞 NOT NULL）', async () => {
    updateAssembly.mockResolvedValue(makeAssemblyOut({ version: 4 }));
    const { edit, row } = setup(makeRow({ row_type: 'ASSEMBLY', unit_price: '', total_price: '' }));

    edit.startEdit(row);
    await edit.saveEdit(row);

    const [, payload] = updateAssembly.mock.calls[0] as [string, Record<string, unknown>];
    // editBuffer.unit_price 初始为 '0'，startEdit 从 row 取 '' → 归一为 '0'（R3），
    // 因此两个 key 都应存在且为数字 0，而不是 null。
    expect(payload.unit_price).toBe(0);
    expect(payload.total_price).toBe(0);
    // 只锁 NOT NULL 的两列：order_no / system_delivery_date / note 三态 null = 置 NULL
    // 是**期望**语义（DDL nullable），不在本 guard 范围内。
    for (const col of ['unit_price', 'total_price']) {
      expect(payload[col]).not.toBeNull();
    }
  });

  // R3：unit_price 空串归一 + total_price 前端派生下发（后端 update 不重算）
  it('R3: unit_price 空串归一为 0，total_price 按 quantity * unit_price 派生', async () => {
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    const { edit, row } = setup(makeRow({ unit_price: '', quantity: 3 }));

    edit.startEdit(row);
    edit.editBuffer.unit_price = '';
    await edit.saveEdit(row);

    const [, payload] = updatePart.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.unit_price).toBe('0');
    expect(payload.total_price).toBe('0.00');
  });

  it('R3b: total_price 走整数分中间量，规避浮点误差', async () => {
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    const { edit, row } = setup(makeRow({ quantity: 3, unit_price: '0.1' }));

    edit.startEdit(row);
    await edit.saveEdit(row);

    const [, payload] = updatePart.mock.calls[0] as [string, Record<string, unknown>];
    // 裸浮点会是 0.30000000000000004
    expect(payload.total_price).toBe('0.30');
  });

  // R4：onSuccess 失效 parts 域（version / total_price 都靠失效回流，见文件头）
  // 四条用例的**业务 intent 不变**，只是断言方式从「就地回写行对象」换成
  // 「invalidateQueries 被以 qk.partsPrefix 调用」——
  //   R4a/R4b intent：保存后 version 必须更新，否则同一行第二次保存必撞 40901
  //                   假冲突；
  //   R4c    intent：保存后总价列必须显示新值；
  //   R4d    intent：响应体无 version 时不崩（旧实现是 readResponseVersion 兜底
  //                   返回 null；该函数 2026-10-02 已作为死代码删除，本用例改为
  //                   断言「不再依赖响应体形态」也能正常失效）。
  // 键值逐字断言 `['parts']`：防止将来有人改成裸数组或写错层级。
  it('R4a: onSuccess 失效 parts 域（part 分支）', async () => {
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    const { edit, row } = setup(makeRow());
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    edit.startEdit(row);
    await edit.saveEdit(row);
    await flush();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['parts'] });
    expect(edit.editingId.value).toBeNull();
  });

  it('R4b: onSuccess 失效 parts 域（assembly 分支，响应 AssemblyOut 平铺）', async () => {
    // 2026-09-29 review 第 1 轮 C3 修复：mock 响应形态对齐后端真实契约
    // AssemblyOut 19 字段平铺（顶层 version，不再是 AssemblyDetail.assembly.version）。
    updateAssembly.mockResolvedValue(makeAssemblyOut({ version: 7 }));
    const { edit, row } = setup(makeRow({ row_type: 'ASSEMBLY' }));
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    edit.startEdit(row);
    await edit.saveEdit(row);
    await flush();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['parts'] });
  });

  it('R4c: onSuccess 失效 parts 域（改数量后总价列靠 refetch 拿到新值）', async () => {
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    const { edit, row } = setup(
      makeRow({ quantity: 3, unit_price: '10.00', total_price: '30.00' }),
    );
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    edit.startEdit(row);
    edit.editBuffer.quantity = 5;
    await edit.saveEdit(row);
    await flush();

    // 派生值仍按 quantity * unit_price 下发（后端不重算，见 R3）；
    // 「显示新值」由失效后的 refetch 负责，本用例锁住这两半的接缝。
    const [, payload] = updatePart.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.total_price).toBe('50.00');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['parts'] });
  });

  it('R4d: 响应体无 version 也不崩（onSuccess 不再依赖响应体形态）', async () => {
    updatePart.mockResolvedValue({ id: '1' });
    const { edit, row } = setup(makeRow());
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    edit.startEdit(row);
    await edit.saveEdit(row);
    await flush();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['parts'] });
    expect(edit.editingId.value).toBeNull();
  });

  // R5：核心 regression guard —— vue-query 深只读代理 + 不得有 Set-operation warn
  it('R5（2026-10-02 根因回归）：rows 为 readonly 时 saveEdit 不触发 Set-operation warn，且失效一次', async () => {
    // 线上症状：编辑保存后控制台刷一串
    //   `[Vue warn] Set operation on key "version" failed: target is readonly.`
    // （Object.assign 的 13 个 key 全部写不进，`version` 只是最后一条 warn），
    // 且列表不刷新 —— 必须手动刷新页面才看到自己的修改。
    // 根因：deps.items 是 vue-query 的 `readonly(state)` 深只读代理（未开
    // shallow: true）；2026-10-02 起 onSuccess 不再就地写行对象，改走失效。
    // 本用例同时锁住两半：
    //   ① 没有写操作 ⇒ 没有 Vue readonly warn（生产症状消失）；
    //   ② 失效确实发生且键正确（数据能回流，症状 2 消失）。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    // setup() 返回的 row 就是 readonly 代理下的元素（生产 el-table 传给 saveEdit 的
    // 同一个东西），不需要也不该再包一层。
    const { edit, row } = setup(makeRow());
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    edit.startEdit(row);
    edit.editBuffer.quantity = 5;
    await edit.saveEdit(row);
    await flush();

    const readonlyWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('Set operation on key'),
    );
    expect(readonlyWarns).toEqual([]);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['parts'] });
    expect(edit.editingId.value).toBeNull();
    warnSpy.mockRestore();
  });

  // 40901 走 warning + 整表 invalidate（不吞错）
  it('40901 冲突走 warning 分支而非 error', async () => {
    updatePart.mockRejectedValue(Object.assign(new Error('版本冲突'), { code: 40901 }));
    const { edit, row } = setup(makeRow());

    edit.startEdit(row);
    await edit.saveEdit(row);
    await flush();

    expect(ElMessage.warning).toHaveBeenCalledWith('该记录已被他人修改，已为你刷新列表');
    expect(ElMessage.error).not.toHaveBeenCalled();
  });
});
