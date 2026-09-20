// 2026-09-20 新增：STEP 3D 预览器的跨页共享状态。
//
// 设计要点（对齐 frontend/CLAUDE.md #1）：
//   - 跨页共享（工序制定页 + 零件详情页都用同一组视图偏好），按硬约束用模块级 ref 单例。
//   - 不引 pinia / vue-router：纯 Vue ref，保持组件解耦，路由切换由消费方各自处理。
//   - 当前只承担"展示偏好"（grid 可见性 / gizmo 可见性 / 当前视图预设 / 模型信息）；
//     sceneManager / cubeGizmo 实例本身由 StepViewer 组件持有，组件 unmount 时 dispose。

import { ref, type Ref } from 'vue';
import type { ViewPresetId } from '@/three/ViewPresets';

export interface CurrentModelInfo {
  triangleCount: number;
  /** OCCT 包围盒（mm 或 STEP 原始单位，axis-aligned bbox） */
  bbox: {
    xmin: number;
    ymin: number;
    zmin: number;
    xmax: number;
    ymax: number;
    zmax: number;
  } | null;
}

const gridVisible: Ref<boolean> = ref(true);
const gizmoVisible: Ref<boolean> = ref(true);
const activePreset: Ref<ViewPresetId> = ref('iso');
const currentModelInfo: Ref<CurrentModelInfo | null> = ref(null);

function setGridVisible(v: boolean): void {
  gridVisible.value = v;
}

function setGizmoVisible(v: boolean): void {
  gizmoVisible.value = v;
}

function setActivePreset(p: ViewPresetId): void {
  activePreset.value = p;
}

function setCurrentModelInfo(info: CurrentModelInfo | null): void {
  currentModelInfo.value = info;
}

/** 组件 unmount 时清空 model info，避免下次进入时残留上一个 part 的统计 */
function clearCurrentModelInfo(): void {
  currentModelInfo.value = null;
}

export function useStepViewer(): {
  gridVisible: Ref<boolean>;
  gizmoVisible: Ref<boolean>;
  activePreset: Ref<ViewPresetId>;
  currentModelInfo: Ref<CurrentModelInfo | null>;
  setGridVisible: (v: boolean) => void;
  setGizmoVisible: (v: boolean) => void;
  setActivePreset: (p: ViewPresetId) => void;
  setCurrentModelInfo: (info: CurrentModelInfo | null) => void;
  clearCurrentModelInfo: () => void;
} {
  return {
    gridVisible,
    gizmoVisible,
    activePreset,
    currentModelInfo,
    setGridVisible,
    setGizmoVisible,
    setActivePreset,
    setCurrentModelInfo,
    clearCurrentModelInfo,
  };
}
