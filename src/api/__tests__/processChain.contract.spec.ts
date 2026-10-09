// src/api/__tests__/processChain.contract.spec.ts
//
// 2026-10-10 新增（review 第 1 轮 次要 8）：`processChainSchema` 的守门有效性 +
// `getProcessChainById` 真的把它接在返回路径上。
//
// 背景：零件详情域写了三条守门 schema，前两条（详情 / 事件）接在 queryFn 上，第三条
// （工序链）此前**只被自己的 spec 引用、生产零消费** —— 删掉 `.parse()` 全仓无感。
// 守门点选在 api 层而不是新开 query hook：工序链的两个消费方（零件详情页的
// `useProcessChain`、「制定工序」页的 `useProcessDesignStore`）各写各的 fetch /
// queryFn，没有统一的 queryFn 可挂，而「api 层守门」正是 CLAUDE.md 为「没有 queryFn
// 承载的调用」留的口子（同 `listRepairBatches` / `listProcessDesignParts`）。
//
// ⚠️ **这条是「parse 真的接在返回路径上」的守卫**：把 api 层那行 `.parse()` 删掉时
// 下面 G 组全红 —— 上一版只有 schema 自身行为的 F 组（partDetailSchema.spec.ts），
// 那个形状在 parse 被拆掉时依然全绿。
//
// mock 手法沿 productionScan.contract.spec.ts / inspection.contract.spec.ts 同款：
// 整模块桩掉 `@/api/http`（不 importOriginal）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const httpGetMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: { get: (...args: unknown[]) => httpGetMock(...args) },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import { getProcessChainById } from '../processChain';

const CHAIN_ID = '9000000000010';

/** 一行合法的 `ProcessChainOut`（后端 `prod/process_chain/vo/process_chain.rs`）。 */
function validChain() {
  return {
    id: CHAIN_ID,
    name: '默认工艺',
    note: null,
    version: 2,
    created_at: '2026-09-20 08:00:00',
    updated_at: '2026-09-21 08:00:00',
    steps: [
      {
        id: '9100000000001',
        sort_order: 0,
        process_id: '9200000000001',
        estimated_minutes: 30,
        note: null,
        version: 1,
      },
      // 后端 step.note 挂了 skip_serializing_if：没写备注时**键不存在**（不是 null）
      {
        id: '9100000000002',
        sort_order: 1,
        process_id: '9200000000002',
        estimated_minutes: 45,
        version: 1,
      },
    ],
  };
}

beforeEach(() => {
  httpGetMock.mockReset().mockResolvedValue({ data: validChain() });
});

describe('G1：URL 与响应形态', () => {
  it('G1a：GET /prod/process-chains/{chain_id}（雪花 ID 走 encodeURIComponent）', async () => {
    await getProcessChainById(CHAIN_ID);
    expect(httpGetMock).toHaveBeenCalledWith(`/prod/process-chains/${CHAIN_ID}`);
    await getProcessChainById('a/b');
    expect(httpGetMock).toHaveBeenLastCalledWith('/prod/process-chains/a%2Fb');
  });

  it('G1b：合法响应原样返回（steps 顺序不二次排序）', async () => {
    const chain = await getProcessChainById(CHAIN_ID);
    expect(chain.id).toBe(CHAIN_ID);
    expect(chain.steps.map((s) => s.id)).toEqual(['9100000000001', '9100000000002']);
    // step.note 键不存在 ⇒ undefined（消费侧 ProcessChainCard 的 v-if 不渲染）
    expect(chain.steps[1]?.note).toBeUndefined();
  });
});

describe('G2：Zod 守门真的接在返回路径上（删掉 parse 时本组全红）', () => {
  it('G2a：缺 steps ⇒ 抛 ZodError（Zod strip 陷阱 guard）', async () => {
    const bad = validChain() as Record<string, unknown>;
    delete bad.steps;
    httpGetMock.mockReset().mockResolvedValue({ data: bad });
    await expect(getProcessChainById(CHAIN_ID)).rejects.toBeInstanceOf(ZodError);
  });

  it('G2b：step 的雪花 ID 发 number ⇒ 抛（19 位 ID 在 JS Number 下丢精度）', async () => {
    const bad = validChain();
    (bad.steps[0] as unknown as Record<string, unknown>).process_id = 9200000000001;
    httpGetMock.mockReset().mockResolvedValue({ data: bad });
    await expect(getProcessChainById(CHAIN_ID)).rejects.toBeInstanceOf(ZodError);
  });

  it('G2c：多一个未知键被静默 strip（本 schema 有意不接 .strict()，后端加派生列不该白屏）', async () => {
    httpGetMock.mockReset().mockResolvedValue({ data: { ...validChain(), ghost_derived: 1 } });
    const chain = await getProcessChainById(CHAIN_ID);
    expect('ghost_derived' in chain).toBe(false);
  });

  it('G2d：正向对照 —— 合法响应不抛（证明 G2a~G2c 不是恒真断言）', async () => {
    await expect(getProcessChainById(CHAIN_ID)).resolves.toMatchObject({ id: CHAIN_ID });
  });
});

describe('G3：404 / 20701 的空链兜底语义不受守门影响', () => {
  it('G3a：HTTP 层就抛出的错误原样上抛（根本没走到 .parse()）', async () => {
    const netError = Object.assign(new Error('20701 BIZ_PROCESS_CHAIN_NOT_FOUND'), {
      code: 20701,
    });
    httpGetMock.mockReset().mockRejectedValue(netError);
    // 两个消费方（useProcessChain 的 try/catch、useProcessDesignStore 的 20701 分支）
    // 都靠这个错误对象分流，守门不能把它换成 ZodError。
    await expect(getProcessChainById(CHAIN_ID)).rejects.toBe(netError);
  });
});
