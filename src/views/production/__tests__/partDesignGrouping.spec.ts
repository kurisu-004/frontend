// 2026-09-16 新增：splitPartsByProcessDesign 纯函数单测（node 环境，无组件挂载 ——
// 项目不引入 testing-library，见 vitest.config.ts 注释）。
//
// 分组契约（对齐后端 2026-09-16 契约第 1 条）：
//   part.process_chain_id == null（null 或 undefined）→「待制定」
//   part.process_chain_id 非 null（雪花 ID 字符串）    →「已制定」
// 2026-09-29 简化：删除「装配件不参与分组」用例（PartPickerList 已移除独立 section）。
// 后端 GET /parts 已切到只查 t_part，所有行按 process_chain_id 分组；ASSEMBLY
// 行若因 stale cache / 后端未切换而混入，仍按 process_chain_id 直入对应分组，
// 见下方「新契约」用例。

import { describe, it, expect } from 'vitest';
import type { PartListItem } from '@/types/parts';
import { splitPartsByProcessDesign } from '../utils/partDesignGrouping';

/** 构造最小 PartListItem（分组只消费 id / process_chain_id / row_type，
 *  其余必填字段对本测试无意义，统一 cast 兜底）。 */
function makePart(partial: {
  id: string;
  row_type?: 'PART' | 'ASSEMBLY';
  process_chain_id?: string | null;
}): PartListItem {
  return partial as PartListItem;
}

describe('splitPartsByProcessDesign', () => {
  it('process_chain_id null / 非 null 的零件正确落入待制定 / 已制定', () => {
    const parts = [
      makePart({ id: 'P1', process_chain_id: null }), // 待制定
      makePart({ id: 'P2', process_chain_id: '7000000000001' }), // 已制定
      makePart({ id: 'P3' }), // undefined（旧出参缺字段）→ 待制定
      makePart({ id: 'P4', process_chain_id: '7000000000002' }), // 已制定
    ];
    const { pending, designed } = splitPartsByProcessDesign(parts);
    expect(pending.map((p) => p.id)).toEqual(['P1', 'P3']);
    expect(designed.map((p) => p.id)).toEqual(['P2', 'P4']);
  });

  it('后端契约：即使 stale 数据混入 ASSEMBLY 行，分组函数也按 process_chain_id 分（不再跳过）', () => {
    // 2026-09-29：旧版本会跳过 row_type='ASSEMBLY'，靠 PartPickerList 顶部「装配件」section 展示。
    // 新版本删除该 section，装配件行若还在入参里（stale cache / 后端未切换），
    // 按 process_chain_id 走待制定/已制定（与 PART 行同语义），不再失踪。
    const parts = [
      makePart({ id: 'A1', row_type: 'ASSEMBLY', process_chain_id: null }),
      makePart({ id: 'P1', row_type: 'PART', process_chain_id: null }),
      makePart({ id: 'A2', row_type: 'ASSEMBLY', process_chain_id: '7000000000007' }),
    ];
    const { pending, designed } = splitPartsByProcessDesign(parts);
    expect(pending.map((p) => p.id)).toEqual(['A1', 'P1']);
    expect(designed.map((p) => p.id)).toEqual(['A2']);
  });

  it('空数组 → 两组皆空', () => {
    const { pending, designed } = splitPartsByProcessDesign([]);
    expect(pending).toEqual([]);
    expect(designed).toEqual([]);
  });

  it('保存后回写 process_chain_id 的零件在下一轮分组中移入「已制定」（分组迁移语义）', () => {
    // 模拟 usePartProcessDesign.saveFlow 成功路径：同一零件对象先 null 后回写链 id，
    // 分组结果必须从待制定迁移到已制定（响应式由调用方 computed 保证，这里断言纯函数语义）。
    const part = makePart({ id: 'P1', process_chain_id: null });
    expect(splitPartsByProcessDesign([part]).pending.map((p) => p.id)).toEqual(['P1']);
    const migrated: PartListItem = { ...part, process_chain_id: '7000000000005' };
    const { pending, designed } = splitPartsByProcessDesign([migrated]);
    expect(pending).toHaveLength(0);
    expect(designed.map((p) => p.id)).toEqual(['P1']);
  });
});
