// src/api/parts/__tests__/routes.spec.ts
//
// 2026-10-02 新增：t_part_batch 路由迁 prod 域的**逐条 URL 契约守卫**。
//
// 为什么必须有这个文件：
//   本次迁移把 25 条以 part 为锚的路由改成以**批次**为锚并整体挪进 prod 域
//   （`POST /parts/{part_id}/<action>` → `POST /prod/batches/{batch_id}/<action>`，
//   硬切换无 alias）。此前全仓**没有任何 spec 断言 URL 字符串** —— 25 条路由零守卫，
//   「点按钮才发现 404」是唯一发现手段（本次用户报的 404 就是这么来的：前端打的是
//   v1 遗留的 `pass-inspection` / `fail-inspection`，v2 从未注册）。
//   契约必须在前端侧被逐字钉死，不能靠后端自测 + 类型系统兜底。
//
// 判据（与后端域划分一致）：
//   - 操作对象是**单个批次** → `/prod/batches/{batch_id}/<action>`（batch_id 是路径参数，
//     不再进 body）；
//   - 操作对象是**多个批次**或**根本不是批次** → 留在 part 域
//     （`POST /parts/{id}/cancel` / `force-complete` / `soft-delete`、批次集合读
//     `GET /parts/{id}/batches`）。本文件末尾有反断言守住这批「不该动」的路径。
//
// mock 手法沿 src/api/shelfProcesses.spec.ts 同款：整模块桩掉 `@/api/http`
// （不 importOriginal），只留可断言的 api.get / api.post 入口。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
  // crud.ts 的 listParts 会用，本文件不覆盖它；给出实现避免 vitest 报
  // 「No normalizeListResult export is defined on the mock」。
  normalizeListResult: (v: unknown) => v,
}));

vi.mock('@/composables/queries/schemas', () => ({
  // 集合读端点本函数内会 Zod parse；URL 守卫不需要真实 schema，原样回传给调用方即可。
  inspectionBatchListResultSchema: { parse: (v: unknown) => v },
}));

import {
  batchToInspection,
  batchToShip,
  cancelPartBatch,
  listInspectionBatches,
  listPartBatches,
  splitPartBatch,
} from '../batch';
import {
  completePart,
  completePartRepair,
  deliverPart,
  listRepairBatches,
  listRepairingBatches,
  pickUpPart,
  placeOnShelf,
  recallToPending,
  receiveFromOutsource,
  receiveFromOutsourceToInspection,
  releaseFromProgramming,
  repairDispatch,
  scanDeliverPart,
  scanInspect,
  sendToOutsource,
  startPartRepair,
  toInspection,
  toProcess,
  toShip,
  workerScan,
} from '../crud';

const BATCH = '190000000000123';

/** 发一次写请求并取回实际打出的路径。 */
async function postedPath(run: () => Promise<unknown>): Promise<string> {
  // 每个断言独立计数：helper 内部先 reset，同一个 it 里连打多条路径互不干扰。
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: {} });
  await run();
  expect(httpPostMock).toHaveBeenCalledTimes(1);
  return httpPostMock.mock.calls[0]![0] as string;
}

/** 发一次读请求并取回实际打出的路径。 */
async function fetchedPath(run: () => Promise<unknown>): Promise<string> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data: {} });
  await run();
  expect(httpGetMock).toHaveBeenCalledTimes(1);
  return httpGetMock.mock.calls[0]![0] as string;
}

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

