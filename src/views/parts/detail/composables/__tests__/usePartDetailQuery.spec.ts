// src/views/parts/detail/composables/__tests__/usePartDetailQuery.spec.ts
//
// 零件详情页两条只读 query hook（`usePartDetailQuery` / `usePartEventsQuery`）的回归保护。
//
// 覆盖七件事，任何一件被后人改坏都会红：
//   Q1 queryKey 形状 `['part-detail', id]` / `['part-events', id]`，且**不**挂在
//      `qk.partsPrefix` 下（挂下去会让全仓最热的零件域一把全刷把详情缓存连带重拉）。
//   Q2 queryFn 从 queryKey 读 id（reactive params 范式），换 id 后 refetch 带新值 —
//      闭包捕获 stale id 的写法在这条上会红。
//   Q3 **enabled 闸门**：`partId` 为 null ⇒ 零请求；`isActive` 为 false ⇒ 零请求。
//      这不是优化：keep-alive 缓存页下 `useRoute()` 跟的是**全局** currentRoute，切到
//      别的页面时 `route.params.id` 照样变，不闸门就会去拉「别的页面的零件」。
//   Q4 **Zod 守门真的接在 queryFn 上**：坏响应（多一个键 / 缺必填键 / 数组而非信封）
//      ⇒ data undefined + isError。把 queryFn 里的 `.parse()` 整段删掉时 Q1~Q3 全绿
//      而线上崩 —— 这条是那个失败模式的唯一守卫。
//   Q5 `fetchDetail` / `fetchEvents` 别名可驱动 refetch。
//   Q6 `error` 桥接到 `ElMessage.error`。
//   Q7 events 出参是**裸数组**（端点无分页），`batch_no` 保持 JSON number —— 声明成
//      string 或改成 `{items,total}` 信封都会红。
//
// 测试手法与 `views/production/scan/composables/__tests__/useScanQuery.spec.ts` 同款，
// 三个坑照抄：
//   - ⚠️ **必须用 `app.runWithContext`**：vue-query 的 `useQueryClient()` 走 Vue `inject()`，
//     node env 下 currentApp 为 null 时 inject 直接抛。该 app 不挂组件，仅作 provide channel。
//   - ⚠️ 每个用例一份新 QueryClient：缓存跨用例残留会让「请求次数」类断言依赖执行顺序。
//   - ⚠️ `mockResolvedValue`（持久）而非 `Once`：useQuery 在 setup 时会自动首调。
//
// api 层整模块桩掉（`@/api/parts`）：本文件要断言的正是「发了什么请求 / 发了几次」与
// 「失效键是哪几条」，真 axios 会让这些都变成时序赌博。api 自身的 URL / body 契约由
// `src/api/parts/__tests__/` 下的 spec 守。
// `element-plus` 也桩掉（node env 下真 ElMessage 会因 `document is not defined` 污染输出）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

const h = vi.hoisted(() => ({
  getPart: vi.fn(),
  listPartEvents: vi.fn(),
}));

vi.mock('@/api/parts', () => ({
  getPart: h.getPart,
  listPartEvents: h.listPartEvents,
}));

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { qk } from '@/composables/queries/keys';
import { usePartDetailQuery } from '@/views/parts/detail/composables/usePartDetailQuery';
import { usePartEventsQuery } from '@/views/parts/detail/composables/usePartEventsQuery';

const PART_A = '219276974948876288';
const PART_B = '219276974948876289';

/** 一行合法的 `PartDetailOut`（28 字段，与 partDetailSchema.spec.ts 的 fixture 同源）。 */
function validDetail(id: string) {
  return {
    id,
    serial_no: 'F1889-01',
    name: '子零件',
    drawing_no: 'DWG-1889',
    applicant_name: '张工',
    quantity: 5,
    request_date: '2026-10-01',
    planned_delivery_date: '2026-10-20',
    customer_id: '9000000000001',
    assembly_id: null,
    status: 'IN_PROCESS',
    is_urgent: true,
    next_process_id: null,
    order_no: 'SO-6200037950',
    system_delivery_date: null,
    note: null,
    unit_price: '12.50',
    total_price: '62.50',
    version: 3,
    created_at: '2026-10-01 09:00:00',
    created_by: null,
    updated_at: '2026-10-02 10:00:00',
    updated_by: '9000000000002',
    deleted_at: null,
    process_chain_id: '9000000000010',
    customer_name: '二级客户',
    l1_customer_name: '一级客户',
    current_batch_id: null,
  };
}

