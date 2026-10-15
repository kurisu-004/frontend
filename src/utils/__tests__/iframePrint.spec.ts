// @vitest-environment happy-dom
// src/utils/__tests__/iframePrint.spec.ts
//
// 2026-10-22 新增：`useIframePrint`（隐藏 iframe + blob URL 打印）的行为守卫。
//
// ⚠️ **I2 是本 spec 存在的理由**，它守的是一个现场复现过、而 typecheck / lint 全绿的
// 缺陷：用户在零件一览批量打印图纸 → 关掉原生打印窗 → **不关标签页** → 切去别的页面
// → 切回来 ⇒ **打印窗口自己又弹一次**。四步根因（见 iframePrint.ts 文件头）：
//   1. MainLayout 的 `<keep-alive :include>` 缓存了 `PartsList` / `PartDetail` /
//      `AssemblyDetail` 三页（路由名都等于组件文件名）；
//   2. Vue 3 的 `<KeepAlive>` 把缓存页整棵 DOM 子树 `move()` 进一个**游离的**
//      `storageContainer`（`createElement("div")`，从不 append 到 document）；
//   3. `<iframe>` 被移出文档 = 卸载 browsing context，**重新插回时浏览器会再次导航到
//      `src`** ⇒ `load` 第二次触发；
//   4. 改前两处打印都是 `iframe.onload = () => { ...; print() }` 且**永不解绑**。
//
// ⚠️ **happy-dom 不实现「iframe 脱离文档后重载」这条语义**，所以本 spec 测不到第 3 环
// 本身 —— 它测的是 helper 的**应对**是否到位：`onload` 一次性（I2）、deactivate 拆解
// （I3）、在途作废（I4）。第 3 环是浏览器行为、无需测试；**第 4 环是代码，必须守**。
//
// 「第二次 load」的模拟方式：直接**再调一次同一个 handler 闭包**（真实浏览器里 iframe
// 重载会派发同一个 `onload` 函数对象）。这比任何 mock 都更接近现场，也不会因为
// happy-dom 的 iframe 实现细节而给出假绿。
//
// 依赖处理：
// - `ElMessage` 桩成 no-op（真实 ElMessage 在测试环境会拿 document 渲染并污染输出）；
// - `URL.createObjectURL` / `revokeObjectURL` 在 happy-dom 下不可靠，直接打桩计数；
// - iframe 用**假对象**（只被读 `src` / `onload` / `contentWindow` 三样），不依赖
//   happy-dom 的 iframe 实现；
// - `onDeactivated` 用**真 `<KeepAlive>` + 切 `<component :is>`** 触发，不手调 composable
//   返回值去冒充生命周期 —— 手调只能证明「release 能拆」，证明不了「deactivate 真的会
//   调到 release」，而后者正是改前漏掉的那一环。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useIframePrint } from '@/utils/iframePrint';

// `vi.mock` 的工厂会被提升到文件顶部，不能引用后声明的 const ⇒ 桩对象走 vi.hoisted。
const ElMessageMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));

vi.mock('element-plus', () => ({ ElMessage: ElMessageMock }));

interface FakeIframe {
  src: string;
  onload: (() => void) | null;
  contentWindow: { focus: ReturnType<typeof vi.fn>; print: ReturnType<typeof vi.fn> };
}

function makeFakeIframe(): FakeIframe {
  return { src: '', onload: null, contentWindow: { focus: vi.fn(), print: vi.fn() } };
}

/** 每次用例重置的桥：宿主组件把 printBlob / release 挂上来，测试直接操作。 */
const bridge = {
  iframe: null as FakeIframe | null,
  printBlob: null as ((blob: Blob) => boolean) | null,
  release: null as (() => void) | null,
  show: null as ((v: boolean) => void) | null,
};

const Subject = defineComponent({
  name: 'PrintSubject',
  setup() {
    // 假 iframe 结构上不是真的 HTMLIFrameElement（它只被读 src / onload / contentWindow
    // 三样），转换点收在这里一处。
    const iframeRef = ref<HTMLIFrameElement | null>(
      bridge.iframe as unknown as HTMLIFrameElement | null,
    );
    const api = useIframePrint(iframeRef);
    bridge.printBlob = api.printBlob;
    bridge.release = api.release;
    return () => h('div', 'subject');
  },
});

