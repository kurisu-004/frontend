<!--
  StepViewerProgress.vue

  2026-09-20 新增：3D 模型加载进度条（覆盖在 canvas 上方）。

  阶段：
   - 0~5: wasm 初始化（occt-wasm.emcripten 主线程初始化）
   - 5~40: parse（STEP 文本 → OCCT shape handle）
   - 40~100: tessellate（mesh + wireframe → three.js BufferGeometry）

  来源：OcctStepLoader 的 onProgress 回调（5/40/60/100 四个 checkpoint）。
-->
<template>
  <div class="step-viewer-progress-overlay">
    <el-progress :percentage="percent" :stroke-width="10" text-inside />
    <p class="hint">正在加载 3D 模型…</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  percent: number;
}>();
</script>

<style lang="scss" scoped>
.step-viewer-progress-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(238, 241, 245, 0.85);
  z-index: 20;
  pointer-events: none;
  :deep(.el-progress) {
    width: 60%;
    max-width: 360px;
  }
  .hint {
    margin: 0;
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }
}
</style>
