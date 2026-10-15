// utils/iframePrint.ts
//
// 2026-10-22 新增：隐藏 iframe + blob URL 触发浏览器打印的**唯一**实现。
//
// ⚠️ **本文件存在的理由是 keep-alive，不只是去重**。下面这条根因在现场表现成
// 「零件一览打印完图纸、切到别的页再回来 ⇒ 打印窗口自己又弹一次」，而它零报错、
// 零日志、typecheck / lint 全绿：
//
//   1. `MainLayout.vue` 用 `<keep-alive :include="tags.cachedViewNames">` 缓存路由
//      组件（`PartsList` / `PartDetail` / `AssemblyDetail` 的路由名都等于组件文件名，
//      三页都在缓存名单里）。
//   2. Vue 3 的 `<KeepAlive>` **不是**把缓存页 `display:none` 藏起来，而是把整棵 DOM
//      子树 `move()` 进一个**游离的** `storageContainer`（`createElement("div")`，
//      从不 append 到 document；见 `@vue/runtime-core` 的 KeepAlive 实现）。
//   3. 按 HTML 规范，`<iframe>` 被移出文档 = 卸载它的 browsing context；**重新插回
//      文档时浏览器会再次导航到 `src`** ⇒ `load` 事件第二次触发。
//   4. 改前两处打印都是 `iframe.onload = () => { ...; iframe.contentWindow.print() }`
//      且**永不解绑**，blob URL 又只在 `onBeforeUnmount` 里 revoke（keep-alive
//      deactivate 不触发 `onBeforeUnmount`）⇒ 重载成功 ⇒ `print()` 又跑一遍。
//
// ⇒ 本文件用四道闸各挡一环。**它们挡的不是同一件事，去掉任何一道都留下一个复现路径**，
// 而每一条路径都只对应「多打印一次」这一个用户可见症状 ⇒ 回归时看不出是哪道闸失效。
//
//   - `settled` 一次性旗标 ⇒ 挡第 4 环那个「第二次 load」。⚠️ **光靠把 `iframe.onload`
//     置 null 是不够的**：那是依赖「浏览器在派发时现查 onload 属性」这条实现细节，而
//     handler 已经被闭包捕获在别处（测试里就是直接再调它）时照样会跑第二次。旗标写在
//     handler **体内**，与它从哪儿被调出来无关。
//   - `onDeactivated` 拆解（onload=null + `src = 'about:blank'` + revoke blob）⇒
//     只解绑 handler 不够：iframe 仍会**静默重载并重渲染整份合并 PDF**（批量打印动辄
//     几十 MB），每次切标签页都重来一遍，且内存里的 PDF viewer 一直驻着。
//   - `settled` 在 `release()` 里置位 ⇒ 挡「打印已发起、load 还没落地时切走」。
//   - `active`（`onActivated` / `onDeactivated` 维护）⇒ 挡**打印在途**那一支。
//     ⚠️ 这一支**不是** deactivate 能挡的，时序是反的：大图纸批量打印要跑几分钟，用户
//     点完就切走（此时 `deactivate` 跑过、`release()` 跑过、什么 pending 都没有），
//     网络回来后 `printBlob` 才挂上 handler，而用户什么时候切回来不由我们决定 ⇒
//     只在 deactivate 里做文章的话，切回来照样弹窗抢焦点。判据必须是「此刻页面是不是
//     活跃」，不是一个「发生过的事件」。
//
// **调用约束**：必须在 setup 作用域调用（`onActivated` / `onDeactivated` /
// `onBeforeUnmount` 需要当前组件实例；不在 `<KeepAlive>` 下时前两个永不触发，
// `active` 保持初值 `true`，走正常路径，无害）。当前消费方两个：
// `views/parts/list/composables/useBatchPrint.ts`（批量打印）与
// `components/FileListCard.vue`（单件打印，宿主是零件详情 / 装配件详情）。
//
// **不要在消费方里再写裸 `iframe.onload =` / `contentWindow?.print()`** —— 那等于把
// 上面第 4 环原样抄回去，且没有任何报错提示。守卫见
// `src/utils/__tests__/iframePrint.spec.ts`（行为）与
// `src/utils/__tests__/iframePrintContract.spec.ts`（不许有第二份实现）。

