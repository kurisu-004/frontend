// 2026-10-03 新增：usePartBatchPdf composable 单测（此前零覆盖）。
// 模式参考同目录 usePartBatchManual.spec.ts：harness 组件 + 模块 mock。
//
// 本 spec 锁的是「Excel 数据回填」这条链路的业务口径（缺陷 B）：
//   - 装配件顶层按**装配件自身图号**命中 Excel → 分厂 / 申请人 / 整套数量 / 计划交期；
//   - 子件**只**共享计划交期，数量保持 1、单价 / 总价保持 null（业务口径：Excel 里的
//     数量和单价是整套的；子件数量手填、子件不需要单价）；
//   - 独立零件（单页 PDF）维持原状：数量 / 单价 / 总价 / 交期 / 分厂 / 申请人全回填；
//   - Excel 解析结果活过 rebuildFromUploads（合并不再是无源之水）；
//   - splitStandalonePart 把多页拆回子页时**不**回填，且之后再建行也不会被回填
//     （子页不该吃整套数量 / 单价）；
//   - 4 个建行入口（合并成零件 / 合并成装配件 / 手动新增零件 / 手动新增装配件）
//     都回填，但**只作用于本次新建的行** —— 再建一行不得撤销其它行上用户的手改值。
//     这条约束**同集合与跨集合都要锁**：建装配件不得重刷独立零件表，建零件不得重刷
//     装配件表（独立的 describe 见下方「跨集合作用域」）。
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ============ 模块 mock ============

const mocks = vi.hoisted(() => ({
  /** countPdfPages 的返回值，按用例需要改（1 / 2 / 3 页）。 */
  pageCount: 1,
  routerPush: vi.fn(),
}));

// 冻结「今天」，让 readExcel 内部 todayIso() 推出的计划交期可断言（否则跨天 flaky）。
// 只桩掉 todayIso，makeUid / pageUid / parsePageUid / stripExt 保持真实实现
// （selectedPages 的 key 格式依赖 pageUid）。
const TODAY = '2026-10-03';
vi.mock('../composables/usePartBatchShared', async (importOriginal) => {
  const actual = await importOriginal<typeof PartBatchSharedNS>();
  return { ...actual, todayIso: () => TODAY };
});

vi.mock('@/utils/pdfjs', () => ({
  countPdfPages: async () => mocks.pageCount,
}));

// pdf-lib 只被 mergePages（部分页合并成独立零件）用到；用最小假实现代替，
// 免去在单测里造真实 PDF 字节。
vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: async () => ({}),
    create: async () => ({
      copyPages: async () => [{}, {}],
      addPage: () => undefined,
      save: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }),
  },
}));

// 2026-10-04：Tab 2 改成「建工单 + 逐 part 后置上传」，composable 从 @/api/parts
// 导入 batchCreateParts / uploadPartDrawing / uploadPart3DModel 三个导出 —— mock 必须
// 覆盖全部被 import 的导出，否则模块解析失败。
vi.mock('@/api/parts', () => ({
  batchCreateParts: vi.fn(),
  uploadPartDrawing: vi.fn(),
  uploadPart3DModel: vi.fn(),
}));

vi.mock('@/views/parts/new/composables/usePartsNewDraft', () => ({
  usePartsNewDraft: () => ({
    userId: 'u-test',
    load: () => null,
    save: () => undefined,
    clear: () => undefined,
    saver: { schedule: () => undefined, cancel: () => undefined, flush: () => undefined },
  }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerPush }),
  useRoute: () => ({ path: '/parts/new', query: {} }),
}));

// node / happy-dom 下真实 ElMessage 会在 document 缺失时抛错污染输出，桩成 no-op。
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn(), alert: vi.fn() },
}));

// 静态导入（必须在 vi.mock 之后）
import { usePartBatchPdf } from '../composables/usePartBatchPdf';
import type { UsePartBatchPdfReturn } from '../composables/usePartBatchPdf';
import type { Customer } from '@/api/customer';
import type { UploadFile } from 'element-plus';
// 类型命名空间导入（编译期擦除，放在 vi.mock 之后不影响 hoist），
// 供上面 importOriginal<typeof …> 泛型用 —— eslint 禁内联 `typeof import('…')` 写法。
import type * as PartBatchSharedNS from '../composables/usePartBatchShared';

