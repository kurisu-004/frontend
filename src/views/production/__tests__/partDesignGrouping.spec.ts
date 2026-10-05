// 2026-09-16 新增：splitPartsByProcessDesign 纯函数单测（node 环境，无组件挂载 ——
// 项目不引入 testing-library，见 vitest.config.ts 注释）。
//
// 分组契约（对齐后端契约）：
//   行上 process_chain_id == null（null 或 undefined）→「待制定」
//   行上 process_chain_id 非 null（雪花 ID 字符串）  →「已制定」
// 2026-09-29 简化：删除「装配件不参与分组」用例（PartPickerList 已移除独立 section）。
// 2026-10-05：入参类型随数据源切到 prod 域 `GET /prod/process-design/parts` 换成
// `ProcessDesignPartSchema`（7 字段），分组逻辑未变。**新增子件用例** —— 新端点刻意
// 不加 `AND assembly_id IS NULL`，子件（assembly_id 非空）与独立零件同表出现，
// 分组对它与独立零件一视同仁（不跳过、不单列）。

import { describe, it, expect } from 'vitest';
import type { ProcessDesignPartSchema } from '@/composables/queries/schemas';
import { splitPartsByProcessDesign } from '../utils/partDesignGrouping';

/** 构造最小零件行（分组只消费 id / process_chain_id / assembly_id，
 *  其余必填字段对本测试无意义，统一补默认值）。 */
function makePart(partial: {
  id: string;
  process_chain_id?: string | null;
  assembly_id?: string | null;
}): ProcessDesignPartSchema {
  return {
    id: partial.id,
    version: 0,
    serial_no: null,
    name: '零件',
    drawing_no: 'DWG-X',
    process_chain_id: partial.process_chain_id ?? null,
    assembly_id: partial.assembly_id ?? null,
  };
}

describe('splitPartsByProcessDesign', () => {
  it('process_chain_id null / 非 null 的零件正确落入待制定 / 已制定', () => {
    // Zod 保证 process_chain_id 键恒在（可空但不为 undefined），但纯函数用 `== null`
    // 判据、保留 undefined 防御分支 ⇒ 这里单独造一行显式 undefined 的对象覆盖它。
    const missingChainField = {
      ...makePart({ id: 'P3' }),
      process_chain_id: undefined,
    } as unknown as ProcessDesignPartSchema;
    const parts = [
      makePart({ id: 'P1', process_chain_id: null }), // 待制定
      makePart({ id: 'P2', process_chain_id: '7000000000001' }), // 已制定
      missingChainField, // 缺字段（undefined）→ 待制定
      makePart({ id: 'P4', process_chain_id: '7000000000002' }), // 已制定
    ];
    const { pending, designed } = splitPartsByProcessDesign(parts);
    expect(pending.map((p) => p.id)).toEqual(['P1', 'P3']);
    expect(designed.map((p) => p.id)).toEqual(['P2', 'P4']);
  });

  it('2026-10-05：装配件子件（assembly_id 非空）按 process_chain_id 参与分组，不被跳过', () => {
    // 新端点（/prod/process-design/parts）刻意不加 `AND assembly_id IS NULL`，
    // 子件是本页的正常成员：未制定工序的子件进「待制定」，已制定的进「已制定」。
    const parts = [
      makePart({ id: 'C1', process_chain_id: null, assembly_id: '8000000000001' }),
      makePart({ id: 'C2', process_chain_id: '7000000000007', assembly_id: '8000000000001' }),
      makePart({ id: 'P1', process_chain_id: null, assembly_id: null }),
    ];
    const { pending, designed } = splitPartsByProcessDesign(parts);
    expect(pending.map((p) => p.id)).toEqual(['C1', 'P1']);
    expect(designed.map((p) => p.id)).toEqual(['C2']);
  });

  it('空数组 → 两组皆空', () => {
    const { pending, designed } = splitPartsByProcessDesign([]);
    expect(pending).toEqual([]);
    expect(designed).toEqual([]);
  });

  it('保存后回写 process_chain_id 的零件在下一轮分组中移入「已制定」（分组迁移语义）', () => {
    // 模拟 store 保存成功后 setQueryData 回写链 id：同一行先 null 后有链 id，
    // 分组结果必须从待制定迁移到已制定（响应式由调用方 computed 保证，这里断言纯函数语义）。
    const part = makePart({ id: 'P1', process_chain_id: null });
    expect(splitPartsByProcessDesign([part]).pending.map((p) => p.id)).toEqual(['P1']);
    const migrated: ProcessDesignPartSchema = { ...part, process_chain_id: '7000000000005' };
    const { pending, designed } = splitPartsByProcessDesign([migrated]);
    expect(pending).toHaveLength(0);
    expect(designed.map((p) => p.id)).toEqual(['P1']);
  });
});
