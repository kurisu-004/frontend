<!--
  ImagePager.vue — 图纸**图片模式**翻页器（2026-10-13 新增）。

  替代 PdfViewer 承载「多页图纸预览」的主力路径：图纸由后端 CI 转成逐页图片直链
  （`GET /files/objects/{id}/preview` → `FilePreviewResult.pages`），本组件把那些
  直链挂成可翻页 / 可缩放的图片流，浏览器不再下载整份 PDF 交给 pdf.js 解析。

  ── 能力取舍（本轮产品已接受，不是待办）─────────────────────────────
  图片模式相对 PDF 模式**少两件能力**，这是「服务端出图」这条路线的固有代价：
    1. **没有矢量缩放**：放大看细节会糊（源图分辨率是 CI 出图时定死的）。PDF 模式
       的 `renderScale` 会让 pdf.js 按新分辨率重渲染，图片模式无从重渲染 ——
       滚轮只动 CSS `transform`，越放大越像素化。
    2. **没有文字选中 / 标注**：位图里选不中字、也拖不出选区。
  ⇒ **逃生口是必须的**，不是可选优化：每个承载点都要保留「查看原始 PDF」入口
  （走 `/content` + PdfViewer），用户要看细节、要复制尺寸标注时能退回去。本组件
  因此**刻意不内置**原文档开关 —— 它不持有 fileId、也不知道原始 PDF 在哪，
  那是承载方的事（各自的 blob 生命周期不同）。

  ── 与 PdfViewer 刻意不同的地方 ─────────────────────────────────────
  PdfViewer 的双 scale 模型（`renderScale` 管矢量重渲染分辨率 / `viewScale` 管 CSS
  乘数）在图片模式下**没有意义** —— 没有重渲染这一步，两个 scale 合并成单个
  `scale`。相应地也省掉 `fitPending` + ResizeObserver 补算那套：图片的「fit」在
  `<img>` 拿到 `naturalWidth/naturalHeight` 之后一次算清即可（尺寸随图片一起到，
  不像 canvas 要等 pdfjs 渲染完才知道）。所以这里只有**一个** scale 与一组平移。

  交互（与 PdfViewer 对齐，工人不用学两套）：
    - 滚轮缩放（鼠标点锚定）/ 双指缩放（触控屏，工控机与平板场景）/ 左键拖动平移；
    - 双击复位 = 回到「整页塞进容器」；
    - 工具栏 上一页 / 下一页 + `n / total`（页数 > 1 才显示，单页图藏按钮）；
    - 缩放区间 [0.1, 10] 与 PdfViewer 的 [-] 区间一致。

  ── 承载契约（高度链，与 PdfViewer 同款）─────────────────────────────
  .image-pager{height:100%} → .canvas-wrap{flex:1} → .img-viewport{flex:1;overflow:hidden}
  同样要求宿主有确定高度。el-dialog 承载时挂 `.img-preview-dialog`（全局规则见
  src/styles/index.scss，与 `.pdf-preview-dialog` 同一套 flex 分高写法）；
  自带高度的宿主（.file-preview flex 链 / aspect-ratio 定宽定高）天然满足。
-->
<template>
  <div class="image-pager">
    <div v-if="!pages.length" class="empty">
      <el-icon :size="24" color="#909399"><Picture /></el-icon>
      <span>暂无预览图</span>
    </div>
    <div v-else class="canvas-wrap">
      <div class="pager-toolbar">
        <el-button-group v-if="totalPages > 1">
          <el-button :disabled="page <= 1" @click="prevPage">
            <el-icon><ArrowLeft /></el-icon>
            <span>上一页</span>
          </el-button>
          <el-button :disabled="page >= totalPages" @click="nextPage">
            <span>下一页</span>
            <el-icon><ArrowRight /></el-icon>
          </el-button>
        </el-button-group>
        <span v-if="totalPages > 1" class="page-info">{{ page }} / {{ totalPages }}</span>
        <el-button @click="zoomIn"
          ><el-icon><ZoomIn /></el-icon
        ></el-button>
        <el-button @click="zoomOut"
          ><el-icon><ZoomOut /></el-icon
        ></el-button>
        <!-- 复位 = 回到「整页塞进容器」，不是回到 1 倍（与 PdfViewer 同一口径） -->
        <el-button title="双击也可复位" @click="resetView">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </div>
      <div
        ref="viewportRef"
        class="img-viewport"
        @wheel.prevent="onWheel"
        @mousedown="onMouseDown"
        @dblclick="resetView"
        @touchstart="onTouchStart"
        @touchmove.prevent="onTouchMove"
        @touchend="onTouchEnd"
      >
        <div
          class="img-stage"
          :style="{
            width: `${stageWidth}px`,
            height: `${stageHeight}px`,
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: '0 0',
          }"
        >
          <img
            :key="currentSrc"
            :src="currentSrc"
            class="pager-image"
            alt="图纸预览"
            draggable="false"
            @load="onImageLoad"
            @error="onImageError"
          />
        </div>
      </div>
      <div v-if="imgError" class="img-error">{{ imgError }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ArrowLeft, ArrowRight, Picture, Refresh, ZoomIn, ZoomOut } from '@element-plus/icons-vue';

