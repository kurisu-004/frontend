// src/stores/__tests__/tagsView.setTitle.spec.ts
//
// 2026-10-10 新增：`setTitle`（动态 tab 标题）的回归守卫。
//
// 为什么要有：tab 文案的唯一来源 `meta.title` 是**编译期常量**，承载不了「按当前工单
// 显示流水号」这种数据到位后才有的值 —— 零件详情页每个工单开出来的 tab 全叫「零件详情」，
// 多开几个就分不清谁是谁。`setTitle` 覆盖单个**已存在**的 tab，配套钉住三条最容易退化
// 的行为：
//   1. 命中即落盘 —— `visitedViews` 按用户持久化在 localStorage 里，不落盘则刷新 / 重登
//      退回静态标题；
//   2. 不新建 tab —— 找不到就返回 false 且不动数组长度（凭空造 tab 会把「调用方寻址
//      写错」这个真 bug 变成一条看不懂的孤儿 tab）；
//   3. path / name 两种寻址都可用。
//
// 测试基础设施照同目录 `tagsView.spec.ts`：每个用例前重置 Pinia；store setup 路径不读
// localStorage（hydrate 只由 switchOwner 驱动），故无需注册 VueQueryPlugin。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useTagsViewStore, type TagView } from '../tagsView';

function makeView(overrides: Partial<TagView> = {}): TagView {
  return {
    path: '/p',
    fullPath: '/p',
    name: 'P',
    title: 'P',
    ...overrides,
  };
}

function attachPinia(): void {
  const pinia = createPinia();
  setActivePinia(pinia);
}

describe('useTagsViewStore.setTitle', () => {
  beforeEach(() => {
    localStorage.clear();
    attachPinia();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('命中', () => {
    it('S1：按 path 命中 → 标题被改，返回 true，其余 tab 不受影响', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));
      tags.addView(makeView({ path: '/parts/1001', name: 'PartDetail', title: '零件详情' }));

      expect(tags.setTitle({ path: '/parts/1001' }, 'F1248-01')).toBe(true);

      expect(tags.visitedViews).toHaveLength(2);
      expect(tags.visitedViews[0].title).toBe('零件详情');
      expect(tags.visitedViews[1].title).toBe('F1248-01');
      // 同一个 path 的另一张 tab 没被顺带改（不是按 name 全量刷）
      expect(tags.visitedViews[0].path).toBe('/parts/1000');
    });

    it('S2：按 name 命中（调用方只知道路由名时）→ 改掉第一处匹配的 tab，返回 true', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));
      tags.addView(makeView({ path: '/parts/1001', name: 'PartDetail', title: '零件详情' }));

      expect(tags.setTitle({ name: 'PartDetail' }, 'F1000')).toBe(true);
      expect(tags.visitedViews[0].title).toBe('F1000');
      expect(tags.visitedViews[1].title).toBe('零件详情');
    });

    it('S3：path 与 name 都给时 path 优先（path 找不中才退回 name）', () => {
      const tags = useTagsViewStore();
      tags.addView(
        makeView({ path: '/assemblies/9', name: 'AssemblyDetail', title: '装配件详情' }),
      );

      // path 命中 → 用 path 找到的那一张，不退回 name 匹配
      expect(tags.setTitle({ path: '/assemblies/9', name: 'PartDetail' }, 'ASM-9')).toBe(true);
      expect(tags.visitedViews[0].title).toBe('ASM-9');
    });

    it('S4：path 写错时退回 name 命中', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));

      expect(tags.setTitle({ path: '/parts/不存在', name: 'PartDetail' }, 'F1000')).toBe(true);
      expect(tags.visitedViews[0].title).toBe('F1000');
    });
  });

  describe('未命中：不新建 tab', () => {
    it('S5：path 找不到 → 返回 false，visitedViews 长度与内容都不动', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));
      const before = tags.visitedViews.map((v) => ({ ...v }));

      expect(tags.setTitle({ path: '/parts/不存在' }, 'X')).toBe(false);

      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews.map((v) => ({ ...v }))).toEqual(before);
      expect(tags.visitedViews[0].title).toBe('零件详情');
    });

    it('S6：name 找不到 → 返回 false，不新建 tab', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));

      expect(tags.setTitle({ name: 'DeliveryNoteDetail' }, '送货单')).toBe(false);
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.cachedViewNames).toEqual(['PartDetail']);
    });

    it('S7：path / name 都不给（都是空串）→ 返回 false 且不新建', () => {
      const tags = useTagsViewStore();
      expect(tags.setTitle({}, 'X')).toBe(false);
      expect(tags.setTitle({ path: '', name: '' }, 'X')).toBe(false);
      expect(tags.visitedViews).toHaveLength(0);
    });
  });

  describe('持久化', () => {
    it('S8：命中即同步落盘（不经微任务 —— 刷新 / 重登不能退回静态标题）', () => {
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));

      tags.setTitle({ path: '/parts/1000' }, 'F1000');

      // 同步读取：store 内部那条 deep watch 是 flush:'pre'（微任务），这里刻意不等它
      const raw = localStorage.getItem('myerp.tags_view.u1');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw ?? '{}').visitedViews[0].title).toBe('F1000');
    });

    it('S9：未命中不写盘（ownerId 已存在时也不该产生一次无谓落盘）', () => {
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      const spy = vi.spyOn(Storage.prototype, 'setItem');

      expect(tags.setTitle({ path: '/parts/不存在' }, 'X')).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it('S10：切 owner 后新标题仍在（跨会话 hydrate 还原）', () => {
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));
      tags.setTitle({ path: '/parts/1000' }, 'F1000');

      // 换账号：u1 的存档留在自己的 key 里，u2 看不到
      tags.switchOwner('u2');
      expect(tags.visitedViews).toHaveLength(0);
      tags.switchOwner('u1');
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].title).toBe('F1000');
    });
  });

  describe('与 addView 的共存', () => {
    it(
      'S11：再次 addView 同 path（路由 afterEach 重登记）会把标题刷回 meta.title，' +
        '调用方随后再 setTitle 即可恢复动态值',
      () => {
        const tags = useTagsViewStore();
        tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));
        tags.setTitle({ path: '/parts/1000' }, 'F1000');
        expect(tags.visitedViews[0].title).toBe('F1000');

        // 切走再切回同一 tab：afterEach 再登记一次，addView 的「同 path 更新 title」分支
        // 按 meta.title 覆写（这是既有行为，不改）—— 页面侧的响应式派生随后补回动态值。
        tags.addView(makeView({ path: '/parts/1000', name: 'PartDetail', title: '零件详情' }));
        expect(tags.visitedViews).toHaveLength(1);
        expect(tags.visitedViews[0].title).toBe('零件详情');

        expect(tags.setTitle({ path: '/parts/1000' }, 'F1000')).toBe(true);
        expect(tags.visitedViews[0].title).toBe('F1000');
      },
    );
  });
});
