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
// 2026-10-03 补：本文件**同时钉 body 形态** —— R2b / R2c / R4 / R4b 四条都断言 body
//   （原先只钉 URL，字段名与 number/string 之差的契约缺口正是这么漏出去的）。
//   pick-up 迁出后，**批次锚定的写端点已全部离开 part 域**；part 域仍留 part 级 /
//   多批次写端点（create / update / cancel / force-complete / soft-delete / scan），
//   上面「判据」一节列的就是它们，R6 反断言守住批次集合读那一类。
//   另：`changePartStatus`（`POST /parts/{id}/change-status`）已随无用封装删除 ——
//   在后端仓 `src/` 与 `tests/` 全仓 grep 过 `change-status`，零路由注册、零测试引用，
//   前端侧亦零调用方，故无反断言需求。
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
  // 2026-10-03：待品检端点换 13 字段精简 VO 后，两个 VO 的守门 schema 也分家了
  // （repairBatchListResultSchema 服务返修两条端点，inspectionQueueListResultSchema
  // 服务待品检端点），mock 必须同时给出两者，缺一个 vitest 就会报
  // 「No xxx export is defined on the mock」。
  // 2026-10-04：报工台两个列表端点（pickable-by-work-type / by-worker）出参改走
  // scanPartListResultSchema（它们返分页信封，不再是裸数组），crud.ts 在模块顶层
  // import 它 ⇒ mock 同样必须给出，缺一个整份 spec 直接挂（与上面两条同款理由）。
  repairBatchListResultSchema: { parse: (v: unknown) => v },
  inspectionQueueListResultSchema: { parse: (v: unknown) => v },
  scanPartListResultSchema: { parse: (v: unknown) => v },
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
    expect(
      await postedPath(() => placeOnShelf(BATCH, { shelf_id: 's', next_process_id: 'p' })),
    ).toBe(`/prod/batches/${BATCH}/place-on-shelf`);
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
    expect(await postedPath(() => completePartRepair(BATCH, { shelf_id: 's', version: 1 }))).toBe(
      `/prod/batches/${BATCH}/complete-repair`,
    );
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
        sendToOutsource(BATCH, { outsource_company_id: 'c', process_id: 'p', version: 1 }),
      ),
    ).toBe(`/prod/batches/${BATCH}/send-to-outsource`);
    expect(await postedPath(() => repairDispatch(BATCH, { shelf_id: 's', version: 1 }))).toBe(
      `/prod/batches/${BATCH}/repair-dispatch`,
    );
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
      await postedPath(() => toInspection(BATCH, { target_inspection_shelf_id: 's', version: 1 })),
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
  // 2026-10-03 契约对齐：send-to-outsource 的 body 键是 `process_id`（**不是**
  // `next_process_id`）—— 沿用旧名必然 422（后端 DTO 是 process_id，serde 未开
  // deny_unknown_fields 时旧名被静默忽略、必填 process_id 落空 → 422）。
  // 注意对比：receive-from-outsource 的键**仍是** `next_process_id`（后端没跟着改），
  // 两个端点刻意不同名，这条断言同时把两者钉住防止「顺手统一」。
  it('R2c：send-to-outsource 用 process_id，receive-from-outsource 仍用 next_process_id', async () => {
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await sendToOutsource(BATCH, {
      outsource_company_id: 'c',
      process_id: 'p',
      version: 1,
      quote_id: 'q',
      direct: null,
    });
    const [, sendBody] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(sendBody.process_id).toBe('p');
    expect(sendBody).not.toHaveProperty('next_process_id');
    // APPROVAL 路径：带 quote_id，direct 显式为 null（api 层纯透传，不注入不兜底）
    expect(sendBody.quote_id).toBe('q');
    expect(sendBody.direct).toBeNull();

    // DIRECT 路径：direct: true + quote_id: null
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await sendToOutsource(BATCH, {
      outsource_company_id: 'c',
      process_id: 'p',
      version: 1,
      quote_id: null,
      direct: true,
      quantity: 3,
    });
    const [, directBody] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(directBody.direct).toBe(true);
    expect(directBody.quote_id).toBeNull();
    // 部分发送数量透传（后端拆批，源批次留余量）
    expect(directBody.quantity).toBe(3);

    // 接收端点：键名未跟着 send 改，且部分接收的 quantity 现在后端真的认了
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await receiveFromOutsource(BATCH, {
      shelf_id: 's',
      next_process_id: 'p',
      version: 1,
      quantity: 2,
    });
    const [, recvBody] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(recvBody.next_process_id).toBe('p');
    expect(recvBody).not.toHaveProperty('process_id');
    expect(recvBody.quantity).toBe(2);
  });

  // 2026-10-03：place-on-shelf / recall-to-pending / release-from-programming 三个后端
  // DTO 都把 `version`（t_part_batch.version）列为必填且无 `#[serde(default)]`
  // ⇒ 缺字段 422。api 层只做透传，本条钉的是「调用方给了 version 就逐字进 body」。
  // 断言强度对齐 R2b / R4b：钉全量键集（防多余字段混入）+ 钉 version 形态是 number
  // （后端 i32 无自定义 deserializer，发字符串会 422）+ 负向钉 batch_id 不进 body
  // （已是路径参数）。三条端点同规格，不给「某个字段先炸时给出已守住的假信心」。
  // 编号 R2d：R2c 已被上面的 outsource 契约对齐占用。
  it('R2d：三个 place-on-shelf 系端点的 body 透传 version', async () => {
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await placeOnShelf(BATCH, { shelf_id: 's', next_process_id: 'p', version: 3 });
    const [, onShelfBody] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(onShelfBody).sort()).toEqual(['next_process_id', 'shelf_id', 'version']);
    expect(typeof onShelfBody.version).toBe('number');
    expect(onShelfBody.version).toBe(3);
    expect(onShelfBody).not.toHaveProperty('batch_id');

    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await recallToPending(BATCH, { version: 3 });
    const [, recallBody] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(recallBody).sort()).toEqual(['version']);
    expect(typeof recallBody.version).toBe('number');
    expect(recallBody.version).toBe(3);
    expect(recallBody).not.toHaveProperty('batch_id');

    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await releaseFromProgramming(BATCH, 's', 'p', 3);
    const [, releaseBody] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(releaseBody).sort()).toEqual(['next_process_id', 'shelf_id', 'version']);
    expect(typeof releaseBody.version).toBe('number');
    expect(releaseBody).toEqual({ shelf_id: 's', next_process_id: 'p', version: 3 });
    expect(releaseBody).not.toHaveProperty('batch_id');
  });
});

