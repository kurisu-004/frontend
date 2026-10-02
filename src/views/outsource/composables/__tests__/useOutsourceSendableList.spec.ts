// src/views/outsource/composables/__tests__/useOutsourceSendableList.spec.ts
//
// 2026-10-03 新增：send-to-outsource 的 **payload 组装契约守卫**。
//
// 为什么必须有：`POST /prod/batches/{batch_id}/send-to-outsource` 的 2026-10-03
// 契约有三条硬要求，违反任一条都是**静默失败**（serde 未开 deny_unknown_fields）：
//   1. 工序键是 `process_id`，不是 `next_process_id` —— 沿用旧名后端 DTO 收不到、
//      必填字段落空 → 422（线上故障：外协发送 100% 失败）。
//   2. `quote_id`（APPROVAL）与 `direct: true`（DIRECT）**必传其一**，都不传 → 400。
//      此前前端两个键都不发 ⇒ 全部行都打回 400。
//   3. `quantity: null` = 整批，非 null = 部分发送（后端拆批，源批次留余量）。
//
// 两条发送路径（单件确认 / 扫码批量）此前各写一份 payload 字典 —— 「改一处漏另一处」
// 是本仓已付出过代价的形态。现在两者共用 buildSendPayload，本文件对**两条路径**都断言。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// node env 下真实 ElMessage 会因 `document is not defined` 污染输出（CLAUDE.md 约定）。
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const sendToOutsourceMock = vi.fn();
const getPartBySerialMock = vi.fn();
const listOutsourceSendableMock = vi.fn();

vi.mock('@/api/parts', () => ({
  sendToOutsource: (...args: unknown[]) => sendToOutsourceMock(...args),
  getPartBySerial: (...args: unknown[]) => getPartBySerialMock(...args),
}));

vi.mock('@/api/outsource', () => ({
  listOutsourceSendable: (...args: unknown[]) => listOutsourceSendableMock(...args),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ dangerous: vi.fn(async () => true) }),
}));

vi.mock('@/composables/useListFilterPersist', () => ({
  useListStatePersist: () => ({ restore: () => null, snapshot: vi.fn(), clear: vi.fn() }),
}));

vi.mock('@/composables/useProcessChainRequiredHandler', () => ({
  handleProcessChainRequired: vi.fn(async () => false),
}));

import {
  useOutsourceSendableList,
  type SendableItem,
  type UseOutsourceSendableListReturn,
} from '../useOutsourceSendableList';

/** APPROVAL 行（有报价 + quote_id）。 */
function approvalRow(overrides: Partial<SendableItem> = {}): SendableItem {
  return {
    version: 7,
    send_mode: 'APPROVAL',
    source_status: 'IN_PROCESS',
    part_id: 'P1',
    part_serial_no: 'SN-1',
    part_drawing_no: 'DWG-1',
    part_name: '零件甲',
    quantity: 10,
    batch_id: 'BA1',
    batch_no: 1,
    batch_quantity: 10,
    planned_delivery_date: '2026-10-20',
    is_urgent: false,
    customer_path: '一级/二级',
    next_process_id: 'PR1',
    next_process_name: '外协工序',
    shelf_code: 'C2',
    outsource_company_id: 'C1',
    outsource_company_name: '外协厂',
    company_options: [],
    price: '30.00',
    quote_id: 'Q1',
    status_label: 'sendable',
    ...overrides,
  };
}

/** DIRECT 行（无报价、quote_id 为 null、company_options 有值）。 */
function directRow(overrides: Partial<SendableItem> = {}): SendableItem {
  return approvalRow({
    send_mode: 'DIRECT',
    source_status: 'PENDING',
    outsource_company_id: null,
    outsource_company_name: null,
    company_options: [{ id: 'C1', name: '外协厂' }],
    price: null,
    quote_id: null,
    ...overrides,
  });
}

/** 最近一次 send-to-outsource 的 body。 */
function lastBody(): Record<string, unknown> {
  expect(sendToOutsourceMock).toHaveBeenCalledTimes(1);
  return sendToOutsourceMock.mock.calls[0]![1] as Record<string, unknown>;
}

function lastBatchId(): string {
  return sendToOutsourceMock.mock.calls[0]![0] as string;
}

beforeEach(() => {
  sendToOutsourceMock.mockReset();
  sendToOutsourceMock.mockResolvedValue({});
  getPartBySerialMock.mockReset();
  listOutsourceSendableMock.mockReset();
  listOutsourceSendableMock.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
});

