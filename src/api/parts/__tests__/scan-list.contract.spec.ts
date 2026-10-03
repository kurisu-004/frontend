// src/api/parts/__tests__/scan-list.contract.spec.ts
//
// 2026-10-04 新增：报工台三页（取件 / 放回 / 送检）两个**读**端点的 URL + 出参契约守卫。
//
// 为什么必须有这个文件（本次线上故障的根因与症状）：
//   `GET /parts/pickable-by-work-type/{work_type_id}`（取件）与
//   `GET /parts/by-worker/{worker_id}`（放回 / 送检 / HeldPartsBadge）两个后端端点
//   返回的都是**分页信封**（`PartListOut`：items / total / limit / offset），行 VO 是
//   `PartListItem`。两个 api helper 却把 `resp.data` 当裸数组原样抛出，视图层又
//   直接把返回值当数组用（`useScanPartsSort` 里 `[...list]` 展开）⇒ 抛
//   `TypeError: list is not iterable`，取件 / 放回 / 送检**三页的 `v-for` 同时渲染失败**。
//   换句话说：形状不符时前端**收不到任何可显示的信号**，只有整页空白。
//
//   失守的是**契约测试**这一层 —— 故障形态的两半各缺一处守卫，缺一不可：
//   ① URL / query 侧：`src/api/parts/__tests__/routes.spec.ts` 只钉**写**端点路径，
//      这两个**读**端点在该文件里一条断言都没有（对 `listPartsByWorkTypeAllShelves`
//      / `listPartsHeldByWorker` 零命中）。分页参数有没有真发出去、路径有没有被
//      误迁到别的域，全靠人眼。
//   ② API 边界侧：守门此前只存在于 schema 自身（`schemas.spec.ts` 的 S-SP 系列），
//      证明不了 `.parse()` 真的接在两个 helper 的返回路径上 —— 把它整段删掉，
//      既有 spec 全绿而线上三页全崩。
//   本文件 A 组补 ①、E 组补 schema 侧的「键集逐字段相等」、F 组补 ②。
//
//   2026-10-04 追加 W 组（真实 wire 样本）：E 组的两份 fixture 与 `scanPartRowSchema`
//   **同源**（都照后端 VO 源码手写），只能证明「schema 接受自己那份手写形状」，证明不了
//   「schema 接受真实响应」。schema 误拒合法响应的产线症状是「列表数据格式异常，请截图
//   上报」—— 与本次「加载不出」不同，它把排查方向指歪。W 组用实测响应体转录的样本
//   补上这一维（详见 W 组上方注释）。
//
// mock 手法沿 src/api/__tests__/outsource.contract.spec.ts 同款：整模块桩掉 `@/api/http`
// （不 importOriginal），只留 api.get / api.post / cleanParams / normalizeListResult。
//
// ⚠️ 这里**刻意不桩掉** `@/composables/queries/schemas`（与 routes.spec.ts 相反）：
// A 组用的响应是合法的空信封，真 schema 能 parse 通过，于是同一个文件里 E 组可以直接
// import **真 schema** 验证守门本身 —— 桩掉它会让「parse 抛错」这批断言全部变成空断言
// （对着 no-op 桩 parse 永远不抛）。
//
// ⚠️ `cleanParams` / `normalizeListResult` 在本文件里是**语义复刻**而非恒等函数
// （`src/api/http.ts` 的实现逐条照搬）。理由：A6（falsy 的 `offset: 0` 必须仍出现在
// params 里）与 F3b（字符串计数经 `normalizeListResult` 变 number）要成立，恒等桩会让
// 这两条退化成恒真断言。代价是复刻体与真实实现存在漂移可能 —— 二者的过滤/强转规则若
// 在 `src/api/http.ts` 侧变更，本文件的复刻体须同步。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { scanPartListResultSchema, scanPartRowSchema } from '@/composables/queries/schemas';

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
  // 逐条复刻 `src/api/http.ts::normalizeListResult`：三个计数无条件过 Number()。
  normalizeListResult: (v: unknown) => {
    const r = v as {
      items: unknown[];
      total: string | number;
      limit: string | number;
      offset: string | number;
    };
    return {
      items: r.items,
      total: Number(r.total),
      limit: Number(r.limit),
      offset: Number(r.offset),
    };
  },
}));

