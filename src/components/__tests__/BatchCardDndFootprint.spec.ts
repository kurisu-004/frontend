// @vitest-environment happy-dom
// src/components/__tests__/BatchCardDndFootprint.spec.ts
//
// 2026-10-04 新增：BatchCard 的 **DOM footprint 契约** —— Sortable 的可拖元素必须
// 等于该 vnode 的 DOM footprint，否则每次投放都会在源容器里留下一个 Vue 已经不认识、
// 也删不掉的幻影节点（卡片停在原位、刷新浏览器才恢复）。
//
// 硬不变式：**投放容器内一个可拖项的 DOM footprint 只能有一个元素**（卡片组件的根必须
// 是单元素）。推演：Sortable 只搬 `evt.item` 这一个节点；组件根若是 Fragment（多根
// vnode），Vue 会在根两侧插锚点、锚点跟着留在源容器而卡片元素被搬走，随后按
// `from.insertBefore(item, from.children[oldIndex])` 放回时元素序列已位移，卡片被插到
// **自己那对锚点范围之外**；refetch 卸载该 vnode 走 `removeFragment()`，只删锚点、够不到
// 卡片 ⇒ 幻影逐次累积。组件根是单元素时 vnode.el 就是那张卡，`remove()` 一次摘干净。
//
// 覆盖：
//   - D1（幻影守卫，核心）：复刻线上时序 —— 搬进目标容器 → restoreNodeToSource 按原下标
//         放回 → 数据更新为只剩第二张卡 → 断言容器里只剩第二张卡这一张。
//   - D2（不变式守卫）：容器的**元素**子节点数恒等于卡片数 ⇒ 每张卡的根就是容器的
//         唯一元素子节点，中间没有包裹层。
//   - D3：tooltip 触发区是根内的卡面（.card-body 包住全部 4 行）⇒ 触发区不塌成 0 高度、
//         tooltip 有东西可挂。
//   - D4：勾选角标仍是根的直接子元素（绝对定位的定位上下文是根，不是触发区）。
//
// 测试策略：
//   - 必须挂**真** el-tooltip：Fragment 锚点与 Teleport 占位注释都来自 EP 内部实现，
//     换成 stub 就没有锚点、用例恒绿，也就守不住任何东西。happy-dom 下只渲染、
//     不 hover，ElTooltipContent 的 popper 实例不会被创建。
//   - 宿主组件用 h() 渲染（vitest 走 vue runtime 构建，运行时 template 编译不可用）；
//     容器 div 模拟 Sortable 容器，卡片以 batch_id 为 key（与三个消费方一致）。
//   - 回滚动作直接调 `dndSourceTracker.restoreNodeToSource`（二参形态的 WorkerColumn /
//     PoolDrawer 挂的就是它），不在用例里复刻一份 insertBefore 语义。

import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { ElCheckbox, ElTooltip } from 'element-plus';
import BatchCard from '../BatchCard.vue';
import type { BatchCardModel } from '@/types/batchCard';
import { restoreNodeToSource } from '@/utils/dndSourceTracker';

function makeBatch(batchId: string, overrides: Partial<BatchCardModel> = {}): BatchCardModel {
  return {
    batch_id: batchId,
    part_id: '4000000000001',
    batch_no: `B${batchId.slice(-4)}`,
    part_name: '连杆',
    drawing_no: 'DRW-1',
    serial_no: `SN-${batchId.slice(-4)}`,
    quantity: 12,
    system_delivery_date: '2026-10-20',
    planned_delivery_date: null,
    is_urgent: false,
    has_cnc_program: false,
    customer_l1: '某某集团',
    customer_l2: null,
    applicant_name: '张三',
    note: null,
    location: 'SH-A01',
    shelf_id: '5000000000001',
    ...overrides,
  };
}

const CARD_A = makeBatch('3000000000001');
const CARD_B = makeBatch('3000000000002');
const CARD_C = makeBatch('3000000000003');

/** 模拟一个 Sortable 投放容器：直接子元素只有 v-for 出来的卡片（与三个消费方同构）。 */
const Host = defineComponent({
  components: { BatchCard },
  props: { selectable: { type: Boolean, default: false } },
  setup() {
    const batches = ref<BatchCardModel[]>([CARD_A, CARD_B]);
    return { batches };
  },
  render() {
    return h(
      'div',
      { class: 'container' },
      this.batches.map((b) =>
        h(BatchCard, { key: b.batch_id, batch: b, selectable: this.selectable }),
      ),
    );
  },
});

