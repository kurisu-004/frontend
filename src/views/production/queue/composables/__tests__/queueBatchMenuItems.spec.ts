// src/views/production/queue/composables/__tests__/queueBatchMenuItems.spec.ts
//
// 2026-10-09 新增：生产队列三区右键菜单项**派生矩阵**的逐格 spec。
//
// 派生是纯函数（四维：区域 × 角色 × 批次状态 × 目标集），不碰 api / store / DOM，所以
// 可以把矩阵整张铺开逐格断言 —— 板级 spec 只守接线（「板级把什么递进派生函数」），派生
// 本身守在这里。
//
// 覆盖：
//   - Q1：待下发池 —— 不给召回（召回自己无意义）；给拆批；给「发送到工序」二级菜单
//     （目标集 = 全量工序，INHOUSE + OUTSOURCE 都要）；
//   - Q2：工序候选池 —— 召回 + 拆批 + 「派给工人」二级菜单；
//   - Q3：工人列 —— 召回 + **不给拆批** + 「转交给工人」二级菜单**排除自己所在列**；
//   - Q3b：工人列反查不到自己所在列时**整项不给**「转交给工人」（from 为空必被后端拒）；
//   - Q4：角色闸 —— 无召回权 / 无拆批权逐项消失（不是「一次性闸」）；
//   - Q5：批次闸 —— `quantity <= 1` 时三个区都不给拆批（后端要求拆出数量 ∈ [1, n-1]，
//     给选项就是给一个必然失败的入口）；
//   - Q6：目标集为空（工序列表未加载 / 该工序没有工人）时**不给**二级菜单那一项 ——
//     给一个点开是空白的二级菜单比不给更难解释；
//   - Q7：二级菜单的 children 结构与文案（工序 `code name` / 工人名）+ onClick 闭包
//     把目标 id 传出去。
//
// 测试策略：纯函数，直接调；onClick 用 spy 断言「点了哪一项、带的是哪个目标 id」。

import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '@imengyu/vue3-context-menu';
import { buildQueueBatchMenuItems, type QueueBatchMenuInput } from '../queueBatchMenuItems';
import type { BatchCardModel } from '@/types/batchCard';

function makeCard(overrides: Partial<BatchCardModel> = {}): BatchCardModel {
  return {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    batch_no: 'B1024',
    part_name: '连杆',
    drawing_no: 'DRW-1',
    serial_no: 'SN-0001',
    quantity: 6,
    system_delivery_date: '2026-10-20',
    planned_delivery_date: null,
    is_urgent: false,
    has_process_chain: false,
    has_cnc_program: false,
    customer_l1: '某某集团',
    customer_l2: null,
    applicant_name: '张三',
    note: null,
    location: 'SH-A01',
    shelf_id: '5000000000001',
    version: 7,
    ...overrides,
  };
}

const PROCESSES = [
  { id: 'P-1', code: 'IP10', name: '自产车削' },
  { id: 'P-2', code: 'OP10', name: '外协粗车' },
];

const WORKERS = [
  { worker_id: 'W-1', name: '张三' },
  { worker_id: 'W-2', name: '李四' },
];

/** 默认入参（全权、余量足够、目标集齐全），各用例只改自己关心的那一维。
 *
 *  `selfWorkerId` 默认给 W-1 —— 工人列上真正常驻的卡总能反查到自己所在列（见
 *  Q3b：反查不到时那一项整个消失，那是唯一的例外）。 */
function input(overrides: Partial<QueueBatchMenuInput> = {}): QueueBatchMenuInput {
  return {
    area: 'pool',
    batch: makeCard(),
    canRecall: true,
    canSplit: true,
    processes: PROCESSES,
    workers: WORKERS,
    selfWorkerId: 'W-1',
    onRecall: vi.fn(),
    onSplit: vi.fn(),
    onDispatch: vi.fn(),
    onMoveToWorker: vi.fn(),
    onTransfer: vi.fn(),
    ...overrides,
  };
}

const labels = (items: MenuItem[]) => items.map((i) => i.label);
const childrenOf = (items: MenuItem[], label: string) =>
  items.find((i) => i.label === label)?.children ?? [];

