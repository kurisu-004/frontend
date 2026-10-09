<!--
  PdfViewer.vue

  PDF 内嵌预览组件（基于 pdfjs-dist）。
  接收一个 url（COS 临时签名 URL，由后端即时签发），直接 GET 拉取 PDF 二进制并渲染。

  2026-09-12 新增：滚轮缩放（鼠标点中心）+ 左键拖动平移 + 双击复位。
  双 scale 模型：
    - renderScale: 给 pdfjs.getViewport 用（snap 0.1，0.4-3.0）；改变时触发 PDF 重渲染，保证矢量清晰
    - viewScale : CSS transform 乘数（连续，0.1-10）；仅 CSS 缩放，手感流畅
  2026-09-12 第四轮改造：
    - 删除 scheduleReRender（250ms 节流的 viewScale → renderScale + render()）：节流触发的 render()
      会改 canvas.width/height/style.width/style.height → 引起 layout shift 抖动。
    - 删除 <el-input-number v-model="renderScale"> 缩放比例输入框（抖动源头）。
    - onWheel 只调 viewScale / tx / ty，不再 scheduleReRender。
    - 滚轮纯 CSS 缩放：极高缩放（>3x）会有像素感，但避免每次 wheel 后的 canvas 重排抖动。
    - +/- 按钮（zoomIn / zoomOut）仍触发 render() 重渲染（用户主动意图，不算抖动）。
  2026-09-12 第四轮改造（T3）：高度链修复。
    - .pdf-viewer 加 height: 100% + flex: 1 / 去掉 min-height: 400px
    - .canvas-wrap 加 flex: 1 / min-height: 0（已在第三轮加过 flex: 1）
    - .pdf-toolbar 加 flex-shrink: 0
    - DrawingPreviewPane.vue 的 .file-preview 改为 display:flex/flex-direction:column（让 PdfViewer 在此成为 flex item）
    - 完整高度链：preview-card (flex:1) → preview-tabs (flex:1) → file-preview (flex:1, flex col) → pdf-viewer (flex:1) → canvas-wrap (flex:1) → viewport (flex:1) 撑满父容器
  2026-10-03 修缺陷：这条高度链要求宿主容器有确定高度，而 el-dialog 不是这样的宿主。
    EP 的 .el-dialog__body 只有 color / font-size / text-align，display:block + height:auto，
    直接子元素的 height:100% 会退化成 auto → 整条链塌成 0 → position:absolute 的 canvas
    被 .pdf-viewport 的 overflow:hidden 裁掉，表现为「工具栏在、下面纯白」。
    承载契约：承载 PdfViewer 的 el-dialog 必须挂 .pdf-preview-dialog（全局规则见
    src/styles/index.scss，把 dialog 变成 column flex 并给 body flex:1 + min-height:0）；
    el-drawer 无需（.el-drawer__body 自带 flex:1）；自带确定高度的宿主（如
    DrawingPreviewPane 的 .file-preview flex 链）天然满足契约。
    ⚠️ 2026-10-11：`.pdf-preview-dialog` 的全局规则现在有**两支** —— `.is-fullscreen`
    （dialog 被钉到视口，body 靠 flex:1 分高）与 `:not(.is-fullscreen)`（窗口形态，
    dialog 是 auto 高度，必须由 **body 自己**声明确定高度）。只留 fullscreen 那一支时，
    窗口形态的弹窗会退回本段描述的塌陷。

  2026-10-11 新增：**默认 fit 到容器**（`fit` prop，默认 true，全仓生效）。
    此前 render() 恒用 `props.initialScale`（默认 1.0）渲染，完全不看容器尺寸，
    于是 A0/A1 图纸（scale 1 时 2384×3370px）只能看见左上角一小块，工人得先滚、
    再自己调比例才能找到要看的那一面。现在每次 render() 都按
    `min(容器可用宽 / 页宽@scale1, 容器可用高 / 页高@scale1)` 算 fit 并写进
    **renderScale**（不是 viewScale —— 见下），翻页重算（每页各自适应）。
    · **为什么写 renderScale 而不是 viewScale**：viewScale 是纯 CSS transform 乘数，
      >1 时不会重渲染，矢量图会被 CSS 放大成糊的；fit 是一次性落到「看得清」的
      比例，必须让 pdfjs 按该分辨率出像素。
    · **为什么不复用 zoomIn / zoomOut 的 [0.4, 3] 夹逼**：那两条是用户主动 +/- 的步进
      区间。fit 到 A1 在 1100px 弹窗里约需 0.2 上下，套上 0.4 的下限就把图纸撑出容器，
      比不做 fit 更糟。fit 单独夹到 [FIT_MIN_SCALE, FIT_MAX_SCALE]。
    · 容器尺寸为 0（宿主尚未布局，例如弹窗还在进场动画里、或宿主在 v-if 内刚挂上）
      ⇒ fit 算不出来，此时**回落 props.initialScale**（不产生 NaN），并记一笔等容器
      拿到尺寸后由 ResizeObserver 补一次 render。
    · 该 ResizeObserver 只在「上一次 fit 失败」时补渲染，不跟着每次尺寸变化重算 ——
      窗口拖拽缩放时反复重渲染会造成 canvas 重排抖动，与 2026-09-12 删掉
      scheduleReRender 的理由同款。
    · **fit 只在用户没手动缩放过时生效**（`userZoomed` 标志）：+/- 改的就是 renderScale
      本身，若 render() 随后无条件覆写成 fit 值，那一步就等于没做（点 +/- 视觉零变化）。
      置位点是三条缩放入口 —— `zoomIn` / `zoomOut`（改 renderScale）与 `onWheel`
      （只改 viewScale，但同样是「我要看多大」的表态）。
      清位分两类，**口径不同、别混**：
      (a) **用户对这份文件做了动作** ⇒ 走 `resetView()`，它把三样一起归位：
          `userZoomed`（让 render() 重算 fit）、`viewScale = 1`、`tx = ty = 0`。
          调用方是 `resetView` 自身（复位按钮 / 双击）、工具栏翻页、`props.page` watch
          （外部换页）。切 `url` 也属这一类，同样三样归位，只是改为调 `load()`
          （它自己会渲染，不重复调 render）。三样缺一，「翻页 = 重新适应整页」就不成立：
          不清标志 ⇒ 滚轮用户下一页仍以「fit × 自己的缩放」呈现、出容器；
          不清平移 ⇒ 翻页后看到的是新一页的一角（tx/ty 是 stage 的 CSS translate，
          与两个 scale 互不干涉，只清缩放类变量对它无效）；
          不重渲 ⇒ fit 根本不重算。
      (b) **宿主改配置** ⇒ `props.fit` watch 只清 `userZoomed`：切 `fit` 是宿主行为、
          不是用户对这份文件的动作，用户没表态就不替他丢掉已调好的缩放与位置。
      ⇒ 复位与翻页的语义统一为「回到整页塞进容器的大小」（复位按钮不是「回到 1 倍」）。
      翻页重置是**刻意**的：图纸各页图幅不同（封面 A0、正图 A4 混排很常见），
      带着上一页的缩放或平移都会让下一张图看不到全貌。
    · `fit` prop 是 opt-out 口子（默认 true）：全仓所有 `<PdfViewer>` 承载点都要 fit
      （清单见 `src/components/__tests__/PdfPreviewDialogContract.spec.ts` 的表与例外），
      但组件本体不该把「永远 fit」焊死 —— 将来某个页面要固定比例（比如逐页比对同一比例），
      传 `:fit="false"` 即可，不必改组件本体。
  CLAUDE.md #6：仍走 @/utils/pdfjs，不直接 import pdfjs-dist。