import { onActivated, onBeforeUnmount, onDeactivated, type Ref } from 'vue';
import { ElMessage } from 'element-plus';

export interface IframePrint {
  /**
   * 把 blob 塞进隐藏 iframe 并调起浏览器打印。
   *
   * 两种失败各自带一条用户提示、由本函数自己发（都是打印宿主的属性，与哪个消费方无关），
   * 因此**失败时返回 false、调用方什么都不用做**：
   *   - 页面当前不活跃（在途打印：用户点完打印就切走了）⇒ info「已离开本页…」；
   *   - iframe 未挂载 ⇒ error「打印 iframe 未挂载…」。
   *
   * 注意这是**同步**返回：是否打印成功取决于随后的 `load`，不在返回值里（原生打印
   * 对话框是否弹出也不可知）。
   */
  printBlob: (blob: Blob) => boolean;
  /**
   * 拆解打印宿主：作废在途打印 + 解绑 `onload` + iframe 导航到 `about:blank` + revoke
   * 当前 blob。`onDeactivated` / `onBeforeUnmount` 已自动调用，一般不需要手动调；
   * 留出来是给「打印完立刻要释放」这类显式场景的。
   */
  release: () => void;
}

/** 用户在打印发起后离开本页时的统一提示（两处调用，避免文案分叉）。 */
const CANCELED_TEXT = '已离开本页，本次打印已取消';

export function useIframePrint(iframeRef: Ref<HTMLIFrameElement | null>): IframePrint {
  let blobUrl = '';
  /** 本次打印是否已终结（已打印 或 已作废）。false = 还有一次 load 在等着。 */
  let settled = true;
  /** 是否已挂上 handler、还没等到 `load`。只用于决定要不要提示用户。 */
  let pending = false;
  /**
   * 宿主页面当前是否活跃。不在 `<KeepAlive>` 下时两个钩子都不触发，本值恒为初值
   * `true` ⇒ 非缓存页走完全一样的正常路径，不需要调用方区分。
   */
  let active = true;

  function release(): void {
    // 顺序不能反：先作废在途打印，再动 DOM。handler 是同步派发的，先置位才能保证本次
    // deactivate 之后到达的 load 一律被后面的比对挡掉。
    settled = true;
    const iframe = iframeRef.value;
    if (iframe) {
      iframe.onload = null;
      // 必须置 `about:blank` 而不只是解绑：重插时浏览器会重新导航到当前 `src`，
      // 解绑 handler 只让「不打印」，那整份 PDF 照样被重载 + 重渲染一遍。
      iframe.src = 'about:blank';
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = '';
    }
    if (pending) {
      pending = false;
      ElMessage.info(CANCELED_TEXT);
    }
  }

  function printBlob(blob: Blob): boolean {
    // ⚠️ 必须**先判活跃再判 iframe**、且都早于 `URL.createObjectURL`：页面不活跃时
    // 连 blob URL 都不该造（造了就得 revoke，等于白白多一份引用）。
    if (!active) {
      ElMessage.info(CANCELED_TEXT);
      return false;
    }
    const iframe = iframeRef.value;
    if (!iframe) {
      ElMessage.error('打印 iframe 未挂载，请刷新页面后重试');
      return false;
    }

    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);

    settled = false;
    pending = true;
    iframe.src = blobUrl;
    iframe.onload = () => {
      // ⚠️ 第一句就置位、且在任何可能抛异常的调用之前：这一句是「keep-alive 重插导致
      // 第二次 load」的答案。写成 `iframe.onload = null` 只能挡住「浏览器派发时现查属性」
      // 那条路，handler 已被别处捕获时仍会跑第二次（守卫见 iframePrint.spec.ts::I2）。
      if (settled) return;
      settled = true;
      pending = false;
      iframe.onload = null;
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        // sandbox / cross-origin 等极端情况下 fallback 到新窗口打印
        const w = window.open(blobUrl, '_blank');
        if (w) w.print();
      }
    };
    return true;
  }

  onActivated(() => {
    active = true;
  });
  onDeactivated(() => {
    active = false;
    // deactivate（切标签页）与 unmount（关标签页）都要拆：前者治「切回来又弹」，
    // 后者治 blob 泄漏 —— 页面被缓存时 `onBeforeUnmount` 根本不触发。
    release();
  });
  onBeforeUnmount(release);

  return { printBlob, release };
}
