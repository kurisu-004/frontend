// 2026-10-05 新增：`POST /parts/batch` 的 item 载荷契约（单价 / 总价不被丢）。
//
// 缺陷背景：Tab 2 表格里有「含税单价 / 含税价格」可编辑列，Excel 也会回填，但
// `toPartBatchCreateItem` 的显式白名单里**没有** `unit_price` / `total_price`，
// 于是用户填的价在请求体里被静默丢弃、建出来的工单单价恒为 0。
//
// 本 spec 直接锁请求体形状：白名单漏一项就是回归。后端侧是 rust rust_decimal +
// serde-with-str，**只认字符串**且标度固定 2 位（`NUMERIC(12,2)` / `NUMERIC(14,2)`），
// 所以这里断言的是字符串而不是 number。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/http', () => ({
  api: { post: mocks.post, get: vi.fn() },
  cleanParams: (p: unknown) => p,
}));

import { batchCreateParts, type PartBatchCreatePayload } from '../batch';

beforeEach(() => {
  mocks.post.mockReset();
  mocks.post.mockResolvedValue({ data: { created: [], failed: [] } });
});

/** 最小合法 item（只有必填项）。 */
function baseItem(over: Partial<PartBatchCreatePayload> = {}): PartBatchCreatePayload {
  return {
    customer_id: 'C1',
    name: 'n',
    drawing_no: 'd',
    request_date: '2026-10-05',
    planned_delivery_date: '2026-10-06',
    ...over,
  };
}

describe('batchCreateParts：item 载荷形状', () => {
  it('转发 unit_price / total_price（2 位小数字符串）', async () => {
    await batchCreateParts([
      baseItem({ unit_price: '95.00', total_price: '285.00' }),
      baseItem({ unit_price: '0.10', total_price: '0.30' }),
    ]);

    // 同一 customer_id → 一个分组一次请求
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const body = mocks.post.mock.calls[0]![1] as { items: Record<string, unknown>[] };
    expect(body.items[0]!.unit_price).toBe('95.00');
    expect(body.items[0]!.total_price).toBe('285.00');
    // 浮点尾数在 FE 侧已被 toMoneyString 抹平，这里锁的是「透传不加工」
    expect(body.items[1]!.unit_price).toBe('0.10');
    expect(body.items[1]!.total_price).toBe('0.30');
  });

  it("缺价时两个键都不出现在**线上请求体**里（undefined 而非 null / '0'）", async () => {
    await batchCreateParts([baseItem()]);

    const body = mocks.post.mock.calls[0]![1] as { items: Record<string, unknown>[] };
    // 对象里两个键的值是 undefined（不是 null、不是 '0'：那会把「没填价」说成「0 元」）
    expect(body.items[0]!.unit_price).toBeUndefined();
    expect(body.items[0]!.total_price).toBeUndefined();
    // axios 走 JSON.stringify → undefined 的键整个消失，后端看不到这两个字段
    const wire = JSON.parse(JSON.stringify(body)) as { items: Record<string, unknown>[] };
    expect('unit_price' in wire.items[0]!).toBe(false);
    expect('total_price' in wire.items[0]!).toBe(false);
  });

  it('total_price 显式 null 时原样透传 null（后端落 0，不做兜底计算）', async () => {
    await batchCreateParts([baseItem({ unit_price: '12.50', total_price: null })]);

    const body = mocks.post.mock.calls[0]![1] as { items: Record<string, unknown>[] };
    expect(body.items[0]!.unit_price).toBe('12.50');
    expect(body.items[0]!.total_price).toBeNull();
  });
});
