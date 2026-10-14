// src/views/wecom/daily/__tests__/WeComScheduleSection.spec.ts
//
// 2026-10-17 新建：`WeComScheduleSection.vue` 的**源码契约**守卫（本文件不挂载组件 —— 挂载要
// 拖 element-plus 全家桶，而这条 section 上值得守的东西全都是「哪些字段的显隐由谁决定」）。
//
// 守的四条不变量：
//
//  1. **三条渲染分支由 `frequencyOptions` 的三个 `needs_*` 决定，不在本组件硬编码**：
//     `v-if="flags.needs_time"` / `needs_weekday` / `needs_day_of_month`。硬编码的症状是「后端
//     给 DAILY 加了「不要时刻」的判据、前端照样渲染时/分两个框」。
//  2. **切频率时按判据归一**（`onFrequencyChange`）：不归一的话 schema 的「多填即非法」issue
//     挂在**整行不渲染**的字段上 ⇒ 屏幕上零红字而三条动作全被拦死（一条看不见的死路）。
//  3. **推送通道在最前面**：它是「能不能发出去」的前置条件，比「什么时候发」更该先看见。
//  4. **通道候选来自 prop**（壳传下来的 query 数据），不是模板里硬编码的选项。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
  new URL('../components/WeComScheduleSection.vue', import.meta.url),
  'utf8',
);

function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(SRC);

describe('WeComScheduleSection.vue — 配套字段的显隐由 meta 的 needs_* 决定', () => {
  it('S1：三个 needs_* 各有一条 v-if 分支', () => {
    expect(CODE).toMatch(/v-if="flags\.needs_time"/);
    expect(CODE).toMatch(/v-if="flags\.needs_weekday"/);
    expect(CODE).toMatch(/v-if="flags\.needs_day_of_month"/);
  });

  it('S2：flags 优先读 meta 下发的选项、读不到才回落内置兜底表', () => {
    expect(CODE).toMatch(
      /frequencyOptions\.find\(\(f\) => f\.value === props\.modelValue\.frequency\)/,
    );
    expect(CODE).toMatch(/DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS\[props\.modelValue\.frequency\]/);
  });

  it('S3：MANUAL_ONLY（三 needs_* 全 false）留一条说明，且不承诺自动发出', () => {
    expect(CODE).toMatch(/v-if="!flags\.needs_time"/);
    expect(CODE).toMatch(/仅手动推送，不注册定时任务/);
  });

  it('S4：星期候选是 ISO 1=周一 … 7=周日（**不是** JS 的 0=周日）', () => {
    expect(CODE).toMatch(
      /WEEKDAY_OPTIONS = \[[\s\S]*?value: 1, label: '周一'[\s\S]*?value: 7, label: '周日'/,
    );
  });

  it('S5：时/分用两个 el-select 而不是 el-time-picker（wire 形态就是两个独立数字字段）', () => {
    expect(CODE).toMatch(/HOUR_OPTIONS = Array\.from\(\{ length: 24 \}/);
    expect(CODE).toMatch(/MINUTE_OPTIONS = Array\.from\(\{ length: 60 \}/);
    expect(CODE).not.toMatch(/el-time-picker/);
  });
});

describe('WeComScheduleSection.vue — 切频率时按判据归一', () => {
  it('N1：onFrequencyChange 把当前频率用不到的配套字段置 null', () => {
    const fn = CODE.match(/function onFrequencyChange[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/send_hour: judge\.needs_time \? props\.modelValue\.send_hour : null/);
    expect(fn).toMatch(/send_minute: judge\.needs_time \? props\.modelValue\.send_minute : null/);
    expect(fn).toMatch(/weekday: judge\.needs_weekday \? props\.modelValue\.weekday : null/);
    expect(fn).toMatch(
      /day_of_month: judge\.needs_day_of_month \? props\.modelValue\.day_of_month : null/,
    );
  });

  it("N2：el-select 清空给出 `''` ⇒ 归一成 null（免得把空串塞上 wire）", () => {
    expect(CODE).toMatch(
      /function toNullableInt[\s\S]*?if \(v === '' \|\| v === null \|\| v === undefined\) return null;/,
    );
    expect(CODE).toMatch(
      /function toNullableString[\s\S]*?if \(v === '' \|\| v === null \|\| v === undefined\) return null;/,
    );
  });

  it('N3：通道 id **不过 Number()**（雪花 id 走 JSON string，过一遍就丢精度）', () => {
    const fn = CODE.match(/function toNullableString[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/return String\(v\);/);
    expect(fn).not.toMatch(/Number\(/);
  });
});

describe('WeComScheduleSection.vue — 推送通道行', () => {
  it('W1：通道下拉是**第一个** field-row（它是「能不能发出去」的前置条件）', () => {
    const firstRow = CODE.indexOf('webhook_id');
    const enabledRow = CODE.indexOf('aria-label="启用定时"');
    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(firstRow).toBeLessThan(enabledRow);
  });

  it('W2：选项来自 prop（壳传下来的 query 数据），不是硬编码', () => {
    expect(CODE).toMatch(/v-for="w in webhooks"/);
    expect(CODE).toMatch(/:key="w\.id"/);
    expect(CODE).toMatch(/:label="w\.name"/);
    // 掩码进 option 的右侧副文本（同名通道靠它区分是哪一群）
    expect(CODE).toMatch(/\{\{ w\.url_masked \}\}/);
  });

  it('W3：列表为空时给一句指路（去「Webhook 配置」新增），不是空白', () => {
    expect(CODE).toMatch(/v-if="webhooks\.length === 0"/);
    expect(CODE).toMatch(/还没有可用通道，请先到「Webhook 配置」里新增一条/);
  });

  it('W4：空选 placeholder 写明「发送会失败」（后端对 null 直接 21801、无回落分支）', () => {
    expect(CODE).toMatch(/placeholder="未选（发送会失败）"/);
  });
});

describe('WeComScheduleSection.vue — 纯组件纪律', () => {
  it('P1：不首调 store、零 api 依赖（表单模型是 prop、补丁是 emit）', () => {
    expect(CODE).not.toMatch(/useWeComDailyStore|@\/api\//);
    expect(CODE).toMatch(/defineProps</);
    expect(CODE).toMatch(/defineEmits</);
  });

  it('P2：字段红字与高亮行都由 errors / focusField 驱动', () => {
    expect(CODE).toMatch(/function rowClass\(field: WeComDailyFormField\)/);
    expect(CODE).toMatch(/'is-error': !!props\.errors\?\.\[field\]/);
    expect(CODE).toMatch(/'is-focus': props\.focusField === field/);
  });

  it('P3：引 webhook 的 wire 类型用 `import type`（不引那个子域的守门 schema）', () => {
    expect(CODE).toMatch(
      /import type \{ WeComWebhookData \} from '@\/views\/wecom\/webhooks\/weComWebhookSchema';/,
    );
    expect(CODE).not.toMatch(
      /^import \{[^}]*\} from '@\/views\/wecom\/webhooks\/weComWebhookSchema';/m,
    );
  });
});
