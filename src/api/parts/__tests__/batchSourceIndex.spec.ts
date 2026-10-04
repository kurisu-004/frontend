// 2026-10-04 新增：`batchCreateParts` 的 `created[].sourceIndex` 契约。
//
// Tab 2 走「建工单 + 逐 part 后置上传」，caller 必须能把建出来的 part 对回本地
// 哪一行，sourceIndex 是唯一锚。后端 `created` 按 items 顺序 push、失败项不占位，
// 所以它等于「沿组内 items 顺序、跳过 failed[].item_index 命中的项后落到的位置」。
//
// 本 spec 锁的关键点：**同一 customer_id 可以出现在数组的多个不连续区段**
//（Tab 2 每行各选分厂时是常态，A / B / C / A 会分成 2 组）。反推全局下标时不能靠
// 「前几组长度的累加」，必须原样带着分组时记下的下标。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/http', () => ({
  api: { post: mocks.post, get: vi.fn() },
  cleanParams: (p: unknown) => p,
}));
vi.mock('@/composables/queries/schemas', () => ({
  inspectionQueueListResultSchema: { parse: (v: unknown) => v },
}));

import { batchCreateParts } from '../batch';

beforeEach(() => {
  mocks.post.mockReset();
});

describe('batchCreateParts sourceIndex', () => {
  it('跨 customer 分组 + 组内失败不占位', async () => {
    // items: A(0) A(1) A(2) B(3) A(4) B(5)
    // 组 A = [0,1,2,4]，组内 1 失败 → created = 源 0,2,4
    // 组 B = [3,5]  → created = 源 3,5
    mocks.post
      .mockResolvedValueOnce({
        data: {
          created: [{ id: 'a0' }, { id: 'a2' }, { id: 'a4' }],
          failed: [{ item_index: 1, code: 40001, message: 'bad' }],
        },
      })
      .mockResolvedValueOnce({ data: { created: [{ id: 'b3' }, { id: 'b5' }], failed: [] } });

    const res = await batchCreateParts([
      {
        customer_id: 'A',
        name: 'n0',
        drawing_no: 'd0',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'A',
        name: 'n1',
        drawing_no: 'd1',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'A',
        name: 'n2',
        drawing_no: 'd2',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'B',
        name: 'n3',
        drawing_no: 'd3',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'A',
        name: 'n4',
        drawing_no: 'd4',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'B',
        name: 'n5',
        drawing_no: 'd5',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
    ]);
    expect(res.created.map((c) => [c.id, c.sourceIndex])).toEqual([
      ['a0', 0],
      ['a2', 2],
      ['a4', 4],
      ['b3', 3],
      ['b5', 5],
    ]);
    expect(res.failed).toEqual([{ index: 1, message: 'bad' }]);
  });

  it('整组请求失败：聚合成 groupErrors，不整体 reject（前面成功的组已 commit）', async () => {
    // 组 A commit 成功，组 B 抛 502。整体 reject 会让 caller 看不到 A 已建出的 part，
    // 再发一次就是重复建单。
    mocks.post
      .mockResolvedValueOnce({ data: { created: [{ id: 'a0' }, { id: 'a1' }], failed: [] } })
      .mockRejectedValueOnce(new Error('网关 502'));

    const res = await batchCreateParts([
      {
        customer_id: 'A',
        name: 'n0',
        drawing_no: 'd0',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'A',
        name: 'n1',
        drawing_no: 'd1',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'B',
        name: 'n2',
        drawing_no: 'd2',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'B',
        name: 'n3',
        drawing_no: 'd3',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
    ]);

    expect(res.created.map((c) => [c.id, c.sourceIndex])).toEqual([
      ['a0', 0],
      ['a1', 1],
    ]);
    expect(res.failed).toEqual([]);
    expect(res.groupErrors).toEqual([
      { customer_id: 'B', startIndex: 2, endIndex: 3, message: '网关 502' },
    ]);
  });

  it('全部组都失败：不 reject，created 为空、groupErrors 覆盖全部下标', async () => {
    mocks.post.mockRejectedValue(new Error('网络中断'));
    const res = await batchCreateParts([
      {
        customer_id: 'A',
        name: 'n0',
        drawing_no: 'd0',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
      {
        customer_id: 'B',
        name: 'n1',
        drawing_no: 'd1',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-01-01',
      },
    ]);
    expect(res.created).toEqual([]);
    expect(res.groupErrors).toEqual([
      { customer_id: 'A', startIndex: 0, endIndex: 0, message: '网络中断' },
      { customer_id: 'B', startIndex: 1, endIndex: 1, message: '网络中断' },
    ]);
  });
});

/**
 * 2026-10-04：响应后处理（`failed` / `created` 解读）也必须在该组的 try 里。
 *
 * 请求已经 commit 之后才抛错 ⇒ 这一组的成败**已经无法确定**，且前面几组建出的 part
 * 必须原样交给 caller。若让这类抛错整体 reject，caller 只能退到「回 idle 让用户重来」，
 * 把上一组已建出的工单建第二遍。
 */
describe('batchCreateParts 畸形响应', () => {
  const twoGroups = () => [
    {
      customer_id: 'A',
      name: 'n0',
      drawing_no: 'd0',
      request_date: '2026-01-01',
      planned_delivery_date: '2026-01-01',
    },
    {
      customer_id: 'B',
      name: 'n1',
      drawing_no: 'd1',
      request_date: '2026-01-01',
      planned_delivery_date: '2026-01-01',
    },
  ];

  it('缺 failed 字段：整组记未知，前面已建的组不丢，也不 reject', async () => {
    mocks.post
      .mockResolvedValueOnce({ data: { created: [{ id: 'a0' }], failed: [] } })
      .mockResolvedValueOnce({ data: { created: [{ id: 'b1' }] } }); // 没有 failed

    const res = await batchCreateParts(twoGroups());

    expect(res.created.map((c) => [c.id, c.sourceIndex])).toEqual([['a0', 0]]);
    expect(res.failed).toEqual([]);
    expect(res.groupErrors).toEqual([
      { customer_id: 'B', startIndex: 1, endIndex: 1, message: '响应缺少 failed 数组' },
    ]);
  });

  it('created 不是数组：整组记未知，前面已建的组不丢，也不 reject', async () => {
    mocks.post
      .mockResolvedValueOnce({ data: { created: [{ id: 'a0' }], failed: [] } })
      .mockResolvedValueOnce({ data: { created: null, failed: [] } });

    const res = await batchCreateParts(twoGroups());

    expect(res.created.map((c) => [c.id, c.sourceIndex])).toEqual([['a0', 0]]);
    expect(res.groupErrors).toEqual([
      { customer_id: 'B', startIndex: 1, endIndex: 1, message: '响应缺少 created 数组' },
    ]);
  });

  it('响应体是字符串（网关返 200 + HTML）：整组记未知，不 reject', async () => {
    mocks.post.mockResolvedValue({ data: '<html>502</html>' });

    const res = await batchCreateParts(twoGroups());

    expect(res.created).toEqual([]);
    expect(res.groupErrors).toEqual([
      { customer_id: 'A', startIndex: 0, endIndex: 0, message: '响应不是对象（可能被网关拦截）' },
      { customer_id: 'B', startIndex: 1, endIndex: 1, message: '响应不是对象（可能被网关拦截）' },
    ]);
  });

  it('failed 里的 item_index 不合法：整组记未知（不把 part 绑到错误的行上）', async () => {
    mocks.post.mockResolvedValueOnce({
      data: { created: [{ id: 'a0' }], failed: [{ item_index: 'x', message: '坏数据' }] },
    });

    const res = await batchCreateParts(twoGroups());

    expect(res.created).toEqual([]);
    expect(res.groupErrors?.[0]).toEqual({
      customer_id: 'A',
      startIndex: 0,
      endIndex: 0,
      message: '响应 failed 缺少合法的 item_index',
    });
  });
});
