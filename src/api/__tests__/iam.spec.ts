// src/api/__tests__/iam.spec.ts
//
// 2026-10-10 新增：iam 域（`src/api/iam.ts`）写端点的**URL + 方法 + body 契约守卫**。
//
// 为什么必须逐字钉死：iam 域的写端点在 2026-10-10 这一轮全部改成**必收乐观锁
// `version`**，漏传不是业务错误码而是 axum 的 HTTP 422 **纯文本**（不是 `R` 信封）——
// 开发期表现为「按钮点了没反应 / 报错信息莫名其妙」，从错误码层面完全看不出是漏了
// version。方法同理：解绑从 `DELETE` 改成 `POST .../wx-bind/unbind`（后端全站只允许
// GET 与 POST），打错方法会 405。这类契约必须在**前端**侧被钉死，不能靠后端自测兜底。
//
// 覆盖：
//   - I1：`unbindWxIdentity` 打 **POST** `/iam/users/{id}/wx-bind/unbind` 且 body 含
//     `version`（不是 DELETE —— 本仓至今零 DELETE 调用，本文件末尾还有一条守卫）。
//   - I2：`updateUser` / `deactivateUser` / `removeUserRole` 三条都走 POST 且 body 含
//     `version`（removeRole 的 version 取 `UserRoleOut.version`）。
//   - I3：`getWxIdentity` / `bindWxIdentity` 的 URL 与 body（bind 只有 wx_user_id）。
//   - I4：`listUsers` 的四个 query 参数落到 axios params。
//   - I5：全仓无 DELETE 调用（解绑改 POST 之后，这条防的是有人「顺手改回去」）。
//
// mock 手法沿 `src/api/__tests__/inspection.contract.spec.ts` 同款：整模块桩掉
// `@/api/http`（不 importOriginal），只留可断言的 api.get / api.post 入口。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
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
  normalizeListResult: (resp: {
    items: unknown[];
    total: string | number;
    limit: string | number;
    offset: string | number;
  }) => ({
    items: resp.items,
    total: Number(resp.total),
    limit: Number(resp.limit),
    offset: Number(resp.offset),
  }),
  refreshClient: { post: vi.fn() },
  ApiError: class ApiError extends Error {
    public constructor(
      public readonly code: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import {
  bindWxIdentity,
  deactivateUser,
  getWxIdentity,
  listUsers,
  removeUserRole,
  unbindWxIdentity,
  updateUser,
} from '../iam';

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
  httpGetMock.mockResolvedValue({ data: null });
  httpPostMock.mockResolvedValue({ data: undefined });
});

describe('iam 写端点的 URL / 方法 / body 契约', () => {
  it('I1：解绑走 POST /iam/users/{id}/wx-bind/unbind，body 带 version', async () => {
    await unbindWxIdentity('U1', { version: 2 });
    expect(httpPostMock).toHaveBeenCalledTimes(1);
    expect(httpPostMock.mock.calls[0]?.[0]).toBe('/iam/users/U1/wx-bind/unbind');
    expect(httpPostMock.mock.calls[0]?.[1]).toEqual({ version: 2 });
    // 关键：不是 DELETE（后端全站只允许 GET / POST）。
    expect(httpGetMock).not.toHaveBeenCalled();
  });

  it('I2：update / deactivate / removeRole 三条都走 POST 且 body 带 version', async () => {
    await updateUser('U1', { version: 3, full_name: '张三' });
    expect(httpPostMock.mock.calls[0]?.[0]).toBe('/iam/users/U1/update');
    expect(httpPostMock.mock.calls[0]?.[1]).toEqual({ version: 3, full_name: '张三' });

    httpPostMock.mockClear();
    await deactivateUser('U1', { version: 3 });
    expect(httpPostMock.mock.calls[0]?.[0]).toBe('/iam/users/U1/deactivate');
    // 该端点原本无 body，2026-10-10 起必收 version。
    expect(httpPostMock.mock.calls[0]?.[1]).toEqual({ version: 3 });

    httpPostMock.mockClear();
    // version 取 UserRoleOut.version（t_user_role 的计数器）。
    await removeUserRole('U1', 'R1', { version: 5 });
    expect(httpPostMock.mock.calls[0]?.[0]).toBe('/iam/users/U1/roles/R1/remove');
    expect(httpPostMock.mock.calls[0]?.[1]).toEqual({ version: 5 });
  });

  it('I3：企微绑定读 / 写：GET 与 POST 的 URL、body 只有 wx_user_id', async () => {
    httpGetMock.mockResolvedValue({ data: null });
    // 未绑定时信封 data 是 null，api 层原样返回（不归一成空对象）。
    expect(await getWxIdentity('U1')).toBeNull();
    expect(httpGetMock.mock.calls[0]?.[0]).toBe('/iam/users/U1/wx-bind');

    httpPostMock.mockResolvedValue({ data: { id: 'X1' } });
    await bindWxIdentity('U1', { wx_user_id: 'zhangsan' });
    expect(httpPostMock.mock.calls[0]?.[0]).toBe('/iam/users/U1/wx-bind');
    // 不传 corp_id（后端已删该入参，只认配置值 WECOM_CORPID）。
    expect(httpPostMock.mock.calls[0]?.[1]).toEqual({ wx_user_id: 'zhangsan' });
  });

  it('I4：列表的四个 query 参数落到 axios params', async () => {
    httpGetMock.mockResolvedValue({
      data: { items: [], total: '0', limit: 20, offset: 40 },
    });
    await listUsers({ username_like: 'zhang', is_active: false, limit: 20, offset: 40 });
    expect(httpGetMock.mock.calls[0]?.[0]).toBe('/iam/users');
    const config = httpGetMock.mock.calls[0]?.[1] as { params: Record<string, unknown> };
    expect(config.params).toEqual({
      username_like: 'zhang',
      is_active: false,
      limit: 20,
      offset: 40,
    });
  });

  it('I5：全仓无 DELETE 调用（解绑改 POST 之后防「顺手改回去」）', () => {
    // 递归扫 src/ 下的 .ts / .vue，找 axios 客户端上的 DELETE 方法调用。
    const root = join(process.cwd(), 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|vue)$/.test(name)) continue;
        const src = readFileSync(full, 'utf8');
        if (/api\s*\.\s*delete\s*\(/.test(src)) hits.push(full);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
