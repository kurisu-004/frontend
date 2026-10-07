// src/views/outsource/composables/__tests__/outsourceBatchMenuItems.spec.ts
//
// 2026-10-09 新增：外协两区右键菜单项**派生矩阵**的逐格 spec。
//
// 与生产队列侧同款分层：派生是纯函数（四维：区域 × 角色 × 批次状态 × 报价路径），不碰
// api / store / DOM，所以矩阵可以整张铺开逐格断言。板级 spec 只守接线。
//
// 覆盖：
//   - O1：公司列 = 回收生产 + 回收品检 + 拆分批次；**不给**召回与「发送到」；
//   - O2：候选池 = 召回 + 拆分批次 + 发送到外协公司（二级菜单）；
//   - O3：角色闸逐项生效（Inspector 拿得到回收两项、拿不到拆批 / 召回）；
//   - O4：批次闸 —— 余量 ≤ 1 不给拆批；PENDING 未上架的行不给召回；
//   - O5：发送白名单 —— APPROVAL 只给报价锁定的一家；DIRECT 给 company_options 里的；
//     白名单与当前 tab 的公司列求交（没被映射成列的公司不进列表）；
//   - O6：`can_send=false`（后端派生的可发送判据）整个不给「发送到」；
//   - O7：目标过多不自己截断（靠菜单的 maxHeight 滚动）。
//
// 测试策略：纯函数，直接调；onClick 用 spy 断言「点了哪一项、带的是哪个公司 id」。

import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '@imengyu/vue3-context-menu';
import {
  buildOutsourceBatchMenuItems,
  sendableCompanyIds,
  type OutsourceBatchMenuInput,
} from '../outsourceBatchMenuItems';
import type { OutsourceQueueCandidateData } from '../outsourceQueueSchema';
import type { BatchCardModel } from '@/types/batchCard';

const COMPANY_A = '9000000000001';
const COMPANY_B = '9000000000002';

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
    has_cnc_program: false,
    customer_l1: '某某集团',
    customer_l2: null,
    applicant_name: '张三',
    note: null,
    location: 'OUTSOURCE_COMPANY',
    shelf_id: null,
    version: 7,
    ...overrides,
  };
}

/** 一条 APPROVAL 候选行：目标是报价锁定的那家公司。 */
function approvalCandidate(
  overrides: Partial<OutsourceQueueCandidateData> = {},
): OutsourceQueueCandidateData {
  return {
    version: 5,
    send_mode: 'APPROVAL',
    part_id: '4000000000001',
    part_serial_no: 'SN-0001',
    part_drawing_no: 'DRW-1',
    part_name: '连杆',
    quantity: 6,
    batch_id: '3000000000001',
    batch_no: 1024,
    planned_delivery_date: null,
    is_urgent: false,
    customer_name: null,
    parent_customer_name: null,
    shelf_code: 'SH-A01',
    shelf_id: '5000000000001',
    outsource_company_id: COMPANY_A,
    outsource_company_name: '外协厂甲',
    quote_id: '7000000000001',
    company_options: [],
    price: '12.50',
    has_cnc_program: false,
    applicant_name: null,
    note: null,
    system_delivery_date: null,
    can_send: true,
    ...overrides,
  };
}

/** 一条 DIRECT 候选行：目标是 company_options 里的任一家。 */
function directCandidate(
  overrides: Partial<OutsourceQueueCandidateData> = {},
): OutsourceQueueCandidateData {
  return {
    ...approvalCandidate(),
    send_mode: 'DIRECT',
    outsource_company_id: null,
    outsource_company_name: null,
    quote_id: null,
    company_options: [
      { id: COMPANY_A, name: '外协厂甲' },
      { id: COMPANY_B, name: '外协厂乙' },
    ],
    ...overrides,
  };
}

const COMPANIES = [
  { company_id: COMPANY_A, name: '外协厂甲' },
  { company_id: COMPANY_B, name: '外协厂乙' },
];

