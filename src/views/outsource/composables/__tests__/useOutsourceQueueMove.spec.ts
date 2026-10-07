// src/views/outsource/composables/__tests__/useOutsourceQueueMove.spec.ts
//
// 外协看板「发送 / 回收」写操作 composable 行为 spec。
//
// 后端契约：`POST /api/v2/outsource-queue/move`，收发合一的单端点，三个方向
// （PRODUCTION_SHELF→OUTSOURCE_COMPANY / OUTSOURCE_COMPANY→PRODUCTION_SHELF /
// OUTSOURCE_COMPANY→INSPECTION_SHELF）。两条最容易踩的：
//   - `version` 必填（serde 无 `#[serde(default)]` ⇒ 缺字段返 HTTP 422 **纯文本**，
//     不是业务信封，错误文案对用户毫无意义）；
//   - `quote_id` 与 `direct` 必传其一，都不传或同时传 → 20104。
//
// 覆盖：
//   - M1：APPROVAL 发送成功 → quote_id + direct=null、from/to 形态逐字正确 + 两域前缀
//     失效 + 成功 toast。
//   - M2：DIRECT 发送成功 → direct=true + quote_id=null，且目标公司须命中
//     company_options。
//   - M3：APPROVAL 行传了报价锁定之外的公司 → 早退、不发请求。
//   - M4：DIRECT 行 company_options 为空 → 早退、不发请求。
//   - M5：shelf_id 为空串（PENDING 未上架）→ 早退、不发请求（必被 from 守卫拒收）。
//   - M6：version 为 NaN（卡片没填）→ 早退、不发请求。
//   - M7：回收到生产成功 → from.company_id / to.shelf_id + next_process_id 取 DTO 上的
//     `receive_next_process_id`，quote_id / direct 均为 null。
//   - M8：`receive_next_process_id === '0'` 且用户没选工序 → 早退、不发请求（后端 20706）。
//   - M9：`receive_next_process_id === '0'` 但用户选了工序 → 放行，next_process_id 用
//     用户选的值。
//   - M10：回收到品检成功 → to.kind = INSPECTION_SHELF，不带任何工序字段。
//   - M11：mutationKey 是 ['outsource-queue', 'move']。
//   - M12：失效的域集合 = 快照前缀 + 单工序看板前缀（顺序：先快照后看板）。
//   - M13：失败（onError）也失效同两个域 —— 409 OCC 说明本端副本已过期，只能重拉对账。
//   - M14：canMove 与后端 require_any_role([Manager, Clerk, Inspector]) 对齐。
//   - M15：出参缺 version → mutationFn 的 Zod 守门抛错（契约漂移不会静默通过）。
//   - M16：`shipment_id` / `new_process_id` 键整个缺失（skip_serializing_if）仍放行
//     （schema 必须 .nullish()，用 .nullable() 会在真实响应上抛错）。
//   - M17：早退路径裸 await 失效，invalidateQueries 抛错被吞、不冒未捕获 rejection。
//   - M18：成功 toast 文案按 to_kind 三向分。
//   - M19（2026-10-09 契约抢救）：旧表格页 `useOutsourceSendableList.buildSendPayload`
//     的三条硬要求随该文件一起删除后，逐条迁到本 spec 钉在新契约上。形态都变了，但
//     「踩中就整页 400/422」的性质没变，故必须留下可执行断言而不是靠记忆：
//       ① 工序键：新端点**根本没有**工序键（发送的 `from` 只有货架，目标工序由后端
//          从批次当前 step 自推）。断言落点是「请求体里不存在任何 process 键」——
//          照旧字段名（`current_process_id` / `process_id`）拼进 body 会被后端 serde
//          当未知字段或错类型拒（HTTP 422 纯文本，错误文案对用户毫无意义）。
//       ② `quote_id` 与 `direct` 必传其一：两者都传或都不传 → 20104。M1/M2 已覆盖正
//          向两路（APPROVAL 传 quote_id+direct=null、DIRECT 传 direct=true+
//          quote_id=null），M19 补「回收方向两者必须都是 null」这一路。
//       ③ 旧端点的 `quantity: null` = 整批；新端点**删掉了 quantity 字段**（整批语义
//          内建），部分收发要先拆批。断言落点是「请求体里不存在 quantity 键」。
//
// 测试策略：
//   - vi.mock('@/api/outsource') 桩掉 moveOutsourceBatch —— 只关心入参形态与调用次数；
//   - vi.mock('element-plus')：ElMessage 桩成 no-op；
//   - vi.mock('@/stores/auth')：只桩 useOutsourceQueueMove 消费的那一面（hasRole），
//     避免把整个 auth store 拉进本 spec；
//   - app.use(VueQueryPlugin) + 传 QueryClient，并 vi.spyOn(qc, 'invalidateQueries')
//     验证失效链的 queryKey 序列。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type {
  OutsourceMoveRequestDto,
  OutsourceMoveResultDto,
} from '@/api/outsource.contract';
import { ApiError } from '@/api/http';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/outsource', () => ({
  moveOutsourceBatch: (...args: unknown[]) =>
    realMoveOutsourceBatch(...(args as Parameters<typeof realMoveOutsourceBatch>)),
  fetchOutsourceQueueSnapshot: vi.fn(),
  fetchOutsourceQueueProcess: vi.fn(),
}));

