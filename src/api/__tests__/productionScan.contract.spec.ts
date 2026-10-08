// src/api/__tests__/productionScan.contract.spec.ts
//
// 2026-10-10 重写：报工台（工人扫码台）域 `src/api/productionScan.ts` 5 个端点的
// **逐条 URL + query + body 契约守卫** + `scanPartListResultSchema` 的守门有效性回归锁。
//
// 本文件的前身是 `src/api/parts/__tests__/scan-list.contract.spec.ts`（报工台当时挂在
// part 域，URL 是 `/parts/pickable-by-work-type/{id}` 与 `/parts/by-worker/{id}`，行 VO
// 是 39 字段的 `PartListItem`）。后端把这 5 条端点整体迁进新的 `prod::scan` 域并把行
// VO 收敛成 17 字段的 `ScanListItem`（砍掉 22 个恒为占位值的键）⇒ URL 与守卫一起重写。
// 旧的「helper 返回值必须过 Zod」那组断言（F 组）**不再成立**：按 CLAUDE.md 的分层
// 取舍，api 层已不做守门，守门落在 queryFn / mutationFn（见 E 组与
// `views/production/scan/composables/__tests__/scanSchema.spec.ts`）。
//
// 为什么 URL 必须逐字钉死：这次是**硬切无 alias**，且两条 list 的过滤键由 path 改成
// query，旧前端发出的 URL 直接 404（verify-badge 那条更隐蔽 —— 路径匹配上了但 method
// 变了，返回 405）。失败发生在网络层而不是 Zod 契约层，现场只看到一句 axios 错误。
// ⚠️ **部署顺序：后端必须先上**，否则报工台三页 + 徽章同时空白。
//
// 守门分工：本文件只钉「打出去的东西」与「schema 自身对各种形状的行为」；
// 「queryFn 真的把 parse 接在返回路径上」由 scan 域的 query hook spec 守
// （把 parse 整段删掉时，本文件全绿而线上三页崩 —— 那个失败模式的守卫在那边）。
//
// mock 手法沿 `inspection.contract.spec.ts` / 旧的 scan-list spec 同款：整模块桩掉
// `@/api/http`（不 importOriginal），只留 api.get / api.post / cleanParams。
// ⚠️ `cleanParams` 是**语义复刻**而非恒等函数：A6（falsy 的 `offset: 0` 必须仍出现在
// params 里）要成立，恒等桩会让这条退化成恒真断言。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import {
  scanPartListResultSchema,
  scanPartRowSchema,
} from '@/views/production/scan/composables/scanSchema';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  // 逐条复刻 `src/api/http.ts::cleanParams`：只丢 undefined / null / 空串 / 空数组，
  // **不丢 0 与 false**（分页 offset: 0 是合法值，丢掉就退化成「永远取第一页」）。
  cleanParams: (obj?: Record<string, unknown>) => {
    if (!obj) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' && v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  },
}));

import {
  fetchScanHeld,
  fetchScanPickable,
  findWorkerByBadge,
  pickUpBatch,
  scanWorker,
} from '../productionScan';

const WORK_TYPE_ID = '190000000000001';
const WORKER_ID = '190000000000002';
const BATCH_ID = '190000000000111';

/** 合法的空分页信封：URL 组只需要一次「不抛错」的读请求。 */
const EMPTY_ENVELOPE = { items: [], total: 0, limit: 200, offset: 0 };

/** 打一次读请求并返回 axios 实际收到的 URL 与 request config。 */
async function fetchedRequest(
  run: () => Promise<unknown>,
): Promise<{ path: string; params: Record<string, unknown> }> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data: EMPTY_ENVELOPE });
  await run();
  expect(httpGetMock).toHaveBeenCalledTimes(1);
  const [path, cfg] = httpGetMock.mock.calls[0] as [string, { params?: Record<string, unknown> }];
  // 真实 cleanParams 恒返回对象（无参时 `{}`），所以这里 config.params 不会是 undefined。
  return { path, params: cfg.params ?? {} };
}

/** 打一次读请求并返回实际使用的 URL。 */
async function fetchedPath(run: () => Promise<unknown>): Promise<string> {
  return (await fetchedRequest(run)).path;
}

/** 打一次写请求并返回 axios 实际收到的 URL 与 body。 */
async function postedRequest(
  run: () => Promise<unknown>,
): Promise<{ path: string; body: Record<string, unknown> }> {
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: {} });
  await run();
  expect(httpPostMock).toHaveBeenCalledTimes(1);
  const [path, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
  return { path, body };
}

/** 打一次写请求并返回实际使用的 URL。 */
async function postedPath(run: () => Promise<unknown>): Promise<string> {
  return (await postedRequest(run)).path;
}

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

// ============================================================
// A 组：5 个端点的 URL 与 query 逐字钉死。
// ============================================================

