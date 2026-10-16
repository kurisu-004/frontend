// @vitest-environment happy-dom
// src/views/hr/schedule/components/__tests__/ScheduleDayCell.spec.ts
//
// 2026-10-16 新建：月历单格的**色带判据**、**覆盖标记**与**格内密度预算**。这三样都是
// 「数据进了 schema、进了对账，唯独没进 UI（或者进了 UI 但没渲染出来）」的高发区。
//
//  1. **日级 `workday` 不是色带的闸门**。全局作用域下权威判据是**班次级**的
//     `shift_bands[].is_workday`（store 已按它滤过）。「全局是法定节假日、但某班次有覆盖行使
//     其照常上班」正是后端 `vo.rs` 点名的场景：拿日级 `workday` 再过一道，这段就被杀掉，
//     用户永远看不到「这个班次那天照常上班」—— 本域最有价值的一条信息。
//  2. **`is_override` 必须落到 UI 上**：全局视图上「这天是全局配置」与「这天被某班次覆盖过」
//     是两回事。被覆盖的那一段要带视觉区分 + tooltip 点名。
//  3. **格内密度**是 42 格 × 6 行的硬约束，`el-tag` 的原生 `small` 尺寸（20px 高 / 12px 字）
//     在 1366×768 这类笔记本视口下会把格子顶出裁切。本仓没有布局测试环境，所以这组用例直接
//     读源文件文本钉住那几条规则（照 `api/__tests__/hrContractShape.spec.ts` 「真读源码」
//     的纪律），规则被删 / 被改回 Element Plus 原生尺寸时当场红。
//     ⚠️ **这层守卫只认字面量，不是布局回归守卫**：它发现得了「这条声明被删了 / 被改回 EP
//     原生尺寸」，发现不了选择器与真实 DOM 脱钩、Element Plus 改名改结构、以及层叠顺序 /
//     特异性回归（本仓没有能算布局的测试环境，这几类只能靠评审与人工在真视口下看）。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import ScheduleDayCell from '../ScheduleDayCell.vue';
import { buildMonthGrid, type MonthCell } from '../../utils/monthGrid';
import type { ShiftBandView } from '../../composables/useScheduleStore';
import type { HrDayType } from '@/types/hr';

// ---------------------------------------------------------------- EP 桩
/** `el-tag` 桩：照真实组件的 DOM 形态渲染外层 + `.el-tag__content`（文字装在后者里，
 *  省略号那段样式也必须打在后者上 —— `.el-tag` 是 flex 容器，写在外层是空操作）。 */
const ElTagStub = {
  name: 'ElTag',
  props: ['type', 'size', 'effect'],
  template: '<span class="el-tag"><span class="el-tag__content"><slot /></span></span>',
};

const globalConfig = { components: { 'el-tag': ElTagStub } };

const OCT = buildMonthGrid(2026, 10);

function cell(iso: string, patch: Partial<MonthCell> = {}): MonthCell {
  const found = OCT.find((c) => c.iso === iso);
  if (!found) throw new Error(`fixture 里没有 ${iso}`);
  return { ...found, ...patch };
}

function band(over: Partial<ShiftBandView> = {}): ShiftBandView {
  return { color: '#1e4d8b', title: '白班', override: false, ...over };
}

function mountCell(props: {
  cell: MonthCell;
  bands?: ShiftBandView[];
  workday?: boolean;
  isOverride?: boolean;
  dayType?: HrDayType | null;
  name?: string | null;
  derived?: boolean;
}) {
  return mount(ScheduleDayCell, {
    props: {
      cell: props.cell,
      dayType: props.dayType === undefined ? 'WORKDAY' : props.dayType,
      name: props.name ?? null,
      derived: props.derived ?? false,
      isOverride: props.isOverride ?? false,
      workday: props.workday ?? true,
      bands: props.bands ?? [],
      selected: false,
      inRange: false,
    },
    global: globalConfig,
  });
}

describe('ScheduleDayCell — 色带的闸门（班次级，不是日级）', () => {
  // ⚠️ **本域最有价值的一条**：全局是法定节假日（`workday = false`），但白班有覆盖行使其照常
  //   上班。这一段必须画出来 —— 拿日级 `workday` 当闸门就正好把它杀掉。
  it('C1：**全局休息日 + 某班次覆盖上班 ⇒ 段照样画出来**（`workday=false` 不当闸门）', () => {
    const w = mountCell({
      cell: cell('2026-10-07'),
      dayType: 'STATUTORY_HOLIDAY',
      workday: false,
      bands: [band({ override: true })],
    });
    expect(w.findAll('.shift-band')).toHaveLength(1);
    expect(w.find('.shift-bands').exists()).toBe(true);
    // 日级 `workday` 唯一的运行时去处就是这一跳（`types/hr.ts::isHrWorkday` 口径收敛后的
    // 消费链）：它只弱化日期号，**不碰色带**。
    expect(w.classes()).toContain('is-rest');
  });

  it('C2：没有上工的班次 ⇒ 一段都不画（容器也不出）', () => {
    const w = mountCell({ cell: cell('2026-10-08'), bands: [] });
    expect(w.find('.shift-bands').exists()).toBe(false);
    // 工作日（`workday` 默认 `true`）不该带 `is-rest`：上一条钉住「假 ⇒ 有」，这条钉住「真 ⇒ 无」。
    expect(w.classes()).not.toContain('is-rest');
  });

  it('C3：**补格**（前后月）不出色带 —— 写进去用户会以为改到了当月', () => {
    const w = mountCell({ cell: cell('2026-09-27', { inMonth: false }), bands: [band()] });
    expect(w.find('.shift-bands').exists()).toBe(false);
  });
});