interface Props {
  /** 逐页图片直链（`FilePreviewResult.pages`）。空数组 ⇒ 渲染空态，不报错。 */
  pages: string[];
  /** 初始页码（1-based）；仅在打开时定一次，翻页改内部状态、不回写本 prop。 */
  page?: number;
  /** 是否按容器尺寸把整页塞进容器（默认 true）。关掉则恒以 1 倍起手、只由用户缩放改。 */
  fit?: boolean;
  /** fit 算不出（宿主尚未布局）时的回落比例。 */
  initialScale?: number;
}
const props = withDefaults(defineProps<Props>(), {
  page: 1,
  fit: true,
  initialScale: 1.0,
});

const viewportRef = ref<HTMLElement | null>(null);
const page = ref((() => props.page)());
// 图片的原始像素尺寸（@load 事件给）。fit 的分母就是它。
const naturalWidth = ref(0);
const naturalHeight = ref(0);
const stageWidth = ref(0);
const stageHeight = ref(0);
const imgError = ref<string | null>(null);

// 单 scale 模型：图片没有「按新分辨率重渲染」这一步（见文件头），故 PdfViewer 的
// renderScale / viewScale 双模型合并成一个连续值。
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const userZoomed = ref(false);

const SCALE_MIN = 0.1;
const SCALE_MAX = 10;
const ZOOM_STEP = 0.2;
// fit 的夹逼区间与 PdfViewer 同款：下界 0.05 防算成 0（图片缩到 0 不可见），
// 上界 8 防超小页面被放成马赛克。
const FIT_MIN_SCALE = 0.05;
const FIT_MAX_SCALE = 8;

const pages = computed<string[]>(() => props.pages ?? []);
const totalPages = computed<number>(() => pages.value.length);
const currentSrc = computed<string>(() => pages.value[page.value - 1] ?? '');

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 「整页塞进 .img-viewport」的比例；容器没量到尺寸（或图片还没 load）时返回 null。 */
function fitScale(): number | null {
  const host = viewportRef.value;
  if (!host) return null;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!(w > 0) || !(h > 0)) return null;
  if (!(naturalWidth.value > 0) || !(naturalHeight.value > 0)) return null;
  return clamp(
    Math.min(w / naturalWidth.value, h / naturalHeight.value),
    FIT_MIN_SCALE,
    FIT_MAX_SCALE,
  );
}

/** 图片 load 后：记下原始尺寸并落 scale。fit 算不出时回落 initialScale。 */
function onImageLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  naturalWidth.value = img.naturalWidth;
  naturalHeight.value = img.naturalHeight;
  imgError.value = null;
  stageWidth.value = naturalWidth.value;
  stageHeight.value = naturalHeight.value;
  // 只有「用户还没表过态」时才允许 fit 覆写 scale；用户缩放过就别替他丢掉选择。
  if (props.fit && !userZoomed.value) {
    const fit = fitScale();
    if (fit !== null) scale.value = fit;
  }
}

function onImageError(): void {
  imgError.value = '预览图加载失败，可点「查看原始 PDF」打开原文件';
}

/** 翻页 = 重新适应整页（图纸各页图幅不同，带着上一页缩放会看不到全貌）。 */
function prevPage(): void {
  if (page.value > 1) {
    page.value -= 1;
    resetView();
  }
}
function nextPage(): void {
  if (page.value < totalPages.value) {
    page.value += 1;
    resetView();
  }
}

function zoomIn(): void {
  userZoomed.value = true;
  scale.value = clamp(scale.value + ZOOM_STEP, SCALE_MIN, SCALE_MAX);
}
function zoomOut(): void {
  userZoomed.value = true;
  scale.value = clamp(scale.value - ZOOM_STEP, SCALE_MIN, SCALE_MAX);
}