-->
<template>
  <div class="pdf-viewer">
    <div v-if="loading" class="loading">
      <el-icon :size="24" class="is-loading"><Loading /></el-icon>
      <span>加载中…</span>
    </div>
    <div v-else-if="error" class="error">
      <el-icon :size="24" color="#f56c6c"><CircleClose /></el-icon>
      <span>{{ error }}</span>
    </div>
    <div v-else class="canvas-wrap">
      <div class="pdf-toolbar">
        <el-button-group>
          <el-button :disabled="page <= 1" @click="prevPage">
            <el-icon><ArrowLeft /></el-icon>
            <span>上一页</span>
          </el-button>
          <el-button :disabled="page >= totalPages" @click="nextPage">
            <span>下一页</span>
            <el-icon><ArrowRight /></el-icon>
          </el-button>
        </el-button-group>
        <span class="page-info">{{ page }} / {{ totalPages }}</span>
        <!-- 2026-09-12 第四轮：删除 <el-input-number v-model="renderScale"> 缩放比例输入框。
             滚轮缩放是唯一的连续控制；不再自动 snap-to-renderScale，避免 canvas 内部尺寸变化导致抖动。 -->
        <el-button @click="zoomIn"
          ><el-icon><ZoomIn /></el-icon
        ></el-button>
        <el-button @click="zoomOut"
          ><el-icon><ZoomOut /></el-icon
        ></el-button>
        <!-- 复位 = 回到「整页塞进容器」的大小（fit 开启时），不是回到 1 倍 -->
        <el-button title="双击也可复位" @click="resetView">
          <el-icon><Refresh /></el-icon>
        </el-button>
        <el-button @click="download">
          <el-icon><Download /></el-icon>
          <span>下载</span>
        </el-button>
      </div>
      <div
        ref="viewportRef"
        class="pdf-viewport"
        @wheel.prevent="onWheel"
        @mousedown="onMouseDown"
        @dblclick="resetView"
      >
        <div
          class="pdf-canvas-stage"
          :style="{
            width: `${stageWidth}px`,
            height: `${stageHeight}px`,
            transform: `translate(${tx}px, ${ty}px) scale(${totalScale})`,
            transformOrigin: '0 0',
          }"
        >
          <canvas ref="canvasRef" class="pdf-canvas" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  CircleClose,
  Download,
  Loading,
  Refresh,
  ZoomIn,
  ZoomOut,
} from '@element-plus/icons-vue';
import { pdfjsLib, PDF_CMAP_OPTIONS } from '@/utils/pdfjs';

