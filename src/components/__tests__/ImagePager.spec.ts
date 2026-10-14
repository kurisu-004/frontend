// @vitest-environment happy-dom
// src/components/__tests__/ImagePager.spec.ts
//
// ImagePager 的缩放 / 平移 / 翻页模型守卫（2026-10-13 随组件同批补）。
//
// 为什么不等到出事再补：ImagePager 的语义与 `PdfViewer.spec.ts` 里逐条钉死的那些是同一套
// （fit 夹逼区间、翻页归位、用户缩放优先级），而 PdfViewer 那批用例在本文件之前就存在 ——
// 于是「同款语义、一个组件有守卫一个没有」的不对称会长期存在，后来人改 ImagePager 时
// 默认它是「没人管的组件」。
//
// 本 spec 钉的几件事（都与 PdfViewer 侧同款，每条都对应一个「全仓 spec 全绿也拦不住」的
// 静默退化）：
//   1. 默认 fit 到容器（fit 值真的落进 scale，而不是恒 1 倍）；
//   2. 翻页把 `userZoomed` / `scale` / `tx` / `ty` 一起归位（平移与缩放是 transform 里
//      两个互不干涉的量，必须分别断）；
//   3. `props.fit = false` 时 `onImageLoad` 不得用 fit 覆写；
//   4. `userZoomed` 置位后，后续图片 load 不得把用户选的比例打回 fit；
//   5. 单页不渲染翻页入口；空 pages 渲染空态；
//   6. 键盘可达（`.img-viewport` 是本组件唯一的交互面）。
// 另有一条源码契约：键盘路径**不得自己实现**翻页 / 缩放，只能转调工具栏那批函数 ——
// 两套实现必然漂，而这类漂移在 mount 用例里看不出来（键位仍能翻页，只是步长不一致）。
//
// 断言打在哪：**`.img-stage` 的 CSS transform**（`translate(tx,ty) scale(s)`）。比读组件
// 内部 ref 稳，也不需要组件暴露任何测试专用接口。组件不 import pdfjs，桩的只有
// el-button / el-button-group / el-icon 三个（图标按组件名桩，VTU 走 `<script setup>`
// 编译出的 setup binding + 组件 name 匹配，与 PdfViewer.spec.ts 同款）。

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { flushPromises, mount } from '@vue/test-utils';
import ImagePager from '../ImagePager.vue';

/** 假图的原始像素尺寸（@load 给的 naturalWidth/Height）。容器比它小 ⇒ fit 一定 < 1。 */
const IMG_W = 1000;
const IMG_H = 1000;

/** 每个用例改这两个，`.img-viewport` 的 clientWidth / clientHeight 从这里取。 */
const container = { w: 0, h: 0 };

// happy-dom 里 clientWidth/clientHeight 恒 0 ⇒ fitScale 恒返回 null。按 class 取值，
// 与 PdfViewer.spec.ts 同款（不是每个用例去改 DOM）。
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains('img-viewport') ? container.w : 0;
  },
});
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains('img-viewport') ? container.h : 0;
  },
});

function iconStub(cls: string) {
  return { name: `Icon${cls}`, template: `<i class="mock-icon mock-${cls}"></i>` };
}

const stubs = {
  'el-button-group': { template: '<div class="mock-btn-group"><slot /></div>' },
  'el-button': {
    name: 'ElButtonStub',
    props: ['disabled', 'title'],
    emits: ['click'],
    template:
      '<button :title="title" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  Picture: iconStub('picture'),
  ZoomIn: iconStub('zoom-in'),
  ZoomOut: iconStub('zoom-out'),
  Refresh: iconStub('refresh'),
  ArrowLeft: iconStub('arrow-left'),
  ArrowRight: iconStub('arrow-right'),
};

type Wrapper = ReturnType<typeof mount>;

/** 组件源码所在目录（源码契约用例要读 ImagePager.vue 本身）。 */
const COMPONENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 造 n 页直链。 */
function pages(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://cdn.test/p${i + 1}.jpg`);
}

async function mountPager(
  props: { fit?: boolean; initialScale?: number } = {},
  pageCount = 2,
): Promise<Wrapper> {
  const w = mount(ImagePager, { props: { pages: pages(pageCount), ...props }, global: { stubs } });
  await flushPromises();
  return w;
}

/**
 * 触发 `<img>` 的 load 并给一个确定的原始尺寸。
 *
 * happy-dom 不会真的去取那张 CDN 图，naturalWidth/Height 恒 0 ⇒ fitScale 恒 null。
 * 直接把 naturalWidth/Height 定好再派发 load 事件，模拟「图已解码完」那一刻。
 */
async function fireImageLoad(w: Wrapper, naturalW = IMG_W, naturalH = IMG_H): Promise<void> {
  const img = w.find('img').element as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: naturalW });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: naturalH });
  await w.find('img').trigger('load');
  await flushPromises();
}