/** 复位 = 回到「整页塞进容器」（fit 开启时）。三样一起归位，缺一就不成立。 */
function resetView(): void {
  userZoomed.value = false;
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
  const fit = fitScale();
  if (fit !== null) scale.value = fit;
}

// ============ 滚轮缩放（鼠标点锚定）============
function onWheel(e: WheelEvent): void {
  const viewport = viewportRef.value;
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const oldScale = scale.value;
  const newScale = clamp(oldScale * factor, SCALE_MIN, SCALE_MAX);
  if (newScale === oldScale) return;

  // 调整 tx/ty 让鼠标点保持锚定：
  //   缩放后同一 stage 坐标应对应同一个鼠标点 ⇒ newTx = mouseX - (mouseX - oldTx) * ratio
  const ratio = newScale / oldScale;
  tx.value = mouseX - (mouseX - tx.value) * ratio;
  ty.value = mouseY - (mouseY - ty.value) * ratio;
  scale.value = newScale;
  userZoomed.value = true;
}

// ============ 双指缩放（触控屏）============
// 2026-10-13：工控机与平板上有触摸屏，没有滚轮就没有连续缩放入口。
// 只认两指同时按下时的距离变化；单指不缩放（拖动平移在桌面端走鼠标，这里不重复实现）。
let pinchStartDist = 0;
let pinchStartScale = 1;

function touchDistance(t: TouchList): number {
  const a = t[0];
  const b = t[1];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function onTouchStart(e: TouchEvent): void {
  if (e.touches.length !== 2) return;
  pinchStartDist = touchDistance(e.touches);
  pinchStartScale = scale.value;
}

function onTouchMove(e: TouchEvent): void {
  if (e.touches.length !== 2 || pinchStartDist <= 0) return;
  const dist = touchDistance(e.touches);
  if (dist <= 0) return;
  scale.value = clamp((pinchStartScale * dist) / pinchStartDist, SCALE_MIN, SCALE_MAX);
  userZoomed.value = true;
}

function onTouchEnd(): void {
  pinchStartDist = 0;
}

// ============ 拖动平移 ============
// 通过 window 监听 mouseup，避免鼠标移出 viewport 后卡在 dragging 态。
const dragging = ref(false);
const dragStart = ref({ x: 0, y: 0, tx: 0, ty: 0 });

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return; // 只响应左键
  dragging.value = true;
  dragStart.value = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent): void {
  if (!dragging.value) return;
  // 除以 scale：缩放后拖动灵敏度不该漂移（屏幕上走 10px 恒等于图上走 10/scale px）。
  tx.value = dragStart.value.tx + (e.clientX - dragStart.value.x) / scale.value;
  ty.value = dragStart.value.ty + (e.clientY - dragStart.value.y) / scale.value;
}

function onMouseUp(): void {
  dragging.value = false;
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
}

// ============ 入参变化 ============
// pages 换一批（新打开一份文件）⇒ 页数、当前页、视图全部归位。
// 承载点通常还会给 `:key="fileId"`，那会把组件整个重建；这里仍做兜底，
// 因为 `:key` 不是接口契约的一部分（PdfViewer 的 `url` watch 同理）。
watch(
  () => props.pages,
  () => {
    page.value = clamp(props.page, 1, Math.max(totalPages.value, 1));
    imgError.value = null;
    userZoomed.value = false;
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
    naturalWidth.value = 0;
    naturalHeight.value = 0;
    stageWidth.value = 0;
    stageHeight.value = 0;
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
});
</script>

<style lang="scss" scoped>
// 高度链与 PdfViewer 同款（宿主确定高度 → .image-pager height:100% → .canvas-wrap
// flex:1 → .img-viewport flex:1），承载 el-dialog 须挂 .img-preview-dialog。
.image-pager {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
.empty {
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
  flex: 1;
  min-height: 0;
}
.pager-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.page-info {
  font-size: 13px;
  color: var(--text-secondary);
}
.img-viewport {
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
.img-stage {
  position: absolute;
  top: 0;
  left: 0;
  transition: transform 0.05s linear;
  will-change: transform;
}
.pager-image {
  display: block;
  border: 1px solid var(--border-color);
  background: #fff;
  // 位图放大不重渲染，交给浏览器插值即可；不平滑是为了让「已经糊了」这件事可见。
  image-rendering: auto;
  -webkit-user-drag: none;
}
.img-error {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--el-color-danger);
  text-align: center;
}
</style>
