// src/views/production/scan/composables/__tests__/useScanQuery.spec.ts
//
// 报工台两条 list 的 query hook（`useScanPickableQuery` / `useScanHeldQuery`）与四条写
// mutation（pick-up / worker-scan / take-over / outsource-receive）的回归保护。
//
// 覆盖四件事，任何一件被后人改坏都会红：
//   Q1 **同键去重**（本轮接入的核心收益）：两个 hook 实例传同一组 params ⇒ 底层
//      fetchScanHeld 只被调 **1 次**。此前徽章与放回页 / 送检页各自发一次同参请求，
//      同屏对同一个工人发 2 次；这条把「共用一条 query key」钉成可执行断言。
//   Q2 **enabled 闸门**：params 为 null（未扫工牌 / 无工种）时**零请求**。这不是优化 ——
//      两条端点的过滤键后端走 `deserialize_i64` 且必填，漏传会被 axum `QueryRejection`
//      拒成 HTTP 400 纯文本（不进业务信封）。
//   Q3 **reactive params 不被 snapshot**：换 workerId / workTypeId 后 refetch 必须带新值
//      （queryFn 从 queryKey 读 params，不闭包捕获 stale 值）。
//   Q4 **Zod 守门在 queryFn 上**：坏响应（裸数组 / 空行）→ data 为 undefined、isError
//      为 true。把 queryFn 里的 `.parse()` 整段删掉时 Q2 / Q3 仍绿而线上三页崩 —— 这条
//      就是那个失败模式的守卫。
//   W1 **失效链**：四条写路径（pick-up / worker-scan / take-over / outsource-receive）的
//      `onSuccess` **与 `onError`** 都失效 `qk.scanPickablePrefix` + `qk.scanHeldPrefix` +
//      `qk.scanLocatePrefix` 三条前缀（8 条路径逐条有用例，少一条就有一处失效函数可以
//      被换回只失效两条 list 而全绿）。少失效 list 那两条会留下半截陈旧列表（取件后
//      候选列表里还留着刚领走的卡 / 放回后徽章少算一件）；少失效 `scanLocatePrefix`
//      那一条，扫码找件诊断弹窗在 30s 内重扫同一条码时会渲染写之前的旧行（stale
//      `action` + stale `version`）。
//
// 测试手法与 `composables/queries/__tests__/useWorkTypesQuery.spec.ts` 同款，三个坑照抄：
//   - ⚠️ **必须用 `app.runWithContext`**：vue-query 的 `useQueryClient()` 走 Vue `inject()`，
//     node env 下 currentApp 为 null 时 inject 直接抛。该 app 不挂组件，仅作 provide channel。
//   - ⚠️ 每个用例一份新 QueryClient：缓存跨用例残留会让「请求次数」类断言依赖执行顺序。
//   - ⚠️ `mockResolvedValue`（持久）而非 `Once`：useQuery 在 setup 时会自动首调，紧接的
//     refetch 是第二调，两次都要命中 mock。
//
// api 层整模块桩掉（`/api/productionScan`）：本文件要断言的正是「query 只发一次请求」与
// 「失效键是哪三条」，真 axios 会让这两条都变成时序赌博。api 层自身的 URL / query / body
// 契约由 `src/api/__tests__/productionScan.contract.spec.ts` 守。
// `element-plus` 也桩掉（node env 下真 ElMessage 会因 `document is not defined` 污染输出）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

const h = vi.hoisted(() => ({
  fetchScanHeld: vi.fn(),
  fetchScanPickable: vi.fn(),
  pickUpBatch: vi.fn(),
  receiveFromOutsource: vi.fn(),
  scanWorker: vi.fn(),
  takeOverBatch: vi.fn(),
}));

vi.mock('@/api/productionScan', () => ({
  fetchScanHeld: h.fetchScanHeld,
  fetchScanPickable: h.fetchScanPickable,
  pickUpBatch: h.pickUpBatch,
  receiveFromOutsource: h.receiveFromOutsource,
  scanWorker: h.scanWorker,
  takeOverBatch: h.takeOverBatch,
}));

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { qk } from '@/composables/queries/keys';
import {
  useScanHeldQuery,
  useScanPickableQuery,
} from '@/views/production/scan/composables/useScanListQuery';
import {
  useScanOutsourceReceiveMutation,
  useScanPickUpMutation,
  useScanTakeOverMutation,
  useScanWorkerScanMutation,
} from '@/views/production/scan/composables/useScanWrite';

