// src/api/workType.spec.ts
//
// 2026-10-02 新增：工种↔工序映射端点的**契约级**回归守卫（与
// src/api/shelfProcesses.spec.ts 同款设计，理由照抄那份的判断：后端集成测试逐字用
// 正确形态 ⇒ 「后端自测绿」被误当成「前后端对接没问题」；前端唯一同域测试又把
// **前端的错误形态**复刻进 mock ⇒ 「前端自测也绿」。两个绿拼起来，功能从未成功过
// 一次。⇒ 契约必须在前端侧被逐字钉死，不能靠后端自测 + 类型系统兜底 —— **类型系统
// 挡不住对象字面量的 key 拼错**（旧的 `{process_ids: [...]}` 恰好满足旧的
// `SetWorkTypeProcessesPayload`，编译期完全合法）。
//
// 覆盖对齐 backend-rust docs/api/production/work-type-process-mapping.md +
// src/modules/prod/work_type/{vo,process_mapping.rs}：
//   - W0：toWorkTypeProcessesPayload 逐字产出 {items:[{process_id, sort_order}]}，
//         sort_order = 数组下标（v1「提交顺序即 sort_order」）。
//   - W0b（BUG-1 核心 regression）：结果里**绝不能**出现 v1 的 process_ids 键。
//   - W0c：空选必须发 {items: []}（不能省略 key，否则后端 serde missing field
//         → 40001 → HTTP 422）。
//   - W0d：去重 + sort_order 按去重后下标重排（不留空洞）。
//   - W1：setWorkTypeProcesses 发出的 body 逐字是 {items:[...]}，URL 逐字锁定。
//   - W1b：setWorkTypeProcesses 返回 Promise<void>（后端 data 为 null，不谎称返回
//         对象 —— 旧实现返回 Promise<WorkTypeWithProcesses>）。
//   - W2（BUG-2 核心 regression）：getWorkTypeProcesses 消费的是 {items:[...]}，
//         item 带 work_type_id / process_code / sort_order，**没有** processes 键
//         （旧代码 `detail.processes.map(...)` 恒 TypeError）。
//   - W2b：toWorkTypeProcessIds 按 sort_order 升序取 process_id、不读 processes 键；
//         sort_order 重复 / 乱序时仍稳定（ES2019 sort 稳定性承担）。
//
// mock 手法沿 src/api/shelfProcesses.spec.ts / dashboard.spec.ts 同款：整模块桩掉
// `@/api/http`（不 importOriginal），只保留 `api.get` / `api.post` 两个可断言入口
// + `cleanParams`（workType.ts 实际 import 的就这两个）。真实理由不是「http.ts 在
// node 下求值不安全」（它在模块求值期只做 axios.create，localStorage 读取全在拦截器
// 回调内）——而是整模块桩掉才能对「URL + body」逐字断言，且能顺带证明本文件不依赖
// http.ts 的任何内部实现。

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

