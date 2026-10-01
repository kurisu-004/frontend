// src/api/shelfProcesses.spec.ts
//
// 2026-10-02 新增：货架↔工序映射端点的**契约级**回归守卫。
//
// 为什么必须有这个文件（这是本 PR 最重要的产出）：
//   BUG-1/2/3 能长期静默存在的唯一原因，是这个域**前端零契约覆盖**。后端集成
//   测试 tests/shelf/api.rs:242 逐字用正确的 `{items:[...]}` 形态，于是「后端自测
//   绿」被误当成「前后端对接没问题」；而前端唯一的同域测试
//   （usePendingProgrammingStore.spec.ts）把**前端的错误形态**复刻进了 mock，
//   于是前端自测也绿。两个绿拼起来，功能却从未成功过一次。
//   ⇒ 契约必须在前端侧被逐字钉死，不能靠后端自测 + 类型系统兜底。
//
// 覆盖（对齐 backend-rust docs/api/shelves.md:216-270 +
//       src/modules/shelf/dto.rs:85-96 + src/modules/shelf/vo/process_mapping.rs）：
//   - C1：setShelfProcesses 发出的 body 逐字是 `{items:[{process_id, sort_order}]}`
//         （BUG-1 守卫：旧的 `{process_ids:[...]}` 会让后端 serde missing field
//          → 40001 VALIDATION_ERROR → HTTP 422，用户 2026-10-02 报的原 bug）。
//         payload 形态由 C0 的纯函数 toShelfProcessesPayload 逐字钉死（调用方
//         ShelfList.vue 只是它的唯一消费者，收口后编不出 v1 形态）。
//   - C2：setShelfProcesses 返回 Promise<void>（后端 data 为 null，不谎称返回对象）。
//   - C3：getShelfProcesses 消费的是 `{items:[...]}` 扁平形态
//         （BUG-2 守卫：旧的 `sp.processes` 恒 undefined → .map 抛 TypeError →
//         被裸 catch 吞掉 → 已选工序被静默清空）。形态还原由 C3b 的纯函数
//         toShelfProcessIds 逐字钉死。
//   - C4：getAllShelfProcessMappings 的 item 是**扁平行**四字段
//         （BUG-3 守卫：同一 shelf_id 多行，不是 v1 的「一架子集一行」）。
//
// mock 手法沿 dashboard.spec.ts 同款：整模块桩掉 `@/api/http`（不 importOriginal），
// 只保留 `api.get` / `api.post` 两个可断言入口 + cleanParams / ApiError 占位。
// 不桩 http.ts 原件是因为它在模块求值期就 axios.create + 读 localStorage，
// vitest node 环境没有 localStorage。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  apiPrint: { get: vi.fn(), post: vi.fn() },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
  ApiError: class ApiError extends Error {},
}));

