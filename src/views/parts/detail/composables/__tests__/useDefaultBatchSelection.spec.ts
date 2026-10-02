// src/views/parts/detail/composables/__tests__/useDefaultBatchSelection.spec.ts
//
// 2026-10-03 新增：兜底选中批次的规则守卫。
//
// 为什么必须有这个文件：兜底逻辑原先内联在 PartDetail.vue 的 watch 里，零测试覆盖，
// 于是「选中 list[0]」这个错误规则能一直存活 —— `GET /parts/{id}/batches` 按
// batch_no ASC 且无 status 过滤，第一行是最老批次，而初始批次（PENDING）与被取消的
// 批次 current_process_step_id 恒 NULL，选中它们 → currentStepId = null →
// 工序链时间轴照样全灰（本该被修掉的 UI 缺陷换了个成因继续存在）。
// 抽出成纯函数 + composable 后，这里能钉住「优先带工序链定位的批次」与
// 「不覆盖用户已有选择」两条语义。

import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import type { PartBatch } from '@/api/parts';
import { pickDefaultBatch, useDefaultBatchSelection } from '../useDefaultBatchSelection';

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

describe('pickDefaultBatch（兜底选中的判据）', () => {
  it('D0：优先带 current_process_step_id 的批次，而不是列表第一条', () => {
    const list = [
      makeBatch({ id: 'b1', batch_no: 1, current_process_step_id: null }),
      makeBatch({ id: 'b2', batch_no: 2, current_process_step_id: 'step-3' }),
      makeBatch({ id: 'b3', batch_no: 3, current_process_step_id: 'step-1' }),
    ];
    expect(pickDefaultBatch(list)?.id).toBe('b2');
  });

  it('D0b：全部未绑定工序链步骤 → 回落第一条（不是 null，进页面仍有锚点）', () => {
    const list = [
      makeBatch({ id: 'b1', current_process_step_id: null }),
      makeBatch({ id: 'b2', current_process_step_id: null }),
    ];
    expect(pickDefaultBatch(list)?.id).toBe('b1');
  });

  it('D0c：空列表 → null', () => {
    expect(pickDefaultBatch([])).toBeNull();
  });
});

describe('useDefaultBatchSelection（watch 行为）', () => {
  it('D1：batches 到达且首条无工序链定位 → 选中带定位的那条', async () => {
    const batches = ref<PartBatch[]>([]);
    const selectedBatchId = ref<string | null>(null);
    useDefaultBatchSelection(batches, selectedBatchId);

    batches.value = [
      makeBatch({ id: 'b1', batch_no: 1, current_process_step_id: null }),
      makeBatch({ id: 'b2', batch_no: 2, current_process_step_id: 'step-3' }),
    ];
    await nextTick();

    expect(selectedBatchId.value).toBe('b2');
  });

  it('D2：用户手动取消选中后不选回（batches 引用不变 ⇒ watch 不触发）', async () => {
    const batches = ref<PartBatch[]>([makeBatch({ id: 'b1' })]);
    const selectedBatchId = ref<string | null>(null);
    useDefaultBatchSelection(batches, selectedBatchId);
    await nextTick();
    expect(selectedBatchId.value).toBe('b1');

    // PartBatchMonitorCard 再点同一行 → onBatchSelect(null)
    selectedBatchId.value = null;
    await nextTick();
    expect(selectedBatchId.value).toBeNull();
  });

  it('D3：用户已选中某批次后 batches 刷新（引用变化）→ 不覆盖用户选择', async () => {
    const batches = ref<PartBatch[]>([makeBatch({ id: 'b1' }), makeBatch({ id: 'b2' })]);
    const selectedBatchId = ref<string | null>('b2');
    useDefaultBatchSelection(batches, selectedBatchId);

    batches.value = [makeBatch({ id: 'b1' }), makeBatch({ id: 'b2' })];
    await nextTick();

    expect(selectedBatchId.value).toBe('b2');
  });

  it('D4：空批次列表 → 保持 null，不写入脏 id', async () => {
    const batches = ref<PartBatch[]>([]);
    const selectedBatchId = ref<string | null>(null);
    useDefaultBatchSelection(batches, selectedBatchId);
    await nextTick();
    expect(selectedBatchId.value).toBeNull();
  });

  it('D5：切 partId 场景 —— 外部把选中置 null 后，新批次到达兜底到新批次', async () => {
    const batches = ref<PartBatch[]>([makeBatch({ id: 'old-1' })]);
    const selectedBatchId = ref<string | null>(null);
    useDefaultBatchSelection(batches, selectedBatchId);
    await nextTick();
    expect(selectedBatchId.value).toBe('old-1');

    // 切 partId：useProcessChain / route watch 都会把 selectedBatchId 置空
    selectedBatchId.value = null;
    batches.value = [
      makeBatch({ id: 'new-1', batch_no: 1, current_process_step_id: null }),
      makeBatch({ id: 'new-2', batch_no: 2, current_process_step_id: 'step-1' }),
    ];
    await nextTick();

    expect(selectedBatchId.value).toBe('new-2');
  });
});
