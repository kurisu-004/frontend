// @vitest-environment happy-dom
// src/views/printTemplates/composables/__tests__/usePrintTemplatesStore.spec.ts
//
// 2026-10-16 新增（review 第 1 轮 MAJOR-3 附带的页面级 spec）：模板管理页 store 的守卫。
//
// 为什么必须有它：全仓所有页面级 store 都有 spec（`useInspectionListStore` /
// `useMailAccountsStore` / `usePendingProgrammingStore` …），而本 store 的**核心判据**
// ——「上传前的逐格校验不过就不发请求」—— 此前**一条测试都没有**。它一旦被删掉，坏模板会先
// 落库、再在打印那一刻飘到客户签字的收货凭证上，而集成测试照样全绿。
//
// 覆盖：
//   1. **坏模板零请求**（第一道闸：扩展名；第二道闸：逐格结构）；
//   2. 好模板确实发一次请求、customer_id 传对（否则「零请求」可以是恒真断言）；
//   3. **MAJOR-2：请求失败不得被误报成「模板解析失败」**、也不得污染 `uploadDiffs` ——
//      模板在 mutateAsync 那一刻是校验通过的，把 API 错误文案写进差异面板会把用户引去改
//      Excel 单元格，而真正原因是文件太大 / 无权限 / 版本冲突；
//   4. `total` 透出（不翻页 ⇒ 截断必须可见，见 MINOR-13）；
//   5. 软删的 OCC body 形状（`{version}`，漏传是 axum 422 纯文本、连业务码都拿不到）。
//
// mock 策略：
//   - `vi.mock('@/api/printTemplates')` 用 importOriginal 形态：**只**换掉三个网络函数
//     （upload / delete / fetchContent），`isPrintTemplateXlsxName` 留真实现 —— 它是本
//     store 的第一道闸，用桩就等于把被测判据也桩掉了。
//   - `vi.mock('element-plus')` 只桩 ElMessage（node/happy-dom 下真实 ElMessage 走
//     normalizeAppendTo）。
//   - `vi.mock('@/utils/download')`：happy-dom 没有真实下载。
//   - hucre 与 `assertTemplateMatches` **走真实现**，坏模板用真 xlsx（改一格）造 —— 与
//     打印对话框那份 spec 同一手法（照抄会让「校验不过」变成一个和实现无关的假输入）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type * as PrintTemplateApi from '@/api/printTemplates';

const { uploadMock, deleteMock, fetchContentMock, listMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  deleteMock: vi.fn(),
  fetchContentMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock('@/api/printTemplates', async (importOriginal) => {
  const actual = await importOriginal<typeof PrintTemplateApi>();
  return {
    ...actual,
    deletePrintTemplate: (...args: unknown[]) => deleteMock(...args),
    fetchPrintTemplateContent: (...args: unknown[]) => fetchContentMock(...args),
    listPrintTemplates: (...args: unknown[]) => listMock(...args),
  };
});

// 2026-10-15：上传从 `uploadPrintTemplate(customerId, file)`（multipart 代理）改成直传
// 引擎 `directUpload({ ownerKind, ownerId, kind, file })`。下面这层 shim 把对象入参摊回
// 旧的位置参数 ⇒ 各条用例的「customer_id 透传 / 文件名」断言逐字保留。
vi.mock('@/utils/directUpload', () => ({
  directUpload: (o: { ownerKind: string; ownerId: string; kind: string; file: File }) =>
    uploadMock(o.ownerId, o.file, o),
}));

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/utils/download', () => ({
  triggerBrowserDownload: vi.fn(),
}));

import { usePrintTemplatesStore } from '../usePrintTemplatesStore';
import type { PrintTemplateData } from '../../printTemplateSchema';

const { ElMessage } = await import('element-plus');

/** 内置送货单模板（逐格校验通过的那一份）的字节。 */
const BUILTIN = readFileSync('templates/delivery_note_fala.xlsx');

/** 内置检具版模板（百路达）字节 —— 第二套版式，判据见 deliveryNoteTemplateContract.ts。 */
const BUILTIN_GAUGE = readFileSync('templates/delivery_note_gauge_bailuda.xlsx');