// ============ fixtures ============

// happy-dom 环境下 import.meta.url 不是 file: 协议，fileURLToPath 会抛
// "The URL must be of scheme file"；vitest 的 cwd 即项目根，故按 cwd 拼路径。
const FIXTURE_PATH = join(process.cwd(), 'src/utils/__tests__/__fixtures__/历史价确认单 (1).xlsx');

/** fixture 里的 5 行（today=2026-10-03 时解析结果）里本 spec 用到的两条。 */
const EXCEL_ROW_PART = {
  drawingNo: 'E42DMMET45007101',
  deptName: '镀膜厂',
  applicantName: '程胜志',
  quantity: 3,
  unitPrice: 160,
  totalPrice: 480,
  deliveryDays: 14,
};
const EXCEL_ROW_ASM = {
  drawingNo: 'E42HJWLD10012101',
  deptName: '六厂',
  applicantName: '谢岩国',
  quantity: 2,
  unitPrice: 130,
  totalPrice: 260,
  deliveryDays: 14,
};

/** PDF 文件名按「图号_名称.pdf」约定（parseDrawingFilename 只切首个 `_`），
 *  刻意让图号与 fixture 里的 Excel 行对上，才能验证回填命中。 */
const ASM_PDF = `${EXCEL_ROW_ASM.drawingNo}_扁条收框档条.pdf`;
const PART_PDF = `${EXCEL_ROW_PART.drawingNo}_断路器开关链接头.pdf`;

/** ISO 日期加天数（避免把「今天 + 14」硬编码成具体日期）。 */
function plusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function customer(id: string, name: string, parentId: string | null): Customer {
  return {
    id,
    name,
    parent_id: parentId,
    parent_name: null,
    serial_prefix: null,
    version: 1,
    created_at: '',
    updated_at: '',
  };
}

/** L1 = 测试集团；其下挂 fixture 用到的 3 个分厂。 */
const customers = ref<Customer[]>([
  customer('c-root', '测试集团', null),
  customer('c-duqi', '镀膜厂', 'c-root'),
  customer('c-liuchang', '六厂', 'c-root'),
  customer('c-bachang', '八厂', 'c-root'),
]);

// ============ harness ============

let captured: UsePartBatchPdfReturn | null = null;
const Harness = defineComponent({
  setup() {
    captured = usePartBatchPdf({
      customers,
      applicantSearch: {
        applicants: ref([]),
        loading: ref(false),
        loadForCustomer: async () => undefined,
        querySearch: () => undefined,
      },
      successNextTab: ref('manual'),
    });
    return () => h('div', { class: 'harness' });
  },
});

function harnessMount() {
  return mount(Harness);
}

/** 最小合法 PDF 字节（`%PDF`），只用于让上传链路拿到一个 File 实例。 */
function pdfFile(name: string): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });
}

/** 组一个 el-upload 的 UploadFile（只需 uid / name / raw）。 */
function uploadFile(uid: number, name: string): UploadFile {
  return { uid, name, status: 'success', raw: pdfFile(name) } as unknown as UploadFile;
}

/** 真实 fixture 的历史价确认单，作为 excelFiles 的 raw。 */
function excelUploadFile(): UploadFile {
  const buf = readFileSync(FIXTURE_PATH);
  const raw = new File([new Uint8Array(buf)], '历史价确认单 (1).xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return {
    uid: 2001,
    name: '历史价确认单 (1).xlsx',
    status: 'success',
    raw,
  } as unknown as UploadFile;
}

/** 走完「选 L1 + 传 PDF(+Excel) + 解析」的公共前置。
 *  上传的 PDF 固定 uid=1001（对应解析后的 pdfSourceUid = 'pdf-1001'）。 */
async function setup(
  api: UsePartBatchPdfReturn,
  opts: { pdfName: string; withExcel: boolean },
): Promise<void> {
  api.pdfForm.customerL1Id = 'c-root';
  api.pdfFiles.value = [uploadFile(1001, opts.pdfName)];
  if (opts.withExcel) api.excelFiles.value = [excelUploadFile()];
  await api.rebuildFromUploads();
}

