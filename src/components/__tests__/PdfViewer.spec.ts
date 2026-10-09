// @vitest-environment happy-dom
// src/components/__tests__/PdfViewer.spec.ts
//
// PdfViewer「默认 fit 到容器」的回归守卫。
//
// 为什么这批用例以前不存在（2026-10-11 补）：fit 那次改动把 `render()` 改成每次都按
// 容器尺寸覆写 `renderScale`，而 `zoomIn` / `zoomOut` 的实现恰恰是「改 renderScale →
// 调 render()」—— 刚写进去的值在同一次调用里被抹掉，净效果是**点 +/- 视觉零变化**
// （唯一残留效果是把 viewScale 重置为 1，观感上像「缩小回原样」）。这条回归不需要任何
// 报错、不改任何 DOM 结构，**全仓 spec 全绿也拦不住它**。
//
// 断言打在哪：**canvas 的 CSS 宽**（`renderScale * 页宽@scale1`，与 devicePixelRatio 无关
// —— viewport 用 `scale * dpr` 出像素、再除 dpr 得 css 尺寸，两者正好抵消）。
// 比读内部 ref 稳，也不需要组件暴露任何测试专用接口。
//
// pdfjs 桩：组件走 `@/utils/pdfjs` 单点入口（CLAUDE.md #6），桩掉整个模块即可，
// 不碰真实 pdfjs-dist / worker。本文件只需要三样东西：
//   - getDocument → 一个 numPages 页、getPage 给出确定尺寸的假文档；
//   - getViewport({scale}) → 尺寸线性于 scale（真实 pdfjs 就是线性的）；
//   - render() → 返回一个带 promise / cancel 的任务对象（不真的画像素）。

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PdfViewer from '../PdfViewer.vue';

/** 假文档的页宽 / 页高（scale = 1 时的 CSS 尺寸）。容器比它小 ⇒ fit 一定 < 1。 */
const PAGE_W = 1000;
const PAGE_H = 1000;

/** 每个用例改这两个，桩的 clientWidth / clientHeight 从这里取。 */
const container = { w: 0, h: 0 };

/** 记录最近一次真正被拿来渲染的 scale —— 断言「fit 值算进了 renderScale」最直接的一手。 */
const renderedScales: number[] = [];

const h = vi.hoisted(() => ({
  cleanup: vi.fn(),
  getDocument: vi.fn(),
}));

vi.mock('@/utils/pdfjs', () => ({
  pdfjsLib: { getDocument: (opts: unknown) => h.getDocument(opts) },
  PDF_CMAP_OPTIONS: {},
}));

/** 一页假 PDF：getViewport 的尺寸线性于 scale（真实 pdfjs 就是线性的）。 */
function makePage(w: number, hgt: number) {
  return {
    getViewport: ({ scale }: { scale: number }) => {
      const vp = {
        width: w * scale,
        height: hgt * scale,
        /** 记录渲染比例：断言「fit 值算进了 renderScale」最直接的一手数据。 */
        scale,
      };
      return vp;
    },
    render: ({ viewport }: { viewport: { scale: number } }) => {
      renderedScales.push(viewport.scale);
      return { promise: Promise.resolve(), cancel: vi.fn() };
    },
  };
}

/** 一份假文档：页尺寸逐页给定（用于验「翻页按新页重算 fit」）。 */
function fakeDoc(pages: { w: number; h: number }[]) {
  return {
    numPages: pages.length,
    cleanup: h.cleanup,
    getPage: (n: number) => Promise.resolve(makePage(pages[n - 1]!.w, pages[n - 1]!.h)),
  };
}

// `.pdf-viewport` 的 clientWidth / clientHeight 在 happy-dom 里恒为 0 ⇒ fit 恒算不出来。
// 在原型上按用例配置给值，而不是每个用例去改 DOM —— render() 发生在 load() 的
// await 链之后（getDocument().promise → nextTick），mount 之后立刻设也能赶上，
// 但读 case 配置比跟时序赛跑稳。
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains('pdf-viewport') ? container.w : 0;
  },
});
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains('pdf-viewport') ? container.h : 0;
  },
});
// happy-dom 无 2d 上下文 ⇒ 组件在 `if (!ctx) return` 处提前返回。这里补一个空上下文，
// 让 render() 走完整条路径（stage 尺寸 / renderTask 赋值也一并覆盖）。
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement['getContext'];

