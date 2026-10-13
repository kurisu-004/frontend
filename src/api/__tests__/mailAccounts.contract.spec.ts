// src/api/__tests__/mailAccounts.contract.spec.ts
//
// 2026-10-16 新增：`src/api/mailAccounts.ts` 的两组守卫 ——
//   ① **wire 契约**（URL / method / body 逐条钉死）；
//   ② **守门点分工**（哪几条 parse、哪几条不 parse）。
//
// 为什么要逐字钉 URL：本域五个端点的路径打错就是 404 / 405，而 404 只在「点一下才发现」
// 时暴露 —— 前端没有任何类型或测试能挡住 URL 打错（同 `inspection.contract.spec.ts` /
// `mailDigest.contract.spec.ts` 的同款理由）。
//
// ⚠️ **守门点分工的两组守卫必须成对存在**（照 `statistics.spec.ts` /
// `mailDigest.contract.spec.ts` 的同款纪律）：
//   - N1：两条**读**端点（meta / accounts）api 层**不** parse —— 它们有 queryFn 承载，
//     守门在 `views/mail/accounts/composables/useMailAccountsQuery.ts`。Zod 的 parse 入口
//     返回**深拷贝**，在 api 层再走一遍等于每屏数据被校验并克隆两遍；而且两处校验点会随
//     字段增删各自漂移。
//   - N2：四条**写**端点（建档 / 改档 / 删除 / 设为默认）**必须** parse —— 它们走
//     useMutation、**没有 queryFn 承载**（CLAUDE.md 为这类调用留的口子）。漏掉 parse 时
//     坏响应会一路流到「刚建的邮箱 `id` 是 undefined / `version` 是 undefined」，下一次
//     编辑/删除就会拿 undefined 打 URL（`/mail/accounts/undefined`）。
// 少了 N1，把 parse 搬回 api 层是零信号；少了 N2，把 parse 从写端点删掉也是零信号。
// 两个方向都要有人在。
//
// ⚠️ N1 / N2 **必须成对存在**的另一层理由：本仓已有一个真实教训 ——
// `views/statistics/composables/__tests__/useStatisticsWorkersQuery.spec.ts` 的 W3 守
// 「parse 真的接在 queryFn 的返回路径上」。本文件的 N1 只守「api 层没有 parse」，把
// queryFn 里那行 parse 整段删掉时本文件仍然全绿 ⇒ **读端点的守门完整性由那条 spec 负责**
// （见该文件头 W3 一节的说明）。
//
// mock 手法沿 `mailDigest.contract.spec.ts` 同款：整模块桩掉 `@/api/http`，schema 模块
// 也整体桩成「可断言 parse 次数」的形状。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const schemaParse = vi.hoisted(() => ({
  account: vi.fn(),
  list: vi.fn(),
  meta: vi.fn(),
  deleteResult: vi.fn(),
}));

vi.mock('@/views/mail/accounts/mailAccountSchema', () => ({
  mailAccountSchema: { parse: schemaParse.account },
  mailAccountListSchema: { parse: schemaParse.list },
  mailMetaSchema: { parse: schemaParse.meta },
  mailAccountDeleteResultSchema: { parse: schemaParse.deleteResult },
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
  createMailAccount,
  deleteMailAccount,
  fetchMailMeta,
  listMailAccounts,
  setDefaultMailAccount,
  updateMailAccount,
} from '../mailAccounts';

const ACCOUNT = { id: '9000000000000902', name: '采购部邮箱' };
const CREATE_BODY = {
  name: '采购部邮箱',
  preset: 'NET_EASE_163' as const,
  account: 'purchase@example.com',
  secret: 'abc123',
};

/** 跑一次写端点，返回实际打到 axios 的 [url, body]。 */
async function postArgs(run: () => Promise<unknown>): Promise<[string, unknown]> {
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: ACCOUNT });
  await run();
  return [httpPostMock.mock.calls[0]![0] as string, httpPostMock.mock.calls[0]![1]];
}

beforeEach(() => {
  schemaParse.account.mockReset().mockReturnValue(ACCOUNT);
  schemaParse.list.mockReset().mockReturnValue([ACCOUNT]);
  schemaParse.meta.mockReset().mockReturnValue({ presets: [] });
  schemaParse.deleteResult.mockReset().mockReturnValue({ deleted: true });
  httpGetMock.mockReset().mockResolvedValue({ data: [] });
  httpPostMock.mockReset().mockResolvedValue({ data: ACCOUNT });
});