/** 精确长度的 ArrayBuffer（不能用 `BUILTIN.buffer`：那是 node 8MB 池化缓冲的整段）。 */
function exactBuffer(src: Uint8Array): ArrayBuffer {
  const exact = new Uint8Array(src.byteLength);
  exact.set(src);
  return exact.buffer as ArrayBuffer;
}

function builtinArrayBuffer(): ArrayBuffer {
  return exactBuffer(BUILTIN);
}

function builtinFile(name = 'delivery_note_fala.xlsx'): File {
  return new File([builtinArrayBuffer()], name, { type: '' });
}

/** 检具版模板文件（百路达那份），走磁盘原件。 */
function gaugeFile(name = 'delivery_note_gauge_bailuda.xlsx'): File {
  return new File([exactBuffer(BUILTIN_GAUGE)], name, { type: '' });
}

/** 改坏 C3（列位错位）的模板：走 hucre 真实 round-trip，产出的字节是真 xlsx。 */
async function brokenTemplateFile(): Promise<File> {
  const { openXlsx, saveXlsx } = await import('hucre');
  const wb = await openXlsx(new Uint8Array(BUILTIN));
  wb.sheets[0]!.rows[2]![2] = '{{L2_customer}}';
  const bytes = await saveXlsx(wb);
  return new File([exactBuffer(bytes)], 'broken.xlsx', { type: '' });
}

/**
 * 判不出**任何**一套版式的模板：把探测用的四个锚点格全抹掉（B3 / B5 / F15 / I2），
 * 走 hucre 真实 round-trip。它仍是一份合法的 xlsx —— 后端只认「是 ZIP」，这就是必须在前端
 * 拦住的那类文件（拒收理由见 store 的 `uploadChecked`）。
 */
async function unrecognizableTemplateFile(): Promise<File> {
  const { openXlsx, saveXlsx } = await import('hucre');
  const wb = await openXlsx(new Uint8Array(BUILTIN));
  const sheet = wb.sheets[0]!;
  sheet.rows[2]![1] = '';
  sheet.rows[4]![1] = '';
  sheet.rows[14]![5] = '';
  sheet.rows[1]![8] = '';
  const bytes = await saveXlsx(wb);
  return new File([exactBuffer(bytes)], 'unknown-layout.xlsx', { type: '' });
}

/**
 * 一条逐字合法的列表行（后端 `PrintTemplateOut` 12 字段）。
 *
 * ⚠️ 2026-10-16 review 第 2 轮 C-1：`kind` / `content_type` 两个字段原先漏了
 * （后端真给的），且 `file_type` 填成了 MIME —— 真实取值是**短码 `XLSX`**，
 * xlsx 的规范 MIME 在另一个字段 `content_type` 上。
 */
function row(over: Partial<PrintTemplateData> = {}): PrintTemplateData {
  return {
    id: 'T1',
    customer_id: 'C1',
    kind: 'DELIVERY_TEMPLATE',
    file_type: 'XLSX',
    original_filename: 'fala.xlsx',
    file_size: 12345,
    content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content_sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    version: 3,
    created_at: '2026-10-16 09:00:00',
    updated_at: '2026-10-16 09:30:00',
    customer_name: '法拉电子',
    ...over,
  };
}

function setupApp(): void {
  const app = createApp({});
  app.use(createPinia());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  app.use(VueQueryPlugin, { queryClient });
  setActivePinia(app.config.globalProperties.$pinia);
}