/** 图标桩：按名字落成可定位的 class，工具栏按钮靠它区分（工具栏里没有别的文字锚点）。 */
function iconStub(cls: string) {
  return { name: `Icon${cls}`, template: `<i class="mock-icon mock-${cls}"></i>` };
}

const stubs = {
  'el-button-group': { template: '<div class="mock-btn-group"><slot /></div>' },
  'el-button': {
    name: 'ElButtonStub',
    props: ['disabled', 'loading', 'title', 'circle', 'type', 'size'],
    emits: ['click'],
    template:
      '<button :title="title" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  'el-icon': { name: 'ElIconStub', template: '<i class="mock-icon"><slot /></i>' },
  ZoomIn: iconStub('zoom-in'),
  ZoomOut: iconStub('zoom-out'),
  Refresh: iconStub('refresh'),
  ArrowLeft: iconStub('arrow-left'),
  ArrowRight: iconStub('arrow-right'),
  Download: iconStub('download'),
  Loading: iconStub('loading'),
  CircleClose: iconStub('circle-close'),
};

type Wrapper = ReturnType<typeof mount>;

/**
 * 捕获组件挂上的 ResizeObserver，好让用例手动触发它的回调。
 *
 * 为什么需要：容器尺寸为 0 时组件记一笔 `fitPending`，等容器拿到尺寸后**由这个观察者
 * 补渲一次**（见 `PdfViewer.vue::ensureResizeObserver`）。happy-dom 虽然实现了
 * ResizeObserver，但不会真的在元素尺寸变化时回调，桩掉才能驱动那条路径。
 */
let roCallbacks: (() => void)[] = [];

class FakeResizeObserver {
  public constructor(cb: () => void) {
    roCallbacks.push(cb);
  }
  public observe(): void {}
  public unobserve(): void {}
  public disconnect(): void {}
}

beforeAll(() => {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

async function mountViewer(
  props: { url?: string; initialScale?: number; fit?: boolean; page?: number } = {},
  pages: { w: number; h: number }[] = [{ w: PAGE_W, h: PAGE_H }],
): Promise<Wrapper> {
  h.getDocument.mockReturnValue({ promise: Promise.resolve(fakeDoc(pages)) });
  const w = mount(PdfViewer, {
    props: { url: 'https://example.test/a.pdf', ...props },
    global: { stubs },
  });
  await flushPromises();
  await flushPromises();
  await flushPromises();
  return w;
}

/** 画布的 CSS 宽（= renderScale × 页宽@scale1）。fit 的断言全部打在它上面。 */
function canvasWidth(w: Wrapper): number {
  return Number.parseFloat(w.find('canvas').element.style.width);
}

/**
 * 视觉总缩放（stage 上的 CSS transform `scale(...)`）= renderScale × viewScale。
 * 只打 renderScale 侧（`renderedScales`）看不出 viewScale 有没有归位 —— 滚轮缩放
 * 之后两者会分叉，这条 helper 就是给「两个量都要归位」那类断言用的。
 */
function totalScaleOf(w: Wrapper): number {
  const style = w.find('.pdf-canvas-stage').attributes('style') ?? '';
  const m = /scale\(([\d.]+)\)/.exec(style);
  expect(m, `stage 上没有 scale()：${style}`).not.toBeNull();
  return Number.parseFloat(m![1] as string);
}

/**
 * 视觉平移（stage 上的 CSS transform `translate(...)`）。与两个 scale 互不干涉：
 * 只清 `viewScale` / `userZoomed` 对它**完全无效**，必须单独钉。
 */
function panOf(w: Wrapper): { tx: number; ty: number } {
  const style = w.find('.pdf-canvas-stage').attributes('style') ?? '';
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(style);
  expect(m, `stage 上没有 translate()：${style}`).not.toBeNull();
  return { tx: Number.parseFloat(m![1] as string), ty: Number.parseFloat(m![2] as string) };
}

/** 在 stage 上滚轮 `n` 档（onWheel 的 factor 是 1.1）+ 从 from 拖到 to，模拟真实手势。 */
async function zoomAndPan(w: Wrapper, n: number): Promise<void> {
  const vp = w.find('.pdf-viewport');
  for (let i = 0; i < n; i++) {
    await vp.trigger('wheel', { deltaY: -100, clientX: 200, clientY: 200 });
  }
  await vp.trigger('mousedown', { button: 0, clientX: 400, clientY: 400 });
  await window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 700, clientY: 700 }));
  await window.dispatchEvent(new window.MouseEvent('mouseup'));
  await flushPromises();
}

