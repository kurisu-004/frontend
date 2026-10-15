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
  2026-10-20 修 Worker 泄漏：`getDocument()` 返回的 `loadingTask` 是**唯一**能终止
    pdf.js worker 线程的句柄 —— `task.destroy()` 会走 `WorkerTransport.destroy()`，
    连带销毁 messageHandler、取消在途网络请求、清 pageCache / commonObjs / fontLoader、
    终止线程本身。组件把 loadingTask 存在实例上，释放路径共三条：
    ① 切 `props.url` 前先释放旧的，并 await 它 —— 保证旧线程在新线程建出来之前终止，
       否则高频切文件时新旧线程会并存；
    ② `props.url` 被清空（宿主收起预览）时也释放，**排在判空 return 之前** —— 少了它，
       上一份的 worker 就被丢在后台跑完，等于换一种写法复现同一个泄漏；
    ③ `onBeforeUnmount` 释放（不 await：卸载不阻塞；失败只 console.warn，不打断预览）。
    doc 上的 `cleanup()` 不在这三条路径里：它只清渲染缓存、worker 照旧活着，destroy
    已经把那份清理做了。
    承载弹窗是 destroy-on-close，所以「不释放」等价于「每打开一次图纸预览就漏一个线程」，
    而图纸预览是工人全天的高频动作。
    同一条链上的另一半：`load()` 全程带守卫，卸载后迟到的结果不写回状态 —— 被自己
    destroy 掉的 task 会以 "Worker was destroyed" / "Loading aborted" 拒绝，把它当加载
    失败上屏是假的，写回已死的视图更是纯浪费。
    ⚠️ **「最后发起 load 的那次赢」这条硬保证由单调序号（loadSeq）兜底，不是由
    `loadingTask` 的赋值顺序**：load() 要先 await 释放上一份，而 await 期间完全可能有
    新的 load 打进来；那样一来「谁最后写 loadingTask」与「谁最后调 load()」就分家了 ——
    抢在 await 之前建好 task 的那次会被后来者覆盖掉 loadingTask，从此再没人能 destroy
    它（这恰好把本段要消灭的泄漏又造回来）。注意可见后果是「多建一个孤儿 task + 对同一
    份文档多下一次重复下载」，**不是**「显示错文档」：`getDocument()` 那次读的是当时的
    `props.url`（load() 入口只在判空时读一次，不做快照），被抢跑的那次同样会取到最新的
    url，所以别把「谁渲染出来的」当判据。
    所以 bail 点一律对照 seq，且**必须在建 task 之前**bail（建出来就晚了）。
    ⚠️ 路径 ② 除了释放，还必须**自己把 loading 落回 false**：模板是 `v-if="loading"`，
    loading 为真就接管整个视图，而被它作废的那次 load 醒来只会命中 stale 守卫直接 return
    （它没有、也不该有「替别人把 loading 落回去」的职责）⇒ 没人归位就永远停在「加载中…」。

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
// 2026-10-21：运行期面改成 `loadPdfjs()`（懒加载 pdfjs-dist，见 @/utils/pdfjs 的口径），
// 类型面仍写成 `pdfjsLib.XXX`（`export type * as`，编译期擦除）。
import { loadPdfjs, PDF_CMAP_OPTIONS, type pdfjsLib } from '@/utils/pdfjs';

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
// 2026-10-20 修 Worker 泄漏：loadingTask 是唯一能终止 pdf.js worker 线程的句柄
// （`destroy()` → `WorkerTransport.destroy()` → 销毁 messageHandler + 终止线程）。
// 它必须活在实例上、贯穿 load 的整个 await 链 —— 谁把它丢在局部变量里，谁就永远
// 没机会回收那个线程（承载弹窗是 destroy-on-close，等于每次开预览漏一个）。
let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
// 卸载后仍在飞行的 load() 一律不得再写状态（见 releaseLoadingTask 与 load 的守卫）。
let disposed = false;
// 2026-10-20 补：load() 的单调序号。基线里 getDocument() 整个在 load() 的同步段内，
// 「谁最后调用 load 谁赢」是硬保证；引入「先 await 释放旧 task」之后这个保证没了 ——
// 抢在后一个 await 里回来的那次会把 loadingTask 覆盖成自己的，让先建的那一份彻底
// 失去句柄（孤儿 worker 线程）。序号是唯一单调递增的量，判据只能是它。
let loadSeq = 0;

