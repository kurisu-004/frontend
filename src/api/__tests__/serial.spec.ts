// src/api/__tests__/serial.spec.ts
//
// 2026-10-19 新增：`src/api/serial.ts` 的**负向守卫** —— api 层**不允许**做 Zod 校验。
//
// 为什么是负向断言：本端点的守门点在 composable 的 mutationFn
// （`views/parts/list/composables/useSerialRelease.ts` 的两条 mutation），api 层只发请求
// + 用 schema 的 `z.infer` 标注返回类型。Zod 的 parse 入口返回**深拷贝**，在 api 层再走
// 一遍等于同一份数据被校验并克隆两遍；而且 api 层一旦 parse，mutationFn 那次 parse 就
// 变成纯浪费，两处校验点还会随字段增删各自漂移。
//
// ⚠️ 本条与 `views/parts/list/composables/__tests__/useSerialRelease.spec.ts` 的 U2 是
// **一对**：U2 守「parse 真的接在 mutationFn 的返回路径上」，本文件守「parse 没有被搬回
// api 层」。少了本文件，把 parse 加回 api 层是零测试信号；少了 U2，把 parse 从
// mutationFn 删掉也是零测试信号（api 层本来就该不 parse）。**两个方向都要有人在。**
//
// 顺带钉死 URL 与 body：这是 serials 域目前唯一的对外表面，URL 打错就是 404。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// 把 schema 模块整体桩掉，`parse` 用可断言的 spy：api 层今天用 `import type` 引类型，
// 模块根本不会被加载 ⇒ spy 恒 0 次调用；哪天有人把它改成运行时 import 并挂上 parse，
// 这些断言立刻红。
const schemaParse = vi.hoisted(() => ({ out: vi.fn() }));

vi.mock('@/views/parts/list/composables/serialReleaseSchema', () => ({
  releaseTerminalSerialsOutSchema: { parse: schemaParse.out },
}));

const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    post: (...args: unknown[]) => httpPostMock(...args),
  },
}));

import { releaseTerminalSerials } from '../serial';

beforeEach(() => {
  schemaParse.out.mockReset();
  httpPostMock.mockReset();
});

describe('serial api 层不做 Zod 校验（负向守卫）', () => {
  it('N1：releaseTerminalSerials 一律不调用 schema.parse', async () => {
    httpPostMock.mockResolvedValue({ data: { totally_wrong: true } });
    await releaseTerminalSerials({ dry_run: true });
    expect(schemaParse.out).not.toHaveBeenCalled();
  });

  it('N2：坏响应原样透传（缺必填键也照返，不 reject、不裁剪、不补默认值）', async () => {
    httpPostMock.mockResolvedValue({ data: { dry_run: true, affected: '这不是数组' } });
    await expect(releaseTerminalSerials({ dry_run: true })).resolves.toEqual({
      dry_run: true,
      affected: '这不是数组',
    });

    httpPostMock.mockResolvedValue({ data: { nope: 1 } });
    await expect(releaseTerminalSerials({ dry_run: false })).resolves.toEqual({ nope: 1 });
  });

  it('N3：域内 schema 的引用是 import type（编译期擦除，api → views 不留运行时边）', () => {
    // 守 CLAUDE.md「api 层引域内 schema 默认用 import type」：改成值 import 会在运行时
    // 引入一条 api → views 的边，且没给本域带来任何收益（守门在 mutationFn）。
    const src = readFileSync(new URL('../serial.ts', import.meta.url), 'utf8');
    const match = src.match(
      /import\s+(type\s+)?\{[^}]*\}\s*from\s*'@\/views\/parts\/list\/composables\/serialReleaseSchema'/s,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('type ');
  });
});

describe('serial 端点的 URL 与 body 契约', () => {
  it('U1：两段式打同一条 POST /serials/release-terminal，dry_run 进 body', async () => {
    httpPostMock.mockResolvedValue({ data: {} });
    await releaseTerminalSerials({ dry_run: true });
    await releaseTerminalSerials({ dry_run: false });
    expect(httpPostMock).toHaveBeenCalledTimes(2);
    for (const call of httpPostMock.mock.calls) {
      expect(call[0]).toBe('/serials/release-terminal');
      expect(Object.keys(call[1] as object)).toEqual(['dry_run']);
    }
    expect(httpPostMock.mock.calls[0]![1]).toEqual({ dry_run: true });
    expect(httpPostMock.mock.calls[1]![1]).toEqual({ dry_run: false });
  });
});
