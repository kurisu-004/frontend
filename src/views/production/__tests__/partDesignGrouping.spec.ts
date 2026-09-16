// 2026-09-16 新增：splitPartsByProcessDesign 纯函数单测（node 环境，无组件挂载 ——
// 项目不引入 testing-library，见 vitest.config.ts 注释）。
//
// 分组契约（对齐后端 2026-09-16 契约第 1 条）：
//   part.process_chain_id == null（null 或 undefined）→「待制定」
//   part.process_chain_id 非 null（雪花 ID 字符串）    →「已制定」
//   row_type === 'ASSEMBLY' 的装配件不参与分组（在独立 section 展示）。

import { describe, it, expect } from 'vitest';
import type { PartListItem } from '@/types/parts';
import { splitPartsByProcessDesign } from '../utils/partDesignGrouping';

/** 构造最小 PartListItem（分组只消费 id / row_type / process_chain_id，
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

  it('装配件（ASSEMBLY）不参与分组，即使 process_chain_id 为空', () => {
    const parts = [
      makePart({ id: 'A1', row_type: 'ASSEMBLY', process_chain_id: null }),
      makePart({ id: 'P1', process_chain_id: null }),
    ];
    const { pending, designed } = splitPartsByProcessDesign(parts);
    expect(pending.map((p) => p.id)).toEqual(['P1']);
    expect(designed).toHaveLength(0);
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