describe('A 组：prod::scan 域 5 个端点的 URL 与 query 逐字钉死', () => {
  it('A1：取件列表 = GET /prod/scan/pickable，work_type_id 走 query（不再是 path 分段）', async () => {
    expect(await fetchedPath(() => fetchScanPickable({ workTypeId: WORK_TYPE_ID }))).toBe(
      '/prod/scan/pickable',
    );
    // 反断言：过滤键**必须**离开 path。后端已把该端点改成 Query extractor，路径上再带
    // id 会 404。这条钉的是「不再拼 path」而不是「拼了什么」。
    expect(await fetchedPath(() => fetchScanPickable({ workTypeId: WORK_TYPE_ID }))).not.toContain(
      WORK_TYPE_ID,
    );
  });

  it('A2：放回 / 送检 / 徽章列表 = GET /prod/scan/held，worker_id 走 query', async () => {
    expect(await fetchedPath(() => fetchScanHeld({ workerId: WORKER_ID }))).toBe('/prod/scan/held');
    expect(await fetchedPath(() => fetchScanHeld({ workerId: WORKER_ID }))).not.toContain(
      WORKER_ID,
    );
  });

  // ⚠️ 两条 list 的过滤键后端走 `deserialize_i64`：**只吃 JSON 字符串**，发数字或漏传
  // 会被 axum `QueryRejection` 拒成 HTTP 400 纯文本（不进 R<T> 信封）。这条钉住
  // 「work_type_id / worker_id 是字符串键」—— 调用点传 Number() 时这条会红。
  it('A3：两条 list 的过滤键发的是字符串字面量（后端 deserialize_i64 只吃 JSON string）', async () => {
    const pick = await fetchedRequest(() => fetchScanPickable({ workTypeId: WORK_TYPE_ID }));
    expect(pick.params.work_type_id).toBe(WORK_TYPE_ID);
    expect(typeof pick.params.work_type_id).toBe('string');
    const held = await fetchedRequest(() => fetchScanHeld({ workerId: WORKER_ID }));
    expect(held.params.worker_id).toBe(WORKER_ID);
    expect(typeof held.params.worker_id).toBe('string');
  });

  // 后端两个端点都是 `limit.unwrap_or(50).clamp(1, 200)`：不传 limit 静默只返 50 条。
  // 传了必须真的发出去，否则报工台会「看起来正常、少一半候选件」。
  it('A4：分页参数照传（limit / offset 进 query，两个端点都测）', async () => {
    const pick = await fetchedRequest(() =>
      fetchScanPickable({ workTypeId: WORK_TYPE_ID, limit: 200, offset: 20 }),
    );
    expect(pick.params).toEqual({ work_type_id: WORK_TYPE_ID, limit: 200, offset: 20 });
    const held = await fetchedRequest(() =>
      fetchScanHeld({ workerId: WORKER_ID, limit: 200, offset: 20 }),
    );
    expect(held.params).toEqual({ worker_id: WORKER_ID, limit: 200, offset: 20 });
  });

  it('A5：分页参数缺省时不得凭空出现 limit / offset 键（只有过滤键）', async () => {
    const pick = await fetchedRequest(() => fetchScanPickable({ workTypeId: WORK_TYPE_ID }));
    expect(pick.params).toEqual({ work_type_id: WORK_TYPE_ID });
    const held = await fetchedRequest(() => fetchScanHeld({ workerId: WORKER_ID }));
    expect(held.params).toEqual({ worker_id: WORKER_ID });
  });

  // offset: 0 是「第一页」的合法值。helper 若自己手搓过滤（`if (offset) …`）把它吃掉，
  // 症状是翻页永远停第一页，且没有任何报错。
  it('A6：falsy 的 offset: 0 仍然出现在 params 里', async () => {
    const pick = await fetchedRequest(() =>
      fetchScanPickable({ workTypeId: WORK_TYPE_ID, limit: 200, offset: 0 }),
    );
    expect(pick.params).toEqual({ work_type_id: WORK_TYPE_ID, limit: 200, offset: 0 });
    expect(pick.params).toHaveProperty('offset', 0);
    const held = await fetchedRequest(() =>
      fetchScanHeld({ workerId: WORKER_ID, limit: 200, offset: 0 }),
    );
    expect(held.params).toEqual({ worker_id: WORKER_ID, limit: 200, offset: 0 });
    expect(held.params).toHaveProperty('offset', 0);
  });

  // ⚠️ `?shelf_id=` 随「目标货架由后端按负载自动选」整体删除。钉死它不出现在 query 里：
  // 多发一个后端不认的键不会被拒，但会让「前端还在指定货架」这个已经废止的口径
  // 在代码里复活。
  it('A7：两条 list 的 params 里没有 shelf_id（目标架由后端自动选）', async () => {
    const pick = await fetchedRequest(() => fetchScanPickable({ workTypeId: WORK_TYPE_ID }));
    expect(pick.params).not.toHaveProperty('shelf_id');
    const held = await fetchedRequest(() => fetchScanHeld({ workerId: WORKER_ID }));
    expect(held.params).not.toHaveProperty('shelf_id');
  });

  it('A8：工牌定位 = POST /prod/scan/verify-badge（旧 /prod/workers/verify-badge 是 405）', async () => {
    const { path, body } = await postedRequest(() => findWorkerByBadge('W-001'));
    expect(path).toBe('/prod/scan/verify-badge');
    expect(body).toEqual({ badge_code: 'W-001' });
  });

  // 工牌码先 trim、空串直接短路不发请求（旧实现沿用至今）。
  it('A9：工牌码 trim 后发送；空串 / 纯空白不发出任何请求', async () => {
    expect(await postedPath(() => findWorkerByBadge('  W-001  '))).toBe('/prod/scan/verify-badge');
    const { body } = await postedRequest(() => findWorkerByBadge('  W-001  '));
    expect(body).toEqual({ badge_code: 'W-001' });

    httpPostMock.mockReset();
    expect(await findWorkerByBadge('')).toBeNull();
    expect(await findWorkerByBadge('   ')).toBeNull();
    expect(httpPostMock).not.toHaveBeenCalled();
  });

  it('A10：放回 / 送检 = POST /prod/scan/worker-scan，body 逐字透传不带任何货架字段', async () => {
    const { path, body } = await postedRequest(() =>
      scanWorker({
        serial_no: 'F2256',
        badge_code: 'W-001',
        event_type: 'RETURNED',
        next_process_id: '190000000000131',
        batch_id: BATCH_ID,
      }),
    );
    expect(path).toBe('/prod/scan/worker-scan');
    expect(body).toEqual({
      serial_no: 'F2256',
      badge_code: 'W-001',
      event_type: 'RETURNED',
      next_process_id: '190000000000131',
      batch_id: BATCH_ID,
    });
    // 目标架由后端按负载自动选：shelf_id / target_inspection_shelf_id 一律不发。
    expect(body).not.toHaveProperty('shelf_id');
    expect(body).not.toHaveProperty('target_inspection_shelf_id');
  });

  // 三个 number/string 之差的坑，只断言 URL 抓不住：
  //   - `version` 必须是普通 number（后端 i32，无自定义反序列化器）；
  //   - `worker_id` 必须是**工人雪花 ID 字符串**，不是工牌码；
  //   - `quantity` 必须发 JSON **字符串**（发 number 被 axum Json extractor 拒成 422）。
  it('A11：取件 = POST /prod/scan/batches/{batch_id}/pick-up，body 与 ScanPickUpRequest 同构', async () => {
    const { path, body } = await postedRequest(() =>
      pickUpBatch(BATCH_ID, { version: 7, worker_id: WORKER_ID, quantity: '4' }),
    );
    expect(path).toBe(`/prod/scan/batches/${BATCH_ID}/pick-up`);
    expect(Object.keys(body).sort()).toEqual(['quantity', 'version', 'worker_id']);
    expect(typeof body.version).toBe('number');
    expect(body.version).toBe(7);
    expect(typeof body.quantity).toBe('string');
    expect(body.quantity).toBe('4');
    // batch_id 是路径参数，不再进 body；货架字段一律不发。
    expect(body).not.toHaveProperty('batch_id');
    expect(body).not.toHaveProperty('shelf_id');
    // v1 的两个字段随端点下线一并消失。
    expect(body).not.toHaveProperty('badge_code');
    expect(body).not.toHaveProperty('serial_no');
  });

  // batch_id 走路径，必须 encodeURIComponent：漏掉时无特殊字符的 id 上第一个断言仍绿。
  it('A12：pick-up 的 batch_id 走 encodeURIComponent', async () => {
    expect(await postedPath(() => pickUpBatch('a b/c', { version: 1, worker_id: WORKER_ID }))).toBe(
      '/prod/scan/batches/a%20b%2Fc/pick-up',
    );
  });
});