/** 角色桩：默认三角色都有权；用例内可改。 */
const roles = vi.hoisted(() => ({ list: ['MANAGER', 'CLERK', 'INSPECTOR'] as string[] }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    hasRole: (r: string) => roles.list.includes(r),
  }),
}));

import { useOutsourceQueueMove } from '../useOutsourceQueueMove';
import type {
  OutsourceQueueCandidateData,
  OutsourceQueueHeldBatchData,
} from '../outsourceQueueSchema';

/** mock `POST /outsource-queue/move` 响应（rust OutsourceMoveResult）。
 *  shipment_id / new_process_id 在 rust 侧带 skip_serializing_if ⇒ 条件不满足时整个键
 *  从 JSON 省略（不是 null）。 */
function makeMoveResult(
  from: OutsourceMoveResultDto['from_kind'],
  to: OutsourceMoveResultDto['to_kind'],
): OutsourceMoveResultDto {
  return {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    from_kind: from,
    to_kind: to,
    new_holder_id: to === 'OUTSOURCE_COMPANY' ? '9000000000001' : '5000000000001',
    new_location: to,
    version: 4,
    ...(to === 'OUTSOURCE_COMPANY'
      ? { shipment_id: '8000000000001' }
      : to === 'PRODUCTION_SHELF'
        ? { new_process_id: '2000000000002' }
        : {}),
  };
}

const realMoveOutsourceBatch = vi.fn<(req: OutsourceMoveRequestDto) => Promise<unknown>>(
  async (req) => makeMoveResult(req.from.kind, req.to.kind),
);

/** APPROVAL 候选行（已批准报价、单一公司、有货架）。 */
const approvalCandidate: OutsourceQueueCandidateData = {
  version: 3,
  send_mode: 'APPROVAL',
  part_id: '4000000000001',
  part_serial_no: 'SN-0001',
  part_drawing_no: 'DRW-1',
  part_name: '连杆',
  quantity: 12,
  batch_id: '3000000000001',
  batch_no: 1024,
  planned_delivery_date: '2026-10-20',
  is_urgent: false,
  customer_name: '某某零件厂',
  parent_customer_name: '某某集团',
  shelf_code: 'A-01',
  shelf_id: '5000000000001',
  outsource_company_id: '9000000000001',
  outsource_company_name: '外协厂甲',
  quote_id: '7000000000001',
  company_options: [],
  price: '12.50',
  has_cnc_program: true,
  applicant_name: '张三',
  note: null,
  system_delivery_date: '2026-10-18',
  can_send: true,
};

