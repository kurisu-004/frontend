// src/views/hr/schedule/utils/__tests__/dayType.spec.ts
//
// 2026-10-19 新建：日型展示元数据的单测。核心是**防双份定义漂移**：
// `utils/dayType.ts` 只做展示层取数，6 档的**枚举真源必须仍是 `@/types/hr` 的
// `HR_DAY_TYPES` / `HR_DAY_TYPE_META` / `isHrWorkday`。本文件把这条钉死 —— 有人在本文件
// 旁边另抄一份 6 档字面量数组时，下面 T2 / T3 立刻红。

import { describe, expect, it } from 'vitest';
import { HR_DAY_TYPE_META, HR_DAY_TYPES, isHrWorkday, type HrDayType } from '@/types/hr';
import {
  HR_DAY_TYPE_OPTIONS,
  crossDayText,
  dailyMinutesText,
  dayTypeAcceptsName,
  dayTypeLabel,
  dayTypeTagType,
  dayTypeRequiresName,
  isWorkdayDayType,
} from '../dayType';

describe('HR_DAY_TYPE_OPTIONS — 与 `@/types/hr` 同源', () => {
  it('T1：6 档齐全且顺序逐字等于 `HR_DAY_TYPES`', () => {
    expect(HR_DAY_TYPE_OPTIONS).toHaveLength(6);
    expect(HR_DAY_TYPE_OPTIONS.map((o) => o.value)).toEqual([...HR_DAY_TYPES]);
    // 逐字钉死（不是「集合相等」）：顺序变了就是展示顺序变了，必须有人决定。
    expect([...HR_DAY_TYPES]).toEqual([
      'WORKDAY',
      'MAKEUP_WORKDAY',
      'REST_DAY',
      'STATUTORY_HOLIDAY',
      'MAKEUP_HOLIDAY',
      'CUSTOM_LEAVE',
    ]);
  });

  it('T2：**每个 option 的 label / colorKey 都取自 `HR_DAY_TYPE_META`**（没抄第二份）', () => {
    for (const opt of HR_DAY_TYPE_OPTIONS) {
      expect(opt.label).toBe(HR_DAY_TYPE_META[opt.value].label);
      expect(opt.colorKey).toBe(HR_DAY_TYPE_META[opt.value].colorKey);
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.colorKey.length).toBeGreaterThan(0);
    }
  });

  it('T3：6 个色板键互不相同（否则两类日型在月历里长得一样）', () => {
    const keys = HR_DAY_TYPE_OPTIONS.map((o) => o.colorKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('T4：6 档中文标签齐全（无空串 / 无英文枚举漏出）', () => {
    const labels = HR_DAY_TYPE_OPTIONS.map((o) => o.label);
    expect(labels).toEqual([
      '工作日',
      '调休上班',
      '休息日',
      '法定节假日',
      '调休放假',
      '自定义休息',
    ]);
    for (const l of labels) expect(l).not.toMatch(/[A-Z_]{3,}/);
  });
});

describe('isHrWorkday — 只有两档算上班', () => {
  it('W1：`WORKDAY` / `MAKEUP_WORKDAY` 为真，其余四档为假', () => {
    const workdayTypes = HR_DAY_TYPES.filter((t) => isHrWorkday(t));
    expect(workdayTypes).toEqual(['WORKDAY', 'MAKEUP_WORKDAY']);
    for (const t of HR_DAY_TYPES) {
      expect(isHrWorkday(t)).toBe(t === 'WORKDAY' || t === 'MAKEUP_WORKDAY');
    }
  });

  it('W2：`utils/dayType` 的转发与真源同判（页面只有一个入口）', () => {
    for (const t of HR_DAY_TYPES) {
      expect(isWorkdayDayType(t)).toBe(isHrWorkday(t));
    }
  });
});

describe('dayTypeLabel / dayTypeTagType / 名称判据', () => {
  it('L1：label 取自 META', () => {
    expect(dayTypeLabel('CUSTOM_LEAVE')).toBe('自定义休息');
  });

  it('L2：**能填名称** = `CUSTOM_LEAVE` / `STATUTORY_HOLIDAY`（法定节假日要能起「国庆节」的名）', () => {
    const accept = HR_DAY_TYPES.filter((t) => dayTypeAcceptsName(t));
    expect(accept).toEqual(['STATUTORY_HOLIDAY', 'CUSTOM_LEAVE']);
  });

  it('L2b：**必须填名称**只有 `CUSTOM_LEAVE`（后端 21907 的前端版；法定节假日不填照样入库）', () => {
    const require_ = HR_DAY_TYPES.filter((t) => dayTypeRequiresName(t));
    expect(require_).toEqual(['CUSTOM_LEAVE']);
    // 「能填」≠「必填」：把两档合成一个判据，前端就会凭空拒一条后端允许的写。
    for (const t of HR_DAY_TYPES) {
      expect(dayTypeRequiresName(t)).toBe(t === 'CUSTOM_LEAVE');
      expect(dayTypeAcceptsName(t)).toBe(t === 'CUSTOM_LEAVE' || t === 'STATUTORY_HOLIDAY');
    }
  });

  it('L3：未知日型不抛（守门在 Zod 那层，这里只保证标签渲染不炸）', () => {
    const bogus = 'SOMETHING_ELSE' as HrDayType;
    expect(dayTypeLabel(bogus)).toBe('SOMETHING_ELSE');
    expect(dayTypeTagType(bogus)).toBe('info');
  });
});

describe('dayTypeTagType — 6 档日型 → `el-tag` 的 type（映射表在 dayType.ts 一处）', () => {
  it('T5：逐档映射钉死（格内徽标的颜色口径，改一处必须改两处会当场看见）', () => {
    expect(dayTypeTagType('WORKDAY')).toBe('primary');
    expect(dayTypeTagType('MAKEUP_WORKDAY')).toBe('success');
    expect(dayTypeTagType('REST_DAY')).toBe('info');
    expect(dayTypeTagType('MAKEUP_HOLIDAY')).toBe('info'); // 调休放假
    expect(dayTypeTagType('STATUTORY_HOLIDAY')).toBe('danger');
    expect(dayTypeTagType('CUSTOM_LEAVE')).toBe('warning');
    // 取值必须落在 Element Plus 的 5 个 `type` 里（多写一个渲染不出来）。
    for (const t of HR_DAY_TYPES) {
      expect(['primary', 'success', 'info', 'warning', 'danger']).toContain(dayTypeTagType(t));
    }
  });

  it('T6：`dayType === null`（后端没返那天）给 `info`，**不给 `primary`**', () => {
    // 给 primary 会把「这条没数据」渲染成「这天照常上班」，用户照着改日型时判断依据是错的。
    expect(dayTypeTagType(null)).toBe('info');
  });

  it('T7：`REST_DAY` 与 `MAKEUP_HOLIDAY` 同落 `info` 是**已定的取舍**（靠文字区分）', () => {
    // 元素只有 5 个 type 而日型有 6 档，牺牲的是两档休息日的颜色区分（原先也都是灰系）。
    expect(dayTypeTagType('REST_DAY')).toBe(dayTypeTagType('MAKEUP_HOLIDAY'));
    expect(dayTypeLabel('REST_DAY')).not.toBe(dayTypeLabel('MAKEUP_HOLIDAY'));
  });
});

describe('crossDayText / dailyMinutesText — 班次派生值的展示', () => {
  it('C1：`overflow_minutes = 0` → 无标注（不跨天）', () => {
    expect(crossDayText(0)).toBe('');
    expect(crossDayText(-30)).toBe('');
  });

  it('C2：不足一天按小时写（夜班收在次日 02:00 ⇒ 120 分钟 ⇒ `跨天 +2h`）', () => {
    expect(crossDayText(120)).toBe('跨天 +2h');
    // ⚠️ 写「+0天」等于没标 —— 90 分钟溢出截成整小时就会落进这个坑。
    expect(crossDayText(90)).toBe('跨天 +2h');
  });

  it('C3：超过一天按天写', () => {
    expect(crossDayText(24 * 60)).toBe('跨天 +1天');
    expect(crossDayText(2 * 24 * 60)).toBe('跨天 +2天');
    // 1.25 天按天算向下取整成 1（分钟数没被偷偷换算回小时）。
    expect(crossDayText(30 * 60)).toBe('跨天 +1天');
  });

  it('C4：`daily_minutes` 人话（整小时不带分位）', () => {
    expect(dailyMinutesText(480)).toBe('8h');
    expect(dailyMinutesText(510)).toBe('8h30m');
    expect(dailyMinutesText(0)).toBe('');
  });
});
