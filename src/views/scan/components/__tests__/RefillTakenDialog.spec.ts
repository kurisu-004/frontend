// @vitest-environment happy-dom
// src/views/scan/components/__tests__/RefillTakenDialog.spec.ts
//
// 2026-10-05 新增：worker-scan 同事务 refill 抢到批次时给工人看的告知弹窗。
//
// 钉住三件删掉也不会让任何用例变红、但会让产线出事的事：
//   1. **三样信息逐字渲染**：序列号 / 数量 / 系统交期。少了系统交期，工人按「先来后到」
//      排活，硬期限的件压到过期；少了序列号则无从对上物料，无从核对。
//   2. **leadText 承载本次扫码动作的成功提示**：父组件在开窗时**不发** ElMessage.success
//      （后开的 dialog 遮罩会盖住先发的 toast，见组件注释），这条文案一旦不渲染，工人的
//      「送检 / 放回到底成没成功」就只剩弹窗里那段补料信息 —— 语义上完全答非所问。
//   3. **唯一出口是「知道了」并把 modelValue 收到 false**：本组件由父组件 v-if 挂载，
//      关窗即卸载；漏抛 update:modelValue(false) ⇒ v-if 永远为 true，弹窗关不掉，
//      工人被卡死在它后面（本页所有操作都在同一屏）。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import RefillTakenDialog from '../RefillTakenDialog.vue';
import type { TakenItemDto } from '@/api/workerPool.contract';

/** el-dialog 壳 + footer slot、el-button 保留原生 click 透传，与同目录
 *  ReturnConfirmDialog.spec.ts / BatchPickerDialog.spec.ts 的桩手法一致。
 *  el-tag / el-icon 只需占位（加急标与图标的有无靠 v-if 断言文本）。 */
const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title', 'width', 'showClose'],
    template: '<div class="mock-dialog" :data-title="title"><slot /><slot name="footer" /></div>',
  },
  'el-button': {
    name: 'ElButtonStub',
    props: { type: String, size: String },
    template: '<button :data-type="type"><slot /></button>',
  },
  'el-tag': { name: 'ElTagStub', template: '<span class="mock-tag"><slot /></span>' },
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
};

/** 与后端 `TakenItemDto`（workerPool/model.rs TakenItem）同形。 */
function taken(over: Partial<TakenItemDto> = {}): TakenItemDto {
  return {
    batch_id: '223628232644100096',
    part_id: '223628232639905792',
    batch_no: 1,
    quantity: 1,
    serial_no: 'F2117',
    drawing_no: 'E42BD90H0658201',
    system_delivery_date: '2026-09-30',
    planned_delivery_date: '2026-09-24',
    is_urgent: false,
    version: 5,
    has_cnc_program: false,
    ...over,
  };
}

function render(props: {
  items: TakenItemDto[];
  leadText?: string;
  modelValue?: boolean;
}) {
  return mount(RefillTakenDialog, {
    props: { modelValue: true, ...props },
    global: { stubs },
  });
}

function ackButton(w: ReturnType<typeof render>) {
  const btn = w.findAll('button').find((b) => b.text() === '知道了');
  if (!btn) throw new Error(`找不到「知道了」按钮，实际：${w.text()}`);
  return btn;
}

describe('RefillTakenDialog / 补料告知', () => {
  it('逐条渲染序列号、数量与系统交期（复用卡片同款 chip 的 MM/DD 口径）', () => {
    const w = render({ items: [taken(), taken({ serial_no: 'F2118', quantity: 3 })] });
    const rows = w.findAll('.taken-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('F2117');
    expect(rows[0].text()).toContain('× 1');
    expect(rows[0].text()).toContain('09/30'); // formatDeliveryDate('2026-09-30')
    expect(rows[0].text()).toContain('系统交期');
    expect(rows[1].text()).toContain('F2118');
    expect(rows[1].text()).toContain('× 3');
  });

  it('serial_no 为空时回退显示图号（后端 serial_no 是 Option，无序列号件常态）', () => {
    const w = render({ items: [taken({ serial_no: null })] });
    expect(w.find('.serial-no').text()).toBe('E42BD90H0658201');
  });

  it('system_delivery_date 为 null 时 chip 仍渲染、日期位显示 -（不整行消失）', () => {
    const w = render({ items: [taken({ system_delivery_date: null })] });
    expect(w.find('.taken-row .qty').text()).toBe('× 1');
    const chip = w.find('.delivery-date');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toBe('-');
  });

  it('加急件才渲染加急标（chip 的「系统交期」标是另一个 el-tag，别混）', () => {
    expect(render({ items: [taken()] }).find('.taken-main .mock-tag').exists()).toBe(false);
    const urgent = render({ items: [taken({ is_urgent: true })] });
    expect(urgent.find('.taken-main .mock-tag').text()).toBe('加急');
  });

  // leadText 是送检 / 放回的成功提示本身（父组件在开窗时不再发 ElMessage.success）。
  // 不渲染 ⇒ 工人只看到「系统给您接了批」，无从知道自己上一步有没有成。
  it('leadText 逐字渲染；不传时不渲染这一行', () => {
    const withLead = render({ items: [taken()], leadText: '已送检：F2117' });
    expect(withLead.find('.lead-text').text()).toContain('已送检：F2117');
    expect(render({ items: [taken()] }).find('.lead-text').exists()).toBe(false);
  });

  it('条数文案单复数分岔（1 条不带数字、多条带总数）', () => {
    expect(render({ items: [taken()] }).find('.refill-text').text()).toBe(
      '系统已自动为您接取以下批次：',
    );
    expect(render({ items: [taken(), taken()] }).find('.refill-text').text()).toBe(
      '系统已自动为您接取以下 2 个批次：',
    );
  });

  it('点「知道了」只抛 update:modelValue(false)（父组件 v-if 据此卸载，弹窗才关得掉）', async () => {
    const w = render({ items: [taken()], leadText: '已放回：F2117 → 下料' });
    await ackButton(w).trigger('click');
    expect(w.emitted('update:modelValue')).toEqual([[false]]);
  });
});