/** 按图标 class 找到它所在的工具栏按钮（+ / − / 复位 / 翻页）。 */
function buttonOf(w: Wrapper, iconClass: string) {
  const icon = w.find(`.mock-${iconClass}`);
  expect(icon.exists(), `工具栏里没有 ${iconClass} 图标`).toBe(true);
  return w.findAll('button').find((b) => b.element.contains(icon.element))!;
}

beforeEach(() => {
  container.w = 0;
  container.h = 0;
  renderedScales.length = 0;
  roCallbacks.length = 0;
  h.cleanup.mockReset();
  h.getDocument.mockReset();
});

describe('PdfViewer / fit 到容器', () => {
  // P1：fit 值必须真的进 renderScale（否则整个「默认 fit」是空转的）。
  // 这条同时守住了 `fit` 的**默认值 = true**：用例不传 fit，断言却是 fit 值；
  // 把 withDefaults 里的 fit 改成 false，P1 与 P10 一起红。
  it('P1：默认就 fit —— 不传 fit 时 fit 值算进 renderScale（800×800 容器装 1000×1000 页 ⇒ 0.8）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer();

    expect(canvasWidth(w)).toBe(800);
    expect(renderedScales.at(-1)).toBeCloseTo(0.8, 6);
    w.unmount();
  });

  // ⛔ 本条就是那条回归：zoomIn 写进去的 renderScale 被随后的 render() 覆写成 fit 值。
  // 症状是「点 +/- 视觉零变化」，任何报错都不会有。
  it('P2：zoomIn / zoomOut 之后 renderScale 不再被 fit 回退', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer();
    expect(canvasWidth(w), '前置：先落在 fit 值 800px').toBe(800);

    await buttonOf(w, 'zoom-in').trigger('click');
    await flushPromises();
    expect(canvasWidth(w), '点 + 之后画布应变大（0.8 → 1.0）').toBe(1000);

    await buttonOf(w, 'zoom-out').trigger('click');
    await flushPromises();
    expect(canvasWidth(w), '点 − 之后画布应变小（1.0 → 0.8）').toBe(800);

    // 再走一轮，确认不是「第一次恰好没被覆盖」
    await buttonOf(w, 'zoom-out').trigger('click');
    await flushPromises();
    expect(canvasWidth(w), '第二次点 − 应继续低于 fit（0.8 → 0.6）').toBe(600);
    w.unmount();
  });

  it('P3：复位回到 fit 后的大小（而不是停在用户缩放的比例上）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer();

    await buttonOf(w, 'zoom-in').trigger('click');
    await flushPromises();
    expect(canvasWidth(w)).toBe(1000);

    await buttonOf(w, 'refresh').trigger('click');
    await flushPromises();
    expect(canvasWidth(w), '复位 = 回到整页塞进容器的大小').toBe(800);
    w.unmount();
  });

  // 翻页清 userZoomed：图纸各页图幅不同，保留上一页缩放会让下一张图出容器 / 看不清。
  // 第二页给 500×500（第一页 1000×1000）：fit 从 0.8 变成 1.6，可区分。
  // ⚠️ 断言打在**渲染比例**上而不是 canvas 宽：fit 之后画布宽恒等于容器的受限边
  // （800），两种 fit 结果的 canvas 宽一样，看不出区别；而比例 1.6（重算）vs
  // 1.0（沿用用户缩放）一眼可辨。
  it('P4：翻页重算 fit（每页各自适应）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer({}, [
      { w: PAGE_W, h: PAGE_H },
      { w: 500, h: 500 },
    ]);
    expect(renderedScales.at(-1)).toBeCloseTo(0.8, 6);

    await buttonOf(w, 'zoom-in').trigger('click');
    await flushPromises();
    expect(renderedScales.at(-1), '前置：用户放大到 1.0').toBeCloseTo(1.0, 6);

    await buttonOf(w, 'arrow-right').trigger('click');
    await flushPromises();
    // 500×500 页在 800×800 容器里 fit = min(800/500, 800/500) = 1.6
    expect(renderedScales.at(-1), '翻页后应按新页尺寸重算 fit').toBeCloseTo(1.6, 6);
    w.unmount();
  });

  it('P5：容器尺寸为 0（宿主尚未布局）时回落 initialScale', async () => {
    container.w = 0;
    container.h = 0;
    const w = await mountViewer({ initialScale: 1.5 });

    expect(canvasWidth(w), '量不到容器时不得算出 NaN/0，按 initialScale 渲染').toBe(1500);
    w.unmount();
  });

  // 滚轮与 +/- 同级：它只动 viewScale（CSS transform），但同样表达「我要看多大」，
  // 所以 onWheel 也置位 userZoomed。翻页必须**同时**清 userZoomed 与把 viewScale 归 1 ——
  // 只清前者的话 renderScale 回到 fit、viewScale 留着，下一页仍以「fit × 自己的缩放」
  // 呈现、出容器（净效果 totalScale ≠ fit）。
  // 断言同时打两个量：renderScale 侧的 `renderedScales`，viewScale 侧的 stage transform。
  it('P6：滚轮放大后翻页 —— renderScale 回到 fit 且 viewScale 回到 1（净效果整页塞进容器）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer({}, [
      { w: PAGE_W, h: PAGE_H },
      { w: PAGE_W, h: PAGE_H },
    ]);

    // 连滚两档（onWheel 的 factor 是 1.1）
    const vp = w.find('.pdf-viewport');
    await vp.trigger('wheel', { deltaY: -100 });
    await vp.trigger('wheel', { deltaY: -100 });
    expect(totalScaleOf(w), '前置：滚轮两档后 totalScale 应为 0.8 × 1.1²').toBeCloseTo(0.968, 3);
    // 滚轮不动 renderScale ⇒ 画布仍是 fit 那一份（这是滚轮与 +/- 的区别）
    expect(renderedScales.at(-1)).toBeCloseTo(0.8, 6);

    await buttonOf(w, 'arrow-right').trigger('click');
    await flushPromises();

    // 两个量都要归位：fit 重算 + CSS 缩放归 1
    expect(renderedScales.at(-1), '翻页后 renderScale 应重算 fit').toBeCloseTo(0.8, 6);
    expect(totalScaleOf(w), '翻页后 viewScale 必须归 1，否则仍是 fit × 自己的缩放').toBeCloseTo(
      0.8,
      6,
    );
    w.unmount();
  });

  // 「翻页 = 回到整页塞进容器的大小」要成立，平移也得归位：`tx`/`ty` 是 stage 上的
  // CSS translate，与 renderScale / viewScale **互不干涉** —— 前两条用例把缩放类变量
  // 全钉住了，翻页照样可以带着上一页的平移不放，工人翻过去看到的是新一页的一角。
  it('P7：滚轮 + 拖动平移后翻页 —— tx/ty 归 0（整页真的塞回容器左上角）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer({}, [
      { w: PAGE_W, h: PAGE_H },
      { w: PAGE_W, h: PAGE_H },
    ]);

    await zoomAndPan(w, 2);
    const panned = panOf(w);
    expect(
      panned.tx > 1 || panned.ty > 1,
      `前置：平移应当非零（实际 tx=${panned.tx} ty=${panned.ty}），否则这条断言是恒真`,
    ).toBe(true);

    await buttonOf(w, 'arrow-right').trigger('click');
    await flushPromises();

    expect(panOf(w), '翻页必须把平移一起归零').toEqual({ tx: 0, ty: 0 });
    // 顺带确认缩放侧没被这次改动带坏
    expect(totalScaleOf(w)).toBeCloseTo(0.8, 6);
    w.unmount();
  });

  // P6 只证明「翻页清 viewScale」；onWheel 自己置位 userZoomed 的效果体现在**另一条
  // render() 路径**上：容器尺寸为 0（fit 算不出来、记一笔 fitPending）→ 用户滚轮表态 →
  // 容器就绪、ResizeObserver 补渲一次。那一次 render() 若无视 userZoomed，就会把
  // renderScale 从 initialScale 覆写成 fit，正是「fit 覆掉用户选择」那条回归的同款。
  it('P8：fit 还没算出来的窗口里滚轮表过态 ⇒ ResizeObserver 补渲不得覆写 renderScale', async () => {
    container.w = 0; // 宿主尚未布局：首次 render 算不出 fit，落回 initialScale 并记 fitPending
    container.h = 0;
    const w = await mountViewer({ initialScale: 1 });
    expect(canvasWidth(w), '前置：量不到容器时按 initialScale 渲染').toBe(1000);

    await w.find('.pdf-viewport').trigger('wheel', { deltaY: -100 });

    // 容器就绪 → 观察者回调触发补渲
    container.w = 800;
    container.h = 800;
    expect(
      roCallbacks.length,
      '组件没有挂上 ResizeObserver（fit 失败时的补渲通道）',
    ).toBeGreaterThan(0);
    const before = renderedScales.length;
    for (const cb of roCallbacks) cb();
    await flushPromises();

    // ⚠️ 先断言「补渲确实发生了」：否则下面两条会在**根本没有第二次渲染**的情况下
    // 以「什么都没发生」的方式通过（`renderedScales.at(-1)` 仍是首次渲染的
    // initialScale），把 `fitPending` 整段删掉都测不出来。
    expect(
      renderedScales.length,
      'ResizeObserver 补渲没有发生 —— fit 失败时的补渲通道坏了，这条用例已失去意义',
    ).toBeGreaterThan(before);

    // 用户已表态 ⇒ renderScale 保持 initialScale（1.0），不被 fit 的 0.8 覆写
    expect(renderedScales.at(-1), '补渲不得覆写用户已表过态的比例').toBeCloseTo(1.0, 6);
    expect(totalScaleOf(w), '净效果 = 保留的 1.0 × 滚轮的 1.1').toBeCloseTo(1.1, 6);
    w.unmount();
  });

  // P8 的另一半：`fitPending` 这道闸的**另一侧**。fit 已经算出来（没有欠账）时，
  // ResizeObserver 回调必须**什么都不做** —— 跟着每次尺寸变化重渲会改
  // canvas.width/height/style，产生 layout shift 抖动（见 PdfViewer.vue 的
  // ensureResizeObserver 注释）。没有这条，把 `if (!fitPending) return` 整段删掉
  // （观察者退化成「每次尺寸变化都重渲」）时全仓仍绿，而那正是被明令禁止的行为。
  it('P11：fit 已算出来时 ResizeObserver 回调不动作（不许跟着每次尺寸变化重渲）', async () => {
    container.w = 800; // 正常尺寸 ⇒ 首渲就算出 fit，没有欠账
    container.h = 800;
    const w = await mountViewer();
    expect(roCallbacks.length, '组件没有挂上 ResizeObserver').toBeGreaterThan(0);
    const before = renderedScales.length;
    expect(before, '前置：首屏渲染应当已经发生').toBeGreaterThan(0);

    for (const cb of roCallbacks) cb();
    await flushPromises();

    expect(
      renderedScales.length,
      '没有 fit 欠账却重渲了 —— `if (!fitPending) return` 这道闸被删了，会造成 layout shift 抖动',
    ).toBe(before);
    w.unmount();
  });

  // `props.page` 是另一条换页通道（PartBatchPdfTab 传 `:page`），它与工具栏翻页同口径：
  // 都走 resetView。少归位任一项，滚轮用户在这里换页就会带着自己的 CSS 缩放 / 平移 ——
  // 与 P6 / P7 是同一个缺陷的两条入口。
  it('P9：外部改 page prop 后同样重算 fit 且 viewScale 归 1', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer({ page: 1 }, [
      { w: PAGE_W, h: PAGE_H },
      { w: PAGE_W, h: PAGE_H },
    ]);

    const vp = w.find('.pdf-viewport');
    await vp.trigger('wheel', { deltaY: -100 });
    await vp.trigger('wheel', { deltaY: -100 });
    expect(totalScaleOf(w), '前置：滚轮两档后 totalScale ≠ fit').toBeCloseTo(0.968, 3);

    await w.setProps({ page: 2 });
    await flushPromises();

    expect(renderedScales.at(-1)).toBeCloseTo(0.8, 6);
    expect(totalScaleOf(w), '外部换页与工具栏翻页同口径').toBeCloseTo(0.8, 6);
    w.unmount();
  });

  // fit 是 opt-out 口子：将来某个承载点要固定比例时传 :fit="false" 即可，
  // 不必改组件本体。默认值为 true（全仓所有 <PdfViewer> 承载点都要 fit）。
  it('P10：fit=false 时不套用 fit（按 initialScale 渲染，与容器尺寸无关）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer({ fit: false, initialScale: 1 });

    expect(canvasWidth(w), 'fit 关掉后容器尺寸不参与渲染').toBe(1000);
    // 且 +/- 仍然可用（opt-out 的只是 fit，不是缩放）
    await buttonOf(w, 'zoom-in').trigger('click');
    await flushPromises();
    expect(canvasWidth(w)).toBe(1200);
    w.unmount();
  });
});