// ============================================================
// E 组：schema 守门有效性回归锁。
//
// ⚠️ Zod 默认 `z.object()` 是 **strip** 模式：schema 里没声明的键被**静默丢弃**、
// parse 不报错 —— 守门形同虚设。所以每条都要求「一份完整合法 fixture parse 通过」
// +「缺分页字段 / 类型错 / 裸数组时 parse 抛错」双向锁死。
//
// 下面两份 fixture 是 `ScanListItem`（17 字段）的逐字转录。「fixture 写全」本身不构成
// 守卫 —— 多出来的键会被 strip 静默吞掉；真正把「schema 声明的字段集 == wire 字段集」
// 钉死的是 E7 的键集断言。
// ============================================================

/**
 * 取件行 fixture（`GET /prod/scan/pickable` 的行）。
 *
 * 值按该端点的真实填充口径给：工序链四件套恒为降级值（`"NONE"` / `"0"` / null / null）、
 * `process_chain_id` 恒 null、`location` 恒 null 但**键必须在**（`BatchPickerDialog`
 * 的 `holderText` 用 `'location' in p` 判要不要渲染 holder 行）。雪花 id 全是 JSON string。
 */
const pickRowFixture = {
  id: '190000000000101',
  serial_no: 'SN-PICK-1',
  name: '零件甲',
  drawing_no: 'DWG-1',
  quantity: 10,
  is_urgent: false,
  planned_delivery_date: '2026-11-15',
  system_delivery_date: null,
  process_chain_id: null,
  has_process_chain: true,
  chain_state: 'NONE',
  chain_next_process_id: '0',
  chain_next_process_name: null,
  chain_current_process_name: null,
  batch_id: '190000000000111',
  batch_version: 3,
  location: null,
};

/** 放回 / 送检行 fixture（`GET /prod/scan/held`）：与取件行同 VO、同 17 字段。
 *  差别在工序链四件套的取值：held 填真值，这里取 `TAIL`（当前工序是链内最后一道 ⇒
 *  下一道工序 id 落兜底值 `'0'`、下一道工序名为 null）。 */
const heldRowFixture = {
  ...pickRowFixture,
  id: '190000000000102',
  // 存量数据里 held 的链指针常常是 NULL ⇒ 本行取 false（列表卡灰边框），属预期而非缺陷
  has_process_chain: false,
  process_chain_id: '190000000000121',
  chain_state: 'TAIL',
  chain_next_process_id: '0',
  chain_next_process_name: null,
  chain_current_process_name: 'CUT-01 下料',
  batch_id: '190000000000112',
  batch_version: 4,
};

