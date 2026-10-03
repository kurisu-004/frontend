// src/api/shelfPickers.spec.ts
//
// 2026-10-02 新增：共享 HMI 卡片网格 **picker 两个端点**（`for-return` /
// `for-inspection`）的契约级回归守卫。与 `shelfProcesses.spec.ts`（映射域）刻意分文件：
// 两个域的失败模式完全不同，混在一个 describe 里会让人以为货架域只有映射契约。
//
// 为什么必须有这个文件：
//   `listShelvesForInspection()` 曾把返回类型声明成 `ShelfForReturnResult` —— 而后端
//   两个 VO **形状不同**（for-return 有 is_recommended，for-inspection 有 is_active）。
//   这个类型谎言在编译期完全无害，在运行时才现形：品检路径会去读一个后端不返的字段。
//   本文件把「两个端点返回两种形状」钉成可执行断言，挡住未来再次混用。
//
// 覆盖对齐 backend-rust：
//   - docs/api/shelves.md:189-202（for-inspection 端点 + 响应字段表 + 业务规则）
//   - src/modules/shelf/vo/shelf.rs（两个 Item VO）
//   - src/modules/shelf/service/picker.rs::list_for_inspection（查询条件 / 不过滤 scope）
//   - src/auth/rbac.rs:131-137（require_any_role → 40300 FORBIDDEN）
//
// mock 手法沿 `shelfProcesses.spec.ts` 同款：整模块桩掉 `@/api/http`（不
// importOriginal），只保留 `api.get` / `api.post` + `cleanParams`（shelves.ts 实际
// import 的就这两个）。理由见 shelfProcesses.spec.ts 文件头 M-4 订正：真实理由是
// 整模块桩才能对「URL + query」逐字断言，而不是 http.ts 在 node 下不能用。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import { listShelvesForInspection, listShelvesForReturn } from './shelves';

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('2026-10-02：picker 两个端点契约（shelves.ts for-return / for-inspection）', () => {
  it('P1：listShelvesForInspection 打的是 /shelves/for-inspection，且不带任何 query', async () => {
    // 路径守卫：两个 picker 端点路径只差一个词，抄错 / 串台都不会编译报错
    // （都是 `api.get<...>('/shelves/...')`）。逐字钉死。
    httpGetMock.mockResolvedValue({ data: { items: [] } });

    await listShelvesForInspection();

    // 本端点**无 query 参数**（后端 handler 不接 Query<...>），故断言整个调用元组
    // 只有 URL —— 若将来有人「顺手补上」next_process_id，这条会红。
    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock).toHaveBeenCalledWith('/shelves/for-inspection');
    expect(httpGetMock.mock.calls[0]).toHaveLength(1);
  });

  it('P2：listShelvesForInspection 逐字消费 VO，不依赖 is_recommended', async () => {
    // 本条是本文件的核心：模拟后端 ShelfForInspectionOut 的**真实**响应体，断言
    // 消费侧拿到它时不需要 for-return 独有的 is_recommended 就能工作 —— 即「品检架
    // 没有推荐语义」是合法状态，不是契约破损。
    // current_load 单独由 P2b 覆盖（后端同轮补的聚合，两种部署顺序都要过）。
    httpGetMock.mockResolvedValue({
      data: {
        items: [
          {
            id: '8800000000001',
            code: 'SH-I01',
            name: '品检架 1',
            zone: 'INSPECTION',
            location: 'A 区 3 层',
            is_active: true,
          },
          {
            id: '8800000000002',
            code: 'SH-I02',
            name: '品检架 2',
            zone: 'INSPECTION',
            location: null,
            is_active: true,
          },
        ],
      },
    });

    const r = await listShelvesForInspection();

    expect(r.items).toHaveLength(2);
    // 逐字等于后端响应（前端不做投影 / 不补字段 —— 补字段正是本轮要消灭的谎报）。
    expect(r.items[0]).toEqual({
      id: '8800000000001',
      code: 'SH-I01',
      name: '品检架 1',
      zone: 'INSPECTION',
      location: 'A 区 3 层',
      is_active: true,
    });
    // 反向断言：响应里就**没有** for-return 独有的 is_recommended，类型层也**不许**
    // 它在品检侧存在（拾进来会驱动出一套品检架根本不提供的推荐逻辑）。
    expect(r.items[0]).not.toHaveProperty('is_recommended');
    // location 可空（后端 Option<String>）—— 消费侧 `s.location || undefined` 依赖这条。
    expect(r.items[1]?.location).toBeNull();
    // 公共字段（卡片网格真正消费的 5 个）在品检侧同样存在，dialog 模板可零断言共用。
    expect(r.items.map((s) => s.code)).toEqual(['SH-I01', 'SH-I02']);
    expect(r.items.map((s) => s.id)).toEqual(['8800000000001', '8800000000002']);
    expect(r.items.every((s) => s.zone === 'INSPECTION')).toBe(true);
  });

  it('P2b：品检架的 current_load 两种部署顺序都过（缺省 / 有值）', async () => {
    // 2026-10-04：for-inspection 的在架数聚合由后端同轮补，前端与之并行推进，故消费侧
    // 必须同时兼容「字段缺省」（老后端）与「字段有值」（新后端）两种响应：
    //   - 缺省 → current_load 为 undefined，`HmiPickerCard` 的
    //     `currentLoad !== undefined && !== null` 守卫整块不渲染（不是渲染成
    //     「在架 undefined 件」）；
    //   - 有值 → 逐字透传，品检架与放回架的在架数口径一致。
    // 这条用例把这两种形状钉死：谁把品检类型强行对齐成 ShelfForReturn（或反过来把
    // current_load 声明成必填），本用例会红。
    httpGetMock.mockResolvedValue({ data: { items: [] } });
    await expect(listShelvesForInspection()).resolves.toEqual({ items: [] });

    httpGetMock.mockResolvedValue({
      data: {
        items: [
          {
            id: '8800000000001',
            code: 'SH-I01',
            name: '品检架 1',
            zone: 'INSPECTION',
            location: 'A 区 3 层',
            is_active: true,
            current_load: 3,
          },
        ],
      },
    });

    const r = await listShelvesForInspection();

    expect(r.items[0]?.current_load).toBe(3);
    // 补了聚合不等于补了推荐：is_recommended 仍然是 for-return 独有。
    expect(r.items[0]).not.toHaveProperty('is_recommended');
  });

  it('P3：无品检架时是 200 + items: []，不是业务错误（前端不得当异常处理）', async () => {
    // 2026-10-02 订正旧 JSDoc：旧注释写本端点会抛 20506
    // BIZ_SHELF_NO_MATCH_FOR_PROCESS —— 后端 service 里没有这个分支，20506 不可能
    // 由此端点抛出。本端点唯一错误是 40300（require_any_role 失败）。
    httpGetMock.mockResolvedValue({ data: { items: [] } });

    const r = await listShelvesForInspection();

    // 空列表是正常返回值：调用方应渲染「暂无可用货架」空态，而非错误态。
    expect(r).toEqual({ items: [] });
  });

  it('P4：两个端点 URL 互不串台（for-return 带 next_process_id，for-inspection 不带）', async () => {
    // 防「把两个 picker 端点写反」这种回归：两者的 JSDoc 段落形状高度相似（都是
    // 「拉候选货架列表 + 说明排序 / 推荐语义」），很容易在复制粘贴时连 URL 带
    // query 一起串。本用例把「各自的 URL + query 形态」并排钉死。
    httpGetMock.mockResolvedValue({ data: { items: [] } });

    await listShelvesForReturn('190000000000001');
    await listShelvesForInspection();

    expect(httpGetMock).toHaveBeenCalledTimes(2);
    expect(httpGetMock).toHaveBeenNthCalledWith(1, '/shelves/for-return', {
      params: { next_process_id: '190000000000001' },
    });
    expect(httpGetMock).toHaveBeenNthCalledWith(2, '/shelves/for-inspection');
  });

  it('P5：for-return 侧仍消费 7 字段 VO（拆类型不得误伤 RETURN 路径）', async () => {
    // 反向守卫：本轮把 for-inspection 拆成独立类型，若顺手把 ShelfForReturn 也
    // 「对齐」错了（例如摘掉 current_load），本用例会红。
    httpGetMock.mockResolvedValue({
      data: {
        items: [
          {
            id: '8800000000003',
            code: 'SH-P01',
            name: '生产架 1',
            zone: 'PRODUCTION',
            location: 'B 区 1 层',
            current_load: 7,
            is_recommended: true,
          },
        ],
      },
    });

    const r = await listShelvesForReturn('190000000000001');

    expect(r.items[0]).toEqual({
      id: '8800000000003',
      code: 'SH-P01',
      name: '生产架 1',
      zone: 'PRODUCTION',
      location: 'B 区 1 层',
      current_load: 7,
      is_recommended: true,
    });
    expect(r.items[0]?.current_load).toBe(7);
    // for-return VO 同样**没有** is_active（那是 for-inspection 独有的）。
    expect(r.items[0]).not.toHaveProperty('is_active');
  });
});
