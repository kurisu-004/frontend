// @vitest-environment happy-dom
// src/api/files/__tests__/previewContract.spec.ts —— `GET /files/objects/{id}/preview`
// 的**跨仓错误契约**守卫。
//
// 这份 spec 存在的理由是一类其它 spec 结构上发现不了的缺陷：白名单 / 分流逻辑全部按
// 「手造的 `{code: …}` 对象」测，而**决定 `ApiError.code` 到底是什么的那一层**
// （`api/http.ts` 的响应拦截器）从未参与过这些用例。那一层的事实是：
//
//   响应体是信封 ⇒ `ApiError.code` = **信封里的业务码**，不是 HTTP 状态码。
//
// 于是「白名单按 HTTP 状态码写」这种错在纯 mock 的 spec 里全绿 —— 而它一错，后端
// 返 502 + `{code: 21118}` 时前端读到的是 `21118`、不在白名单里 ⇒ 每张图纸转圈
// 120 秒才降级；返 502 + `{code: 21117}` 时同理，且每次重试都会让后端**重新提交一个
// 按页计费的 CI job**。
//
// 因此本 spec 分两段：
//   1. **不打 mock，走真实拦截器**：用 `api.defaults.adapter` 把响应换成后端真实的
//      响应体形状（5xx + 信封 / 无信封的裸 502），断言 `ApiError.code` 的取值与分流
//      判据。这一段只需要本仓的 `api/http.ts`，任何机器都能跑。
//   2. **对着后端源码核码表**（可选段）：能找到后端仓时读 `src/shared/error.rs` 与
//      `preview/dto.rs`，确认三个码的名字 / 值、以及 wire 上 `state` 只有 READY / PENDING。
//      找不到（CI 只 checkout 前端仓）时整段跳过并打印提示，**不静默通过**。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, ApiError } from '@/api/http';
import {
  isPreviewSelfHealError,
  isPreviewUnsupportedError,
  PREVIEW_SELF_HEAL_CODES,
  PREVIEW_UNSUPPORTED_CODES,
} from '@/types/part_file';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * 定位后端仓根目录。
 *
 * 判据是「**存在被核的那个模块**」（`src/modules/files/part_file/preview/dto.rs`）而不是
 * 「这是个后端仓」：并行开发时根 checkout 可能还是改动前的代码（核它只会核出一份过期
 * 码表，然后给出一条假红），而机器上可能有多个无关的后端 worktree。候选顺序把 worktree
 * 排在前面 —— 前端仓的并行开发分支对应的后端改动也只落在后端的同名 worktree 里。
 */