/**
 * 释放当前 loadingTask（2026-10-20 修 Worker 泄漏）。
 *
 * `destroy()` 返回 Promise，两条调用点的口径不同但共用这一个函数：
 *  · 切 url：**await** 它 —— 新 task 建出来之前旧 worker 必须已经终止，否则切文件
 *    高频发生时新旧线程会并存，峰值线程数跟着涨；
 *  · unmount：**不 await** —— 卸载是同步流程，不能为一个后台收尾卡住整条卸载链；
 *    失败只记一行 warn（沿用本仓 best-effort 清理的既有风格），绝不冒泡成未处理拒绝。
 *
 * ⚠️ 释放失败（warn 之后）**照常建新 task**：destroy 失败只说明旧线程的终止没被确认，
 *   不代表这份文档还能取到页 —— 停在旧文档上等于给工人看一份已经不成立的图纸，比多
 *   留一个待回收的线程更难查。下一次 load / unmount 还会再释放一次（那时 loadingTask
 *   已经指向新 task，旧的只能靠 pdf.js 自身的 GC），这属于可接受的兜底。
 *
 * 2026-10-20 补：释放 task 的同一个瞬间把 `pdfDoc` 也置 null。它是**这个 task** 的
 * promise 兑现出来的，task 一销毁，那份 doc 就再也取不到页（后续 `getPage` 一律
 * "Worker was destroyed"）。留着它有两个后果：render() 会拿着一个已死的 doc 去摸画布；
 * 换文件那次还会多刷一条「取页失败」假 warn —— 新 doc 还没 resolve、`pdfDoc` 仍指着旧
 * doc 的话，`doc !== pdfDoc` 这道竞态守卫就分不清「自 destroy」与「真取页失败」了。
 */
async function releaseLoadingTask(): Promise<void> {
  const task = loadingTask;
  loadingTask = null;
  pdfDoc = null;
  if (!task) return;
  try {
    await task.destroy();
  } catch (e) {
    console.warn(`[PdfViewer] 释放 pdf.js worker 失败：${(e as Error).message ?? String(e)}`);
  }
}

/**
 * 本次加载是否仍然「算数」：组件已卸载、或 loadingTask 已换主（有一份更新的 task
 * 接手了这份文档的 worker 线程）⇒ 结果作废。
 *
 * 判据用「task 换主」而不是序号，是因为**每一次新的 load 都会先释放上一份**：
 * 新的 load 一动手（同步段内）就把 loadingTask 摘空或换成人，于是「这份 task 还在
 * loadingTask 上」与「没有更新的 load 抢跑」是同一件事，序号不必再进这道闸。
 */
function isStale(task: pdfjsLib.PDFDocumentLoadingTask): boolean {
  return disposed || loadingTask !== task;
}