import { listPartsByWorkTypeAllShelves, listPartsHeldByWorker } from '../crud';

const WORK_TYPE_ID = '190000000000001';
const WORKER_ID = '190000000000002';

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

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

describe('A 组：报工台两个读端点的 URL 与 query 逐字钉死', () => {
  it('A1：取件列表 = /parts/pickable-by-work-type/{work_type_id}（workTypeId 走 encodeURIComponent）', async () => {
    expect(await fetchedPath(() => listPartsByWorkTypeAllShelves(WORK_TYPE_ID))).toBe(
      `/parts/pickable-by-work-type/${WORK_TYPE_ID}`,
    );
    // 后端 `Path<i64>` 不会真收到带特殊字符的 id，这条断言守的是「路径参数被编码」
    // 这条代码路径本身：漏掉 encodeURIComponent 时，第一个断言在无特殊字符的 id 上
    // 仍会绿，这条会红。
    expect(await fetchedPath(() => listPartsByWorkTypeAllShelves('wt id/1'))).toBe(
      '/parts/pickable-by-work-type/wt%20id%2F1',
    );
  });

  it('A2：放回 / 送检列表 = /parts/by-worker/{worker_id}（workerId 走 encodeURIComponent）', async () => {
    expect(await fetchedPath(() => listPartsHeldByWorker(WORKER_ID))).toBe(
      `/parts/by-worker/${WORKER_ID}`,
    );
    expect(await fetchedPath(() => listPartsHeldByWorker('wt id/1'))).toBe(
      '/parts/by-worker/wt%20id%2F1',
    );
  });

  // 反断言：这两个**读**端点留在 part 域。批次**写**端点（place-on-shelf / pick-up /
  // worker-scan / send-to-outsource / …）已整体迁到 prod 域，见同仓
  // src/api/parts/__tests__/routes.spec.ts；把读端点跟着搬走会 404，且后端 VO 与
  // 路由分域无关（都在 part 域的 PartListOut）。
  it('A3：两个 URL 都不得出现 /prod/ 前缀（读端点留在 part 域）', async () => {
    expect(await fetchedPath(() => listPartsByWorkTypeAllShelves(WORK_TYPE_ID))).not.toContain(
      '/prod/',
    );
    expect(await fetchedPath(() => listPartsHeldByWorker(WORKER_ID))).not.toContain('/prod/');
  });

  // 后端两个 service 都是 `limit.unwrap_or(50).clamp(1, 200)`：不传 limit 静默只返 50 条。
  // 传了必须真的发出去，否则报工台会「看起来正常、少一半候选件」。
  it('A4：分页参数照传（limit / offset 进 query，两个函数都测）', async () => {
    const pick = await fetchedRequest(() =>
      listPartsByWorkTypeAllShelves(WORK_TYPE_ID, { limit: 200, offset: 20 }),
    );
    expect(pick.params).toEqual({ limit: 200, offset: 20 });
    const held = await fetchedRequest(() =>
      listPartsHeldByWorker(WORKER_ID, { limit: 200, offset: 20 }),
    );
    expect(held.params).toEqual({ limit: 200, offset: 20 });
  });

  it('A5：分页参数缺省时 params 为空（不得凭空出现 limit / offset 键）', async () => {
    const pick = await fetchedRequest(() => listPartsByWorkTypeAllShelves(WORK_TYPE_ID));
    expect(pick.params).toEqual({});
    const held = await fetchedRequest(() => listPartsHeldByWorker(WORKER_ID));
    expect(held.params).toEqual({});
  });

  // offset: 0 是「第一页」的合法值。helper 若自己手搓过滤（`if (offset) …`）把它吃掉，
  // 症状是翻页永远停第一页，且没有任何报错。
  it('A6：falsy 的 offset: 0 仍然出现在 params 里', async () => {
    const pick = await fetchedRequest(() =>
      listPartsByWorkTypeAllShelves(WORK_TYPE_ID, { limit: 200, offset: 0 }),
    );
    expect(pick.params).toEqual({ limit: 200, offset: 0 });
    expect(pick.params).toHaveProperty('offset', 0);
    const held = await fetchedRequest(() =>
      listPartsHeldByWorker(WORKER_ID, { limit: 200, offset: 0 }),
    );
    expect(held.params).toEqual({ limit: 200, offset: 0 });
    expect(held.params).toHaveProperty('offset', 0);
  });
});

