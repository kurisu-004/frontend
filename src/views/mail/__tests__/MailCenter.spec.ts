// src/views/mail/__tests__/MailCenter.spec.ts
//
// 2026-10-16 新增：页内 tab 壳 `MailCenter.vue` 的**源码契约**守卫（本文件不挂载组件）。
//
// 守卫的那条不变量只有一处、却决定首屏的并发请求数：**两个 `<el-tab-pane>` 都必须带
// `lazy`**。element-plus 2.14.6 的 `tab-pane.vue` 里 `shouldBeRender = !lazy || loaded ||
// active`：不带 `lazy` 时**首屏全部 pane 都挂载** ⇒ 进页面立刻并发打
// `/cron/mail/accounts` + `/cron/mail/accounts`(meta) + `/cron/mail-digest/config|meta|logs`
// 五六个请求，而用户第一眼只看得见当前那一个 tab。
//
// ⚠️ 为什么必须是**源码**守卫而不是挂载后数请求：`lazy` 被 element-plus 换版改成
// `v-if`（而不是当前的 `v-show`）时，两种表现**都不会有测试报警** ——
//   ① 切走 tab 丢未保存改动（pane 真卸载 → `onBeforeUnmount` → `$dispose()`）；
//   ② 每个 pane 每次被激活都重新挂载重取。
// 而「两个 pane 都带 lazy」这件事，渲染后的 DOM 里查不出来（lazy 的效果是不渲染）。
// 照 `views/mail/accounts/__tests__/` 各 spec 的同款纪律用 `readFileSync` 断言模板源码。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../MailCenter.vue', import.meta.url), 'utf8');

describe('MailCenter.vue — 两个 tab pane 都必须带 lazy', () => {
  it('恰好两个 el-tab-pane，且都带 lazy 属性', () => {
    const panes = SRC.match(/<el-tab-pane\b[^>]*>/g) ?? [];
    expect(panes).toHaveLength(2);
    for (const pane of panes) {
      expect(pane, `tab-pane 缺 lazy：${pane}`).toMatch(/\blazy\b/);
    }
  });

  it('两个 pane 的 name 仍是 accounts / digest（改 name 会让首屏默认 tab 指空）', () => {
    const panes = SRC.match(/<el-tab-pane\b[^>]*>/g) ?? [];
    expect(panes[0]).toMatch(/\bname="accounts"/);
    expect(panes[1]).toMatch(/\bname="digest"/);
  });

  it('⚠️ 不是「只有第一个 pane 带 lazy」—— 交期汇总那个同样要带（它才是请求大头）', () => {
    // 单条正则断言很容易放过「只给首屏那个加了 lazy」的写法，所以这里逐个点名。
    const panes = SRC.match(/<el-tab-pane\b[^>]*>/g) ?? [];
    const digest = panes.find((pane) => /\bname="digest"/.test(pane));
    expect(digest).toMatch(/\blazy\b/);
  });
});