// ============================================================
// W 组：**wire 样本** —— 与 E 组的 fixture 是两种不同性质的证据。
//
// E 组那两份 fixture 是**照契约手写**的，而 `scanPartRowSchema` 同样是照契约手写的
// ⇒ 两者同源，只能证明「schema 接受自己那份手写形状」，证明不了「schema 接受真实
// 响应」。schema 误拒合法响应的产线症状是「列表数据格式异常，请截图上报」—— 与「加载不出」
// 不同，它把排查方向指歪。W 组补的就是这一维。
//
// 样本出处与其可信度（**必须说清，否则这个「唯一真值维度」的守卫会自我否定**）：
//   · **实测转录**：2026-10-04 在 dev 库采自 `GET /parts/pickable-by-work-type/208472998548602880`
//     与 `GET /parts/by-worker/208473192891678720` 的响应体 `data.items[0]`（采集方式：
//     e2e seed MANAGER → `POST /iam/login` 取 token → 带 Bearer 打 GET）。
//     本文件保留下来的实测部分就是这些行里的**标识类字段**（`id` / `serial_no` /
//     `drawing_no` / `quantity` / `batch_id` / `batch_version` 的具体取值）与它们
//     **实测到的 JSON 形态**（雪花 id 是 string、`batch_version` 是 number）。
//   · **按新契约手写**（后端 2026-10-10 的 `prod::scan` 域迁移 + 行 VO 收敛后才确定，
//     旧端点已下线、无法再采）：`name` / `is_urgent` / `planned_delivery_date` /
//     `system_delivery_date` / `has_process_chain` / 工序链四件套 / `location`。
//     旧样本里这些字段是 `1970-01-01` 占位 / 恒 null / 恒 false，新契约不再下发
//     占位形态（`planned_delivery_date` 是真实投影、`request_date` 整键删除）。
//
// 「键集完全一致 / 逐行 parse 通过」这类结论**只对实测转录的那部分字段成立**，本文件
// 不把它当整体结论引用。
// ============================================================

/** 取件行样本：`GET /prod/scan/pickable` 的 `data.items[0]`（标识字段实测 + 其余按契约手写）。 */
const wirePickRow = {
  id: '226157188085710848',
  serial_no: 'F2256',
  // 2026-10-04 补真实投影后 `name` 是工单名（实测样本里它是图号，与 drawing_no 相同）
  name: '齿轮轴',
  drawing_no: 'E42BD20009014101',
  quantity: 2,
  is_urgent: true,
  planned_delivery_date: '2026-11-15',
  system_delivery_date: '2026-12-31',
  process_chain_id: null,
  has_process_chain: true,
  // 取件行的链四件套恒为降级值（候选按工种↔工序映射取，不按链）
  chain_state: 'NONE',
  chain_next_process_id: '0',
  chain_next_process_name: null,
  chain_current_process_name: null,
  batch_id: '226157188089905152',
  batch_version: 6,
  location: null,
};

/** 放回 / 送检行样本：`GET /prod/scan/held` 的 `data.items[0]`（标识字段实测 + 其余按契约手写）。 */
const wireHeldRow = {
  id: '228801248768294912',
  serial_no: 'F2475',
  name: '连接法兰',
  drawing_no: 'E42703FZJ294500',
  quantity: 2,
  is_urgent: false,
  planned_delivery_date: '2026-10-20',
  system_delivery_date: null,
  process_chain_id: '226157188099400000',
  // ⚠️ 存量数据里 held 的链指针常常是 NULL ⇒ 本行取 false（列表卡灰边框），属预期
  // 而非渲染缺陷。
  has_process_chain: false,
  chain_state: 'TAIL',
  chain_next_process_id: '0',
  chain_next_process_name: null,
  chain_current_process_name: 'CUT-01 下料',
  batch_id: '228801248771809280',
  batch_version: 2,
  location: null,
};

