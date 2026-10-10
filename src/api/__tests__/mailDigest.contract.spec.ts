// src/api/__tests__/mailDigest.contract.spec.ts
//
// 2026-10-13 新增：`src/api/mailDigest.ts` 的 **wire 契约守卫**（URL / method / body
// 逐条钉死）+ **守门点分工守卫**。
//
// 为什么要逐字钉 URL：本域六个端点的路径一旦打错就是 404 / 405，而 404 只在「点一下才
// 才发现」时暴露 —— 前端没有任何类型或测试能挡住 URL 打错（这正是
// `inspection.contract.spec.ts` / `processChain.contract.spec.ts` 同款理由）。
//
// ⚠️ **守门点分工的两条守卫必须成对存在**（照 `statistics.spec.ts` 的同款纪律）：
//   - N1：三条**读**端点（config / meta / logs）api 层**不** parse —— 它们有 queryFn
//     承载，守门在 `composables/useMailDigestQuery.ts`。把 parse 搬回 api 层会让每屏
//     数据被校验并克隆两遍，且两处校验点会随字段增删各自漂移。
//   - N2：两条「跑一次」的端点（preview / send）**必须** parse —— 它们走 useMutation、
//     没有 queryFn 承载；漏掉 parse 时坏响应会一路流到 `iframe :srcdoc`（预览）与
//     成功提示（发送）。
// 少了 N1，把 parse 搬回 api 层是零信号；少了 N2，把 parse 从 preview / send 删掉也是
// 零信号。两个方向都要有人在。
//
// mock 手法沿 `inspection.contract.spec.ts` / `statistics.spec.ts` 同款：整模块桩掉
// `@/api/http`（不 importOriginal），schema 模块也整体桩成「可断言 parse 次数」的形状。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const schemaParse = vi.hoisted(() => ({
  config: vi.fn(),
  meta: vi.fn(),
  preview: vi.fn(),
  send: vi.fn(),
  logs: vi.fn(),
}));

vi.mock('@/views/mail/digest/mailDigestSchema', () => ({
  mailDigestConfigSchema: { parse: schemaParse.config },
  mailDigestMetaSchema: { parse: schemaParse.meta },
  mailDigestPreviewSchema: { parse: schemaParse.preview },
  mailDigestSendResultSchema: { parse: schemaParse.send },
  mailDigestLogListSchema: { parse: schemaParse.logs },
}));

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  // cleanParams 的桩**照抄**真实现的剥离语义（undefined / null / 空串 / 空数组一律不上
  // wire），否则「筛选键为空不上 wire」那条断言会退化成恒真。
  cleanParams: (obj?: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' && v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  },
}));

import {
  fetchMailDigestConfig,
  fetchMailDigestMeta,
  listMailDigestLogs,
  previewMailDigest,
  saveMailDigestConfig,
  sendMailDigestNow,
} from '../mailDigest';
import type { SaveMailDigestConfigPayload } from '@/types/mailDigest';

/** 一份合法的配置请求体（OCC 锚 version 必填）。 */
const CONFIG_PAYLOAD: SaveMailDigestConfigPayload = {
  version: 3,
  enabled: true,
  frequency: 'WEEKLY',
  send_hour: 8,
  send_minute: 30,
  weekday: 1,
  day_of_month: null,
  recipients: ['a@example.com'],
  cc_recipients: ['b@example.com'],
  include_overdue: true,
  include_upcoming: true,
  upcoming_days: 7,
  visible_columns: ['part_no', 'customer'],
  subject_template: null,
};

beforeEach(() => {
  schemaParse.config.mockReset();
  schemaParse.meta.mockReset();
  schemaParse.preview.mockReset();
  schemaParse.send.mockReset();
  schemaParse.logs.mockReset();
  httpGetMock.mockReset().mockResolvedValue({ data: {} });
  httpPostMock.mockReset().mockResolvedValue({ data: {} });
  // parse 桩默认「透传」（identity），让 URL / body 断言不被守门干扰。
  schemaParse.config.mockImplementation((v: unknown) => v);
  schemaParse.meta.mockImplementation((v: unknown) => v);
  schemaParse.preview.mockImplementation((v: unknown) => v);
  schemaParse.send.mockImplementation((v: unknown) => v);
  schemaParse.logs.mockImplementation((v: unknown) => v);
});

