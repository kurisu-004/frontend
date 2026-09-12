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
      （同时声明 height/flex：flex 父容器用 flex:1，block 父容器用 height:100%）
    - .canvas-wrap 加 flex: 1 / min-height: 0（已在第三轮加过 flex: 1）
    - .pdf-toolbar 加 flex-shrink: 0
    - DrawingPreviewPane.vue 的 .file-preview 改为 display:flex/flex-direction:column（让 PdfViewer 在此成为 flex item）
    - 完整高度链：preview-card (flex:1) → preview-tabs (flex:1) → file-preview (flex:1, flex col) → pdf-viewer (flex:1) → canvas-wrap (flex:1) → viewport (flex:1) 撑满父容器
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
// 2026-09-12 新增：鼠标点中心缩放（纯 CSS transform，不触发 render）
// 2026-09-12 第四轮改造：删除 250ms 节流的 scheduleReRender —— 节流触发的 render() 会改
// canvas.width/height/style.width/style.height，引起 layout shift 视觉抖动。
// 现在滚轮只调整 viewScale / tx / ty，由 CSS transform 处理；PDF bitmap 不重渲染。
// 权衡：极高缩放（>3x）会出现像素感，但避免每次 wheel 后的 canvas 重排抖动；
// 如需矢量清晰可点 +/- 按钮（zoomIn / zoomOut）触发 render() 重渲染。
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
  // 不再调 scheduleReRender() —— 防止 canvas 内部尺寸变化引发抖动
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
// 2026-09-12 第四轮（T3）：完整高度链让 viewport 撑满父容器
//   preview-card (flex:1) → .pdf-viewer (height:100%) → .canvas-wrap (flex:1) → .pdf-viewport (flex:1)
// 关键：.pdf-viewer 必须声明 height: 100% 才能继承自上而下的高度链；
//       min-height: 0 允许 flex 子项收缩到 0（避免内容撑爆）。
.pdf-viewer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  // 2026-09-12 第四轮：同时声明 height:100% 和 flex:1
  //   - flex 父容器（如 DrawingPreviewPane 的 .file-preview 现在是 flex column）→ flex:1 生效
  //   - block 父容器 + definite height（如 FileListCard 的 el-dialog body）→ height:100% 生效
  height: 100%;
  flex: 1 1 auto;
  min-height: 0;       /* ← 去掉 400px 下限 */
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
  flex: 1;             /* ← 撑满父容器 */
  min-height: 0;
}
.pdf-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;      /* ← toolbar 不被压缩 */
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
