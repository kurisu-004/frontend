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
// mock 手法：`vi.mock('@/api/http')` 只换掉 `api.get` / `api.post`（`cleanParams` /
// `normalizeListResult` 走真实现，否则「空值不上 wire」那条断言是在验副本）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type * as HttpModule from '@/api/http';

// ⚠️ `vi.mock` 的 factory 会被 hoist 到文件顶部 ⇒ 桩变量必须走 `vi.hoisted`，
// 否则这里就是 `Cannot access 'apiGetMock' before initialization`（mailAccounts 那份
// 用的是 `vi.fn` 直接声明 + 全模块桩，本文件要保留 `cleanParams` / `normalizeListResult`
// 的真实现，只能用 importOriginal 形态，也就必须 hoisted）。
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

/** 一条**逐字合法**的 `PrintTemplateOut`（10 字段；`.strict()` ⇒ 多一个键即抛）。 */
const ROW = {
  id: '9000000000000701',
  customer_id: '9000000000000900',
  customer_name: '法拉电子',
  original_filename: 'fala.xlsx',
  file_size: 12345,
  file_type: XLSX_MIME,
  content_sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  version: 2,
  created_at: '2026-10-16 09:00:00',
  updated_at: '2026-10-16 09:30:00',
} as const;

/** 一条**逐字合法**的 `PrintTemplateResolveOut`（8 字段，**不带** `file_type` / `created_at`）。 */
const RESOLVE_ROW = {
  id: ROW.id,
  customer_id: ROW.customer_id,
  customer_name: ROW.customer_name,
  original_filename: ROW.original_filename,
  file_size: ROW.file_size,
  content_sha256: ROW.content_sha256,
  version: ROW.version,
  updated_at: ROW.updated_at,
  content_url: `/print-templates/${ROW.id}/content`,
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
  it('N1：listPrintTemplates 不 parse，坏响应不抛（只经 normalizeListResult 整形计数）', async () => {
    // 真在 api 层挂过 parse 时这里必然抛 ZodError —— 这条是 N1 的行为侧镜像。
    // 注意断言的形态：`items` 原样透传（`undefined`）、三个计数被 `Number(undefined)` 变成
    // NaN，但**不抛**。守门在 queryFn（`usePrintTemplateListQuery`），不在这里。
    apiGetMock.mockResolvedValue({ data: { definitely_not_a_list: true } });
    await expect(listPrintTemplates()).resolves.toEqual({
      items: undefined,
      total: NaN,
      limit: NaN,
      offset: NaN,
    });
  });

  it('N1b：listPrintTemplates 的三个分页计数仍经 normalizeListResult 归一成 number', async () => {
    // 后端各域 list 端点的分页字段类型不统一（有的 serialize_i64 给 string）。这一层归一是
    // api 层该做的事，与「要不要 parse」是两个独立问题。
    apiGetMock.mockResolvedValue({ data: { items: [], total: '7', limit: '200', offset: '0' } });
    await expect(listPrintTemplates()).resolves.toEqual({
      items: [],
      total: 7,
      limit: 200,
      offset: 0,
    });
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

  it('N2c：resolve 出参多一个后端新加的字段时**不抛**（读侧不 `.strict()`，否则全站自动选型静默失效）', async () => {
    apiGetMock.mockResolvedValue({ data: { ...RESOLVE_ROW, some_new_field: 'x' } });
    const out = await resolvePrintTemplate('C1');
    expect(out.id).toBe(RESOLVE_ROW.id);
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
    const src = readFileSync(new URL('../printTemplates.ts', import.meta.url), 'utf8');
    const match = src.match(
      /import\s+(type\s+)?\{[^}]*\}\s*from\s*'@\/views\/printTemplates\/printTemplateSchema'/s,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('type ');
  });
});