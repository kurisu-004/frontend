// src/composables/__tests__/cosUploader.pickPlan.spec.ts
//
// 2026-09-28 新增：纯函数 planPick / matchesAccept 单测。

import { describe, expect, it } from 'vitest';
import { matchesAccept, planPick } from '../cosUploaderPickPlan';

function f(name: string, sizeBytes: number, type = 'application/octet-stream'): File {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

describe('matchesAccept', () => {
  it('解析 .pdf 后缀（拖拽 .PDF 大小写不敏感）', () => {
    expect(matchesAccept(f('a.pdf', 1, 'application/pdf'), '.pdf')).toBe(true);
    expect(matchesAccept(f('A.PDF', 1, 'application/pdf'), '.pdf')).toBe(true);
    expect(matchesAccept(f('a.png', 1), '.pdf')).toBe(false);
  });
  it('解析 image/* MIME 主类型通配', () => {
    expect(matchesAccept(f('a.jpg', 1, 'image/jpeg'), 'image/*')).toBe(true);
    expect(matchesAccept(f('a.png', 1, 'image/png'), 'image/*')).toBe(true);
    expect(matchesAccept(f('a.txt', 1, 'text/plain'), 'image/*')).toBe(false);
  });
  it('解析 image/jpeg 完全匹配', () => {
    expect(matchesAccept(f('a.jpg', 1, 'image/jpeg'), 'image/jpeg')).toBe(true);
    expect(matchesAccept(f('a.png', 1, 'image/png'), 'image/jpeg')).toBe(false);
  });
  it('解析 jpeg 子类型缩写', () => {
    expect(matchesAccept(f('a.jpg', 1, 'image/jpeg'), 'jpeg')).toBe(true);
    expect(matchesAccept(f('a.png', 1, 'image/png'), 'jpeg')).toBe(false);
  });
  it('空 accept / 全空 token', () => {
    expect(matchesAccept(f('a.any', 1), '')).toBe(false);
    expect(matchesAccept(f('a.any', 1), ',,')).toBe(false);
  });
});

describe('planPick', () => {
  it('limit=2 + currentCount=0 → 接受前 2，剩余走 rejectedByLimit', () => {
    const pool = [f('a', 1), f('b', 1), f('c', 1)];
    const plan = planPick(pool, { limit: 2 }, 0);
    expect(plan.accepted.map((x) => x.name)).toEqual(['a', 'b']);
    expect(plan.rejectedByLimit.map((x) => x.name)).toEqual(['c']);
  });
  it('limit=0（不限）→ 全部接受', () => {
    const plan = planPick([f('a', 1), f('b', 1)], { limit: 0 }, 0);
    expect(plan.accepted.length).toBe(2);
    expect(plan.rejectedByLimit.length).toBe(0);
  });
  it('maxSizeMB=1 + 1MB+1B → rejectedBySize', () => {
    const big = f('big.bin', 1024 * 1024 + 1);
    const small = f('small.bin', 1024);
    const plan = planPick([big, small], { maxSizeMB: 1 }, 0);
    expect(plan.accepted.map((x) => x.name)).toEqual(['small.bin']);
    expect(plan.rejectedBySize.length).toBe(1);
    expect(plan.rejectedBySize[0]!.reason).toContain('超过 1MB');
  });
  it('accept=".pdf" 拒绝 .png', () => {
    const plan = planPick(
      [f('a.pdf', 1, 'application/pdf'), f('b.png', 1, 'image/png')],
      { accept: '.pdf' },
      0,
    );
    expect(plan.accepted.map((x) => x.name)).toEqual(['a.pdf']);
    expect(plan.rejectedByAccept.length).toBe(1);
  });
  it('multiple=false 截断到第 1 个，其余 rejectedByMultiple', () => {
    const plan = planPick(
      [f('a', 1), f('b', 1)],
      { multiple: false },
      0,
    );
    expect(plan.accepted.map((x) => x.name)).toEqual(['a']);
    expect(plan.rejectedByMultiple.map((x) => x.file.name)).toEqual(['b']);
    expect(plan.rejectedByMultiple[0]!.reason).toContain('仅支持单文件上传');
  });
  it('组合：limit 截断后再 size 校验', () => {
    const plan = planPick(
      [f('a', 1), f('big.bin', 1024 * 1024 * 2, 'application/octet-stream'), f('b', 1)],
      { limit: 2, maxSizeMB: 1 },
      0,
    );
    expect(plan.accepted.map((x) => x.name)).toEqual(['a']);
    expect(plan.rejectedByLimit.map((x) => x.name)).toEqual(['b']);
    expect(plan.rejectedBySize.map((x) => x.file.name)).toEqual(['big.bin']);
  });
});