const WORKER_A = '190000000000001';
const WORKER_B = '190000000000002';
const WORK_TYPE = '190000000000003';

/** 一行合法的 `ScanListItem`（17 字段）。 */
function validRow(id: string) {
  return {
    id,
    serial_no: `SN-${id}`,
    name: '零件',
    drawing_no: 'DWG-1',
    quantity: 1,
    is_urgent: false,
    planned_delivery_date: '2026-10-20',
    system_delivery_date: null,
    process_chain_id: null,
    has_process_chain: false,
    chain_state: 'NONE',
    chain_next_process_id: '0',
    chain_next_process_name: null,
    chain_current_process_name: null,
    batch_id: `19000000000001${id}`,
    batch_version: 1,
    location: null,
  };
}

function envelope(ids: string[]) {
  return { items: ids.map(validRow), total: ids.length, limit: 200, offset: 0 };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

beforeEach(() => {
  h.fetchScanHeld.mockReset().mockResolvedValue(envelope([WORKER_A]));
  h.fetchScanPickable.mockReset().mockResolvedValue(envelope([WORKER_A]));
  h.pickUpBatch.mockReset().mockResolvedValue({});
  h.receiveFromOutsource.mockReset().mockResolvedValue({ batch_id: '190000000000111', version: 8 });
  h.takeOverBatch.mockReset().mockResolvedValue({ batch_id: '190000000000111', version: 8 });
  h.scanWorker.mockReset().mockResolvedValue({
    scan: {
      worker_id: WORKER_A,
      part_id: WORKER_A,
      batch_id: WORKER_A,
      event_type: 'WORKER_SCAN_RETURNED',
      synced_assembly_id: null,
    },
    refill: { worker_id: WORKER_A, shelf_id: '190000000000009', taken: [], pool_empty: true },
  });
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

describe('Q 组：useScanHeldQuery / useScanPickableQuery', () => {
  // ⭐ 本轮接入的核心收益。此前徽章与放回页 / 送检页各自调 fetchScanHeld(workerId,
  // { limit: 200 })，同一屏对同一个工人发 **2 次完全同参的请求**，且切页零缓存。
  it('Q1：两个 hook 实例传同一组 params ⇒ 底层只发 1 次请求（徽章与页面共用一条 query key）', async () => {
    const scope = effectScope();
    const params = () => ({ workerId: WORKER_A, limit: 200 });
    const observers: Array<ReturnType<typeof useScanHeldQuery>> = [];
    scope.run(() => {
      // 两个独立实例 = 报工台「页面列表 + HeldPartsBadge 徽章」的真实形态
      observers.push(testApp.runWithContext(() => useScanHeldQuery(params)));
      observers.push(testApp.runWithContext(() => useScanHeldQuery(params)));
    });
    await observers[0]!.fetchList();

    expect(h.fetchScanHeld).toHaveBeenCalledTimes(1);
    // 两个 observer 读到的是同一份数据（同键 ⇒ 同一 cache entry）
    expect(observers[0]!.query.data.value?.items).toHaveLength(1);
    expect(observers[1]!.query.data.value?.items).toHaveLength(1);
    scope.stop();
  });

  it('Q1b：换一个 workerId ⇒ 换一份 cache identity，第二次发请求（不拿上一个工人的持有件冒充）', async () => {
    const scope = effectScope();
    const workerId: Ref<string> = ref(WORKER_A);
    let q: ReturnType<typeof useScanHeldQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useScanHeldQuery(() => ({ workerId: workerId.value, limit: 200 })),
      );
    });
    await q!.fetchList();
    expect(h.fetchScanHeld).toHaveBeenCalledTimes(1);
    expect(h.fetchScanHeld.mock.calls[0]![0]).toEqual({ workerId: WORKER_A, limit: 200 });

    workerId.value = WORKER_B;
    await q!.fetchList();
    expect(h.fetchScanHeld).toHaveBeenCalledTimes(2);
    expect(h.fetchScanHeld.mock.calls[1]![0]).toEqual({ workerId: WORKER_B, limit: 200 });
    scope.stop();
  });

  // ⚠️ 闸门是必需的而非优化：两条端点的过滤键后端走 deserialize_i64 且必填，漏传会被
  // axum QueryRejection 拒成 **HTTP 400 纯文本**（不进 R<T> 信封）。
  it('Q2：params 为 null（未扫工牌 / 无工种）⇒ 零请求（enabled 闸门 + queryFn 二次守卫）', async () => {
    const scope = effectScope();
    const picks: Array<ReturnType<typeof useScanPickableQuery>> = [];
    const helds: Array<ReturnType<typeof useScanHeldQuery>> = [];
    scope.run(() => {
      picks.push(testApp.runWithContext(() => useScanPickableQuery(() => null)));
      helds.push(testApp.runWithContext(() => useScanHeldQuery(() => null)));
    });
    await Promise.all([picks[0]!.fetchList(), helds[0]!.fetchList()]);

    expect(h.fetchScanPickable).not.toHaveBeenCalled();
    expect(h.fetchScanHeld).not.toHaveBeenCalled();
    expect(picks[0]!.query.data.value).toBeUndefined();
    scope.stop();
  });

  it('Q3：reactive params 不被 snapshot —— getter 换 workTypeId 后 refetch 带新值', async () => {
    const scope = effectScope();
    const workTypeId = ref(WORK_TYPE);
    let q: ReturnType<typeof useScanPickableQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useScanPickableQuery(() => ({ workTypeId: workTypeId.value, limit: 200 })),
      );
    });
    await q!.fetchList();
    expect(h.fetchScanPickable.mock.calls[0]![0]).toEqual({ workTypeId: WORK_TYPE, limit: 200 });

    workTypeId.value = '190000000000009';
    await q!.fetchList();
    expect(h.fetchScanPickable).toHaveBeenCalledTimes(2);
    expect(h.fetchScanPickable.mock.calls[1]![0]).toEqual({
      workTypeId: '190000000000009',
      limit: 200,
    });
    scope.stop();
  });

  // 把 queryFn 里的 `.parse()` 整段删掉时，Q1 / Q2 / Q3 全绿而线上三页崩 ——
  // 守门被拆掉而测试无感。这条是那个失败模式的唯一守卫。
  it('Q4：Zod 守门在 queryFn 上 —— 坏响应（裸数组 / 空行）⇒ data undefined + isError', async () => {
    const scope = effectScope();
    // 契约漂移时 scanListErrorText 会 console.error 打完整 issues（设计如此：人话给工人、
    // 细节给 console）。这里桩掉免得单测输出里堆一屏 Zod 噪音。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    h.fetchScanHeld.mockReset().mockResolvedValue([validRow(WORKER_A)]);
    let bare: ReturnType<typeof useScanHeldQuery> | undefined;
    scope.run(() => {
      bare = testApp.runWithContext(() =>
        useScanHeldQuery(() => ({ workerId: WORKER_A, limit: 200 })),
      );
    });
    await bare!.fetchList();
    expect(bare!.query.data.value, '裸数组必须被守门拒掉').toBeUndefined();
    expect(bare!.query.error.value).toBeTruthy();

    h.fetchScanHeld.mockReset().mockResolvedValue({ items: [{}], total: 1, limit: 200, offset: 0 });
    let emptyRow: ReturnType<typeof useScanHeldQuery> | undefined;
    scope.run(() => {
      emptyRow = testApp.runWithContext(() =>
        useScanHeldQuery(() => ({ workerId: WORKER_B, limit: 200 })),
      );
    });
    await emptyRow!.fetchList();
    expect(emptyRow!.query.data.value, '空行必须被守门拒掉').toBeUndefined();
    expect(emptyRow!.query.error.value).toBeTruthy();

    // 正向对照：合法信封放行（证明上面两条不是恒真断言）
    h.fetchScanHeld.mockReset().mockResolvedValue(envelope([WORKER_A]));
    let ok: ReturnType<typeof useScanHeldQuery> | undefined;
    scope.run(() => {
      ok = testApp.runWithContext(() =>
        useScanHeldQuery(() => ({ workerId: WORKER_A, limit: 200 })),
      );
    });
    await ok!.fetchList();
    expect(ok!.query.data.value?.items).toHaveLength(1);
    expect(ok!.query.error.value).toBeFalsy();
    consoleError.mockRestore();
    scope.stop();
  });

  // 后端多发那 23 个已砍的键（灰度期新旧后端并存）必须被 strip 且不抛错。
  // 键清单与 scanSchema.ts 的模块注释、contract spec 的 E8 同源；覆盖全部 23 个，
  // 少列一个就让「23 个键被 strip」这条守卫在该键上失守。
  it('Q5：后端多发 23 个已砍键 ⇒ parse 通过且结果仍是 17 个键（灰度期不炸）', async () => {
    const scope = effectScope();
    h.fetchScanHeld.mockReset().mockResolvedValue({
      items: [
        {
          ...validRow(WORKER_A),
          applicant_name: '',
          request_date: '1970-01-01',
          customer_id: '0',
          assembly_id: null,
          status: 'IN_PROCESS',
          order_no: null,
          note: null,
          unit_price: '0',
          total_price: '0',
          version: 0,
          created_at: '1970-01-01T00:00:00',
          created_by: null,
          updated_at: '1970-01-01T00:00:00',
          updated_by: null,
          deleted_at: null,
          customer_name: null,
          l1_customer_name: null,
          holder_name: null,
          row_type: 'PART',
          has_children: false,
          child_count: null,
          has_cnc_program: false,
          delivered_quantity: 0,
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    });
    let q: ReturnType<typeof useScanHeldQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useScanHeldQuery(() => ({ workerId: WORKER_A, limit: 200 })),
      );
    });
    await q!.fetchList();
    expect(q!.query.error.value).toBeFalsy();
    expect(Object.keys(q!.query.data.value!.items[0]!)).toHaveLength(17);
    scope.stop();
  });
});

