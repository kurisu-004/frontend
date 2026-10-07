// src/api/__tests__/batch.contract.spec.ts
//
// 2026-10-08 新增：共用层 `src/api/batch.ts`（批次拆批）的 **URL + body 契约守卫**。
//
// 为什么必须有这个文件：`POST /prod/batches/{batch_id}/split` 硬切下线、改为
// `POST /api/v2/batches/split`（`batch_id` 从路径参数改成 **body 字段**），无 alias。
// 旧 URL 的守卫原本在 `src/api/parts/__tests__/routes.spec.ts` 的 R1 组里（那一组只钉
// parts 域），拆批搬走时守卫必须跟着搬，否则新端点就处于「前端侧零 URL 守卫」的状态 ——
// 打错就是 404，且只在开发期「点一下才发现」。
//
// 覆盖：
//   - S1：URL 逐字钉死为 `/batches/split`（**不是** `/prod/batches/{id}/split`，也不是
//     旧 v1 形态 `/parts/{id}/batches/split`）。
//   - S2：body 原样透传、`batch_id` 在 body 里（不是路径参数）；雪花 ID 是字符串。
//   - S2b：`quantity` 打在 body 里必须是字符串（后端 `deserialize_i64`，发 number → 422）。
//   - S3：出参原样返回（不做加工、不 parse）—— api 层不承担守门职责。
//   - S4：反断言 —— URL 不得含 `/parts/` 或 `/prod/batches/`（把新端点又挂回旧域的
//     典型回归）。
//
// 守门分工：api 层只发请求、不做 Zod 解析（出参 5 字段且调用方只判成败），所以本文件
// 只钉「打出去的东西」与「拿回来的东西是同一个对象」。
//
// mock 手法沿 `src/api/parts/__tests__/routes.spec.ts` / `inspection.contract.spec.ts`
// 同款：整模块桩掉 `@/api/http`（不 importOriginal），只留可断言的 api.post 入口。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpPostMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import { splitBatch } from '../batch';

const BATCH = '3000000000001';

/** 后端 SplitBatchOut 的 5 字段（雪花 ID 是字符串 —— 声明成 number 会在 JS 丢精度）。 */
const SPLIT_OUT = {
  batch_id: BATCH,
  new_batch_id: '3000000000002',
  part_id: '4000000000001',
  quantity: 8,
  source_version: 4,
};

beforeEach(() => {
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: SPLIT_OUT });
});

describe('batch api（批次拆分共用端点）', () => {
  it('S1：URL 逐字钉死为 /batches/split（baseURL 之外的路径部分）', async () => {
    await splitBatch({ batch_id: BATCH, version: 3, quantity: '4' });
    expect(httpPostMock).toHaveBeenCalledTimes(1);
    expect(httpPostMock.mock.calls[0]![0]).toBe('/batches/split');
  });

  it('S2：body 原样透传，batch_id 在 body 里且是雪花 ID 字符串', async () => {
    const payload = { batch_id: BATCH, version: 3, quantity: '4', note: '先拆一半' };
    await splitBatch(payload);
    const [path, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/batches/split');
    // api 层不加工入参：键集合与形状都必须与调用方给的一致（尤其 batch_id 是 body 字段）
    expect(body).toEqual(payload);
    expect(typeof body.batch_id).toBe('string');
  });

  it('S2b：`quantity` 打在 body 里必须是**字符串**（后端 deserialize_i64 只吃 str）', async () => {
    // 后端 SplitBatchByBodyRequest.quantity 与 batch_id 同样挂 deserialize_i64，发
    // JSON number 会被 serde 拒在反序列化阶段：HTTP 422 **纯文本**、响应里没有 code
    // 字段。类型声明（`SplitBatchByBodyRequest.quantity: string`）是编译期闸，这条是
    // 运行期闸 —— 断言真正 post 出去的 body，避免有人为了「让它好过」把类型改回 number。
    await splitBatch({ batch_id: BATCH, version: 3, quantity: '4' });
    const [, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(typeof body.quantity).toBe('string');
    expect(body.quantity).toBe('4');
    // version 是裸 i32（无该反序列化器）⇒ 保持 JSON integer，别被一并字符串化
    expect(typeof body.version).toBe('number');
  });

  it('S3：出参原样返回（api 层不 parse、不加工）', async () => {
    await expect(splitBatch({ batch_id: BATCH, version: 3, quantity: '4' })).resolves.toEqual(
      SPLIT_OUT,
    );
  });

  it('S4：反断言 —— URL 不得含 /parts/ 或 /prod/batches/', async () => {
    await splitBatch({ batch_id: BATCH, version: 3, quantity: '4' });
    const url = httpPostMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('/parts/');
    expect(url).not.toContain('/prod/batches/');
  });
});
