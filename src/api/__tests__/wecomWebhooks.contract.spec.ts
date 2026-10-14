// src/api/__tests__/wecomWebhooks.contract.spec.ts
//
// 2026-10-17 新建：`src/api/wecomWebhooks.ts` 的两组守卫 ——
//   ① **wire 契约**（URL / method / body 逐条钉死）；
//   ② **守门点分工**（哪三条 parse、哪两条不 parse）。
//
// 为什么要逐字钉 URL：本域六个端点的路径打错就是 404 / 405，而 404 只在「点一下才发现」时暴露
// —— 前端没有任何类型或测试能挡住 URL 打错（同 `mailAccounts.contract.spec.ts` 的同款理由）。
// ⚠️ 2026-10-17 后端把定时任务域归拢到 `/cron` 根下、**旧路径无 alias** ⇒ 反序发布时这六个
//   端点全 404，且失败发生在网络层（不是 Zod 契约层），现场只看到一句 axios 错误。
//
// ⚠️ **守门点分工的两组守卫必须成对存在**：
//   - N1：唯一那条**读**端点（webhooks 列表）api 层**不** parse —— 它有 queryFn 承载，守门在
//     `views/wecom/webhooks/composables/useWeComWebhooksQuery.ts`。把 parse 搬回 api 层会让每屏
//     数据被校验并克隆两遍，且两处校验点会随字段增删各自漂移。
//   - N2：三条**有对象出参**的写端点（建档 / 改档 / 置默认）**必须** parse —— 它们走
//     useMutation、**没有 queryFn 承载**。漏掉 parse 时坏响应会一路流到「刚建的通道 `id` 是
//     undefined / `version` 是 undefined」，下一次编辑/删除就会拿 undefined 打 URL。
//   - N2b：**软删与测连通不做 parse** —— 后端返 `R<()>`、信封 `data` 是 `null`，没有形状可守
//     （`parse(null)` 必抛，那正是「删除 / 测连通永远失败」的成因）。N2b3 是它的**源码侧补强**：
//     只数那三个 parse 计数守不住「新造一个结果 schema 再接上 parse」这条路。
// 少了 N1，把 parse 搬回 api 层是零信号；少了 N2，把 parse 从写端点删掉也是零信号。
//
// ⚠️ N1 / N2 守不住「parse 真的接在 queryFn 返回路径上」：把 queryFn 里那行 `xxxSchema.parse`
//   整段删掉时本文件仍然全绿 ⇒ 由 `views/wecom/webhooks/__tests__/useWeComWebhooksQuery.spec.ts`
//   的坏响应用例负责。两条必须成对存在。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const schemaParse = vi.hoisted(() => ({
  row: vi.fn(),
  list: vi.fn(),
}));

// ⚠️ mock 里**没有**软删 / 测连通的结果 schema：这个形状本身就是「那两条端点不许有出参守门」的
// 负向守卫 —— 有人把它们加回来时这里必须同步，否则本文件变成「有一道闸门却没有断言它接在返回
//  路径上」。
vi.mock('@/views/wecom/webhooks/weComWebhookSchema', () => ({
  weComWebhookSchema: { parse: schemaParse.row },
  weComWebhookListSchema: { parse: schemaParse.list },
}));

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
}));

import {
  createWeComWebhook,
  deleteWeComWebhook,
  listWeComWebhooks,
  setDefaultWeComWebhook,
  testWeComWebhook,
  updateWeComWebhook,
} from '../wecomWebhooks';

const WEBHOOK = { id: '9000000000000903', name: '生产群' };
const VERSION_BODY = { version: 7 };
const CREATE_BODY = {
  name: '生产群',
  webhook_url:
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a0000-1111-2222-3333-44445555ffff',
};

/** 跑一次写端点，返回实际打到 axios 的 [url, body]。 */
async function postArgs(run: () => Promise<unknown>): Promise<[string, unknown]> {
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: WEBHOOK });
  await run();
  return [httpPostMock.mock.calls[0]![0] as string, httpPostMock.mock.calls[0]![1]];
}

beforeEach(() => {
  schemaParse.row.mockReset().mockReturnValue(WEBHOOK);
  schemaParse.list.mockReset().mockReturnValue({ items: [WEBHOOK] });
  httpGetMock.mockReset().mockResolvedValue({ data: { items: [] } });
  httpPostMock.mockReset().mockResolvedValue({ data: WEBHOOK });
});