describe('ScheduleDayCell — 覆盖标记落到 UI', () => {
  it('C4：被覆盖的那一段带 `is-override` 类，其余不带', () => {
    const w = mountCell({
      cell: cell('2026-10-07'),
      dayType: 'STATUTORY_HOLIDAY',
      workday: false,
      bands: [band({ title: '白班', override: true }), band({ title: '夜班', override: false })],
    });
    const segs = w.findAll('.shift-band');
    expect(segs).toHaveLength(2);
    expect(segs[0]!.classes()).toContain('is-override');
    expect(segs[1]!.classes()).not.toContain('is-override');
  });

  it('C5：tooltip 点名被覆盖的段（「（覆盖）」后缀），分辨得出全局配置与覆盖', () => {
    const w = mountCell({
      cell: cell('2026-10-07'),
      dayType: 'STATUTORY_HOLIDAY',
      name: '中秋',
      workday: false,
      bands: [band({ title: '白班', override: true }), band({ title: '夜班', override: false })],
    });
    expect(w.attributes('title')).toContain('上班班次：白班（覆盖）、夜班');
  });

  it('C6：后端没返这一天（`dayType = null`）时标题只给日期 + 「无数据」，不编造班次', () => {
    const w = mountCell({ cell: cell('2026-10-09'), dayType: null });
    expect(w.attributes('title')).toBe('2026-10-09 无数据');
  });
});

describe('ScheduleDayCell — 格内密度预算的字面量守门（读源文件，不是布局回归守卫）', () => {
  // 本仓没有布局测试环境（happy-dom 不计算 SFC 的 `<style scoped>`，更没有真实视口），
  // 所以这组用例直接读组件**源文件**钉住那几条规则：规则被删、或被改回 Element Plus 的
  // 原生尺寸时当场红，而不是等有人在 1366×768 的笔记本上看见裁切才发现。
  // ⚠️ **能力边界**：只认字面量 ⇒ 抓得到「声明被删 / 被改回 EP 原生尺寸」，抓不到选择器与
  //   DOM 脱钩、EP 改名、以及层叠顺序 / 特异性回归。别把它当布局守卫用。
  // 路径取 Vite 注入的 `__file`（本仓唯一的组件源文件绝对路径真源），不拼 `import.meta.url`
  // ——happy-dom 环境下后者不是 `file:` scheme。
  const css = readFileSync(
    (ScheduleDayCell as unknown as { __file: string }).__file,
    'utf8',
  );

  it('C7：`el-tag` 压回 10px 字 / 16px 行高，省略号打在 `.el-tag__content` 上', () => {
    // ⚠️ 三条尺寸必须**同属 `.day-badges :deep(.el-tag)` 这一条规则块**：拆成三条
    //   `toContain` 时它们是全文件级匹配，而 `.override-flag` 里同样写着 `padding: 0 4px;`
    //   ——把 `.el-tag` 的 `padding` 整条删掉，`toContain` 照样绿（恒真断言）。
    // 先切出规则块、再逐条断言，每条都锚在「声明自己的行首」（`^` 配 `m` 标志按行匹配，或上一条
    //   声明的 `;` 之后）。这样两条性质同时成立：①三条**顺序无关**，手改 / 整理重排属性不会得到
    //   一条看不懂的假红；②`line-height` / `min-height` 这类前缀属性不会被误当成 `height`。
    const block = /\.day-badges :deep\(\.el-tag\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/(?:^|[\n;])\s*--el-tag-font-size:\s*10px;/m);
    expect(block).toMatch(/(?:^|[\n;])\s*height:\s*16px;/m);
    expect(block).toMatch(/(?:^|[\n;])\s*padding:\s*0 4px;/m);
    // 省略号必须打在承载文字的内层 span 上（写在外层 `.el-tag` 上是空操作：文字被硬切、无省略号）。
    expect(css).toContain('.day-badges :deep(.el-tag__content)');
    // 高度不够时裁切优先落在徽标区，而不是把整块顶出 `.day-cell`。
    expect(css).toMatch(/\.day-badges \{[^}]*min-height: 0;/);
  });

  it('C8：色带段的兜底可见宽度 + 覆盖段的视觉区分都在（防「删了没人发现」）', () => {
    expect(css).toContain('min-width: 2px;');
    expect(css).toContain('.shift-band.is-override');
  });
});
