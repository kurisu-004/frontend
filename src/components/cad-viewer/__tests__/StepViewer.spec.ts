// src/components/cad-viewer/__tests__/StepViewer.spec.ts
//
// 2026-09-20 新增：StepViewer 壳组件纯函数 / lifecycle 单测。
//
// 设计：vitest 跑在 node 环境（无 DOM），且本项目不引入 testing-library，
// 这里只对纯函数分支（stepViewerFile 工具函数）做覆盖；
// StepViewer.vue 的 mount/unmount 涉及 WebGL canvas，node 环境无法跑真实 three.js，
// 由 dev 模式手动验证覆盖（见 dev 模式 STEP 加载场景）。
//
// 真正 unit-test 友好的部分是 utils/stepViewerFile.ts —— 覆盖 is3DModelFileType /
// isOcctSupported / detectOcctFormat 三个判定函数的所有分支。

import { describe, it, expect } from 'vitest';
import {
  is3DModelFileType,
  isOcctSupported,
  detectOcctFormat,
  fileTypeToOcctFormat,
} from '@/utils/stepViewerFile';

describe('is3DModelFileType', () => {
  it('STEP / STP / IGES / IGS / STL / OBJ / 3MF 都视为 3D 模型', () => {
    for (const t of ['STEP', 'STP', 'IGES', 'IGS', 'STL', 'OBJ', '3MF']) {
      expect(is3DModelFileType(t)).toBe(true);
    }
  });

  it('小写扩展名也认（toUpperCase）', () => {
    expect(is3DModelFileType('step')).toBe(true);
    expect(is3DModelFileType('obj')).toBe(true);
  });

  it('PDF / PNG / DWG / DXF / NC 不算 3D 模型', () => {
    expect(is3DModelFileType('PDF')).toBe(false);
    expect(is3DModelFileType('PNG')).toBe(false);
    expect(is3DModelFileType('DWG')).toBe(false);
    expect(is3DModelFileType('DXF')).toBe(false);
    expect(is3DModelFileType('NC')).toBe(false);
  });

  it('空字符串 / null / undefined → false', () => {
    expect(is3DModelFileType('')).toBe(false);
    expect(is3DModelFileType(null)).toBe(false);
    expect(is3DModelFileType(undefined)).toBe(false);
  });
});

describe('isOcctSupported', () => {
  it('STEP / STP / IGES / IGS / STL / BREP occt-wasm 支持', () => {
    for (const t of ['STEP', 'STP', 'IGES', 'IGS', 'STL', 'BREP']) {
      expect(isOcctSupported(t)).toBe(true);
    }
  });

  it('OBJ / 3MF 当前 occt-wasm 不支持', () => {
    expect(isOcctSupported('OBJ')).toBe(false);
    expect(isOcctSupported('3MF')).toBe(false);
  });

  it('非 3D 类型一律 false', () => {
    expect(isOcctSupported('PDF')).toBe(false);
    expect(isOcctSupported('DWG')).toBe(false);
    expect(isOcctSupported('NC')).toBe(false);
  });

  it('空 / null / undefined → false', () => {
    expect(isOcctSupported('')).toBe(false);
    expect(isOcctSupported(null)).toBe(false);
    expect(isOcctSupported(undefined)).toBe(false);
  });
});

describe('detectOcctFormat', () => {
  it('.step / .stp → "step"', () => {
    expect(detectOcctFormat('part.step')).toBe('step');
    expect(detectOcctFormat('PART.STP')).toBe('step');
  });

  it('.stl → "stl"', () => {
    expect(detectOcctFormat('mesh.stl')).toBe('stl');
    expect(detectOcctFormat('MESH.STL')).toBe('stl');
  });

  it('.brep → "brep"', () => {
    expect(detectOcctFormat('shape.brep')).toBe('brep');
  });

  it('.obj / .3mf 不在 occt 白名单 → null', () => {
    expect(detectOcctFormat('mesh.obj')).toBeNull();
    expect(detectOcctFormat('mesh.3mf')).toBeNull();
  });

  it('未知后缀 → null（不强行当 step）', () => {
    expect(detectOcctFormat('foo.pdf')).toBeNull();
    expect(detectOcctFormat('foo.dwg')).toBeNull();
    expect(detectOcctFormat('foo')).toBeNull();
  });

  it('空 / null / undefined → null', () => {
    expect(detectOcctFormat('')).toBeNull();
    expect(detectOcctFormat(null)).toBeNull();
    expect(detectOcctFormat(undefined)).toBeNull();
  });
});

describe('fileTypeToOcctFormat', () => {
  it('STEP / STP / IGES / IGS → "step"（合并 IGES 类文本格式）', () => {
    expect(fileTypeToOcctFormat('STEP')).toBe('step');
    expect(fileTypeToOcctFormat('STP')).toBe('step');
    expect(fileTypeToOcctFormat('IGES')).toBe('step');
    expect(fileTypeToOcctFormat('IGS')).toBe('step');
  });

  it('STL → "stl"', () => {
    expect(fileTypeToOcctFormat('STL')).toBe('stl');
  });

  it('BREP → "brep"', () => {
    expect(fileTypeToOcctFormat('BREP')).toBe('brep');
  });

  it('OBJ / 3MF occt-wasm 不支持 → null', () => {
    expect(fileTypeToOcctFormat('OBJ')).toBeNull();
    expect(fileTypeToOcctFormat('3MF')).toBeNull();
  });

  it('非 3D 类型 → null', () => {
    expect(fileTypeToOcctFormat('PDF')).toBeNull();
    expect(fileTypeToOcctFormat('PNG')).toBeNull();
    expect(fileTypeToOcctFormat('DWG')).toBeNull();
    expect(fileTypeToOcctFormat('NC')).toBeNull();
  });

  it('小写也认（toUpperCase）', () => {
    expect(fileTypeToOcctFormat('step')).toBe('step');
    expect(fileTypeToOcctFormat('stl')).toBe('stl');
  });

  it('空 / null / undefined → null', () => {
    expect(fileTypeToOcctFormat('')).toBeNull();
    expect(fileTypeToOcctFormat(null)).toBeNull();
    expect(fileTypeToOcctFormat(undefined)).toBeNull();
  });
});
