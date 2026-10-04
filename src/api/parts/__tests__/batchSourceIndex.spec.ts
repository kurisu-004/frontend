// 2026-10-04 新增：`batchCreateParts` 的 `created[].sourceIndex` 契约。
//
// Tab 2 改成「建工单 + 逐 part 后置上传」后，caller 必须能把建出来的 part 对回本地
// 哪一行，sourceIndex 是唯一锚。后端 `created` 按 items 顺序 push、失败项不占位，
// 所以它等于「沿组内 items 顺序、跳过 failed[].item_index 命中的项后落到的位置」。
//
// 本 spec 锁的关键点：**同一 customer_id 可以出现在数组的多个不连续区段**
//（Tab 2 每行各选分厂时是常态，A / B / C / A 会分成 2 组）。反推全局下标时不能靠
// 「前几组长度的累加」，必须原样带着分组时记下的下标。
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/http', () => ({
  api: { post: mocks.post, get: vi.fn() },
  cleanParams: (p: unknown) => p,
}));
vi.mock('@/composables/queries/schemas', () => ({
  inspectionQueueListResultSchema: { parse: (v: unknown) => v },
}));

import { batchCreateParts } from '../batch';

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
});
