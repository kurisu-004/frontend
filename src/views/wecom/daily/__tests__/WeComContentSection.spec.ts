// src/views/wecom/daily/__tests__/WeComContentSection.spec.ts
//
// 2026-10-17 新建：`WeComContentSection.vue` 的**源码契约**守卫（本文件不挂载组件）。
//
// 守的四条不变量：
//
//  1. **条形图由后端渲染成 markdown 字符条随消息下发，本组件不引入任何图表组件** —— CLAUDE.md
//     「图表」一节要求业务组件一律走 `vue-echarts`，而这里是**刻意的例外**：推送内容是一段要
//     原样进企业微信的 markdown，前端渲染出来的图对「群里那条消息」毫无贡献。前端这一侧只
//     负责「选口径 / 选人数上限」。
//  2. **四个开关 + 三个数字全部由 meta 驱动**（`workerMetricOptions` / `ranges`），不在本组件
//     硬编码上界（后端收窄 / 放宽时前端自动跟随，且 schema 的越界校验读同一份）。
//  3. **关开关不禁用清值**：`include_orders` / `include_workers` 关掉时对应输入项**禁用但不清
//     值** —— 清值会让用户「关 → 开」之后发现设置丢了。
//  4. **四节全关的提示挂在虚拟字段 `sections` 上**，不挂到任何一个开关上（那是四个开关**共同**
//     的责任，挂到任一个都会误导）。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
  new URL('../components/WeComContentSection.vue', import.meta.url),
  'utf8',
);

function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(SRC);

describe('WeComContentSection.vue — 条形图零图表依赖（第一性质）', () => {
  it('G1：不引入 echarts / VChart / canvas / svg 图表（条形字符图由后端渲染）', () => {
    expect(CODE).not.toMatch(/echarts|VChart|EChart|echarts\/core|echarts\.init/);
    expect(CODE).not.toMatch(/<canvas|<svg/);
  });

  it('G2：条形图的「口径」是一个下拉（不是画布上的某个参数）', () => {
    expect(CODE).toMatch(/aria-label="条形图指标口径"/);
    expect(CODE).toMatch(/v-for="opt in workerMetricOptions"/);
  });

  it('G3：三个开关 + 三个数字的 label 一字不差（① ② ③ ④ 是与产品约定的节序）', () => {
    for (const label of [
      '① 全厂报工总览',
      '② 今日出货',
      '③ 交期工单',
      '④ 工人报工',
      '单次最多条数',
      '标题模板',
    ]) {
      expect(CODE, `缺控件「${label}」`).toContain(label);
    }
  });
});

describe('WeComContentSection.vue — 四个开关与三个数字', () => {
  it('S1：四个节开关各一行，各自带一句口径说明', () => {
    for (const field of [
      'include_overview',
      'include_delivery',
      'include_orders',
      'include_workers',
    ]) {
      expect(CODE, `缺开关 ${field}`).toContain(field);
    }
    expect(CODE).toMatch(/今日报工批次 \/ 件数、完工 \/ 在制 \/ 返修/);
    expect(CODE).toMatch(/今日已取货的送货单数与件数合计/);
  });

  it('S2：三个数字的 :min/:max **来自 ranges prop**（不写死上界）', () => {
    expect(CODE).toMatch(/:min="ranges\.upcoming_days\.min"/);
    expect(CODE).toMatch(/:max="ranges\.upcoming_days\.max"/);
    expect(CODE).toMatch(/:min="ranges\.worker_top_n\.min"/);
    expect(CODE).toMatch(/:max="ranges\.worker_top_n\.max"/);
    expect(CODE).toMatch(/:min="ranges\.max_chunks\.min"/);
    expect(CODE).toMatch(/:max="ranges\.max_chunks\.max"/);
  });

  it('S3：关开关时输入项**禁用但不清值**（清值会让「关 → 开」之后发现设置丢了）', () => {
    expect(CODE).toMatch(/:disabled="!modelValue\.include_orders"/);
    expect(CODE).toMatch(/:disabled="!modelValue\.include_workers"/);
    // 反向确认：切开关的那两个 handler **只改布尔量**，不动天数 / 人数。
    expect(CODE).toMatch(/@update:model-value="patch\(\{ include_orders: Boolean\(\$event\) \}\)"\s*\/>/);
  });

  it('S4：三个 el-input-number 清空交原值给 schema（不兜成 0）', () => {
    for (const handler of ['onUpcomingDaysChange', 'onWorkerTopNChange', 'onMaxChunksChange']) {
      const fn = CODE.match(new RegExp(`function ${handler}[\\s\\S]*?\\n\\}`))?.[0] ?? '';
      expect(fn, `${handler} 没找到`).toContain(`v === '' ? undefined`);
    }
  });

  it('S5：单次最多条数的 hint 说清「不截断 / 拆成多条」（管理员据此判断要不要调大）', () => {
    expect(CODE).toMatch(/内容超长会拆成多条发出（不截断）/);
  });

  it('S6：标题模板留空合法（= 用后端默认标题），placeholder 说清这一点', () => {
    expect(CODE).toMatch(/留空则用后端默认标题/);
    expect(CODE).toMatch(/maxlength="200"/);
  });
});

describe('WeComContentSection.vue — 四节全关的提示', () => {
  it('X1：提示挂在虚拟字段 `sections` 上（不挂任何单个开关）', () => {
    expect(CODE).toMatch(/v-if="errors\?\.sections"/);
    expect(CODE).toMatch(/rowClass\('sections'\)/);
  });

  it('X2：文案说清后果（一条空消息），而不是「某个开关错了」', () => {
    // 提示文案本体在 schema 里（唯一真源）；这里只断言它被渲染出来。
    expect(CODE).toMatch(/\{\{ errors\.sections \}\}/);
  });
});

describe('WeComContentSection.vue — 纯组件纪律', () => {
  it('P1：不首调 store、零 api 依赖', () => {
    expect(CODE).not.toMatch(/useWeComDailyStore|@\/api\//);
    expect(CODE).toMatch(/defineProps</);
    expect(CODE).toMatch(/defineEmits</);
  });

  it('P2：ranges 的 prop 默认值来自 schema 的兜底常量（不是第二份字面量）', () => {
    expect(CODE).toMatch(/DEFAULT_WECOM_DAILY_RANGES/);
    expect(CODE).not.toMatch(/upcoming_days: \{ min: 1, max: \d+ \}/);
  });

  it('P3：字段红字与高亮行都由 errors / focusField 驱动', () => {
    expect(CODE).toMatch(/'is-error': !!props\.errors\?\.\[field\]/);
    expect(CODE).toMatch(/'is-focus': props\.focusField === field/);
  });
});
