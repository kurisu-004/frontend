// 2026-10-03 新增：usePartBatchPdf composable 单测（此前零覆盖）。
// 模式参考同目录 usePartBatchManual.spec.ts：harness 组件 + 模块 mock。
//
// 本 spec 锁的是「Excel 数据回填」这条链路的业务口径（缺陷 B）：
//   - 装配件顶层按**装配件自身图号**命中 Excel → 分厂 / 申请人 / 整套数量 / 计划交期；
//   - 子件**只**共享计划交期，数量保持 1、单价 / 总价保持 null（业务口径：Excel 里的
//     数量和单价是整套的；子件数量手填、子件不需要单价）；
//   - 独立零件（单页 PDF）维持原状：数量 / 单价 / 总价 / 交期 / 分厂 / 申请人全回填；
//   - Excel 解析结果活过 rebuildFromUploads（合并不再是无源之水）；
//   - splitStandalonePart 把多页拆回子页时**不**回填（子页不该吃整套数量 / 单价）。
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

vi.mock('@/api/parts', () => ({ batchCreateParts: vi.fn() }));
vi.mock('@/api/files/sts', () => ({ grantStsTmpKeyFiles: vi.fn() }));
vi.mock('@/composables/useCosUpload', () => ({ useCosUpload: vi.fn() }));

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

/** 组一个 el-upload 的 UploadFile（只需 uid / name / raw）。 */
function uploadFile(uid: number, name: string): UploadFile {
  const raw = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf',
  });
  return { uid, name, status: 'success', raw } as unknown as UploadFile;
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

  it('splitStandalonePart 不触发 Excel 回填：拆出的子页不继承整套数量 / 单价', async () => {
    mocks.pageCount = 3;
    const w = harnessMount();
    await flushPromises();
    const api = need();

    await setup(api, { pdfName: PART_PDF, withExcel: true });
    selectPages(api, 'pdf-1001', 2);
    await api.mergeSelectedAsPart();
    const merged = api.standaloneParts.value[0];
    if (!merged) throw new Error('未生成独立零件行');
    expect(merged.quantity).toBe(EXCEL_ROW_PART.quantity);

    api.splitStandalonePart(merged);

    const rows = api.standaloneParts.value;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.quantity).toBe(1);
      expect(r.unit_price).toBeNull();
      expect(r.total_price).toBeNull();
      expect(r.planned_delivery_date).toBe('');
      expect(r.customer_id).toBe('');
    }

    w.unmount();
  });
});