// ============================================================
// E 组：schema 守门有效性回归锁。
//
// ⚠️ Zod 默认 `z.object()` 是 **strip** 模式：schema 里没声明的键被**静默丢弃**、
// parse 不报错 —— 守门形同虚设。所以每条都要求「一份完整合法 fixture parse 通过」
// +「缺分页字段 / 类型错 / 裸数组时 parse 抛错」双向锁死。
//
// 下面 2 份 fixture 是后端 `PartListItem`（backend-rust
// `src/modules/part/vo/part.rs::PartListItem`）的**完整 34 字段集**，逐字照抄 VO 结构。
// 「fixture 写全」本身不构成守卫 —— 多出来的键会被 strip 静默吞掉、parse 不报错；
// 真正把「schema 声明的字段集 == VO 字段集」钉死的是 E7 的键集断言。
// ============================================================

/**
 * 取件行 fixture（`GET /parts/pickable-by-work-type/{work_type_id}` 的行）。
 *
 * 值按该端点 service 的真实填充口径给（backend-rust
 * `src/modules/part/service/phase1/work_type.rs::list_pickable_by_work_type`
 * 显式构造 `TPart` + `PartListItem::from`）：申请人为空串 / 两个日期写死
 * `1970-01-01` / `customer_id` 写死 0 / `status` 写死 `IN_PROCESS` /
 * `is_urgent` 写死 false / 单价总价写死 0 / part 级 `version` 写死 0 /
 * `created_at` 是 epoch；派生字段（客户名 / 位置 / 持有人）恒 null，
 * `row_type` 恒 `'PART'`（`From<TPart>` 派生）。雪花 id 全是 JSON string。
 * 唯独 `batch_id` / `batch_version` 有值 —— 全仓只有取件端点填批次锚点。
 */
const pickRowFixture = {
  id: '190000000000101',
  serial_no: 'SN-PICK-1',
  name: '零件甲',
  drawing_no: 'DWG-1',
  applicant_name: '',
  quantity: 10,
  request_date: '1970-01-01',
  planned_delivery_date: '1970-01-01',
  customer_id: '0',
  assembly_id: null,
  status: 'IN_PROCESS',
  is_urgent: false,
  order_no: null,
  system_delivery_date: null,
  note: null,
  unit_price: '0',
  total_price: '0',
  version: 0,
  created_at: '1970-01-01T00:00:00',
  created_by: null,
  updated_at: '1970-01-01T00:00:00',
  updated_by: null,
  deleted_at: null,
  process_chain_id: null,
  customer_name: null,
  l1_customer_name: null,
  location: null,
  holder_name: null,
  row_type: 'PART',
  has_children: false,
  child_count: null,
  has_cnc_program: false,
  batch_id: '190000000000111',
  batch_version: 3,
};

/** 放回 / 送检行 fixture（`GET /parts/by-worker/{worker_id}`）：与取件行同 VO，唯批次锚点恒 null。 */
const heldRowFixture = {
  ...pickRowFixture,
  id: '190000000000102',
  batch_id: null,
  batch_version: null,
};

