// src/api/__tests__/printTemplates.contract.spec.ts
//
// 2026-10-16 新增（review 第 1 轮 MAJOR-3）：`src/api/printTemplates.ts` 五个端点的
// **wire 契约**守卫。
//
// 为什么逐字钉 URL：本域五个端点的路径打错就是 404 / 405，而 404 只在「点一下才发现」时暴露
// —— 前端没有任何类型能挡住 URL 打错（同 `mailAccounts.contract.spec.ts` /
// `inspection.contract.spec.ts` / `mailDigest.contract.spec.ts` 的同款理由）。
//
// ⚠️ **本文件最有价值的一条是 U1 的尾斜杠**：实现里 4 处 URL 全是无尾斜杠的
// `'/print-templates'`，而本文件的**注释**在 review 前把上传端点写成 `POST /print-templates/`
//（与同文件下方那条「URL 一律不带尾斜杠」的注释自相矛盾）。注释错了没人红、有人照着
// 「修正」成 `/print-templates/` 就是 404 —— 而那时没有任何测试会红。**把 URL 钉进断言
// 正是为了让这类改动必须显式过一道。**
//
// ⚠️ **守门点分工**（照 mailAccounts 那组的 N1 / N2 / N2b 三段式，两侧都要有人在）：
//   - N1：`listPrintTemplates` **不 parse** —— 它有 queryFn 承载（`usePrintTemplateListQuery`），
//     在 api 层再走一遍等于每屏数据被校验并克隆两遍；
//   - N2：`resolvePrintTemplate` **必须 parse** —— 走组件单次拉取，**没有 queryFn 承载**
//     （CLAUDE.md 为这类调用留的口子）。漏掉时坏响应会一路流到「刚解析的模板
//     `id` 是 undefined / `version` 是 undefined」；
//     ⚠️ 2026-10-15：原 `uploadPrintTemplate` 的 parse 随 multipart 上传端点一起下线 ——
//     上传改走直传链路（`utils/directUpload.ts` → files/objects/confirm），出参是通用
//     `PartFileItem`，本域的 `.strict()` schema 只服务读侧（列表 / 解析）。
//   - N2b：`deletePrintTemplate` **不 parse** —— 后端返 `R<()>`、信封 `data` 是 `null`，
//     `parse(null)` 必抛，那正是「删除永远失败」的成因。
//   本文件用**真实 zod schema + 喂坏数据**来判这三段（而不是 parse 计数桩）：坏响应时
//   N1 / N2b 照常 resolve、N2 照常 reject —— 这是消费方真正看到的现象。
//
// mock 手法：`vi.mock('@/api/http')` 只换掉 `api.get` / `api.post`（`cleanParams` 走真实现，
// 否则「空值不上 wire」那条断言是在验副本）。
//
// ⚠️ **2026-10-16 review 第 2 轮 C-1 补的一整段「出参形状对账」**（`V` 组用例）—— 本文件
// 第 1 轮最有价值的产出恰恰是**它当时没覆盖的东西**：下面 `ROW` / `RESOLVE_ROW` 两个 fixture
// 是**前端自己手写的**，断言的只是「前端代码符不符合前端自己的想象」，所以出参形状错了整整
// 两轮没被拦（上传 / 列表 100% 不可用、自动选用 100% 失效）。
//
// ⚠️⚠️ **2026-10-16 review 第 3 轮 MAJOR-1 订正本段原先的强度声明**：V1..V6 里的
// `ROW` / `RESOLVE_ROW` 是**本文件内的手写字面量**，`printTemplateSchema` 在另一个文件，
// 三者之间没有任何一处读后端仓源码 ⇒ 明天后端把 `kind` 改成 `file_kind`、或给
// `PrintTemplateListOut` 加回 `limit`，这 6 条**一条都不会红**。把「前端此刻的想象」抄成
// 字面量再断言自己抄对了，与第 1 轮「fixture 没对照」是同一条谬误，只是升级成了
// 「对照了、但断言仍然自证」。**所以 V1..V6 的正确定位是「行为侧镜像」**：它们断言的是
// 「parse 真的接在返回路径上 / `.strict()` 真的按预期抛或 strip」，那一半是真价值；它们
// **不**承担任何「后端现在长什么样」的外部事实。
//
// ⇒ **外部事实由 V7 承担**（`V7a..V7d`，见文件末尾）：照 `api/files/__tests__/
// previewContract.spec.ts::findBackendRoot` 的既有纪律定位后端仓、真读 `vo.rs`、
// 把三个 struct 的 `pub <字段>:` 抽出来与前端三组键**双向集合相等**对拍。
// **今后改 `ROW` / `RESOLVE_ROW` 这两个 fixture 之前，先跑一遍 V7**（它会告诉你后端真源
// 此刻是哪几个字段），别再靠「打开 vo.rs 对一遍」这种无人监督的自觉动作。
//
// ⚠️ **V7 的强度边界（能守什么 / 守不住什么，别越读越信）**：
//   - **只在本机能读到后端仓时生效**。CI 只 checkout 前端仓 ⇒ 整段 skip 并打一行
//     `[跳过]` 提示（**不静默通过**，同 previewContract 的约定）。
//   - **只比字段名，不比类型**。后端把 `pub kind: String` 改成 `Option<String>`（wire 变
//     `null`）这类改动 V7 抓不到 —— 但它的运行时后果是 `z.string()` 拒 `null` 当场抛，
//     **响的**，不是静默失效。
//   - **只认「Rust 字段名 = wire 键」这一前提**。一旦后端给这三个 struct 加
//     `#[serde(rename = …)]` 或 `skip_serializing_if`，wire 键就与字段名分家 ⇒ V7d 专门
//     守这条前提，它变红时人来看一眼即可。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as HttpModule from '@/api/http';