describe('W 组：写 mutation 的失效链', () => {
  // 2026-10-15：失效链从两条前缀扩到三条 —— 扫码找件诊断（`qk.scanLocatePrefix`）也
  // 失效。四条写路径都会改诊断结果的字段（`action` / `disabled_reason` /
  // `chain_state` / `next_process_id` / `version`），而它 `staleTime` 30s ⇒ 少这一条就是
  // 「关窗 → 重扫同一条码 → 渲染写之前的旧行」，工人点下去必吃 `40901`。
  it('W1：pick-up 成功后失效 scanPickablePrefix + scanHeldPrefix + scanLocatePrefix 三条', async () => {
    const keys: unknown[][] = [];
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries').mockImplementation((q?: unknown) => {
      keys.push((q as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    });

    const scope = effectScope();
    let m: ReturnType<typeof useScanPickUpMutation> | undefined;
    scope.run(() => {
      m = testApp.runWithContext(() => useScanPickUpMutation());
    });
    await m!.mutateAsync({
      batchId: '190000000000111',
      version: 7,
      workerId: WORKER_A,
      quantity: '4',
    });

    expect(keys).toEqual([qk.scanPickablePrefix, qk.scanHeldPrefix, qk.scanLocatePrefix]);
    // 正向对照：mutationFn 真的把 payload 组装成了 ScanPickUpRequest 的形态
    expect(h.pickUpBatch).toHaveBeenCalledWith('190000000000111', {
      version: 7,
      worker_id: WORKER_A,
      quantity: '4',
      note: null,
    });
    spy.mockRestore();
    scope.stop();
  });

  // worker-scan（放回 / 送检）顺链推进同样改诊断的 `chain_state` / `next_process_id`，
  // 故它也走三条前缀。
  it('W1b：worker-scan 成功后同样失效三条前缀', async () => {
    const keys: unknown[][] = [];
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries').mockImplementation((q?: unknown) => {
      keys.push((q as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    });

    const scope = effectScope();
    let m: ReturnType<typeof useScanWorkerScanMutation> | undefined;
    scope.run(() => {
      m = testApp.runWithContext(() => useScanWorkerScanMutation());
    });
    const res = await m!.mutateAsync({
      serial_no: 'SN-1',
      badge_code: 'W-001',
      event_type: 'RETURNED',
      next_process_id: '190000000000021',
      batch_id: '190000000000111',
      // 2026-10-11：worker-scan 新增可选 quantity（放回 / 送检指定数量）。
      // **必须发 JSON 字符串** —— 后端 deserialize_i64_opt 只解 str，发 number 是
      // 422 纯文本；mutation 不做守门也不加工（原样透传给 api 层），所以这层
      // 断言的是「payload 原样到达 api」。
      quantity: '3',
    });
    // 响应原样交给调用方（放回页按 res.scan.event_type 分成功文案）
    expect(res.scan.event_type).toBe('WORKER_SCAN_RETURNED');
    expect(h.scanWorker.mock.calls[0]![0]).toMatchObject({ quantity: '3' });
    expect(keys).toEqual([qk.scanPickablePrefix, qk.scanHeldPrefix, qk.scanLocatePrefix]);
    spy.mockRestore();
    scope.stop();
  });

  // 失败也必须失效：40901（OCC 版本冲突）恰恰意味着**别人已经把这批处置了**，
  // 本端副本已过期；只在 onSuccess 失效的话，工人盯着一条作废的列表继续操作。
  it('W2：两条 mutation 在 onError 时同样走全套失效（不只是 onSuccess）', async () => {
    const keys: unknown[][] = [];
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries').mockImplementation((q?: unknown) => {
      keys.push((q as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    });

    const scope = effectScope();
    let pick: ReturnType<typeof useScanPickUpMutation> | undefined;
    let scan: ReturnType<typeof useScanWorkerScanMutation> | undefined;
    scope.run(() => {
      pick = testApp.runWithContext(() => useScanPickUpMutation());
      scan = testApp.runWithContext(() => useScanWorkerScanMutation());
    });

    h.pickUpBatch.mockReset().mockRejectedValue(new Error('40901 版本冲突'));
    await expect(
      pick!.mutateAsync({ batchId: '190000000000111', version: 7, workerId: WORKER_A }),
    ).rejects.toThrow('40901');
    expect(keys).toEqual([qk.scanPickablePrefix, qk.scanHeldPrefix, qk.scanLocatePrefix]);

    keys.length = 0;
    h.scanWorker.mockReset().mockRejectedValue(new Error('20103 状态不允许'));
    await expect(
      scan!.mutateAsync({ serial_no: 'SN-1', badge_code: 'W-001', event_type: 'INSPECTED' }),
    ).rejects.toThrow('20103');
    expect(keys).toEqual([qk.scanPickablePrefix, qk.scanHeldPrefix, qk.scanLocatePrefix]);

    spy.mockRestore();
    scope.stop();
  });

  // ⭐ 扫码接管成功后**必须**失效 `qk.scanLocatePrefix`。
  //
  // 守的是这一条真实故障链：接管成功 → 诊断弹窗关掉 → 工人 30s 内重扫同一工单的另一个
  // 批次（该 part 仍有别的批次不在他的列表里 ⇒ 又是 0 匹配）→ 弹窗挂载时 queryKey 与上次
  // 完全相同、`staleTime: 30_000` 内算「新鲜」⇒ 不发请求、直接渲染接管前的旧行（仍显示
  // 旧持有人 + 「接管」按钮 + 旧 `version`）⇒ 点下去必吃 `40901`。
  // 只断言 keys 里出现该前缀即可：失效的具体形态（mark stale / 立即 refetch）由
  // TanStack 自己管，前端只负责「调了 invalidateQueries 且键是这一条」。
  it('W3：take-over 成功后失效扫码找件诊断前缀（不失效则重扫同一条码命中写前的诊断）', async () => {
    const keys: unknown[][] = [];
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries').mockImplementation((q?: unknown) => {
      keys.push((q as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    });

    const scope = effectScope();
    let m: ReturnType<typeof useScanTakeOverMutation> | undefined;
    scope.run(() => {
      m = testApp.runWithContext(() => useScanTakeOverMutation());
    });
    await m!.mutateAsync({
      batchId: '190000000000111',
      badgeCode: 'W-001',
      version: 7,
      nextProcessId: null,
    });

    expect(keys).toContainEqual(qk.scanLocatePrefix);
    expect(
      qk.scanLocatePrefix,
      '诊断前缀必须是 pickable / held 的同级前缀，否则写路径的失效匹配不上诊断键',
    ).toEqual(['production-scan', 'locate']);
    spy.mockRestore();
    scope.stop();
  });

  // ⚠️ W4 / W5 / W6 存在的理由：W 组原先只覆盖四条写路径里的 5/8 条（两条 list mutation 的
  // onSuccess+onError、take-over 的 onSuccess），`useScanOutsourceReceiveMutation` 的
  // onSuccess 与 onError **零用例**、take-over 的 onError 也没有。少它们的后果很具体：
  // 把任一 mutation 的失效函数换回只失效两条 list 的 `invalidateScanLists`，收回的成败
  // 两条路径照样全绿 —— 而外协收回正是「把批次从外协公司挪到工人手上」的动作，诊断行的
  // `action`（`RECEIVE_FROM_OUTSOURCE` → 无动作 / `MINE`）与列表行集都变了，不失效诊断前缀
  // 就是「关窗 → 重扫同一条码 → 渲染写之前的旧行 + 旧 version」。
  it('W4：外协收回成功后失效三条前缀（含诊断前缀）', async () => {
    const keys: unknown[][] = [];
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries').mockImplementation((q?: unknown) => {
      keys.push((q as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    });

    const scope = effectScope();
    let m: ReturnType<typeof useScanOutsourceReceiveMutation> | undefined;
    scope.run(() => {
      m = testApp.runWithContext(() => useScanOutsourceReceiveMutation());
    });
    await m!.mutateAsync({
      batchId: '190000000000111',
      badgeCode: 'W-001',
      version: 7,
      // chain_state === 'NEXT' 时也必须原样回传诊断行的 next_process_id（写侧缺省推导
      // 口径与读侧在稀疏链上不等价），收回归属整批动作、无 quantity / note。
      nextProcessId: '190000000000777',
    });

    expect(keys).toEqual([qk.scanPickablePrefix, qk.scanHeldPrefix, qk.scanLocatePrefix]);
    const [batchId, body] = h.receiveFromOutsource.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(batchId).toBe('190000000000111');
    expect(body.next_process_id).toBe('190000000000777');
    spy.mockRestore();
    scope.stop();
  });

  it('W5：外协收回失败时同样走全套失效（失败码 20103 / 20706 意味着服务端那份数据已变）', async () => {
    const keys: unknown[][] = [];
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries').mockImplementation((q?: unknown) => {
      keys.push((q as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    });

    const scope = effectScope();
    let m: ReturnType<typeof useScanOutsourceReceiveMutation> | undefined;
    scope.run(() => {
      m = testApp.runWithContext(() => useScanOutsourceReceiveMutation());
    });
    h.receiveFromOutsource.mockReset().mockRejectedValue(new Error('20103 状态迁移非法'));
    await expect(
      m!.mutateAsync({ batchId: '190000000000111', badgeCode: 'W-001', version: 7 }),
    ).rejects.toThrow('20103');

    expect(keys).toEqual([qk.scanPickablePrefix, qk.scanHeldPrefix, qk.scanLocatePrefix]);
    spy.mockRestore();
    scope.stop();
  });

  it('W6：接管失败时同样走全套失效（40901 意味着别人已把这批处置了）', async () => {
    const keys: unknown[][] = [];
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries').mockImplementation((q?: unknown) => {
      keys.push((q as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    });

    const scope = effectScope();
    let m: ReturnType<typeof useScanTakeOverMutation> | undefined;
    scope.run(() => {
      m = testApp.runWithContext(() => useScanTakeOverMutation());
    });
    h.takeOverBatch.mockReset().mockRejectedValue(new Error('40901 版本冲突'));
    await expect(
      m!.mutateAsync({ batchId: '190000000000111', badgeCode: 'W-001', version: 7 }),
    ).rejects.toThrow('40901');

    expect(keys).toEqual([qk.scanPickablePrefix, qk.scanHeldPrefix, qk.scanLocatePrefix]);
    spy.mockRestore();
    scope.stop();
  });
});