const Other = defineComponent({
  name: 'OtherPage',
  render: () => h('div', 'other'),
});

const Host = defineComponent({
  setup() {
    const showing = ref(true);
    bridge.show = (v: boolean) => {
      showing.value = v;
    };
    // 真 <KeepAlive>：切换时 Subject 走 deactivate/activate，而不是卸载重挂。
    return () => h(KeepAlive, null, { default: () => h(showing.value ? Subject : Other) });
  },
});

let created = 0;
const revoked: string[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const mounted: VueWrapper[] = [];

function mountHost(): VueWrapper {
  const w = mount(Host);
  mounted.push(w);
  return w;
}

function blob(): Blob {
  return new Blob(['pdf'], { type: 'application/pdf' });
}

beforeEach(() => {
  created = 0;
  revoked.length = 0;
  bridge.iframe = makeFakeIframe();
  bridge.printBlob = null;
  bridge.release = null;
  ElMessageMock.error.mockClear();
  ElMessageMock.info.mockClear();
  URL.createObjectURL = vi.fn(() => `blob:fake/${++created}`);
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.push(u);
  });
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.restoreAllMocks();
});

describe('useIframePrint：一次打印只触发一次 print()', () => {
  it('I1：printBlob 后 load 落地 ⇒ focus + print 各调一次，src 指向 blob URL', () => {
    mountHost();
    const iframe = bridge.iframe!;

    expect(bridge.printBlob!(blob())).toBe(true);
    expect(iframe.src).toBe('blob:fake/1');
    expect(iframe.onload).toBeTypeOf('function');

    iframe.onload!();
    expect(iframe.contentWindow.print).toHaveBeenCalledTimes(1);
    expect(iframe.contentWindow.focus).toHaveBeenCalledTimes(1);
  });

  it('I2：⚠️ 同一个 onload 再触发两次（keep-alive 重插导致的第二次 load）⇒ 仍然只打印一次', () => {
    // 改前这里是红的：`iframe.onload` 永不解绑 ⇒ 切页回来 iframe 重载 → print 又跑一遍
    // ⇒ 用户看到「打印窗口自己又弹一次」。
    //
    // ⚠️ 断言方式要注意：这里**直接再调那个已被捕获的 handler 闭包**，而不是读
    // `iframe.onload` 属性来派发。浏览器派发时是现查属性，所以「置 null 就够了」在真
    // 浏览器里也成立；但那只是一种实现细节，handler 一旦被别处捕获就绕过去了。
    // helper 里那道闸写在 handler 体内（`settled` 旗标）正是为此，测试也就必须按
    // 「最坏情况」派发，否则这个 spec 会在改坏之后照样全绿。
    mountHost();
    const iframe = bridge.iframe!;

    bridge.printBlob!(blob());
    const firstOnload = iframe.onload!;

    // 第一次 load：打印
    firstOnload();
    expect(iframe.contentWindow.print).toHaveBeenCalledTimes(1);

    // iframe 被 keep-alive 移出文档又插回 → 浏览器对同一个 src 再次导航 → 同一个
    // handler 被再次派发。
    firstOnload();
    firstOnload();

    expect(iframe.contentWindow.print, '第二次 load 又打印了一次').toHaveBeenCalledTimes(1);
    expect(iframe.onload, 'handler 必须一次性自解绑').toBeNull();
  });
});