interface Props {
  url: string;
  page?: number;
  initialScale?: number;
  /** 是否每次渲染都按容器尺寸算「整页塞进容器」的比例（默认 true）。关掉则恒用
   *  `initialScale` 起手、之后只由 +/- / 滚轮改 —— 供需要固定比例的承载点 opt-out。 */
  fit?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  page: 1,
  initialScale: 1.0,
  fit: true,
});

const canvasRef = ref<HTMLCanvasElement | null>(null);
// 2026-10-11：滚轮缩放与 fit 都量这个元素。此前 onWheel 走
// `document.querySelector('.pdf-viewport')` —— 页面上有第二个 PdfViewer 时，
// 滚轮会作用到错误实例（querySelector 只返回第一个），且拿到的尺寸也不对。
const viewportRef = ref<HTMLElement | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
// 2026-09-13 PR-2：vue/no-setup-props-destructure 禁止在 setup 顶层读 props.x。
// 包一层 IIFE 把 props.page / props.initialScale 的读取放进函数体。
const page = ref((() => props.page)());
const totalPages = ref(0);

// ============ 双 scale 模型 ============
// 2026-09-12 新增
// 2026-10-11：initialSize 存一份原值：render() 每次都会按 fit 覆写 renderScale，
// 「回落」时需要一个稳定的初值（不能读可能已被改写的 renderScale）。
const initialScale = (() => props.initialScale)();
const renderScale = ref(initialScale); // pdfjs 渲染分辨率（snap 0.1，0.4-3.0）
const viewScale = ref(1); // CSS transform 乘数（连续，0.1-10）
const tx = ref(0); // 平移 x（屏幕 px）
const ty = ref(0); // 平移 y
const totalScale = computed(() => renderScale.value * viewScale.value);
// 2026-10-11：用户用缩放入口表过态（+/- 改 renderScale、滚轮改 viewScale）之后，
// render() 不得再无条件覆写成 fit 值 —— 对 +/- 来说那会把刚写进去的比例在同一次调用里
// 抹掉（点一下视觉零变化）。置位点 = zoomIn / zoomOut / onWheel；
// 清位分「用户动作」（走 resetView，三样一起归位）与「宿主改配置」
// （props.fit watch，只清本标志）两类，见文件头。
const userZoomed = ref(false);