describe('2026-10-02：静态批量 / 事件端点只改前缀（3 条）', () => {
  it('R3：worker-scan / 批量送检 / 批量品检通过', async () => {
    expect(
      await postedPath(() =>
        workerScan({ serial_no: 'S1', badge_code: 'B1', event_type: 'RETURNED', shelf_id: 's' }),
      ),
    ).toBe('/prod/batches/worker-scan');
    expect(
      await postedPath(() => batchToInspection({ target_inspection_shelf_id: 's', items: [] })),
    ).toBe('/prod/batches/to-inspection');
    expect(await postedPath(() => batchToShip({ items: [] }))).toBe('/prod/batches/to-ship');
  });

  // 2026-10-03 契约修复：body 字段名对齐后端 `ScanDeliverPartRequest`（此前发
  // `part_id`，与后端 `part_serial_no` 不同名且无 serde default ⇒ 恒 422）。
  // 这条缺口之所以拖到现在，正是因为旧断言**只钉了 URL**；现在 body 一起钉。
  it('R4：司机扫码发货（2 段、首段静态 scan），body 字段名与后端 DTO 一致', async () => {
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await scanDeliverPart({ part_serial_no: 'S1', worker_badge_code: 'B1' });
    expect(httpPostMock).toHaveBeenCalledWith('/prod/batches/scan/deliver', {
      part_serial_no: 'S1',
      worker_badge_code: 'B1',
    });
  });

  // 2026-10-03：pickUpPart 由 v1 遗留的 `POST /parts/pick-up` 迁到 prod 域批次锚定
  // （`POST /prod/batches/{batch_id}/pick-up`）—— v1 的「扫序列号 + 工牌」与 v2 的
  // 「按批次 + OCC + 工人」不同构，此前是刻意保留的已知缺口，现在完成迁移。
  // 本条同时钉 body 形态：后端 `PickUpRequest` 有两个 number/string 之差的坑，
  // 只断言 URL 是抓不住的 ——
  //   - `quantity` 必须发 JSON **字符串**（后端 deserialize_i64_opt 先解 String 再 parse
  //     i64，发 number 直接 422）；
  //   - `version` 必须是普通 number（i32，无自定义 deserializer）。
  it('R4b：pickUpPart 打 /prod/batches/{batch_id}/pick-up，body 与 PickUpRequest 同构', async () => {
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: {} });
    await pickUpPart(BATCH, {
      version: 7,
      worker_id: '190000000000001',
      shelf_id: '190000000000002',
      quantity: '4',
    });
    const [path, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe(`/prod/batches/${BATCH}/pick-up`);
    expect(Object.keys(body).sort()).toEqual(['quantity', 'shelf_id', 'version', 'worker_id']);
    expect(typeof body.version).toBe('number');
    expect(body.version).toBe(7);
    // 字符串形态钉死（v1 的 number 形态就是 422 的根因）。
    expect(typeof body.quantity).toBe('string');
    expect(body.quantity).toBe('4');
    // batch_id 是路径参数，不再进 body。
    expect(body).not.toHaveProperty('batch_id');
    // v1 的两个字段随端点下线一并消失（worker_id ≠ badge_code，serial_no 不用了）。
    expect(body).not.toHaveProperty('badge_code');
    expect(body).not.toHaveProperty('serial_no');
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

describe('2026-10-03：待品检端点的 Query 参数集（VO 收口的另一半）', () => {
  /** 发一次 listInspectionBatches 并取回实际打到 axios 的 params。 */
  async function inspectionQueryParams(
    run: () => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    httpGetMock.mockReset();
    httpGetMock.mockResolvedValue({ data: { items: [], total: '0', limit: '200', offset: '0' } });
    await run();
    const config = httpGetMock.mock.calls[0]![1] as { params: Record<string, unknown> };
    return config.params;
  }

  it('R7：新参数集（三个 ILIKE + 客户 + 系统交期 + 排序 + 分页）逐个落到 axios params', async () => {
    const params = await inspectionQueryParams(() =>
      listInspectionBatches({
        drawing_no: 'A',
        name: 'B',
        serial_no: 'C',
        customer_id: '9000000000001',
        system_delivery_date_from: '2026-10-01',
        system_delivery_date_to: '2026-10-31',
        sort_by: 'NAME',
        sort_dir: 'ASC',
        limit: 20,
        offset: 40,
      }),
    );
    expect(params).toEqual({
      drawing_no: 'A',
      name: 'B',
      serial_no: 'C',
      customer_id: '9000000000001',
      system_delivery_date_from: '2026-10-01',
      system_delivery_date_to: '2026-10-31',
      sort_by: 'NAME',
      sort_dir: 'ASC',
      limit: 20,
      offset: 40,
    });
  });

  // 「空筛选 → undefined → 不上 wire」这一层的真 wire 形态守卫：store spec 里
  // buildParams 那半（params.xxx === undefined）因 @/api/parts 被 mock 掉而验不到 wire。
  // 入参刻意把 6 个筛选键显式写成 undefined —— 那正是 buildParams 空筛选下的产出，
  // 走的是 cleanParams 真正要 strip 的那条路径（不写这几个键则该层根本没被触发）。
  it('R7b：筛选键为 undefined 时不出现在 axios params 上', async () => {
    const params = await inspectionQueryParams(() =>
      listInspectionBatches({
        drawing_no: undefined,
        name: undefined,
        serial_no: undefined,
        customer_id: undefined,
        system_delivery_date_from: undefined,
        system_delivery_date_to: undefined,
        sort_by: 'SYSTEM_DELIVERY_DATE',
        sort_dir: 'ASC',
        limit: 20,
        offset: 0,
      }),
    );
    expect(params).toEqual({
      sort_by: 'SYSTEM_DELIVERY_DATE',
      sort_dir: 'ASC',
      limit: 20,
      offset: 0,
    });
  });

  // 2026-10-03：原 R8「废弃的 keyword / planned_delivery_date_* 绝不出现在 axios
  // params 上」随 api 层的过渡剥离逻辑（DEPRECATED_INSPECTION_QUERY_KEYS）一起删除 ——
  // 三个键已从 ListInspectionQueueParams 类型上消失，待品检页也已改传新参数集，
  // api 层不再需要「拦住页面层误传」这层防御。
});
