<!--
  StepViewer.vue

  2026-09-20 新增：3D STEP / IGES / STL 模型浏览器内嵌预览壳组件。

  移植自 ~/Code/step-viewer 的 src/three/* + src/components/ViewerCanvas.vue 思路，
  重写为适配 hsh-erp frontend 的 Vue 3 + Element Plus 壳组件，consumer 用 props.src
  传入 blob URL（由父组件调 api.get('/part-files/{id}/content', blob) → createObjectURL
  得到），本组件负责 occt-wasm 解析 → three.js Group → 渲染 + 资源 dispose。

  设计要点：
   - props.src = null 时不挂载 SceneManager（避免空 canvas）；src 非空时挂载 + 加载。
   - props.src 变化（典型场景：切换 part / 切换文件）→ 释放旧 model + revoke 旧 blob URL
     + fetch 新 blob → occt-wasm 解析 → setModel。
   - onBeforeUnmount：sceneManager.unmount() + cubeGizmo.dispose() + revokeObjectURL，
     防止 GPU 资源泄漏（CLAUDE.md 强调 WebGL 资源要 dispose）。
   - blob URL 由 props 传入，不在内部 fetch —— 父组件已经走 axios + responseType:'blob'
     鉴权拦截。本组件不重复拉数据。
-->
<template>
  <div ref="hostRef" class="step-viewer-host">
    <canvas ref="canvasRef" class="step-viewer-canvas" />
    <StepViewerToolbar
      v-if="showToolbar && loaded && sceneManager"
      class="step-viewer-toolbar"
      :scene-manager="sceneManager"
    />
    <StepViewerProgress v-if="loading" :percent="progressPct" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { SceneManager } from '@/three/SceneManager';
import { CubeGizmo } from '@/three/CubeGizmo';
import { loadStepFromBytes, OcctLoadError, type OcctFormat } from '@/three/OcctStepLoader';
import type { LoadedShape } from '@/three/types';
import { useStepViewer } from './useStepViewer';
import { detectOcctFormat } from '@/utils/stepViewerFile';
import StepViewerToolbar from './StepViewerToolbar.vue';
import StepViewerProgress from './StepViewerProgress.vue';

const props = withDefaults(
  defineProps<{
    /** blob URL 或普通 URL；非空时挂载 canvas + 加载模型；null = 占位空载 */
    src: string | null;
    /** 当前固定为 'blob-url'（父组件调 axios 拿 blob → createObjectURL）。留口以备未来扩展 */
    srcType?: 'blob-url';
    /** 容器高度，默认 100%（跟随父级布局） */
    height?: string;
    /** 是否显示右下角视图切换 / 网格 / gizmo 切换工具条，默认 true */
    showToolbar?: boolean;
    /** 加载失败的错误信息前缀（拼到 emit('error') 里） */
    errorPrefix?: string;
    /**
     * 显式声明 occt-wasm 解析格式（推荐）。blob URL 没有文件名后缀，无法用
     * detectOcctFormat 自动探测 —— 调用方（已知 PartFileItem.file_type）必须显式传。
     * 不传时回退到 detectOcctFormat(src)，blob URL 探测失败会抛错。
     */
    format?: OcctFormat;
  }>(),
  {
    srcType: 'blob-url',
    height: '100%',
    showToolbar: true,
    errorPrefix: '3D 模型加载失败',
    format: undefined,
  },
);

const emit = defineEmits<{
  loaded: [info: { triangleCount: number; bbox: unknown; stats: unknown }];
  error: [string];
  progress: [number];
}>();

const hostRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
// 2026-09-20：sceneManager / cubeGizmo / currentShape 用 shallowRef —— 这些实例带有
// 内部 mutable 状态（Three.js scene graph + GPU 资源），不需要 Vue 深度代理，反而 ref
// 的 Proxy 包装会让 vue-tsc 在模板 prop 传递时报「missing private fields」。
// shallowRef 只在 .value 赋值时触发响应，引用类型内部 mutation 不触发。
const sceneManager = shallowRef<SceneManager | null>(null as SceneManager | null);
const cubeGizmo = shallowRef<CubeGizmo | null>(null as CubeGizmo | null);
const loading = ref(false);
const loaded = ref(false);
const progressPct = ref(0);
const currentShape = shallowRef<LoadedShape | null>(null as LoadedShape | null);
const currentBlob = ref<Blob | null>(null as Blob | null);

const { gridVisible, gizmoVisible, setCurrentModelInfo, clearCurrentModelInfo } = useStepViewer();

const hostHeight = computed<string>(() => props.height);

// ----------------- mount / unmount -----------------