// stage 实际尺寸（按 renderScale 渲染出的画布像素 / devicePixelRatio），用于占位 div 宽度
const stageWidth = ref(0);
const stageHeight = ref(0);

// 2026-10-11：fit 的夹逼区间。与 zoomIn / zoomOut 的 [0.4, 3] **刻意不同** —— 后者是
// 用户主动 +/- 的步进范围，fit 是一次性「把整页塞进容器」的比例，A1 图纸在小窗口里
// 需要 0.2 上下，套 0.4 的下限就放不下。上界 8 防超小页面被放成马赛克，下界 0.05
// 防 fit 算出 0 / NaN（两者都会让 pdfjs 抛错或出全黑）。
const FIT_MIN_SCALE = 0.05;
const FIT_MAX_SCALE = 8;
// 上一次 render 因容器尺寸为 0 而没能算出 fit ⇒ 等容器就绪后补一次渲染。
let fitPending = false;

let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
let renderTask: pdfjsLib.RenderTask | null = null;
let resizeObserver: ResizeObserver | null = null;

async function load() {
  if (!props.url) return;
  loading.value = true;
  error.value = null;
  try {
    const task = pdfjsLib.getDocument({ url: props.url, ...PDF_CMAP_OPTIONS });
    pdfDoc = await task.promise;
    totalPages.value = pdfDoc.numPages;
    if (page.value < 1) page.value = 1;
    if (page.value > totalPages.value) page.value = totalPages.value;
  } catch (e) {
    error.value = (e as Error).message ?? 'PDF 加载失败';
    loading.value = false;
    return;
  }
  // 先让 Vue 把 canvas-wrap（含 canvas）插入 DOM，
  // 否则 render() 中 canvasRef.value 为 null，绘画被静默跳过。
  loading.value = false;
  await nextTick();
  // `.pdf-viewport` 只在 loading 结束后才渲染（v-else 分支），所以观察者必须挂在这里，
  // 挂在 onMounted 上时它还不存在。
  ensureResizeObserver();
  await render();
}

/**
 * 容器尺寸在首次 render 时还没量到（弹窗进场 / v-if 刚挂上）时，fit 会记一笔待补，
 * 尺寸一到由观察者补渲染一次。只在「有欠账」时动作 —— 拖拽缩放窗口不跟着重渲染，
 * 否则每次尺寸变化都改 canvas.width/height/style，产生 layout shift 抖动。
 */
function ensureResizeObserver(): void {
  const host = viewportRef.value;
  if (!host || resizeObserver || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    if (!fitPending) return;
    void render();
  });
  resizeObserver.observe(host);
}