describe('E 组：scanPartRowSchema / scanPartListResultSchema 的守门有效性', () => {
  it('E1：合法 fixture 组成完整信封 parse 通过（17 字段行 + 四个分页键）', () => {
    const parsed = scanPartListResultSchema.parse({
      items: [pickRowFixture],
      total: 1,
      limit: 200,
      offset: 0,
    });
    expect(parsed.items[0]!.id).toBe('190000000000101');
    expect(parsed.items[0]!.batch_version).toBe(3);
    expect(parsed.total).toBe(1);
    expect(parsed.limit).toBe(200);
    expect(parsed.offset).toBe(0);
  });

  // ⚠️ 历史上真实发生过的故障形态：helper 把分页信封当裸数组吐出去，视图层 `[...list]`
  // 抛 TypeError、三页 v-for 同时渲染失败。这条是防复发最关键的一条 —— 守门必须在边界
  // 就拒收裸数组。
  it('E2：裸数组 → parse 抛 ZodError（防「信封退化成数组」复发）', () => {
    expect(() => scanPartListResultSchema.parse([pickRowFixture])).toThrow(ZodError);
    expect(() => scanPartListResultSchema.parse([heldRowFixture])).toThrow(ZodError);
  });

  it('E3：缺分页字段 → parse 抛 ZodError', () => {
    expect(() => scanPartListResultSchema.parse({ items: [] })).toThrow(ZodError);
    // 少 total / limit / offset 任一都会让守门失效（调用方按 total 渲染截断计数）
    expect(() => scanPartListResultSchema.parse({ items: [], total: 0 })).toThrow(ZodError);
    expect(() => scanPartListResultSchema.parse({ items: [], total: 0, limit: 200 })).toThrow(
      ZodError,
    );
    // 正向对照：四个键齐了才放行
    expect(() =>
      scanPartListResultSchema.parse({ items: [], total: 0, limit: 200, offset: 0 }),
    ).not.toThrow();
  });

  // ⚠️ 2026-10-10：后端不再下发占位符，`planned_delivery_date` 是**真实投影值**、
  // 声明成非 null string。上一版 schema 上那个把 `'1970-01-01'` 归一成 null 的字段级
  // transform 已随本次收敛删除 —— 这条钉住新口径，同时反锁 transform 没有复活
  // （复活了会把真实日期判成占位、把交期 chip 显示成 01/01）。
  it('E4：planned_delivery_date 是真实值、原样透传（占位符归一 transform 已删除）', () => {
    const parsed = scanPartRowSchema.parse(pickRowFixture);
    expect(parsed.planned_delivery_date).toBe('2026-11-15');
    // 即使后端哪天又吐出占位符，也不再被归一成 null —— schema 只认「字符串」这一条。
    const placeholder = scanPartRowSchema.parse({
      ...pickRowFixture,
      planned_delivery_date: '1970-01-01',
    });
    expect(placeholder.planned_delivery_date).toBe('1970-01-01');
    // 缺键仍抛（非 null 是必填）：键消失说明后端换了行 VO，要在边界炸出来。
    const { planned_delivery_date: _dropped, ...rest } = pickRowFixture;
    void _dropped;
    expect(() => scanPartRowSchema.parse(rest)).toThrow(ZodError);
    expect(() =>
      scanPartRowSchema.parse({ ...pickRowFixture, planned_delivery_date: null }),
    ).toThrow(ZodError);
  });

  it('E5：取件行与放回行的批次锚点都 parse 通过且有值（两个端点都填）', () => {
    expect(scanPartRowSchema.parse(pickRowFixture).batch_id).toBe('190000000000111');
    expect(scanPartRowSchema.parse(pickRowFixture).batch_version).toBe(3);
    expect(scanPartRowSchema.parse(heldRowFixture).batch_id).toBe('190000000000112');
    expect(scanPartRowSchema.parse(heldRowFixture).batch_version).toBe(4);
    expect(
      scanPartListResultSchema.parse({
        items: [pickRowFixture, heldRowFixture],
        total: 2,
        limit: 200,
        offset: 0,
      }).items,
    ).toHaveLength(2);
  });

  it('E6：字段类型错 → parse 抛 ZodError（雪花 id 必为 string、计数必为 number）', () => {
    // 雪花 id 退化成 number（后端某天漏了 serialize_i64）必须被抓出来，不能靠 coerce 掩盖
    for (const key of ['id', 'batch_id', 'chain_next_process_id'] as const) {
      expect(() => scanPartRowSchema.parse({ ...pickRowFixture, [key]: 190000000000101 })).toThrow(
        ZodError,
      );
    }
    // 布尔与数值同理
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, is_urgent: 'false' })).toThrow(
      ZodError,
    );
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, batch_version: '3' })).toThrow(
      ZodError,
    );
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, quantity: '2' })).toThrow(ZodError);
  });

  // 「fixture 写全」本身不构成守卫：Zod strip 会把 schema 没声明的键静默吞掉、parse 照过
  // 不误。这条把「schema 声明的字段集 == wire 字段集」变成可执行断言：
  //   · schema 少声明 → parse 结果少键 → 与 fixture 键集不等 → 红；
  //   · schema 多声明一个**必填**字段 → 输入缺该键即 parse 抛错，键集断言也红；
  //   · schema 多声明一个 **optional** 字段 → 键集断言看不见（Zod 对输入中缺省的
  //     optional 键不写入输出）。该失败模式本身无害（不会误拒任何响应，也不会有字段
  //     被静默吞掉），故不为它额外设计断言。
  it('E7：parse 后的行键集与 wire 的 17 字段逐字段相等', () => {
    expect(Object.keys(pickRowFixture).length, 'fixture 字段数（后端 VO 漂移也会红）').toBe(17);
    expect(Object.keys(scanPartRowSchema.parse(pickRowFixture)).sort()).toEqual(
      Object.keys(pickRowFixture).sort(),
    );
  });

  // ⚠️ **本次收敛的核心**：22 个恒为占位值的键随行 VO 收敛一并删除。它们在 schema 上
  // 彻底消失 ⇒ 后端若仍下发（灰度期新旧后端并存、或后端没跟上），Zod strip 掉、**不抛错**。
  // 反向断言（它们不得成为保留键）守的是「哪天有人顺手把某个加回 schema 变成必填」——
  // 那会让灰度期的新后端响应整份 parse 失败、报工台三页全空。
  //
  // ⚠️ `location` **不在**这 22 个之列：它的值恒为 null，但键必须声明（`holderText`
  // 用 `'location' in p` 判要不要渲染 holder 行）。strip 掉的后果是卡片静默少
  // 「未知位置」那一行，且仓内没有测试能提前发现 —— E9 单独钉这条。
  it('E8：被砍掉的 22 个键被 strip 且不抛错（灰度期后端多发也不会炸）', () => {
    const legacyExtraKeys = {
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
    };
    expect(Object.keys(legacyExtraKeys)).toHaveLength(22);

    // 正向：后端多发这 22 个键，parse 通过且一个都不留在结果里。
    const parsed = scanPartRowSchema.parse({ ...pickRowFixture, ...legacyExtraKeys });
    for (const key of Object.keys(legacyExtraKeys)) {
      expect(Object.keys(parsed), `${key} 不得成为保留键`).not.toContain(key);
      expect(parsed, `${key} 不得被保留`).not.toHaveProperty(key);
    }
    // 键集仍是 17 个：一个都没被留下，也一个都没挤掉。
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(pickRowFixture).sort());
  });

  // ⚠️ **`location` 的声明一个字都不能动**。`BatchPickerDialog.holderText` 的判据是
  // 「键在不在」（`in`）而不是「值是否 null」：null 是合法取值（尚未上架的 PENDING 批次），
  // 那种场景必须继续显示「未知位置」。值恒为 null，但键恒在。
  // 这条同时钉住 nullable 形态：把 null 换成 undefined（`.optional()`）会让「键在不在」
  // 的判据在部分响应上翻面。
  it('E9：location 键恒在（值可 null、不可缺键）—— BatchPickerDialog holder 行的判据依赖它', () => {
    expect(scanPartRowSchema.parse(pickRowFixture)).toHaveProperty('location');
    expect(Object.keys(scanPartRowSchema.parse(pickRowFixture))).toContain('location');
    expect(scanPartRowSchema.parse(pickRowFixture).location).toBeNull();
    expect(scanPartRowSchema.parse({ ...pickRowFixture, location: '货架 A-01' }).location).toBe(
      '货架 A-01',
    );
    // 缺键必须抛（声明成 `.optional()` 会让上面两条判据在真响应上翻面）。
    const { location: _dropped, ...rest } = pickRowFixture;
    void _dropped;
    expect(() => scanPartRowSchema.parse(rest)).toThrow(ZodError);
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, location: 7 })).toThrow(ZodError);
  });

  // ⚠️ 后端 VO 不存在的键（`next_process_id` 更是后端显式决定「列表响应不暴露」）
  // 不得被声明进 schema —— 声明成必填会让真实响应恒 parse 失败；声明成 optional 则
  // 无害但无意义。这里断言它们**不作为保留键存在**，防止哪天被顺手加进去。
  it('E10：后端行 VO 不存在的 5 个键不被保留', () => {
    const parsed = scanPartRowSchema.parse({
      ...pickRowFixture,
      next_process_id: '190000000000121',
      customer_path: '一级客户/二级客户',
      shelf_code: 'C2',
      next_process_name: '外协工序',
      last_inspection_fail_note: '打回到货架',
    });
    for (const key of [
      'next_process_id',
      'customer_path',
      'shelf_code',
      'next_process_name',
      'last_inspection_fail_note',
    ]) {
      expect(Object.keys(parsed), `${key} 不得成为保留键`).not.toContain(key);
      expect(parsed, `${key} 不得被保留`).not.toHaveProperty(key);
    }
    expect(Object.keys(parsed)).toHaveLength(17);
  });

  // 2026-10-04 工序链四件套的守门。放回页按 chain_state 三态分流（NEXT 免选工序
  // 直接单确认 / TAIL 常驻送检提示 / 其余按 NONE 走原三步）。声明口径是
  // **「带默认值的必输出键」**：缺键降级、坏形态抛（取舍理由见 schemas.ts 该字段注释）。
  it('E11：工序链四件套三态都能 parse，缺键降级、坏形态抛 ZodError', () => {
    // NEXT：有下一道，id / name 都有值
    const next = scanPartRowSchema.parse({
      ...heldRowFixture,
      chain_state: 'NEXT',
      chain_next_process_id: '190000000000131',
      chain_next_process_name: 'CUT-01 下料',
    });
    expect(next.chain_state).toBe('NEXT');
    expect(next.chain_next_process_id).toBe('190000000000131');
    expect(next.chain_next_process_name).toBe('CUT-01 下料');
    // TAIL：链内最后一道 ⇒ id 落兜底值 '0'、下一道工序名 null（键仍在）
    const tail = scanPartRowSchema.parse(heldRowFixture);
    expect(tail.chain_state).toBe('TAIL');
    expect(tail.chain_next_process_id).toBe('0');
    expect(tail.chain_next_process_name).toBeNull();
    expect(tail.chain_current_process_name).toBe('CUT-01 下料');
    // NONE：无链 / 软删 / 指针漂移（取件行的恒定形态）
    expect(scanPartRowSchema.parse(pickRowFixture).chain_state).toBe('NONE');

    // 缺键 → **不抛**，落到「没有下一道」的默认值。守的正是这条降级承诺：后端未上线 /
    // 漏发时，报工台三页必须照常可用（旧路径），而不是在边界抛 ZodError 全页空。
    const bare: Record<string, unknown> = { ...pickRowFixture };
    for (const key of [
      'chain_state',
      'chain_next_process_id',
      'chain_next_process_name',
      'chain_current_process_name',
    ]) {
      delete bare[key];
    }
    const bareParsed = scanPartRowSchema.parse(bare);
    expect(bareParsed.chain_state).toBeUndefined();
    expect(bareParsed.chain_next_process_id).toBe('0');
    expect(bareParsed.chain_next_process_name).toBeNull();
    expect(bareParsed.chain_current_process_name).toBeNull();
    // 枚举外的字面量也放行：后端加第四个 chain_state 是纯后端单方面改动，消费侧窄化
    // 成 NONE 并 warn 一次（见 ScanReturnParts.enterReturnFlow）。
    expect(scanPartRowSchema.parse({ ...pickRowFixture, chain_state: 'SKIP' }).chain_state).toBe(
      'SKIP',
    );

    // 但键在、值形态错仍然抛（默认值只兜「缺键」，不兜「坏形态」）：雪花 id 退化成 number
    // / null 都不是合法 wire 形态。
    expect(() =>
      scanPartRowSchema.parse({ ...pickRowFixture, chain_next_process_id: 190000000000131 }),
    ).toThrow(ZodError);
    expect(() =>
      scanPartRowSchema.parse({ ...pickRowFixture, chain_next_process_id: null }),
    ).toThrow(ZodError);
  });

  // 2026-10-09 后端派生列 `has_process_chain`（列表卡左边框的唯一语义源）。必填且
  // **无默认值**：缺键降级成灰边框与「真无链」不可区分，不如在边界炸出来。
  it('E12：has_process_chain 真假两态过守门；缺键 / 坏形态抛 ZodError', () => {
    expect(scanPartRowSchema.parse(pickRowFixture).has_process_chain).toBe(true);
    expect(scanPartRowSchema.parse(heldRowFixture).has_process_chain).toBe(false);
    expect(
      scanPartRowSchema.parse({ ...pickRowFixture, has_process_chain: false }).has_process_chain,
    ).toBe(false);

    const { has_process_chain: _dropped, ...rest } = wirePickRow;
    void _dropped;
    expect(() => scanPartRowSchema.parse(rest)).toThrow(ZodError);
    for (const bad of [0, 1, 'true', null]) {
      expect(() => scanPartRowSchema.parse({ ...pickRowFixture, has_process_chain: bad })).toThrow(
        ZodError,
      );
    }
  });
});