describe('useIframePrint：keep-alive deactivate 必须拆解打印宿主', () => {
  it('I3：切走标签页 ⇒ onload 解绑 + src 置 about:blank + blob 被 revoke', async () => {
    mountHost();
    const iframe = bridge.iframe!;

    bridge.printBlob!(blob());
    iframe.onload!();
    expect(iframe.contentWindow.print).toHaveBeenCalledTimes(1);

    // 切去别的页面：Subject 走 deactivate（不卸载）。
    bridge.show!(false);
    await nextTick();

    expect(iframe.onload, 'deactivate 后不得留着 onload').toBeNull();
    // 不置 about:blank 的话，重插时浏览器仍会重新导航到 blob URL —— 那份几十 MB 的
    // 合并 PDF 会被静默重载 + 重渲染一遍，且内存里的 PDF viewer 一直驻着。
    expect(iframe.src, 'deactivate 后不得留在 blob URL 上').toBe('about:blank');
    expect(revoked, '打印已落地的 blob 必须 revoke').toEqual(['blob:fake/1']);

    // 回来后 iframe 会真的再 load 一次（导航到 about:blank）⇒ 什么也不该发生。
    expect(iframe.contentWindow.print).toHaveBeenCalledTimes(1);
  });

  it('I4：打印已发起、load 还没落地时切走 ⇒ handler 作废 + 提示（切回来不再弹窗）', async () => {
    mountHost();
    const iframe = bridge.iframe!;

    bridge.printBlob!(blob());
    const lateOnload = iframe.onload!;

    bridge.show!(false);
    await nextTick();
    expect(ElMessageMock.info, '取消在途打印要让用户知道').toHaveBeenCalledTimes(1);

    // 迟到的那次 load 落地 ⇒ 不打印。
    lateOnload();
    expect(iframe.contentWindow.print, '已作废的打印不该弹窗').toHaveBeenCalledTimes(0);
  });

  it('I5：⚠️ 打印在途（用户点完就切走、网络才回来）⇒ 直接拒绝，零 blob URL、零 handler', async () => {
    // 这一支**不是** deactivate 能挡的，时序是反的：大图纸批量打印要跑几分钟，用户点完
    // 就切走 —— 此刻 `deactivate` 与 `release()` 都跑过了、什么 pending 都没有；网络
    // 回来后 `printBlob` 才挂上 handler，而用户什么时候切回来不由我们决定。
    // 改前没有这一支时：切回来照样弹窗抢焦点。
    mountHost();
    const iframe = bridge.iframe!;

    bridge.show!(false);
    await nextTick();

    // 网络迟到。
    expect(bridge.printBlob!(blob())).toBe(false);

    expect(ElMessageMock.info, '取消在途打印要让用户知道').toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL, '拒绝时不该造 blob URL（造了还得 revoke）').not.toHaveBeenCalled();
    expect(iframe.onload, '拒绝时不该挂 handler').toBeNull();

    // 用户切回来 ⇒ 仍然什么都没有。
    bridge.show!(true);
    await nextTick();
    expect(iframe.contentWindow.print).toHaveBeenCalledTimes(0);
  });
});

describe('useIframePrint：blob 生命周期与异常分支', () => {
  it('I6：连续两次打印 ⇒ 前一个 blob URL 被 revoke', () => {
    mountHost();
    bridge.printBlob!(blob());
    bridge.printBlob!(blob());
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(revoked).toEqual(['blob:fake/1']);
  });

  it('I7：iframe 未挂载 ⇒ 返回 false + 报错 + 零 createObjectURL', () => {
    // 用 iframeRef 恒为 null 的宿主，不复用 bridge.iframe。
    const printBlobRef: { fn: ((b: Blob) => boolean) | null } = { fn: null };
    const NullSubject = defineComponent({
      name: 'PrintSubjectNoIframe',
      setup() {
        printBlobRef.fn = useIframePrint(ref<HTMLIFrameElement | null>(null)).printBlob;
        return () => h('div');
      },
    });
    mounted.push(mount(NullSubject));

    expect(printBlobRef.fn!(blob())).toBe(false);
    expect(ElMessageMock.error).toHaveBeenCalledWith('打印 iframe 未挂载，请刷新页面后重试');
    expect(URL.createObjectURL, '未挂载时不该凭空造 blob URL').not.toHaveBeenCalled();
  });

  it('I8：contentWindow.print 抛异常（sandbox / cross-origin）⇒ fallback 到 window.open', () => {
    mountHost();
    const iframe = bridge.iframe!;
    iframe.contentWindow.print.mockImplementation(() => {
      throw new Error('cross-origin');
    });
    const opened = { win: { print: vi.fn() } };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(opened.win as unknown as Window);

    bridge.printBlob!(blob());
    iframe.onload!();

    expect(iframe.contentWindow.print).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith('blob:fake/1', '_blank');
    expect(opened.win.print).toHaveBeenCalledTimes(1);
  });

  it('I9：卸载 ⇒ blob 被 revoke（关标签页不留在内存里）', () => {
    const w = mountHost();
    bridge.printBlob!(blob());
    expect(revoked).toEqual([]);

    w.unmount();
    mounted.pop();
    expect(revoked).toEqual(['blob:fake/1']);
  });
});