async function load() {
  // 单调序号：本次调用在整个 load() 生命周期内的身份。所有 bail 点都拿它对照，
  // 不用「loadingTask 是不是我」——那一项在 task 建出来之前还没有值可比。
  const seq = (loadSeq += 1);
  if (!props.url) {
    // 2026-10-20 补：url 被清空（宿主收起预览）也是一条释放路径。直接 return 会把
    // 上一份的 worker 丢在后台跑完，等于换一种写法复现同一个泄漏。
    await releaseLoadingTask();
    // ⚠️ 释放之后**必须自己把 loading 归位**：模板是 `v-if="loading"`，loading 为真就
    // 接管整个视图；而被本次作废的那次 load 醒来时只会命中 stale 守卫直接 return（它没有、
    // 也不该有「替别人把 loading 落回去」的职责）⇒ 谁不归位，界面就永远停在「加载中…」。
    // 附带清 error：那句报错是上一份文档的结论，宿主已经表示「这里没有文档」。
    // 判据取 seq（本次身份）—— 释放期间完全可能有更新的 load 接手，它的状态不能被覆盖。
    if (!disposed && seq === loadSeq) {
      loading.value = false;
      error.value = null;
    }
    return;
  }
  loading.value = true;
  error.value = null;
  // 先取 pdfjs 运行期面（首次调用会下载约 415KB 的 pdfjs-dist 并配置 workerSrc）。
  // 放在这里而不是 load() 最开头：loading 已经置真 ⇒ 用户看到的是原有的「加载中…」
  // 而不是一块空白；而下面的 `disposed || seq !== loadSeq` 闸门本来就排在 await 之后，
  // 两处 await（取运行期面 + 释放旧 task）共用同一道闸，不必再加一条。
  const pdfjs = await loadPdfjs();
  // 先释放上一份：切 url 时它对应的 worker 还活着，留着就是一次泄漏。
  await releaseLoadingTask();
  // ⚠️ 必须在建 task **之前** bail：上面那两次 await 期间可能又来了一次 load（url
  // 再变）或组件已卸载，那种情况下本次不该再建 task —— 建出来的那份会被后一次
  // load 覆盖掉 loadingTask，从此没有任何句柄能 destroy 它（孤儿 worker），还白白多下
  // 一次同一份文档。
  if (disposed || seq !== loadSeq) return;
  const task = pdfjs.getDocument({ url: props.url, ...PDF_CMAP_OPTIONS });
  loadingTask = task;
  try {
    const doc = await task.promise;
    if (isStale(task)) return;
    pdfDoc = doc;
    totalPages.value = doc.numPages;
    if (page.value < 1) page.value = 1;
    if (page.value > totalPages.value) page.value = totalPages.value;
  } catch (e) {
    // 被自己 release 掉的 task 会以 "Worker was destroyed" / "Loading aborted" 拒绝，
    // 那不是加载失败：不上屏（否则切 url 会闪一句假报错），不写回已卸载的视图。
    if (isStale(task)) return;
    error.value = (e as Error).message ?? 'PDF 加载失败';
    loading.value = false;
    return;
  }
  if (isStale(task)) return;
  // 先让 Vue 把 canvas-wrap（含 canvas）插入 DOM，
  // 否则 render() 中 canvasRef.value 为 null，绘画被静默跳过。
  loading.value = false;
  await nextTick();
  if (isStale(task)) return;
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
  const doc = pdfDoc;
  if (!doc || !canvasRef.value) return;
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      /* ignore */
    }
  }
  let p: pdfjsLib.PDFPageProxy;
  try {
    p = await doc.getPage(page.value);
  } catch (e) {
    // 2026-10-20 补：失败**分两种**，别合成一句「拿不到页就算了」——
    //   · 已卸载 / 这份 doc 已随它的 task 被释放（换文件会 destroy 旧 task，在途 getPage
    //     于是以 "Worker was destroyed" 拒绝）⇒ 竞态的正常收尾，静默放弃，新文档的
    //     load / render 会自己重画。render() 由复位 / +/- / ResizeObserver 以 void 调用，
    //     抛出去就是一条未处理拒绝，所以这里必须吃掉。
    //   · 当前文档真的取不到页（页码越界、页面损坏、worker 崩溃）⇒ 留一行 warn。零日志地
    //     吞掉的话画布就静默停在空白或上一帧，排障时没有任何信号（同仓 SCAN_BANNER 的
    //     「丢弃 + 一行 warn」口径，也与本文件 releaseLoadingTask 的 warn 一致）。
    if (disposed || doc !== pdfDoc) return;
    console.warn(
      `[PdfViewer] 取页失败（第 ${page.value} 页）：${(e as Error).message ?? String(e)}`,
    );
    return;
  }
  // ⚠️ getPage 是 await，醒来时这次渲染有两种「已作废」，后果不同、守卫也不同 ——
  // load() 的那道守卫管不到这里（render 还被复位 / +/- / ResizeObserver 直接调用）：
  //   · **已卸载** ⇒ canvasRef 已被 Vue 置 null，继续摸 canvas.width 是 TypeError
  //     （`!canvas` 拦；`disposed` 是同义的第二道，卸载收尾里两者不保证同一时刻）；
  //   · **已换文档**（含旧 task 被释放、`pdfDoc` 已置 null）⇒ canvas 还在，不会 TypeError，
  //     但会把**上一份文档的页**画到新画布上，工人看到闪一帧旧图纸 —— `doc !== pdfDoc` 拦。
  const canvas = canvasRef.value;
  if (disposed || !canvas || doc !== pdfDoc) return;
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
  // 2026-10-20 修 Worker 泄漏：先立「已卸载」标志，再做收尾 —— 正在 await
  // task.promise 的 load() 醒来后据此跳过写状态与渲染。
  disposed = true;
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
    renderTask = null;
  }
  // 唯一的 worker 回收点（2026-10-20）：destroy-on-close 的承载弹窗每开一次就新建
  // 一个 pdf.js worker，不在此终止就是每开一次漏一个线程。doc 侧的清理由 destroy()
  // 一并完成（它会清 pageCache / commonObjs / fontLoader 并终止 worker），
  // 故不再单独调 pdfDoc.cleanup()。
  pdfDoc = null;
  void releaseLoadingTask();
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