describe('wecomWebhooks api — 唯一一条读端点不做 Zod 校验（负向守卫 N1）', () => {
  it('N1：listWeComWebhooks 不调用 schema.parse', async () => {
    httpGetMock.mockResolvedValue({ data: { items: [] } });
    await listWeComWebhooks();

    expect(schemaParse.list).not.toHaveBeenCalled();
    // 反向确认：api 模块**确实**引了 schema（值引入），否则 N2 那组会变成恒真。
    expect(schemaParse.row).not.toHaveBeenCalled();
  });

  it('N1b：坏响应原样透传（不 reject、不裁剪、不裁成数组）', async () => {
    // 这条是 N1 的行为侧镜像：真在 api 层挂过 parse，这里必然抛 ZodError。
    httpGetMock.mockResolvedValue({ data: { definitely_not_an_array: true } });
    await expect(listWeComWebhooks()).resolves.toEqual({ definitely_not_an_array: true });
  });
});

describe('wecomWebhooks api — 三条写端点必须 Zod 校验（N2）', () => {
  it('N2a：建档 / 改档 / 设为默认 三个出参都过 weComWebhookSchema.parse', async () => {
    await createWeComWebhook(CREATE_BODY);
    await updateWeComWebhook('9000000000000903', { ...CREATE_BODY, version: 2 });
    await setDefaultWeComWebhook('9000000000000903', VERSION_BODY);

    expect(schemaParse.row).toHaveBeenCalledTimes(3);
  });

  it('N2b：软删与测连通**不做** parse 且返回 undefined（后端 `data` 是 `null`，无可守）', async () => {
    // 后端 → `R<()>` ⇒ 信封 `data: null`。曾经凭空发明一个 `{deleted: boolean}` 的 schema 去
    // parse 它，于是软删**永远**走 onError，而后端行已软删。
    httpPostMock.mockResolvedValue({ data: null });
    await expect(deleteWeComWebhook('9000000000000903', VERSION_BODY)).resolves.toBeUndefined();
    await expect(testWeComWebhook('9000000000000903')).resolves.toBeUndefined();
    // 那道闸门确实不存在：两个 parse 计数一个都没动
    expect(schemaParse.row).not.toHaveBeenCalled();
  });

  it('N2b2：软删失败（后端返 21808 信封）照常 reject 出 api 层', async () => {
    const err = Object.assign(new Error('该 Webhook 已被每日总结配置引用'), { code: 21808 });
    httpPostMock.mockRejectedValue(err);
    await expect(deleteWeComWebhook('9000000000000903', VERSION_BODY)).rejects.toThrow(
      '已被每日总结配置引用',
    );
  });

  it('N2b3：**源码**断言软删 / 测连通两个函数体里没有 parse', () => {
    // ⚠️ N2b 只守得住「既有那三个 parse 没被接到这两条上」：有人顺手新建一个结果 schema、把它
    // 加进本文件的 schema mock、再在 deleteWeComWebhook 里 parse 它时，N2b 那两个计数一个都
    // 不动、仍然全绿 —— 而线上正是「软删永远失败 / 测连通永远报错」。补了这层源码断言，
    // 那条路就没有零信号的口子了。
    const src = readFileSync(new URL('../wecomWebhooks.ts', import.meta.url), 'utf8');
    for (const name of ['deleteWeComWebhook', 'testWeComWebhook']) {
      const fn = src.match(new RegExp(`export async function ${name}[\\s\\S]*?\\n\\}`));
      expect(fn, `${name} 没找到`).not.toBeNull();
      expect(fn![0], `${name} 里不该出现 parse`).not.toMatch(/\.parse\(/);
    }
  });

  it('N2c：守门失败时 api 层**抛**（不把坏响应透传给 store）', async () => {
    schemaParse.row.mockImplementation(() => {
      throw new Error('ZodError: id 缺失');
    });
    await expect(createWeComWebhook(CREATE_BODY)).rejects.toThrow('id 缺失');
  });
});

describe('wecomWebhooks 六个端点的 URL / method / body 契约', () => {
  it('U1：读列表打 GET /cron/wecom/webhooks（无入参 —— 端点一次性返全部、无分页参数）', async () => {
    httpGetMock.mockReset().mockResolvedValue({ data: { items: [] } });
    await listWeComWebhooks();
    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock.mock.calls[0]![0]).toBe('/cron/wecom/webhooks');
    // 没有第二个实参（没有 params 形参）⇒ 不会有 `?limit=&offset=` 那种空串 query。
    expect(httpGetMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('U2：建档打 POST /cron/wecom/webhooks，body 两个键逐字', async () => {
    const [url, body] = await postArgs(() => createWeComWebhook(CREATE_BODY));
    expect(url).toBe('/cron/wecom/webhooks');
    expect(body).toEqual(CREATE_BODY);
  });

  it('U3：改档打 POST /cron/wecom/webhooks/{id}（**不是 PUT**），id 经 encodeURIComponent', async () => {
    const [url, body] = await postArgs(() =>
      updateWeComWebhook('SN/A B', { ...CREATE_BODY, version: 7 }),
    );
    expect(url).toBe('/cron/wecom/webhooks/SN%2FA%20B');
    // ⚠️ 全量覆写：`name` 与 `version` 都必带；`webhook_url` 空串 = 沿用旧密文。
    expect(body).toMatchObject({ version: 7, name: '生产群' });
  });

  it('U4：软删与置默认打各自的 action 路径（**不是 DELETE 方法**），body 必带 version', async () => {
    const [delUrl, delBody] = await postArgs(() =>
      deleteWeComWebhook('9000000000000903', VERSION_BODY),
    );
    expect(delUrl).toBe('/cron/wecom/webhooks/9000000000000903/delete');
    expect(delBody).toEqual({ version: 7 });

    const [defUrl, defBody] = await postArgs(() =>
      setDefaultWeComWebhook('9000000000000903', VERSION_BODY),
    );
    expect(defUrl).toBe('/cron/wecom/webhooks/9000000000000903/set-default');
    expect(defBody).toEqual({ version: 7 });
  });

  it('U5：测连通打 POST /cron/wecom/webhooks/{id}/test，body 是**空对象**（不带 version）', async () => {
    const [url, body] = await postArgs(() => testWeComWebhook('9000000000000903'));
    expect(url).toBe('/cron/wecom/webhooks/9000000000000903/test');
    // ⚠️ `/test` 不写配置 ⇒ body 不带 version；发 `{version: n}` 会被后端忽略而不是报错，
    // 但那是一个「前端以为它有意义」的信号，宁可逐字钉死。
    expect(body).toEqual({});
  });

  it('U6：URL 字面量**不出现**旧前缀（/mail 时代的路径已硬切，漏写一个就是 404）', () => {
    const src = readFileSync(new URL('../wecomWebhooks.ts', import.meta.url), 'utf8');
    // ⚠️ 只取**真正打到 axios 的那个实参**（`api.get(...)` / `api.post(...)` 的第一个参数），
    // 不是全文里所有含 wecom 的引号串 —— 注释与 JSDoc 里写着 `/api/v2/cron/wecom/*` 是给人
    // 看的，不是请求路径。
    const urls = [
      ...src.matchAll(/(?:api\.get|api\.post)(?:<[^>]*>)?\(\s*[`'](\/[^`']+)[`']/g),
    ].map((m) => m[1]!);
    expect(urls).toHaveLength(6);
    for (const u of urls) expect(u.startsWith('/cron/wecom/')).toBe(true);
  });
});

describe('wecomWebhooks api 的引法纪律', () => {
  it('U7：域内 schema 的**类型**引用是 import type（编译期擦除，api → views 不留类型边）', () => {
    const src = readFileSync(new URL('../wecomWebhooks.ts', import.meta.url), 'utf8');
    const match = src.match(
      /import\s+(type\s+)?\{[^}]*\}\s*from\s*'@\/views\/wecom\/webhooks\/weComWebhookSchema'/s,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('type ');
  });

  it('U8：api 层**不**另存任何 webhook 地址样例常量（那是入参形态，不是可展示的地址）', () => {
    // 前端存一份「某群的 key」就是 secret 的第二个落点；`CREATE_BODY` 那种样例只活在 spec 里。
    const src = readFileSync(new URL('../wecomWebhooks.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/key=[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});
