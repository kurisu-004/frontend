// @vitest-environment happy-dom
// src/components/__tests__/PdfViewer.spec.ts
//
// 两组守卫：
//   · P 组 —— 「默认 fit 到容器」的缩放 / 翻页 / 平移契约（2026-10-11 补）；
//   · W 组 —— loadingTask 即 pdf.js worker 线程的生命周期（2026-10-20 补，含换文件的
//     并发竞态、url 清空、以及「释放路径自持 UI 状态 / 取页失败分竞态与真失败」几条边界）。
//
// 为什么 P 组以前不存在（2026-10-11 补）：fit 那次改动把 `render()` 改成每次都按
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
// 2026-10-20 起再加第四样：`getDocument` 返回的 **loadingTask** 带 `destroy()` ——
// 真实 pdf.js 里它是唯一能终止 worker 线程的句柄，Worker 泄漏那批用例就打在它身上。

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
  getDocument: vi.fn(),
}));

vi.mock('@/utils/pdfjs', () => ({
  pdfjsLib: { getDocument: (opts: unknown) => h.getDocument(opts) },
  PDF_CMAP_OPTIONS: {},
}));

/** 一个 loadingTask 桩：`promise` 可控（延迟 resolve 用），`destroy` 单独一个 spy。 */
interface FakeLoadingTask {
  promise: Promise<unknown>;
  destroy: ReturnType<typeof vi.fn>;
}

/** 本次用例里创建过的 loadingTask，按创建顺序。断言「销毁了哪一个」全靠它。 */
const createdTasks: FakeLoadingTask[] = [];

/**
 * 「建 task 的这一刻，全局已经发起过多少次 destroy」，与 `createdTasks` 同序。
 *
 * 存在的理由：**只断言 destroy 的调用次数钉不住顺序** —— 把「先 await 释放旧 task」
 * 挪到 `getDocument()` 之后（旧线程还没终止就建新线程），新旧 task 各被 destroy 一次，
 * 次数一条不差，全绿。要钉住「新 task 建出来之前旧 task 已经发起销毁」，只能在
 * 建 task 的当场把已有的 destroy 次数记下来。
 */
const destroyCallsBeforeCreate: number[] = [];

function makeLoadingTask(doc: Promise<unknown>): FakeLoadingTask {
  const task: FakeLoadingTask = { promise: doc, destroy: vi.fn(() => Promise.resolve()) };
  createdTasks.push(task);
  destroyCallsBeforeCreate.push(
    createdTasks.reduce((sum, t) => sum + t.destroy.mock.calls.length, 0),
  );
  return task;
}

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
  // 每次 getDocument 都造一个新 task（真实 pdf.js 就是一个 task 对应一个 worker），
  // 并登记到 createdTasks —— Worker 泄漏那批用例靠它分辨「销毁的是哪一个」。
  h.getDocument.mockImplementation(() => makeLoadingTask(Promise.resolve(fakeDoc(pages))));
  const w = mount(PdfViewer, {
    props: { url: 'https://example.test/a.pdf', ...props },
    global: { stubs },
  });
  await flushAll();
  return w;
}

/**
 * 连刷若干轮微任务：`load()` 的 await 链有六段（释放旧 task → `task.promise` →
 * `nextTick` → `getPage` → `renderTask.promise`），单轮 `flushPromises()` 常常只跑到链
 * 中段。凡是要「等整条链跑完」的断言都必须用它。
 */