async function render() {
  if (!pdfDoc || !canvasRef.value) return;
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      /* ignore */
    }
  }
  const p = await pdfDoc.getPage(page.value);
  // 2026-10-11：先把 renderScale 落到「整页塞进容器」的比例（写 renderScale 而非
  // viewScale：fit 要的是矢量清晰的成像，CSS 放大只会把图放大糊）。
  // 两个门都过才重算：`props.fit` 是 opt-out 口子；`userZoomed` 表示工人已经用 +/− /
  // 滚轮表过态（滚轮只动 viewScale，但它同样表达了「我要看多大」，故 onWheel 也置位）。
  // 两种情况下都**不碰 renderScale** —— 那正是工人要的值，落到 initialScale 反而把
  // 选择抹了。
  if (props.fit && !userZoomed.value) {
    const fit = fitScaleOf(p);
    if (fit === null) {
      // 容器尺寸为 0（宿主尚未布局）⇒ 回落 initialScale（不产生 NaN），
      // 并记一笔等 ResizeObserver 补一次。
      renderScale.value = initialScale;
      fitPending = true;
    } else {
      renderScale.value = fit;
      fitPending = false;
    }
  } else {
    fitPending = false;
  }
  const viewport = p.getViewport({ scale: renderScale.value * (window.devicePixelRatio || 1) });
  const canvas = canvasRef.value;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const cssWidth = viewport.width / (window.devicePixelRatio || 1);
  const cssHeight = viewport.height / (window.devicePixelRatio || 1);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  stageWidth.value = cssWidth;
  stageHeight.value = cssHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  renderTask = p.render({ canvas: canvas, canvasContext: ctx, viewport });
  await renderTask.promise.catch(() => {
    /* cancelled */
  });
}

// 翻页 = 重新适应整页，直接复用 `resetView()`：清 userZoomed（让 render() 重算 fit）、
// viewScale 归 1、平移 tx/ty 归 0，三件事一个都不能少。
//   · 只清标志 ⇒ 滚轮用户（onWheel 也置位 userZoomed）下一页仍以「fit × 自己的缩放」
//     呈现、出容器；
//   · 不清平移 ⇒ 翻页后工人看到的是新一页的右下角，整页并没有塞进容器（tx/ty 是
//     stage 的 CSS translate，与 renderScale / viewScale 互不干涉，只清缩放类变量
//     对它无效）。
// 图纸各页图幅不同（封面 A0、正图 A4 混排很常见），带着上一页的缩放或平移都会让下一张图
// 看不到全貌，而「翻页 = 重新适应」正是 fit 这件事的价值所在。
function prevPage() {
  if (page.value > 1) {
    page.value -= 1;
    resetView();
  }
}
function nextPage() {
  if (page.value < totalPages.value) {
    page.value += 1;
    resetView();
  }
}
/**
 * 「整页塞进 `.pdf-viewport`」的比例；容器没量到尺寸（或页面本身尺寸为 0）时返回
 * `null`，由调用方回落 `initialScale`。每页各自算，翻页后自动重新适应。
 *
 * ⚠️ 只在 `props.fit && !userZoomed` 时被调用 —— 容器尺寸为 0 与「不打算 fit」是两件
 * 不同的事，前者要回落 initialScale 并等 ResizeObserver，后者必须原样保留 renderScale。
 */
function fitScaleOf(p: pdfjsLib.PDFPageProxy): number | null {
  const host = viewportRef.value;
  if (!host) return null;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!(w > 0) || !(h > 0)) return null;
  const base = p.getViewport({ scale: 1 });
  if (!(base.width > 0) || !(base.height > 0)) return null;
  return clamp(Math.min(w / base.width, h / base.height), FIT_MIN_SCALE, FIT_MAX_SCALE);
}

// +/- 改的是 renderScale 本身，必须先置位 userZoomed，否则随后的 render() 会把它
// 覆写回 fit 值（点一下视觉零变化，唯一残留效果是 viewScale 被重置成 1）。
function zoomIn() {
  userZoomed.value = true;
  renderScale.value = Math.min(3, +(renderScale.value + 0.2).toFixed(1));
  viewScale.value = 1;
  void render();
}
function zoomOut() {
  userZoomed.value = true;
  renderScale.value = Math.max(0.4, +(renderScale.value - 0.2).toFixed(1));
  viewScale.value = 1;
  void render();
}

