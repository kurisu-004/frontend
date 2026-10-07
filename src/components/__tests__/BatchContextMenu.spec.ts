// @vitest-environment happy-dom
// src/components/__tests__/BatchContextMenu.spec.ts
//
// 2026-10-06 新增：BatchContextMenu 的行为 spec。菜单是批次卡片右键操作的唯一 UI 入口，
// 它的两条硬需求分别由本 spec 与消费方 spec 守住：
//   - 本 spec：菜单本身（定位 / 视口钳制 / 派发 / 三种关闭 / 监听清理 / 菜单项由 props
//     驱动）；
//   - 消费方 spec：`@contextmenu.prevent` 真的落到了 BatchCard 根 div 上、且没有引入
//     包裹层（BatchCardDndFootprint.spec.ts 守不变式）。
//
// 2026-10-08 升为共享组件（从 views/production/queue/components 搬来）：菜单项由调用方
// 经 `items` 配置、动作由 `select(key, batch)` 分发，本 spec 的用例相应从「硬编码一条
// 召回项」改成按传入 items 断言。⚠️ 用例结构整体保留（原样搬，不重写）：定位 / 钳制 /
// 三种关闭 / 监听清理这些行为与菜单项数无关，改写等于丢掉原有的回归网。
//
// 覆盖：
//   - C1：open(evt, batch) → 菜单渲染出来，left/top 等于传入坐标，文案 = 传入的 items；
//   - C2：贴右下角的坐标被钳制回视口内（不出屏）；
//   - C3：点菜单项 → emit('select', **该项的 key**, **同一个 batch 实例**) 且菜单先关闭；
//   - C4：Escape 关闭；C5：点菜单外部关闭；点菜单内部不关；
//   - C6：unmount 后 document 上的监听已移除（removeEventListener 断言）；
//   - C7：dumb 契约 —— 组件不认识 api / store，**唯一 prop 是 items**（目标批次只走
//     expose 的 open 入参，没有 batch / target 之类的 prop）；
//   - C8：多菜单项 → 每项都渲染，且点第 N 项 emit 第 N 项的 key（分发键不错位）；
//   - C9：items 为空数组 → 不渲染菜单（调用方用它表达「本角色无可执行动作」）。
//
// 测试策略：
//   - 挂**真** el-menu / el-menu-item：菜单项的点击 → `select` 派发链是 EP 内部实现
//     （menu-item → inject menu → rootMenu.handleClick），换成 stub 用例就恒绿、
//     什么也守不住；happy-dom 下不涉及浮层，不需要 teleport 之外的任何 mock。
//   - 组件用 expose 出来的 open() 驱动（与线上一致：板级 opener 调它），不构造
//     MouseEvent 之外的任何耦合。
//   - 不用 vi.mock('element-plus')：本组件只用 el-menu / el-menu-item 两个渲染组件，
//     不碰 ElMessage / ElMessageBox，真实组件在 happy-dom 下可正常挂载。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ElMenu, ElMenuItem } from 'element-plus';
import BatchContextMenu, { type BatchContextMenuItem } from '../BatchContextMenu.vue';
import type { BatchCardModel } from '@/types/batchCard';

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
    has_cnc_program: false,
    customer_l1: '某某集团',
    customer_l2: null,
    applicant_name: '张三',
    note: null,
    location: 'A-01',
    shelf_id: '5000000000001',
    version: 7,
    ...overrides,
  };
}

/** 默认菜单项：单条召回项（与生产队列板级给的那一项同形）。 */
const RECALL_ITEMS: BatchContextMenuItem[] = [{ key: 'recall', label: '召回到待下发' }];

interface MenuExpose {
  open: (evt: MouseEvent, batch: BatchCardModel) => void;
}

/** 挂菜单组件（挂在 document 上，teleport 的目标就是 body）。 */
function mountMenu(items: BatchContextMenuItem[] = RECALL_ITEMS): VueWrapper {
  return mount(BatchContextMenu, {
    props: { items },
    global: { components: { ElMenu, ElMenuItem } },
    attachTo: document.body,
  }) as VueWrapper;
}

/** 定位容器（teleport 到 body 后不在 wrapper.element 里，按 class 全局找）。 */
function menuBox(wrapper: VueWrapper): HTMLElement {
  const el = document.querySelector<HTMLElement>('.batch-context-menu');
  expect(el).not.toBeNull();
  // 断言它确实被 teleport 到了 body（不在 wrapper 自己的挂载点内）
  expect(wrapper.element.contains(el)).toBe(false);
  return el as HTMLElement;
}

/** 造一个带坐标的 MouseEvent（组件只读 clientX / clientY）。 */
function contextEvent(x: number, y: number): MouseEvent {
  return new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true });
}

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.querySelectorAll('.batch-context-menu').forEach((el) => el.remove());
});