// ⚠️ `vi.mock` 的 factory 会被 hoist 到文件顶部 ⇒ 桩变量必须走 `vi.hoisted`，
// 否则这里就是 `Cannot access 'apiGetMock' before initialization`（mailAccounts 那份
// 用的是 `vi.fn` 直接声明 + 全模块桩，本文件要保留 `cleanParams` 的真实现，只能用
// importOriginal 形态，也就必须 hoisted）。
const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('@/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, api: { ...actual.api, get: apiGetMock, post: apiPostMock } };
});

import {
  deletePrintTemplate,
  fetchPrintTemplateContent,
  isPrintTemplateXlsxName,
  listPrintTemplates,
  resolvePrintTemplate,
} from '../printTemplates';
import {
  printTemplateListResultSchema,
  printTemplateResolveSchema,
  printTemplateSchema,
  PRINT_TEMPLATE_ACCEPT,
  PRINT_TEMPLATE_ACCEPT_EXT,
} from '@/views/printTemplates/printTemplateSchema';
import { XLSX_MIME } from '@/constants/mime';
import { normalizeUploadContentType } from '@/utils/fileContentType';

// ============================================================================
// 跨仓对账基建（2026-10-16 review 第 3 轮 MAJOR-1）—— 只服务于文件末尾的 V7 组
// ----------------------------------------------------------------------------
// 纪律与 `api/files/__tests__/previewContract.spec.ts` 逐字同源（那份是本仓「对着后端
// 源码核」的唯一先例）：判据是「**存在被核的那个模块**」而不是「这是个后端仓」；候选顺序
// 把后端 worktree 排在根 checkout 前面；找不到时整段 skip 并打一行提示、**不静默通过**。
// ============================================================================

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** 被核的那份后端源码（`print_template` 是 2026-10-16 新立域，只有后端 worktree 里有）。 */
const BACKEND_VO_REL = 'src/modules/print_template/vo.rs';

/**
 * 定位后端仓根目录；返回 `null` 表示「本机没有可读的后端源」。
 *
 * 判据是「**存在被核的那个模块**」（`src/modules/print_template/vo.rs`）而不是
 * 「这是个后端仓」：本域是 2026-10-16 新立域，根 checkout 里**根本没有** `print_template`
 * 模块，只有对应的后端 worktree 里有 ⇒ 用「像不像后端仓」判会把根 checkout 选上，然后对着
 * 一份没有 `print_template` 的源码核出一条假红。候选顺序把 worktree 排在前面 —— 前端并行
 * 开发分支对应的后端改动也只落在后端的同名 worktree 里。
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
    if (existsSync(join(c, BACKEND_VO_REL))) return c;
  }
  return null;
}

const BACKEND = findBackendRoot();

/**
 * 从后端 Rust 源码里抽出某个 `pub struct` 的**字段名**（按声明顺序）。
 *
 * ⚠️ **只抽名字、不抽类型，也不解析 serde 属性** —— 那两件事的强度边界写在文件头
 * 「V7 的强度边界」一节（类型差异的运行时后果是**响的**，属性分家由 V7d 专门守）。
 * 抽到空集时**抛错而不是返回空数组**：否则「正则哪天坏了 ⇒ 抽不出字段」会退化成
 * 「后端字段集为空」，与前端那侧一比就变成一条读不懂的红。
 *
 * 逐行扫描而不是一个大正则：doc 注释行（`///`）以 `///` 开头、`#[serde(…)]` 属性行以
 * `#[` 开头，两者的行首都不是 `pub`，天然被跳过；struct 体以「独占一行的 `}`」收尾。
 */
function rustStructFields(src: string, structName: string): string[] {
  const head = new RegExp(`^\\s*pub\\s+struct\\s+${structName}\\s*\\{`, 'm').exec(src);
  if (!head) throw new Error(`后端 vo.rs 里找不到 struct ${structName} —— 跨仓对账无法进行`);
  const fields: string[] = [];
  for (const line of src.slice(head.index + head[0].length).split('\n')) {
    if (line.trim() === '}') break;
    const m = /^\s*pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (m) fields.push(m[1]!);
  }
  if (fields.length === 0) throw new Error(`后端 vo.rs 的 struct ${structName} 抽出 0 个字段`);
  return fields;
}