/** stage 的 CSS transform 拆成缩放与平移两个量（都是 DOM 上的值，不读组件内部状态）。 */
function transformOf(w: Wrapper): { scale: number; tx: number; ty: number } {
  const style = w.find('.img-stage').attributes('style') ?? '';
  const s = /scale\(([\d.]+)\)/.exec(style);
  const t = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(style);
  expect(s, `stage 上没有 scale()：${style}`).not.toBeNull();
  expect(t, `stage 上没有 translate()：${style}`).not.toBeNull();
  return {
    scale: Number.parseFloat(s![1] as string),
    tx: Number.parseFloat(t![1] as string),
    ty: Number.parseFloat(t![2] as string),
  };
}

/** 按图标 class 找到它所在的工具栏按钮（+/- / 复位 / 翻页）。 */
function buttonOf(w: Wrapper, iconClass: string) {
  const icon = w.find(`.mock-${iconClass}`);
  expect(icon.exists(), `工具栏里没有 ${iconClass} 图标`).toBe(true);
  return w.findAll('button').find((b) => b.element.contains(icon.element))!;
}

/** 在 viewport 上滚轮 `n` 档（onWheel 的 factor 是 1.1）+ 拖动平移，模拟真实手势。 */
async function zoomAndPan(w: Wrapper, zoomSteps: number): Promise<void> {
  const vp = w.find('.img-viewport');
  for (let i = 0; i < zoomSteps; i += 1) {
    await vp.trigger('wheel', { deltaY: -100, clientX: 200, clientY: 200 });
  }
  await vp.trigger('mousedown', { button: 0, clientX: 400, clientY: 400 });
  await window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 700, clientY: 700 }));
  await window.dispatchEvent(new window.MouseEvent('mouseup'));
  await flushPromises();
}

beforeEach(() => {
  container.w = 0;
  container.h = 0;
});

