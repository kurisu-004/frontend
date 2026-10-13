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
//   - N2：`uploadPrintTemplate` / `resolvePrintTemplate` **必须 parse** —— 走 useMutation /
//     组件单次拉取，**没有 queryFn 承载**（CLAUDE.md 为这类调用留的口子）。漏掉时坏响应会一路
//     流到「刚传的模板 `id` 是 undefined / `version` 是 undefined」；
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
// 两轮没被拦（上传 / 列表 100% 不可用、自动选用 100% 失效）。`V` 组存在的意义是把「后端
// `vo.rs` 里有哪些字段」这条**外部事实**钉成字面量断言，让「后端加了字段」与「前端漏声明了
// 字段」都变红。**今后改这两个 fixture 之前，先打开后端 `print_template/vo.rs` 对一遍。**

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type * as HttpModule from '@/api/http';

// ⚠️ `vi.mock` 的 factory 会被 hoist 到文件顶部 ⇒ 桩变量必须走 `vi.hoisted`，
// 否则这里就是 `Cannot access 'apiGetMock' before initialization`（mailAccounts 那份
// 用的是 `vi.fn` 直接声明 + 全模块桩，本文件要保留 `cleanParams` 的真实现，只能用
// importOriginal 形态，也就必须 hoisted）。
const { apiGetMock, apiPostMock } = vi.hoisted(() => ({ apiGetMock: vi.fn(), apiPostMock: vi.fn() }));

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
  uploadPrintTemplate,
} from '../printTemplates';
import {
  PRINT_TEMPLATE_ACCEPT,
  PRINT_TEMPLATE_ACCEPT_EXT,
} from '@/views/printTemplates/printTemplateSchema';
import { XLSX_MIME } from '@/views/com/delivery/utils/deliveryNoteTemplateContract';

/**
 * 一条**逐字合法**的 `PrintTemplateOut`（**12 字段**；`.strict()` ⇒ 多一个键即抛）。
 *
 * ⚠️ **逐字照抄后端 `print_template/vo.rs` 的字段表**（2026-10-16 review 第 2 轮 C-1）。
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
  content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

/** `el-upload` 给的那种 File（happy-dom / node 都有 File 全局）。 */
function xlsxFile(name = 'fala.xlsx'): File {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, { type: '' });
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiGetMock.mockResolvedValue({ data: RESOLVE_ROW });
  apiPostMock.mockResolvedValue({ data: ROW });
});

describe('printTemplates api — 五个端点的 URL / method / body 契约', () => {
  it('U1：上传打 POST /print-templates（**无尾斜杠**），multipart 恰好 data + file 两段', async () => {
    await uploadPrintTemplate('9000000000000900', xlsxFile());
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [url, body] = apiPostMock.mock.calls[0]!;
    // ⚠️ 尾斜杠 = 404（后端 nest 把内层 `/` 折叠成 prefix 本身）。这条断言就是防住
    // 「照注释里的表格『修正』成 `/print-templates/`」的那道闸。
    expect(url).toBe('/print-templates');
    expect(url).not.toBe('/print-templates/');

    const form = body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // ⚠️ **恰好两段**：多 append 一个 / 缺一段 / 换个字段名，后端都返 40001。
    const names = [...form.keys()].sort();
    expect(names).toEqual(['data', 'file']);
    // `customer_id` 是**雪花 id 的 JSON 字符串**，不是数字（19 位 id 在 JS Number 下丢精度）。
    expect(JSON.parse(form.get('data') as string)).toEqual({ customer_id: '9000000000000900' });
    const filePart = form.get('file') as File;
    expect(filePart.name).toBe('fala.xlsx');
    // 段 content-type 恒为契约 MIME（绝不用 `file.type` —— 浏览器给 xlsx 的 type 极不稳定）。
    expect(filePart.type).toBe(XLSX_MIME);
    expect(XLSX_MIME).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
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

  it('N2a：uploadPrintTemplate 必须 parse（坏响应照抛，不把坏数据交给调用方）', async () => {
    apiPostMock.mockResolvedValue({ data: { id: 'X' } });
    await expect(uploadPrintTemplate('C1', xlsxFile())).rejects.toThrow();
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
  //   字面量，换反引号 / 双引号就绕过去了；`XLSX_MIME` 真正在不在，靠的是 E1 那条
  //   （断言实际拼进 multipart 的 File 段 content-type）。当「没有第二份字面量副本」的粗筛用。
  it('E2：MIME 字面量在本文件里**没有第二份副本**（后端改判据时它不会报错、只会静默被 21102 挡回）', () => {
    const src = readFileSync(new URL('../printTemplates.ts', import.meta.url), 'utf8');
    // 允许的是从契约模块 import 后的**使用**；不允许的是把字面量抄进来。
    expect(src).not.toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(src).not.toContain("'.xlsx'");
    expect(src).toContain("from '@/views/com/delivery/utils/deliveryNoteTemplateContract'");
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
// V 组：出参形状与后端 `print_template/vo.rs` 逐字对账（2026-10-16 review 第 2 轮 C-1）
// ----------------------------------------------------------------------------
// 为什么这组是本文件的核心：U 组钉的是「打到哪里、发什么」，**出参形状一条都没钉**，
// 而 C-1 的五处不符**全部**在出参形状上。下面每条都对着后端 `vo.rs` 写。
// ============================================================================

describe('V：出参形状与后端 vo.rs 逐字对账（C-1）', () => {
  it('V1：行 VO 必含 kind / content_type / file_type —— 漏一个，`.strict()` 下上传与列表全废', async () => {
    // 后端 `PrintTemplateOut` 逐字给了这三个字段（取值恒定，但类型是必填 string）。
    // ⚠️ 前端一度只声明了 `file_type`，少了 `kind` 与 `content_type` ⇒ 每次 parse 都抛。
    expect(Object.keys(ROW)).toEqual(expect.arrayContaining(['kind', 'file_type', 'content_type']));
    await expect(uploadPrintTemplate('C1', xlsxFile())).resolves.toMatchObject({
      kind: 'DELIVERY_TEMPLATE',
      // ⚠️ `file_type` 是**短码**、`content_type` 才是 MIME —— 两个字段值形态不同不是笔误。
      file_type: 'XLSX',
      content_type: XLSX_MIME,
    });
  });

  it('V2：行 VO 的 customer_name 可为 null（客户软删 / 查不到时后端给 null，不是必填）', async () => {
    apiPostMock.mockResolvedValue({ data: { ...ROW, customer_name: null } });
    await expect(uploadPrintTemplate('C1', xlsxFile())).resolves.toMatchObject({
      customer_name: null,
    });
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