function input(overrides: Partial<OutsourceBatchMenuInput> = {}): OutsourceBatchMenuInput {
  return {
    area: 'outsource-company',
    batch: makeCard(),
    canMove: true,
    canSplit: true,
    canRecall: true,
    companies: COMPANIES,
    candidate: approvalCandidate(),
    onSend: vi.fn(),
    onRecall: vi.fn(),
    onSplit: vi.fn(),
    onReceiveProduction: vi.fn(),
    onReceiveInspection: vi.fn(),
    ...overrides,
  };
}

const labels = (items: MenuItem[]) => items.map((i) => i.label);
const childrenOf = (items: MenuItem[], label: string) =>
  items.find((i) => i.label === label)?.children ?? [];

describe('sendableCompanyIds（可发送公司白名单）', () => {
  it('S1：APPROVAL → 只给报价锁定的那一家', () => {
    expect(sendableCompanyIds(approvalCandidate())).toEqual([COMPANY_A]);
  });

  it('S2：DIRECT → 给 company_options 里的全部', () => {
    expect(sendableCompanyIds(directCandidate())).toEqual([COMPANY_A, COMPANY_B]);
  });

  it('S3：can_send=false（后端派生的可发送判据）→ 空列表，前端不自己重算', () => {
    expect(sendableCompanyIds(directCandidate({ can_send: false }))).toEqual([]);
    expect(sendableCompanyIds(approvalCandidate({ can_send: false }))).toEqual([]);
  });
});

