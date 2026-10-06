// @vitest-environment happy-dom
// src/views/production/components/__tests__/BatchContextMenu.spec.ts
//
// 2026-10-06 新增：BatchContextMenu 的行为 spec。菜单是「已下发批次右键召回」的唯一
// UI 入口，它的两条硬需求分别由本 spec 与 PoolDrawer/WorkerColumn 的 spec 守住：
//   - 本 spec：菜单本身（定位 / 视口钳制 / 派发 / 三种关闭 / 监听清理）；
//   - 消费方 spec：`@contextmenu.prevent` 真的落到了 BatchCard 根 div 上、且没有引入
//     包裹层（BatchCardDndFootprint.spec.ts 守不变式）。
//
// 覆盖：
//   - C1：open(evt, batch) → 菜单渲染出来，left/top 等于传入坐标；
//   - C2：贴右下角的坐标被钳制回视口内（不出屏）；
//   - C3：点菜单项 → emit('recall', **同一个 batch 实例**) 且菜单先关闭；
//   - C4：Escape 关闭；C5：点菜单外部关闭；点菜单内部不关；
//   - C6：unmount 后 document 上的监听已移除（removeEventListener 断言）；
//   - C7：dumb 契约 —— 组件不认识 api / store（零 props、零权限判断）。
//
// 测试策略：
//   - 挂**真** el-menu / el-menu-item：菜单项的点击 → `select` 派发链是 EP 内部实现
//     （menu-item → inject menu → rootMenu.handleClick），换成 stub 用例就恒绿、
//     什么也守不住；happy-dom 下不涉及浮层，不需要 teleport 之外的任何 mock。
//   - 组件用 expose 出来的 open() 驱动（与线上一致：Board 的 opener 调它），不构造
//     MouseEvent 之外的任何耦合。
//   - 不用 vi.mock('element-plus')：本组件只用 el-menu / el-menu-item 两个渲染组件，
//     不碰 ElMessage / ElMessageBox，真实组件在 happy-dom 下可正常挂载。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ElMenu, ElMenuItem } from 'element-plus';
import BatchContextMenu from '../BatchContextMenu.vue';
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

interface MenuExpose {
  open: (evt: MouseEvent, batch: BatchCardModel) => void;
}

/** 挂菜单组件（挂在 document 上，teleport 的目标就是 body）。 */
function mountMenu(): VueWrapper {
  return mount(BatchContextMenu, {
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

describe('BatchContextMenu（2026-10-06 右键召回菜单）', () => {
  it('C1：open 后菜单渲染出来，left/top 等于传入坐标', async () => {
    wrapper = mountMenu();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(240, 180), makeCard());
    await nextTick();

    const box = menuBox(wrapper);
    expect(box.style.left).toBe('240px');
    expect(box.style.top).toBe('180px');
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
    // 钳制量是估算值（160×120），只断言「不越界且为正」
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(window.innerWidth);
    expect(top).toBeLessThanOrEqual(window.innerHeight);
    expect(box.style.left).not.toBe('10000px');
    expect(box.style.top).not.toBe('10000px');
  });

  it('C3：点菜单项 → emit(recall, 同一个 batch 实例)，且菜单先关闭', async () => {
    wrapper = mountMenu();
    const batch = makeCard();
    (wrapper.vm as unknown as MenuExpose).open(contextEvent(100, 100), batch);
    await nextTick();

    const item = document.querySelector<HTMLElement>('.el-menu-item');
    expect(item).not.toBeNull();
    item!.click();
    await nextTick();

    const emitted = wrapper.emitted('recall');
    expect(emitted).toHaveLength(1);
    // 同一实例：消费方（useBatchRecall）要的是卡片自带的 batch_id / version
    expect(emitted![0]![0]).toBe(batch);
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

  it('C7：dumb 契约 —— 零 props（目标批次只走 expose 的 open 入参）', () => {
    wrapper = mountMenu();
    const def = (wrapper.vm.$options as unknown as { props?: unknown }).props ?? {};
    // script setup 未声明任何 props ⇒ 组件 options 上没有 props 定义
    expect(def).toEqual({});
  });
});
