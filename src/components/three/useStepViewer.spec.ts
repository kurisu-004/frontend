// src/components/three/useStepViewer.spec.ts
//
// 2026-09-20 新增：STEP 3D 预览器跨页共享状态单测。
// 验证：模块级 ref 单例（多次 useStepViewer 调用共享同一份状态）、setter 生效、默认值符合预期。

import { describe, it, expect } from 'vitest';
import { useStepViewer } from './useStepViewer';

describe('useStepViewer', () => {
  it('默认值：gridVisible=true / gizmoVisible=true / activePreset="iso" / currentModelInfo=null', () => {
    // 模块级 ref 在所有测试间共享（单例），所以测试间不能直接断言初始默认值
    // —— 但本文件作为单测入口（vitest 顺序），用 setCurrentModelInfo(null) 之前
    // 显式重置一次，确保基线可预测
    const cv = useStepViewer();
    cv.clearCurrentModelInfo();
    expect(cv.gridVisible.value).toBe(true);
    expect(cv.gizmoVisible.value).toBe(true);
    expect(cv.activePreset.value).toBe('iso');
    expect(cv.currentModelInfo.value).toBeNull();
  });

  it('setGridVisible 切换 gridVisible', () => {
    const cv = useStepViewer();
    cv.setGridVisible(false);
    expect(cv.gridVisible.value).toBe(false);
    cv.setGridVisible(true);
    expect(cv.gridVisible.value).toBe(true);
  });

  it('setGizmoVisible 切换 gizmoVisible', () => {
    const cv = useStepViewer();
    cv.setGizmoVisible(false);
    expect(cv.gizmoVisible.value).toBe(false);
    cv.setGizmoVisible(true);
    expect(cv.gizmoVisible.value).toBe(true);
  });

  it('setActivePreset 切换 activePreset', () => {
    const cv = useStepViewer();
    cv.setActivePreset('zp');
    expect(cv.activePreset.value).toBe('zp');
    cv.setActivePreset('iso');
    expect(cv.activePreset.value).toBe('iso');
  });

  it('setCurrentModelInfo / clearCurrentModelInfo', () => {
    const cv = useStepViewer();
    const info = {
      triangleCount: 1234,
      bbox: { xmin: -1, ymin: -1, zmin: -1, xmax: 1, ymax: 1, zmax: 1 },
    };
    cv.setCurrentModelInfo(info);
    expect(cv.currentModelInfo.value).toEqual(info);
    cv.clearCurrentModelInfo();
    expect(cv.currentModelInfo.value).toBeNull();
  });

  it('模块级单例：多次 useStepViewer 返回的 ref 引用同一份状态', () => {
    const a = useStepViewer();
    const b = useStepViewer();
    expect(a.gridVisible).toBe(b.gridVisible);
    expect(a.gizmoVisible).toBe(b.gizmoVisible);
    expect(a.activePreset).toBe(b.activePreset);
    expect(a.currentModelInfo).toBe(b.currentModelInfo);
  });
});