describe('ImagePager / fit 与视图归位', () => {
  // I1：默认 fit —— 不传 fit 时 fit 值必须真的落进 scale。
  // 这条同时守住 `fit` 的**默认值 = true**：用例不传 fit，断言的却是 fit 值；
  // 把 withDefaults 里的 fit 改成 false，本条与 I3 一起红。
  it('I1：默认就 fit —— 800×800 容器装 1000×1000 图 ⇒ scale 0.8', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountPager();

    await fireImageLoad(w);
    expect(transformOf(w).scale).toBeCloseTo(0.8, 6);
    w.unmount();
  });

  // I2：翻页必须把**四样**一起归位：userZoomed（让 fit 重算）、scale、tx、ty。
  // 只清缩放不平移 ⇒ 工人翻过去看到的是新一页的一角；不清 userZoomed ⇒ 新页 load 时仍
  // 以用户缩放呈现、出容器。第二页给 500×500（fit 从 0.8 变 1.6）以便区分「重算」与「沿用」。
  it('I2：滚轮放大 + 拖动平移后翻页 —— scale 回到新页的 fit 且 tx/ty 归零', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountPager();

    await fireImageLoad(w);
    await fireImageLoad(w, 500, 500); // 模拟第二页的原始尺寸
    await zoomAndPan(w, 2);
    const panned = transformOf(w);
    expect(
      panned.tx > 1 || panned.ty > 1,
      `前置：平移应当非零（tx=${panned.tx} ty=${panned.ty}），否则这条断言恒真`,
    ).toBe(true);

    await buttonOf(w, 'arrow-right').trigger('click');
    await flushPromises();

    // 500×500 页在 800×800 容器里 fit = min(800/500, 800/500) = 1.6
    const after = transformOf(w);
    expect(after.scale, '翻页后应按新页尺寸重算 fit').toBeCloseTo(1.6, 6);
    expect(after.tx, '翻页必须把平移一起归零').toBe(0);
    expect(after.ty, '翻页必须把平移一起归零').toBe(0);
    w.unmount();
  });

  // I3：`props.fit = false` 是给「固定比例」承载点的 opt-out 口子。关掉后 `onImageLoad`
  // 里的 fit 分支整块不该跑，比例只由用户缩放改。
  it('I3：fit=false 时不套用 fit（保持 initialScale，容器尺寸不参与）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountPager({ fit: false, initialScale: 1 });

    await fireImageLoad(w);
    expect(transformOf(w).scale, 'fit 关掉后容器尺寸不参与').toBeCloseTo(1, 6);

    // opt-out 的只是 fit，不是缩放：+/- 仍然可用。
    await buttonOf(w, 'zoom-in').trigger('click');
    await flushPromises();
    expect(transformOf(w).scale).toBeCloseTo(1.2, 6);
    w.unmount();
  });

  // I4：`userZoomed` 是「用户已表态、别替他改」的那道闸。它只有一条观察得到的效果 ——
  // 闸若失效，后续图片 load 会把用户选的比例覆写成 fit 值。（内部状态读不到，但
  // 「load 之后比例不变」读得到。）
  it('I4：用户缩放过之后，后续页 load 不得把比例覆写回 fit', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountPager();

    await fireImageLoad(w);
    expect(transformOf(w).scale, '前置：先落在 fit 值').toBeCloseTo(0.8, 6);

    await buttonOf(w, 'zoom-in').trigger('click');
    await flushPromises();
    expect(transformOf(w).scale, '点 + 之后应放大到 1.0').toBeCloseTo(1.0, 6);

    // 再来一次 load（换 src / 重挂 img）：若 userZoomed 闸失效，这里会被打回 0.8。
    await fireImageLoad(w);
    expect(transformOf(w).scale, 'load 不得覆写用户已表过态的比例').toBeCloseTo(1.0, 6);
    w.unmount();
  });

  // I5：单页图纸没有「翻页」这回事，工具栏不该出现上一页 / 下一页 与页码指示。
  it('I5：单页时不渲染翻页按钮与页码', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountPager({}, 1);
    await fireImageLoad(w);

    expect(w.find('.mock-arrow-left').exists(), '单页不该有「上一页」').toBe(false);
    expect(w.find('.mock-arrow-right').exists(), '单页不该有「下一页」').toBe(false);
    expect(w.find('.page-info').exists(), '单页不该有页码指示').toBe(false);
    expect(w.find('.mock-zoom-in').exists(), '缩放入口与页数无关').toBe(true);
    w.unmount();
  });

  // I6：空 pages 渲染空态而不是白屏。
  it('I6：pages 为空渲染空态', () => {
    const w = mount(ImagePager, { props: { pages: [] }, global: { stubs } });
    expect(w.find('.empty').exists()).toBe(true);
    expect(w.find('img').exists()).toBe(false);
    w.unmount();
  });

  // I7：键盘可达。`.img-viewport` 是本组件唯一的交互面，不给它 tabindex 等于对键盘
  // 用户完全不存在；方向键 / 加减号 / 0 三组键必须转到与工具栏同一批函数上。
  it('I7：键盘可达 —— tabindex + 方向键翻页 / 加减号缩放 / 0 复位', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountPager();
    await fireImageLoad(w);

    const vp = w.find('.img-viewport');
    expect(vp.attributes('tabindex'), '交互面必须可聚焦').toBe('0');

    // 方向键翻页（与工具栏同口径：翻过去就重新适应整页）
    await vp.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(w.find('.page-info').text().trim(), '方向键翻页').toBe('2 / 2');
    const fit = transformOf(w).scale;

    // + / − 缩放：步进一档 ZOOM_STEP
    await vp.trigger('keydown', { key: '+' });
    await flushPromises();
    expect(transformOf(w).scale, '键盘 + 应当放大一档').toBeCloseTo(fit + 0.2, 6);
    await vp.trigger('keydown', { key: '-' });
    await flushPromises();
    expect(transformOf(w).scale, '键盘 − 应当缩回 fit').toBeCloseTo(fit, 6);

    // 0 复位 ⇒ 回到 fit
    await vp.trigger('keydown', { key: '+' });
    await flushPromises();
    await vp.trigger('keydown', { key: '0' });
    await flushPromises();
    expect(transformOf(w).scale, '键盘 0 应当复位到 fit').toBeCloseTo(fit, 6);
    w.unmount();
  });

  // I8：未处理的按键不能被吞 —— preventDefault 掉 Tab 会把用户卡在组件里出不来。
  it('I8：未处理的按键不 preventDefault（不劫持浏览器默认行为）', async () => {
    const w = await mountPager();
    await fireImageLoad(w);
    const e = new window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    w.find('.img-viewport').element.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    w.unmount();
  });
});

describe('ImagePager / 键盘路径与工具栏共用同一批函数', () => {
  it('onKeyDown 里只调 prevPage / nextPage / goToPage / zoomIn / zoomOut / resetView', () => {
    const src = readFileSync(join(COMPONENT_DIR, 'ImagePager.vue'), 'utf8');
    const body = /function onKeyDown\([^)]*\): void \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(body, 'ImagePager.vue 里找不到 onKeyDown 的函数体').toBeDefined();
    const calls = [...(body!.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g) ?? [])].map((m) => m[1]);
    const allowed = new Set([
      'switch',
      'prevPage',
      'nextPage',
      'goToPage',
      'zoomIn',
      'zoomOut',
      'resetView',
      'preventDefault',
    ]);
    for (const c of calls) {
      expect(
        allowed.has(c),
        `onKeyDown 里出现了白名单外的调用 ${c}：键盘路径应只转调工具栏那批函数，否则两套实现必然漂`,
      ).toBe(true);
    }
  });
});
