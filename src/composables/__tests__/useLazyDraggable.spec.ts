import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick, ref } from 'vue';

// vi.mock 会被提升到 import 之上，工厂里不能引用普通 const（TDZ），必须用 vi.hoisted。
const { startSpy, destroySpy, capturedOptions } = vi.hoisted(() => ({
  startSpy: vi.fn(),
  destroySpy: vi.fn(),
  capturedOptions: [] as Record<string, unknown>[],
}));

vi.mock('vue-draggable-plus', () => ({
  useDraggable: (_el: unknown, _list: unknown, options: Record<string, unknown>) => {
    capturedOptions.push(options);
    return {
      start: startSpy,
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: destroySpy,
      option: vi.fn(),
      save: vi.fn(),
      toArray: vi.fn(),
      closest: vi.fn(),
    };
  },
}));

import { useLazyDraggable } from '../useLazyDraggable';

beforeEach(() => {
  startSpy.mockClear();
  destroySpy.mockClear();
  capturedOptions.length = 0;
});

describe('useLazyDraggable', () => {
  it('强制 immediate: false，即使调用方传了 true 也覆写，其余选项原样透传', () => {
    useLazyDraggable(ref<HTMLElement | null>(null), ref<number[]>([]), {
      group: 'work-orders',
      animation: 150,
      immediate: true,
    });
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).toMatchObject({
      group: 'work-orders',
      animation: 150,
      immediate: false,
    });
  });

  it('elRef 为 null 时不调 start()（回归守卫：此前会 new Sortable(null) 抛错）', async () => {
    useLazyDraggable(ref<HTMLElement | null>(null), ref<number[]>([]));
    await nextTick();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('elRef 由 null 转非 null 后自动 start(el)', async () => {
    const elRef = ref<HTMLElement | null>(null);
    useLazyDraggable(elRef, ref<number[]>([]));
    await nextTick();
    expect(startSpy).not.toHaveBeenCalled();

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 测试 stub：HTMLElement 在 node 环境无 DOM
    const el = {} as HTMLElement;
    elRef.value = el;
    await nextTick();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(el);
  });

  it('elRef 换成新节点时重绑（覆盖 el-dialog destroy-on-close 重建 tbody 的场景）', async () => {
    const elRef = ref<HTMLElement | null>(null);
    useLazyDraggable(elRef, ref<number[]>([]));

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 测试 stub
    const first = {} as HTMLElement;
    elRef.value = first;
    await nextTick();

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 测试 stub
    const second = {} as HTMLElement;
    elRef.value = second;
    await nextTick();

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(startSpy).toHaveBeenLastCalledWith(second);
  });

  it('elRef 被置回 null 时不调 start()', async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 测试 stub
    const elRef = ref<HTMLElement | null>({} as HTMLElement);
    useLazyDraggable(elRef, ref<number[]>([]));
    await nextTick();
    startSpy.mockClear();

    elRef.value = null;
    await nextTick();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('elRef 被置回 null 时 destroy()（容器卸载 ⇒ 旧 Sortable 实例必须释放）', async () => {
    // 回归 guard：容器在 v-if 分支内被卸载时，组件本身往往还活着 ⇒ useDraggable 内部
    // 挂在组件上的 onBeforeUnmount(destroy) 不会跑。没有这里的 else 分支，旧实例与
    // 已脱离文档的节点会被组件闭包一直持有。
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 测试 stub
    const elRef = ref<HTMLElement | null>({} as HTMLElement);
    useLazyDraggable(elRef, ref<number[]>([]));
    await nextTick();
    expect(destroySpy).not.toHaveBeenCalled();

    elRef.value = null;
    await nextTick();
    expect(destroySpy).toHaveBeenCalledTimes(1);
    // 重建（v-if 切回 / el-dialog 重新打开）仍走 start()，重绑语义不变
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 测试 stub
    const reopened = {} as HTMLElement;
    elRef.value = reopened;
    await nextTick();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(reopened);
  });
});
