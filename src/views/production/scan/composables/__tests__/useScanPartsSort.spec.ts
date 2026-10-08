// src/views/production/scan/composables/__tests__/useScanPartsSort.spec.ts
//
// 2026-10-04 新增：报工台客户端排序的四条产品规则的回归锁。
//
// 为什么这份 spec 是这次改动的根因之一：排序函数本身逐条**早就**满足产品规则
// （加急最先、有系统交期的整组在前、组内日期升序、id 降序兜底），但它此前**零测试**。
// 于是「后端还没给真实投影」这件事没有任何红灯提示 —— 键 1 / 2 / 3 在占位值上不产生
// 差异、排序静默退化成「按 id 降序」，而两端都以为规则在生效。后端一改数据，规则要不要
// 真的生效、往哪个方向生效，全靠人肉比对列表。
//
// 本文件的四条规则各用构造数据锁死（不依赖任何真实后端数据形状），并额外钉住两条容易
// 悄悄变形的边界：
//   - 两个日期都缺时走键 4（id 字符串降序），且这条 tie-break 只在日期相同时生效；
//   - `is_urgent` 是**第一**键：加急件的「无系统交期」不能把它压到无系统交期组之后。
//
// 判据一律用「id 序列」而不是「某一项在第几位」：后者会被同组内其它行挤动，前者正是
// 报工台三页真正渲染的顺序。
// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useScanPartsSort, type ScanSortablePart } from '../useScanPartsSort';

/** 构造一行；只写排序用到的四个字段，其余字段与报工台三页读的一致（多余字段不影响）。 */
function part(
  id: string,
  opts: { is_urgent?: boolean; planned?: string | null; system?: string | null } = {},
): ScanSortablePart {
  return {
    id,
    is_urgent: opts.is_urgent ?? false,
    planned_delivery_date: opts.planned ?? null,
    system_delivery_date: opts.system ?? null,
  };
}

function ids(list: ScanSortablePart[]): string[] {
  return list.map((p) => p.id);
}

describe('useScanPartsSort / compareScanParts', () => {
  it('规则①：加急件排最前（哪怕它没有系统交期、日期最晚）', () => {
    const sorted = useScanPartsSort(
      ref([
        part('001', { system: '2026-01-01' }),
        part('002', { system: '2026-12-31' }),
        part('003', { is_urgent: true, planned: '2026-12-31' }),
      ]),
    );

    // 键 1 优先于键 2：加急件若被键 2 压到「无系统交期」那一组之后，就会沉在列表尾部 ——
    // 那正是「加急」这个标记存在意义的反面。
    expect(ids(sorted.value)).toEqual(['003', '001', '002']);
  });

  it('规则②：无系统交期的整组排在有系统交期的之后（组内仍各按键 3 排）', () => {
    const sorted = useScanPartsSort(
      ref([
        part('001', { planned: '2026-01-05' }),
        part('002', { system: '2026-12-31' }),
        part('003', { planned: '2026-01-01' }),
        part('004', { system: '2026-01-10' }),
      ]),
    );

    // 有系统交期组（002/004）整体在前并按系统交期升序；无系统交期组（001/003）在后并按
    // 计划交期升序 —— 计划交期在这里是**纯排序键**，不上屏。
    expect(ids(sorted.value)).toEqual(['004', '002', '003', '001']);
  });

  it('规则③：组内日期升序（ASC），且有系统交期的一律用系统交期而不是计划交期', () => {
    const sorted = useScanPartsSort(
      ref([
        part('001', { system: '2026-03-01' }),
        part('002', { system: '2026-01-01' }),
        part('003', { system: '2026-02-01' }),
      ]),
    );

    expect(ids(sorted.value)).toEqual(['002', '003', '001']);
  });

  it('规则③：同组内日期都缺时先落到键 4（id 字符串降序）', () => {
    const sorted = useScanPartsSort(
      ref([part('001'), part('003'), part('002')]),
    );

    // 全都无日期 ⇒ 键 3 返回 0，最终由 id 字符串降序决定（雪花 id 单调递增，
    // 字典序等价于数值序 ⇒ 「新件在前」）
    expect(ids(sorted.value)).toEqual(['003', '002', '001']);
  });

  it('边界：组内一个缺日期时不按 id 排，缺日期的沉到该组末尾（NULLS LAST）', () => {
    const sorted = useScanPartsSort(
      ref([part('001'), part('002', { system: '2026-01-01' }), part('003')]),
    );

    // 001 / 003 都无系统交期 ⇒ 同组；002 单独成组在前。
    // 组内 003 有 planned、001 没有 ⇒ 001 沉底。这条守住「NULLS LAST」不被写成
    // 「NULLS FIRST」—— 否则无日期的件会浮到有日期的件上面，工人先看到最没信息量的行。
    expect(ids(sorted.value)).toEqual(['002', '003', '001']);
  });

  it('边界：日期相同的组内成员才走 id 降序（tie-break 不越权到跨组）', () => {
    const sorted = useScanPartsSort(
      ref([
        part('001', { system: '2026-05-01' }),
        part('002', { system: '2026-05-01' }),
        part('003', { system: '2026-05-01', is_urgent: true }),
      ]),
    );

    // 003 加急 ⇒ 键 1 把它提到最前（不是 id 序）；001 / 002 同日期 ⇒ 键 4 排 002 在前。
    expect(ids(sorted.value)).toEqual(['003', '002', '001']);
  });

  it('全量混合：四条规则按优先级依次生效', () => {
    const sorted = useScanPartsSort(
      ref([
        part('100', { system: '2026-06-01' }),
        part('200', { planned: '2026-01-01' }),
        part('300', { is_urgent: true, system: '2026-12-31' }),
        part('400', { planned: '2026-02-01' }),
        part('500', { system: '2026-06-01' }),
        part('600', { is_urgent: true, planned: '2026-03-01' }),
        part('700', { system: '2026-01-01' }),
      ]),
    );

    // 分组：加急组（300 / 600）→ 有系统交期组（700 / 100 / 500）→ 无系统交期组（200 / 400）
    // 键 1: 300 / 600 加急排最前；组内键 2 仍生效 —— 300 有系统交期、600 没有，
    //      所以 300 在 600 之前（键 2 优先于键 3，600 的 planned 03/01 不参与这一步）
    // 键 3: 700 sys 01/01 < 100 sys 06/01 = 500 sys 06/01（后者同日期走键 4 ⇒ 500 在前）
    // 键 3: 200 planned 01/01 < 400 planned 02/01
    expect(ids(sorted.value)).toEqual(['300', '600', '700', '500', '100', '200', '400']);
  });

  it('不改原数组（复制后排序，不原地变更 ref 持有的数组）', () => {
    const source = ref<ScanSortablePart[]>([part('001'), part('002')]);
    const before = ids(source.value);
    useScanPartsSort(source);

    expect(ids(source.value)).toEqual(before);
  });
});
