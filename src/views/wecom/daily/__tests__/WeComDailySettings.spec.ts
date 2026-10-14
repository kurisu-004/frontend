// src/views/wecom/daily/__tests__/WeComDailySettings.spec.ts
//
// 2026-10-17 新建：`WeComDailySettings.vue`（每日总结页薄壳）的**源码契约**守卫（本文件不挂载
// 组件 —— 它是唯一首调 store 的地方，挂载要拖 pinia + vue-query + element-plus 全家桶）。
//
// 守的四条不变量：
//
//  1. **「立即发送」必须挂二次确认**：`POST /cron/wecom-daily/send` 真发、不可撤销，也没有
//     「撤回」端点；点错一次的代价是**整个群里多出一条日报**（或几条分片消息）。
//  2. **顶部两条告警的判据是三态派生的 `noWebhooks` / `webhookMissing`**（各自都只在
//     `=== true` 时成立），而不是「取不到」—— 后者会在通道列表还在飞时先闪一条假告警再消失。
//  3. **文案里零「不选也会用默认通道推」这类假承诺**：后端对 `webhook_id IS NULL`（或指向已
//     软删的行）直接返 21801，**没有**回落到 `is_default` 的分支。
//  4. **4 不变量**：首调 store / `onBeforeUnmount` 必须 `$dispose()` / 消费侧不解构 / 不 import
//     `vue-router`。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../WeComDailySettings.vue', import.meta.url), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(SRC);

describe('WeComDailySettings.vue — 工具条与危险动作', () => {
  it('T1：四个按钮齐全（保存 / 预览 / 立即发送 / 刷新）', () => {
    for (const label of ['保存', '预览', '立即发送', '刷新']) {
      expect(CODE, `工具条缺「${label}」`).toContain(label);
    }
  });

  it('T2：「立即发送」挂 el-popconfirm 二次确认（真发不可撤销）', () => {
    expect(CODE).toMatch(/<el-popconfirm[\s\S]*?@confirm="onSend"/);
    expect(CODE).toMatch(/消息会真的发到群里，且不可撤销/);
  });

  it('T3：「立即发送」受 sendDisabled 约束（正在发 / 一个通道都没有 / 没选通道）', () => {
    expect(CODE).toMatch(/:disabled="store\.actions\.sendDisabled"/);
  });

  it('T4：dirty 时给一行提示（有未保存的修改）', () => {
    expect(CODE).toMatch(/v-if="store\.query\.dirty"/);
    expect(CODE).toMatch(/有未保存的修改/);
  });
});

describe('WeComDailySettings.vue — 顶部三条告警', () => {
  it('A1：两条通道告警用 v-if / v-else-if（不会同时弹）', () => {
    expect(CODE).toMatch(/v-if="store\.query\.noWebhooks"/);
    expect(CODE).toMatch(/v-else-if="store\.query\.webhookMissing"/);
  });

  it('A2：配置错误单独一条 error alert', () => {
    expect(CODE).toMatch(/v-if="store\.query\.configErrorText"/);
    expect(CODE).toMatch(/:title="store\.query\.configErrorText"/);
  });

  it('A3：文案里**零「不选也能发 / 会用默认通道」这类假承诺**', () => {
    const descriptions = [...CODE.matchAll(/(?:description|title)="([^"]*)"/g)].map((m) => m[1]!);
    expect(descriptions.length).toBeGreaterThan(0);
    for (const d of descriptions) {
      expect(d, `文案含假承诺：${d}`).not.toMatch(/不选也|会用默认通道|自动选|自动发/);
    }
  });

  it('A4：两条告警都指路到「Webhook 配置」那个 tab（下一步是明确的）', () => {
    expect(CODE).toMatch(/请先到「Webhook 配置」里新增一条通道/);
    expect(CODE).toMatch(/请在下方「推送通道」里选一条/);
  });
});

describe('WeComDailySettings.vue — 组件拼装与 4 不变量', () => {
  it('I1：不变量 #1：setup 顶部首调 store', () => {
    expect(CODE).toMatch(/const store = useWeComDailyStore\(\);/);
  });

  it('I2：不变量 #2：onBeforeUnmount 必须 $dispose（Pinia 是单例）', () => {
    expect(CODE).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*?store\.\$dispose\(\);/);
  });

  it('I3：不变量 #4：不 import vue-router（弹窗全在本页）', () => {
    expect(CODE).not.toMatch(/from 'vue-router'/);
  });

  it('I4：消费侧不解构 store（统一 store.切片.字段）', () => {
    expect(CODE).not.toMatch(/const\s*\{\s*(query|dialogs|actions)[^}]*\}\s*=\s*store/);
  });

  it('I5：两个配置卡片 + 预览弹窗 + 发送历史 + 分页都挂上了', () => {
    for (const comp of [
      'WeComScheduleSection',
      'WeComContentSection',
      'WeComPreviewDialog',
      'WeComLogTable',
    ]) {
      expect(CODE, `未挂 ${comp}`).toContain(`<${comp}`);
    }
    expect(CODE).toMatch(/<el-pagination/);
  });

  it('I6：表单变更走 applyForm（不换引用 —— 换掉会让 dirty / payload 组装作用在旧对象上）', () => {
    expect(CODE).toMatch(/store\.query\.applyForm\(next\)/);
    expect(CODE).not.toMatch(/store\.query\.form = next/);
  });

  it('I7：每页条数变化时页码复位（避免停在一个已不存在的页）', () => {
    expect(CODE).toMatch(/watch\(\s*\(\) => store\.query\.logsPageSize,/);
    expect(CODE).toMatch(/store\.query\.logsPage = 1;/);
  });

  it('I8：onMounted 末尾开 enabled 闸门（避免 setup 期抢跑）', () => {
    expect(CODE).toMatch(/onMounted\(\(\) => \{[\s\S]*?store\.query\.openGate\(\);/);
  });
});
