<!--
  PdfViewer.vue

  PDF 内嵌预览组件（基于 pdfjs-dist）。
  接收一个 url（COS 临时签名 URL，由后端即时签发），直接 GET 拉取 PDF 二进制并渲染。

  2026-09-12 新增：滚轮缩放（鼠标点中心）+ 左键拖动平移 + 双击复位。
  双 scale 模型：
    - renderScale: 给 pdfjs.getViewport 用（snap 0.1，0.4-3.0）；改变时触发 PDF 重渲染，保证矢量清晰
    - viewScale : CSS transform 乘数（连续，0.1-10）；仅 CSS 缩放，手感流畅
    - 滚轮 250ms 节流：每 250ms 把 viewScale 合并到 renderScale → render()，把 viewScale 重置 1
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
        <el-input-number
          v-model="renderScale"
          :min="0.4"
          :max="3"
          :step="0.2"
          :precision="1"
          size="small"
          controls-position="right"
          @change="onScaleInputChange"
        />
        <el-button @click="zoomIn"><el-icon><ZoomIn /></el-icon></el-button>
        <el-button @click="zoomOut"><el-icon><ZoomOut /></el-icon></el-button>
        <el-button @click="resetView" title="双击也可复位">
          <el-icon><Refresh /></el-icon>
        </el-button>
        <el-button @click="download">
          <el-icon><Download /></el-icon>
          <span>下载</span>
        </el-button>
      </div>
      <div
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft,
  ArrowRight,
  CircleClose,
  Download,
  Loading,
  Refresh,
  ZoomIn,
  ZoomOut,
} from '@element-plus/icons-vue'
import { pdfjsLib, PDF_CMAP_OPTIONS } from '@/utils/pdfjs'

interface Props {
  url: string
  page?: number
  initialScale?: number
}
const props = withDefaults(defineProps<Props>(), {
  page: 1,
  initialScale: 1.0,
})

const canvasRef = ref<HTMLCanvasElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const page = ref(props.page)
const totalPages = ref(0)

// ============ 双 scale 模型 ============
// 2026-09-12 新增
const renderScale = ref(props.initialScale) // pdfjs 渲染分辨率（snap 0.1，0.4-3.0）
const viewScale = ref(1) // CSS transform 乘数（连续，0.1-10）
const tx = ref(0) // 平移 x（屏幕 px）
const ty = ref(0) // 平移 y
const totalScale = computed(() => renderScale.value * viewScale.value)

// stage 实际尺寸（按 renderScale 渲染出的画布像素 / devicePixelRatio），用于占位 div 宽度
const stageWidth = ref(0)
const stageHeight = ref(0)

let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null
let renderTask: pdfjsLib.RenderTask | null = null

async function load() {
  if (!props.url) return
  loading.value = true
  error.value = null
  try {
    const task = pdfjsLib.getDocument({ url: props.url, ...PDF_CMAP_OPTIONS })
    pdfDoc = await task.promise
    totalPages.value = pdfDoc.numPages
    if (page.value < 1) page.value = 1
    if (page.value > totalPages.value) page.value = totalPages.value
  } catch (e) {
    error.value = (e as Error).message ?? 'PDF 加载失败'
    loading.value = false
    return
  }
  // 先让 Vue 把 canvas-wrap（含 canvas）插入 DOM，
  // 否则 render() 中 canvasRef.value 为 null，绘画被静默跳过。
  loading.value = false
  await nextTick()
  await render()
}

