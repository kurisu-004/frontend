// src/api/parts/__tests__/toProcess.spec.ts
//
// 2026-10-02 新增：`toProcess` / `toShip` 两个品检流转端点的契约级回归守卫。
//
// 为什么必须有（背景）：
//   「待品检」页点「品检通过」和「指定工序」报 404，根因是前端打的
//   `POST /parts/{part_id}/pass-inspection` / `fail-inspection` 是 v1 Python 遗留
//   路径、v2 从未注册（axum 路由匹配先于鉴权，可与 401 区分）。修复方式不是换个
//   URL 了事，而是改打 v2 真正的品检端点：`to-ship`（通过）/ `to-process`（打回），
//   两者都随 t_part_batch 迁到 prod 域并以**批次**为锚。
//
//   这两条路径此前**零契约覆盖**（全仓没有任何 spec 断言 URL 字符串与请求体），
//   于是「调用方拼错路径 / 漏必填字段」只能等用户点按钮才发现 —— 404 / 422 都是
//   运行时才炸。本文件把 URL、method、body 逐字钉死。
//
// 覆盖要点：
//   - C1：toProcess 打 `/prod/batches/{batch_id}/to-process`，POST，body 逐字带齐
//         `shelf_id` / `next_process_id` / `version`（三者后端均无 serde(default)，
//         缺任一 → HTTP 422），且**不含** `batch_id`（它已是路径参数）。
//   - C2：toProcess 返回 `resp.data` 原样（后端 `ToProcessOut { part, new_batch_id }`，
//         不是裸 PartItem —— 调用方成功提示取 out.part.serial_no）。
//   - C3：toShip 同款守卫（`version` 必填 / body 不含 batch_id / 返回 { part, new_batch_id }）。
//   - C4：批次 id 走 encodeURIComponent（雪花 id 是纯数字，但 URL 拼接统一转义）。
//
// mock 手法沿 src/api/shelfProcesses.spec.ts 同款：整模块桩掉 `@/api/http`
// （不 importOriginal），只留可断言的 api.post 入口。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: vi.fn(),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import { toProcess, toShip } from '../crud';

beforeEach(() => {
  httpPostMock.mockReset();
});

describe('2026-10-02：品检流转端点契约（parts/crud.ts）', () => {
  it('C1：toProcess 打 prod 域批次路径，body 带齐三个必填字段且不含 batch_id', async () => {
    httpPostMock.mockResolvedValue({ data: { part: { id: '1' }, new_batch_id: null } });

    await toProcess('190000000000123', {
      shelf_id: '8800000000001',
      next_process_id: '7700000000001',
      version: 7,
      note: '尺寸超差',
      quantity: 3,
    });

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    const [url, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/prod/batches/190000000000123/to-process');
    expect(body.shelf_id).toBe('8800000000001');
    expect(body.next_process_id).toBe('7700000000001');
    expect(body.version).toBe(7);
    expect(body.note).toBe('尺寸超差');
    expect(body.quantity).toBe(3);
    // batch_id 是路径参数，再放进 body 会被后端 serde 忽略（前端的旧形状残留）。
    expect(body).not.toHaveProperty('batch_id');
  });

  it('C2：toProcess 原样返回 resp.data 的 { part, new_batch_id }', async () => {
    const payload = { part: { id: '42', serial_no: 'SN-42' }, new_batch_id: '190000000000999' };
    httpPostMock.mockResolvedValue({ data: payload });

    const out = await toProcess('190000000000123', {
      shelf_id: '8800000000001',
      next_process_id: '7700000000001',
      version: 1,
    });

    expect(out).toEqual(payload);
    // 调用方（InspectionPending「指定工序」/ usePartDetail.onFailInspection）
    // 的成功提示取 out.part.serial_no。
    expect(out.part.serial_no).toBe('SN-42');
  });

  it('C3：toShip 同样锚批次、version 必填、body 不含 batch_id', async () => {
    const payload = { part: { id: '42', serial_no: 'SN-42' }, new_batch_id: null };
    httpPostMock.mockResolvedValue({ data: payload });

    const out = await toShip('190000000000123', { version: 9, quantity: 2 });

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    const [url, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/prod/batches/190000000000123/to-ship');
    expect(body).toEqual({ version: 9, quantity: 2 });
    expect(body).not.toHaveProperty('batch_id');
    expect(out).toEqual(payload);
  });

  it('C4：批次 id 统一 encodeURIComponent 转义后再拼路径', async () => {
    httpPostMock.mockResolvedValue({ data: { part: {}, new_batch_id: null } });

    await toProcess('a b/c', {
      shelf_id: 's',
      next_process_id: 'p',
      version: 1,
    });

    const [url] = httpPostMock.mock.calls[0] as [string];
    expect(url).toBe('/prod/batches/a%20b%2Fc/to-process');
  });
});