// ============================================================
// W 组：**真实 wire 样本**（2026-10-04 实测）—— 与 E 组的 fixture 是两种不同性质的证据。
//
// E 组那两份 fixture 是**照后端 VO 源码手写**的，而 `scanPartRowSchema` 同样是照那份
// 源码手写的 ⇒ 两者同源。这批用例只能证明「schema 接受自己那份手写形状」，**证明不了
// 「schema 接受后端真实吐出的形状」**：把 schema 的某个声明改错（多声明一个必填键、
// 把 Decimal 当 number、把 `serialize_i64` 当 number），E 组全绿而线上三页全部报
// 「列表数据格式异常，请截图上报」。
//
// W 组补的就是这一维：下面两个对象是 `GET /parts/pickable-by-work-type/208472998548602880`
// 与 `GET /parts/by-worker/208473192891678720` 的**响应体逐字转录**（dev 库，2026-10-04），
// 不是照源码推出来的。取值口径（雪花 id 形态 / Decimal 字符串 / 两个日期占位符 /
// 批次锚点有无）与真实响应完全一致，可直接与后端日志对账。
//
// 采集方式：e2e seed 一个 MANAGER 账号 → `POST /iam/login` 取 token → 带
// `Authorization: Bearer` 打两个 GET（`?limit=200&offset=0`）→ 落盘响应体。
// 取件路径 200 行 / 放回路径 4 行**逐行** `scanPartRowSchema.parse()` 全部通过（0 失败），
// 且 204 行的键集**完全一致**（34 键，无一行缺键、无一个键被 strip）。
// ============================================================

/** 取件行真实样本：`GET /parts/pickable-by-work-type/{work_type_id}` 的 `data.items[0]`，逐字转录。 */
const wirePickRow = {
  id: '226157188085710848',
  serial_no: 'F2256',
  name: 'E42BD20009014101',
  drawing_no: 'E42BD20009014101',
  applicant_name: '',
  quantity: 2,
  request_date: '1970-01-01',
  planned_delivery_date: '1970-01-01',
  customer_id: '0',
  assembly_id: null,
  status: 'IN_PROCESS',
  is_urgent: false,
  order_no: null,
  system_delivery_date: null,
  note: null,
  unit_price: '0',
  total_price: '0',
  version: 0,
  created_at: '1970-01-01T00:00:00',
  created_by: null,
  updated_at: '1970-01-01T00:00:00',
  updated_by: null,
  deleted_at: null,
  process_chain_id: null,
  customer_name: null,
  l1_customer_name: null,
  location: null,
  holder_name: null,
  row_type: 'PART',
  has_children: false,
  child_count: null,
  has_cnc_program: false,
  batch_id: '226157188089905152',
  batch_version: 6,
};

/** 放回 / 送检行真实样本：`GET /parts/by-worker/{worker_id}` 的 `data.items[0]`，逐字转录。 */
const wireHeldRow = {
  id: '228801248768294912',
  serial_no: 'F2475',
  name: 'E42703FZJ294500',
  drawing_no: 'E42703FZJ294500',
  applicant_name: '',
  quantity: 2,
  request_date: '1970-01-01',
  planned_delivery_date: '1970-01-01',
  customer_id: '0',
  assembly_id: null,
  status: 'IN_PROCESS',
  is_urgent: false,
  order_no: null,
  system_delivery_date: null,
  note: null,
  unit_price: '0',
  total_price: '0',
  version: 0,
  created_at: '1970-01-01T00:00:00',
  created_by: null,
  updated_at: '1970-01-01T00:00:00',
  updated_by: null,
  deleted_at: null,
  process_chain_id: null,
  customer_name: null,
  l1_customer_name: null,
  location: null,
  holder_name: null,
  row_type: 'PART',
  has_children: false,
  child_count: null,
  has_cnc_program: false,
  batch_id: null,
  batch_version: null,
};

