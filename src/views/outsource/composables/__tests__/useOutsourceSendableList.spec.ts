// src/views/outsource/composables/__tests__/useOutsourceSendableList.spec.ts
//
// 2026-10-03 新增：send-to-outsource 的 **payload 组装契约守卫**。
//
// 为什么必须有：`POST /prod/batches/{batch_id}/send-to-outsource` 的 2026-10-03
// 契约有三条硬要求，违反任一条都是**静默失败**（serde 未开 deny_unknown_fields）：
//   1. 工序键是 `process_id`，不是 `current_process_id` —— 沿用行字段名后端 DTO 收不到、
//      必填字段落空 → 422（线上故障：外协发送 100% 失败）。行字段是
//      `current_process_id`（批次当前所属的外协工序），body 键另叫 `process_id`。
//   2. `quote_id`（APPROVAL）与 `direct: true`（DIRECT）**必传其一**，都不传 → 400。
//      两个键都不发的 payload 会被后端全量打回。
//   3. `quantity: null` = 整批，非 null = 部分发送（后端拆批，源批次留余量）。
//
// 两条发送路径（单件确认 / 扫码批量）共用 buildSendPayload —— 「改一处漏另一处」
// 是本仓已付出过代价的形态，本文件对**两条路径**都断言。

import { beforeEach, describe, expect, it, vi } from 'vitest';
// 断言提示文案要用的 ElMessage（下列 vi.mock 已把它桩成 no-op，import 拿到的是桩）。
import { ElMessage } from 'element-plus';

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
  type SendQueueItem,
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
    current_process_id: 'PR1',
    current_process_name: '外协工序',
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

/** 队列项工厂。`outsource_company_id` 留空即「空公司项」，其余字段与真实入队结果对齐。 */
function queueItem(
  overrides: Omit<Partial<SendQueueItem>, 'part'> & { part?: Partial<SendQueueItem['part']> } = {},
): SendQueueItem {
  const { part, ...rest } = overrides;
  return {
    part: {
      id: 'P1',
      serial_no: 'SN-1',
      drawing_no: 'DWG-1',
      name: '零件甲',
      ...part,
    },
    outsource_company_id: 'C1',
    outsource_company_name: '外协厂',
    process_id: 'PR1',
    process_name: '外协工序',
    price: null,
    version: 7,
    batch_id: 'BA1',
    quantity: 10,
    quote_id: null,
    direct: true,
    ...rest,
  };
}

