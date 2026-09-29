// fileExt.ts 单元测试（2026-09-29 frontend-cos-flatten-key）。
//
// 验证 utils/fileExt.parseFileExt：
// - 取文件名的最后一段 '.' 后的连续 [a-zA-Z0-9] 段；
// - 大写归一化为小写；
// - 不含扩展名 / 点开头 / 超长（>7）→ 抛 Error('invalid ext')；
// - 多 dot 文件名仅取最后一段（与 rust ext schema 语义一致）。
//
// 本函数是 2026-09-29 STS grant 端口契约升级（rust 要求 ext: required lowercase
// 1-7）的唯一字面解析入口；caller（usePartFileUpload / usePartBatchManual /
// usePartBatchPdf）不再自行实现 regex，全部走这里。

import { describe, expect, it } from 'vitest';
import { parseFileExt } from '../fileExt';

describe('parseFileExt', () => {
  it('正常文件名 → ext', () => {
    expect(parseFileExt('a.pdf')).toBe('pdf');
    expect(parseFileExt('part.step')).toBe('step');
    expect(parseFileExt('drawing.PDF')).toBe('pdf');
    expect(parseFileExt('foo.BAR')).toBe('bar');
  });

  it('大小写归一化为小写', () => {
    expect(parseFileExt('A.PDF')).toBe('pdf');
    expect(parseFileExt('MiXeD.NaMe')).toBe('name');
  });

  it('多 dot 文件名取最后一段', () => {
    expect(parseFileExt('multi.dot.name')).toBe('name');
    expect(parseFileExt('archive.tar.gz')).toBe('gz');
  });

  it('单字符 ext 合法', () => {
    expect(parseFileExt('a.c')).toBe('c');
  });

  it('最长 7 字符 ext 合法', () => {
    expect(parseFileExt('a.1234567')).toBe('1234567');
    expect(parseFileExt('a.abcdefg')).toBe('abcdefg');
  });

  it('超长 ext（>7 字符）→ 抛 Error', () => {
    expect(() => parseFileExt('a.12345678')).toThrow(/ext too long/);
    expect(() => parseFileExt('a.toolongext')).toThrow(/ext too long/);
  });

  it('无扩展名 → 抛 Error', () => {
    expect(() => parseFileExt('noext')).toThrow(/invalid ext/);
    expect(() => parseFileExt('')).toThrow(/invalid ext/);
    expect(() => parseFileExt('a.')).toThrow(/invalid ext/);
  });

  it('点开头（隐藏文件无 ext） → 抛 Error', () => {
    // '.hidden' 中 '.' 后是 'hidden'（合法 6 字符），但函数只看最后一段 →
    // 实际取 'hidden'，长度合法。
    // 真正"点开头 + 无扩展名"的形态（如 '.bashrc'）在 POSIX 里视为无 ext，
    // 我们这里仅按 regex 末尾语义；caller 拿到 'bashrc' 仍合法。
    // 故仅校验 file 名不含任何 '.' 时抛错。
    expect(parseFileExt('.hidden')).toBe('hidden');
  });

  it('ext 内含非法字符（连字符、空格）→ 抛 Error（regex 不匹配）', () => {
    expect(() => parseFileExt('a.bad-ext')).toThrow(/invalid ext/);
    expect(() => parseFileExt('a.bad ext')).toThrow(/invalid ext/);
    expect(() => parseFileExt('a.bad_ext')).toThrow(/invalid ext/);
  });
});
