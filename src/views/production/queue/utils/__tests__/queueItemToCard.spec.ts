// @vitest-environment node
// src/views/production/queue/utils/__tests__/queueItemToCard.spec.ts
//
// 2026-10-09 新增：生产队列域三个 wire DTO → `BatchCardModel` 适配层的
// **`has_process_chain`（卡片左边框语义）**逐来源映射 guard。
//
// 为什么单独守这一层：边框色是卡片上最显眼的批次级语义，而三个 DTO 里这个字段的
// 来源**三者各不相同**（两个透传后端派生列、一个必须在前端推导），推导口径一旦写错，
// 表现是「某一片卡片绿边框亮错」而不是任何报错：
//   - 工序候选池 / 工人持有：后端派生列，直通；
//   - 待下发批次：wire DTO **没有**该字段（`GET /prod/queue/pending` 未加），只能按
//     `process_chain_id !== '0'` 推导 —— 后端那列的口径在 pending 上会恒 false
//     （待下发批次按定义没 dispatch 过，指针恒 NULL），所以推导不是「抄一遍」。
//
// 测试策略：纯函数，无 Vue / Query / api 依赖，直接 import 被测模块。

import { describe, expect, it } from 'vitest';
import { heldToCard, pendingBatchToCard, poolItemToCard } from '../queueItemToCard';
import type {
  QueueHeldBatchDto,
  QueuePendingBatchDto,
  QueuePoolItemDto,
} from '@/api/productionQueue.contract';

function makePoolItem(over: Partial<QueuePoolItemDto> = {}): QueuePoolItemDto {
  return {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    batch_no: 1024,
    quantity: 12,
    serial_no: 'SN-0001',
    name: '连杆',
    drawing_no: 'DRW-1',
    system_delivery_date: '2026-10-20',
    customer_name: '某某零件厂',
    parent_customer_name: '某某集团',
    applicant_name: '张三',
    shelf_id: '5000000000001',
    shelf_code: 'A-01',
    shelf_name: '生产架 A',
    is_urgent: false,
    has_process_chain: true,
    has_cnc_program: true,
    note: null,
    version: 3,
    ...over,
  };
}

function makeHeld(over: Partial<QueueHeldBatchDto> = {}): QueueHeldBatchDto {
  return {
    batch_id: '3000000000002',
    part_id: '4000000000002',
    batch_no: 1025,
    quantity: 5,
    serial_no: 'SN-0002',
    name: '齿轮',
    drawing_no: 'DRW-2',
    system_delivery_date: '2026-10-22',
    planned_delivery_date: '2026-11-01',
    is_urgent: false,
    has_process_chain: true,
    has_cnc_program: false,
    customer_name: '某某零件厂',
    parent_customer_name: '某某集团',
    applicant_name: '李四',
    location: 'WORKER',
    note: null,
    version: 4,
    ...over,
  };
}

function makePending(over: Partial<QueuePendingBatchDto> = {}): QueuePendingBatchDto {
  return {
    batch_id: '3000000000003',
    part_id: '4000000000003',
    batch_no: 1026,
    quantity: 1,
    serial_no: null,
    name: '法兰',
    drawing_no: 'DRW-3',
    planned_delivery_date: '2026-11-05',
    system_delivery_date: null,
    customer_name: null,
    parent_customer_name: null,
    applicant_name: null,
    is_urgent: false,
    note: null,
    version: 0,
    // 后端非 Option i64 + unwrap_or(0)：未挂 / 未制定都是字符串 "0"
    current_process_step_id: '0',
    process_chain_id: '8000000000001',
    ...over,
  };
}

describe('queueItemToCard — 工序候选池 / 工人持有：透传后端派生列', () => {
  it('QC1：poolItemToCard 直通 has_process_chain（真 / 假两态）', () => {
    expect(poolItemToCard(makePoolItem()).has_process_chain).toBe(true);
    expect(poolItemToCard(makePoolItem({ has_process_chain: false })).has_process_chain).toBe(
      false,
    );
  });

  it('QC2：heldToCard 直通 has_process_chain（真 / 假两态）', () => {
    expect(heldToCard(makeHeld()).has_process_chain).toBe(true);
    expect(heldToCard(makeHeld({ has_process_chain: false })).has_process_chain).toBe(false);
  });
});

describe('queueItemToCard — 待下发批次：按 process_chain_id !== "0" 推导', () => {
  // 待下发端点没有派生列，判据错半步（拿 `!== '0'` 当成「指针已定位」）就会让
  // 未制定链的批次亮绿边框 —— 而它们恰恰是下发前最需要人工确认工序的那一批。
  it('QC3：process_chain_id 为 "0"（未制定链）→ false', () => {
    expect(pendingBatchToCard(makePending({ process_chain_id: '0' })).has_process_chain).toBe(
      false,
    );
  });

  it('QC4：真实链 id → true（与 current_process_step_id 恒 "0" 无关）', () => {
    // 待下发批次按定义还没 dispatch 过 ⇒ 指针恒 "0"。这正是本条必须独立于指针判据的
    // 原因：pending 端点的驱动 SQL 不 join 链，后端派生列在这里只会恒 false。
    expect(pendingBatchToCard(makePending()).has_process_chain).toBe(true);
    expect(
      pendingBatchToCard(makePending({ process_chain_id: '0', current_process_step_id: '0' }))
        .has_process_chain,
    ).toBe(false);
  });

  it('QC5：判据只认 "0" 这一个哨兵 —— null / 空串不是合法 wire 形态', () => {
    // 后端是非 Option i64 + unwrap_or(0)，键恒在、值恒是字符串数字。这里锁住
    // 「字符串 "0" 才是未制定」，防止将来有人把判据宽松成 falsy / nullish 后
    // 把 '0' 也当成有链。
    expect(pendingBatchToCard(makePending({ process_chain_id: '1' })).has_process_chain).toBe(true);
    expect(
      pendingBatchToCard(makePending({ process_chain_id: '1234567890123' })).has_process_chain,
    ).toBe(true);
  });
});
