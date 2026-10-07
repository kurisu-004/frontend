// @vitest-environment happy-dom
// src/composables/__tests__/useBatchContextMenu.spec.ts
//
// 2026-10-09 新增：`showBatchContextMenu` 的固定传参与**打开串行化**的行为 spec。
//
// 为什么这类断言值得单列一个 spec：本文件是**全仓唯一**的批次右键菜单入口（生产队列三区
// + 外协两区共用），菜单项的派生矩阵分别由两个域内的纯函数 spec 覆盖
// （queueBatchMenuItems.spec / outsourceBatchMenuItems.spec）。本 spec 只守「菜单本体
// 这一层」的契约：
//   - M1：固定传参。每一项都是为了绕开某个具体问题（z-index 被 EP 弹层盖、滚轮滚的是
//     看板、Sortable 自动滚动误关菜单、库的全局键盘 capture 吃掉看板快捷键…）。这些
//     缺一个都不会报错，只会「看起来不对」，所以必须钉死。
//   - ★ E1：**打开必须串行化** —— `closeContextMenu()` 在 `showContextMenu()` 之前被调、
//     且两者之间隔着一个 `nextTick`。库复用同一个 body 级容器，上一个菜单的 after-leave
//     回调会 `render(null, container)` 把紧接着打开的新菜单一起抹掉（issue #123 未修）。
//     看板是逐卡右键的高频场景，不串行化就稳定复现「右键 A 再右键 B，第二次菜单不出现」。
//     这是本文件最要紧的一条：它锁的是**调用顺序**，不是最终 DOM。
//   - M2：坐标透传（x / y 直接取 clientX / clientY —— 库自己做视口钳制，本仓不重复做）。
//
// 测试策略：`@imengyu/vue3-context-menu` 整体 vi.mock 掉。理由：它的函数模式内部直接调
//   Vue 的 `render()` 挂一棵裸 vnode（不建 app 实例），要测出真实 DOM 就得把整个库的
//   挂载 / 过渡 / 互斥容器一起拖进 happy-dom —— 那是「测库」而不是「测我们的接线」。
//   我们这一层要守的恰恰只有「传给库什么、按什么顺序调」，mock 之后这两件事完全可断言。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MenuItem } from '@imengyu/vue3-context-menu';

const { closeMock, showMock } = vi.hoisted(() => ({
  closeMock: vi.fn(),
  showMock: vi.fn(),
}));

// ⚠️ 必须是 default import 的形状：库的整体导出就是那个带 showContextMenu 的全局实例
// （named export 的 ContextMenu 是组件、不是实例，拿到它调 showContextMenu 会报
// 「not a function」）。这里连 closeContextMenu 也一起挂在默认导出上。
vi.mock('@imengyu/vue3-context-menu', () => ({
  default: { showContextMenu: showMock, closeContextMenu: closeMock },
}));

import { showBatchContextMenu } from '../useBatchContextMenu';

const EVT = new MouseEvent('contextmenu', { clientX: 240, clientY: 180 });

const ITEMS: MenuItem[] = [
  { label: '召回到待下发', onClick: () => undefined },
  { label: '派给工人', children: [{ label: '张三' }] },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('showBatchContextMenu（批次右键菜单本体）', () => {
  it('M1：固定传参 —— 原生外观 + 盖得住 EP 弹层 + 不抢看板的滚轮 / 滚动 / 快捷键', async () => {
    await showBatchContextMenu(EVT, ITEMS);

    expect(showMock).toHaveBeenCalledTimes(1);
    expect(showMock).toHaveBeenCalledWith({
      // 坐标：库自己做视口钳制（adjustPosition 默认 true），本仓不重复钳制
      x: 240,
      y: 180,
      // 亮色主题在库里就叫 'default'（没有 'light' 这个名字）；零 CSS 覆盖 —— 不传
      // customClass、不写 --mx-menu-* 变量
      theme: 'default',
      // 库默认 100 < EP 弹层起点 2000 ⇒ 不覆盖会被 dialog / message-box 盖住
      zIndex: 3000,
      minWidth: 180,
      // 长二级菜单（工序 / 工人 / 外协公司都可能几十项）的滚动上限
      maxHeight: 420,
      // 默认 false ⇒ 滚轮滚的是看板（连带触发菜单关闭）而不是二级菜单
      mouseScroll: true,
      // 默认 true ⇒ Sortable 拖到边缘自动滚动会误关菜单
      closeWhenScroll: false,
      // 默认 true ⇒ 库全局 capture 方向键 / Home / End / Enter 并 preventDefault，
      // 吃掉看板自己的快捷键
      keyboardControl: false,
      // 默认 200ms（切换已开二级时的等待）⇒ 0 = 全瞬开
      subMenuOpenDelay: 0,
      items: ITEMS,
    });
  });

  it('★ E1：先 closeContextMenu → 隔一个 nextTick → 再 showContextMenu（打开串行化）', async () => {
    // 回归守卫（库 issue #123 未修）：库复用同一个 body 级容器，上一个菜单的 after-leave
    // 会 `render(null, container)` 把紧接着挂上去的新菜单一起抹掉。表现是「右键 A 再
    // 右键 B，第二次菜单根本不出现」—— 逐卡右键的高频场景下这等于菜单不可用。
    const pending = showBatchContextMenu(EVT, ITEMS);

    // ① 调用当拍：close 已调，show 还没调（说明中间确实隔了一个 tick）
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(showMock).not.toHaveBeenCalled();

    // ② await 之后：show 才被调，且排在 close 之后
    await pending;
    expect(showMock).toHaveBeenCalledTimes(1);
    expect(closeMock.mock.invocationCallOrder[0]!).toBeLessThan(
      showMock.mock.invocationCallOrder[0]!,
    );
  });

  it('E1b：连续右键两张卡 —— 第二次仍是 close → tick → show（不会串成两个 show 竞态）', async () => {
    // 复刻线上时序：A 的菜单还开着就右键 B。若实现漏掉串行化，这里会看到两次 show
    // 之间没有 close，两棵 vnode 挂进同一个容器 ⇒ 后挂的被前一个的收尾抹掉。
    await showBatchContextMenu(EVT, ITEMS);
    await showBatchContextMenu(EVT, ITEMS);

    expect(closeMock).toHaveBeenCalledTimes(2);
    expect(showMock).toHaveBeenCalledTimes(2);
    for (const i of [0, 1]) {
      expect(closeMock.mock.invocationCallOrder[i]!).toBeLessThan(
        showMock.mock.invocationCallOrder[i]!,
      );
    }
  });

  it('M2：items 原样透传（含二级菜单的 children 结构），不加工不裁剪', async () => {
    const items: MenuItem[] = [
      { label: '发送到工序', children: [{ label: 'OP10 车削' }, { label: 'OP20 钻孔' }] },
    ];
    await showBatchContextMenu(EVT, items);
    expect(showMock.mock.calls[0]![0].items).toBe(items);
  });

  it('M3：菜单项的 onClick 由板级闭包持有 —— 本层不执行、不包 try/catch', async () => {
    // 本文件保持 dumb：它既不判权限也不执行动作。onClick 是板级派生函数里的闭包，
    // 由库在点击时调用；本层只负责把 items 递进去。
    const spy = vi.fn();
    const items: MenuItem[] = [{ label: '拆分批次', onClick: spy }];
    await showBatchContextMenu(EVT, items);
    expect(showMock.mock.calls[0]![0].items[0].onClick).toBe(spy);
    expect(spy).not.toHaveBeenCalled();
  });
});