/** DIRECT 候选行（免审批，公司走 company_options）。 */
const directCandidate: OutsourceQueueCandidateData = {
  ...approvalCandidate,
  send_mode: 'DIRECT',
  outsource_company_id: null,
  outsource_company_name: null,
  quote_id: null,
  price: null,
  company_options: [
    { id: '9000000000001', name: '外协厂甲' },
    { id: '9000000000002', name: '外协厂乙' },
  ],
};

/** 在途批次行（工序链可推导下一道工序）。 */
const heldBatch: OutsourceQueueHeldBatchData = {
  batch_id: '3000000000002',
  part_id: '4000000000002',
  batch_no: 1025,
  quantity: 8,
  serial_no: null,
  drawing_no: 'DRW-2',
  name: '齿轮',
  system_delivery_date: null,
  planned_delivery_date: '2026-10-25',
  is_urgent: true,
  customer_name: '某某零件厂',
  parent_customer_name: null,
  applicant_name: null,
  location: 'OUTSOURCE_COMPANY',
  note: null,
  version: 5,
  sent_at: '2026-10-01T09:00:00',
  price: '8.00',
  receive_next_process_id: '2000000000002',
  receive_next_process_name: '外协热处理',
  chain_resolvable: true,
  has_cnc_program: false,
};

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** move 后应触发的两域前缀失效（顺序：先快照后看板）。
 *  ⚠️ 必须是**前缀**失效：一次移动同时改左列候选池与右列在途集合（还可能跨 tab），
 *  mutation 回调拿不到受影响的 processId。 */
