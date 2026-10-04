// @vitest-environment happy-dom
// src/views/scan/components/__tests__/WorkingShelfDialog.spec.ts
//
// 2026-10-04 新增：送检选作业架弹窗的三条契约。
//
// 为什么值得单测（而不是在 ScanActionPicker 的页面 spec 里顺带断言）：本页的用例把弹窗
// 整个桩掉，只能验「confirm 事件被接上了」，验不了「弹窗真的只列生产架」—— 而「只列
// 生产架」正是这个组件存在的理由。送检的 `shelf_id` 必须是 PRODUCTION 区，品检架一旦
// 被选出去，后端 worker-scan 开头那道 `get_by_id_zone(shelf_id, "PRODUCTION")` 硬校验
// 会返 20501，工人选完才发现是错的，选架这一步本身就白做了。
//
// 组件自己不 fetch（候选由调用方从 useScanShelfStore 拿），所以本文件不需要 api 桩；
// HmiPickerCard 用真组件（同目录 spec 的既有取舍：卡片网格是本组件的主角）。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import WorkingShelfDialog from '../WorkingShelfDialog.vue';
import type { ShelfOption } from '@/stores/scanShelf';

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    template: '<div class="mock-dialog"><slot /><slot name="footer" /></div>',
  },
  'el-button': {
    name: 'ElButtonStub',
    props: ['disabled'],
    template: '<button :disabled="disabled"><slot /></button>',
  },
  'el-icon': { name: 'ElIconStub', template: '<i><slot /></i>' },
};

function opt(id: string, code: string, zone: string): ShelfOption {
  return { id, code, zone };
}

function render(
  options: ShelfOption[],
  extra: { modelValue?: boolean; currentShelfId?: string | null; emptyText?: string } = {},
) {
  return mount(WorkingShelfDialog, {
    props: {
      modelValue: extra.modelValue ?? true,
      options,
      currentShelfId: extra.currentShelfId,
      emptyText: extra.emptyText,
    },
    global: { stubs },
  });
}

/** 卡片的架号列表（按渲染顺序）—— 工人看到的网格内容。 */
function cardCodes(w: ReturnType<typeof render>): string[] {
  return w.findAll('.hmi-card .code').map((n) => n.text());
}