import {
  getWorkTypeProcesses,
  setWorkTypeProcesses,
  toWorkTypeProcessIds,
  toWorkTypeProcessesPayload,
} from './workType';

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('2026-10-02：工种↔工序映射端点契约（workType.ts）', () => {
  it('W0：toWorkTypeProcessesPayload 逐字产出 {items:[{process_id, sort_order}]}，sort_order = 下标', () => {
    // BUG-1 根因就是「调用方编错请求形态」：旧 ProcessWorkTypeMappingTab.vue 内联
    // `{process_ids: selectedProcessIds.value}`。收口成纯函数后逐字钉死。
    expect(toWorkTypeProcessesPayload(['190000000000001', '190000000000002'])).toEqual({
      items: [
        { process_id: '190000000000001', sort_order: 0 },
        { process_id: '190000000000002', sort_order: 1 },
      ],
    });
  });

  it('W0b（BUG-1 核心 regression）：结果里没有 v1 的 process_ids 键', () => {
    // 这条断言是本次修复的**核心**：旧 payload 形态恰好满足旧的 TS 类型，类型系统
    // 挡不住，编译期全绿、线上把该工种映射静默清空。负向断言比正向断言更抗回归 ——
    // 将来有人「顺手加个兼容字段」也会被它挡住。
    const payload = toWorkTypeProcessesPayload(['a', 'b']);
    expect(payload).not.toHaveProperty('process_ids');
    expect(Array.isArray(payload.items)).toBe(true);
  });

  it('W0c：空选（清空整组映射）必须发 {items: []}，不能省略 items 键', () => {
    // 后端 items 是必填 Vec（空数组 = 清空全部 mapping），没有 serde(default)：
    // 漏掉 items 键 → 40001 VALIDATION_ERROR → HTTP 422。
    expect(toWorkTypeProcessesPayload([])).toEqual({ items: [] });
    expect(toWorkTypeProcessesPayload([])).toHaveProperty('items');
  });

  it('W0d：去重，且 sort_order 按去重后下标重排（不留空洞）', () => {
    // t_work_type_process 上有 (work_type_id, process_id) 唯一约束，items 里出现重复
    // process_id ⇒ bulk_insert 撞唯一索引 ⇒ 500（没人能自解释的 500）。
    // 今天 el-checkbox-group 产不出重复值，但本函数的立身之本是收口 payload 形态
    // —— 将来「已有映射 + 新增勾选」合并提交时重复就会真实发生。
    expect(toWorkTypeProcessesPayload(['p1', 'p2', 'p1', 'p3', 'p2'])).toEqual({
      items: [
        { process_id: 'p1', sort_order: 0 },
        { process_id: 'p2', sort_order: 1 },
        { process_id: 'p3', sort_order: 2 },
      ],
    });
    // 保留首次出现：顺序 = 输入里的首次出现序，不是排序后的序。
    expect(toWorkTypeProcessesPayload(['p3', 'p1', 'p3']).items.map((i) => i.process_id)).toEqual([
      'p3',
      'p1',
    ]);
    // 全重复 → 退化成单条（而不是发 3 条同 id 去撞索引）。
    expect(toWorkTypeProcessesPayload(['p1', 'p1', 'p1'])).toEqual({
      items: [{ process_id: 'p1', sort_order: 0 }],
    });
  });

  it('W1：setWorkTypeProcesses body 逐字是 {items:[{process_id, sort_order}]}，URL 逐字锁定', async () => {
    httpPostMock.mockResolvedValue({ data: null });

    await setWorkTypeProcesses('207145107692978177', {
      items: [
        { process_id: '190000000000001', sort_order: 0 },
        { process_id: '190000000000002', sort_order: 1 },
      ],
    });

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    expect(httpPostMock).toHaveBeenCalledWith('/prod/work-types/207145107692978177/processes', {
      items: [
        { process_id: '190000000000001', sort_order: 0 },
        { process_id: '190000000000002', sort_order: 1 },
      ],
    });
    // 反向断言：绝不能是 v1 的 {process_ids: [...]} 形态。
    const body = httpPostMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('process_ids');
  });

  it('W1b：setWorkTypeProcesses 返回 Promise<void>（后端 data 为 null，不返回对象）', async () => {
    // 旧签名谎称 Promise<WorkTypeWithProcesses>，让调用方以为「保存后能拿到含映射的
    // 工种详情」而写出读 `processes` 的代码 —— 与 BUG-2 同源。
    httpPostMock.mockResolvedValue({ data: null });

    const r = await setWorkTypeProcesses('8800000000001', {
      items: [{ process_id: '190000000000001', sort_order: 0 }],
    });

    expect(r).toBeUndefined();
  });

  it('W2（BUG-2 核心 regression）：getWorkTypeProcesses 消费 {items:[...]}，没有 processes 键', async () => {
    // 后端 WorkTypeProcessMappingOut **只有 items 一个键**。旧代码
    // `detail.processes.map((p) => p.process_id)` 恒 TypeError（用户报的
    // `Cannot read properties of undefined (reading 'map')`）。
    httpGetMock.mockResolvedValue({
      data: {
        items: [
          {
            work_type_id: '8800000000001',
            process_id: '190000000000001',
            process_code: 'CUT',
            sort_order: 0,
          },
          {
            work_type_id: '8800000000001',
            process_id: '190000000000002',
            process_code: 'WELD',
            sort_order: 1,
          },
        ],
      },
    });

    const res = await getWorkTypeProcesses('8800000000001');

    expect(httpGetMock).toHaveBeenCalledWith('/prod/work-types/8800000000001/processes');
    expect(res.items).toHaveLength(2);
    expect(res.items.map((p) => p.process_id)).toEqual(['190000000000001', '190000000000002']);
    // 后端恒返 work_type_id（映射行天然带）—— 旧 WorkTypeProcessLink 漏了这个字段。
    expect(res.items[0]?.work_type_id).toBe('8800000000001');
    expect(res.items[1]?.sort_order).toBe(1);
    // v1 影子键两个都不该存在。
    expect((res as unknown as Record<string, unknown>).processes).toBeUndefined();
    expect(res.items[0]).not.toHaveProperty('process_name');
  });

  it('W2b：toWorkTypeProcessIds 按 sort_order 升序取 process_id（不读 processes 键）', () => {
    const row = (process_id: string, sort_order: number) => ({
      work_type_id: 'wt1',
      process_id,
      process_code: process_id.toUpperCase(),
      sort_order,
    });
    // 乱序输入 → 按 sort_order 升序。
    expect(toWorkTypeProcessIds({ items: [row('c', 2), row('a', 0), row('b', 1)] })).toEqual([
      'a',
      'b',
      'c',
    ]);
    // sort_order 全部相同（脏数据）→ 保持输入次序，不随机重排（ES2019 sort 稳定性
    // + 后端 SQL `ORDER BY sort_order ASC, id ASC` 的 id ASC 次序）。
    expect(toWorkTypeProcessIds({ items: [row('c', 0), row('a', 0), row('b', 0)] })).toEqual([
      'c',
      'a',
      'b',
    ]);
    // 无映射（空 items）→ 空数组（不是 undefined / 不抛错）。
    expect(toWorkTypeProcessIds({ items: [] })).toEqual([]);
  });
});
