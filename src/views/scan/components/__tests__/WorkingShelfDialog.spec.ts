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

function render(options: ShelfOption[], modelValue = true) {
  return mount(WorkingShelfDialog, {
    props: { modelValue, options },
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

  it('候选全在品检区 → 空态文案指向「联系管理员绑定生产货架」，不给确认按钮', async () => {
    const w = render([opt('2', 'SH-I02', 'INSPECTION')]);

    expect(w.find('.empty-state').exists()).toBe(true);
    expect(w.text()).toContain(
      '本账号当前绑定的货架在品检区，缺少生产区作业货架，请联系管理员为本账号绑定生产货架',
    );
    expect(w.findAll('.hmi-card')).toHaveLength(0);
    // 空态下点「完成」不该 emit confirm（没得可确认）
    await w.findAll('button').find((b) => b.text().includes('完成'))!.trigger('click');
    expect(w.emitted('confirm')).toBeUndefined();
  });

  it('单选：点第二张卡换选中，确认只 emit 后点的那一个', async () => {
    const w = render([opt('1', 'SH-P01', 'PRODUCTION'), opt('2', 'SH-P02', 'PRODUCTION')]);

    // 打开时不预选任何一张：多架账号里没有天然正确的默认项
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
  it('关闭后重开：清掉上一次的选中', async () => {
    const w = render([opt('1', 'SH-P01', 'PRODUCTION'), opt('2', 'SH-P02', 'PRODUCTION')]);
    await w.findAll('.hmi-card')[1]!.trigger('click');
    expect(w.findAll('.hmi-card.is-selected')).toHaveLength(1);

    await w.setProps({ modelValue: false });
    await w.setProps({ modelValue: true });

    expect(w.findAll('.hmi-card.is-selected')).toHaveLength(0);
  });
});
