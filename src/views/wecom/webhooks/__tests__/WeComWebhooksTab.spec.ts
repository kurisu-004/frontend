// src/views/wecom/webhooks/__tests__/WeComWebhooksTab.spec.ts
//
// 2026-10-17 新建：Webhook 配置 tab（`WeComWebhooksTab.vue`）的**源码契约**守卫 + 纯函数口径
// 守卫（本文件不挂载组件 —— 挂载要拖 pinia + vue-query + element-plus 三件套，而这条 tab 上
// 值得守的东西全都是「文案里承诺了什么」与「哪几列渲染了」，源码契约更直接）。
//
// 守的几条不变量：
//
//  1. **H1（文案纪律）**：「默认」这一列的提示条**一个字的发信承诺都不许有**。后端对
//     `is_default` 的全部消费只有列表排序与那条唯一索引，推送路径只读 `webhook_id`。写成
//     「点『设为默认』…才能用它推送」会让用户照做、回到每日总结仍吃 21801（那页的
//     `webhookMissing` 还会把「立即发送」置灰）。
//  2. **地址只显示掩码**：列表列是 `url_masked`，**不是** `webhook_url`（后端出参里根本没有完整
//     地址这回事）。渲染完整地址 = 把 secret 画到屏幕上。
//  3. **5 条动作都在**：编辑 / 测连通 / 设为默认 / 删除 / 新增 —— 少一条就是一条没人能走的路。
//  4. **删除走二次确认**（`el-popconfirm`）：软删不可撤销，且被每日总结引用时会被后端 21808
//     拒。
//  5. **弹窗显隐的出口收在一处**（CLAUDE.md「弹窗关闭权」）：`onDialogVisible` + `closeDialog`
//     两处，不发第二个业务事件。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../WeComWebhooksTab.vue', import.meta.url), 'utf8');

/** 剥掉**注释**后的源码（HTML 块注释 + 脚本块注释 + 整行 `//` 注释）—— 本组件的文件头与
 *  脚本注释里**刻意在讲「为什么是掩码 / 为什么不能承诺推送」**，那些词原样出现在注释里；不剥
 *  的话下面的负向断言会被自己的注释判红。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(SRC);

describe('WeComWebhooksTab.vue — 文案纪律（H1）', () => {
  it('H1：提示条只陈述 is_default 的真实语义，**零发信 / 推送承诺**', () => {
    const m = CODE.match(/description="[^"]*"/g) ?? [];
    const hint = m.find((s) => s.includes('默认'));
    expect(hint, '「默认」提示条消失了').toBeDefined();
    // ⚠️ 这些词一旦出现在提示条里就是一句**假承诺**：后端推送路径只读 `webhook_id`。
    expect(hint).not.toMatch(/用它推送|才能推|默认.*会用来发|自动成为默认的通道/);
    // 反向确认：它确实在解释「默认」的真实作用。
    expect(hint).toMatch(/排序/);
  });
});

describe('WeComWebhooksTab.vue — 地址只显示掩码', () => {
  it('A1：列表列取 `url_masked`，不渲染完整 `webhook_url`', () => {
    expect(CODE).toMatch(/prop="url_masked"/);
    // ⚠️ `webhook_url` 只出现在**提交路径**（store 的 payload），表格里绝不能有。
    const tableBlock = CODE.match(/<el-table[\s\S]*?<\/el-table>/)?.[0] ?? '';
    expect(tableBlock).not.toMatch(/webhook_url/);
  });

  it('A2：弹窗展示的是掩码（`editingUrlMasked`），不是完整地址', () => {
    expect(CODE).toMatch(/:url-masked="store\.dialogs\.editingUrlMasked"/);
  });
});

describe('WeComWebhooksTab.vue — 5 条动作都在 + 删除走二次确认', () => {
  it('B1：编辑 / 测连通 / 设为默认 / 删除 四个行内动作齐全', () => {
    for (const label of ['编辑', '测连通', '设为默认', '删除']) {
      expect(CODE, `行内动作缺「${label}」`).toContain(label);
    }
  });

  it('B2：新增入口在工具条上（且空态里也有一份，别让新用户卡住）', () => {
    expect(CODE).toMatch(/store\.dialogs\.openCreate\(\)/);
    const count = CODE.match(/store\.dialogs\.openCreate\(\)/g)?.length ?? 0;
    expect(count, '空态里也该有一个新增入口').toBeGreaterThanOrEqual(2);
  });

  it('B3：删除走 el-popconfirm 二次确认（软删不可撤销）', () => {
    expect(CODE).toMatch(/<el-popconfirm[\s\S]*?@confirm="onDelete/);
    expect(CODE).toMatch(/确认删除这条通道/);
  });

  it('B4：软删传**整行**（body 必填 version，store 从行上取）', () => {
    expect(CODE).toMatch(/onDelete\(row as WeComWebhookData\)/);
    expect(CODE).toMatch(/store\.actions\.remove\(row\)/);
  });
});

describe('WeComWebhooksTab.vue — 弹窗关闭权与生命周期', () => {
  it('C1：弹窗显隐的出口收在 closeDialog 一处（不发第二个业务事件）', () => {
    expect(CODE).toMatch(/function onDialogVisible\(next: boolean\): void \{[\s\S]*?closeDialog\(\);/);
    expect(CODE).toMatch(/@cancel="store\.dialogs\.closeDialog\(\)"/);
    // ⚠️ 弹窗**留着 × 是安全的**（关闭不丢任何已提交的数据，唯一的输入态在 store 里，
    // 关掉再打开会被 openCreate / openEdit 重置）—— 所以这里不钉 `:show-close="false"`。
  });

  it('C2：不变量 #2：onBeforeUnmount 必须 $dispose（Pinia 是单例）', () => {
    expect(CODE).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*?store\.\$dispose\(\);/);
  });

  it('C3：onMounted 末尾开 enabled 闸门（避免 setup 期抢跑）', () => {
    expect(CODE).toMatch(/onMounted\(\(\) => \{[\s\S]*?store\.query\.openGate\(\);/);
  });

  it('C4：消费 store **不解构**（统一 store.切片.字段）', () => {
    expect(CODE).not.toMatch(/const\s*\{\s*query[^}]*\}\s*=\s*store/);
    // store 实例本身是首调出来的（不变式 #1）
    expect(CODE).toMatch(/const store = useWeComWebhooksStore\(\);/);
  });
});

describe('WeComWebhooksTab.vue — 「更新时间」列与同域日志表同一套时间口径', () => {
  it('D1：走域内共用的 `formatNaiveDateTime`，不裸渲染后端 naive 字符串', () => {
    // ⚠️ **守卫信号**：把这一格退回 `<el-table-column prop="updated_at" …>` 时本用例立刻红。
    // 裸渲染会把秒/小数原样怼进格子，而同域日志表（本 tab 与「每日总结」tab 各一张表）的
    // 「时间」列是切过的 ⇒ 切 tab 时两处时间格式跳变，用户没法一眼判断两处是不是同一次操作。
    expect(CODE).toMatch(/import \{ formatNaiveDateTime \} from '\.\.\/utils\/naiveDateTime'/);
    expect(CODE).toMatch(/\{\{ formatNaiveDateTime\(row\.updated_at\) \}\}/);
    const tableBlock = CODE.match(/<el-table[\s\S]*?<\/el-table>/)?.[0] ?? '';
    expect(tableBlock).not.toMatch(/prop="updated_at"/);
  });

  it('D2：不引 `utils/date.ts`（`new Date()` 会把墙钟整体平移 8 小时）', () => {
    expect(CODE).not.toMatch(/from '@\/utils\/date'/);
  });
});
