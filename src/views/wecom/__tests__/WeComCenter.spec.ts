// src/views/wecom/__tests__/WeComCenter.spec.ts
//
// 2026-10-17 新建：页内 tab 壳 `WeComCenter.vue` 的**源码契约**守卫（本文件不挂载组件）。
//
// 守卫的那条不变量只有一处、却决定首屏的并发请求数：**两个 `<el-tab-pane>` 都必须带
// `lazy`**。element-plus 2.14.6 的 `tab-pane.vue` 里 `shouldBeRender = !lazy || loaded ||
// active`：不带 `lazy` 时**首屏全部 pane 都挂载** ⇒ 进页面立刻并发打
// `/cron/wecom/webhooks` 与 `/cron/wecom-daily/config|meta|logs`（四五个请求），而用户第一眼
// 只看得见当前那一个 tab。
//
// ⚠️ 为什么必须是**源码**守卫而不是挂载后数请求：`lazy` 被 element-plus 换版改成 `v-if`
//   （而不是当前的 `v-show`）时，两种表现**都不会有测试报警** ——
//   ① 切走 tab 丢未保存改动（pane 真卸载 → `onBeforeUnmount` → `$dispose()`）；
//   ② 每个 pane 每次被激活都重新挂载重取。
// 而「两个 pane 都带 lazy」这件事，渲染后的 DOM 里查不出来（lazy 的效果就是不渲染）。
// 照 `views/mail/__tests__/MailCenter.spec.ts` 的同款纪律用 `readFileSync` 断言模板源码。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../WeComCenter.vue', import.meta.url), 'utf8');

/**
 * 剥掉**注释**后的源码（HTML 块注释 `<!-- -->` + 脚本块注释 `/* *\/` + 整行 `//` 注释）。
 *
 * ⚠️ **为什么必须剥**：这些组件的文件头**刻意在讲「为什么不这么写」**，那些被禁止的写法会
 * 原样出现在注释里（连 JSDoc 块注释里都有）。不剥注释的话下面那几条负向断言会被自己的注释
 * 判红，于是每次改注释都要来改测试（或者更糟：有人为了让测试绿而把文件头里那段解释删掉）。
 * 剥掉之后断言只对**真正的模板与脚本**生效，守的东西与它宣称的完全一致。
 *
 * 副作用（刻意接受）：本 spec 不检查注释内容是否正确 —— 那是 review 的事，不是测试的事。
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(SRC);

describe('WeComCenter.vue — 两个 tab pane 都必须带 lazy', () => {
  it('恰好两个 el-tab-pane，且都带 lazy 属性', () => {
    const panes = CODE.match(/<el-tab-pane\b[^>]*>/g) ?? [];
    expect(panes).toHaveLength(2);
    for (const pane of panes) {
      expect(pane, `tab-pane 缺 lazy：${pane}`).toMatch(/\blazy\b/);
    }
  });

  it('两个 pane 的 name 仍是 webhooks / daily（改 name 会让首屏默认 tab 指空）', () => {
    const panes = CODE.match(/<el-tab-pane\b[^>]*>/g) ?? [];
    expect(panes[0]).toMatch(/\bname="webhooks"/);
    expect(panes[1]).toMatch(/\bname="daily"/);
  });

  it('⚠️ 不是「只有第一个 pane 带 lazy」—— 每日总结那个同样要带（它才是请求大头）', () => {
    // 单条正则断言很容易放过「只给首屏那个加了 lazy」的写法，所以这里逐个点名。
    const panes = CODE.match(/<el-tab-pane\b[^>]*>/g) ?? [];
    const daily = panes.find((pane) => /\bname="daily"/.test(pane));
    expect(daily).toMatch(/\blazy\b/);
  });

  it('两个 pane 的顺序是「先 Webhook 配置、后每日总结」（先建通道才有得选）', () => {
    const panes = CODE.match(/<el-tab-pane\b[^>]*>/g) ?? [];
    expect(panes[0]).toMatch(/\bname="webhooks"/);
    expect(panes[1]).toMatch(/\bname="daily"/);
  });

  it('activeTab 刻意**不**持久化到 localStorage（照 MailCenter.vue 的同一取舍）', () => {
    // 「记住上次看哪个 tab」在本域没有需求，而持久化会把「进来时该看什么」变成一个没人维护
    // 的状态。哪天真要加，这里必须红（顺带把取舍记在文件头）。
    expect(CODE).not.toMatch(/localStorage|sessionStorage|useStorage/);
  });

  it('本壳**零业务零数据**：不 import 任何 store / api（业务全在两个子 tab 里）', () => {
    expect(CODE).not.toMatch(/useWeComWebhooksStore|useWeComDailyStore|@\/api\//);
  });
});