describe('WorkingShelfDialog', () => {
  it('只列 PRODUCTION 区候选（品检架不出现）', () => {
    const w = render([
      opt('1', 'SH-P01', 'PRODUCTION'),
      opt('2', 'SH-I02', 'INSPECTION'),
      opt('3', 'SH-P03', 'PRODUCTION'),
    ]);

    expect(cardCodes(w)).toEqual(['SH-P01', 'SH-P03']);
    expect(w.text()).not.toContain('SH-I02');
  });

  // 2026-10-04 review 第 2 轮：空态文案改由**调用方**传（`emptyText`）。组件判不出成因
  // （至少两个：都在品检区 / 所属区域暂未识别 = 调用方 store 兜底填的 UNKNOWN），猜错就会
  // 与背后的横条摆出互相矛盾的成因。下面两条分别锁「传了就用传的」与「不传才用兜底」。
  it('候选全在品检区 → 空态：不给确认按钮、也不 emit confirm', async () => {
    const w = render([opt('2', 'SH-I02', 'INSPECTION')]);

    expect(w.find('.empty-state').exists()).toBe(true);
    expect(w.findAll('.hmi-card')).toHaveLength(0);
    // 空态下点「完成」不该 emit confirm（没得可确认）
    await w.findAll('button').find((b) => b.text().includes('完成'))!.trigger('click');
    expect(w.emitted('confirm')).toBeUndefined();
  });

  it('emptyText 传了就原样渲染，且不与兜底文案混着出现', () => {
    const w = render([opt('2', 'SH-I02', 'INSPECTION')], {
      emptyText: '本账号绑定的货架里没有生产区作业货架（可能都在品检区，或所属区域暂未识别）……',
    });

    expect(w.find('.empty-text').text()).toBe(
      '本账号绑定的货架里没有生产区作业货架（可能都在品检区，或所属区域暂未识别）……',
    );
    // 兜底那句不该同时出现（否则又是一屏两条近义文案）
    expect(w.text()).not.toContain('缺少生产区作业货架');
  });

  it('未传 emptyText → 用组件内兜底（全品检这一支的既有文案）', () => {
    const w = render([opt('2', 'SH-I02', 'INSPECTION')]);

    expect(w.find('.empty-text').text()).toBe(
      '本账号当前绑定的货架在品检区，缺少生产区作业货架，请联系管理员为本账号绑定生产货架',
    );
  });

  // 组件侧只认「有没有生产架可列」，成因归调用方：UNKNOWN 区（store 兜底形态）同样落空态，
  // 此时渲染哪句完全由 emptyText 决定 —— 组件不猜。
  it('候选全是 UNKNOWN 区（store 兜底形态）→ 也落空态，文案同样由 emptyText 决定', () => {
    const w = render([opt('1', 'shelf#1', 'UNKNOWN')], {
      emptyText: '本账号绑定的货架里没有生产区作业货架（可能都在品检区，或所属区域暂未识别）……',
    });

    expect(w.find('.empty-state').exists()).toBe(true);
    expect(w.find('.empty-text').text()).toContain('或所属区域暂未识别');
  });

  // 兜底文案必须真的只覆盖「全品检」：zone 全未知时原样念出来是错的（见上方用例）。
  it('兜底文案那句在 zone 全 UNKNOWN 时不再被当成权威（未传 emptyText 的已知取舍）', () => {
    const w = render([opt('1', 'shelf#1', 'UNKNOWN')]);

    expect(w.find('.empty-state').exists()).toBe(true);
    // 兜底仍然是兜底：会显示，但调用方（唯一消费方）一定会传 emptyText，此处只是把
    // 「未传 ⇒ 显示兜底」这一行为钉住，不对兜底本身的文案正确性做跨 zone 断言。
    expect(w.find('.empty-text').text()).toContain('请联系管理员');
  });

  it('单选：点第二张卡换选中，确认只 emit 后点的那一个', async () => {
    const w = render([opt('1', 'SH-P01', 'PRODUCTION'), opt('2', 'SH-P02', 'PRODUCTION')]);

    // 调用方没传 currentShelfId（未选状态）⇒ 不预选任何一张：多架账号里没有天然正确的默认项
    expect(w.findAll('.hmi-card.is-selected')).toHaveLength(0);

    await w.findAll('.hmi-card')[1]!.trigger('click');
    const cards = w.findAll('.hmi-card');
    expect(cards[0]!.classes()).not.toContain('is-selected');
    expect(cards[1]!.classes()).toContain('is-selected');

    await w.findAll('button').find((b) => b.text().includes('完成'))!.trigger('click');
    expect(w.emitted('confirm')).toEqual([['2']]);
    // 写 store 由调用方做：本组件不碰 Pinia
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('cancel：不 emit confirm，只回 cancel + 关闭弹窗（调用方据此中止跳转）', async () => {
    const w = render([opt('1', 'SH-P01', 'PRODUCTION')]);

    await w.findAll('.hmi-card')[0]!.trigger('click');
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click');

    expect(w.emitted('confirm')).toBeUndefined();
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('update:modelValue')).toEqual([[false]]);
  });

  // 重新打开时清掉上一次的选中：候选可能已经变了（管理员解绑 / 换绑定），
  // 沿用旧选中等于替工人做了一个他没做的决定。
  it('关闭后重开：清掉上一次的选中（没有生效架可预选时）', async () => {
    const w = render([opt('1', 'SH-P01', 'PRODUCTION'), opt('2', 'SH-P02', 'PRODUCTION')]);
    await w.findAll('.hmi-card')[1]!.trigger('click');
    expect(w.findAll('.hmi-card.is-selected')).toHaveLength(1);

    await w.setProps({ modelValue: false });
    await w.setProps({ modelValue: true });

    expect(w.findAll('.hmi-card.is-selected')).toHaveLength(0);
  });

  // 2026-10-04 review 第 1 轮：预选调用方**已生效**的架。横条写着「当前：SH-P01」+
  // 「更换」，弹窗打开后那张卡却不是选中态，等于让工人把自己刚选过的架再指一次。
  it('传了 currentShelfId：打开即预选那一张（不要求工人重指）', async () => {
    const w = render([opt('1', 'SH-P01', 'PRODUCTION'), opt('2', 'SH-P02', 'PRODUCTION')], {
      currentShelfId: '2',
    });

    const cards = w.findAll('.hmi-card');
    expect(cards[0]!.classes()).not.toContain('is-selected');
    expect(cards[1]!.classes()).toContain('is-selected');

    // 不点任何卡直接「完成」⇒ emit 的就是预选值
    await w.findAll('button').find((b) => b.text().includes('完成'))!.trigger('click');
    expect(w.emitted('confirm')).toEqual([['2']]);
  });

  it('currentShelfId 指向品检架 / 越界 id / 未传 → 都不预选（预选只认可选集里的生产架）', async () => {
    const options = [opt('1', 'SH-P01', 'PRODUCTION'), opt('2', 'SH-I02', 'INSPECTION')];
    /** 「完成」按钮是否可点：预选错架时它会被悄悄放开，工人就能确认一个看不见的品检架。 */
    const confirmDisabled = (w: ReturnType<typeof render>): unknown => {
      const btn = w.findAll('button').find((b) => b.text().includes('完成'));
      return btn!.attributes('disabled');
    };

    // 品检架：单架品检账号的生效值。品检架不在可选集里，预选它等于默认了一个必然 20501
    // 的架 —— 而且它不在卡片网格里，「完成」会被悄悄放开，工人确认的是一张看不见的卡。
    const inZone = render(options, { currentShelfId: '2' });
    expect(inZone.findAll('.hmi-card.is-selected')).toHaveLength(0);
    expect(confirmDisabled(inZone)).toBeDefined();

    // 越界（已解绑 / listShelves 没返到）
    const stale = render(options, { currentShelfId: '999' });
    expect(stale.findAll('.hmi-card.is-selected')).toHaveLength(0);
    expect(confirmDisabled(stale)).toBeDefined();

    // 没传
    const none = render(options, { currentShelfId: null });
    expect(none.findAll('.hmi-card.is-selected')).toHaveLength(0);
    expect(confirmDisabled(none)).toBeDefined();
  });

  it('关闭后重开：预选跟着 currentShelfId 重算，不沿用上一轮的临时选中', async () => {
    const w = render([opt('1', 'SH-P01', 'PRODUCTION'), opt('2', 'SH-P02', 'PRODUCTION')], {
      currentShelfId: '1',
    });
    await w.findAll('.hmi-card')[1]!.trigger('click');
    expect(w.findAll('.hmi-card')[1]!.classes()).toContain('is-selected');

    await w.setProps({ modelValue: false });
    // 生效架在关闭期间变了（工人用别的入口改过 / store 重算过）
    await w.setProps({ modelValue: true, currentShelfId: '2' });

    expect(w.findAll('.hmi-card')[1]!.classes()).toContain('is-selected');
    expect(w.findAll('.hmi-card')[0]!.classes()).not.toContain('is-selected');
  });
});