function download() {
  const a = document.createElement('a');
  a.href = props.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ============ 滚轮缩放 ============
// 2026-09-12 新增：鼠标点中心缩放（纯 CSS transform，不触发 render）
// 2026-09-12 第四轮改造：删除 250ms 节流的 scheduleReRender —— 节流触发的 render() 会改
// canvas.width/height/style.width/style.height，引起 layout shift 视觉抖动。
// 现在滚轮只调整 viewScale / tx / ty，由 CSS transform 处理；PDF bitmap 不重渲染。
// 权衡：极高缩放（>3x）会出现像素感，但避免每次 wheel 后的 canvas 重排抖动；
// 如需矢量清晰可点 +/- 按钮（zoomIn / zoomOut）触发 render() 重渲染。
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function onWheel(e: WheelEvent) {
  const viewport = viewportRef.value;
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const direction = e.deltaY < 0 ? 1 : -1;
  const factor = direction > 0 ? 1.1 : 1 / 1.1;
  const newViewScale = clamp(viewScale.value * factor, 0.1, 10);

  // 调整 tx, ty 让鼠标点保持锚定：
  //   oldMouseX = mouseX   =>   oldMouseX = (oldStageX * oldTotal) + oldTx
  //   缩放后同一 stage 坐标应对应同一个鼠标点：
  //   newTx = mouseX - (mouseX - oldTx) * (newTotal / oldTotal)
  const oldTotal = totalScale.value;
  const newTotal = renderScale.value * newViewScale;
  const ratio = newTotal / oldTotal;
  tx.value = mouseX - (mouseX - tx.value) * ratio;
  ty.value = mouseY - (mouseY - ty.value) * ratio;

  viewScale.value = newViewScale;
  // 滚轮与 +/- 同级：都是「我要看多大」的明确表态，故同样置位 userZoomed，供各条清位
  // 路径（复位 / 切 url / 翻页）判断。它只动 viewScale、不动 renderScale（不重渲染），
  // 但对「翻页要不要回到 fit」这个决定是一票。
  userZoomed.value = true;
  // 不再调 scheduleReRender() —— 防止 canvas 内部尺寸变化引发抖动
}

// ============ 拖动平移 ============
// 2026-09-12 新增：左键拖动；通过 window 监听 mouseup（避免鼠标离开 viewport 后卡死）
const dragging = ref(false);
const dragStart = ref({ x: 0, y: 0, tx: 0, ty: 0 });

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return; // 只响应左键
  dragging.value = true;
  dragStart.value = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}
function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return;
  // 把屏幕像素位移转成 stage 坐标位移（除以 totalScale，避免 zoom 下拖动灵敏度漂移）
  const scale = totalScale.value;
  tx.value = dragStart.value.tx + (e.clientX - dragStart.value.x) / scale;
  ty.value = dragStart.value.ty + (e.clientY - dragStart.value.y) / scale;
}
function onMouseUp() {
  dragging.value = false;
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
}

// ============ 复位 ============
// 2026-09-12 新增：双击 / 工具栏复位按钮。
// 2026-10-11 改：清 userZoomed 并重渲一次 —— 语义是「回到整页塞进容器的大小」
// （fit 开启时），不是「回到 1 倍」。只清 viewScale / 平移的话，工人按了复位却仍停在
// 自己放大后的比例上（renderScale 被 userZoomed 保护、不被 fit 覆写），「复位」这个
// 按钮名就落空了。
// ⚠️ 翻页与 `props.page` watch 都调这里（换页类动作的清位都走这一个入口）。
// 切 `url` 是唯一的例外：它也三样归位，但紧接着调 `load()` 而不是 render()，
// 所以只能内联那几行、不能复用本函数 —— 改这一组变量时记得两处一起看。
function resetView() {
  userZoomed.value = false;
  viewScale.value = 1;
  tx.value = 0;
  ty.value = 0;
  // fit=false 时重渲一次只是把同一个 renderScale 再画一遍，无副作用；
  // fit=true 时它才是「回到 fit」的那一步。
  void render();
}

