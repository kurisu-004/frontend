// @vitest-environment happy-dom
// src/components/__tests__/PdfViewer.spec.ts
//
// PdfViewer「默认 fit 到容器」的回归守卫。
//
// 为什么这批用例以前不存在（2026-10-11 补）：fit 那次改动把 `render()` 改成每次都按
// 容器尺寸覆写 `renderScale`，而 `zoomIn` / `zoomOut` 的实现恰恰是「改 renderScale →
// 调 render()」—— 刚写进去的值在同一次调用里被抹掉，净效果是**点 +/- 视觉零变化**
// （唯一残留效果是把 viewScale 重置为 1，观感上像「缩小回原样」）。这条回归不需要任何
// 报错、不改任何 DOM 结构，202 个 spec / 2385 条用例全绿也拦不住它。
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  h.cleanup.mockReset();
  h.getDocument.mockReset();
});

describe('PdfViewer / fit 到容器', () => {
  // P1：fit 值必须真的进 renderScale（否则整个「默认 fit」是空转的）。
  it('P1：fit 值算进 renderScale（800×800 容器装 1000×1000 页 ⇒ 0.8）', async () => {
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

  // fit 是 opt-out 口子：将来某个承载点要固定比例时传 :fit="false" 即可，
  // 不必改组件本体。默认值为 true（全仓 7 个承载点都要 fit）。
  it('P6：fit=false 时不套用 fit（按 initialScale 渲染，与容器尺寸无关）', async () => {
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

  it('P7：默认 fit 为 true（不传 fit 与显式传 true 同结果）', async () => {
    container.w = 800;
    container.h = 800;
    const w = await mountViewer();
    expect(canvasWidth(w)).toBe(800);
    w.unmount();
  });
});