describe('buildOutsourceBatchMenuItems（外协两区的菜单项派生）', () => {
  it('O1：公司列 = 回收生产 + 回收品检 + 拆分批次（不给召回、不给发送）', () => {
    const items = buildOutsourceBatchMenuItems(input());
    expect(labels(items)).toEqual(['回收生产', '回收品检', '拆分批次']);
  });

  it('O2：候选池 = 召回 + 拆分批次 + 发送到外协公司', () => {
    const items = buildOutsourceBatchMenuItems(input({ area: 'outsource-candidate' }));
    expect(labels(items)).toEqual(['召回到待下发', '拆分批次', '发送到外协公司']);
  });

  it('O3a：Inspector 拿得到回收两项、拿不到拆批', () => {
    const items = buildOutsourceBatchMenuItems(input({ canSplit: false }));
    expect(labels(items)).toEqual(['回收生产', '回收品检']);
  });

  it('O3b：不能收发（canMove 假）→ 公司列只剩拆批', () => {
    const items = buildOutsourceBatchMenuItems(input({ canMove: false }));
    expect(labels(items)).toEqual(['拆分批次']);
  });

  it('O3c：无召回权 → 候选池少「召回到待下发」', () => {
    const items = buildOutsourceBatchMenuItems(
      input({ area: 'outsource-candidate', canRecall: false }),
    );
    expect(labels(items)).toEqual(['拆分批次', '发送到外协公司']);
  });

  it('O4a：余量 ≤ 1 → 两个区都不给「拆分批次」', () => {
    const card = makeCard({ quantity: 1 });
    expect(labels(buildOutsourceBatchMenuItems(input({ batch: card })))).toEqual([
      '回收生产',
      '回收品检',
    ]);
    expect(
      labels(
        buildOutsourceBatchMenuItems(input({ area: 'outsource-candidate', batch: card })),
      ),
    ).toEqual(['召回到待下发', '发送到外协公司']);
  });

  it('O4b：PENDING 未上架（candidateIsPending）的候选行不给召回 —— 它本来就在待下发区', () => {
    const items = buildOutsourceBatchMenuItems(
      input({ area: 'outsource-candidate', candidateIsPending: true }),
    );
    expect(labels(items)).not.toContain('召回到待下发');
  });

  it('O5a：APPROVAL 行的二级菜单只含报价锁定的那一家', () => {
    const items = buildOutsourceBatchMenuItems(input({ area: 'outsource-candidate' }));
    expect(childrenOf(items, '发送到外协公司').map((c) => c.label)).toEqual(['外协厂甲']);
  });

  it('O5b：DIRECT 行的二级菜单含 company_options 里的每一家', () => {
    const items = buildOutsourceBatchMenuItems(
      input({ area: 'outsource-candidate', candidate: directCandidate() }),
    );
    expect(childrenOf(items, '发送到外协公司').map((c) => c.label)).toEqual([
      '外协厂甲',
      '外协厂乙',
    ]);
  });

  it('O5c：白名单里的公司没被映射进本工序（看板上没有那一列）→ 不进二级菜单', () => {
    const items = buildOutsourceBatchMenuItems(
      input({ area: 'outsource-candidate', companies: [{ company_id: COMPANY_B, name: '外协厂乙' }] }),
    );
    // APPROVAL 锁定的是甲，而本工序只映射了乙 ⇒ 交集为空 ⇒ 整项不给
    expect(labels(items)).not.toContain('发送到外协公司');
  });

  it('O5d：公司列里没有的目标不进列表（交集是双向的）', () => {
    const items = buildOutsourceBatchMenuItems(
      input({
        area: 'outsource-candidate',
        candidate: directCandidate({
          company_options: [
            { id: COMPANY_A, name: '外协厂甲' },
            { id: '9999999999999', name: '外协厂丙' },
          ],
        }),
      }),
    );
    expect(childrenOf(items, '发送到外协公司').map((c) => c.label)).toEqual(['外协厂甲']);
  });

  it('O6：can_send=false 的候选行整个不给「发送到」', () => {
    const items = buildOutsourceBatchMenuItems(
      input({ area: 'outsource-candidate', candidate: approvalCandidate({ can_send: false }) }),
    );
    expect(labels(items)).not.toContain('发送到外协公司');
  });

  it('O6b：没有候选行 DTO（上下文缺失）→ 不给「发送到」，其余项照常', () => {
    const items = buildOutsourceBatchMenuItems(
      input({ area: 'outsource-candidate', candidate: undefined }),
    );
    expect(labels(items)).toEqual(['召回到待下发', '拆分批次']);
  });

  it('O7：二级菜单 onClick 带目标公司 id；召回 / 拆批 / 回收不带走参', () => {
    const onSend = vi.fn();
    const onRecall = vi.fn();
    const onSplit = vi.fn();
    const onReceiveProduction = vi.fn();
    const onReceiveInspection = vi.fn();
    const items = buildOutsourceBatchMenuItems(
      input({
        area: 'outsource-candidate',
        candidate: directCandidate(),
        onSend,
        onRecall,
        onSplit,
      }),
    );
    childrenOf(items, '发送到外协公司')[1]!.onClick!();
    expect(onSend).toHaveBeenCalledWith(COMPANY_B);
    items[0]!.onClick!();
    items[1]!.onClick!();
    expect(onRecall).toHaveBeenCalledWith();
    expect(onSplit).toHaveBeenCalledWith();

    const heldItems = buildOutsourceBatchMenuItems(
      input({ onReceiveProduction, onReceiveInspection }),
    );
    heldItems[0]!.onClick!();
    heldItems[1]!.onClick!();
    expect(onReceiveProduction).toHaveBeenCalledWith();
    expect(onReceiveInspection).toHaveBeenCalledWith();
  });

  it('O8：目标过多不自己截断（全部进二级菜单，靠菜单的 maxHeight 滚动）', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `C-${i}`,
      name: `外协厂${i}`,
    }));
    const items = buildOutsourceBatchMenuItems(
      input({
        area: 'outsource-candidate',
        candidate: directCandidate({ company_options: many }),
        companies: many.map((c) => ({ company_id: c.id, name: c.name })),
      }),
    );
    expect(childrenOf(items, '发送到外协公司')).toHaveLength(100);
  });
});