describe('E 组：scanPartRowSchema / scanPartListResultSchema 的守门有效性', () => {
  it('E1：合法 fixture 组成完整信封 parse 通过（34 字段行 + 四个分页键）', () => {
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

  // ⚠️ 本次线上故障的形态：helper 把分页信封当裸数组吐出去，视图层 `[...list]` 抛
  // TypeError。这条是防复发最关键的一条 —— 守门必须在 API 边界就拒收裸数组。
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

  it('E4：占位符归一 —— 1970-01-01 → null，真实日期原样透传', () => {
    const placeholder = scanPartRowSchema.parse(pickRowFixture);
    expect(placeholder.planned_delivery_date).toBeNull();
    expect(placeholder.request_date).toBeNull();
    // 真实日期不得被误伤（后端将来补上真投影就自动恢复，不靠改 schema）
    const real = scanPartRowSchema.parse({
      ...pickRowFixture,
      planned_delivery_date: '2026-12-31',
      request_date: '2026-01-05',
    });
    expect(real.planned_delivery_date).toBe('2026-12-31');
    expect(real.request_date).toBe('2026-01-05');
  });

  // 取件行（批次锚点有值）与放回 / 送检行（恒 null）是同一 VO 的两种填充口径。
  // 只测一种会让另一种在生产里炸 —— 放回 / 送检两页正靠 null 判定「无批次锚点」。
  it('E5：取件行与放回行（批次锚点有值 / 恒 null）都 parse 通过', () => {
    expect(scanPartRowSchema.parse(pickRowFixture).batch_id).toBe('190000000000111');
    expect(scanPartRowSchema.parse(pickRowFixture).batch_version).toBe(3);
    expect(scanPartRowSchema.parse(heldRowFixture).batch_id).toBeNull();
    expect(scanPartRowSchema.parse(heldRowFixture).batch_version).toBeNull();
    expect(
      scanPartListResultSchema.parse({
        items: [pickRowFixture, heldRowFixture],
        total: 2,
        limit: 200,
        offset: 0,
      }).items,
    ).toHaveLength(2);
  });

  it('E6：字段类型错 → parse 抛 ZodError（雪花 id 必为 string，Decimal 必为 string）', () => {
    // 雪花 id 退化成 number（后端某天漏了 serialize_i64）必须被抓出来，不能靠 coerce 掩盖
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, id: 190000000000101 })).toThrow(
      ZodError,
    );
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, batch_id: 190000000000111 })).toThrow(
      ZodError,
    );
    // Decimal 退化成 number（后端漏了 rust_decimal::serde::str）
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, unit_price: 12.5 })).toThrow(
      ZodError,
    );
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, total_price: 125 })).toThrow(
      ZodError,
    );
    // 布尔与数值同理
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, is_urgent: 'false' })).toThrow(
      ZodError,
    );
    expect(() => scanPartRowSchema.parse({ ...pickRowFixture, batch_version: '3' })).toThrow(
      ZodError,
    );
  });

  // 「fixture 写全」本身不构成守卫：Zod strip 会把 schema 没声明的键静默吞掉、parse 照过
  // 不误。这条把「schema 声明的字段集 == 后端 VO 字段集」变成可执行断言：
  //   · schema 少声明 → parse 结果少键 → 与 fixture 键集不等 → 红；
  //   · schema 多声明一个**必填**字段 → 输入缺该键即 parse 抛错，键集断言也红；
  //   · schema 多声明一个 **optional** 字段 → 键集断言看不见（Zod 对输入中缺省的
  //     optional 键不写入输出）。该失败模式本身无害（不会误拒任何响应，也不会有字段
  //     被静默吞掉），故不为它额外设计断言。
  it('E7：parse 后的行键集与后端 PartListItem 的 34 字段逐字段相等', () => {
    expect(Object.keys(pickRowFixture).length, 'fixture 字段数（后端 VO 漂移也会红）').toBe(34);
    expect(Object.keys(scanPartRowSchema.parse(pickRowFixture)).sort()).toEqual(
      Object.keys(pickRowFixture).sort(),
    );
  });

  // 反向锁：这 5 个键后端 VO 里**根本不存在**（`next_process_id` 更是后端显式决定
  // 「列表响应不暴露」，见 vo/part.rs::PartListItem 该字段处的注释）。把它们声明成必填
  // 会让真实响应恒 parse 失败；声明成 optional 则无害但无意义。这里断言它们在 parse
  // 结果里**不作为保留键存在**（Zod strip）—— 防止哪天被顺手加进 schema 变成必填。
  it('E8：后端 VO 不存在的 5 个键不被保留（next_process_id / customer_path / shelf_code / next_process_name / last_inspection_fail_note）', () => {
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
    expect(Object.keys(parsed)).toHaveLength(34);
  });
});