/** 等 useQuery 的 scheduler 跑过一轮。 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

function errorCalls(): unknown[][] {
  return (ElMessage.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupApp();
  uploadMock.mockResolvedValue(row());
  deleteMock.mockResolvedValue(undefined);
  listMock.mockResolvedValue({ items: [row()], total: 1 });
});

describe('usePrintTemplatesStore 上传前的两道闸（核心判据）', () => {
  it('G1：扩展名不是 .xlsx ⇒ **零请求** + 差异面板给出格式提示', async () => {
    const store = usePrintTemplatesStore();
    const ok = await store.upload.run(new File([new Uint8Array([1])], '模板.xls'), 'C1');

    expect(ok).toBe(false);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(store.upload.diffs.length).toBe(1);
    expect(store.upload.diffs[0]).toContain('.xlsx');
    expect(store.upload.busy).toBe(false);
  });

  it('G2：逐格校验不过（列位错位）⇒ **零请求** + 差异原文逐条上屏', async () => {
    const store = usePrintTemplatesStore();
    const ok = await store.upload.run(await brokenTemplateFile(), 'C1');

    expect(ok).toBe(false);
    // ⚠️ 这条就是全文件存在的理由：坏模板若先落库，打印对话框会把它自动选用 ⇒ 导出的送货单
    // 在客户签字那页就是废纸，而所有其它测试照样全绿。
    expect(uploadMock).not.toHaveBeenCalled();
    expect(store.upload.diffs.join('；')).toContain('{{l2_customer}}');
    expect(store.upload.busy).toBe(false);
  });

  // 2026-10-15：ZIP magic 校验是**新增**的一道闸（职责从后端 confirm 端点移交过来
  // —— 直传链路的后端拿不到字节）。它排在逐格校验之前，因为它只要读 4 个字节。
  it('G3a：文件头不是 ZIP（改了后缀名的 .txt）⇒ **零请求** + 说清原因', async () => {
    const store = usePrintTemplatesStore();
    const ok = await store.upload.run(
      new File([new Uint8Array([1, 2, 3, 4, 5])], 'not-a-zip.xlsx'),
      'C1',
    );

    expect(ok).toBe(false);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(store.upload.diffs.join('；')).toContain('不是 ZIP');
    expect(String(errorCalls()[0]![0])).toContain('文件头');
  });

  it('G3b：是 ZIP 但内部解不开（不是 xlsx）⇒ **零请求** + 报「模板解析失败」', async () => {
    const store = usePrintTemplatesStore();
    // 合法 ZIP 头 + 垃圾字节：过得了 magic 闸，过不了 hucre 解包 / 版式探测。
    const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const ok = await store.upload.run(new File([zipHead], 'broken.xlsx'), 'C1');

    expect(ok).toBe(false);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(store.upload.diffs.join('；')).toContain('模板');
  });

  it('G4：校验通过 ⇒ 发**恰好一次**请求，customer_id 透传（G1/G2 的「零请求」不是恒真断言）', async () => {
    const store = usePrintTemplatesStore();
    const ok = await store.upload.run(builtinFile(), 'C1');

    expect(ok).toBe(true);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0]![0]).toBe('C1');
    expect((uploadMock.mock.calls[0]![1] as File).name).toBe('delivery_note_fala.xlsx');
    // 2026-10-15：owner 是**一级客户**（不是零件 / 装配件），kind 恒为 DELIVERY_TEMPLATE。
    const opts = uploadMock.mock.calls[0]![2] as { ownerKind: string; kind: string };
    expect(opts.ownerKind).toBe('CUSTOMER');
    expect(opts.kind).toBe('DELIVERY_TEMPLATE');
    expect(store.upload.diffs).toEqual([]);
    expect(store.upload.busy).toBe(false);
  });

  it('G5：检具版模板（百路达）⇒ 校验通过、发恰好一次请求（版式不是零件版就不能被拒）', async () => {
    // ⚠️ 这条守的是「上传闸先探版式、再按该版式逐格校验」：探测结果若是零件版，
    // 检具模板会在 C5 / I2 上报出几十条差异、被永远拒收（管理员永远传不进检具模板）。
    const store = usePrintTemplatesStore();
    const ok = await store.upload.run(gaugeFile(), 'C1');

    expect(ok).toBe(true);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(store.upload.diffs).toEqual([]);
    expect(errorCalls()).toHaveLength(0);
  });

  it('G6：判不出版式的模板 ⇒ **零请求** + 提示说清「两套版式都不匹配」', async () => {
    // 后端 `kind` 恒是 `DELIVERY_TEMPLATE`、不带版式信息 ⇒ 「是哪一套版式」只能由前端探测；
    // 探测不出来就没有「该按哪套判据校验」这回事，只能拒收并把理由说全。
    const store = usePrintTemplatesStore();
    const ok = await store.upload.run(await unrecognizableTemplateFile(), 'C1');

    expect(ok).toBe(false);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(store.upload.diffs.join('；')).toContain('既不匹配零件版');
    expect(store.upload.diffs.join('；')).toContain('检具版');
    expect(String(errorCalls()[0]![0])).toContain('版式');
    expect(store.upload.busy).toBe(false);
  });
});

describe('usePrintTemplatesStore 上传失败归因（2026-10-16 review 第 1 轮 MAJOR-2）', () => {
  it('E1：请求失败（21103 超限）⇒ 回落 false、差异面板**保持空**、只弹那一次后端文案', async () => {
    uploadMock.mockRejectedValue(Object.assign(new Error('文件超过大小上限'), { code: 21103 }));
    const store = usePrintTemplatesStore();
    const ok = await store.upload.run(builtinFile(), 'C1');

    expect(ok).toBe(false);
    // ⚠️ 模板在请求那一刻是**校验通过**的。把 API 错误文案写进 uploadDiffs 会让
    // `PrintTemplateList.vue` 的 el-alert 渲染成「模板校验未通过，共 1 处差异」⇒ 用户去改
    // Excel 单元格，而真正原因是文件太大。
    expect(store.upload.diffs).toEqual([]);
    // 只有 mutation 的 onError 那一次提示，且文案是**后端**给的，不是「模板解析失败」。
    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0]![0]).toBe('文件超过大小上限');
    expect(String(errorCalls()[0]![0])).not.toContain('模板解析失败');
  });

  it('E2：请求失败不往页面壳抛 rejection（`await store.upload.run(...)` 照常 resolve）', async () => {
    uploadMock.mockRejectedValue(Object.assign(new Error('版本冲突'), { code: 40901 }));
    const store = usePrintTemplatesStore();
    // 页面壳是 `await store.upload.run(...)`；让 reject 冒出去就是未捕获的 rejection。
    await expect(store.upload.run(builtinFile(), 'C1')).resolves.toBe(false);
    expect(store.upload.busy).toBe(false);
  });

  it('E3：解析失败与请求失败走**不同**文案（两条路径各弹各的，不互相污染）', async () => {
    const store = usePrintTemplatesStore();
    // ZIP magic 过、逐格校验解析不过 —— 这才走「模板解析失败」那一支。
    const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await store.upload.run(new File([zipHead], 'x.xlsx'), 'C1');
    expect(String(errorCalls()[0]![0])).not.toContain('无权限');

    vi.clearAllMocks();
    uploadMock.mockRejectedValue(Object.assign(new Error('无权限'), { code: 40300 }));
    await store.upload.run(builtinFile(), 'C1');
    expect(String(errorCalls()[0]![0])).toContain('无权限');
  });
});

describe('usePrintTemplatesStore 列表与软删', () => {
  it('L1：`total` 透出（不翻页 ⇒ 后端 clamp 截断必须看得见，见 MINOR-13）', async () => {
    listMock.mockResolvedValue({ items: [row()], total: 7 });
    const store = usePrintTemplatesStore();
    store.query.openGate();
    await tick();

    expect(store.query.rows).toHaveLength(1);
    // ⚠️ `total > rows.length` 只可能是被 clamp 截断了 —— 那正是工具栏要显示 total 的理由。
    expect(store.query.total).toBe(7);
  });

  it('L2：软删收**整行**并从行上取 version 当 OCC 锚（漏传是 axum 422 纯文本）', async () => {
    const store = usePrintTemplatesStore();
    await store.actions.remove(row({ id: 'T9', version: 12 }));

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock.mock.calls[0]![0]).toBe('T9');
    expect(deleteMock.mock.calls[0]![1]).toEqual({ version: 12 });
    expect(store.actions.deletingRowId).toBeNull();
  });

  it('L3：软删失败不抛（错误已由 onError 提示），且仍按行复位 loading', async () => {
    deleteMock.mockRejectedValue(Object.assign(new Error('模板不存在'), { code: 21101 }));
    const store = usePrintTemplatesStore();
    await expect(store.actions.remove(row())).resolves.toBeUndefined();
    expect(store.actions.deletingRowId).toBeNull();
    expect(errorCalls()).toHaveLength(1);
  });
});
