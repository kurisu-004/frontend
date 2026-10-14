// src/api/__tests__/customer.spec.ts
//
// 2026-10-17 新增：`src/api/customer.ts` 的**负向守卫** —— api 层的读函数
// **不允许**做 Zod 校验。
//
// 为什么是负向断言：客户的守门点在 `useCustomersQuery` 的 queryFn
// （`customerListResultSchema.parse`）。Zod 的 parse 入口返回**深拷贝**，在 api 层
// 再走一遍等于每屏客户数据被校验并克隆两遍；而且 api 层一旦 parse，queryFn 那次
// parse 就变成纯浪费，两处校验点还会随字段增删各自漂移。
//
// ⚠️ 这条守卫与 `composables/queries/__tests__/useCustomersQuery.spec.ts` 的 Q1/Q2
// 是一**对**：那边守「parse 真的接在 queryFn 的返回路径上」，本文件守「parse 没有
// 被搬回 api 层」。少了本文件，把 parse 加回 api 层是零测试信号；少了那边，把 parse
// 从 queryFn 删掉也是零测试信号（api 层本来就该不 parse）。**两个方向都要有人在。**
//
// 同时钉死列表端点的 URL 与「不传参」这条约定：客户树拼装需要全量，而**不传
// limit 才是全量**是无限层级改造锁定的后端口径（见 `api/customer.ts` 文件头）；
// 谁图省事给它加个 `limit: 200` 就会让客户数一多就缺层，而这类缺失是静默的。

import { describe, expect, it, vi } from 'vitest';

// 把 schema 模块整体桩掉，`parse` 用可断言的 spy：api 层今天只 `import type`
// 取 `z.infer` 派生类型（模块根本不会被加载）⇒ spy 恒 0 次调用；哪天有人改成
// 运行时 import 并挂上 parse，这些断言立刻红。
const schemaParse = vi.hoisted(() => ({
  customer: vi.fn(),
  customerList: vi.fn(),
}));

vi.mock('@/composables/queries/schemas', () => ({
  customerSchema: { parse: schemaParse.customer },
  customerListResultSchema: { parse: schemaParse.customerList },
}));

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  normalizeListResult: (resp: {
    items: unknown[];
    total: string | number;
    limit: string | number;
    offset: string | number;
  }) => ({
    items: resp.items,
    total: Number(resp.total),
    limit: Number(resp.limit),
    offset: Number(resp.offset),
  }),
}));

import { createCustomer, listCustomers, softDeleteCustomer, updateCustomer } from '../customer';

describe('api/customer — api 层不做 parse（负向守卫，2026-10-17）', () => {
  it('A1：listCustomers 拿到缺 customer_path 的坏响应也**原样返回**，不抛 ZodError', async () => {
    httpGetMock.mockReset();
    // 坏响应：故意少 customer_path（后端没上无限层级改造时的形态）。
    httpGetMock.mockResolvedValue({
      data: {
        items: [
          {
            id: '1',
            name: '华强',
            parent_id: null,
            parent_name: null,
            serial_prefix: 'H',
            version: 1,
            created_at: '',
            updated_at: '',
          },
        ],
        total: '1',
        limit: '50',
        offset: '0',
      },
    });
    const out = await listCustomers();
    // 原样返回 ⇒ 守门完全交给 queryFn（那边少一个字段就会抛，测试见 Q1）
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).not.toHaveProperty('customer_path');
    expect(schemaParse.customerList).not.toHaveBeenCalled();
    expect(schemaParse.customer).not.toHaveBeenCalled();
  });

  it('A2：列表端点 URL 与「不传参」约定被钉死（不传 limit 才是全量）', async () => {
    httpGetMock.mockReset();
    httpGetMock.mockResolvedValue({ data: { items: [], total: 0, limit: 0, offset: 0 } });
    await listCustomers();
    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock).toHaveBeenCalledWith('/com/customers');
    // 没有第二个参数 ⇒ 没有 params / limit / offset
    expect(httpGetMock.mock.calls[0]!.length).toBe(1);
  });

  it('A3：normalizeListResult 仍把 total / limit / offset 强制成 number', async () => {
    httpGetMock.mockReset();
    // 后端某天改成 serialize_i64 字符串时的形态
    httpGetMock.mockResolvedValue({
      data: { items: [], total: '42', limit: '50', offset: '10' },
    });
    const out = await listCustomers();
    expect(out.total).toBe(42);
    expect(out.limit).toBe(50);
    expect(out.offset).toBe(10);
  });

  it('A4：其余 3 个端点的 URL / method 被钉死，且同样不 parse', async () => {
    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: { id: '1' } });

    await createCustomer({ name: 'X', parent_id: null, serial_prefix: 'X' });
    expect(httpPostMock).toHaveBeenCalledWith('/com/customers', {
      name: 'X',
      parent_id: null,
      serial_prefix: 'X',
    });

    await updateCustomer('42', { name: 'Y' });
    expect(httpPostMock).toHaveBeenCalledWith('/com/customers/42/update', { name: 'Y' });

    await softDeleteCustomer('42');
    expect(httpPostMock).toHaveBeenCalledWith('/com/customers/42/soft-delete');

    expect(schemaParse.customer).not.toHaveBeenCalled();
    expect(schemaParse.customerList).not.toHaveBeenCalled();
  });
});