// ============================================================
// W 组：真实 wire 样本回归锁（样本见上方 `wirePickRow` / `wireHeldRow` 的来源注释）。
//
// 这组与 E 组的关系：E 组锁「schema 对自己那份手写 fixture 的行为」，W 组锁「schema 对
// 后端真实吐出的字节形状的行为」。后者才是线上三页会不会报「列表数据格式异常」的决定项。
// ============================================================
describe('W 组：真实 wire 样本（2026-10-04 实测响应）过守门', () => {
  // 实测结论：两个端点共 204 行逐行 parse 全部通过。这条把「取件 / 放回 两条真实路径
  // 的行都被真 schema 接受」钉成可执行断言 —— 之前它只存在于一次人工核对里。
  it('W1：两条路径的真实行都 parse 通过，且键集与真实响应完全相等（无键被 strip）', () => {
    for (const [label, row] of [
      ['取件 pickable-by-work-type', wirePickRow],
      ['放回 by-worker', wireHeldRow],
    ] as const) {
      const parsed = scanPartRowSchema.parse(row);
      // 实测两个端点的行都恰好 34 键；键集不等说明 schema 多声明（strip 掉了后端的键）
      // 或少声明（后端的键没进 parse 结果），两种都是契约漂移。
      expect(Object.keys(row), `${label} 真实样本键数`).toHaveLength(34);
      expect(Object.keys(parsed).sort(), `${label} 键集`).toEqual(Object.keys(row).sort());
    }
  });

  // 两个 transform 的实测值：真实响应里两个日期**恒为占位符字符串 '1970-01-01'**
  // （不是 null、不是缺键）—— 归一后必须变 null，否则 DeliveryDateChip 会显示
  // 「01/01 · 已逾期 2 万多天」。反之字段本身仍必填（键恒在，值为字符串）。
  it('W2：真实样本的两个日期是占位符字符串，归一后为 null', () => {
    expect(wirePickRow.request_date).toBe('1970-01-01');
    expect(wirePickRow.planned_delivery_date).toBe('1970-01-01');
    const pick = scanPartRowSchema.parse(wirePickRow);
    expect(pick.request_date).toBeNull();
    expect(pick.planned_delivery_date).toBeNull();
    const held = scanPartRowSchema.parse(wireHeldRow);
    expect(held.request_date).toBeNull();
    expect(held.planned_delivery_date).toBeNull();
  });

  // 实测的批次锚点口径（与 VO 文档一致，两条路径方向相反）：
  //   取件行 batch_id 是 18 位雪花字符串 / batch_version 是 JSON number；
  //   放回行两者恒 null。放回 / 送检两页正靠 null 判定「无批次锚点」。
  it('W3：真实样本的批次锚点 —— 取件行有值（string + number），放回行恒 null', () => {
    const pick = scanPartRowSchema.parse(wirePickRow);
    expect(typeof pick.batch_id, '取件 batch_id 必为 string（serialize_i64_opt）').toBe('string');
    expect(pick.batch_id).toBe('226157188089905152');
    expect(typeof pick.batch_version, '取件 batch_version 必为 number（i32，无序列化器）').toBe(
      'number',
    );
    expect(pick.batch_version).toBe(6);
    const held = scanPartRowSchema.parse(wireHeldRow);
    expect(held.batch_id).toBeNull();
    expect(held.batch_version).toBeNull();
  });

  // 实测的雪花 id / Decimal 形态：id 与 customer_id 都是 JSON string（customer_id 虽是
  // 写死 0 也照样被 serialize_i64 编成 "0"，不是数字 0），Decimal 是字符串 "0"。
  // 这几条把「后端哪天摘掉 serialize_i64 / rust_decimal::serde::str」的漂移变成红灯。
  it('W4：真实样本的雪花 id 与 Decimal 形态（id/customer_id 为 string，Decimal 为 string）', () => {
    const pick = scanPartRowSchema.parse(wirePickRow);
    expect(typeof pick.id).toBe('string');
    expect(typeof pick.customer_id).toBe('string');
    expect(pick.customer_id).toBe('0');
    expect(typeof pick.unit_price).toBe('string');
    expect(typeof pick.total_price).toBe('string');
    expect(pick.unit_price).toBe('0');
    expect(pick.total_price).toBe('0');
    // 反向锁：把真实样本的形态改坏必须被拒（证明 W1 不是恒真断言）。
    expect(() => scanPartRowSchema.parse({ ...wirePickRow, id: 226157188085710848 })).toThrow(
      ZodError,
    );
    expect(() => scanPartRowSchema.parse({ ...wireHeldRow, total_price: 0 })).toThrow(ZodError);
  });

  // 整信封走一遍：实测信封的四个计数在 wire 上就是 JSON number（不是字符串），
  // 经 `normalizeListResult` 的 Number() 之后再过 schema。
  it('W5：真实信封（items/total/limit/offset）过守门，计数是 number', () => {
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
  });
});

