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
// 覆盖对齐 backend-rust docs/api/production/shelf-process-mapping.md（2026-10-02
//       新建，本域从 docs/api/shelves.md 迁出）+ src/modules/prod/shelf_process/
//       {dto,vo}.rs —— 2026-10-02 后端域拆分后
//       映射的 DTO / VO 已整文件搬到 prod 子模块，文件路径随之变；DTO 在
//       master 上仍可从 src/modules/shelf/dto.rs 找到）：
//   - C0：toShelfProcessesPayload 把下拉多选 id 列表编成 `{items:[{process_id,
//         sort_order}]}`，sort_order = 数组下标（v1「提交顺序即 sort_order」）。
//   - C0b：toShelfProcessesPayload 去重 + 按去重后下标重排 sort_order
//         （review M-3：后端 partial unique index uk_t_shelf_process 遇重复
//          process_id 直接撞索引 → 500，不是可自解释的 40001）。
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
//   - C3c：toShelfProcessIds 在 sort_order 重复 / 乱序时仍稳定（review M-1 去掉
//         `?? 0` 兜底后，稳定性改由 ES2019 规范保证的 sort 稳定性承担）。
//   - C4：getAllShelfProcessMappings 的 item 是**扁平行**四字段
//         （BUG-3 守卫：同一 shelf_id 多行，不是 v1 的「一架子集一行」）。
//   - C5：prod 域拆分硬切后的 URL 回归守卫 —— 3 个映射端点的 URL 必须全部落在
//         `/prod/shelf-processes*` 命名空间内，旧 `/shelves/*/processes` 路径一个
//         都不许再出现（完整缘由见 C5 用例内注释）。
//
// mock 手法沿 dashboard.spec.ts 同款：整模块桩掉 `@/api/http`（不 importOriginal），
// 只保留 `api.get` / `api.post` 两个可断言入口 + `cleanParams`（shelves.ts:3 实际
// import 的就这两个）。
// 2026-10-02 review M-4 订正注释：原注释称「不桩 http.ts 原件是因为它在模块求值期
// 就 axios.create + 读 localStorage，vitest node 环境没有 localStorage」——**该
// 理由不成立**：`axios.create`（http.ts:178）在 node 下无害，localStorage 读取全在
// 拦截器回调内（http.ts:240/251/273/281），仓内 `src/api/http.spec.ts` 直接
// `import { serializeParams... } from './http'` 且全绿。真实理由是别的：整模块桩掉
// 才能对「URL + body」逐字断言（走原件要 mock adapter/拦截器，噪声大且脆弱），
// 且能顺带证明本文件完全不依赖 http.ts 的任何内部实现。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  // 2026-10-02 review M-4：原先还桩了 apiPrint / ApiError 两个死桩 ——
  // shelves.ts 只 import 了 `api, cleanParams`，这两个从未被读取，删掉避免
  // 「这里好像依赖它们」的错觉。
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