async function render() {
  if (!pdfDoc || !canvasRef.value) return
  if (renderTask) {
    try {
      renderTask.cancel()
    } catch {
      /* ignore */
    }
  }
  const p = await pdfDoc.getPage(page.value)
  const viewport = p.getViewport({ scale: renderScale.value * (window.devicePixelRatio || 1) })
  const canvas = canvasRef.value
  canvas.width = viewport.width
  canvas.height = viewport.height
  const cssWidth = viewport.width / (window.devicePixelRatio || 1)
  const cssHeight = viewport.height / (window.devicePixelRatio || 1)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`
  stageWidth.value = cssWidth
  stageHeight.value = cssHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  renderTask = p.render({ canvas: canvas, canvasContext: ctx, viewport })
  await renderTask.promise.catch(() => {
    /* cancelled */
  })
}

function prevPage() {
  if (page.value > 1) {
    page.value -= 1
    void render()
  }
}
function nextPage() {
  if (page.value < totalPages.value) {
    page.value += 1
    void render()
  }
}
function zoomIn() {
  renderScale.value = Math.min(3, +(renderScale.value + 0.2).toFixed(1))
  viewScale.value = 1
  void render()
}
function zoomOut() {
  renderScale.value = Math.max(0.4, +(renderScale.value - 0.2).toFixed(1))
  viewScale.value = 1
  void render()
}

/** el-input-number 的 @change 回调：参数可能是新值（number）或 undefined（用户清空）。 */
function onScaleInputChange(v: number | undefined): void {
  if (typeof v !== 'number' || Number.isNaN(v)) return
  renderScale.value = clamp(v, 0.4, 3)
  viewScale.value = 1
  void render()
}

function download() {
  const a = document.createElement('a')
  a.href = props.url
  a.target = '_blank'
  a.rel = 'noopener'
  a.download = ''
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// ============ 滚轮缩放 ============
// 2026-09-12 新增：鼠标点中心缩放 + 250ms 节流 viewScale → renderScale → render()
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function onWheel(e: WheelEvent) {
  const viewport = document.querySelector('.pdf-viewport') as HTMLElement | null
  if (!viewport) return
  const rect = viewport.getBoundingClientRect()
  const mouseX = e.clientX - rect.left
  const mouseY = e.clientY - rect.top

  const direction = e.deltaY < 0 ? 1 : -1
  const factor = direction > 0 ? 1.1 : 1 / 1.1
  const newViewScale = clamp(viewScale.value * factor, 0.1, 10)

  // 调整 tx, ty 让鼠标点保持锚定：
  //   oldMouseX = mouseX   =>   oldMouseX = (oldStageX * oldTotal) + oldTx
  //   缩放后同一 stage 坐标应对应同一个鼠标点：
  //   newTx = mouseX - (mouseX - oldTx) * (newTotal / oldTotal)
  const oldTotal = totalScale.value
  const newTotal = renderScale.value * newViewScale
  const ratio = newTotal / oldTotal
  tx.value = mouseX - (mouseX - tx.value) * ratio
  ty.value = mouseY - (mouseY - ty.value) * ratio

  viewScale.value = newViewScale
  scheduleReRender()
}

let reRenderTimer: number | null = null
function scheduleReRender() {
  if (reRenderTimer !== null) return
  reRenderTimer = window.setTimeout(() => {
    // 把 viewScale 合并到 renderScale，viewScale 重置为 1，保证 PDF 矢量清晰
    const merged = clamp(renderScale.value * viewScale.value, 0.4, 3)
    renderScale.value = +(merged).toFixed(1)
    viewScale.value = 1
    reRenderTimer = null
    void render()
  }, 250)
}

// ============ 拖动平移 ============
// 2026-09-12 新增：左键拖动；通过 window 监听 mouseup（避免鼠标离开 viewport 后卡死）
const dragging = ref(false)
const dragStart = ref({ x: 0, y: 0, tx: 0, ty: 0 })

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return // 只响应左键
  dragging.value = true
  dragStart.value = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}
function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return
  // 把屏幕像素位移转成 stage 坐标位移（除以 totalScale，避免 zoom 下拖动灵敏度漂移）
  const scale = totalScale.value
  tx.value = dragStart.value.tx + (e.clientX - dragStart.value.x) / scale
  ty.value = dragStart.value.ty + (e.clientY - dragStart.value.y) / scale
}
function onMouseUp() {
  dragging.value = false
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

// ============ 复位 ============
// 2026-09-12 新增：双击 / 工具栏复位按钮
function resetView() {
  viewScale.value = 1
  tx.value = 0
  ty.value = 0
}

watch(
  () => props.url,
  () => {
    // 切 url 时同时重置视图，避免新 PDF 继承上一次的平移
    resetView()
    void load()
  },
)
watch(
  () => props.page,
  (v) => {
    page.value = v
    void render()
  },
)

onMounted(load)
onBeforeUnmount(() => {
  if (reRenderTimer !== null) {
    window.clearTimeout(reRenderTimer)
    reRenderTimer = null
  }
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  if (renderTask) {
    try {
      renderTask.cancel()
    } catch {
      /* ignore */
    }
  }
  if (pdfDoc) {
    void pdfDoc.cleanup()
  }
})
</script>

<style lang="scss" scoped>
.pdf-viewer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 400px;
  min-width: 0;
  height: 100%;
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
  flex: 1;
  min-height: 0;
}
.pdf-toolbar {
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