watch(
  () => props.url,
  () => {
    // 切 url 时同时重置视图 + 清 userZoomed，避免新 PDF 继承上一次的缩放与平移
    userZoomed.value = false;
    viewScale.value = 1;
    tx.value = 0;
    ty.value = 0;
    void load();
  },
);
watch(
  () => props.page,
  (v) => {
    page.value = v;
    // 换页 = 重新适应，与工具栏翻页**完全同一口径**（直接复用 resetView：fit 重算、
    // viewScale 归 1、平移 tx/ty 归 0 一次做完）。
    // 真实驱动方是 PartBatchPdfTab 的 `:page="pdfPreviewing.page"`：它在打开预览时
    // 由 `previewAt()` 赋一次初始页，此后工具栏翻页改的是组件内部 ref、**不回写
    // prop**，所以这个 watch 在生产上是「打开时定初始页」的单次触发；真出现同一文档
    // 内换页时，重新适应整页也是对的。
    resetView();
  },
);
// `fit` 是 opt-out 口子，运行时切它要立刻让新取值生效 ⇒ 清 userZoomed 后重渲。
// ⚠️ 这里**刻意不清 viewScale / 平移**，与上面几条不是一类：`props.fit` 目前零调用方
// （留给将来承载点的 opt-out 口子），而运行期切它是**宿主改配置**、不是用户对这份文件
// 的动作 —— 用户没表态就不该替他丢掉已经调好的缩放与位置。宿主若要在切 fit 时一并
// 复位，显式调 `resetView()` 即可。
watch(
  () => props.fit,
  () => {
    userZoomed.value = false;
    void render();
  },
);

onMounted(load);
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      /* ignore */
    }
  }
  if (pdfDoc) {
    void pdfDoc.cleanup();
  }
});
</script>

<style lang="scss" scoped>
// 2026-09-12 第四轮（T3）：完整高度链让 viewport 撑满父容器
//   宿主（确定高度）→ .pdf-viewer (height:100%) → .canvas-wrap (flex:1) → .pdf-viewport (flex:1)
// 关键：.pdf-viewer 必须声明 height: 100%，且宿主必须给确定高度（见文件头「承载契约」）。
//       min-height: 0 允许 flex 子项收缩到 0（避免内容撑爆）。
.pdf-viewer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  // 2026-09-12 第四轮：同时声明 height:100% 和 flex:1
  //   - flex 宿主（如 DrawingPreviewPane 的 .file-preview、.pdf-preview-dialog 下的 body）
  //     → flex:1 生效
  //   - block 宿主：height:100% 仅在宿主有确定高度时生效
  height: 100%;
  flex: 1 1 auto;
  min-height: 0; /* ← 去掉 400px 下限 */
  min-width: 0;
}
.loading,
.error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: var(--text-secondary);
}
.canvas-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1; /* ← 撑满父容器 */
  min-height: 0;
}
.pdf-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0; /* ← toolbar 不被压缩 */
}
.page-info {
  font-size: 13px;
  color: var(--text-secondary);
}

// 2026-09-12 新增：viewport 包裹 canvas-stage，捕获滚轮 / 鼠标事件
.pdf-viewport {
  flex: 1;
  position: relative;
  overflow: hidden;
  min-height: 0;
  cursor: grab;
  background: #fafbfc;
  user-select: none;
  &:active {
    cursor: grabbing;
  }
}
.pdf-canvas-stage {
  position: absolute;
  top: 0;
  left: 0;
  transition: transform 0.05s linear;
  will-change: transform;
}
.pdf-canvas {
  display: block;
  border: 1px solid var(--border-color);
  background: #fff;
}
</style>
