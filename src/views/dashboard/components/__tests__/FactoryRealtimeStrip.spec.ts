// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/FactoryRealtimeStrip.spec.ts
//
// 「工厂实时态」chip strip 渲染契约。组件零网络请求、零 useQuery（items 走 props
// 传入），故测试不需要 QueryClient / VueQueryPlugin。
//
// 覆盖：
//   - R1：chip 文本 = `序列号(批次量)`（件数用弱一档的 .worker-qty 小字）；
//   - R2：chip 的 :key 用 batch_id（t_part 无唯一约束，同一工单多批次会产生多行），
//     batch_id 缺失时回退 part id；
//   - R3：chip title 带「N 件」；
//   - R4：按 current_holder_id / worker_name 分组渲染，组头出工人姓名；
//   - R5：canOpenDetail=false → 不可点、不 emit itemClick；true → 点击 emit partId；
//   - R6：urgent chip 红底、序列号缺失时渲染「—」；
//   - R7：groups > PAGE_SIZE 时进 el-carousel（轮播分支也用 batch_id 做 key）。
//
// 组件里 el-carousel / el-icon 是模板内未解析组件（vitest.config.ts 只有 vue() 插件、
// 没有 unplugin-vue-components），故在 global.components 里显式注册替身。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import FactoryRealtimeStrip from '../FactoryRealtimeStrip.vue';
import type { WorkerHeldBatchData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

/** el-icon 替身：只当 slot 载体。 */
const ElIconStub = {
  name: 'ElIcon',
  template: '<i class="mock-icon"><slot /></i>',
};

/** el-carousel / el-carousel-item 替身：按 slot 直出，不模拟动画。
 *  el-carousel-item 只渲染「当前页」无法在无布局环境下判定，故全部直出 ——
 *  本 spec 只关心「走的是轮播分支」与每页内的 chip key。 */
const ElCarouselStub = {
  name: 'ElCarousel',
  template: '<div class="mock-carousel"><slot /></div>',
};
const ElCarouselItemStub = {
  name: 'ElCarouselItem',
  template: '<div class="mock-carousel-item"><slot /></div>',
};

const globalConfig = {
  components: {
    'el-icon': ElIconStub,
    'el-carousel': ElCarouselStub,
    'el-carousel-item': ElCarouselItemStub,
  },
};

function makeItem(overrides: Partial<WorkerHeldBatchData> = {}): WorkerHeldBatchData {
  return {
    id: '180000000000001',
    batch_id: '190000000000001',
    serial_no: 'F1234',
    quantity: 20,
    is_urgent: false,
    current_holder_id: '170000000000001',
    worker_name: '张三',
    ...overrides,
  };
}

function mountStrip(items: WorkerHeldBatchData[], canOpenDetail = true) {
  return mount(FactoryRealtimeStrip, {
    props: { items, canOpenDetail },
    global: globalConfig,
  });
}

describe('FactoryRealtimeStrip — chip 文本与 key', () => {
  it('R1：chip 文本 = F1234(20)，件数走 .worker-qty 小字节点', () => {
    const wrapper = mountStrip([makeItem()]);
    const chip = wrapper.find('.worker-chip');

    expect(chip.exists()).toBe(true);
    expect(chip.text()).toBe('F1234(20)');
    // 序列号是视觉主体，件数是补白：两个独立节点便于样式分层。
    expect(chip.find('.worker-serial').text()).toBe('F1234');
    expect(chip.find('.worker-qty').text()).toBe('(20)');
    wrapper.unmount();
  });

  it('R2：:key 用 batch_id —— 同一工单两个批次渲染出两个 chip（part_id 相同）', () => {
    // 这是本用例的核心：t_part 无唯一约束，同一工单的多个 IN_PROCESS 批次会产生
    // 多行。只用 part_id 做 key 时 Vue 拿到重复 key（patch 错行 / 复用错 chip）。
    const wrapper = mountStrip([
      makeItem({ id: '180000000000001', batch_id: '190000000000001', quantity: 20 }),
      makeItem({ id: '180000000000001', batch_id: '190000000000002', quantity: 5 }),
    ]);

    const chips = wrapper.findAll('.worker-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.text()).toBe('F1234(20)');
    expect(chips[1]?.text()).toBe('F1234(5)');
    // 同一个工人分组（current_holder_id 相同）下并存两条。
    expect(wrapper.findAll('.worker-group')).toHaveLength(1);
    wrapper.unmount();
  });

  it('R2b：batch_id 为 null 时 :key 回退 part id（不产生 undefined key）', () => {
    const wrapper = mountStrip([
      makeItem({ id: '180000000000001', batch_id: null, serial_no: 'F0001' }),
      makeItem({ id: '180000000000002', batch_id: null, serial_no: 'F0002' }),
    ]);

    const chips = wrapper.findAll('.worker-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.text()).toBe('F0001(20)');
    expect(chips[1]?.text()).toBe('F0002(20)');
    wrapper.unmount();
  });

  it('R3：chip title 显式带「N 件」', () => {
    const wrapper = mountStrip([makeItem({ quantity: 37 })]);
    expect(wrapper.find('.worker-chip').attributes('title')).toBe('F1234 · 37 件');
    wrapper.unmount();
  });

  it('R4：按 current_holder_id / worker_name 分组，组头出工人姓名', () => {
    const wrapper = mountStrip([
      makeItem({ id: '1', batch_id: 'b1', current_holder_id: '1700...1', worker_name: '张三' }),
      makeItem({ id: '2', batch_id: 'b2', current_holder_id: '1700...1', worker_name: '张三' }),
      makeItem({ id: '3', batch_id: 'b3', current_holder_id: '1700...2', worker_name: '李四' }),
    ]);

    const groups = wrapper.findAll('.worker-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.find('.worker-name').text()).toBe('张三');
    expect(groups[0]?.findAll('.worker-chip')).toHaveLength(2);
    expect(groups[1]?.find('.worker-name').text()).toBe('李四');
    expect(groups[1]?.findAll('.worker-chip')).toHaveLength(1);
    // 头部件数按 items.length（工人在手加工批次数）
    expect(wrapper.find('.strip-count').text()).toBe('3 件');
    wrapper.unmount();
  });

  it('R5：canOpenDetail 门控 —— false 不 emit，true 发 partId', async () => {
    const locked = mountStrip([makeItem()], false);
    await locked.find('.worker-chip').trigger('click');
    expect(locked.emitted('itemClick')).toBeFalsy();
    expect(locked.find('.worker-chip').classes()).not.toContain('clickable');
    locked.unmount();

    const unlocked = mountStrip([makeItem()], true);
    await unlocked.find('.worker-chip').trigger('click');
    // 跳详情路由按工单 id（batch_id 只做 key，不做跳转目标）
    expect(unlocked.emitted('itemClick')?.[0]).toEqual(['180000000000001']);
    expect(unlocked.find('.worker-chip').classes()).toContain('clickable');
    unlocked.unmount();
  });

  it('R6：urgent 红底 + 序列号缺失渲染「—」', () => {
    const wrapper = mountStrip([makeItem({ is_urgent: true, serial_no: null, quantity: 3 })]);
    const chip = wrapper.find('.worker-chip');
    expect(chip.classes()).toContain('urgent');
    expect(chip.text()).toBe('—(3)');
    expect(chip.attributes('title')).toBe('未编号 · 3 件');
    wrapper.unmount();
  });

  it('R7：空态文案 + 轮播分支（groups > 4）', () => {
    const empty = mountStrip([]);
    expect(empty.find('.strip-empty').text()).toBe('暂无正在加工的零件');
    expect(empty.find('.mock-carousel').exists()).toBe(false);
    empty.unmount();

    // 5 个工人组 ⇒ 走 el-carousel 轮播分支（PAGE_SIZE = 4）
    const many = mountStrip(
      Array.from({ length: 5 }, (_, i) =>
        makeItem({
          id: `${i}`,
          batch_id: `b${i}`,
          current_holder_id: `1700...${i}`,
          worker_name: `工人${i}`,
        }),
      ),
    );
    expect(many.find('.mock-carousel').exists()).toBe(true);
    // 轮播分支同样用 batch_id 做 key：5 组各 1 行，chip 文本齐全。
    expect(many.findAll('.mock-carousel-item')).toHaveLength(2);
    expect(many.findAll('.worker-chip')).toHaveLength(5);
    expect(many.find('.worker-chip').text()).toBe('F1234(20)');
    many.unmount();
  });
});