function findBackendRoot(): string | null {
  const worktrees: string[] = [];
  const roots: string[] = [];
  let dir = FRONTEND_ROOT;
  for (let i = 0; i < 5; i += 1) {
    const be = join(dir, 'backend-rust');
    if (existsSync(be)) {
      roots.push(be);
      const wtDir = join(be, '.claude', 'worktrees');
      if (existsSync(wtDir)) {
        for (const slug of readdirSync(wtDir).sort()) worktrees.push(join(wtDir, slug));
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of [...worktrees, ...roots]) {
    if (existsSync(join(c, 'src/modules/files/part_file/preview/dto.rs'))) return c;
  }
  return null;
}

const BACKEND = findBackendRoot();

// ============ 第一段：走真实拦截器 ============

/** 真实 adapter 的一次性应答。 */
interface StubResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

let stub: StubResponse = { status: 200, body: null };
const originalAdapter = api.defaults.adapter;

beforeEach(() => {
  stub = { status: 200, body: { code: 0, message: 'ok', data: null } };
  api.defaults.adapter = async (config) => {
    // 用 HTTP 语义表达失败：axios 的响应拦截器按 status ≥ 400 走错误分支，
    // 这与真实网关的形态一致（不能用 reject 伪造，reject 不会经过响应拦截器）。
    if (stub.status >= 400) {
      return Promise.reject(
        Object.assign(new Error(`Request failed with status code ${stub.status}`), {
          config,
          response: {
            data: stub.body,
            status: stub.status,
            statusText: '',
            headers: { 'content-type': stub.contentType ?? 'application/json' },
            config,
          },
          isAxiosError: true,
          toJSON: () => ({}),
        }),
      );
    }
    return {
      data: stub.body,
      status: stub.status,
      statusText: '',
      headers: {},
      config,
    };
  };
});

afterEach(() => {
  api.defaults.adapter = originalAdapter;
});

/** 打一次 `/preview`，返回被抛出的错误（调用方自己断言）。 */
async function callPreview(): Promise<unknown> {
  try {
    await api.get('/files/objects/f1/preview');
  } catch (e) {
    return e;
  }
  throw new Error('本该抛错却成功了 —— stub 没生效？');
}

describe('/preview 的错误信封：ApiError.code 是业务码，不是 HTTP 状态码', () => {
  // 这条是整份 spec 的地基：后端 `AppError::into_response()` 对 21116 / 21117 / 21118
  // 一律装信封，HTTP 状态码（400 / 502）只体现在 HTTP 响应行上。
  it('HTTP 400 + 信封 code=21116 ⇒ ApiError.code 是 21116（不是 400）', async () => {
    stub = { status: 400, body: { code: 21116, message: '该文件不做预览', data: null } };
    const e = (await callPreview()) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe(21116);
    expect(e.code).not.toBe(400);
  });

  it('HTTP 502 + 信封 code=21118 ⇒ ApiError.code 是 21118（不是 502）', async () => {
    stub = { status: 502, body: { code: 21118, message: 'CI 转发失败', data: null } };
    const e = (await callPreview()) as ApiError;
    expect(e.code).toBe(21118);
    expect(e.code).not.toBe(502);
  });

  it('HTTP 502 + 信封 code=21117 ⇒ ApiError.code 是 21117（不是 502）', async () => {
    stub = { status: 502, body: { code: 21117, message: 'CI job 终态 Failed', data: null } };
    const e = (await callPreview()) as ApiError;
    expect(e.code).toBe(21117);
    expect(e.code).not.toBe(502);
  });

  // 无信封的代理层错误（nginx 直接返 HTML / 纯文本）走拦截器的另一支：用 HTTP 状态码
  // 兜底。这是白名单里 400 / 502 两个 HTTP 码**唯一**会真正命中的场景。
  it('无信封的裸 502（代理层）⇒ ApiError.code 退回 HTTP 状态码 502', async () => {
    stub = { status: 502, body: '<html>502 Bad Gateway</html>', contentType: 'text/html' };
    const e = (await callPreview()) as ApiError;
    expect(e.code).toBe(502);
  });

  // 分流判据的落地：三个真实信封码各自归到哪一组。
  it('分流：21116 / 21118 立即降级组，21117 有限自愈组', async () => {
    for (const [code, msg] of [
      [21116, '该文件不做预览'],
      [21118, 'CI 转发失败'],
    ] as const) {
      stub = { status: 502, body: { code, message: msg, data: null } };
      const e = await callPreview();
      expect(isPreviewUnsupportedError(e), `${code} 应进「立即降级」组`).toBe(true);
      expect(isPreviewSelfHealError(e), `${code} 不该进「自愈」组`).toBe(false);
    }

    stub = { status: 502, body: { code: 21117, message: 'CI job 终态 Failed', data: null } };
    const e17 = await callPreview();
    expect(isPreviewSelfHealError(e17), '21117 应进「有限自愈」组').toBe(true);
    expect(isPreviewUnsupportedError(e17), '21117 不该进「立即降级」组').toBe(false);
  });

  // 白名单里那三个业务码必须逐个在列 —— 这三个码任何一个漏了都是「默认部署下转圈
  // 120 秒」或「一次终局失败被重提交十几次 CI job」。这里用真实信封逐个走一遍。
  it('白名单逐个覆盖真实信封码：三个业务码都在，且两组成员不重叠', () => {
    for (const code of [21116, 21117, 21118]) {
      const inUnsupported = (PREVIEW_UNSUPPORTED_CODES as readonly number[]).includes(code);
      const inSelfHeal = (PREVIEW_SELF_HEAL_CODES as readonly number[]).includes(code);
      expect(inUnsupported || inSelfHeal, `业务码 ${code} 两组都没进 —— 它会被当可重试错误`).toBe(
        true,
      );
    }
    for (const code of PREVIEW_UNSUPPORTED_CODES) {
      expect(
        (PREVIEW_SELF_HEAL_CODES as readonly number[]).includes(code),
        `${code} 同时出现在两组里，分流语义矛盾`,
      ).toBe(false);
    }
  });
});

// ============ 第二段：对着后端源码核（找不到仓则跳过） ============

describe.skipIf(!BACKEND)('/preview 契约与后端源码一致', () => {
  it('error.rs 里三个预览码的值与名字一致', () => {
    const src = readFileSync(join(BACKEND!, 'src/shared/error.rs'), 'utf8');
    const expectConst = (name: string, value: number) => {
      const re = new RegExp(`${name}\\s*:\\s*i32\\s*=\\s*${value}\\b`);
      expect(re.test(src), `后端 error.rs 里 ${name} 不再等于 ${value} —— 前端白名单要跟着改`).toBe(
        true,
      );
    };
    expectConst('BIZ_PART_FILE_PREVIEW_UNSUPPORTED', 21116);
    expectConst('BIZ_PART_FILE_PREVIEW_FAILED', 21117);
    expectConst('BIZ_PART_FILE_PREVIEW_FORWARD_FAILED', 21118);
  });

  // 后端 `PreviewOut.state` 只有 READY / PENDING 两个取值：失败走 5xx 信封，
  // `FAILED` 只出现在 `t_file_preview.state` 表列里。前端把 `'FAILED'` 加进
  // `FilePreviewState` 就是在给一个后端永不返回的响应写分支。
  it('preview/dto.rs 声明的 wire state 只有 READY / PENDING', () => {
    const src = readFileSync(
      join(BACKEND!, 'src/modules/files/part_file/preview/dto.rs'),
      'utf8',
    );
    // 剥注释，只看代码里出现的 state 字面量 / 常量引用。
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const usesFailedLiteral = /state::FAILED|\bFAILED\b/.test(code);
    expect(
      usesFailedLiteral,
      'preview/dto.rs 出现了 FAILED —— 后端开始返第三态了，前端 FilePreviewState 与降级分支要一起改',
    ).toBe(false);
    expect(/state::READY/.test(code), 'preview/dto.rs 里找不到 READY 出参').toBe(true);
    expect(/state::PENDING/.test(code), 'preview/dto.rs 里找不到 PENDING 出参').toBe(true);
  });
});

if (!BACKEND) {
  // 整段 skipIf 会安静地跳过 —— 明确打一行，别让「没核成」看起来像「核过了」。
  console.warn(
    '[跳过] 未找到后端仓（backend-rust/src/modules/files/part_file/preview/dto.rs），' +
      '跨仓码表核对未执行；本仓内的信封分流断言仍然有效。',
  );
}