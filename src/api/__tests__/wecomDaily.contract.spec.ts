// src/api/__tests__/wecomDaily.contract.spec.ts
//
// 2026-10-17 新建：`src/api/wecomDaily.ts` 的两组守卫 ——
//   ① **wire 契约**（URL / method / body 逐条钉死）；
//   ② **守门点分工**（哪三条 parse、哪三条不 parse）。
//
// ⚠️ **守门点分工的两组守卫必须成对存在**（照 `statistics.spec.ts` / `mailDigest.contract.spec.ts`
//   的同款纪律，本仓已有真实教训）：
//   - N1：三条**读**端点（config / meta / logs）api 层**不** parse —— 它们有 queryFn 承载，守门
//     在 `views/wecom/daily/composables/useWeComDailyQuery.ts`。Zod 的 parse 入口返回**深拷贝**，
//     在 api 层再走一遍等于每屏数据被校验并克隆两遍；且两处校验点会随字段增删各自漂移。
//   - N2：三条**写**端点（保存配置 / preview / send）**必须** parse —— 它们走 useMutation、
//     **没有 queryFn 承载**（CLAUDE.md 为这类调用留的口子）。漏掉 parse 时坏响应会一路流到
//     「刚存的配置 `version` 是 undefined」（下一次提交必然 422）、「预览弹窗拿到 undefined 的
//     `chunks`」（渲染崩溃）、「刚发出去那行的 `log_id` 是 undefined」（表格 row-key 失效）。
// 少了 N1，把 parse 搬回 api 层是零信号；少了 N2，把 parse 从写端点删掉也是零信号。
//
// ⚠️ **N1 守不住「parse 真的接在 queryFn 返回路径上」**：把 queryFn 里那行 `xxxSchema.parse`
//   整段删掉时本文件仍然全绿 ⇒ **读端点的守门完整性由
//   `views/wecom/daily/__tests__/useWeComDailyQuery.spec.ts` 的坏响应用例负责**。那两条必须
//   成对存在（CLAUDE.md 已登记的同款纪律）。
//
// mock 手法沿 `mailDigest.contract.spec.ts` 同款：整模块桩掉 `@/api/http`（不
// importOriginal），schema 模块也整体桩成「可断言 parse 次数」的形状。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const schemaParse = vi.hoisted(() => ({
  config: vi.fn(),
  meta: vi.fn(),
  preview: vi.fn(),
  log: vi.fn(),
}));

vi.mock('@/views/wecom/daily/weComDailySchema', () => ({
  weComDailyConfigSchema: { parse: schemaParse.config },
  weComDailyMetaSchema: { parse: schemaParse.meta },
  weComDailyPreviewSchema: { parse: schemaParse.preview },
  weComDailyLogSchema: { parse: schemaParse.log },
}));

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (params: unknown) => params,
}));

import {
  fetchWeComDailyConfig,
  fetchWeComDailyMeta,
  listWeComDailyLogs,
  previewWeComDaily,
  saveWeComDailyConfig,
  sendWeComDailyNow,
} from '../wecomDaily';

const CONFIG = { id: '9000000000000800', version: 3 };
const PREVIEW = { subject: '生产日报', chunks: ['a'], chunk_count: 1 };
const LOG = { log_id: '9000000000000900', status: 'SUCCESS' };

const SAVE_BODY = {
  version: 3,
  enabled: true,
  frequency: 'DAILY' as const,
  send_hour: 8,
  send_minute: 30,
  weekday: null,
  day_of_month: null,
  webhook_id: '9000000000000903',
  upcoming_days: 3,
  order_list_limit: 30,
  worker_metric: 'QUANTITY' as const,
  worker_top_n: 15,
  max_chunks: 6,
  include_overview: true,
  include_delivery: true,
  include_orders: true,
  include_drawings: true,
  include_workers: true,
  subject_template: null,
};

beforeEach(() => {
  schemaParse.config.mockReset().mockReturnValue(CONFIG);
  schemaParse.meta.mockReset().mockReturnValue({ frequencies: [] });
  schemaParse.preview.mockReset().mockReturnValue(PREVIEW);
  schemaParse.log.mockReset().mockReturnValue(LOG);
  httpGetMock.mockReset().mockResolvedValue({ data: CONFIG });
  httpPostMock.mockReset().mockResolvedValue({ data: CONFIG });
});

describe('wecomDaily api — 三条读端点不做 Zod 校验（负向守卫 N1）', () => {
  it('N1：config / meta / logs 一律不调用 schema.parse', async () => {
    await fetchWeComDailyConfig();
    await fetchWeComDailyMeta();
    await listWeComDailyLogs({ limit: 20, offset: 0 });

    expect(schemaParse.config).not.toHaveBeenCalled();
    expect(schemaParse.meta).not.toHaveBeenCalled();
    expect(schemaParse.log).not.toHaveBeenCalled();
    // 反向确认：api 模块**确实**引了 schema（值引入），否则 N2 那组会变成恒真。
    expect(schemaParse.preview).not.toHaveBeenCalled();
  });

  it('N1b：坏响应原样透传（不 reject、不裁剪、不裁成对象）', async () => {
    // 这条是 N1 的行为侧镜像：真在 api 层挂过 parse，这里必然抛 ZodError。
    httpGetMock.mockResolvedValue({ data: { definitely_not_an_object: true } });
    await expect(fetchWeComDailyConfig()).resolves.toEqual({ definitely_not_an_object: true });

    httpGetMock.mockResolvedValue({ data: '一段纯文本' });
    await expect(fetchWeComDailyMeta()).resolves.toBe('一段纯文本');
  });
});