//   - C0：toShelfProcessesPayload 把下拉多选 id 列表编成 `{items:[{process_id,
//         sort_order}]}`，sort_order = 数组下标（v1「提交顺序即 sort_order」）。
import {
  getAllShelfProcessMappings,
  getShelfProcesses,
  setShelfProcesses,
  toShelfProcessIds,
  toShelfProcessesPayload,
} from './shelves';

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('2026-10-02：货架↔工序映射端点契约（shelves.ts）', () => {
  it('C0：toShelfProcessesPayload 逐字产出 {items:[{process_id, sort_order}]}，sort_order = 下标', () => {
    // BUG-1 根因就在「调用方编错请求形态」：旧 ShelfList.vue 内联
    // `{process_ids: selectedProcessIds.value}`。收口成纯函数后逐字钉死。
    expect(toShelfProcessesPayload(['190000000000001', '190000000000002'])).toEqual({
      items: [
        { process_id: '190000000000001', sort_order: 0 },
        { process_id: '190000000000002', sort_order: 1 },
      ],
    });
    // 空选 = 清空整组映射：必须发 items: []（后端 items 是必填 Vec，漏键会 422）。
    expect(toShelfProcessesPayload([])).toEqual({ items: [] });
    // 反向断言：绝不能出现 v1 的 process_ids 键。
    expect(toShelfProcessesPayload(['a'])).not.toHaveProperty('process_ids');
  });

  it('C1：setShelfProcesses body 逐字是 {items:[{process_id, sort_order}]}', async () => {
    httpPostMock.mockResolvedValue({ data: null });

    await setShelfProcesses('207145107692978177', {
      items: [
        { process_id: '190000000000001', sort_order: 0 },
        { process_id: '190000000000002', sort_order: 1 },
      ],
    });

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    // 逐字断言整个调用元组：URL + body。URL 断言刻意锁死当前路径
    // （硬切到 /api/v2/prod/shelf-processes 是后端域拆分子任务的事，本 PR 不动）。
    expect(httpPostMock).toHaveBeenCalledWith('/shelves/207145107692978177/processes', {
      items: [
        { process_id: '190000000000001', sort_order: 0 },
        { process_id: '190000000000002', sort_order: 1 },
      ],
    });
    // 反向断言：绝不能是 v1 的 {process_ids: [...]} 形态。
    const body = httpPostMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('process_ids');
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('C1b：空选（清空整组映射）仍发 items: []，而不是省略 items 键', async () => {
    // 后端 items 是必填 Vec（可为空数组 = 清空映射），没有 serde(default)：
    // 漏掉 items 键会 422，发 [] 才合法。
    httpPostMock.mockResolvedValue({ data: null });

    await setShelfProcesses('8800000000001', { items: [] });

    expect(httpPostMock).toHaveBeenCalledWith('/shelves/8800000000001/processes', { items: [] });
  });

  it('C2：setShelfProcesses 返回 Promise<void>（后端 data 为 null，不返回对象）', async () => {
    httpPostMock.mockResolvedValue({ data: null });

    const r = await setShelfProcesses('8800000000001', {
      items: [{ process_id: '190000000000001', sort_order: 0 }],
    });

    expect(r).toBeUndefined();
  });

  it('C3：getShelfProcesses 消费 {items:[...]} 扁平形态，且 item 带 sort_order', async () => {
    httpGetMock.mockResolvedValue({
      data: {
        items: [
          {
            shelf_id: '8800000000001',
            shelf_code: 'SH-P01',
            process_id: '190000000000001',
            process_code: 'CUT',
            sort_order: 0,
          },
          {
            shelf_id: '8800000000001',
            shelf_code: 'SH-P01',
            process_id: '190000000000002',
            process_code: 'WELD',
            sort_order: 1,
          },
        ],
      },
    });

    const sp = await getShelfProcesses('8800000000001');

    expect(httpGetMock).toHaveBeenCalledWith('/shelves/8800000000001/processes');
    // BUG-2 守卫：消费侧读 sp.items，不是 sp.processes。
    expect(sp.items).toHaveLength(2);
    expect(sp.items.map((p) => p.process_id)).toEqual(['190000000000001', '190000000000002']);
    expect(sp.items[1]?.sort_order).toBe(1);
    expect((sp as unknown as Record<string, unknown>).processes).toBeUndefined();
  });

  it('C3b：toShelfProcessIds 按 sort_order 升序取 process_id（不读 processes 键）', () => {
    // BUG-2 根因守卫：旧代码 `sp.processes.map((p) => p.process_id)` 在后端返
    // `{items:[...]}` 时抛 TypeError。这里锁死「读 items + 升序」两个语义。
    expect(
      toShelfProcessIds({
        items: [
          {
            shelf_id: 's1',
            shelf_code: 'SH-P01',
            process_id: 'p2',
            process_code: 'WELD',
            sort_order: 1,
          },
          {
            shelf_id: 's1',
            shelf_code: 'SH-P01',
            process_id: 'p1',
            process_code: 'CUT',
            sort_order: 0,
          },
        ],
      }),
    ).toEqual(['p1', 'p2']);
    // 无映射（空 items）→ 空数组（不是 undefined / 不抛错）。
    expect(toShelfProcessIds({ items: [] })).toEqual([]);
  });

  it('C4：getAllShelfProcessMappings 返回扁平行（同一 shelf_id 多行、每行一个 process_id）', async () => {
    httpGetMock.mockResolvedValue({
      data: {
        items: [
          {
            shelf_id: '8800000000001',
            shelf_code: 'SH-P01',
            process_id: '190000000000001',
            process_code: 'CUT',
          },
          {
            shelf_id: '8800000000001',
            shelf_code: 'SH-P01',
            process_id: '190000000000002',
            process_code: 'WELD',
          },
          {
            shelf_id: '8800000000002',
            shelf_code: 'SH-P02',
            process_id: '190000000000002',
            process_code: 'WELD',
          },
        ],
      },
    });

    const r = await getAllShelfProcessMappings();

    expect(httpGetMock).toHaveBeenCalledWith('/shelves/processes');
    // BUG-3 守卫：item 上是 process_id 单值，不是 v1 的 process_ids 数组子集。
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).not.toHaveProperty('process_ids');
    expect(r.items[0]).toEqual({
      shelf_id: '8800000000001',
      shelf_code: 'SH-P01',
      process_id: '190000000000001',
      process_code: 'CUT',
    });
  });
});
