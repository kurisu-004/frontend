// src/views/parts/detail/composables/__tests__/useProcessChain.spec.ts
//
// 2026-10-02 新增：useProcessChain 的 currentStepId 派生 + 切 partId 重置守卫。
//
// 为什么要有（背景）：
//   零件详情页的工序链时间轴靠 `currentStepId` 决定高亮哪一步（ProcessChainCard 的
//   currentIndex）。它是纯派生量：selectedBatchId → batches 里找该批次 →
//   `current_process_step_id`。三个输入任一为空都退化成「不高亮」，而**空与
//   「数据没对上」在 UI 上长得一模一样**（全灰），所以这层派生必须有单测钉住。
//   顺带守「切 partId 清空 selectedBatchId」——不清会拿上一个 part 的批次 id 去
//   新 part 的 batches 里找（找不到 → 静默不高亮）。
//
// mock 手法：整模块桩掉 `@/api/processChain`（只留 getProcessChainById），
// node env 不需要 axios / ElMessage。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import type { PartBatch, PartItem } from '@/api/parts';

const getProcessChainByIdMock = vi.fn();

vi.mock('@/api/processChain', () => ({
  getProcessChainById: (id: string) => getProcessChainByIdMock(id),
}));

import { useProcessChain } from '../useProcessChain';

function makeBatch(over: Partial<PartBatch> = {}): PartBatch {
  return {
    id: '190000000000001',
    version: 1,
    part_id: '42',
    batch_no: 1,
    batch_label: 'L1',
    quantity: 10,
    status: 'IN_PROCESS',
    is_repairing: false,
    location: 'PRODUCTION_SHELF',
    current_holder_id: '8800000000001',
    current_holder_display: 'A-01',
    current_process_step_id: 'step-2',
    next_process_name: null,
    delivery_note_id: null,
    delivery_note_no: null,
    parent_batch_id: null,
    created_at: '2026-10-01 08:00:00',
    updated_at: '2026-10-01 08:00:00',
    ...over,
  };
}

// 本组用例只关心 process_chain_id 一个字段，其余字段用 `unknown` 桥接占位
// （PartItem 字段很多，逐个补齐会淹没被测的派生逻辑）。
const PART_PARTIAL: PartItem = { id: '42' } as unknown as PartItem;

function makePart(chainId: string | null): PartItem {
  return { ...PART_PARTIAL, process_chain_id: chainId };
}

beforeEach(() => {
  getProcessChainByIdMock.mockReset();
});

describe('2026-10-02：useProcessChain currentStepId 派生', () => {
  it('S1：未选中批次 → null（调用方据此不高亮任何步骤）', () => {
    const partId = ref('42');
    const part = ref<PartItem | null>(makePart('chain-1'));
    const batches = ref<PartBatch[]>([makeBatch()]);
    const selectedBatchId = ref<string | null>(null);

    const chain = useProcessChain(partId, part, batches, selectedBatchId);

    expect(chain.currentStepId.value).toBeNull();
  });

  it('S2：选中批次 → 该批次的 current_process_step_id', () => {
    const partId = ref('42');
    const part = ref<PartItem | null>(makePart('chain-1'));
    const batches = ref<PartBatch[]>([makeBatch({ id: 'b1' }), makeBatch({ id: 'b2', current_process_step_id: 'step-3' })]);
    const selectedBatchId = ref<string | null>(null);

    const chain = useProcessChain(partId, part, batches, selectedBatchId);
    expect(chain.currentStepId.value).toBeNull();

    chain.setSelectedBatchId('b2');
    expect(chain.currentStepId.value).toBe('step-3');
  });

  it('S3：批次未绑定工序链步骤（字段缺 / null）→ null', () => {
    const partId = ref('42');
    const part = ref<PartItem | null>(makePart('chain-1'));
    const batches = ref<PartBatch[]>([
      makeBatch({ id: 'b1', current_process_step_id: null }),
      makeBatch({ id: 'b2', current_process_step_id: undefined }),
    ]);
    const selectedBatchId = ref<string | null>('b1');

    const chain = useProcessChain(partId, part, batches, selectedBatchId);
    expect(chain.currentStepId.value).toBeNull();

    selectedBatchId.value = 'b2';
    expect(chain.currentStepId.value).toBeNull();
  });

  it('S4：切 partId → selectedBatchId 被清空（不留上个 part 的批次 id）', async () => {
    const partId = ref('42');
    const part = ref<PartItem | null>(makePart('chain-1'));
    const batches = ref<PartBatch[]>([makeBatch({ id: 'b1' })]);
    const selectedBatchId = ref<string | null>('b1');

    const chain = useProcessChain(partId, part, batches, selectedBatchId);
    expect(chain.currentStepId.value).toBe('step-2');

    partId.value = '43';
    // watch(partId) 默认 flush: 'pre'，让出微任务队列再断言
    await Promise.resolve();
    await Promise.resolve();

    expect(selectedBatchId.value).toBeNull();
    expect(chain.currentStepId.value).toBeNull();
    expect(chain.steps.value).toEqual([]);
    expect(chain.chain.value).toBeNull();
  });

  it('S5：fetchProcessChain 拿到步骤后 currentStepId 仍按选中批次派生', async () => {
    getProcessChainByIdMock.mockResolvedValue({
      id: 'chain-1',
      name: '默认工艺',
      note: null,
      version: 1,
      created_at: '2026-10-01 08:00:00',
      updated_at: '2026-10-01 08:00:00',
      steps: [
        { id: 'step-1', sort_order: 0, process_id: 'p1', estimated_minutes: 10 },
        { id: 'step-2', sort_order: 1, process_id: 'p2', estimated_minutes: 20 },
      ],
    });

    const partId = ref('42');
    const part = ref<PartItem | null>(makePart('chain-1'));
    const batches = ref<PartBatch[]>([makeBatch({ id: 'b1', current_process_step_id: 'step-2' })]);
    const selectedBatchId = ref<string | null>('b1');

    const chain = useProcessChain(partId, part, batches, selectedBatchId);
    await chain.fetchProcessChain();

    expect(chain.steps.value.map((s) => s.id)).toEqual(['step-1', 'step-2']);
    expect(chain.currentStepId.value).toBe('step-2');
    // step-2 在索引 1 ⇒ ProcessChainCard 会给它打 current-step
    expect(chain.steps.value.findIndex((s) => s.id === chain.currentStepId.value)).toBe(1);
  });

  it('S6：拉链失败（404 无链）→ 空链兜底，不抛', async () => {
    getProcessChainByIdMock.mockRejectedValue(new Error('20701 BIZ_PROCESS_CHAIN_NOT_FOUND'));

    const partId = ref('42');
    const part = ref<PartItem | null>(makePart('chain-1'));
    const batches = ref<PartBatch[]>([]);
    const selectedBatchId = ref<string | null>(null);

    const chain = useProcessChain(partId, part, batches, selectedBatchId);
    await expect(chain.fetchProcessChain()).resolves.toBeUndefined();
    expect(chain.steps.value).toEqual([]);
  });
});