function expectOutsourceDomainsInvalidated(): void {
  const keys = vi
    .mocked(testQueryClient.invalidateQueries)
    .mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
  expect(keys).toEqual([
    ['outsource-queue', 'snapshot'],
    ['outsource-queue', 'process'],
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  roles.list = ['MANAGER', 'CLERK', 'INSPECTOR'];
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  vi.spyOn(testQueryClient, 'invalidateQueries');
});

afterEach(() => {
  testQueryClient.unmount();
  testApp = null as unknown as ReturnType<typeof createApp>;
  testQueryClient = null as unknown as QueryClient;
  vi.restoreAllMocks();
});

describe('useOutsourceQueueMove — 外协收发写操作', () => {
  it('M1：APPROVAL 发送成功 → quote_id + direct=null，请求体逐字正确 + 两域前缀失效', async () => {
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.sendToCompany({
      candidate: approvalCandidate,
      companyId: '9000000000001',
    });
    expect(ok).toBe(true);
    expect(realMoveOutsourceBatch).toHaveBeenCalledTimes(1);
    expect(realMoveOutsourceBatch).toHaveBeenCalledWith({
      batch_id: '3000000000001',
      version: 3,
      from: { kind: 'PRODUCTION_SHELF', shelf_id: '5000000000001' },
      to: { kind: 'OUTSOURCE_COMPANY', company_id: '9000000000001' },
      quote_id: '7000000000001',
      direct: null,
    });
    expectOutsourceDomainsInvalidated();
    expect(ElMessage.success).toHaveBeenCalled();
  });

  it('M2：DIRECT 发送成功 → direct=true + quote_id=null', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.sendToCompany({
      candidate: directCandidate,
      companyId: '9000000000002',
    });
    expect(ok).toBe(true);
    const sent = realMoveOutsourceBatch.mock.calls[0]?.[0] as OutsourceMoveRequestDto;
    expect(sent.direct).toBe(true);
    expect(sent.quote_id).toBeNull();
    expect(sent.to).toEqual({ kind: 'OUTSOURCE_COMPANY', company_id: '9000000000002' });
  });

  it('M3：APPROVAL 行传了报价锁定之外的公司 → 早退、零请求', async () => {
    // 回归 guard：APPROVAL 的目标是报价锁定的公司，换公司等于绕过审批口径（后端 20104）。
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.sendToCompany({
      candidate: approvalCandidate,
      companyId: '9000000000002',
    });
    expect(ok).toBe(false);
    expect(realMoveOutsourceBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('报价与目标外协公司不匹配');
    expectOutsourceDomainsInvalidated();
  });

  it('M4：DIRECT 行目标公司不在 company_options 内 → 早退、零请求', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.sendToCompany({
      candidate: directCandidate,
      companyId: '9000000000003',
    });
    expect(ok).toBe(false);
    expect(realMoveOutsourceBatch).not.toHaveBeenCalled();
  });

  it('M5：shelf_id 为空串（PENDING 未上架）→ 早退、零请求', async () => {
    // 回归 guard：这类行没有 holder，`from.shelf_id` 必被后端 from 守卫拒收。
    // UI 本该提前置灰，这里是数据层第二道防御。
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.sendToCompany({
      candidate: { ...approvalCandidate, shelf_id: '', shelf_code: null },
      companyId: '9000000000001',
    });
    expect(ok).toBe(false);
    expect(realMoveOutsourceBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('批次尚未上架，无法发送');
    expectOutsourceDomainsInvalidated();
  });

  it('M6：version 为 NaN（卡片没填）→ 早退、零请求', async () => {
    // 回归 guard：卡片没填 version 时从 dataset 读到的是 NaN（不是 undefined / 0）。
    // `typeof NaN === 'number'`，只查 typeof 会让它穿过去，后端返 422 纯文本。
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    expect(
      await q.sendToCompany({
        candidate: { ...approvalCandidate, version: Number.NaN },
        companyId: '9000000000001',
      }),
    ).toBe(false);
    expect(realMoveOutsourceBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('批次版本信息缺失，无法移动');
    expectOutsourceDomainsInvalidated();
  });

  it('M7：回收到生产成功 → from.company_id + to.shelf_id + DTO 上的下一道工序', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.receiveToProduction({
      companyId: '9000000000001',
      batch: heldBatch,
      toShelfId: '5000000000002',
    });
    expect(ok).toBe(true);
    expect(realMoveOutsourceBatch).toHaveBeenCalledWith({
      batch_id: '3000000000002',
      version: 5,
      from: { kind: 'OUTSOURCE_COMPANY', company_id: '9000000000001' },
      to: {
        kind: 'PRODUCTION_SHELF',
        shelf_id: '5000000000002',
        next_process_id: '2000000000002',
      },
      quote_id: null,
      direct: null,
    });
    expectOutsourceDomainsInvalidated();
  });

  it('M8：receive_next_process_id 为 "0" 且用户没选工序 → 早退、零请求（后端 20706）', async () => {
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.receiveToProduction({
      companyId: '9000000000001',
      batch: { ...heldBatch, receive_next_process_id: '0', chain_resolvable: false },
      toShelfId: '5000000000002',
    });
    expect(ok).toBe(false);
    expect(realMoveOutsourceBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('该批次没有下一道工序，请先选择接收工序');
    expectOutsourceDomainsInvalidated();
  });

  it('M9：receive_next_process_id 为 "0" 但用户选了工序 → 放行，用用户选的值', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.receiveToProduction({
      companyId: '9000000000001',
      batch: { ...heldBatch, receive_next_process_id: '0', chain_resolvable: false },
      toShelfId: '5000000000002',
      nextProcessId: '2000000000009',
    });
    expect(ok).toBe(true);
    const sent = realMoveOutsourceBatch.mock.calls[0]?.[0] as OutsourceMoveRequestDto;
    expect(sent.to).toEqual({
      kind: 'PRODUCTION_SHELF',
      shelf_id: '5000000000002',
      next_process_id: '2000000000009',
    });
  });

  it('M10：回收到品检成功 → to.kind = INSPECTION_SHELF，不带任何工序字段', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.receiveToInspection({
      companyId: '9000000000001',
      batch: heldBatch,
      toShelfId: '6000000000001',
    });
    expect(ok).toBe(true);
    expect(realMoveOutsourceBatch).toHaveBeenCalledWith({
      batch_id: '3000000000002',
      version: 5,
      from: { kind: 'OUTSOURCE_COMPANY', company_id: '9000000000001' },
      to: { kind: 'INSPECTION_SHELF', shelf_id: '6000000000001' },
      quote_id: null,
      direct: null,
    });
    expectOutsourceDomainsInvalidated();
  });

  it('M11：mutationKey 是 outsource-queue / move', async () => {
    // 走 mutation cache 而非 useMutationState：后者需要注入上下文（要先 mount 一个组件），
    // 本 spec 不 mount 任何组件，mutation cache 的读法等价。
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    await q.sendToCompany({ candidate: approvalCandidate, companyId: '9000000000001' });
    const keys = testQueryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.options.mutationKey);
    expect(keys).toContainEqual(['outsource-queue', 'move']);
  });

  it('M13：写失败 → 返回 false + error.value 写入 + ElMessage.error，**且仍失效两域**', async () => {
    // 回归 guard：409 OCC（40901，他人并发改动）说明本端看到的是过期数据，只能重拉
    // 对账；失败路径不失效 = 徽标与卡片计数长期与真值分叉。
    const { ElMessage } = await import('element-plus');
    realMoveOutsourceBatch.mockRejectedValueOnce(new ApiError(40901, 'VERSION_CONFLICT'));
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.sendToCompany({
      candidate: approvalCandidate,
      companyId: '9000000000001',
    });
    expect(ok).toBe(false);
    expect(q.error.value).toContain('VERSION_CONFLICT');
    expect(ElMessage.error).toHaveBeenCalledWith('VERSION_CONFLICT');
    expectOutsourceDomainsInvalidated();
  });

  it('M14：canMove 与后端 require_any_role([Manager, Clerk, Inspector]) 对齐', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    expect(q.canMove.value).toBe(true);

    for (const role of ['MANAGER', 'CLERK', 'INSPECTOR']) {
      roles.list = [role];
      const q2 = testApp.runWithContext(() => useOutsourceQueueMove());
      expect(q2.canMove.value).toBe(true);
    }
    // 少放一个角色 ⇒ 用户点了吃 40300，所以非授权角色必须为 false
    roles.list = ['WORKER'];
    const q3 = testApp.runWithContext(() => useOutsourceQueueMove());
    expect(q3.canMove.value).toBe(false);
    roles.list = [];
    const q4 = testApp.runWithContext(() => useOutsourceQueueMove());
    expect(q4.canMove.value).toBe(false);
  });

  it('M15：出参缺 version → mutationFn 的 Zod 守门抛错（契约漂移不会静默通过）', async () => {
    realMoveOutsourceBatch.mockResolvedValueOnce({
      batch_id: '3000000000001',
      part_id: '4000000000001',
      from_kind: 'PRODUCTION_SHELF',
      to_kind: 'OUTSOURCE_COMPANY',
      new_holder_id: '9000000000001',
      new_location: 'OUTSOURCE_COMPANY',
      shipment_id: '8000000000001',
    });
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.sendToCompany({
      candidate: approvalCandidate,
      companyId: '9000000000001',
    });
    expect(ok).toBe(false);
    expect(q.error.value).toBeTruthy();
  });

  it('M16：shipment_id / new_process_id 键整个缺失仍放行（.nullish() 而非 .nullable()）', async () => {
    // rust 侧 skip_serializing_if ⇒ 回收品检方向两个键都从 JSON 消失（不是 null）。
    // schema 写成 .nullable() 会在真实响应上抛错。
    realMoveOutsourceBatch.mockResolvedValueOnce({
      batch_id: '3000000000002',
      part_id: '4000000000002',
      from_kind: 'OUTSOURCE_COMPANY',
      to_kind: 'INSPECTION_SHELF',
      new_holder_id: '6000000000001',
      new_location: 'INSPECTION_SHELF',
      version: 6,
    });
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.receiveToInspection({
      companyId: '9000000000001',
      batch: heldBatch,
      toShelfId: '6000000000001',
    });
    expect(ok).toBe(true);
    expect(q.error.value).toBeNull();
  });

  it('M17：早退路径的失效抛错不冒成未捕获 rejection（仍返回 false）', async () => {
    // 早退分支是**裸 await** invalidateMoveDomains（不在 mutation 回调里，没有框架
    // 兜底），invalidateQueries 一旦 reject 就是 unhandledRejection。
    const { ElMessage } = await import('element-plus');
    vi.mocked(testQueryClient.invalidateQueries).mockRejectedValueOnce(
      new Error('invalidate boom'),
    );
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    const ok = await q.receiveToInspection({
      companyId: '9000000000001',
      batch: heldBatch,
      toShelfId: '',
    });
    expect(ok).toBe(false);
    expect(ElMessage.warning).toHaveBeenCalledWith('请先选择目标品检货架');
  });

  it('M18：成功 toast 文案按 to_kind 三向分', async () => {
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useOutsourceQueueMove());

    await q.sendToCompany({ candidate: approvalCandidate, companyId: '9000000000001' });
    expect(ElMessage.success).toHaveBeenLastCalledWith('已发送到外协公司');

    await q.receiveToProduction({
      companyId: '9000000000001',
      batch: heldBatch,
      toShelfId: '5000000000002',
    });
    expect(ElMessage.success).toHaveBeenLastCalledWith('已从外协公司回收至生产');

    await q.receiveToInspection({
      companyId: '9000000000001',
      batch: heldBatch,
      toShelfId: '6000000000001',
    });
    expect(ElMessage.success).toHaveBeenLastCalledWith('已从外协公司回收至品检');
  });

  // 2026-10-09 契约抢救组：旧表格页 buildSendPayload 的三条硬要求迁到新契约上的可执行
  // 断言（见文件头的 M19 说明）。
  it('M19a：发送请求体里没有任何工序键（目标外协工序由后端自推，不是前端传的）', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    await q.sendToCompany({ candidate: approvalCandidate, companyId: '9000000000001' });
    const sent = realMoveOutsourceBatch.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('process_id');
    expect(Object.keys(sent)).not.toContain('current_process_id');
    expect(Object.keys(sent)).not.toContain('outsource_process_id');
    // `from` 只带批次真实所在货架，没有别的
    expect(sent.from).toEqual({ kind: 'PRODUCTION_SHELF', shelf_id: '5000000000001' });
  });

  it('M19b：回收方向 quote_id 与 direct 都是 null（两者都不传 / 同时传 → 20104）', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    await q.receiveToProduction({
      companyId: '9000000000001',
      batch: heldBatch,
      toShelfId: '5000000000002',
    });
    const sent = realMoveOutsourceBatch.mock.calls[0]?.[0] as OutsourceMoveRequestDto;
    expect(sent.quote_id).toBeNull();
    expect(sent.direct).toBeNull();
  });

  it('M19c：请求体里不存在 quantity 键（move 是整批语义，部分收发先拆批）', async () => {
    const q = testApp.runWithContext(() => useOutsourceQueueMove());
    await q.sendToCompany({ candidate: approvalCandidate, companyId: '9000000000001' });
    const sent = realMoveOutsourceBatch.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('quantity');
    await q.receiveToInspection({
      companyId: '9000000000001',
      batch: heldBatch,
      toShelfId: '6000000000001',
    });
    const recv = realMoveOutsourceBatch.mock.calls[1]?.[0] as unknown as Record<string, unknown>;
    expect(Object.keys(recv)).not.toContain('quantity');
  });
});