describe('BatchContextMenu（批次卡片右键菜单）', () => {
  it('C1：open 后菜单渲染出来，left/top 等于传入坐标', async () => {
    wrapper = mountMenu();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(240, 180), makeCard());
    await nextTick();

    const box = menuBox(wrapper);
    expect(box.style.left).toBe('240px');
    expect(box.style.top).toBe('180px');
    // 文案来自 props.items，不是组件里的硬编码
    expect(box.querySelector('.el-menu-item')?.textContent?.trim()).toBe('召回到待下发');
  });

  it('C1b：未 open 时不渲染菜单（teleport 只留锚点）', async () => {
    wrapper = mountMenu();
    await nextTick();
    expect(document.querySelector('.batch-context-menu')).toBeNull();
  });

  it('C2：贴右下角的坐标被钳制回视口内（菜单不出屏）', async () => {
    wrapper = mountMenu();
    const far = new MouseEvent('contextmenu', {
      clientX: 10_000,
      clientY: 10_000,
      bubbles: true,
    });
    (wrapper.vm as unknown as MenuExpose).open(far, makeCard());
    await nextTick();

    const box = menuBox(wrapper);
    const left = Number.parseInt(box.style.left, 10);
    const top = Number.parseInt(box.style.top, 10);
    // 钳制量是估算值（宽 160、高按条目数算），只断言「不越界且为正」
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(window.innerWidth);
    expect(top).toBeLessThanOrEqual(window.innerHeight);
    expect(box.style.left).not.toBe('10000px');
    expect(box.style.top).not.toBe('10000px');
  });

  it('C3：点菜单项 → emit(select, 该项 key, 同一个 batch 实例)，且菜单先关闭', async () => {
    wrapper = mountMenu();
    const batch = makeCard();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(100, 100), batch);
    await nextTick();

    const item = document.querySelector<HTMLElement>('.el-menu-item');
    expect(item).not.toBeNull();
    item!.click();
    await nextTick();

    const emitted = wrapper.emitted('select');
    expect(emitted).toHaveLength(1);
    // 同一实例：消费方（useBatchRecall / 外协收发链路）要的是卡片自带的 batch_id / version
    expect(emitted![0]![0]).toBe('recall');
    expect(emitted![0]![1]).toBe(batch);
    expect(document.querySelector('.batch-context-menu')).toBeNull();
  });

  it('C4：Escape 关闭菜单', async () => {
    wrapper = mountMenu();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(100, 100), makeCard());
    await nextTick();
    expect(document.querySelector('.batch-context-menu')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.querySelector('.batch-context-menu')).toBeNull();
  });

  it('C4b：其它按键不关闭菜单', async () => {
    wrapper = mountMenu();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(100, 100), makeCard());
    await nextTick();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(document.querySelector('.batch-context-menu')).not.toBeNull();
  });

  it('C5：点菜单外部关闭；点菜单内部（含菜单项）不关', async () => {
    wrapper = mountMenu();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(100, 100), makeCard());
    await nextTick();

    // 点菜单内部（用菜单自身的 ul）→ 不关
    const inner = document.querySelector<HTMLElement>('.el-menu');
    inner!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await nextTick();
    expect(document.querySelector('.batch-context-menu')).not.toBeNull();

    // 点外部 → 关
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await nextTick();
    expect(document.querySelector('.batch-context-menu')).toBeNull();
  });

  it('C6：unmount 后 document 上的监听已移除', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    wrapper = mountMenu();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(100, 100), makeCard());
    await nextTick();

    wrapper.unmount();
    wrapper = null;
    const types = removeSpy.mock.calls.map((c) => c[0]);

    // 关闭路径有三条（点外部 / Escape / select），unmount 路径必须也把两个监听摘干净
    expect(types).toContain('pointerdown');
    expect(types).toContain('keydown');
    removeSpy.mockRestore();
  });

  it('C7：dumb 契约 —— 只收 items 一个 prop（目标批次只走 expose 的 open 入参）', () => {
    wrapper = mountMenu();
    const def = (wrapper.vm.$options as unknown as { props?: Record<string, unknown> }).props ?? {};
    // 组件不许有 batch / target 之类的 prop：目标批次是「光标在哪」的瞬时状态，
    // 只经 open(evt, batch) 传入，多声明一个 prop 就多一条能让调用方存错对象的路。
    expect(Object.keys(def)).toEqual(['items']);
  });

  it('C8：多菜单项逐项渲染，且点第 N 项 emit 第 N 项的 key（分发键不错位）', async () => {
    wrapper = mountMenu([
      { key: 'recall', label: '召回到待下发' },
      { key: 'split', label: '拆分批次' },
      { key: 'cancel', label: '取消批次', danger: true },
    ]);
    const batch = makeCard();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(100, 100), batch);
    await nextTick();

    const rendered = [...document.querySelectorAll('.el-menu-item')].map((el) => el.textContent?.trim());
    expect(rendered).toEqual(['召回到待下发', '拆分批次', '取消批次']);
    // danger 项带标记 class（EP 的 el-menu-item 没有 danger prop，颜色由本组件样式给）
    const third = document.querySelectorAll('.el-menu-item')[2]!;
    expect(third.classList.contains('is-danger')).toBe(true);

    // 点中间那条 ⇒ key 与 batch 都要对
    document.querySelectorAll<HTMLElement>('.el-menu-item')[1]!.click();
    await nextTick();
    const emitted = wrapper.emitted('select');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]![0]).toBe('split');
    expect(emitted![0]![1]).toBe(batch);
  });

  it('C9：items 为空数组 → 不渲染菜单（调用方用它表达本角色无可执行动作）', async () => {
    wrapper = mountMenu([]);
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(100, 100), makeCard());
    await nextTick();
    expect(document.querySelector('.batch-context-menu')).toBeNull();
  });
});