// ============================================================
// W 组：wire 样本回归锁（样本见上方 `wirePickRow` / `wireHeldRow` 的来源注释）。
//
// 这组与 E 组的关系：E 组锁「schema 对自己那份手写 fixture 的行为」，W 组锁「schema 对
// 采集到的字节形状的行为」。后者才是线上三页会不会报「列表数据格式异常」的决定项。
// ============================================================
describe('W 组：wire 样本过守门（标识字段实测转录 + 其余按契约手写）', () => {
  // 把「样本的键集 == schema 的键集」变成可执行断言：键集不等说明 schema 多声明
  // （strip 掉了后端的键）或少声明（后端的键没进 parse 结果），两种都是契约漂移。
  it('W1：两条路径的样本行都 parse 通过，且键集与样本完全相等（无键被 strip）', () => {
    for (const [label, row] of [
      ['取件 /prod/scan/pickable', wirePickRow],
      ['放回 /prod/scan/held', wireHeldRow],
    ] as const) {
      const parsed = scanPartRowSchema.parse(row);
      expect(Object.keys(row), `${label} 样本键数`).toHaveLength(17);
      expect(Object.keys(parsed).sort(), `${label} 键集`).toEqual(Object.keys(row).sort());
    }
  });

  // 实测的雪花 id / 计数形态：id 与 batch_id 都是 JSON string、batch_version 是 JSON
  // number。这几条把「后端哪天摘掉 serialize_i64」的漂移变成红灯。
  it('W2：样本的批次锚点 —— 两个端点都填（id 为 string、version 为 number）', () => {
    const pick = scanPartRowSchema.parse(wirePickRow);
    expect(typeof pick.batch_id, 'batch_id 必为 string（serialize_i64_opt）').toBe('string');
    expect(pick.batch_id).toBe('226157188089905152');
    expect(typeof pick.batch_version, 'batch_version 必为 number（i32，无序列化器）').toBe(
      'number',
    );
    expect(pick.batch_version).toBe(6);
    const held = scanPartRowSchema.parse(wireHeldRow);
    expect(held.batch_id).toBe('228801248771809280');
    expect(held.batch_version).toBe(2);
    // 反向锁：把实测样本的形态改坏必须被拒（证明 W1 不是恒真断言）。
    expect(() => scanPartRowSchema.parse({ ...wirePickRow, id: 226157188085710848 })).toThrow(
      ZodError,
    );
    expect(() => scanPartRowSchema.parse({ ...wireHeldRow, batch_version: '2' })).toThrow(ZodError);
  });

  // 2026-10-10 起 `planned_delivery_date` 是真实投影值（不再是 `1970-01-01` 占位），
  // 两个日期都在样本上按真实值给：DeliveryDateChip 的数据源是 `system_delivery_date`，
  // `planned_delivery_date` 只作排序键、不上屏。
  it('W3：样本的两个交期字段（真实值 + nullable）过守门', () => {
    const pick = scanPartRowSchema.parse(wirePickRow);
    expect(pick.planned_delivery_date).toBe('2026-11-15');
    expect(pick.system_delivery_date).toBe('2026-12-31');
    // held 的 system 交期可空（chip 显示 '-'，计划交期仍作排序键）
    const held = scanPartRowSchema.parse(wireHeldRow);
    expect(held.system_delivery_date).toBeNull();
    expect(held.planned_delivery_date).toBe('2026-10-20');
    // 反向锁：类型改坏必须被拒（证明上面两条不是恒真断言）
    expect(() =>
      scanPartRowSchema.parse({ ...wirePickRow, system_delivery_date: 20261231 }),
    ).toThrow(ZodError);
    expect(() => scanPartRowSchema.parse({ ...wireHeldRow, planned_delivery_date: null })).toThrow(
      ZodError,
    );
  });

  // 加急件形态：红底 + 「加急」tag + 排序硬优先级三条都读 `is_urgent`，声明错类型
  // （string）时列表还能渲染、但三条全部静默失效。
  it('W4：加急形态过守门，坏形态抛（is_urgent 是 boolean 不是 string）', () => {
    expect(scanPartRowSchema.parse(wirePickRow).is_urgent).toBe(true);
    expect(scanPartRowSchema.parse(wireHeldRow).is_urgent).toBe(false);
    expect(() => scanPartRowSchema.parse({ ...wirePickRow, is_urgent: 'true' })).toThrow(ZodError);
  });

  // 工序链四件套在两个端点上的形态：**取件恒降级值**（候选按工种↔工序映射取，不按链）、
  // **held 填真值**。放回页的分流（NEXT 免选工序 / TAIL 常驻送检提示 / 未知取值按
  // NONE 降级）全靠 chain_state，这条把两端的取值形态钉成可执行断言。
  it('W5：样本的工序链四件套（pickable 恒 NONE/0/null/null；held 填 TAIL 真值）', () => {
    const pick = scanPartRowSchema.parse(wirePickRow);
    expect(pick.chain_state).toBe('NONE');
    expect(pick.chain_next_process_id).toBe('0');
    expect(pick.chain_next_process_name).toBeNull();
    expect(pick.chain_current_process_name).toBeNull();
    expect(pick.process_chain_id, '取件行的 process_chain_id 恒 null').toBeNull();
    const held = scanPartRowSchema.parse(wireHeldRow);
    expect(held.chain_state).toBe('TAIL');
    expect(held.chain_next_process_id).toBe('0');
    expect(held.chain_next_process_name).toBeNull();
    expect(held.chain_current_process_name).toBe('CUT-01 下料');
    expect(held.process_chain_id, 'held 的 process_chain_id 填真值').toBe('226157188099400000');
  });

  // 整信封走一遍：实测信封的四个计数在 wire 上就是 JSON number（不是字符串）。
  // ⚠️ 上一版 api 层用过 `normalizeListResult` 把字符串计数强转成 number；按新契约
  // 计数就是裸 i64 → JSON number，守门直接拒收字符串形态（漂移可见，不被静默掩盖）。
  it('W6：真实信封过守门；计数必须是 number（字符串计数被拒）', () => {
    const parsed = scanPartListResultSchema.parse({
      items: [wirePickRow],
      total: 274,
      limit: 200,
      offset: 0,
    });
    expect(typeof parsed.total).toBe('number');
    expect(parsed.total).toBe(274);
    expect(parsed.items).toHaveLength(1);
    const held = scanPartListResultSchema.parse({
      items: [wireHeldRow],
      total: 4,
      limit: 200,
      offset: 0,
    });
    expect(held.total).toBe(4);
    expect(() =>
      scanPartListResultSchema.parse({ items: [wirePickRow], total: '274', limit: 200, offset: 0 }),
    ).toThrow(ZodError);
  });
});