beforeEach(() => {
  sendToOutsourceMock.mockReset();
  sendToOutsourceMock.mockResolvedValue({});
  getPartBySerialMock.mockReset();
  listOutsourceSendableMock.mockReset();
  listOutsourceSendableMock.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
  // ElMessage 桩统一在这里清：用例断言「弹了几次 / 弹了什么」时不跨用例串味
  for (const m of [ElMessage.success, ElMessage.error, ElMessage.warning, ElMessage.info]) {
    vi.mocked(m).mockClear();
  }
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
    expect(body).not.toHaveProperty('current_process_id');
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

  // 工序键的回归锁：payload 里**任何位置**都不许再出现行字段名（next_process_id /
  // current_process_id）—— body 键只叫 process_id。
  it('S3：两条模式的 payload 键集恒为 6 个（键名回归锁）', async () => {
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
  /** 把 row 摆进「当前页」：handleScannedSerialForSend 只在当前页里找 match。 */
  function stubCurrentPage(inst: UseOutsourceSendableListReturn, row: SendableItem): void {
    // items 传**裸数组**：模板 ref 拿到的是组件 public instance，Vue 已把
    // defineExpose 出来的 ref 解包过一层（`.items.value` 恒 undefined）。
    inst.sendablePagedRef.value = {
      items: [row],
      fetch: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
    };
  }

  /** 走一遍扫码入队流程，返回带队列的 composable 实例。 */
  async function enqueueVia(row: SendableItem): Promise<UseOutsourceSendableListReturn> {
    getPartBySerialMock.mockResolvedValue({
      id: row.part_id,
      serial_no: row.part_serial_no,
      drawing_no: row.part_drawing_no,
      name: row.part_name,
    });
    const inst = useOutsourceSendableList();
    stubCurrentPage(inst, row);
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
    expect(body).not.toHaveProperty('current_process_id');
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

  // 后端把「DIRECT 且 company_options 为空」写成一级场景（该行仍返回，前端置灰），
  // 扫码路径必须与行按钮共用 canSend：否则空数组会入队、`outsource_company_id` 拿到
  // 空串，批量发送时后端 `i64` 反序列化失败、返 422 纯文本（非业务信封）。
  it('S11：DIRECT 且 company_options 为空 → 不入队、不弹发送框、不发请求', async () => {
    getPartBySerialMock.mockResolvedValue({
      id: 'P1',
      serial_no: 'SN-1',
      drawing_no: 'DWG-1',
      name: '零件甲',
    });
    const warn = vi.mocked(ElMessage.warning);

    const inst = useOutsourceSendableList();
    stubCurrentPage(inst, directRow({ company_options: [] }));
    await inst.handleScannedSerialForSend('SN-1');

    expect(inst.sendQueue.value).toHaveLength(0);
    // 多公司分支会弹选择框；不可发送的行不该走到那一步
    expect(inst.sendDialogVisible.value).toBe(false);
    // 提示必须指向真实原因（外协工序未映射公司），不是「状态不满足」那种含糊说法。
    // 只弹一条 warning，且两个领域名词必须**同在一条**里 —— 分成两次 stringContaining
    // 断言的话，「先弹一条 A、再弹一条 B」也能骗过断言。
    expect(warn).toHaveBeenCalledTimes(1);
    const warnedText = warn.mock.calls[0]![0] as string;
    expect(warnedText).toContain('外协工序');
    expect(warnedText).toContain('外协公司');

    await inst.onConfirmBatchSend();
    expect(sendToOutsourceMock).not.toHaveBeenCalled();
  });

  // find 只搜当前页 ⇒ 「未命中」可能只是被翻到了别的页。提示必须先讲清这一点，
  // 否则操作员会把分页漏页误当成状态/报价问题，从错误方向排查。
  it('S12：当前页没有该零件 → 提示点明「当前页」这层含义', async () => {
    getPartBySerialMock.mockResolvedValue({
      id: 'P-OTHER-PAGE',
      serial_no: 'SN-9',
      drawing_no: 'DWG-9',
      name: '零件乙',
    });
    const warn = vi.mocked(ElMessage.warning);

    const inst = useOutsourceSendableList();
    stubCurrentPage(inst, approvalRow());
    await inst.handleScannedSerialForSend('SN-9');

    expect(inst.sendQueue.value).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0] as string).toContain('当前页');
  });

  // 纵深防御：入队的 canSend 闸门已挡住空公司，这里锁住批量侧的兜底 ——
  // 空串打过去只会拿到 422 纯文本，操作员看不到根因。
  it('S13：队列项外协公司为空 → 批量发送本地拦下、点名根因、不发请求', async () => {
    const inst = useOutsourceSendableList();
    inst.sendQueue.value = [
      {
        part: { id: 'P1', serial_no: 'SN-1', drawing_no: 'DWG-1', name: '零件甲' },
        outsource_company_id: '',
        outsource_company_name: '',
        process_id: 'PR1',
        process_name: '外协工序',
        price: null,
        version: 7,
        batch_id: 'BA1',
        quantity: 10,
        quote_id: null,
        direct: true,
      },
    ];

    await inst.onConfirmBatchSend();

    expect(sendToOutsourceMock).not.toHaveBeenCalled();
    expect(inst.sendQueue.value).toHaveLength(1);
    expect(vi.mocked(ElMessage.error).mock.calls[0]![0] as string).toContain('缺外协公司');
  });

  // 2026-10-03：混合队列的下标管理回归锁。批量循环里空公司项走 `continue`（**不**
  // `splice`），而发送成功项走 `splice` + `i--` —— 两者混在同一队列时，下标一旦
  // 算错就会漏发或把失败项标到别的行上。S13 只覆盖「队列里只有空公司项」这一种
  // 退化形态（循环里 `splice` 一次都没发生），覆盖不到这里。
  it('S14：混合队列 [正常项, 空公司项] → 只发正常项，剩 1 项且标 _failed', async () => {
    const inst = useOutsourceSendableList();
    inst.sendQueue.value = [
      queueItem({ part: { serial_no: 'SN-A' }, batch_id: 'BA-A' }),
      queueItem({
        part: { id: 'P2', serial_no: 'SN-E', drawing_no: 'DWG-E', name: '零件乙' },
        batch_id: 'BA-E',
        outsource_company_id: '',
        outsource_company_name: '',
      }),
    ];

    await inst.onConfirmBatchSend();

    // 正常项照发（1 次，不是 0 次也不是 2 次）
    expect(sendToOutsourceMock).toHaveBeenCalledTimes(1);
    expect(lastBatchId()).toBe('BA-A');
    // 剩下的必须是那个空公司项本身，且带失败标记 —— 说明 continue 后下标接着走、
    // 没有把失败项错标到已被 splice 掉的行位上
    expect(inst.sendQueue.value).toHaveLength(1);
    expect(inst.sendQueue.value[0]!.part.serial_no).toBe('SN-E');
    expect(inst.sendQueue.value[0]!._failed).toBe(true);
    expect(vi.mocked(ElMessage.success).mock.calls[0]![0] as string).toContain('成功发送 1 件');
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

describe('openSend', () => {
  // 「不可发送的行永远打不开发送 dialog」是真行为，值得独立成锁：openSend 的
  // `!canSend` 分支是唯一挡在「空 company_options 入队 → 批量发时 422 纯文本」前的
  // 行级闸门（行按钮路径对不可发送的行是置灰，但 openSend 本身也必须守住）。
  it('S15：不可发送的行（DIRECT + 空 company_options）→ 只弹一次 warning，dialog 不开', () => {
    const inst = useOutsourceSendableList();
    const warn = vi.mocked(ElMessage.warning);

    inst.openSend(directRow({ company_options: [] }));

    expect(inst.sendDialogVisible.value).toBe(false);
    expect(inst.sendTarget.value).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('S16：可发送的行 → dialog 打开，DIRECT 默认选中第一家映射公司', () => {
    const inst = useOutsourceSendableList();

    inst.openSend(directRow());

    expect(inst.sendDialogVisible.value).toBe(true);
    expect(inst.sendTarget.value).not.toBeNull();
    expect(inst.sendSelectedCompanyId.value).toBe('C1');
  });
});
