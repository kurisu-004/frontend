<!--
  StepViewerToolbar.vue

  2026-09-20 新增：3D 视图控制工具条。
  - 7 个视图预设按钮（iso / xp / xn / yp / yn / zp / zn），点击后 ViewPresets.applyPreset
    做 400ms 平滑过渡（lerp position + slerp quaternion）。
  - 网格 toggle + CubeGizmo toggle：同步到 useStepViewer 模块级 ref，触发 SceneManager / CubeGizmo
    显隐变更。
-->
<template>
  <div class="step-viewer-toolbar-inner">
    <el-button-group>
      <el-button
        v-for="preset in PRESETS"
        :key="preset.id"
        size="small"
        :type="activePreset === preset.id ? 'primary' : 'default'"
        @click="applyViewPreset(preset.id)"
      >
        {{ preset.label }}
      </el-button>
    </el-button-group>

    <el-checkbox v-model="gridVisibleLocal" label="网格" />
    <el-checkbox v-model="gizmoVisibleLocal" label="立方体" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { SceneManager } from '@/three/SceneManager';
import { applyPreset, VIEW_PRESETS, type ViewPresetId } from '@/three/ViewPresets';
import { useStepViewer } from './useStepViewer';

const props = defineProps<{
  /** SceneManager 实例（外部 v-if 已保证非空，但 TS 类型上保留 nullable 方便 StepViewer.vue
   * 模板里 `v-if="sceneManager"` 后直接传，避免 vue-tsc 报错） */
  sceneManager: SceneManager | null;
}>();

const {
  gridVisible,
  gizmoVisible,
  activePreset,
  setGridVisible,
  setGizmoVisible,
  setActivePreset,
} = useStepViewer();

// gridVisibleLocal / gizmoVisibleLocal 是 v-model 用的本地 mirror ref，
// 监听外部模块级 ref 的变化回写（如父组件重置默认），避免双向绑定循环
const gridVisibleLocal = ref<boolean>(gridVisible.value);
const gizmoVisibleLocal = ref<boolean>(gizmoVisible.value);

watch(gridVisible, (v) => (gridVisibleLocal.value = v));
watch(gizmoVisible, (v) => (gizmoVisibleLocal.value = v));
watch(gridVisibleLocal, (v) => setGridVisible(v));
watch(gizmoVisibleLocal, (v) => setGizmoVisible(v));

const PRESETS = VIEW_PRESETS;

function applyViewPreset(id: ViewPresetId): void {
  const preset = VIEW_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  const sm = props.sceneManager;
  if (!sm) return;
  setActivePreset(id);
  void applyPreset(sm.camera, sm.controls, preset, sm.getModelBoundingRadius(), 400);
}
</script>

<style lang="scss" scoped>
.step-viewer-toolbar-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}
</style>