// ============================================================
// F 组：守门**挂在 API 边界** —— 从 api helper 走进去，喂坏响应，期待 reject。
//
// 为什么必须走 helper 而不是只测 schema：E 组在隔离环境里 import 真 schema 直接 parse，
// 锁的是「schema 自身行为」；它证明不了 `.parse()` 真的接在两个 helper 的返回路径上。
// 把 helper 里的 `.parse()` 整段删掉（只留 `normalizeListResult(...)`）时 E 组仍全绿 ——
// 守门被拆掉而测试无感，这正是本次故障的形态（裸数组被原样吐出去，无人拦）。
//
// 坏响应取两种最有代表性的形态：
//   ① 裸数组（把分页信封当数组用，即本次故障的形态）
//   ② 信封在但行是空对象（后端 VO 换字段 / 字段名漂移）
// ============================================================

/** 让下一次读请求返回指定的响应体。 */
function respondWith(data: unknown): void {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data });
}

describe('F 组：两个 list helper 真的在 API 边界 reject 坏响应', () => {
  it('F1：裸数组响应 → 两个 helper 全部 reject（不把数组当信封吐出去）', async () => {
    respondWith([pickRowFixture]);
    await expect(listPartsByWorkTypeAllShelves(WORK_TYPE_ID)).rejects.toThrow(ZodError);
    respondWith([heldRowFixture]);
    await expect(listPartsHeldByWorker(WORKER_ID)).rejects.toThrow(ZodError);
  });

  it('F2：信封在但行是空对象 → 两个 helper 全部 reject（漏声明字段不会被静默放过）', async () => {
    respondWith({ items: [{}], total: 1, limit: 200, offset: 0 });
    await expect(listPartsByWorkTypeAllShelves(WORK_TYPE_ID)).rejects.toThrow(ZodError);
    await expect(listPartsHeldByWorker(WORKER_ID)).rejects.toThrow(ZodError);
  });

  // 正向对照：合法信封必须**放行**。没有这条，F 组可能整体因为桩坏掉而恒绿。
  it('F3：合法分页信封 → 两个 helper 全部 resolve 出 items / total', async () => {
    respondWith({ items: [pickRowFixture], total: 1, limit: 200, offset: 0 });
    const pick = await listPartsByWorkTypeAllShelves(WORK_TYPE_ID);
    expect(Array.isArray(pick.items)).toBe(true);
    expect(typeof pick.total).toBe('number');
    expect(pick.total).toBe(1);
    expect(pick.items[0]!.batch_id).toBe('190000000000111');

    respondWith({ items: [heldRowFixture], total: 2, limit: 200, offset: 0 });
    const held = await listPartsHeldByWorker(WORKER_ID);
    expect(Array.isArray(held.items)).toBe(true);
    expect(typeof held.total).toBe('number');
    expect(held.total).toBe(2);
    expect(held.items[0]!.batch_id).toBeNull();
  });

  // F3 的加强：证明 helper 的返回**不是** `resp.data` 原样透传 —— 计数过
  // `normalizeListResult`（字符串 → number）后再交给 schema（`z.number()`，不吃 string）。
  // 把两个 helper 里的 `normalizeListResult(...)` 包装整段删掉，本条会红。
  it('F3b：字符串计数经 normalizeListResult 归一后才过守门（证明非原样透传）', async () => {
    respondWith({ items: [pickRowFixture], total: '7', limit: '200', offset: '0' });
    const pick = await listPartsByWorkTypeAllShelves(WORK_TYPE_ID);
    expect(pick.total).toBe(7);
    expect(typeof pick.total).toBe('number');
    respondWith({ items: [heldRowFixture], total: '7', limit: '200', offset: '0' });
    expect((await listPartsHeldByWorker(WORKER_ID)).total).toBe(7);
  });
});
