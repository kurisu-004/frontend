// @vitest-environment happy-dom
// src/composables/__tests__/useIsActive.spec.ts
//
// 2026-10-22 新增：`useIsActive`（keep-alive 活跃标志）的行为守卫。
//
// 它是三条修复共用的底座，而它们全部是**静默**的：
//   1. 列表页 `refetchInterval`（待品检 / 账号 / 送货单 / 待编程）—— 后台标签页每 5 分钟
//      打一次请求（`refetchIntervalInBackground: true` 管的是浏览器窗口失焦，与 Vue 的
//      keep-alive 无关）；
//   2. `document` 级 keydown（`usePartInlineEdit` / `useOutsourceSentPartsPage`）—— 在别的
//      标签页敲 Enter 会把用户没在看的那一行存了；
//   3. 隐藏 iframe 打印（`utils/iframePrint.ts` 自带一份同构的 active 标志，因为它是
//      纯 utils、不能反过来 import 本文件所在的 composables 之外的东西）。
//
// 所以本 spec 守的是**判据本身**：把 `isActive` 摘掉 / 改成常 true，上面三条都会当场
// 静默退化，而它们各自的 spec 都不一定拦得住（见 keepAliveContract.spec.ts 的漂移守卫）。
//
// `onDeactivated` 用**真 `<KeepAlive>` + 切 `<component :is>`** 触发，不手调 composable
// 返回值冒充生命周期 —— 手调只能证明「标志能翻」，证明不了「deactivate 真的会翻」。

import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useIsActive } from '@/composables/useIsActive';

const bridge = {
  isActive: null as Readonly<Ref<boolean>> | null,
  show: null as ((v: boolean) => void) | null,
};

const Subject = defineComponent({
  name: 'IsActiveSubject',
  setup() {
    bridge.isActive = useIsActive();
    return () => h('div', 'subject');
  },
});

const Other = defineComponent({ name: 'OtherPage', render: () => h('div', 'other') });

const Host = defineComponent({
  setup() {
    const showing = ref(true);
    bridge.show = (v: boolean) => {
      showing.value = v;
    };
    return () => h(KeepAlive, null, { default: () => h(showing.value ? Subject : Other) });
  },
});

const mounted: VueWrapper[] = [];
function mountHost(): VueWrapper {
  const w = mount(Host);
  mounted.push(w);
  return w;
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
});

describe('useIsActive', () => {
  it('A1：初次挂载即 true（不在 KeepAlive 下也恒 true ⇒ 非缓存页行为不变）', () => {
    mountHost();
    expect(bridge.isActive!.value).toBe(true);
  });

  it('A2：切到别的页面 ⇒ false；切回来 ⇒ true', async () => {
    mountHost();

    bridge.show!(false);
    await nextTick();
    expect(bridge.isActive!.value, 'deactivate 必须翻成 false').toBe(false);

    bridge.show!(true);
    await nextTick();
    expect(bridge.isActive!.value, 'activate 必须翻回 true').toBe(true);
  });

  it('A3：反复切页不累积 / 不漂移（缓存页会被切很多次）', async () => {
    mountHost();
    for (let i = 0; i < 5; i += 1) {
      bridge.show!(false);
      await nextTick();
      expect(bridge.isActive!.value).toBe(false);
      bridge.show!(true);
      await nextTick();
      expect(bridge.isActive!.value).toBe(true);
    }
  });

  it('A4：⚠️ 没有 KeepAlive 的宿主 ⇒ 恒 true（不做任何 keep-alive 语义的页零影响）', () => {
    // 这一条是「初值必须是 true」的守卫：改成 false 的话，所有没进缓存名单的页面
    // （例如待编程一览）的轮询与键盘监听会**立刻全部失效**，且没有任何报错。
    const Plain = defineComponent({
      setup() {
        bridge.isActive = useIsActive();
        return () => h('div');
      },
    });
    mounted.push(mount(Plain));
    expect(bridge.isActive!.value).toBe(true);
  });
});