/** 读一次后端 `vo.rs`（V7 组专用；`BACKEND` 为 null 时那段整段 skip，不会走到这里）。 */
function readBackendVo(): string {
  return readFileSync(join(BACKEND!, BACKEND_VO_REL), 'utf8');
}

/** 取出某个 zod object 的键集（`z.object({…})` 的 `.shape` 就是声明时的键表）。 */
function zodKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort();
}

/**
 * 一条**逐字合法**的 `PrintTemplateOut`（**12 字段**；`.strict()` ⇒ 多一个键即抛）。
 *
 * ⚠️ **逐字照抄后端 `print_template/vo.rs` 的字段表**（2026-10-16 review 第 2 轮 C-1）。
 * ⚠️ ⚠️ **它是「前端此刻的想象」的镜像，不是外部事实**（2026-10-16 review 第 3 轮 MAJOR-1）：
 *   真源是文件末尾的 V7 组（真读后端 `vo.rs`）。改这里之前先跑 V7，别靠自觉对着源码抄。
 * ⚠️ **`file_type` 是短码 `"XLSX"`、不是 MIME**（后端 `policy::file_type_for_ext` 的返回值
 * 形态）；xlsx 的规范 MIME 在**另一个字段** `content_type` 上。这俩值形态不同不是笔误 ——
 * 真实 wire 上就是这样。
 */
const ROW = {
  id: '9000000000000701',
  customer_id: '9000000000000900',
  kind: 'DELIVERY_TEMPLATE',
  file_type: 'XLSX',
  original_filename: 'fala.xlsx',
  file_size: 12345,
  content_type: XLSX_MIME,
  content_sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  version: 2,
  created_at: '2026-10-16 09:00:00',
  updated_at: '2026-10-16 09:30:00',
  customer_name: '法拉电子',
} as const;

/**
 * 一条**逐字合法**的 `PrintTemplateResolveOut`（**嵌套**：一个信封套一行）。
 *
 * ⚠️ 逐字照抄后端 `vo.rs`：`{ template: PrintTemplateOut, customer_name }`。
 * ⚠️ **没有 `content_url`** —— 后端从头到尾没有这个字段（此前前端凭空造了一个，
 * 直接导致 resolve 的 `parse` 每屏抛 ⇒ 自动选用 100% 失效）。
 */
const RESOLVE_ROW = {
  template: ROW,
  customer_name: ROW.customer_name,
} as const;

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiGetMock.mockResolvedValue({ data: RESOLVE_ROW });
  apiPostMock.mockResolvedValue({ data: ROW });
});

