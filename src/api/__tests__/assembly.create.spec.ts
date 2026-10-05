// src/api/__tests__/assembly.create.spec.ts
//
// 2026-10-05 新增：装配件建单端点（`POST /api/v2/assemblies`）的响应守门 + 请求形状守卫。
//
// 为什么必须有这个文件：建单响应不只是「给用户看个结果」，它直接决定**哪些本地行算
// 已建出**（`usePartBatchPdf` 的 createdTargets 记账），记账错了会静默丢文件、丢行。
// `createAssembly` 此前只做类型断言、无守门，形状不符时在零报错的情况下把
// `created_children[i]` 对回错误的行。本 spec 钉住：
//   1. 合法的 `{assembly, created_children}` 原样通过；
//   2. 子件缺 `id`（响应的每一项都会被按下标当作某个子件的 part id 用）⇒ 抛错；
//   3. 子件键名回归（`children` 而非 `created_children`）⇒ 抛错（外层 .strict()）；
//   4. multipart 只发 `data`、不带文件字段（总装图走 `/assemblies/{id}/files`）。
//
// mock 手法沿 outsource.contract.spec.ts：整模块桩掉 `@/api/http`（不 importOriginal），
// 刻意**不**桩 `@/composables/queries/schemas` —— 桩掉它会让「parse 抛错」变成空断言。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: vi.fn(),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import { createAssembly } from '@/api/assembly';
import type { AssemblyCreatePayload } from '@/types/assembly';

const ASM_ID = '1900000000009001';
const CHILD_IDS = ['1900000000009002', '1900000000009003'];

/** 后端 `AssemblyOut`（19 字段，字段集必须与 assemblyOutSchema 对齐）。 */
function assemblyOut(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ASM_ID,
    version: 0,
    serial_no: 'ABC0000001',
    drawing_no: 'E42-ASM-009',
    name: '胶枪内胆总装',
    applicant_name: '程胜志',
    customer_id: '1900000000000002',
    request_date: '2026-10-01',
    planned_delivery_date: '2026-10-20',
    is_urgent: false,
    status: 'PENDING',
    quantity: 3,
    unit_price: '130.00',
    total_price: '390.00',
    order_no: null,
    system_delivery_date: null,
    note: null,
    created_at: '2026-10-05T01:00:00Z',
    updated_at: '2026-10-05T01:00:00Z',
    ...over,
  };
}

/** 后端 `AssemblyChildOut`。 */
function childOut(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CHILD_IDS[i]!,
    version: 0,
    serial_no: `ABC0000001-${String(i + 1).padStart(2, '0')}`,
    name: `子件${i + 1}`,
    drawing_no: `E42-ASM-009-0${i + 1}`,
    status: 'PENDING',
    quantity: 1,
    planned_delivery_date: '2026-10-20',
    applicant_name: '程胜志',
    request_date: '2026-10-01',
    order_no: null,
    system_delivery_date: null,
    is_urgent: false,
    note: null,
    current_batch_id: null,
    ...over,
  };
}

const PAYLOAD: AssemblyCreatePayload = {
  name: '胶枪内胆总装',
  drawing_no: 'E42-ASM-009',
  customer_id: '1900000000000002',
  request_date: '2026-10-01',
  planned_delivery_date: '2026-10-20',
  // 刻意不加 `as` 断言：子件交期必须在 AssemblyChildPayload 上有声明（少声明时 TS 会
  // 立刻在这里报「对象字面量的未知属性」，正是防「类型对 wire 撒谎」的那道闸）。
  children: [
    { name: '子件1', drawing_no: 'E42-ASM-009-01', planned_delivery_date: '2026-10-20' },
    { name: '子件2', drawing_no: 'E42-ASM-009-02', planned_delivery_date: '2026-10-20' },
  ],
};

beforeEach(() => {
  httpPostMock.mockReset();
});

describe('createAssembly：请求形状', () => {
  it('POST /assemblies，multipart 只带 data 字段（JSON 文本），不带文件', async () => {
    httpPostMock.mockResolvedValue({
      data: { assembly: assemblyOut(), created_children: [childOut(0), childOut(1)] },
    });

    await createAssembly(PAYLOAD);

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    const [url, form] = httpPostMock.mock.calls[0]! as [string, FormData];
    expect(url).toBe('/assemblies');
    expect([...form.keys()]).toEqual(['data']);
    // 子件交期是后端入参的一等公民（缺省才继承父件）⇒ 必须真的在 data 里
    const sent = JSON.parse(form.get('data') as string) as { children: unknown[] };
    expect(sent.children).toHaveLength(2);
    expect(sent.children[0]).toMatchObject({
      name: '子件1',
      drawing_no: 'E42-ASM-009-01',
      planned_delivery_date: '2026-10-20',
    });
  });
});

describe('createAssembly：响应守门', () => {
  it('合法响应原样通过（id / drawing_no 都能拿到 —— 记账与顺序对账靠它们）', async () => {
    httpPostMock.mockResolvedValue({
      data: { assembly: assemblyOut(), created_children: [childOut(0), childOut(1)] },
    });

    const res = await createAssembly(PAYLOAD);

    expect(res.assembly.id).toBe(ASM_ID);
    expect(res.created_children.map((c) => c.id)).toEqual(CHILD_IDS);
    expect(res.created_children.map((c) => c.drawing_no)).toEqual([
      'E42-ASM-009-01',
      'E42-ASM-009-02',
    ]);
  });

  it('子件缺 id ⇒ 抛错（缺 id 的项会被静默跳过，那一行的图纸就永不上传）', async () => {
    const bad = childOut(0);
    delete bad.id;
    httpPostMock.mockResolvedValue({
      data: { assembly: assemblyOut(), created_children: [bad, childOut(1)] },
    });

    await expect(createAssembly(PAYLOAD)).rejects.toThrow();
  });

  it('顶层缺 id ⇒ 抛错（顶层没记账就等于这组没建出，却已经建了）', async () => {
    const bad = assemblyOut();
    delete bad.id;
    httpPostMock.mockResolvedValue({
      data: { assembly: bad, created_children: [childOut(0), childOut(1)] },
    });

    await expect(createAssembly(PAYLOAD)).rejects.toThrow();
  });

  it('子件键名回归（children 而非 created_children）⇒ 抛错而不是静默空数组', async () => {
    httpPostMock.mockResolvedValue({
      data: { assembly: assemblyOut(), children: [childOut(0), childOut(1)] },
    });

    await expect(createAssembly(PAYLOAD)).rejects.toThrow();
  });

  it('created_children 不是数组 ⇒ 抛错', async () => {
    httpPostMock.mockResolvedValue({ data: { assembly: assemblyOut(), created_children: null } });

    await expect(createAssembly(PAYLOAD)).rejects.toThrow();
  });
});