// 2026-10-02 review M-4：原这里有一段重复文件头覆盖清单的 C0 注释，已并入文件头。
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

  it('C0b：toShelfProcessesPayload 去重，且 sort_order 按去重后下标重排（不留空洞）', () => {
    // review M-3：后端 t_shelf_process 有 partial unique index
    // `uk_t_shelf_process (shelf_id, process_id) WHERE deleted_at IS NULL`，
    // items 里出现重复 process_id ⇒ bulk_insert 撞索引 ⇒ 500。
    // 今天 el-select multiple 产不出重复值，但本函数的立身之本是收口 payload
    // 形态 —— 将来「已有映射 + 新增勾选」合并提交时重复就会真实发生。
    // sort_order 必须按**去重后**的下标重算：沿用原下标会留下空洞（如 0, 2），
    // 语义上不再是 0..n-1 的连续顺序。
    expect(toShelfProcessesPayload(['p1', 'p2', 'p1', 'p3', 'p2'])).toEqual({
      items: [
        { process_id: 'p1', sort_order: 0 },
        { process_id: 'p2', sort_order: 1 },
        { process_id: 'p3', sort_order: 2 },
      ],
    });
    // 保留首次出现：顺序 = 输入里的首次出现序，不是排序后的序。
    expect(toShelfProcessesPayload(['p3', 'p1', 'p3']).items.map((i) => i.process_id)).toEqual([
      'p3',
      'p1',
    ]);
    // 全重复 → 退化成单条（而不是发 3 条同 id 去撞索引）。
    expect(toShelfProcessesPayload(['p1', 'p1', 'p1'])).toEqual({
      items: [{ process_id: 'p1', sort_order: 0 }],
    });
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
    // 逐字断言整个调用元组：URL + body。URL 断言刻意锁死当前路径，2026-10-02
    // 随后端 prod 域拆分硬切成 /prod/shelf-processes/{shelf_id}（旧路径 404）。
    expect(httpPostMock).toHaveBeenCalledWith('/prod/shelf-processes/207145107692978177', {
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

    expect(httpPostMock).toHaveBeenCalledWith('/prod/shelf-processes/8800000000001', { items: [] });
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

    expect(httpGetMock).toHaveBeenCalledWith('/prod/shelf-processes/8800000000001');
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

  it('C3c：sort_order 重复 / 乱序时 toShelfProcessIds 仍返回稳定顺序（review M-1 稳定性 guard）', () => {
    // review M-1 把 sort_order 收紧成必填并删掉 `?? 0` 兜底后，「重复值下顺序仍
    // 稳定」这条承诺改由 ES2019 起规范保证的 Array.prototype.sort 稳定性承担。
    // 后端单架端点 SQL 是 `ORDER BY sp.sort_order ASC, sp.id ASC`，同 sort_order
    // 时输入序即 id ASC 序 —— 所以本用例断言「保留输入相对次序」而不是某个具体
    // 的二级排序规则（前端不重复实现后端 SQL 的 id 排序）。
    const row = (process_id: string, sort_order: number) => ({
      shelf_id: 's1',
      shelf_code: 'SH-P01',
      process_id,
      process_code: process_id.toUpperCase(),
      sort_order,
    });
    // 乱序输入 → 按 sort_order 升序。
    expect(toShelfProcessIds({ items: [row('c', 2), row('a', 0), row('b', 1)] })).toEqual([
      'a',
      'b',
      'c',
    ]);
    // sort_order 全部相同（脏数据）→ 保持输入次序，不随机重排。
    expect(toShelfProcessIds({ items: [row('c', 0), row('a', 0), row('b', 0)] })).toEqual([
      'c',
      'a',
      'b',
    ]);
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

    expect(httpGetMock).toHaveBeenCalledWith('/prod/shelf-processes');
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

  it('C5：3 个映射端点的 URL 全部落在 /prod/shelf-processes* 命名空间，旧路径已死', async () => {
    // 2026-10-02 新增（后端 prod 域拆分硬切的回归守卫）。
    //
    // 缘由：后端把 `t_shelf_process` 搬到 `src/modules/prod/shelf_process/`，
    // 3 个端点 URL **硬切**到 `/api/v2/prod/shelf-processes/*` 且**无 alias** ——
    // 旧路由已从 `src/modules/shelf/handler.rs` 彻底删除。旧路径现在的行为：
    //   - `GET /shelves/processes`      → 400，且响应体不是 `R` 信封
    //     （落到 shelf 域 `/{id}` 路由，`processes` 解析不成 i64 被 axum
    //     `Path<i64>` 拒掉，返回纯文本 → 前端统一信封错误解析会抛解析异常）
    //   - `GET|POST /shelves/{id}/processes` → 404（写路径 404 = 保存功能全废）
    // 两条都不会给出可展示的业务码，**没有静默降级的可能**。
    //
    // C1 / C1b / C3 / C4 各自已逐字钉死自己那条 URL，本用例是它们的**命名空间
    // 兜底**：逐个收集本模块 3 个函数实际发出的 URL，断言
    //   ① 每条都以 `/prod/shelf-processes` 开头（不容 second namespace 混进来）
    //   ② 没有一条残留旧 `/shelves/` 前缀 —— 防止后人「顺手」把某个路径抄回去，
    //      也防止将来新增映射端点时忘了跟随后端搬域。
    // 不做成「遍历 shelves.ts 源码文本」的静态断言：那会绑死注释里的示例 URL，
    // 反而制造改注释即红的噪声；行为级断言（mock 收到的实际 URL）才是契约本身。
    httpGetMock.mockResolvedValue({ data: { items: [] } });
    httpPostMock.mockResolvedValue({ data: null });

    await getAllShelfProcessMappings();
    await getShelfProcesses('8800000000001');
    await setShelfProcesses('8800000000001', {
      items: [{ process_id: '190000000000001', sort_order: 0 }],
    });

    const urls = [
      ...httpGetMock.mock.calls.map((c) => c[0] as string),
      ...httpPostMock.mock.calls.map((c) => c[0] as string),
    ];
    // 三个函数各发一次，不多不少。
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.startsWith('/prod/shelf-processes')).toBe(true);
      expect(url.startsWith('/shelves/')).toBe(false);
      // 旧路径的两种形态逐字排除：全集 `/shelves/processes` 与单架
      // `/shelves/{id}/processes`。
      expect(url).not.toMatch(/^\/shelves\/(processes|.*\/processes)$/);
    }
  });
});