describe('mailDigest 六个端点的 URL 与 method', () => {
  it('U1：读配置打 GET /mail-digest/config（无 Query 参数）', async () => {
    await fetchMailDigestConfig();
    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock.mock.calls[0]![0]).toBe('/mail-digest/config');
    expect(httpGetMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('U2：保存配置打 **POST** /mail-digest/config（不是 PUT —— 后端只允许 GET/POST）', async () => {
    await saveMailDigestConfig(CONFIG_PAYLOAD);
    expect(httpPostMock).toHaveBeenCalledTimes(1);
    expect(httpPostMock.mock.calls[0]![0]).toBe('/mail-digest/config');
    // body 逐字透传（含必填的 version —— 漏传是后端 HTTP 422 纯文本）
    expect(httpPostMock.mock.calls[0]![1]).toEqual(CONFIG_PAYLOAD);
    expect(httpPostMock.mock.calls[0]![1]).toHaveProperty('version', 3);
  });

  it('U3：元数据打 GET /mail-digest/meta', async () => {
    await fetchMailDigestMeta();
    expect(httpGetMock.mock.calls[0]![0]).toBe('/mail-digest/meta');
  });

  it('U4：预览打 POST /mail-digest/preview，请求体是配置部分（**不含 version**）', async () => {
    const { version: _drop, ...runBody } = CONFIG_PAYLOAD;
    await previewMailDigest(runBody);
    expect(httpPostMock.mock.calls[0]![0]).toBe('/mail-digest/preview');
    expect(httpPostMock.mock.calls[0]![1]).toEqual(runBody);
    expect(httpPostMock.mock.calls[0]![1]).not.toHaveProperty('version');
  });

  it('U5：立即发送打 POST /mail-digest/send，请求体同 preview（空体 = 用当前配置）', async () => {
    await sendMailDigestNow({});
    expect(httpPostMock.mock.calls[0]![0]).toBe('/mail-digest/send');
    expect(httpPostMock.mock.calls[0]![1]).toEqual({});
  });

  it('U6：日志打 GET /mail-digest/logs，limit / offset 进 params', async () => {
    await listMailDigestLogs({ limit: 20, offset: 40 });
    expect(httpGetMock.mock.calls[0]![0]).toBe('/mail-digest/logs');
    const config = httpGetMock.mock.calls[0]![1] as { params: Record<string, unknown> };
    expect(config.params).toEqual({ limit: 20, offset: 40 });
  });

  it('U7：日志的两个分页键为 undefined 时不上 wire（cleanParams 的 strip 层）', async () => {
    await listMailDigestLogs({ limit: undefined, offset: undefined });
    const config = httpGetMock.mock.calls[0]![1] as { params: Record<string, unknown> };
    // 断**键集合**而不是 toEqual：vitest 的 toEqual 忽略值为 undefined 的属性。
    expect(Object.keys(config.params)).toEqual([]);
  });
});

describe('mailDigest api 层守门点分工', () => {
  it('N1：三条读端点（config / meta / logs）api 层一律不 parse', async () => {
    await fetchMailDigestConfig();
    await fetchMailDigestMeta();
    await listMailDigestLogs({ limit: 20, offset: 0 });
    expect(schemaParse.config).not.toHaveBeenCalled();
    expect(schemaParse.meta).not.toHaveBeenCalled();
    expect(schemaParse.logs).not.toHaveBeenCalled();
  });

  it('N2：preview / send 必须 parse（走 useMutation，没有 queryFn 承载）', async () => {
    await previewMailDigest({});
    await sendMailDigestNow({});
    expect(schemaParse.preview).toHaveBeenCalledTimes(1);
    expect(schemaParse.send).toHaveBeenCalledTimes(1);
  });

  it('N3：preview 的 parse 失败会以 rejection 冒泡（坏响应不许一路流到 iframe srcdoc）', async () => {
    schemaParse.preview.mockImplementation(() => {
      throw new Error('ZodError: preview 响应缺 html');
    });
    await expect(previewMailDigest({})).rejects.toThrow('preview 响应缺 html');
    wrapperReset();
  });

  it('N4：send 的 parse 失败同样冒泡', async () => {
    schemaParse.send.mockImplementation(() => {
      throw new Error('ZodError: send 响应缺 log_id');
    });
    await expect(sendMailDigestNow({})).rejects.toThrow('send 响应缺 log_id');
    wrapperReset();
  });

  it('N5：域内 schema 的**类型**引用是 import type（读端点不留 api → views 运行时边）', () => {
    // 守 CLAUDE.md「api 层引域内 schema 默认用 import type」。本文件里 schema 模块被整体
    // mock 了，读端点若哪天改成运行时 import + parse，N1 会先红；这条再钉住「声明形态」。
    const src = readFileSync(new URL('../mailDigest.ts', import.meta.url), 'utf8');
    const typeImports = src.match(
      /import type \{[^}]*\} from '@\/views\/mail\/digest\/mailDigestSchema'/s,
    );
    expect(typeImports).not.toBeNull();
    // 运行时 import 只允许恰好两条（preview / send 的 parse），不多不少。
    const runtimeImports = src.match(
      /import \{[^}]*\} from '@\/views\/mail\/digest\/mailDigestSchema'/g,
    );
    expect(runtimeImports).toHaveLength(1);
  });
});

/** 把被改坏的 parse 桩恢复成 identity（供同一 describe 内后续用例复用）。 */
function wrapperReset(): void {
  schemaParse.preview.mockImplementation((v: unknown) => v);
  schemaParse.send.mockImplementation((v: unknown) => v);
}