async function flushAll(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await flushPromises();
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
  createdTasks.length = 0;
  destroyCallsBeforeCreate.length = 0;
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

/**
 * loadingTask（pdf.js worker 线程）的生命周期。
 *
 * `getDocument()` 每次返回一个 loadingTask，真实 pdf.js 会为它 new 一个 Worker；
 * `task.destroy()` 是唯一能终止那个线程的句柄。承载弹窗是 destroy-on-close，所以
 * 「用完即弃的局部变量」等价于「每打开一次图纸预览就漏一个线程」——而图纸预览是
 * 工人全天的高频动作，常驻 HMI 上线程数与内存单调上涨。这类回归不产生任何报错，
 * 全仓其它 spec 也拦不住它，只能把 loadingTask 的桩显式做出来盯着。
 */
describe('PdfViewer / pdf.js Worker 生命周期', () => {
  /** 读 setup state（`<script setup>` 的绑定都在里面；VTU 的 vm proxy 透出 setupState）。 */
  function stateOf(w: Wrapper): { loading: boolean; error: string | null; totalPages: number } {
    return w.vm as unknown as { loading: boolean; error: string | null; totalPages: number };
  }

  it('W1：unmount 时对已创建的 loadingTask 调 destroy（不释放就等于每开一次预览漏一个线程）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer();
    expect(createdTasks.length, '前置：应当已经建了一个 loadingTask').toBe(1);
    expect(createdTasks[0]!.destroy, '前置：task 上必须有 destroy 句柄').toBeDefined();

    w.unmount();
    await flushPromises();

    expect(
      createdTasks[0]!.destroy,
      '卸载时没有终止 worker —— destroy-on-close 的承载弹窗每开一次就漏一个线程',
    ).toHaveBeenCalledTimes(1);
  });

  it('W2：props.url 变化时旧 task 被 destroy、新 task 被创建（旧 worker 不能留着叠着）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer();
    expect(createdTasks.length).toBe(1);
    // ⚠️ 记下换文件**之前**的渲染条数：`renderedScales` 在 beforeEach 清零，而首次
    // load 已经渲染过一次，直接断言 `> 0` 是近似恒真的 —— 新文档根本没加载出来也照样
    // 绿。要证明的是「切换之后又渲染过」，不是「曾经渲染过」。
    const rendersBefore = renderedScales.length;
    expect(rendersBefore, '前置：首屏渲染应当已经发生').toBeGreaterThan(0);

    await w.setProps({ url: 'https://example.test/b.pdf' });
    await flushAll();

    expect(createdTasks.length, '换文件应当新建一个 loadingTask').toBe(2);
    expect(
      createdTasks[0]!.destroy,
      '换文件时旧 task 没被销毁 —— 每切一次文件就漏一个 worker',
    ).toHaveBeenCalledTimes(1);
    expect(createdTasks[1]!.destroy, '新 task 此时还活着，不能被提前销毁').not.toHaveBeenCalled();
    // 顺序闸：新 task 建出来的那一刻，旧 task 的销毁**已经发起**（只断言调用次数钉不住
    // 顺序 —— 先建后销毁时两条各被 destroy 一次，次数一样、全绿，而新旧 worker 会并存）。
    expect(
      destroyCallsBeforeCreate[1],
      '新 task 建出来之前旧 task 的 destroy 还没发起 —— 新旧 worker 会并存，峰值线程数跟着涨',
    ).toBeGreaterThan(0);
    // 换文件后确实又渲染过新文档（销毁旧 task 不能把新文档一起带走）
    expect(
      renderedScales.length,
      '换文件后应当**又**渲染过新文档（不是把首屏那次渲染当数）',
    ).toBeGreaterThan(rendersBefore);

    w.unmount();
    await flushAll();
    expect(createdTasks[1]!.destroy, '最终卸载时新 task 也要被销毁').toHaveBeenCalledTimes(1);
  });

  // 关弹窗时 `task.promise` 可能还没 settle。无守卫时它照样跑完并把 doc / 页数写进
  // 已卸载的视图 —— 那是同一个 worker 泄漏路径的上游：写回之后没人再会去销毁它。
  it('W3：卸载后才 resolve 的 load 不再写回状态（页数不落进已卸载的视图）', async () => {
    let resolveDoc: ((d: unknown) => void) | null = null;
    h.getDocument.mockImplementation(() =>
      makeLoadingTask(new Promise((res) => (resolveDoc = res))),
    );
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/slow.pdf' },
      global: { stubs },
    });
    await flushPromises();
    expect(stateOf(w).loading, '前置：还卡在 task.promise 上，界面处于加载中').toBe(true);

    w.unmount();
    await flushPromises();
    expect(createdTasks[0]!.destroy, '前置：卸载已终止 worker').toHaveBeenCalledTimes(1);

    resolveDoc!(fakeDoc([{ w: PAGE_W, h: PAGE_H }]));
    await flushPromises();
    await flushPromises();

    expect(stateOf(w).totalPages, '卸载后不得把迟到的 doc 写回状态').toBe(0);
  });

  // 真实 pdf.js 里，被 destroy 掉的 task 会以 "Worker was destroyed" / "Loading aborted"
  // 拒绝 loadingTask 的 promise（见 pdf.mjs 的 `Loading aborted` / `Worker was destroyed`
  // 两个抛出点）。把它当加载失败上屏 = 切文件 / 关弹窗时闪一句假报错，所以「不上屏」
  // 与「不写回」是同一道守卫的两面，用各自的桩分开钉。
  it('W4：被自己 destroy 掉的 task 拒绝 promise 时不当成加载失败（不上屏）', async () => {
    let rejectDoc: ((r: unknown) => void) | null = null;
    const doc = new Promise((_, rej) => (rejectDoc = rej));
    h.getDocument.mockImplementation(() => {
      const task = makeLoadingTask(doc);
      // 真实行为：destroy 终止传输 ⇒ loadingTask 的 promise 以 "Worker was destroyed" 拒绝
      task.destroy.mockImplementation(() => {
        rejectDoc!(new Error('Worker was destroyed'));
        return Promise.resolve();
      });
      return task;
    });
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/slow.pdf' },
      global: { stubs },
    });
    await flushPromises();

    w.unmount();
    await flushPromises();
    await flushPromises();

    const st = stateOf(w);
    expect(st.error, '自己销毁掉的 task 造成的拒绝不是加载失败，不得上屏').toBeNull();
    expect(st.totalPages, '也不得把这次拒绝当成「加载完成」写页数').toBe(0);
  });

  // 释放是 best-effort：destroy() 失败不该冒泡成未处理拒绝（unmount 是同步流程，
  // 抛出去会打断整条卸载链），但也不能静默吞掉 —— 记一行 warn，沿用本仓既有风格。
  it('W5：destroy 失败时只记 warn，不产生未处理拒绝', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    container.w = 800;
    container.h = 800;
    h.getDocument.mockImplementation(() => {
      const task = makeLoadingTask(Promise.resolve(fakeDoc([{ w: PAGE_W, h: PAGE_H }])));
      task.destroy.mockImplementation(() => Promise.reject(new Error('worker 已死')));
      return task;
    });
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/a.pdf' },
      global: { stubs },
    });
    await flushPromises();
    await flushPromises();

    w.unmount();
    await flushPromises();

    expect(warn, '释放失败被静默吞掉了，排查时看不出线程为什么没回收').toHaveBeenCalled();
    expect(String(warn.mock.calls.at(-1)?.[0] ?? '')).toContain('worker 已死');
    warn.mockRestore();
  });

  // 竞态本体：`load()` 要先 await 释放旧 task，而那个 await 期间完全可能有新的 load 打
  // 进来。于是「谁最后写 loadingTask」与「谁最后调 load()」分了家 —— 被抢跑的那次醒来后
  // 会再建一个 task 并覆盖 loadingTask，被它盖掉的那一份从此再没有句柄能 destroy
  // （这恰好把本组要消灭的 worker 泄漏又造回来），还会对同一份文档多下一次重复下载。
  //
  // 放大器：让 a 的 task 的 destroy 迟迟不 resolve（真实 worker 终止本来就有异步尾巴），
  // 保证第二次换 url 一定落在那个窗口里。
  it('W6：旧 task 的 destroy 未回来时又换了一次 url —— 只建两份 task，且最终渲染的是 props.url 那份', async () => {
    container.w = 800;
    container.h = 800;
    // 每个 url 一份可辨认的文档：800×800 容器下 fit 分别是 0.8 / 1.0 / 2.0。
    const edgeOf: Record<string, number> = {
      'https://example.test/a.pdf': 1000,
      'https://example.test/b.pdf': 800,
      'https://example.test/c.pdf': 400,
    };
    let current = 'https://example.test/a.pdf';
    let releaseDestroy: (() => void) | null = null;
    h.getDocument.mockImplementation(() => {
      const edge = edgeOf[current]!;
      const task = makeLoadingTask(Promise.resolve(fakeDoc([{ w: edge, h: edge }])));
      if (current.endsWith('/a.pdf')) {
        task.destroy.mockImplementation(
          () =>
            new Promise<void>((res) => {
              releaseDestroy = () => res();
            }),
        );
      }
      return task;
    });
    const w = mount(PdfViewer, { props: { url: current }, global: { stubs } });
    await flushAll();
    expect(createdTasks.length, '前置：首次加载应当建了一个 task').toBe(1);
    expect(renderedScales.at(-1), '前置：a.pdf 的 fit = 800/1000').toBeCloseTo(0.8, 6);

    // 第 1 次换 url：load#2 释放 taskA，卡在它的 destroy 上
    current = 'https://example.test/b.pdf';
    await w.setProps({ url: current });
    await flushAll();
    expect(releaseDestroy, '前置：b 的 load 应当正卡在 taskA 的 destroy 上').not.toBeNull();

    // 第 2 次换 url：正落在上面那个窗口里（taskA 还没销毁完）
    current = 'https://example.test/c.pdf';
    await w.setProps({ url: current });
    await flushAll();
    releaseDestroy!();
    await flushAll();

    expect(
      createdTasks.length,
      '被抢跑的那次 load 不该再建 task —— 建出来就没人能 destroy 它（孤儿 worker 线程）',
    ).toBe(2);
    expect(createdTasks[0]!.destroy, 'a 的 task 应当已被销毁').toHaveBeenCalledTimes(1);
    expect(createdTasks[1]!.destroy, 'c 的 task 此时还活着').not.toHaveBeenCalled();
    expect(
      renderedScales.at(-1),
      '最后渲染的必须是 props.url 当前指向的那份（c.pdf 的 fit = 800/400 = 2.0）',
    ).toBeCloseTo(2.0, 6);

    w.unmount();
    await flushAll();
    // 无孤儿的不变量收口：卸载之后，每一个建出来过的 task 都恰好被销毁过一次。
    for (const [i, task] of createdTasks.entries()) {
      expect(
        task.destroy,
        `第 ${i + 1} 个 task 从头到尾没被 destroy —— 它的 worker 线程会一直活着`,
      ).toHaveBeenCalledTimes(1);
    }
  });

  // `load()` 的 `if (!props.url) return` 排在释放之前时，url 被清空（宿主收起预览）
  // 这条路径会把上一份的 worker 丢在后台跑完 —— 等于换一种写法复现同一个泄漏。
  it('W7：props.url 被清空时释放旧 task（这也是一条释放路径，不能只 return）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer();
    expect(createdTasks.length).toBe(1);

    await w.setProps({ url: '' });
    await flushAll();

    expect(createdTasks.length, 'url 为空时不该再建 task').toBe(1);
    expect(
      createdTasks[0]!.destroy,
      'url 被清空时没有释放 —— 旧 worker 会留在后台一直跑',
    ).toHaveBeenCalledTimes(1);
    w.unmount();
    await flushAll();
  });

  it('W8：挂载时 url 就为空则一个 task 都不建（getDocument 拿不到可加载的东西）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer({ url: '' });

    expect(createdTasks.length, 'url 为空却建了 task —— 一个空下载的 worker 线程').toBe(0);
    expect(h.getDocument, 'url 为空却发了 getDocument').not.toHaveBeenCalled();
    w.unmount();
  });

  // render() 的 await 窗口：getPage 在途时组件被卸载，醒来后 canvas 已被移除 ——
  // 继续往下摸 canvas.width 是 TypeError，而 render 由复位 / +/- / ResizeObserver 以
  // void 调用，抛出去就是一条未处理拒绝。
  it('W9：卸载发生在 render() 的 getPage 在途时 —— 醒来不再摸已卸载的 canvas', async () => {
    container.w = 800;
    container.h = 800;
    let releasePage: (() => void) | null = null;
    h.getDocument.mockImplementation(() =>
      makeLoadingTask(
        Promise.resolve({
          numPages: 1,
          getPage: () =>
            new Promise((res) => {
              releasePage = () => res(makePage(PAGE_W, PAGE_H));
            }),
        }),
      ),
    );
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', collect);
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/slow.pdf' },
      global: { stubs },
    });
    try {
      await flushAll();
      expect(releasePage, '前置：render() 应当正卡在 getPage 上').not.toBeNull();

      w.unmount();
      releasePage!();
      // 未处理拒绝是在微任务队列排空之后的下一个宏任务才派发的，所以要多等一轮定时器。
      await new Promise((res) => setTimeout(res, 0));
      await flushAll();
    } finally {
      process.off('unhandledRejection', collect);
    }

    expect(unhandled, 'getPage 醒来后摸已卸载的 canvas ⇒ 未处理拒绝').toEqual([]);
  });

  // N-1：空 url 分支只 `await releaseLoadingTask(); return;` 时**没人给 loading 归位**。
  // 模板是 `v-if="loading"`，loading 一旦为真就接管整个视图；而被本次作废的那次 load
  // 醒来只会命中 stale 守卫直接 return（它没有、也不该有替别人落位的职责）⇒ 界面永远
  // 停在「加载中…」。可达性如实说：8 个消费点当前都把 url 绑在 v-if / v-else / :key 之后，
  // 没有生产路径触发得到；但 W7 已把这条分支登记成「受支持的释放路径」，被测试承认的
  // 路径不能带着永久卡 spinner 的状态存在。
  it('W10：url 在加载途中被清空 ⇒ 不得停在「加载中…」（空 url 分支自己把 loading 归位）', async () => {
    let resolveDoc: ((d: unknown) => void) | null = null;
    h.getDocument.mockImplementation(() =>
      makeLoadingTask(
        new Promise((res) => {
          resolveDoc = res;
        }),
      ),
    );
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/slow.pdf' },
      global: { stubs },
    });
    await flushPromises();
    expect(stateOf(w).loading, '前置：卡在 task.promise 上，界面处于加载中').toBe(true);

    await w.setProps({ url: '' });
    await flushAll();

    expect(
      stateOf(w).loading,
      '宿主已表示「这里没有文档」，却永远停在「加载中…」—— 组件再也回不到画布',
    ).toBe(false);
    expect(w.find('.loading').exists(), 'spinner 还挂在 DOM 上').toBe(false);
    expect(
      createdTasks[0]!.destroy,
      '释放路径仍要走（W7 单独钉了次数，这里只防归位代码把释放一起挤掉）',
    ).toHaveBeenCalledTimes(1);

    // 被作废的那次 load 醒来：它 resolve / reject 都只命中 stale 守卫，不得把 loading 顶回去
    resolveDoc!(fakeDoc([{ w: PAGE_W, h: PAGE_H }]));
    await flushAll();
    expect(stateOf(w).loading, '迟到的 load 醒来后不得把 loading 又顶成 true').toBe(false);

    w.unmount();
    await flushAll();
  });

  // N-5：`doc !== pdfDoc` 不是冗余项。切 url 时旧 task 已随 load 开头那次 release 被释放
  // （`pdfDoc` 同时置 null），而画布在 loading 落回 false 之后又回来了 ⇒ 旧 render() 醒来时
  // canvas 是在的、**不会 TypeError**，它会真的把上一份文档的页画上去（工人看到闪一帧
  // 旧图纸）。所以这一侧的守卫只能是 doc 身份比对，`!canvas` 拦不到。
  it('W11：切 url 时旧 doc 的 getPage 在途 —— 醒来不得把上一份文档的页画到新画布上', async () => {
    container.w = 800;
    container.h = 800;
    // 旧文档的页刻意取 500×500 ⇒ fit = 800/500 = 1.6，与新文档的 2.0 互不相同 ⇒
    // 「有没有画上去」一眼可辨，不必去数画布像素。
    let releaseOldPage: (() => void) | null = null;
    let current = 'a';
    h.getDocument.mockImplementation(() => {
      if (current === 'a') {
        return makeLoadingTask(
          Promise.resolve({
            numPages: 1,
            getPage: () =>
              new Promise((res) => {
                releaseOldPage = () => res(makePage(500, 500));
              }),
          }),
        );
      }
      return makeLoadingTask(Promise.resolve(fakeDoc([{ w: 400, h: 400 }])));
    });
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/a.pdf' },
      global: { stubs },
    });
    await flushAll();
    expect(releaseOldPage, '前置：render() 应当正卡在旧 doc 的 getPage 上').not.toBeNull();
    expect(renderedScales, '前置：旧文档一页都还没画过').toEqual([]);

    current = 'b';
    await w.setProps({ url: 'https://example.test/b.pdf' });
    await flushAll();
    expect(renderedScales.at(-1), '前置：新文档已渲染（fit = 800/400 = 2.0）').toBeCloseTo(2.0, 6);
    const drawnBefore = renderedScales.length;

    releaseOldPage!();
    await flushAll();

    expect(
      renderedScales.length,
      '旧 doc 的 render() 醒来把上一份文档的页画到了新画布上（工人看到闪一帧旧图纸）',
    ).toBe(drawnBefore);
    expect(
      renderedScales.some((s) => Math.abs(s - 1.6) < 1e-6),
      '不该出现旧文档那一页的比例（fit = 800/500 = 1.6）',
    ).toBe(false);

    w.unmount();
    await flushAll();
  });

  // N-1 的第二面：url 清空后那句报错是**上一份文档**的结论（宿主已经表示「这里没有
  // 文档」），继续挂着就是拿一份不成立的信息当现状展示 —— 与 W11 那条同族：状态里不许
  // 留着已经不成立的那一份。守卫与 W10 分开：W10 钉 loading，这一条钉 error。
  it('W12：url 被清空时把上一份文档留下的报错一起清掉', async () => {
    let rejectDoc: ((r: unknown) => void) | null = null;
    h.getDocument.mockImplementation(() =>
      makeLoadingTask(
        new Promise((_, rej) => {
          rejectDoc = rej;
        }),
      ),
    );
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/bad.pdf' },
      global: { stubs },
    });
    await flushPromises();
    rejectDoc!(new Error('PDF 结构损坏'));
    await flushAll();
    expect(stateOf(w).error, '前置：加载失败已经上屏').toContain('PDF 结构损坏');
    expect(stateOf(w).loading).toBe(false);

    await w.setProps({ url: '' });
    await flushAll();

    expect(stateOf(w).error, '宿主已表示「这里没有文档」，却仍挂着上一份文档的失败原因').toBeNull();
    expect(stateOf(w).loading).toBe(false);
    w.unmount();
    await flushAll();
  });

  // N-2：getPage 的失败分两种，竞态那种静默、真失败那种必须留痕。零日志地吞掉 ⇒ 画布停在
  // 空白或上一帧，控制台干干净净，排障时没有任何信号（同仓 SCAN_BANNER 的「丢弃 + 一行
  // warn」口径）。与 W5（destroy 失败的 warn）成对：释放侧留痕，取页侧也要留痕。
  it('W13：当前文档的 getPage 真失败时留一行 warn（不静默停在空白画布）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    container.w = 800;
    container.h = 800;
    let failPage: ((e: unknown) => void) | null = null;
    h.getDocument.mockImplementation(() =>
      makeLoadingTask(
        Promise.resolve({
          numPages: 1,
          getPage: () =>
            new Promise((_, rej) => {
              failPage = rej;
            }),
        }),
      ),
    );
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/bad.pdf' },
      global: { stubs },
    });
    try {
      await flushAll();
      expect(failPage, '前置：render() 应当正卡在 getPage 上').not.toBeNull();

      failPage!(new Error('Invalid page request.'));
      await flushAll();

      expect(
        warn,
        '真实失败（页码越界 / 页面损坏 / worker 崩溃）零日志 ⇒ 画布静默空白，排障时没有任何信号',
      ).toHaveBeenCalled();
      expect(String(warn.mock.calls.at(-1)?.[0] ?? '')).toContain('Invalid page request.');
    } finally {
      warn.mockRestore();
    }
    w.unmount();
    await flushAll();
  });

  // N-2 的另一面（别把 warn 放出去的那侧一起打开）：换文件时旧 doc 的 getPage 以
  // "Worker was destroyed" 拒绝是**竞态的正常收尾**，每次切文件都刷一条 warn 就是噪声。
  // 这条同时钉住 `releaseLoadingTask` 里那句 `pdfDoc = null`：新 doc 还没 resolve、
  // `pdfDoc` 若仍指着旧 doc，「自 destroy」与「真取页失败」就分不开了（那条 warn 是假的）。
  it('W14：换文件时被自己 destroy 掉的旧 doc 取页失败 ⇒ 静默收尾（不刷假 warn）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    container.w = 800;
    container.h = 800;
    let failOldPage: ((e: unknown) => void) | null = null;
    let resolveNewDoc: ((d: unknown) => void) | null = null;
    let current = 'a';
    h.getDocument.mockImplementation(() => {
      if (current === 'a') {
        return makeLoadingTask(
          Promise.resolve({
            numPages: 1,
            getPage: () =>
              new Promise((_, rej) => {
                failOldPage = rej;
              }),
          }),
        );
      }
      return makeLoadingTask(
        new Promise((res) => {
          resolveNewDoc = res;
        }),
      );
    });
    const w = mount(PdfViewer, {
      props: { url: 'https://example.test/a.pdf' },
      global: { stubs },
    });
    try {
      await flushAll();
      expect(failOldPage, '前置：render() 应当正卡在旧 doc 的 getPage 上').not.toBeNull();

      current = 'b';
      await w.setProps({ url: 'https://example.test/b.pdf' });
      await flushAll();
      // 刻意把旧 render() 的拒绝**压在**「旧 task 已释放、新 doc 还没 resolve」的窗口里：
      // 这一窗口内 `pdfDoc` 已随 release 置 null，正是竞态与真失败唯一能分开的时刻。
      expect(stateOf(w).loading, '前置：新文档还在下载，界面处于加载中').toBe(true);

      failOldPage!(new Error('Worker was destroyed'));
      await flushAll();
      expect(
        warn,
        '换文件的正常收尾被当成取页失败上报 —— 每次切文件都刷一条假 warn',
      ).not.toHaveBeenCalled();

      resolveNewDoc!(fakeDoc([{ w: 400, h: 400 }]));
      await flushAll();
      expect(renderedScales.at(-1), '新文档照常渲染（静默不是放弃）').toBeCloseTo(2.0, 6);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    w.unmount();
    await flushAll();
  });
});