describe('printTemplates api — 五个端点的 URL / method / body 契约', () => {
  // ⚠️ 2026-10-15：原 U1（上传打 POST /print-templates，multipart 恰好 data + file 两段）
  // 随 multipart 端点下线。直传链路的 URL / body 契约改由
  // `src/api/files/__tests__/intents.spec.ts` 守（upload-intents + objects/confirm）。
  // 这里保留一条**反向**断言：上传端点必须**不再**被打 —— 否则就说明有人把旧实现
  // 复活了，而旧路径在后端已 404。
  it('U1：打印模板上传不再打 POST /print-templates（直传链路接管，旧端点已下线）', () => {
    const src = readFileSync(new URL('../printTemplates.ts', import.meta.url), 'utf8')
      .split('\n')
      .map((l) => (/^\s*(\/\/|\*)/.test(l) ? l.replace(/[^\n]/g, ' ') : l))
      .join('\n');
    // 注释里仍留着旧端点的留档（错误码表），所以先剥注释再查**可执行代码**。
    expect(src).not.toMatch(/uploadPrintTemplate\s*[=(]/);
    expect(src).not.toMatch(/api\.post<[^>]*>\(\s*'\/print-templates'/);
  });

  // ⚠️ **强度有限，别当 URL 纪律的守卫**（2026-10-16 review 第 2 轮 M-4 复核）：它只认**单引号**
  //   字面量，把 URL 写成反引号 / 双引号就绕过去了。真正的 URL 守卫是 U1 / U2 / U3 / U4 / U5
  //   那五条（它们断言的是**实际发出去的请求参数**，换引法改不掉）。当「别把带尾斜杠的
  //   完整路径抄进来」的粗筛用。
  it('U1b：上传 URL 与 resolve / list 的 URL 共用同一 prefix（三个都是 /print-templates…）', () => {
    // 防「只改了上传那一条、另外两条忘了」：三条的域根是同一个字面量。
    const src = readFileSync(new URL('../printTemplates.ts', import.meta.url), 'utf8');
    // `'/print-templates/'`（带尾斜杠）在本文件里只能是「前缀 + 子路径」，不能是完整路径。
    expect(src).not.toContain("'/print-templates/'");
    expect(src).toContain("'/print-templates'");
  });

  it('U2：列表打 GET /print-templates（无尾斜杠），三个查询参数经 cleanParams 去掉空值', async () => {
    apiGetMock.mockResolvedValue({ data: { items: [ROW], total: '1', limit: 200, offset: 0 } });
    await listPrintTemplates({ customer_id: '', limit: 200 });
    expect(apiGetMock.mock.calls[0]![0]).toBe('/print-templates');
    // ⚠️ `customer_id: ''` 经 cleanParams 被丢掉 ⇒ 不会发出 `?customer_id=` 空串。
    expect(apiGetMock.mock.calls[0]![1]).toEqual({ params: { limit: 200 } });

    apiGetMock.mockClear();
    await listPrintTemplates();
    expect(apiGetMock.mock.calls[0]![1]).toEqual({ params: {} });
  });

  it('U3：自动选用打 GET /print-templates/resolve，customer_id 是 query 参数', async () => {
    await resolvePrintTemplate('9000000000000900');
    expect(apiGetMock.mock.calls[0]![0]).toBe('/print-templates/resolve');
    expect(apiGetMock.mock.calls[0]![1]).toEqual({ params: { customer_id: '9000000000000900' } });
  });

  it('U4：取字节打 GET /print-templates/{id}/content，**必须** responseType: arraybuffer', async () => {
    const buf = new ArrayBuffer(8);
    apiGetMock.mockResolvedValue({ data: buf });
    const out = await fetchPrintTemplateContent('SN/A B');
    expect(apiGetMock.mock.calls[0]![0]).toBe('/print-templates/SN%2FA%20B/content');
    expect(apiGetMock.mock.calls[0]![1]).toEqual({ responseType: 'arraybuffer' });
    // 出参是 Uint8Array（hucre 的 openXlsx 吃这个形状），不是裸 ArrayBuffer。
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(8);
  });

  it('U5：软删打 POST /{id}/delete（**不是 DELETE 方法**），body 必带 version、id 经 encodeURIComponent', async () => {
    apiPostMock.mockResolvedValue({ data: null });
    await deletePrintTemplate('9000000000000701', { version: 7 });
    expect(apiPostMock.mock.calls[0]![0]).toBe('/print-templates/9000000000000701/delete');
    // ⚠️ 漏传 version 是 axum 的 HTTP 422 **纯文本**，连业务码都拿不到（见 mailAccounts U5）。
    expect(apiPostMock.mock.calls[0]![1]).toEqual({ version: 7 });
  });
});

describe('printTemplates api — 守门点分工（N1 / N2 / N2b）', () => {
  it('N1：listPrintTemplates 不 parse，坏响应不抛（只把 total 归一成 number）', async () => {
    // 真在 api 层挂过 parse 时这里必然抛 ZodError —— 这条是 N1 的行为侧镜像。
    // 注意断言的形态：`items` 原样透传（`undefined`）、`total` 被 `Number(undefined)` 变成
    // NaN，但**不抛**。守门在 queryFn（`usePrintTemplateListQuery`），不在这里。
    // ⚠️ 2026-10-16 review 第 2 轮 C-1：`limit` / `offset` 两键已不在返回值里
    // （后端不回显，见 V5）。
    apiGetMock.mockResolvedValue({ data: { definitely_not_a_list: true } });
    await expect(listPrintTemplates()).resolves.toEqual({ items: undefined, total: NaN });
  });

  it('N1b：listPrintTemplates 的 total 仍被归一成 number', async () => {
    // 后端 `total` 是裸 `i64`，归一当前是恒等；留着是防御层（其它域 list 端点的计数类型不统一，
    // 有的 serialize_i64 给 string）。这一层归一是 api 层该做的事，与「要不要 parse」是两个
    // 独立问题。
    apiGetMock.mockResolvedValue({ data: { items: [], total: '7' } });
    await expect(listPrintTemplates()).resolves.toEqual({ items: [], total: 7 });
  });

  it('N2b：resolvePrintTemplate 必须 parse（坏响应照抛）', async () => {
    // ⚠️ resolve 出参刻意**不** `.strict()`（读侧，见 printTemplateSchema 的 doc）⇒ 多出来的
    // 键被 strip 而不是抛。这里只断「少字段抛」这一半：parse 这道闸确实在返回路径上。
    apiGetMock.mockResolvedValue({ data: { id: 'X' } });
    await expect(resolvePrintTemplate('C1')).rejects.toThrow();
  });

  it('N2c：resolve 出参多一个后端新加的字段时**不抛**（顶层读侧不 `.strict()`，否则全站自动选型静默失效）', async () => {
    apiGetMock.mockResolvedValue({ data: { ...RESOLVE_ROW, some_new_field: 'x' } });
    const out = await resolvePrintTemplate('C1');
    expect(out.template.id).toBe(RESOLVE_ROW.template.id);
    expect('some_new_field' in out).toBe(false);
  });

  it('N2b4：deletePrintTemplate 不 parse 且返回 undefined（后端 data 是 null，无可守）', async () => {
    apiPostMock.mockResolvedValue({ data: null });
    await expect(deletePrintTemplate('T1', { version: 1 })).resolves.toBeUndefined();
  });

  it('N2b5：软删失败照常 reject 出 api 层（onError 靠它转人话）', async () => {
    const err = Object.assign(new Error('模板不存在'), { code: 21101 });
    apiPostMock.mockRejectedValue(err);
    await expect(deletePrintTemplate('T1', { version: 1 })).rejects.toThrow('模板不存在');
  });
});

describe('printTemplates 的扩展名闸（与后端 21102 判据同源）', () => {
  it('E1：只接受 .xlsx（大小写不敏感）', () => {
    expect(PRINT_TEMPLATE_ACCEPT_EXT).toBe('.xlsx');
    expect(isPrintTemplateXlsxName('送货单模板.xlsx')).toBe(true);
    expect(isPrintTemplateXlsxName('TEMPLATE.XLSX')).toBe(true);
    expect(isPrintTemplateXlsxName('模板.xls')).toBe(false);
    // ⚠️ `模板.xlsx.exe` 之类必须被拒 —— 这正是「按后缀比对」而不是「文件名里含 xlsx」。
    expect(isPrintTemplateXlsxName('模板.xlsx.exe')).toBe(false);
    // el-upload 的 accept 属性用的是同一个常量。
    expect(PRINT_TEMPLATE_ACCEPT).toBe(PRINT_TEMPLATE_ACCEPT_EXT);
  });

  // ⚠️ **强度有限**（2026-10-16 review 第 2 轮 M-4 复核）：`not.toContain("'.xlsx'")` 只认**单引号**
  //   字面量，换反引号 / 双引号就绕过去了。它当「没有第二份字面量副本」的粗筛用；
  //   「上传路径真的取到 xlsx 规范 MIME」由下面的 E3 承担（那是行为断言，不依赖扫源码）。
  it('E2：MIME 字面量在上传路径的两个文件里**没有第二份副本**（后端改判据时它不会报错、只会静默被 21102 挡回）', () => {
    const src = readFileSync(new URL('../printTemplates.ts', import.meta.url), 'utf8');
    // 允许的是从契约模块 import 后的**使用**；不允许的是把字面量抄进来。
    expect(src).not.toContain(XLSX_MIME);
    expect(src).not.toContain("'.xlsx'");
    // 直传链路的 content_type 归一在 `utils/fileContentType.ts`（六个上传场景共用），
    // 它同样不许出现字面量副本 —— 后端 policy 一改，这里就该跟着改常量而不是改字面量。
    const normalize = readFileSync(
      new URL('../../utils/fileContentType.ts', import.meta.url),
      'utf8',
    );
    expect(normalize).not.toContain(XLSX_MIME);
  });

  // ⚠️ **上传路径**（不是下载路径）的 MIME 真源。`usePrintTemplatesStore.ts` 里的 `XLSX_MIME`
  //   只用在下载那段的 Blob 上 ⇒ 「store 里没有字面量」这条断言守不住上传。
  //   真源是 `utils/fileContentType.ts::normalizeUploadContentType`：它在调 upload-intents
  //   **之前**算出 content_type（该值会被签进 SigV4 的 SignedHeaders，PUT 时必须原样回填）。
  it('E3：上传路径的 content_type 取契约常量（行为断言，不扫源码）', () => {
    // 后端 policy 对 xlsx **只**收规范 MIME、没有 octet-stream 兜底 ⇒ 这条红了就是
    // 「签发成功 → PUT 成功 → confirm 被拒」，且桶里会留一个孤儿对象。
    expect(normalizeUploadContentType(new File([new Uint8Array([1])], '送货单模板.xlsx'))).toBe(
      XLSX_MIME,
    );
    expect(normalizeUploadContentType(new File([new Uint8Array([1])], 'TEMPLATE.XLSX'))).toBe(
      XLSX_MIME,
    );
    // 且它确实是从**中性常量模块** import 的（不是碰巧字面量相同，也不在某个域内目录里 ——
    // 后者会让 `utils/` 反向依赖 `views/`，层次倒挂）。
    expect(
      readFileSync(new URL('../../utils/fileContentType.ts', import.meta.url), 'utf8'),
    ).toMatch(/import\s*\{\s*XLSX_MIME\s*\}\s*from\s*'@\/constants\/mime'/);
  });

  // ⚠️ **结构性不变量**：`utils/` 不得依赖 `views/`。判据用 CLAUDE.md 的原话 ——「`src/utils/`
  //   只放跨域通用工具……它 import 域内 composable 类型会让 `utils/` 反向依赖 `views/`
  //   （层次倒挂）」。倒挂不会产生任何报错、任何 spec 变红，只是让「通用工具」在打包图上
  //   拖着某个域进首屏闭包，所以只能扫源码守。
  // ⚠️ **强度有限**（同本文件 E2 / U1b / U6 的免责口径）：这是**正则扫源码**，不是依赖图
  //   分析。① 只认 `@/views/` 这个 alias 前缀，写成相对路径 `'../../views/…'` 或
  //   `import … from '@/views'`（无尾斜杠）都绕得过去；② 剥不掉注释，所以**注释里**出现
  //   `from '@/views/…'` 会误报（这偏保守、只会让用例更早红，不是漏判）；③ `vi.mock` 的
  //   specifier 与 `require()` 形态不覆盖。当「`utils/` 里有人引了 views」的粗筛用 ——
  //   「确实有没有跨层依赖」最终的判据是构建产物的模块图，本用例钉的是**别随手引入**。
  it('E4：`src/utils/` 零 `views/` 依赖（层次倒挂守卫）', () => {
    const utilsRoot = new URL('../../utils/', import.meta.url);
    const offenders: string[] = [];
    // 引号三选一（单 / 双 / 反引号）都认；`@/` alias 与相对路径两种写法都算。
    const crossLayer = [
      /\bfrom\s*['"`]@\/views(?:\/|['"`])/,
      /\bimport\(\s*['"`]@\/views(?:\/|['"`])/,
      /\bfrom\s*['"`][^'"`]*(\.\.\/)+views(?:\/|['"`])/,
      /\bimport\(\s*['"`][^'"`]*(\.\.\/)+views(?:\/|['"`])/,
    ];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
        if (e.isDirectory()) {
          walk(child);
        } else if (/\.(ts|vue)$/.test(e.name)) {
          const src = readFileSync(child, 'utf8');
          if (crossLayer.some((re) => re.test(src))) {
            offenders.push(child.pathname.split('/utils/')[1]!);
          }
        }
      }
    };
    walk(utilsRoot);
    expect(offenders).toEqual([]);
  });

  // ⚠️ **MIME 字面量的唯一真源**。全仓只允许 `src/constants/mime.ts` 定义它；抄一份到别处
  //   不会报错，只会在后端改判据时静默被 40001 挡回。⚠️ `src/` 下**只允许**这一条例外：
  //   `views/com/delivery/utils/__tests__/deliveryNoteLabelWorkbook.spec.ts` 刻意用字面量
  //   把常量值钉死（那里若也引常量就变成恒真），其余任何文件出现字面量都要红。
  it('E5：MIME 字面量在 `src/` 下只出现在真源模块 + 那条刻意的值钉用例里', () => {
    const offenders: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
        if (e.isDirectory()) {
          walk(child);
        } else if (/\.(ts|vue)$/.test(e.name)) {
          const rel = child.pathname.split('/src/')[1]!;
          if (rel === 'constants/mime.ts') continue;
          if (rel === 'views/com/delivery/utils/__tests__/deliveryNoteLabelWorkbook.spec.ts') {
            continue;
          }
          if (readFileSync(child, 'utf8').includes(XLSX_MIME)) offenders.push(rel);
        }
      }
    };
    walk(new URL('../../', import.meta.url));
    expect(offenders).toEqual([]);
  });
});

describe('printTemplates api 的引法纪律', () => {
  it('U6：域内 schema 的类型引用是 import type（编译期擦除，api → views 不留类型边）', () => {
    // 守 CLAUDE.md「api 层引域内 schema 默认用 import type」。运行时的两条值引入是
    // 「写端点 + 无 queryFn 承载」这一条例外（见文件头 N2），所以这里只查 type 那一条。
    //
    // ⚠️ **强度有限，别当 import 顺序的守卫**（2026-10-16 review 第 2 轮 M-4 复核）：正则依赖
    // 「`import type` 恰好排在值 import 之前」，调整 import 顺序就红 —— 那与被测行为无关。
    // 当「域内 schema 不许被当值 import 进 api 层」的粗筛用。
    const src = readFileSync(new URL('../printTemplates.ts', import.meta.url), 'utf8');
    const match = src.match(
      /import\s+(type\s+)?\{[^}]*\}\s*from\s*'@\/views\/printTemplates\/printTemplateSchema'/s,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('type ');
  });
});

// ============================================================================
// V 组：出参形状的**行为侧**断言（2026-10-16 review 第 2 轮 C-1 建，3 轮 MAJOR-1 降级定位）
// ----------------------------------------------------------------------------
// 为什么要有这组：U 组钉的是「打到哪里、发什么」，**出参形状一条都没钉**，而 C-1 的五处不符
// **全部**在出参形状上。
//
// ⚠️⚠️ **但这组本身不是「与后端逐字对账」**（2026-10-16 review 第 3 轮 MAJOR-1 更正上面那句
// 「下面每条都对着后端 `vo.rs` 写」的暗示）：`ROW` / `RESOLVE_ROW` 是本文件里的手写字面量，
// 与被测的 `printTemplateSchema` 同属前端 ⇒ V1..V6 只能证明「parse 接在返回路径上、`.strict()`
// 按预期抛或 strip」，**证明不了后端此刻长什么样**。外部事实由本组末尾的 V7 承担。
// ============================================================================

describe('V：出参形状的行为侧断言（C-1；「后端长什么样」由 V7 守）', () => {
  it('V1：行 VO 必含 kind / content_type / file_type —— 漏一个，`.strict()` 下上传与列表全废', async () => {
    // 后端 `PrintTemplateOut` 逐字给了这三个字段（取值恒定，但类型是必填 string）。
    // ⚠️ 前端一度只声明了 `file_type`，少了 `kind` 与 `content_type` ⇒ 每次 parse 都抛。
    expect(Object.keys(ROW)).toEqual(expect.arrayContaining(['kind', 'file_type', 'content_type']));
    // ⚠️ 2026-10-15：上传不再返回本域行 VO（走直传链路，回通用 PartFileItem），
    // 所以守门点改验 **resolve** 这条读路径 —— `printTemplateResolveSchema` 仍必须
    // 真的接在返回路径上（下面的坏响应用例就是证据）。
    const out = await resolvePrintTemplate('C1');
    expect(out.template).toMatchObject({
      kind: 'DELIVERY_TEMPLATE',
      // ⚠️ `file_type` 是**短码**、`content_type` 才是 MIME —— 两个字段值形态不同不是笔误。
      file_type: 'XLSX',
      content_type: XLSX_MIME,
    });
  });

  it('V2：行 VO 的 customer_name 可为 null（客户软删 / 查不到时后端给 null，不是必填）', async () => {
    apiGetMock.mockResolvedValue({
      data: { template: { ...ROW, customer_name: null }, customer_name: null },
    });
    const out = await resolvePrintTemplate('C1');
    expect(out.template).toMatchObject({ customer_name: null });
  });

  it('V3：resolve 出参是「嵌套信封」而非平铺（取字段一律走 hit.template.*）', async () => {
    // 后端 `PrintTemplateResolveOut { template: PrintTemplateOut, customer_name }`。
    // ⚠️ 前端一度写成平铺 ⇒ parse 每屏抛 ⇒ **全站客户的自动选用 100% 失效**。
    const out = await resolvePrintTemplate('C1');
    expect(out.template.id).toBe(ROW.id);
    expect(out.template.original_filename).toBe(ROW.original_filename);
    expect(out.customer_name).toBe(ROW.customer_name);
    // 平铺那套键**不在**顶层 —— 这条守住「不会有人顺手加回 hit.id」。
    expect('id' in out).toBe(false);
    expect('original_filename' in out).toBe(false);
  });

  it('V4：resolve 出参不含 content_url（顶层与 template 内都没有 —— 后端没这个字段）', async () => {
    const out = await resolvePrintTemplate('C1');
    expect('content_url' in out).toBe(false);
    expect('content_url' in out.template).toBe(false);
    // 取字节只有一条路：`fetchPrintTemplateContent(id)`（走 axios、带 Authorization 头）。
    // 这正是本仓不能有「拼相对路径塞 `<a href>`」写法的原因 —— 压根没有路径可拼。
  });

  it('V5：列表出参只有 {items, total}（limit / offset 只作入参，后端不回显）', async () => {
    // ⚠️ 这是 C-1 **连带**查出的第 5 处不符（reviewer 两轮都没看到）：后端
    // `PrintTemplateListOut` 只渲染 `items` 与 `total`。前端一度按分页信封声明
    // `{items, total, limit, offset}` 且 `.strict()`，而 `normalizeListResult` 把缺失的
    // limit/offset 归一成 **NaN**，zod 4 的 `z.number()` 拒 NaN ⇒ queryFn 每屏抛。
    apiGetMock.mockResolvedValue({ data: { items: [ROW], total: 1 } });
    const out = await listPrintTemplates();
    expect(out).toEqual({ items: [ROW], total: 1 });
    // 真后端响应**没有**这两个键 ⇒ 不该被凭空补成 0 / NaN。
    expect('limit' in out).toBe(false);
    expect('offset' in out).toBe(false);
  });

  it('V6：列表出参的 total 仍被归一成 number（字符串计数不能直接喂 z.number()）', async () => {
    apiGetMock.mockResolvedValue({ data: { items: [ROW], total: '7' } });
    await expect(listPrintTemplates()).resolves.toEqual({ items: [ROW], total: 7 });
  });
});

// ============================================================================
// V7 组：真·跨仓对账（2026-10-16 review 第 3 轮 MAJOR-1）
// ----------------------------------------------------------------------------
// V1..V6 全部基于本文件内的手写 fixture，**自证**：明天后端改一个字段名，这 6 条一条都不会红
// （详细论证见文件头「⚠️⚠️ 2026-10-16 review 第 3 轮 MAJOR-1 订正本段原先的强度声明」）。
// V7 是本组里**唯一读后端源码**的一段：定位后端仓 → 真读 `print_template/vo.rs` → 正则抽出
// 三个 struct 的 `pub <字段>:` → 与前端三组 zod 键集**双向集合相等**对拍。
//
// ⇒ 「后端加字段」「后端删字段」「后端改字段名」三个方向**都会红**（集合相等是双向的，
//   不是「前端 ⊇ 后端」的单向包含）—— 这正是字面量断言做不到的那一半。
// ⇒ 纪律与 `previewContract.spec.ts` 逐字同源：找不到后端仓时 `skipIf` + 打一行 `[跳过]`
//   提示，**不静默通过**。
// ============================================================================

describe.skipIf(!BACKEND)('V7：出参形状真·跨仓对账（对着后端 print_template/vo.rs）', () => {
  it('V7a：行 VO —— printTemplateSchema 的键集与后端 PrintTemplateOut 的 pub 字段集双向相等', () => {
    // ⚠️ 这一条是本域 `.strict()` 行 VO 的全部外部事实。后端给 `PrintTemplateOut` 加字段而
    // 前端没跟上 ⇒ 这里红（前端会在生产上逐屏抛 ZodError）；前端多声明了一个后端没有的键 ⇒
    // 这里也红（那是一条永远拿不到值的死字段，`.strict()` 下会让后端真响应直接抛）。
    const backend = rustStructFields(readBackendVo(), 'PrintTemplateOut').sort();
    const frontend = zodKeys(printTemplateSchema);
    expect(
      frontend,
      'printTemplateSchema 的键与后端 PrintTemplateOut 不一致（改一边就要改另一边）',
    ).toEqual(backend);
  });

  it('V7b：resolve 顶层 —— printTemplateResolveSchema 的键集与后端 PrintTemplateResolveOut 双向相等', () => {
    const backend = rustStructFields(readBackendVo(), 'PrintTemplateResolveOut').sort();
    const frontend = zodKeys(printTemplateResolveSchema);
    expect(frontend, 'resolve 顶层键与后端 PrintTemplateResolveOut 不一致').toEqual(backend);
    // ⚠️ 这条对**不 `.strict()` 的顶层**同样成立，但两边的失败后果不同、别混为一谈：
    // 后端加键而前端没声明 ⇒ 运行时被 Zod **strip**（零故障，纯增量信息丢一点）；前端少声明
    // 后端有的键 ⇒ 该字段恒 `undefined`，打印对话框那一支会读到空值而不报错。
    // 这里**仍然红**，是因为「前端少声明」那一支是静默的，值得当场决策一次，而不是顺过去。
  });

  it('V7c：列表顶层 —— printTemplateListResultSchema 的键集与后端 PrintTemplateListOut 双向相等', () => {
    // ⚠️ 后端 `PrintTemplateListOut` 只有 `items` / `total`（`limit` / `offset` 只作入参）。
    // 第 2 轮 C-1 连带查出的第 5 处不符就是前端凭空多声明了那两个键 + `.strict()` + api 层
    // 把 `undefined` 归一成 `NaN` 被 `z.number()` 拒 ⇒ 列表恒空 + 每次弹「加载失败」。
    const backend = rustStructFields(readBackendVo(), 'PrintTemplateListOut').sort();
    const frontend = zodKeys(printTemplateListResultSchema);
    expect(
      frontend,
      '列表顶层键与后端 PrintTemplateListOut 不一致（limit/offset 后端不回显）',
    ).toEqual(backend);
  });

  it('V7d：三个 struct 里都不许出现 serde rename / skip_serializing_if（否则 wire 键与字段名分家，V7a..V7c 的前提失效）', () => {
    // ⚠️ V7a..V7c 成立的前提是「Rust 字段名 == wire 上的 JSON 键」。这条把该前提本身钉住：
    // 一旦后端给这三个 struct 加 `#[serde(rename = "…")]`（wire 键改名）或
    // `skip_serializing_if`（值为空时整个键消失 ⇒ `.strict()` 必抛），V7 抽出来的字段名
    // 就不再代表 wire 键、会在**两边同时对得上**的情况下放行一次真实的断裂。
    const src = readBackendVo();
    const offenders: string[] = [];
    for (const name of ['PrintTemplateOut', 'PrintTemplateResolveOut', 'PrintTemplateListOut']) {
      const head = new RegExp(`^\\s*pub\\s+struct\\s+${name}\\s*\\{`, 'm').exec(src);
      if (!head) throw new Error(`后端 vo.rs 里找不到 struct ${name}`);
      for (const line of src.slice(head.index + head[0].length).split('\n')) {
        if (line.trim() === '}') break;
        // 只看**字段上的**属性行；`#[derive(…)]` 在 `pub struct` 之前，不在本段里。
        if (/#\[serde\([^)]*(rename|skip_serializing_if)/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, '这三个 struct 出现了 serde rename / skip_serializing_if').toEqual([]);
  });
});

if (!BACKEND) {
  // 整段 skipIf 会安静地跳过 —— 明确打一行，别让「没核成」看起来像「核过了」。
  console.warn(
    `[跳过] 未找到后端仓（backend-rust/${BACKEND_VO_REL}，判据是「存在被核的那个模块」），` +
      'V7 跨仓字段对账未执行；V1..V6 的行为侧断言与本仓内的 URL / 守门点断言仍然有效。',
  );
}
