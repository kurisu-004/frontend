// 2026-09-16 新增：工序制定页左栏「待制定 / 已制定」分组纯函数。
//
// 分组依据 = part.process_chain_id（后端 2026-09-16 起在 GET /parts 列表/详情出参新增）：
//   null / undefined → 待制定；非 null（雪花 ID 字符串）→ 已制定。
// 替代原「allSummaries[partId]?.step_count > 0」懒加载派生 —— 旧逻辑下未点击过的零件
// 永远落入「待制定」（step_count 只在用户点选后才懒加载进本地缓存），语义错误。
//
// 抽成独立纯函数（零 runtime 依赖，仅 type-only import）的原因：项目不引入
// testing-library（vitest.config.ts 注释），组件 computed 无法直接单测；
// 纯函数可在 node 环境 vitest 直测（见 __tests__/partDesignGrouping.spec.ts）。

import type { PartListItem } from '@/types/parts';

/** 把零件列表按「是否已制定工序」拆成两组。
 *  装配件（row_type === 'ASSEMBLY'）不参与分组 —— 本身不能指定工序，
 *  在左栏独立的「装配件」section 展示（PartPickerList.vue）。 */
export function splitPartsByProcessDesign(parts: PartListItem[]): {
  pending: PartListItem[];
  designed: PartListItem[];
} {
  const pending: PartListItem[] = [];
  const designed: PartListItem[] = [];
  for (const p of parts) {
    if (p.row_type === 'ASSEMBLY') continue;
    // `== null` 同时覆盖 null 与 undefined（后端旧出参可能缺字段）
    if (p.process_chain_id == null) {
      pending.push(p);
    } else {
      designed.push(p);
    }
  }
  return { pending, designed };
}