describe('单件发送 onConfirmSend', () => {
  it('S1：APPROVAL 行 → quote_id 有值、direct 为 null、键名是 process_id', async () => {
    const inst = useOutsourceSendableList();
    inst.sendTarget.value = approvalRow();
    inst.sendQuantity.value = 10;

    await inst.onConfirmSend();

    const body = lastBody();
    expect(lastBatchId()).toBe('BA1');
    expect(body.process_id).toBe('PR1');
    expect(body).not.toHaveProperty('next_process_id');
    expect(body.quote_id).toBe('Q1');
    expect(body.direct).toBeNull();
    expect(body.outsource_company_id).toBe('C1');
    expect(body.version).toBe(7);
  });

  it('S2：DIRECT 行 → direct: true、quote_id 为 null', async () => {
    const inst = useOutsourceSendableList();
    inst.sendTarget.value = directRow();
    inst.sendSelectedCompanyId.value = 'C1';
    inst.sendQuantity.value = 10;

    await inst.onConfirmSend();

    const body = lastBody();
    expect(body.direct).toBe(true);
    expect(body.quote_id).toBeNull();
    expect(body.process_id).toBe('PR1');
  });

  // 工序键改名的回归锁：payload 里**任何位置**都不许再出现 next_process_id。
  it('S3：两条模式的 payload 都不含 next_process_id（键名回归锁）', async () => {
    const approval = useOutsourceSendableList();
    approval.sendTarget.value = approvalRow();
    approval.sendQuantity.value = 10;
    await approval.onConfirmSend();
    expect(Object.keys(lastBody()).sort()).toEqual([
      'direct',
      'outsource_company_id',
      'process_id',
      'quantity',
      'quote_id',
      'version',
    ]);

    sendToOutsourceMock.mockClear();
    const direct = useOutsourceSendableList();
    direct.sendTarget.value = directRow();
    direct.sendSelectedCompanyId.value = 'C1';
    direct.sendQuantity.value = 10;
    await direct.onConfirmSend();
    expect(Object.keys(lastBody()).sort()).toEqual([
      'direct',
      'outsource_company_id',
      'process_id',
      'quantity',
      'quote_id',
      'version',
    ]);
  });

  it('S4：部分数量（< batch_quantity）→ payload 带该 quantity', async () => {
    const inst = useOutsourceSendableList();
    inst.sendTarget.value = approvalRow({ batch_quantity: 10 });
    inst.sendQuantity.value = 4;

    await inst.onConfirmSend();

    expect(lastBody().quantity).toBe(4);
  });

  it('S5：整批（== batch_quantity）→ quantity 为 null（不是 batch_quantity）', async () => {
    const inst = useOutsourceSendableList();
    inst.sendTarget.value = approvalRow({ batch_quantity: 10 });
    inst.sendQuantity.value = 10;

    await inst.onConfirmSend();

    expect(lastBody().quantity).toBeNull();
  });

  // 数量越界时**不发请求**（此前会发一个后端必然 422/400 的 payload）。
  it('S6：数量越界 → 直接 return，不发请求', async () => {
    const inst = useOutsourceSendableList();
    inst.sendTarget.value = approvalRow({ batch_quantity: 10 });
    inst.sendQuantity.value = 11;

    await inst.onConfirmSend();

    expect(sendToOutsourceMock).not.toHaveBeenCalled();
  });
});

describe('扫码批量发送 onConfirmBatchSend', () => {
  /** 走一遍扫码入队流程，返回带队列的 composable 实例。 */
  async function enqueueVia(row: SendableItem): Promise<UseOutsourceSendableListReturn> {
    getPartBySerialMock.mockResolvedValue({
      id: row.part_id,
      serial_no: row.part_serial_no,
      drawing_no: row.part_drawing_no,
      name: row.part_name,
    });
    const inst = useOutsourceSendableList();
    // 让当前页可读出该行（handleScannedSerialForSend 只在当前页里找 match）。
    // items 传**裸数组**：模板 ref 拿到的是组件 public instance，Vue 已把
    // defineExpose 出来的 ref 解包过一层（`.items.value` 恒 undefined）。
    inst.sendablePagedRef.value = {
      items: [row],
      fetch: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
    };
    await inst.handleScannedSerialForSend('SN-1');
    expect(inst.sendQueue.value).toHaveLength(1);
    return inst;
  }

  it('S7：入队时把 quote_id / direct 一起带进队列（否则批量发时组不出模式）', async () => {
    const inst = await enqueueVia(approvalRow());
    expect(inst.sendQueue.value[0]!.quote_id).toBe('Q1');
    expect(inst.sendQueue.value[0]!.direct).toBe(false);

    await inst.onConfirmBatchSend();
    const body = lastBody();
    expect(body.quote_id).toBe('Q1');
    expect(body.direct).toBeNull();
    expect(body.process_id).toBe('PR1');
    expect(body).not.toHaveProperty('next_process_id');
  });

  it('S8：DIRECT 行入队 → direct: true、quote_id 为 null', async () => {
    const inst = await enqueueVia(directRow());
    expect(inst.sendQueue.value[0]!.direct).toBe(true);
    expect(inst.sendQueue.value[0]!.quote_id).toBeNull();

    await inst.onConfirmBatchSend();
    const body = lastBody();
    expect(body.direct).toBe(true);
    expect(body.quote_id).toBeNull();
  });
});

describe('canSend', () => {
  it('S9：status_label 非 sendable → 不可发送', () => {
    const inst = useOutsourceSendableList();
    expect(
      inst.canSend(approvalRow({ status_label: 'locked' as SendableItem['status_label'] })),
    ).toBe(false);
  });

  // 后端保证 DIRECT 空 options 的行也会返回并被置灰（这是有意的：让操作员看得见
  // 「该零件没有可送的公司」而不是让它凭空消失）。判定保留。
  it('S10：DIRECT 且 company_options 为空 → 不可发送', () => {
    const inst = useOutsourceSendableList();
    expect(inst.canSend(directRow({ company_options: [] }))).toBe(false);
    expect(inst.canSend(directRow({ company_options: [{ id: 'C1', name: '外协厂' }] }))).toBe(true);
  });
});