// ============================================================
// G 组：api 层**不做**守门（分层取价的负向守卫）。
//
// CLAUDE.md 的分层取舍：守门 schema 随报工台视图目录走，api 层 import 它就是
// api → views 的反向依赖；故 api 函数一律原样返回 `resp.data`，守门在 queryFn /
// mutationFn（报工台自己的 spec 守「parse 真的接在返回路径上」）。
//
// 这组守的正是「**别把 parse 搬回 api 层**」：一旦有人为了图省事在 helper 里加回
// `.parse()`，这里会红 —— 那会让报工台的守门 schema 与 api 模块产生硬依赖，
// 而 api 层每个消费方（将来若别的域也调这 5 个端点）都会被拖着走一份报工台的
// 行 VO 契约。
// ============================================================
describe('G 组：api 层原样透传，不在 API 边界 parse', () => {
  it('G1：坏响应（行是空对象）经 helper 原样吐出，不被 api 层吞掉也不被静默接受', async () => {
    httpGetMock.mockReset();
    httpGetMock.mockResolvedValue({ data: { items: [{}], total: 1, limit: 200, offset: 0 } });
    // 原样透传 ⇒ 消费侧拿到的就是后端那个空行，由守门点去炸。
    await expect(fetchScanPickable({ workTypeId: WORK_TYPE_ID })).resolves.toEqual({
      items: [{}],
      total: 1,
      limit: 200,
      offset: 0,
    });
    // 裸数组同样原样透传（历史上真实发生过的故障形态：helper 把信封当数组吐出去）。
    httpGetMock.mockReset();
    httpGetMock.mockResolvedValue({ data: [pickRowFixture] });
    await expect(fetchScanHeld({ workerId: WORKER_ID })).resolves.toEqual([pickRowFixture]);
  });

  it('G2：合法信封经 helper 拿到的就是 items / total（证明 G1 不是恒真断言）', async () => {
    httpGetMock.mockReset();
    httpGetMock.mockResolvedValue({
      data: { items: [pickRowFixture], total: 1, limit: 200, offset: 0 },
    });
    const pick = await fetchScanPickable({ workTypeId: WORK_TYPE_ID });
    expect(Array.isArray(pick.items)).toBe(true);
    expect(pick.total).toBe(1);
    expect(pick.items[0]!.batch_id).toBe('190000000000111');
  });

  // 写端点同样不做 parse：worker-scan 的 `scan.event_type` 分支与 `refill.taken[]`
  // 都在 mutationFn 之后由调用方读，api 层不预判。
  it('G3：worker-scan 的响应原样透传（含 refill 段）', async () => {
    const wire = {
      scan: {
        worker_id: WORKER_ID,
        part_id: '190000000000101',
        batch_id: BATCH_ID,
        event_type: 'WORKER_SCAN_INSPECTED',
        synced_assembly_id: null,
      },
      refill: { worker_id: WORKER_ID, shelf_id: '190000000000009', taken: [], pool_empty: true },
    };
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: wire });
    await expect(
      scanWorker({ serial_no: 'F2256', badge_code: 'W-001', event_type: 'RETURNED' }),
    ).resolves.toEqual(wire);
  });
});