describe('2026-10-02：批次写端点锚定 prod 域（19 条子资源）', () => {
  it('R1：lifecycle 流转端点全部落在 /prod/batches/{batch_id}/<action>', async () => {
    expect(await postedPath(() => placeOnShelf(BATCH, { shelf_id: 's', next_process_id: 'p' }))).toBe(
      `/prod/batches/${BATCH}/place-on-shelf`,
    );
    expect(await postedPath(() => recallToPending(BATCH))).toBe(
      `/prod/batches/${BATCH}/recall-to-pending`,
    );
    expect(await postedPath(() => releaseFromProgramming(BATCH, 's', 'p'))).toBe(
      `/prod/batches/${BATCH}/release-from-programming`,
    );
    expect(await postedPath(() => toShip(BATCH, { version: 1 }))).toBe(
      `/prod/batches/${BATCH}/to-ship`,
    );
    expect(
      await postedPath(() => toProcess(BATCH, { shelf_id: 's', next_process_id: 'p', version: 1 })),
    ).toBe(`/prod/batches/${BATCH}/to-process`);
    expect(await postedPath(() => deliverPart(BATCH, { version: 1 }))).toBe(
      `/prod/batches/${BATCH}/deliver`,
    );
    expect(await postedPath(() => completePart(BATCH, { version: 1 }))).toBe(
      `/prod/batches/${BATCH}/complete`,
    );
    expect(await postedPath(() => startPartRepair(BATCH, { version: 1 }))).toBe(
      `/prod/batches/${BATCH}/start-repair`,
    );
    expect(
      await postedPath(() => completePartRepair(BATCH, { shelf_id: 's', version: 1 })),
    ).toBe(`/prod/batches/${BATCH}/complete-repair`);
    expect(
      await postedPath(() =>
        receiveFromOutsource(BATCH, { shelf_id: 's', next_process_id: 'p', version: 1 }),
      ),
    ).toBe(`/prod/batches/${BATCH}/receive-from-outsource`);
    expect(
      await postedPath(() =>
        receiveFromOutsourceToInspection(BATCH, { shelf_id: 's', version: 1 }),
      ),
    ).toBe(`/prod/batches/${BATCH}/receive-from-outsource-to-inspection`);
    expect(
      await postedPath(() =>
        sendToOutsource(BATCH, { outsource_company_id: 'c', next_process_id: 'p', version: 1 }),
      ),
    ).toBe(`/prod/batches/${BATCH}/send-to-outsource`);
    expect(
      await postedPath(() =>
        repairDispatch(BATCH, { shelf_id: 's', version: 1 }),
      ),
    ).toBe(`/prod/batches/${BATCH}/repair-dispatch`);
    expect(
      await postedPath(() =>
        scanInspect(BATCH, { target_inspection_shelf_id: 's', pass: true, version: 1 }),
      ),
    ).toBe(`/prod/batches/${BATCH}/scan-inspect`);
    expect(await postedPath(() => splitPartBatch(BATCH, { quantity: 1, version: 1 }))).toBe(
      `/prod/batches/${BATCH}/split`,
    );
    expect(await postedPath(() => cancelPartBatch(BATCH, 1))).toBe(`/prod/batches/${BATCH}/cancel`);
    // 单件送检（本次新建的 URL）。别与 receiveFromOutsourceToInspection 混：
    // 那个是 /receive-from-outsource-to-inspection，外协回收直送品检。
    expect(
      await postedPath(() =>
        toInspection(BATCH, { target_inspection_shelf_id: 's', version: 1 }),
      ),
    ).toBe(`/prod/batches/${BATCH}/to-inspection`);
  });

  it('R2：批次锚定后 batch_id 不再进 body（它是路径参数）', async () => {
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await repairDispatch(BATCH, { shelf_id: 's', version: 1, note: 'n' });
    const [, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty('batch_id');
    expect(body.version).toBe(1);
  });

  // 2026-10-03：钉住 repair-dispatch / start-repair 的 body 键集合 = 后端 DTO 认识的
  // 字段子集。api 层不做键改名/增删（payload 原样透传），所以这条断言实际锁的是
  // 「前端不会主动发后端 DTO 之外的键」：两个 DTO 都没有 quantity（start-repair 连
  // shelf_id 都没有），而 serde 未开 deny_unknown_fields ⇒ 多带的键被静默忽略，
  // 端点仍整批生效，操作员却以为只返修了自己填的数量。
  it('R2b：repair-dispatch / start-repair 的 body 不含 quantity（后端 DTO 无此字段）', async () => {
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await repairDispatch(BATCH, {
      shelf_id: 's',
      version: 1,
      next_process_id: 'p',
      reason: 'r',
      note: 'n',
    });
    const [, dispatchBody] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(dispatchBody).sort()).toEqual([
      'next_process_id',
      'note',
      'reason',
      'shelf_id',
      'version',
    ]);
    expect(dispatchBody).not.toHaveProperty('quantity');

    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await startPartRepair(BATCH, { version: 1, reason: 'r', note: 'n' });
    const [, startBody] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(startBody).sort()).toEqual(['note', 'reason', 'version']);
    expect(startBody).not.toHaveProperty('quantity');
  });
});

describe('2026-10-02：静态批量 / 事件端点只改前缀（3 条）', () => {
  it('R3：worker-scan / 批量送检 / 批量品检通过', async () => {
    expect(
      await postedPath(() =>
        workerScan({ serial_no: 'S1', badge_code: 'B1', event_type: 'RETURNED', shelf_id: 's' }),
      ),
    ).toBe('/prod/batches/worker-scan');
    expect(await postedPath(() => batchToInspection({ target_inspection_shelf_id: 's', items: [] }))).toBe(
      '/prod/batches/to-inspection',
    );
    expect(await postedPath(() => batchToShip({ items: [] }))).toBe('/prod/batches/to-ship');
  });

  it('R4：司机扫码发货（2 段、首段静态 scan）', async () => {
    expect(
      await postedPath(() => scanDeliverPart({ part_id: '1', worker_badge_code: 'B1' })),
    ).toBe('/prod/batches/scan/deliver');
  });

  // 已知缺口守卫：pickUpPart 是**唯一**刻意留在 part 域的写端点（后端 v2 的领取端点
  // 是批次锚定的 /prod/batches/{batch_id}/pick-up，v1 的「扫序列号 + 工牌」与 v2 的
  // 「按批次 + OCC + 工人」不同构，迁移是业务决策）。钉住「它还打着 /parts/pick-up」，
  // 这样将来真去迁的时候这条断言会先红，强迫同步改 payload 与调用方。
  it('R4b：pickUpPart 仍打 v1 遗留的 /parts/pick-up（已知缺口守卫）', async () => {
    expect(
      await postedPath(() => pickUpPart({ serial_no: 'S1', shelf_id: 's', badge_code: 'B1' })),
    ).toBe('/parts/pick-up');
  });
});

describe('2026-10-02：集合读迁入 prod 域（3 条）', () => {
  it('R5：品检 / 返修 / 返修中', async () => {
    expect(await fetchedPath(() => listInspectionBatches())).toBe('/prod/batches/inspection');
    expect(await fetchedPath(() => listRepairBatches())).toBe('/prod/batches/repair');
    expect(await fetchedPath(() => listRepairingBatches())).toBe('/prod/batches/repairing');
  });
});

describe('2026-10-02：留在 part 域的路径一个都不许动', () => {
  it('R6：批次集合读仍按 part 锚定（操作对象是「某 part 的批次集合」）', async () => {
    expect(await fetchedPath(() => listPartBatches('42'))).toBe('/parts/42/batches');
  });
});
