// src/utils/__tests__/batchCardKeyword.spec.ts
//
// 2026-10-20 新增：`src/utils/batchCardKeyword.ts` 的契约守卫。**被测的是四条判定规则**
// （空关键词全通过 / trim / 忽略大小写 / 四字段任一命中），不是「某页渲染成什么样」——
// 同一份过滤被生产队列的待下发区 / 工序候选池与外协候选池三处消费，规则只有这一份。
//
// 之所以值得单测而不是靠组件 spec 顺带覆盖：四个匹配字段各自命中那条，只有在**直接**给
// `matchesBatchCardKeyword` 喂一张只有单字段不同的卡片时才有判定力；组件层的用例只能证明
// 「串起整条链之后还能用」，改掉某个字段（比如把 batch_no 从匹配集合里删掉）组件层仍可能
// 因为另外三个字段命中而全绿。
//
// **K9 / K10 直接打 `filterBatchCardsByKeyword`**（生产路径就是它，三个卡片列只调它）。
// 组件 spec 的关键词不带首尾空白与混合大小写，所以这一组是那条路上归一化规则
// （trim / 忽略大小写）的守卫：K1~K8 里另有若干条也打 filter，逐条含义见各用例。

import { describe, expect, it } from 'vitest';
import { filterBatchCardsByKeyword, matchesBatchCardKeyword } from '../batchCardKeyword';
import type { BatchCardModel } from '@/types/batchCard';

/** 只让四个匹配字段有值、其余字段保持合法占位的卡片。 */
function makeCard(overrides: Partial<BatchCardModel> = {}): BatchCardModel {
  return {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    batch_no: 'B1024',
    part_name: '连杆',
    drawing_no: 'DRW-1',
    serial_no: 'SN-0001',
    quantity: 12,
    system_delivery_date: '2026-10-20',
    planned_delivery_date: null,
    is_urgent: false,
    has_process_chain: false,
    has_cnc_program: false,
    customer_l1: '某某集团',
    customer_l2: '某某零件厂',
    applicant_name: '张三',
    note: null,
    location: null,
    shelf_id: null,
    ...overrides,
  };
}