/** 挂宿主并把初始数据设成 cards（返回的 wrapper.vm.batches 即容器的渲染源）。 */
async function mountHost(cards: BatchCardModel[] = [CARD_A, CARD_B], selectable = false) {
  const wrapper = mount(Host, {
    props: { selectable },
    // 真 EP 组件：Fragment 锚点 / Teleport 占位注释都来自它们，stub 掉就守不住任何东西
    global: { components: { ElCheckbox, ElTooltip } },
    // 挂到 document 上：装载点与投放目标节点同属一个文档，行为更接近线上
    attachTo: document.body,
  });
  wrapper.vm.batches = cards;
  await nextTick();
  return wrapper;
}

describe('BatchCard 的 Sortable DOM footprint（2026-10-04）', () => {
  it('D1：Sortable 搬运 + 放回后，Vue 卸载该卡能真删掉 DOM（无幻影残留）', async () => {
    const wrapper = await mountHost();
    const container = wrapper.element as HTMLElement;
    const node = container.querySelector('.batch-card') as HTMLElement;
    expect(node.dataset.batchId).toBe(CARD_A.batch_id);

    // ① Sortable 拖拽：把被拖节点物理搬进目标容器（此时它已不在源容器里）
    const target = document.createElement('div');
    target.appendChild(node);

    // ② 投放后放回：库内建 onRemove / 本仓 restoreNodeToSource 的同一条语义
    //    （from.children[oldIndex] 按元素计数，卡片已被摘走 ⇒ 元素序列已位移）
    restoreNodeToSource({ item: node, from: container, oldIndex: 0 });

    // ③ refetch 带回新数据：源集合里已无这张卡（后端写成功的正常路径）
    wrapper.vm.batches = [CARD_B];
    await nextTick();

    const left = container.querySelectorAll<HTMLElement>('.batch-card');
    expect(left).toHaveLength(1);
    expect(left[0]?.dataset.batchId).toBe(CARD_B.batch_id);

    wrapper.unmount();
  });

  it('D2：容器里每张卡只占一个节点（元素数 = 卡片数，且没有文本 / 注释兄弟）', async () => {
    const wrapper = await mountHost([CARD_A, CARD_B, CARD_C]);
    const container = wrapper.element as HTMLElement;
    // children 只数元素（不含 Fragment 锚点 / Teleport 占位注释）⇒ 任何包裹层都会
    // 让这个数大于卡片数。
    expect(container.children).toHaveLength(3);
    for (const child of Array.from(container.children)) {
      expect(child.matches('.batch-card')).toBe(true);
    }
    // 锚点 / 注释级的兄弟节点同样会让「Sortable 搬走的元素」与「vnode 的 footprint」
    // 对不上（dev 构建保留模板注释，一个根上方的顶层注释就够让组件变成多根）⇒
    // 节点总数必须与元素数相等。
    expect(container.childNodes).toHaveLength(3);
    wrapper.unmount();
  });

  it('D3：tooltip 触发区是根内的卡面（.card-body 包住全部 4 行）', async () => {
    // 触发区塌成 0 高度 tooltip 就永不出现；96px 的高度预算是按「根 = 边框 + 卡面」
    // 算的，所以 .card-body 必须吃满根的可用高度、4 行都在它里面。
    const wrapper = await mountHost([CARD_A]);
    const root = wrapper.element.querySelector('.batch-card') as HTMLElement;
    const body = root.querySelector('.card-body') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.querySelectorAll('.row')).toHaveLength(4);
    // 触发区挂在 tooltip 上：根的默认 slot 只有一个子节点 = .card-body
    expect(root.children).toHaveLength(1);
    expect(root.firstElementChild).toBe(body);
    wrapper.unmount();
  });

  it('D4：勾选角标仍是根的直接子元素（绝对定位的定位上下文是根）', async () => {
    const wrapper = await mountHost([CARD_A], true);
    const root = wrapper.element.querySelector('.batch-card') as HTMLElement;
    // 可选卡片上根有 2 个元素子节点：勾选角标 + 触发区
    expect(root.children).toHaveLength(2);
    expect(root.querySelector(':scope > .card-check')).not.toBeNull();
    expect(root.querySelector(':scope > .card-body')).not.toBeNull();
    wrapper.unmount();
  });
});