/** 一行合法的 `PartEventOut`（15 字段；`batch_no` 是**裸 number**）。 */
function validEvent(id: string) {
  return {
    id,
    event_type: 'INSPECTED',
    from_status: 'INSPECTION',
    to_status: 'READY_TO_SHIP',
    batch_id: '3000000000002',
    batch_no: 3,
    quantity: 5,
    drawing_code: null,
    badge_code: 'B-001',
    note: null,
    created_at: '2026-10-03 11:00:00',
    created_by: '9000000000002',
    worker_name: '李四',
    operator_name: '王五',
    operator_username: 'wangwu',
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

beforeEach(() => {
  h.getPart.mockReset().mockResolvedValue(validDetail(PART_A));
  h.listPartEvents.mockReset().mockResolvedValue([validEvent('3000000000001')]);
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

afterEach(() => {
  testQueryClient.unmount();
  testApp = null as unknown as ReturnType<typeof createApp>;
  testQueryClient = null as unknown as QueryClient;
  vi.restoreAllMocks();
});

describe('Q 组：详情 / 事件两条 query hook', () => {
  it('Q1：queryKey 形状是独立根命名（不挂 qk.partsPrefix 下）', async () => {
    expect(qk.partDetail(PART_A)).toEqual(['part-detail', PART_A]);
    expect(qk.partDetailPrefix).toEqual(['part-detail']);
    expect(qk.partEvents(PART_A)).toEqual(['part-events', PART_A]);
    expect(qk.partEventsPrefix).toEqual(['part-events']);
    // 挂 parts 下会让全仓最热的零件域一把全刷把详情缓存连带重拉；挂批次列表下会让
    // 「拆批 / 取消批次」把零件主数据也拖着重拉。
    expect(qk.partDetailPrefix).not.toEqual(qk.partsPrefix);
    expect(qk.partDetailPrefix).not.toEqual(qk.partBatchesPrefix);

    const scope = effectScope();
    let q: ReturnType<typeof usePartDetailQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartDetailQuery(() => PART_A));
    });
    await q!.fetchDetail();
    expect(
      testQueryClient
        .getQueryCache()
        .getAll()
        .map((x) => x.queryKey),
    ).toContainEqual(['part-detail', PART_A]);
    scope.stop();
  });

  // 批次键复用既有定义，不新造：两个消费方（dashboard PartPreviewDialog / 本页）共用一条
  // 键才能同屏去重、失效链也只有一条。
  it('Q1b：批次键复用既有的 qk.partBatchesList / partBatchesPrefix（本轮未新造）', () => {
    expect(qk.partBatchesList(PART_A)).toEqual(['part-batches', 'list', PART_A]);
    expect(qk.partBatchesPrefix).toEqual(['part-batches']);
    expect(Object.keys(qk).filter((k) => k.startsWith('partBatches'))).toEqual([
      'partBatchesList',
      'partBatchesPrefix',
    ]);
  });

  it('Q2：queryFn 从 queryKey 读 id —— 换 partId 后 refetch 带新值（不闭包捕获 stale）', async () => {
    const scope = effectScope();
    const partId: Ref<string> = ref(PART_A);
    let q: ReturnType<typeof usePartDetailQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartDetailQuery(() => partId.value));
    });
    await q!.fetchDetail();
    expect(h.getPart.mock.calls[0]![0]).toBe(PART_A);

    partId.value = PART_B;
    await q!.fetchDetail();
    expect(h.getPart).toHaveBeenCalledTimes(2);
    expect(h.getPart.mock.calls[1]![0]).toBe(PART_B);
    scope.stop();
  });

  it('Q3a：partId 为 null ⇒ 零请求（enabled 闸门 + queryFn 二次守卫）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof usePartDetailQuery> | undefined;
    let ev: ReturnType<typeof usePartEventsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartDetailQuery(() => null));
      ev = testApp.runWithContext(() => usePartEventsQuery(() => null));
    });
    await Promise.all([q!.fetchDetail(), ev!.fetchEvents()]);

    expect(h.getPart).not.toHaveBeenCalled();
    expect(h.listPartEvents).not.toHaveBeenCalled();
    expect(q!.query.data.value).toBeUndefined();
    scope.stop();
  });

  // keep-alive 下 `useRoute()` 跟的是全局 currentRoute：不闸门的话切到别的页面时
  // reactive queryKey 会跟着变、自动去拉「别的页面的零件」——比 404 更坏，那个 id 若恰好
  // 有效，本页会静默渲染成另一个工单。
  // ⚠️ 这里断言的是「**自动**取数路径被闸住」，不是「显式 refetch 也被拦」：
  // TanStack 的 `refetch()` 无视 `enabled`（query-core 的 `QueryObserver.fetch` 不查
  // `enabled`），所以「显式 refetch」这条路靠的是 queryFn 的**二次守卫**（Q3a 那条，
  // partId 为空时不发请求），不是 enabled。页面切走后也不会有人调 refetch —— 闸门治的是
  // queryKey 变化自动触发的取数。
  it('Q3b：isActive=false ⇒ 零自动请求；翻 true 后恢复取数', async () => {
    const scope = effectScope();
    const isActive = ref(false);
    let q: ReturnType<typeof usePartDetailQuery> | undefined;
    let ev: ReturnType<typeof usePartEventsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartDetailQuery(() => PART_A, isActive));
      ev = testApp.runWithContext(() => usePartEventsQuery(() => PART_A, isActive));
    });
    // 空跑几拍：enabled=false 时 observer 不该发起首调。
    await new Promise((r) => setTimeout(r, 10));
    expect(h.getPart).not.toHaveBeenCalled();
    expect(h.listPartEvents).not.toHaveBeenCalled();
    expect(q!.query.data.value).toBeUndefined();
    expect(ev!.query.data.value).toBeUndefined();

    isActive.value = true;
    await new Promise((r) => setTimeout(r, 10));
    expect(h.getPart).toHaveBeenCalledTimes(1);
    expect(h.listPartEvents).toHaveBeenCalledTimes(1);
    expect(h.getPart.mock.calls[0]![0]).toBe(PART_A);
    scope.stop();
  });

  it('Q3c：partId 为空时 queryFn 的二次守卫拦下「显式 refetch」这条不受 enabled 保护的路', async () => {
    // TanStack 的 `refetch()` 不查 `enabled`，空 partId 时那条路能进 queryFn ——
    // 没有二次守卫就会打一个 `/parts/undefined` 请求（404 + 一句看不懂的错误）。
    const scope = effectScope();
    let q: ReturnType<typeof usePartDetailQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartDetailQuery(() => ''));
    });
    await q!.fetchDetail();
    expect(h.getPart).not.toHaveBeenCalled();
    scope.stop();
  });

  // 把 queryFn 里的 `.parse()` 整段删掉时，Q1~Q3 全绿而线上崩 ——
  // 守门被拆掉而测试无感。这条是那个失败模式的唯一守卫。
  it('Q4：Zod 守门在 queryFn 上 —— 坏响应 ⇒ data undefined + isError', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scope = effectScope();

    // (a) `.strict()` —— 多一个键就炸（后端加字段 / 前端字段名写错）
    h.getPart.mockReset().mockResolvedValue({ ...validDetail(PART_A), ghost_field: 1 });
    let extra: ReturnType<typeof usePartDetailQuery> | undefined;
    scope.run(() => {
      extra = testApp.runWithContext(() => usePartDetailQuery(() => PART_A));
    });
    await extra!.fetchDetail();
    expect(extra!.query.data.value, '多一个键必须被 .strict() 拒掉').toBeUndefined();
    expect(extra!.query.error.value).toBeTruthy();

    // (b) 缺必填键 —— Zod strip 会静默丢字段，声明不出来就永远显示空
    const missing = validDetail(PART_A) as Record<string, unknown>;
    delete missing.version;
    h.getPart.mockReset().mockResolvedValue(missing);
    let hole: ReturnType<typeof usePartDetailQuery> | undefined;
    scope.run(() => {
      hole = testApp.runWithContext(() => usePartDetailQuery(() => PART_A));
    });
    await hole!.fetchDetail();
    expect(hole!.query.data.value, '缺 version 必须被拒掉').toBeUndefined();
    expect(hole!.query.error.value).toBeTruthy();

    // (c) events 端点出参是裸数组；套一层 {items,total} 说明契约漂了
    h.listPartEvents.mockReset().mockResolvedValue({ items: [validEvent('1')], total: 1 });
    let enveloped: ReturnType<typeof usePartEventsQuery> | undefined;
    scope.run(() => {
      enveloped = testApp.runWithContext(() => usePartEventsQuery(() => PART_A));
    });
    await enveloped!.fetchEvents();
    expect(enveloped!.query.data.value, 'events 出参是裸数组，信封形态必须被拒').toBeUndefined();
    expect(enveloped!.query.error.value).toBeTruthy();

    // 正向对照：合法响应放行（证明上面几条不是恒真断言）
    h.getPart.mockReset().mockResolvedValue(validDetail(PART_A));
    h.listPartEvents.mockReset().mockResolvedValue([validEvent('3000000000001')]);
    let ok: ReturnType<typeof usePartDetailQuery> | undefined;
    let okE: ReturnType<typeof usePartEventsQuery> | undefined;
    scope.run(() => {
      ok = testApp.runWithContext(() => usePartDetailQuery(() => PART_A));
      okE = testApp.runWithContext(() => usePartEventsQuery(() => PART_A));
    });
    await Promise.all([ok!.fetchDetail(), okE!.fetchEvents()]);
    expect(ok!.query.data.value?.id).toBe(PART_A);
    expect(ok!.query.error.value).toBeFalsy();
    expect(okE!.query.data.value).toHaveLength(1);
    expect(okE!.query.error.value).toBeFalsy();
    consoleError.mockRestore();
    scope.stop();
  });

  it('Q5：fetchDetail / fetchEvents 别名能驱动 refetch', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof usePartDetailQuery> | undefined;
    let e: ReturnType<typeof usePartEventsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartDetailQuery(() => PART_A));
      e = testApp.runWithContext(() => usePartEventsQuery(() => PART_A));
    });
    // 先等首调 settle（useQuery 在 setup 时自动首调），否则 refetch 会把在飞的那次
    // 取消掉重新发起，请求次数的断言就变成时序赌博。
    await new Promise((r) => setTimeout(r, 10));
    expect(h.getPart).toHaveBeenCalledTimes(1);
    expect(h.listPartEvents).toHaveBeenCalledTimes(1);

    await q!.fetchDetail();
    expect(h.getPart).toHaveBeenCalledTimes(2);
    expect(q!.query.data.value?.id).toBe(PART_A);
    await e!.fetchEvents();
    expect(h.listPartEvents).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('Q6：query error 桥接到 ElMessage.error', async () => {
    const { ElMessage } = await import('element-plus');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getPart.mockReset().mockRejectedValue(new Error('网络断了'));
    const scope = effectScope();
    let q: ReturnType<typeof usePartDetailQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartDetailQuery(() => PART_A));
    });
    await q!.fetchDetail();
    // watch 是 post-flush 的，等一拍让回调落地。
    await new Promise((r) => setTimeout(r, 0));
    expect(ElMessage.error).toHaveBeenCalledWith('网络断了');
    expect(q!.error.value).toBeTruthy();
    consoleError.mockRestore();
    scope.stop();
  });

  it('Q7：events 裸数组 + batch_no 保持 number（i32 不是雪花 ID 字符串）', async () => {
    const scope = effectScope();
    let e: ReturnType<typeof usePartEventsQuery> | undefined;
    scope.run(() => {
      e = testApp.runWithContext(() => usePartEventsQuery(() => PART_A));
    });
    await e!.fetchEvents();
    const rows = e!.query.data.value ?? [];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]!.batch_no).toBe(3);
    expect(typeof rows[0]!.batch_no).toBe('number');

    // 发字符串必炸：后端 `batch_no` 是 i32 ⇒ 裸 JSON number。
    h.listPartEvents
      .mockReset()
      .mockResolvedValue([{ ...validEvent('3000000000009'), batch_no: '3' }]);
    let strNo: ReturnType<typeof usePartEventsQuery> | undefined;
    scope.run(() => {
      strNo = testApp.runWithContext(() => usePartEventsQuery(() => PART_B));
    });
    await strNo!.fetchEvents();
    expect(strNo!.query.data.value, 'batch_no 发字符串必须被拒').toBeUndefined();
    scope.stop();
  });
});