describe('batchCardKeyword（2026-10-20 批次卡片关键词过滤）', () => {
  it('K1：空关键词（空串 / 空格 / 制表）→ 全部通过，filter 原样返回入参数组', () => {
    const cards = [makeCard(), makeCard({ batch_id: '3000000000002', serial_no: null })];
    // trim 后为空是「不过滤」的唯一判据 —— 三个搜索框的初始态与用户清空后的常态。
    for (const blank of ['', '   ', '\t', '\n ', '　']) {
      expect(matchesBatchCardKeyword(cards[0]!, blank)).toBe(true);
      expect(filterBatchCardsByKeyword(cards, blank)).toBe(cards);
    }
  });

  it('K2：关键词先 trim（吸收条码枪的尾随空格 / 回车）', () => {
    const card = makeCard();
    expect(matchesBatchCardKeyword(card, '  SN-0001  ')).toBe(true);
    expect(matchesBatchCardKeyword(card, 'SN-0001\r')).toBe(true);
    // trim 不能反过来把「只差首尾空白」变成不同字段的匹配对象：trim 后仍要全字段比对
    expect(matchesBatchCardKeyword(card, ' DRW-1 ')).toBe(true);
    expect(filterBatchCardsByKeyword([card], '  连杆 ')).toHaveLength(1);
    expect(filterBatchCardsByKeyword([card], '  不存在的词  ')).toHaveLength(0);
  });

  it('K3：匹配忽略大小写（序列号大小写混输是现场常态）', () => {
    const card = makeCard({ serial_no: 'F1234', batch_no: 'B7', part_name: 'Axle' });
    expect(matchesBatchCardKeyword(card, 'f1234')).toBe(true);
    expect(matchesBatchCardKeyword(card, 'F1234')).toBe(true);
    expect(matchesBatchCardKeyword(card, 'b7')).toBe(true);
    expect(matchesBatchCardKeyword(card, 'axle')).toBe(true);
  });

  it('K4：四个匹配字段各自命中（序列号 / 图号 / 批次号 / 名称）', () => {
    const card = makeCard({
      serial_no: 'SN-0001',
      drawing_no: 'DRW-9',
      batch_no: 'B777',
      part_name: '齿轮',
    });
    expect(matchesBatchCardKeyword(card, 'SN-0001')).toBe(true);
    expect(matchesBatchCardKeyword(card, 'DRW-9')).toBe(true);
    expect(matchesBatchCardKeyword(card, 'B777')).toBe(true);
    expect(matchesBatchCardKeyword(card, '齿轮')).toBe(true);
    // 四字段都不命中 ⇒ 不通过（只断言反方向会漏掉「匹配集合为空集」的退化实现）
    expect(matchesBatchCardKeyword(card, 'SN-0002')).toBe(false);
    expect(matchesBatchCardKeyword(card, '客户名')).toBe(false);
  });

  it('K5：子串命中（模糊包含，不是等值 / 前缀匹配）', () => {
    const card = makeCard({ serial_no: 'SN-2026-0001', part_name: '连杆总成' });
    expect(matchesBatchCardKeyword(card, '2026')).toBe(true);
    expect(matchesBatchCardKeyword(card, '0001')).toBe(true);
    expect(matchesBatchCardKeyword(card, '总成')).toBe(true);
  });

  it('K6：可空字段为 null 不抛错，且空值不会被任何非空关键词命中', () => {
    const card = makeCard({ serial_no: null });
    expect(() => matchesBatchCardKeyword(card, 'SN')).not.toThrow();
    // 序列号缺失的那张卡仍能按图号 / 批次号 / 名称命中
    expect(matchesBatchCardKeyword(card, 'DRW-1')).toBe(true);
    expect(matchesBatchCardKeyword(card, 'B1024')).toBe(true);
    expect(matchesBatchCardKeyword(card, '连杆')).toBe(true);
    expect(matchesBatchCardKeyword(card, 'SN')).toBe(false);
    // 四个字段全空 + 空关键词 ⇒ 仍然通过（空关键词短路在字段遍历之前）
    const blank = makeCard({ serial_no: null, drawing_no: '', batch_no: '', part_name: '' });
    expect(matchesBatchCardKeyword(blank, '')).toBe(true);
    expect(filterBatchCardsByKeyword([blank], '')).toHaveLength(1);
    expect(filterBatchCardsByKeyword([blank], 'a')).toHaveLength(0);
  });

  it('K7：filter 保持原顺序、不改入参数组（返回新数组，元素同引用）', () => {
    const a = makeCard({ batch_id: '3000000000001', serial_no: 'SN-A' });
    const b = makeCard({ batch_id: '3000000000002', serial_no: 'SN-B' });
    const c = makeCard({ batch_id: '3000000000003', serial_no: 'SN-C' });
    const input = [a, b, c];
    const snapshot = [...input];

    const hit = filterBatchCardsByKeyword(input, 'sn-');

    // 顺序按入参排（不是按命中度排序，卡片顺序本身是后端语义）
    expect(hit.map((x) => x.batch_id)).toEqual([a.batch_id, b.batch_id, c.batch_id]);
    expect(hit[0]).toBe(a);
    expect(hit[1]).toBe(b);
    // 入参数组未被就地改动
    expect(input).toEqual(snapshot);
    expect(input).toHaveLength(3);
    expect(filterBatchCardsByKeyword(input, 'SN-B')).toEqual([b]);
    expect(filterBatchCardsByKeyword(input, 'SN-B')).not.toBe(input);
  });

  it('K8：入参数组为空 / 过滤后为空都不抛错', () => {
    expect(filterBatchCardsByKeyword([], 'SN-0001')).toEqual([]);
    expect(filterBatchCardsByKeyword([], '')).toEqual([]);
    expect(filterBatchCardsByKeyword([makeCard()], 'ZZZ')).toEqual([]);
  });

  it('K9：filter 直接吃带首尾空白的关键词（条码枪 / 粘贴的空格落在生产路径上）', () => {
    const card = makeCard({ serial_no: 'SN-0001' });
    // 真打空白（不是只打 'sn-'）：漏掉 trim 时 needle 恒带空格，四张卡一条都命中不了
    expect(filterBatchCardsByKeyword([card], '  SN-0001  ')).toHaveLength(1);
    expect(filterBatchCardsByKeyword([card], 'SN-0001\r')).toHaveLength(1);
    expect(filterBatchCardsByKeyword([card], ' SN-0001 ')[0]).toBe(card);
    // 反方向同样成立：带空白的关键词要能筛掉，而不是「trim 前不匹配就全量放行」
    expect(filterBatchCardsByKeyword([card], '  不存在的词  ')).toHaveLength(0);
    // 只含空白的关键词仍是「不过滤」（原样返回入参数组，不是新数组）
    expect(filterBatchCardsByKeyword([card], '   ')).toHaveLength(1);
  });

  it('K10：filter 直接吃小写关键词命中大写序列号（忽略大小写落在生产路径上）', () => {
    // 序列号是大写、关键词全小写：归一化只漏一边（needle 不 lowerCase）时全表落空
    const card = makeCard({ serial_no: 'F1234', batch_no: 'B777', part_name: 'Axle' });
    expect(filterBatchCardsByKeyword([card], 'f1234')).toHaveLength(1);
    expect(filterBatchCardsByKeyword([card], 'b777')).toHaveLength(1);
    expect(filterBatchCardsByKeyword([card], 'axle')).toHaveLength(1);
    // 另一向：大小写混输的关键词（现场常态）—— needle 与 haystack 两边都必须归一化
    expect(filterBatchCardsByKeyword([card], 'F1234')).toHaveLength(1);
    expect(filterBatchCardsByKeyword([card], 'f12')).toHaveLength(1);
    // 反方向：四字段都不含的子串必须筛掉（防「归一化写错导致恒真」的退化实现）
    expect(filterBatchCardsByKeyword([card], 'f9999')).toHaveLength(0);
  });
});