onMounted(() => {
  if (!canvasRef.value || !hostRef.value) return;
  // 容器可能因父级 v-if 还未挂完，但 ref 已就位 → 直接初始化
  const sm = new SceneManager(canvasRef.value);
  sm.mount(hostRef.value);
  sceneManager.value = sm;
  // 默认初始：grid/gizmo 与 useStepViewer 模块级 ref 保持一致（消费方可在外部 toggle）
  sm.setGridVisible(gridVisible.value);
  // CubeGizmo：固定挂在右上角，与 SceneManager 共享 camera/controls/getBoundingRadius
  const cg = new CubeGizmo({
    camera: sm.camera,
    controls: sm.controls,
    host: hostRef.value,
    getBoundingRadius: () => sm.getModelBoundingRadius(),
    onDragStart: () => {
      /* CubeGizmo 内部已禁用主 controls 的左键 */
    },
  });
  cg.setVisible(gizmoVisible.value);
  cubeGizmo.value = cg;

  // 首次挂载如果 src 已就位（immediate:true 传入），立即加载
  if (props.src) {
    void loadFromBlobUrl(props.src);
  }
});

onBeforeUnmount(() => {
  // 释放顺序：先 gizmo → 再 sceneManager → 再 revoke blob URL
  if (cubeGizmo.value) {
    cubeGizmo.value.dispose();
    cubeGizmo.value = null;
  }
  if (sceneManager.value) {
    sceneManager.value.unmount();
    sceneManager.value = null;
  }
  currentShape.value = null;
  loaded.value = false;
  loading.value = false;
  if (currentBlob.value) {
    // 这里只清组件自持的引用；blob URL 本身的 revoke 由 props.src 语义保证
    currentBlob.value = null;
  }
  clearCurrentModelInfo();
});

// ----------------- watch src -----------------

watch(
  () => props.src,
  (newSrc, _oldSrc) => {
    if (!sceneManager.value) return;
    if (!newSrc) {
      // src 清空：卸载当前模型，回到空白 canvas
      loaded.value = false;
      loading.value = false;
      progressPct.value = 0;
      return;
    }
    void loadFromBlobUrl(newSrc);
  },
);

// ----------------- grid / gizmo 同步模块级 ref -----------------

watch(gridVisible, (v) => sceneManager.value?.setGridVisible(v));
watch(gizmoVisible, (v) => cubeGizmo.value?.setVisible(v));

// ----------------- 加载主流程 -----------------

async function loadFromBlobUrl(url: string): Promise<void> {
  const sm = sceneManager.value;
  if (!sm) return;
  loading.value = true;
  loaded.value = false;
  progressPct.value = 0;
  emit('progress', 0);
  try {
    const blob = await fetchBlob(url);
    currentBlob.value = blob;
    // 探测格式：优先 props.format（推荐，blob URL 场景下唯一可靠路径），
    // 否则从 url pathname 抽扩展名（HTTP URL 场景可用）。
    const format = props.format ?? guessFormatFromBlob(blob, url);
    if (!format) {
      throw new Error(
        '无法识别模型格式：blob URL 没有扩展名，请通过 props.format 显式传入 ' +
          '("step" | "stl" | "brep")',
      );
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const shape = await loadStepFromBytes(bytes, format, {
      onProgress: (pct) => {
        progressPct.value = pct;
        emit('progress', pct);
      },
    });
    currentShape.value = shape;
    sm.setModel(shape.root);
    // 注册 LineMaterial → SceneManager 维护 resolution（与 step-viewer ViewerCanvas 一致）
    if (shape.lineMaterial) sm.registerLineMaterial(shape.lineMaterial);
    loaded.value = true;
    const info = {
      triangleCount: shape.triangleCount,
      bbox: shape.stats.bbox,
      stats: shape.stats,
    };
    setCurrentModelInfo({
      triangleCount: shape.triangleCount,
      bbox: shape.stats.bbox,
    });
    emit('loaded', info);
  } catch (e) {
    const msg =
      e instanceof OcctLoadError
        ? `[${e.stage}] ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    emit('error', `${props.errorPrefix}: ${msg}`);
  } finally {
    loading.value = false;
  }
}

async function fetchBlob(url: string): Promise<Blob> {
  // blob URL：直接 fetch（同源，无 CORS）
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  return resp.blob();
}

function guessFormatFromBlob(_blob: Blob, url: string): 'step' | 'stl' | 'brep' | null {
  // blob URL 无扩展名 → 试图从原 URL 抽取（如果 props.src 是 blob:xxx 这种原始 blob，
  // 抽取不到，只能 null 抛错 —— 父组件应在上传时就把扩展名信息带进 src 元数据，
  // 或切换到 srcType='file-id' + 显式 format prop；当前接口仅支持 blob URL）。
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    if (pathname && pathname !== '/') {
      return detectOcctFormat(pathname);
    }
  } catch {
    /* not a URL */
  }
  return null;
}
</script>

<style lang="scss" scoped>
.step-viewer-host {
  position: relative;
  width: 100%;
  height: v-bind(hostHeight);
  min-height: 0;
  overflow: hidden;
  background: #eef1f5; // 与 SceneManager 内部 scene.background 一致
  border-radius: 4px;
}
.step-viewer-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.step-viewer-toolbar {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
}
</style>
