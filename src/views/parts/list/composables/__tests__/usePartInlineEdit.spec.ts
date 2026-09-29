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
// 本 spec 锁住的 4 条 regression：
//   R1 两条分支的 payload 都必须带 `version`（= row.version，t_part/t_assembly）。
//   R2 assembly 分支绝不能发 `unit_price: null` / `total_price: null`——后端是三态
//      `Option<Option<Decimal>>`，`null` 解成 `Some(None)` → SQL `col = NULL`，
//      而 t_assembly 这两列 NOT NULL → Postgres 23502 → HTTP 500。
//   R3 `unit_price` 空串 / 非法串归一为 '0'（后端 `Decimal::from_str("")` → 40001），
//      且 `total_price` 由前端按 quantity * unit_price 派生下发（后端不重算）。
//   R4 onSuccess 回写 `version`（后端每次 UPDATE version + 1）——不回写则同一行
//      第二次保存必撞 40901 假冲突（列表不整表刷新，行对象引用不变）。
//
// 依赖处理：useMutation / useQueryClient 需 VueQueryPlugin + QueryClient；
// ElMessage 桩成 no-op（node env 无 document，EP 内部 normalizeAppendTo 会抛
// ReferenceError 污染输出）；@/api/parts / @/api/assembly / @/api/applicant 全部 mock。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, ref, type ComputedRef } from 'vue';
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

function setup(rows: PartListItem[]) {
  const items = ref(rows) as unknown as ComputedRef<PartListItem[]>;
  return testApp.runWithContext(() =>
    usePartInlineEdit({
      items,
      customerTree: ref<CustomerCascaderNode[]>([]) as unknown as never,
      canEdit: true,
      isBatchMode: () => false,
    }),
  );
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
    const row = makeRow();
    const edit = setup([row]);

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
    const row = makeRow({ row_type: 'ASSEMBLY' });
    const edit = setup([row]);

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
    const row = makeRow({ row_type: 'ASSEMBLY', unit_price: '', total_price: '' });
    const edit = setup([row]);

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
    const row = makeRow({ unit_price: '', quantity: 3 });
    const edit = setup([row]);

    edit.startEdit(row);
    edit.editBuffer.unit_price = '';
    await edit.saveEdit(row);

    const [, payload] = updatePart.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.unit_price).toBe('0');
    expect(payload.total_price).toBe('0.00');
  });

  it('R3b: total_price 走整数分中间量，规避浮点误差', async () => {
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    const row = makeRow({ quantity: 3, unit_price: '0.1' });
    const edit = setup([row]);

    edit.startEdit(row);
    await edit.saveEdit(row);

    const [, payload] = updatePart.mock.calls[0] as [string, Record<string, unknown>];
    // 裸浮点会是 0.30000000000000004
    expect(payload.total_price).toBe('0.30');
  });

  // R4：onSuccess 回写 version + total_price（否则同一行第二次保存假 40901）
  it('R4a: onSuccess 回写 row.version（part 响应 = PartDetailOut.version）', async () => {
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    const row = makeRow();
    const edit = setup([row]);

    edit.startEdit(row);
    await edit.saveEdit(row);
    await flush();

    expect(row.version).toBe(4);
    expect(edit.editingId.value).toBeNull();
  });

  it('R4b: onSuccess 回写 row.version（assembly 响应 = AssemblyOut.version，平铺）', async () => {
    // 2026-09-29 review 第 1 轮 C3 修复：mock 响应形态对齐后端真实契约
    // AssemblyOut 19 字段平铺（顶层 version，不再是 AssemblyDetail.assembly.version）。
    updateAssembly.mockResolvedValue(makeAssemblyOut({ version: 7 }));
    const row = makeRow({ row_type: 'ASSEMBLY' });
    const edit = setup([row]);

    edit.startEdit(row);
    await edit.saveEdit(row);
    await flush();

    expect(row.version).toBe(7);
  });

  it('R4c: onSuccess 回写 row.total_price（列表总价列渲染该字段）', async () => {
    updatePart.mockResolvedValue({ ...makeRow(), version: 4 });
    const row = makeRow({ quantity: 3, unit_price: '10.00', total_price: '30.00' });
    const edit = setup([row]);

    edit.startEdit(row);
    edit.editBuffer.quantity = 5;
    await edit.saveEdit(row);
    await flush();

    expect(row.total_price).toBe('50.00');
  });

  // 响应体形态不识别时保持原 version（不误写 0）
  it('R4d: 响应体无 version 时保持原值', async () => {
    updatePart.mockResolvedValue({ id: '1' });
    const row = makeRow();
    const edit = setup([row]);

    edit.startEdit(row);
    await edit.saveEdit(row);
    await flush();

    expect(row.version).toBe(3);
  });

  // 40901 走 warning + 整表 invalidate（不吞错）
  it('40901 冲突走 warning 分支而非 error', async () => {
    updatePart.mockRejectedValue(Object.assign(new Error('版本冲突'), { code: 40901 }));
    const row = makeRow();
    const edit = setup([row]);

    edit.startEdit(row);
    await edit.saveEdit(row);
    await flush();

    expect(ElMessage.warning).toHaveBeenCalledWith('该记录已被他人修改，已为你刷新列表');
    expect(ElMessage.error).not.toHaveBeenCalled();
  });
});