/** 同 `setup`，但一次传多个 PDF（uid 从 1001 递增 → 解析后是 `pdf-1001` / `pdf-1002`…）。 */
async function setupMany(
  api: UsePartBatchPdfReturn,
  opts: { pdfNames: string[]; withExcel: boolean },
): Promise<void> {
  api.pdfForm.customerL1Id = 'c-root';
  api.pdfFiles.value = opts.pdfNames.map((n, i) => uploadFile(1001 + i, n));
  if (opts.withExcel) api.excelFiles.value = [excelUploadFile()];
  await api.rebuildFromUploads();
}

/** 勾选某个 PDF 的前 n 页。 */
function selectPages(api: UsePartBatchPdfReturn, pdfUid: string, n: number): void {
  const keys = Array.from({ length: n }, (_, i) => `${pdfUid}:${i}`);
  api.selectedPages.value = new Set(keys);
}

function need(): UsePartBatchPdfReturn {
  if (!captured) throw new Error('composable 未捕获');
  return captured;
}

beforeEach(() => {
  mocks.pageCount = 1;
});

// ============ tests ============

describe('usePartBatchPdf：Excel 回填（业务口径：整套 vs 子件）', () => {
  it('mergeSelectedAsAssembly：顶层按装配件自身图号命中 Excel（分厂 / 申请人 / 整套数量 / 计划交期）', async () => {
    mocks.pageCount = 2;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setup(api, { pdfName: ASM_PDF, withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsAssembly();

    const asm = api.assemblies.value[0];
    expect(asm).toBeDefined();
    if (!asm) return;
    expect(asm.drawing_no).toBe(EXCEL_ROW_ASM.drawingNo);
    expect(asm.customer_id).toBe('c-liuchang');
    expect(asm.customer_name).toBe(EXCEL_ROW_ASM.deptName);
    expect(asm.applicant_name).toBe(EXCEL_ROW_ASM.applicantName);
    // 数量 = 整套数量（不是默认 1）
    expect(asm.quantity).toBe(EXCEL_ROW_ASM.quantity);
    expect(asm.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_ASM.deliveryDays));
    // is_urgent 维持现状：绝不从 Excel 继承（2026-07-30 决策）
    expect(asm.is_urgent).toBe(false);

    w.unmount();
  });

  it('mergeSelectedAsAssembly：子件只共享计划交期，数量仍为 1、单价 / 总价仍为 null', async () => {
    mocks.pageCount = 2;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setup(api, { pdfName: ASM_PDF, withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsAssembly();

    const asm = api.assemblies.value[0];
    if (!asm) throw new Error('未生成装配件');
    expect(asm.children).toHaveLength(2);
    for (const c of asm.children) {
      expect(c.planned_delivery_date).toBe(asm.planned_delivery_date);
      expect(c.quantity).toBe(1);
      expect(c.unit_price).toBeNull();
      expect(c.total_price).toBeNull();
      expect(c.is_urgent).toBe(false);
    }

    w.unmount();
  });

  it('mergeSelectedAsPart：新建独立零件行的数量 / 单价 / 总价 / 分厂 / 申请人全部命中 Excel', async () => {
    // 3 页 PDF 只勾 2 页 → 走部分页合并分支（pdf-lib 已被桩掉）
    mocks.pageCount = 3;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setup(api, { pdfName: PART_PDF, withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsPart();

    const row = api.standaloneParts.value[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.drawing_no).toBe(EXCEL_ROW_PART.drawingNo);
    expect(row.quantity).toBe(EXCEL_ROW_PART.quantity);
    expect(row.unit_price).toBe(EXCEL_ROW_PART.unitPrice);
    expect(row.total_price).toBe(EXCEL_ROW_PART.totalPrice);
    expect(row.customer_id).toBe('c-duqi');
    expect(row.customer_name).toBe(EXCEL_ROW_PART.deptName);
    expect(row.applicant_name).toBe(EXCEL_ROW_PART.applicantName);
    expect(row.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_PART.deliveryDays));
    expect(row.is_urgent).toBe(false);

    w.unmount();
  });

  it('未上传 Excel：mergeSelectedAsAssembly 不抛错，且新行分厂仍为空', async () => {
    mocks.pageCount = 2;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setup(api, { pdfName: ASM_PDF, withExcel: false });
    selectPages(api, 'pdf-1001', 2);
    await expect(api.mergeSelectedAsAssembly()).resolves.toBeUndefined();

    const asm = api.assemblies.value[0];
    if (!asm) throw new Error('未生成装配件');
    expect(asm.customer_id).toBe('');
    expect(asm.applicant_name).toBe('');
    expect(asm.quantity).toBe(1);
    expect(asm.planned_delivery_date).toBe('');
    for (const c of asm.children) expect(c.planned_delivery_date).toBe('');

    w.unmount();
  });

  it('splitStandalonePart 拆出的子页不继承整套数量 / 单价，且后续再建行也不会被回填', async () => {
    mocks.pageCount = 3;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    // 两个 3 页 PDF：先合并前者 2 页 → 拆分，再拿后者合并一次（验证跨动作不回填）
    await setupMany(api, { pdfNames: [PART_PDF, ASM_PDF], withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsPart();
    const merged = api.standaloneParts.value[0];
    if (!merged) throw new Error('未生成独立零件行');
    expect(merged.quantity).toBe(EXCEL_ROW_PART.quantity);

    api.splitStandalonePart(merged);

    // 快照（不是数组引用本身）：下面的建行会往同一个数组 push 新行
    const splitRows = [...api.standaloneParts.value];
    expect(splitRows).toHaveLength(2);
    for (const r of splitRows) {
      expect(r.quantity).toBe(1);
      expect(r.unit_price).toBeNull();
      expect(r.total_price).toBeNull();
      expect(r.planned_delivery_date).toBe('');
      expect(r.customer_id).toBe('');
    }
    // 拆出的第 0 页图号恰好等于 Excel 的物料编号 —— 若回填是「全表重扫」，
    // 下面这次建行就会把它改成整套数量 / 单价。故必须再触发一次建行来锁死。
    expect(splitRows[0]?.drawing_no).toBe(EXCEL_ROW_PART.drawingNo);

    selectPages(api, 'pdf-1002', 2);
    await api.mergeSelectedAsPart();

    expect(api.standaloneParts.value).toHaveLength(3);
    for (const r of splitRows) {
      expect(r.quantity).toBe(1);
      expect(r.unit_price).toBeNull();
      expect(r.total_price).toBeNull();
      expect(r.planned_delivery_date).toBe('');
      expect(r.customer_id).toBe('');
    }
    // 新行该回填的照常回填（证明不是把回填整体关掉了）
    const fresh = api.standaloneParts.value[2];
    if (!fresh) throw new Error('未生成第三行');
    expect(fresh.quantity).toBe(EXCEL_ROW_ASM.quantity);
    expect(fresh.unit_price).toBe(EXCEL_ROW_ASM.unitPrice);

    w.unmount();
  });

  it('回填只作用于本次新建的行：再合并一次不会撤销既有独立行上的手改值', async () => {
    mocks.pageCount = 1;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setupMany(api, { pdfNames: [PART_PDF, ASM_PDF], withExcel: true });
    selectPages(api, 'pdf-1001', 1);
    await api.mergeSelectedAsPart();
    const edited = api.standaloneParts.value[0];
    if (!edited) throw new Error('未生成独立零件行');
    // 先确认它确实被 Excel 回填过，否则下面「保持不变」是空断言
    expect(edited.quantity).toBe(EXCEL_ROW_PART.quantity);
    expect(edited.applicant_name).toBe(EXCEL_ROW_PART.applicantName);

    // 用户手改：数量 / 单价 / 总价 / 交期 / 申请人
    edited.quantity = 99;
    edited.unit_price = 999;
    edited.total_price = 999 * 99;
    edited.planned_delivery_date = '2030-01-01';
    edited.applicant_name = '张三';

    selectPages(api, 'pdf-1002', 1);
    await api.mergeSelectedAsPart();

    expect(edited.quantity).toBe(99);
    expect(edited.unit_price).toBe(999);
    expect(edited.total_price).toBe(999 * 99);
    expect(edited.planned_delivery_date).toBe('2030-01-01');
    expect(edited.applicant_name).toBe('张三');
    // 而本次新建的行该回填的仍然回填了
    const fresh = api.standaloneParts.value[1];
    if (!fresh) throw new Error('未生成第二行');
    expect(fresh.quantity).toBe(EXCEL_ROW_ASM.quantity);
    expect(fresh.unit_price).toBe(EXCEL_ROW_ASM.unitPrice);
    expect(fresh.applicant_name).toBe(EXCEL_ROW_ASM.applicantName);

    w.unmount();
  });

  it('回填只作用于本次新建的行：再合并一次装配件不会撤销既有装配件上的手改值', async () => {
    mocks.pageCount = 2;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setupMany(api, { pdfNames: [ASM_PDF, PART_PDF], withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsAssembly();
    const edited = api.assemblies.value[0];
    if (!edited) throw new Error('未生成装配件');
    expect(edited.quantity).toBe(EXCEL_ROW_ASM.quantity);

    // 用户手改顶层数量 / 交期 / 申请人，并单独改一个子件的交期
    edited.quantity = 99;
    edited.planned_delivery_date = '2030-01-01';
    edited.applicant_name = '张三';
    const firstChild = edited.children[0];
    if (!firstChild) throw new Error('未生成子件');
    firstChild.planned_delivery_date = '2030-02-02';

    selectPages(api, 'pdf-1002', 2);
    await api.mergeSelectedAsAssembly();

    expect(edited.quantity).toBe(99);
    expect(edited.planned_delivery_date).toBe('2030-01-01');
    expect(edited.applicant_name).toBe('张三');
    expect(firstChild.planned_delivery_date).toBe('2030-02-02');
    // 本次新建的装配件照常回填，且子件交期与顶层一致
    const fresh = api.assemblies.value[1];
    if (!fresh) throw new Error('未生成第二个装配件');
    expect(fresh.quantity).toBe(EXCEL_ROW_PART.quantity);
    expect(fresh.customer_id).toBe('c-duqi');
    for (const c of fresh.children) {
      expect(c.planned_delivery_date).toBe(fresh.planned_delivery_date);
      expect(c.quantity).toBe(1);
      expect(c.unit_price).toBeNull();
    }

    w.unmount();
  });

  it('confirmManualPart：手动新增的零件同样走 Excel 回填', async () => {
    // 2 页 PDF 不预生成任何行 → 表内为空，手动新增是唯一的行来源
    mocks.pageCount = 2;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setup(api, { pdfName: ASM_PDF, withExcel: true });
    expect(api.standaloneParts.value).toHaveLength(0);

    api.manualPartForm.drawing_no = EXCEL_ROW_PART.drawingNo;
    api.manualPartForm.name = '断路器开关链接头';
    api.manualPartForm.file = pdfFile('manual-part.pdf');
    await api.confirmManualPart();

    const row = api.standaloneParts.value[0];
    if (!row) throw new Error('未生成手动零件行');
    expect(row.customer_id).toBe('c-duqi');
    expect(row.applicant_name).toBe(EXCEL_ROW_PART.applicantName);
    expect(row.quantity).toBe(EXCEL_ROW_PART.quantity);
    expect(row.unit_price).toBe(EXCEL_ROW_PART.unitPrice);
    expect(row.total_price).toBe(EXCEL_ROW_PART.totalPrice);
    expect(row.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_PART.deliveryDays));
    expect(row.is_urgent).toBe(false);

    w.unmount();
  });

  it('confirmManualAssembly：手动新增的装配件顶层回填、子件只共享交期', async () => {
    mocks.pageCount = 2;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setup(api, { pdfName: ASM_PDF, withExcel: true });
    expect(api.assemblies.value).toHaveLength(0);

    api.manualAsmForm.drawing_no = EXCEL_ROW_ASM.drawingNo;
    api.manualAsmForm.name = '扁条收框档条';
    api.manualAsmForm.file = pdfFile('manual-asm.pdf');
    await api.confirmManualAssembly();

    const asm = api.assemblies.value[0];
    if (!asm) throw new Error('未生成手动装配件');
    expect(asm.drawing_no).toBe(EXCEL_ROW_ASM.drawingNo);
    expect(asm.customer_id).toBe('c-liuchang');
    expect(asm.applicant_name).toBe(EXCEL_ROW_ASM.applicantName);
    expect(asm.quantity).toBe(EXCEL_ROW_ASM.quantity);
    expect(asm.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_ASM.deliveryDays));
    expect(asm.children).toHaveLength(2);
    for (const c of asm.children) {
      expect(c.planned_delivery_date).toBe(asm.planned_delivery_date);
      expect(c.quantity).toBe(1);
      expect(c.unit_price).toBeNull();
      expect(c.total_price).toBeNull();
    }

    w.unmount();
  });
});

// ============ 跨集合作用域回归（2026-10-03 review 第 3 轮）============
//
// 上面的两条「手改值不被撤销」只覆盖**同集合**（改零件 + 建零件 / 改装配件 + 建装配件），
// 跨集合（改零件 + 建装配件 / 改装配件 + 建零件）零覆盖 —— 于是 `applyExcelToAll` 里
// `target?.parts ?? standaloneParts.value` 的隐式回落活了下来：建行入口只给一侧时，
// 另一侧的 `target?.xxx` 是 `undefined`，`??` 便退回全量，把另一侧用户手改过的值
// 悄悄刷回 Excel 值（分厂靠 `!customer_id` 守卫幸免）。本组用例把 4 个建行入口
// 对「另一侧」的污染方向逐个锁死。
describe('usePartBatchPdf：跨集合作用域（建行不得污染另一张表）', () => {
  it('改独立零件 → mergeSelectedAsAssembly 建装配件：独立行手改值原样保留，新装配件照常回填', async () => {
    // 3 页 PDF ×2：合并前者 2 页得到独立零件行，再合并后者 2 页得到装配件
    mocks.pageCount = 3;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setupMany(api, { pdfNames: [PART_PDF, ASM_PDF], withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsPart();

    const edited = api.standaloneParts.value[0];
    if (!edited) throw new Error('未生成独立零件行');
    // 先确认它确实被 Excel 回填过，否则下面「保持不变」是空断言
    expect(edited.drawing_no).toBe(EXCEL_ROW_PART.drawingNo);
    expect(edited.quantity).toBe(EXCEL_ROW_PART.quantity);
    expect(edited.unit_price).toBe(EXCEL_ROW_PART.unitPrice);
    expect(edited.total_price).toBe(EXCEL_ROW_PART.totalPrice);
    expect(edited.applicant_name).toBe(EXCEL_ROW_PART.applicantName);
    expect(edited.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_PART.deliveryDays));

    // 用户手改：数量 / 含税单价 / 含税总价 / 计划交期 / 申请人（分厂不动，见浏览器实测）
    edited.quantity = 99;
    edited.unit_price = 888;
    edited.total_price = 87912;
    edited.planned_delivery_date = '2030-01-01';
    edited.applicant_name = '张三';

    // 跨集合动作：本次只建装配件
    selectPages(api, 'pdf-1002', 2);
    await api.mergeSelectedAsAssembly();

    // 独立零件表一个字段都不许被这次「建装配件」动过
    expect(edited.quantity).toBe(99);
    expect(edited.unit_price).toBe(888);
    expect(edited.total_price).toBe(87912);
    expect(edited.planned_delivery_date).toBe('2030-01-01');
    expect(edited.applicant_name).toBe('张三');

    // 而本次新建的装配件仍被正常回填（证明不是把回填整个关掉了）
    const fresh = api.assemblies.value[0];
    if (!fresh) throw new Error('未生成装配件');
    expect(fresh.drawing_no).toBe(EXCEL_ROW_ASM.drawingNo);
    expect(fresh.customer_id).toBe('c-liuchang');
    expect(fresh.customer_name).toBe(EXCEL_ROW_ASM.deptName);
    expect(fresh.applicant_name).toBe(EXCEL_ROW_ASM.applicantName);
    expect(fresh.quantity).toBe(EXCEL_ROW_ASM.quantity);
    expect(fresh.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_ASM.deliveryDays));
    expect(fresh.children).toHaveLength(2);
    for (const c of fresh.children) {
      expect(c.planned_delivery_date).toBe(fresh.planned_delivery_date);
      expect(c.quantity).toBe(1);
      expect(c.unit_price).toBeNull();
      expect(c.total_price).toBeNull();
    }

    w.unmount();
  });

  it('改装配件顶层与子件 → mergeSelectedAsPart 建零件：装配件手改值原样保留，新零件照常回填', async () => {
    // 2 页 PDF ×2：合并前者 2 页得到装配件，再合并后者 2 页得到独立零件
    mocks.pageCount = 2;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setupMany(api, { pdfNames: [ASM_PDF, PART_PDF], withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsAssembly();

    const edited = api.assemblies.value[0];
    if (!edited) throw new Error('未生成装配件');
    // 先确认它确实被 Excel 回填过，否则下面「保持不变」是空断言
    expect(edited.quantity).toBe(EXCEL_ROW_ASM.quantity);
    expect(edited.applicant_name).toBe(EXCEL_ROW_ASM.applicantName);
    expect(edited.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_ASM.deliveryDays));
    const firstChild = edited.children[0];
    if (!firstChild) throw new Error('未生成子件');
    expect(firstChild.planned_delivery_date).toBe(edited.planned_delivery_date);

    // 用户手改顶层套数 / 计划交期 / 申请人，并单独改一个子件的交期
    edited.quantity = 66;
    edited.planned_delivery_date = '2029-12-31';
    edited.applicant_name = '张三';
    firstChild.planned_delivery_date = '2029-11-11';

    // 跨集合动作：本次只建独立零件
    selectPages(api, 'pdf-1002', 2);
    await api.mergeSelectedAsPart();

    // 装配件表（含子件）一个字段都不许被这次「建零件」动过
    expect(edited.quantity).toBe(66);
    expect(edited.planned_delivery_date).toBe('2029-12-31');
    expect(edited.applicant_name).toBe('张三');
    expect(firstChild.planned_delivery_date).toBe('2029-11-11');

    // 而本次新建的独立零件仍被正常回填（证明不是把回填整个关掉了）
    const fresh = api.standaloneParts.value[0];
    if (!fresh) throw new Error('未生成独立零件行');
    expect(fresh.drawing_no).toBe(EXCEL_ROW_PART.drawingNo);
    expect(fresh.customer_id).toBe('c-duqi');
    expect(fresh.customer_name).toBe(EXCEL_ROW_PART.deptName);
    expect(fresh.applicant_name).toBe(EXCEL_ROW_PART.applicantName);
    expect(fresh.quantity).toBe(EXCEL_ROW_PART.quantity);
    expect(fresh.unit_price).toBe(EXCEL_ROW_PART.unitPrice);
    expect(fresh.total_price).toBe(EXCEL_ROW_PART.totalPrice);
    expect(fresh.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_PART.deliveryDays));

    w.unmount();
  });

  it('改装配件顶层与子件 → confirmManualPart 建零件：装配件手改值原样保留，新零件照常回填', async () => {
    mocks.pageCount = 2;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setupMany(api, { pdfNames: [ASM_PDF, PART_PDF], withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsAssembly();

    const edited = api.assemblies.value[0];
    if (!edited) throw new Error('未生成装配件');
    expect(edited.quantity).toBe(EXCEL_ROW_ASM.quantity);
    expect(edited.applicant_name).toBe(EXCEL_ROW_ASM.applicantName);
    const firstChild = edited.children[0];
    if (!firstChild) throw new Error('未生成子件');
    expect(firstChild.planned_delivery_date).toBe(edited.planned_delivery_date);

    edited.quantity = 66;
    edited.planned_delivery_date = '2029-12-31';
    edited.applicant_name = '张三';
    firstChild.planned_delivery_date = '2029-11-11';

    // 跨集合动作：手动新增一个独立零件
    api.manualPartForm.drawing_no = EXCEL_ROW_PART.drawingNo;
    api.manualPartForm.name = '断路器开关链接头';
    api.manualPartForm.file = pdfFile('manual-part.pdf');
    await api.confirmManualPart();

    expect(edited.quantity).toBe(66);
    expect(edited.planned_delivery_date).toBe('2029-12-31');
    expect(edited.applicant_name).toBe('张三');
    expect(firstChild.planned_delivery_date).toBe('2029-11-11');

    const fresh = api.standaloneParts.value[0];
    if (!fresh) throw new Error('未生成手动零件行');
    expect(fresh.customer_id).toBe('c-duqi');
    expect(fresh.applicant_name).toBe(EXCEL_ROW_PART.applicantName);
    expect(fresh.quantity).toBe(EXCEL_ROW_PART.quantity);
    expect(fresh.unit_price).toBe(EXCEL_ROW_PART.unitPrice);
    expect(fresh.total_price).toBe(EXCEL_ROW_PART.totalPrice);
    expect(fresh.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_PART.deliveryDays));

    w.unmount();
  });

  it('改独立零件 → confirmManualAssembly 建装配件：独立行手改值原样保留，新装配件照常回填', async () => {
    // 单页 PDF ×2 → rebuildFromUploads 直接生成 2 个独立零件行（都已被 Excel 回填）
    mocks.pageCount = 1;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setupMany(api, { pdfNames: [PART_PDF, ASM_PDF], withExcel: true });
    expect(api.standaloneParts.value).toHaveLength(2);
    const edited = api.standaloneParts.value[0];
    const alsoEdited = api.standaloneParts.value[1];
    if (!edited || !alsoEdited) throw new Error('未生成独立零件行');
    // 先确认两行确实被 Excel 回填过，否则下面「保持不变」是空断言
    expect(edited.drawing_no).toBe(EXCEL_ROW_PART.drawingNo);
    expect(edited.quantity).toBe(EXCEL_ROW_PART.quantity);
    expect(alsoEdited.drawing_no).toBe(EXCEL_ROW_ASM.drawingNo);
    expect(alsoEdited.quantity).toBe(EXCEL_ROW_ASM.quantity);

    // 用户在两张独立行上都手改
    edited.quantity = 99;
    edited.unit_price = 888;
    edited.total_price = 87912;
    edited.planned_delivery_date = '2030-01-01';
    edited.applicant_name = '张三';
    alsoEdited.quantity = 77;
    alsoEdited.applicant_name = '李四';

    // 跨集合动作：手动新增一个装配件（1 页 → 单个子件）
    api.manualAsmForm.drawing_no = EXCEL_ROW_ASM.drawingNo;
    api.manualAsmForm.name = '扁条收框档条';
    api.manualAsmForm.file = pdfFile('manual-asm.pdf');
    await api.confirmManualAssembly();

    expect(edited.quantity).toBe(99);
    expect(edited.unit_price).toBe(888);
    expect(edited.total_price).toBe(87912);
    expect(edited.planned_delivery_date).toBe('2030-01-01');
    expect(edited.applicant_name).toBe('张三');
    expect(alsoEdited.quantity).toBe(77);
    expect(alsoEdited.applicant_name).toBe('李四');

    const fresh = api.assemblies.value[0];
    if (!fresh) throw new Error('未生成手动装配件');
    expect(fresh.customer_id).toBe('c-liuchang');
    expect(fresh.applicant_name).toBe(EXCEL_ROW_ASM.applicantName);
    expect(fresh.quantity).toBe(EXCEL_ROW_ASM.quantity);
    expect(fresh.planned_delivery_date).toBe(plusDays(TODAY, EXCEL_ROW_ASM.deliveryDays));
    expect(fresh.children).toHaveLength(1);
    for (const c of fresh.children) {
      expect(c.planned_delivery_date).toBe(fresh.planned_delivery_date);
      expect(c.quantity).toBe(1);
      expect(c.unit_price).toBeNull();
    }

    w.unmount();
  });
});