describe('buildQueueBatchMenuItems（生产队列三区的菜单项派生）', () => {
  it('Q1：待下发池 = 拆批 + 发送到工序（不给召回）', () => {
    const items = buildQueueBatchMenuItems(input({ area: 'pending' }));
    expect(labels(items)).toEqual(['拆分批次', '发送到工序']);
  });

  it('Q2：工序候选池 = 召回 + 拆批 + 派给工人', () => {
    const items = buildQueueBatchMenuItems(input({ area: 'pool' }));
    expect(labels(items)).toEqual(['召回到待下发', '拆分批次', '派给工人']);
  });

  it('Q3：工人列 = 召回 + 转交给工人（不给拆批；二级菜单排除自己所在列）', () => {
    const items = buildQueueBatchMenuItems(input({ area: 'worker', selfWorkerId: 'W-1' }));
    expect(labels(items)).toEqual(['召回到待下发', '转交给工人']);
    // 自己那一列不进「转交给工人」—— 转交给自己不构成一次移动
    expect(childrenOf(items, '转交给工人').map((c) => c.label)).toEqual(['李四']);
  });

  it('Q3b：工人列反查不到自己所在列 → **整项不给**「转交给工人」（不给必失败的入口）', () => {
    // `moveBatchBetweenWorkers` 的 from 就是 selfWorkerId，而那个包装只守 version、
    // 对 fromWorkerId 零校验：空串会原样发出去由后端拒。若这里放行，菜单会把**所有**
    // 工人（含真正持有该批次的那位，因为过滤器此时无差别）列成目标，点了必失败。
    // 可达路径只有切 tab 的过渡窗口（el-tab-pane 用 v-show 常驻，旧 pane 的卡仍可
    // 右键，而 activeTab 已指向新 tab、其看板缓存里没有这张卡）。
    const items = buildQueueBatchMenuItems(input({ area: 'worker', selfWorkerId: undefined }));
    expect(labels(items)).toEqual(['召回到待下发']);
    expect(childrenOf(items, '转交给工人')).toEqual([]);
  });

  it('Q4a：无召回权 → 三个区都少「召回到待下发」', () => {
    expect(labels(buildQueueBatchMenuItems(input({ area: 'pool', canRecall: false })))).toEqual([
      '拆分批次',
      '派给工人',
    ]);
    expect(labels(buildQueueBatchMenuItems(input({ area: 'worker', canRecall: false })))).toEqual([
      '转交给工人',
    ]);
  });

  it('Q4b：无拆批权 → 三个区都少「拆分批次」（逐项闸，不是「一次性闸」）', () => {
    expect(labels(buildQueueBatchMenuItems(input({ area: 'pending', canSplit: false })))).toEqual([
      '发送到工序',
    ]);
    expect(labels(buildQueueBatchMenuItems(input({ area: 'pool', canSplit: false })))).toEqual([
      '召回到待下发',
      '派给工人',
    ]);
  });

  it('Q5：余量 ≤ 1 → 三个区都不给「拆分批次」（后端要求拆出数量 ∈ [1, n-1]）', () => {
    const card = makeCard({ quantity: 1 });
    expect(labels(buildQueueBatchMenuItems(input({ area: 'pending', batch: card })))).toEqual([
      '发送到工序',
    ]);
    expect(labels(buildQueueBatchMenuItems(input({ area: 'pool', batch: card })))).toEqual([
      '召回到待下发',
      '派给工人',
    ]);
    expect(labels(buildQueueBatchMenuItems(input({ area: 'worker', batch: card })))).toEqual([
      '召回到待下发',
      '转交给工人',
    ]);
  });

  it('Q6a：工序列表为空 → 待下发池不给「发送到工序」（不给空白二级菜单）', () => {
    const items = buildQueueBatchMenuItems(input({ area: 'pending', processes: [] }));
    expect(labels(items)).toEqual(['拆分批次']);
  });

  it('Q6b：工序池没有工人 → 不给「派给工人」（空工人列是拖拽落点，但菜单里给个空项没意义）', () => {
    const items = buildQueueBatchMenuItems(input({ area: 'pool', workers: [] }));
    expect(labels(items)).toEqual(['召回到待下发', '拆分批次']);
  });

  it('Q6c：工人列只剩自己 → 不给「转交给工人」', () => {
    const items = buildQueueBatchMenuItems(
      input({ area: 'worker', workers: [{ worker_id: 'W-1', name: '张三' }], selfWorkerId: 'W-1' }),
    );
    expect(labels(items)).toEqual(['召回到待下发']);
  });

  it('Q7a：发送到工序的二级菜单文案 = `code name`，onClick 带目标工序 id', () => {
    const onDispatch = vi.fn();
    const items = buildQueueBatchMenuItems(input({ area: 'pending', onDispatch }));
    const children = childrenOf(items, '发送到工序');
    expect(children.map((c) => c.label)).toEqual(['IP10 自产车削', 'OP10 外协粗车']);
    children[1]!.onClick!();
    expect(onDispatch).toHaveBeenCalledWith('P-2');
  });

  it('Q7b：派给工人 / 转交给工人的 onClick 带目标工人 id', () => {
    const onMoveToWorker = vi.fn();
    const onTransfer = vi.fn();
    const poolItems = buildQueueBatchMenuItems(input({ area: 'pool', onMoveToWorker }));
    childrenOf(poolItems, '派给工人')[0]!.onClick!();
    expect(onMoveToWorker).toHaveBeenCalledWith('W-1');

    const workerItems = buildQueueBatchMenuItems(
      input({ area: 'worker', selfWorkerId: 'W-1', onTransfer }),
    );
    childrenOf(workerItems, '转交给工人')[0]!.onClick!();
    expect(onTransfer).toHaveBeenCalledWith('W-2');
  });

  it('Q7c：召回 / 拆批的 onClick 不带参数（目标批次由板级闭包持有）', () => {
    const onRecall = vi.fn();
    const onSplit = vi.fn();
    const items = buildQueueBatchMenuItems(input({ area: 'pool', onRecall, onSplit }));
    items[0]!.onClick!();
    items[1]!.onClick!();
    expect(onRecall).toHaveBeenCalledWith();
    expect(onSplit).toHaveBeenCalledWith();
  });

  it('Q8：目标过多不自己截断 —— 全部进二级菜单，靠菜单的 maxHeight 滚动', () => {
    // 100 名工人 / 100 道工序都要进列表：截断会让「目标明明在却找不到」。
    const many = Array.from({ length: 100 }, (_, i) => ({ worker_id: `W-${i}`, name: `工人${i}` }));
    const items = buildQueueBatchMenuItems(input({ area: 'pool', workers: many }));
    expect(childrenOf(items, '派给工人')).toHaveLength(100);
  });
});