describe('mailAccounts api — 两条读端点不做 Zod 校验（负向守卫 N1）', () => {
  it('N1：fetchMailMeta / listMailAccounts 一律不调用 schema.parse', async () => {
    httpGetMock.mockResolvedValue({ data: [] });
    await fetchMailMeta();
    await listMailAccounts();

    expect(schemaParse.meta).not.toHaveBeenCalled();
    expect(schemaParse.list).not.toHaveBeenCalled();
    // 反向确认：api 模块**确实**引了 schema（值引入），否则 N2 那组会变成恒真。
    expect(schemaParse.account).not.toHaveBeenCalled();
  });

  it('N1b：坏响应原样透传（不 reject、不裁剪、不裁成对象）', async () => {
    // 这条是 N1 的行为侧镜像：真在 api 层挂过 parse，这里必然抛 ZodError。
    httpGetMock.mockResolvedValue({ data: { definitely_not_an_array: true } });
    await expect(listMailAccounts()).resolves.toEqual({ definitely_not_an_array: true });

    httpGetMock.mockResolvedValue({ data: '一段纯文本' });
    await expect(fetchMailMeta()).resolves.toBe('一段纯文本');
  });
});

describe('mailAccounts api — 四条写端点必须 Zod 校验（N2）', () => {
  it('N2a：建档 / 改档 / 设为默认 三个出参都过 mailAccountSchema.parse', async () => {
    await createMailAccount(CREATE_BODY);
    await updateMailAccount('9000000000000902', { ...CREATE_BODY, version: 2 });
    await setDefaultMailAccount('9000000000000902');

    expect(schemaParse.account).toHaveBeenCalledTimes(3);
  });

  it('N2b：删除出参过 mailAccountDeleteResultSchema.parse', async () => {
    await deleteMailAccount('9000000000000902');
    expect(schemaParse.deleteResult).toHaveBeenCalledTimes(1);
  });

  it('N2c：守门失败时 api 层**抛**（不把坏响应透传给 store）', async () => {
    // 桩成「抛」，断言异常一路冒出去 —— mutation 的 onError 靠它转成人话提示。
    schemaParse.account.mockImplementation(() => {
      throw new Error('ZodError: id 缺失');
    });
    await expect(createMailAccount(CREATE_BODY)).rejects.toThrow('id 缺失');
  });
});

describe('mailAccounts 五个端点的 URL / method / body 契约', () => {
  it('U1：读预设打 GET /mail/meta（无入参）', async () => {
    httpGetMock.mockReset().mockResolvedValue({ data: { presets: [] } });
    await fetchMailMeta();
    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock.mock.calls[0]![0]).toBe('/mail/meta');
  });

  it('U2：读列表打 GET /mail/accounts（无入参 —— 端点一次性返全部、无分页信封）', async () => {
    httpGetMock.mockReset().mockResolvedValue({ data: [] });
    await listMailAccounts();
    expect(httpGetMock.mock.calls[0]![0]).toBe('/mail/accounts');
    // 没有第二个实参（没有 params 形参）⇒ 不会有 `?limit=&offset=` 那种空串 query。
    expect(httpGetMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('U3：建档打 POST /mail/accounts，body 四个键逐字', async () => {
    const [url, body] = await postArgs(() => createMailAccount(CREATE_BODY));
    expect(url).toBe('/mail/accounts');
    expect(body).toEqual(CREATE_BODY);
  });

  it('U4：改档打 POST /mail/accounts/{id}（**不是 PUT**），id 经 encodeURIComponent', async () => {
    const [url, body] = await postArgs(() =>
      updateMailAccount('SN/A B', { ...CREATE_BODY, version: 7 }),
    );
    expect(url).toBe('/mail/accounts/SN%2FA%20B');
    expect(body).toMatchObject({ version: 7, secret: 'abc123' });
  });

  it('U5：删除与设为默认打各自的 action 路径（**不是 DELETE 方法**）', async () => {
    const [delUrl, delBody] = await postArgs(() => deleteMailAccount('9000000000000902'));
    expect(delUrl).toBe('/mail/accounts/9000000000000902/delete');
    expect(delBody).toEqual({});

    const [defUrl] = await postArgs(() => setDefaultMailAccount('9000000000000902'));
    expect(defUrl).toBe('/mail/accounts/9000000000000902/set-default');
  });
});

describe('mailAccounts api 的引法纪律', () => {
  it('U6：域内 schema 的类型引用是 import type（编译期擦除，api → views 不留类型边）', () => {
    // 守 CLAUDE.md「api 层引域内 schema 默认用 import type」。运行时的三条值引入是
    // 「写端点没有 queryFn 承载」这一条例外（见文件头 N2），所以这里只查 type 那一条。
    const src = readFileSync(new URL('../mailAccounts.ts', import.meta.url), 'utf8');
    const match = src.match(
      /import\s+(type\s+)?\{[^}]*\}\s*from\s*'@\/views\/mail\/accounts\/mailAccountSchema'/s,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('type ');
  });

  it('U7：api 层**不**另存 SMTP 预设映射（host / port 由 `/mail/meta` 下发）', () => {
    // 前端存一份「163 ⇒ smtp.163.com:465」就是这个域的第二真源：后端改端口时它不会
    // 报错、只会静默显示旧值。唯一允许出现在 api 层的是**入参**里的枚举别名。
    const src = readFileSync(new URL('../mailAccounts.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/smtp\.163\.com|smtp\.qq\.com/);
    expect(src).not.toMatch(/465/);
  });
});