describe('wecomDaily api — 三条写端点必须 Zod 校验（N2）', () => {
  it('N2a：保存配置 / 预览 / 立即发送 三个出参都过 schema.parse', async () => {
    await saveWeComDailyConfig(SAVE_BODY);
    await previewWeComDaily({});
    await sendWeComDailyNow({});

    expect(schemaParse.config).toHaveBeenCalledTimes(1);
    expect(schemaParse.preview).toHaveBeenCalledTimes(1);
    // ⚠️ preview 与 send 用**两条不同的 schema**（`PreviewOut` vs `LogRow`）：send 的出参是
    // `LogRow`（与 `/logs` 的 items 同体），**不是** PreviewOut —— 契约里 `markdown` 单字段
    // 已删除，只认 `chunks`。
    expect(schemaParse.log).toHaveBeenCalledTimes(1);
  });

  it('N2b：守门失败时 api 层**抛**（不把坏响应透传给 store）', async () => {
    schemaParse.config.mockImplementation(() => {
      throw new Error('ZodError: version 缺失');
    });
    await expect(saveWeComDailyConfig(SAVE_BODY)).rejects.toThrow('version 缺失');
  });

  it('N2c：send 的出参走 LogRow 而不是 PreviewOut（防止有人把 chunks 字段搬到出参上）', () => {
    const src = readFileSync(new URL('../wecomDaily.ts', import.meta.url), 'utf8');
    const fn = src.match(/export async function sendWeComDailyNow[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('weComDailyLogSchema.parse');
    expect(fn![0]).not.toContain('weComDailyPreviewSchema.parse');
  });
});

describe('wecomDaily 六个端点的 URL / method / body 契约', () => {
  it('U1：读配置打 GET /cron/wecom-daily/config（无 Query 参数）', async () => {
    httpGetMock.mockReset().mockResolvedValue({ data: CONFIG });
    await fetchWeComDailyConfig();
    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock.mock.calls[0]![0]).toBe('/cron/wecom-daily/config');
  });

  it('U2：保存配置打 **POST** /cron/wecom-daily/config（不是 PUT —— 后端只允许 GET/POST）', async () => {
    httpPostMock.mockReset().mockResolvedValue({ data: CONFIG });
    await saveWeComDailyConfig(SAVE_BODY);
    expect(httpPostMock.mock.calls[0]![0]).toBe('/cron/wecom-daily/config');
    // ⚠️ `version` 必填（OCC 锚）：漏传是 axum 的 422 纯文本、拿不到业务码。
    expect(httpPostMock.mock.calls[0]![1]).toMatchObject({ version: 3 });
  });

  it('U3：元数据打 GET /cron/wecom-daily/meta', async () => {
    httpGetMock.mockReset().mockResolvedValue({ data: { frequencies: [] } });
    await fetchWeComDailyMeta();
    expect(httpGetMock.mock.calls[0]![0]).toBe('/cron/wecom-daily/meta');
  });

  it('U4：预览打 POST /cron/wecom-daily/preview，请求体是配置部分（**不含 version**）', async () => {
    httpPostMock.mockReset().mockResolvedValue({ data: PREVIEW });
    await previewWeComDaily({ frequency: 'DAILY' });
    expect(httpPostMock.mock.calls[0]![0]).toBe('/cron/wecom-daily/preview');
    expect(httpPostMock.mock.calls[0]![1]).not.toHaveProperty('version');
  });

  it('U5：立即发送打 POST /cron/wecom-daily/send，请求体同 preview（空体 = 用当前配置）', async () => {
    httpPostMock.mockReset().mockResolvedValue({ data: LOG });
    await sendWeComDailyNow({});
    expect(httpPostMock.mock.calls[0]![0]).toBe('/cron/wecom-daily/send');
    expect(httpPostMock.mock.calls[0]![1]).toEqual({});
  });

  it('U6：日志打 GET /cron/wecom-daily/logs，limit / offset 进 params', async () => {
    httpGetMock.mockReset().mockResolvedValue({ data: { items: [] } });
    await listWeComDailyLogs({ limit: 20, offset: 40 });
    expect(httpGetMock.mock.calls[0]![0]).toBe('/cron/wecom-daily/logs');
    expect(httpGetMock.mock.calls[0]![1]).toMatchObject({ params: { limit: 20, offset: 40 } });
  });
});

describe('wecomDaily api 的引法纪律', () => {
  it('U7：域内 schema 的**类型**引用是 import type（api → views 不留类型边）', () => {
    // 守 CLAUDE.md「api 层引域内 schema 默认用 import type」。运行时的三条值引入是「写端点没有
    // queryFn 承载」这一条例外（见文件头 N2），所以这里只查 type 那一条。
    const src = readFileSync(new URL('../wecomDaily.ts', import.meta.url), 'utf8');
    const match = src.match(
      /import\s+(type\s+)?\{[^}]*\}\s*from\s*'@\/views\/wecom\/daily\/weComDailySchema'/s,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('type ');
  });

  it('U8：URL 字面量**不出现**旧前缀（/mail-digest 时代的路径已硬切，漏写一个就是 404）', () => {
    const src = readFileSync(new URL('../wecomDaily.ts', import.meta.url), 'utf8');
    // ⚠️ 只取**真正打到 axios 的那个实参**（`api.get(...)` / `api.post(...)` 的第一个参数），
    // 不是全文里所有含 wecom 的引号串 —— 注释与 JSDoc 里写着 `/api/v2/cron/wecom-daily/*` 是
    // 给人看的，不是请求路径。
    const urls = [
      ...src.matchAll(/(?:api\.get|api\.post)(?:<[^>]*>)?\(\s*[`'](\/[^`']+)[`']/g),
    ].map((m) => m[1]!);
    expect(urls).toHaveLength(6);
    for (const u of urls) expect(u.startsWith('/cron/wecom-daily/')).toBe(true);
  });
});
