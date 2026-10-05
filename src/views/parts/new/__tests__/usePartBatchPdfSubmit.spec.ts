// 2026-10-04 新增：Tab 2「PDF 批量上传」单按钮提交流程（建工单 + 逐实体后置上传）。
//
// 同目录 usePartBatchPdf.spec.ts 锁的是 Excel 回填口径，本 spec 锁提交链路：
//   - 一次点击 = 建工单（独立零件走 POST /parts/batch、装配件走 POST /assemblies）
//     + 逐实体补传图纸 / 3D；
//   - item 不带 drawing_file / model3d_file（文件走后置上传）；
//   - **装配件不再展平成独立 part**：顶层与子件由一次 `POST /assemblies` 建出，
//     子件的 part id 来自响应的 `created_children[].id`；
//   - 上传按目标端点分流：装配件顶层总装图 → `/assemblies/{id}/files`，子件图纸 /
//     3D 与独立零件 → `/parts/{id}/upload-drawing` / `upload-3d-model`；
//   - 服务端拒行 → 回 idle，**一个文件都不上传**；
//   - 建单「部分行成立」→ 建成的行移出本地表格，再提交只发剩下的失败行；装配件组失败
//     ⇒ 整组（顶层 + 全部子件）留在表里可重提，已成功的组不再重复建；
//   - 上传失败 → done 态 + 保留现场 + 弹失败清单，重试**只重传不重复建单**；
//   - 装配件**逐页分发**：默认「无总装图」⇒ 顶层不传总装图、库里没有 ASSEMBLY_MASTER
//     行；每个子件只传自己那一页的单页切片（文件名带 `_pN`）；
//   - 指定某页为总装图 → 该页从子件里排除，顶层只传那一个单页切片（打印页数不重不漏）；
//   - 重试按 **job**（目标实体 × 文件）粒度：部分失败时只补传失败的那一个，
//     已成功的绝不重传（重传会撞后端 uk_t_part_file_owner_kind_sha 报 21108）；
//   - 建单之后任何抛错都不许把阶段退回 idle（否则再点一次 = 同一批工单建第二遍）；
//   - job 列表没登记上时主按钮必须仍是可点的「重试上传」，出路是现场重建 job。
//
// 2026-10-05 边界（读用例前先看，别把结论外推得比证据宽）：
//   本 spec 与 usePartBatchPdf.spec.ts 都用**假 pdf-lib**（见下方 mock）。它证明的是
//   **分发口径**：「切页入参 pageIndex 是第 k 页」+「每个子件上传的是各自那一份 Blob」。
//   假实现的 `save()` 把页下标编码进字节，所以「各子件字节不同」是可断言的，但那是
//   假字节的差异，**不证明**真 pdf-lib 切出来的单页 PDF 在浏览器 / 后端能正确渲染、
//   也不证明字节级保真（字体资源、旋转、注释、页面框等 copyPages 复刻得到）。
//   人工验证方式（未自动化，做过即视为该边界已验）：用一份真多页 PDF 走「合并为装配件」
//   → 提交，在零件详情 / 装配件详情里逐个打开子件图纸，确认每份只有 1 页、页面内容是
//   原 PDF 的对应那一页、方向与缩放正常。
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
  pageCount: 1,
  routerPush: vi.fn(),
  batchCreateParts: vi.fn(),
  createAssembly: vi.fn(),
  uploadAssemblyPdf: vi.fn(),
  uploadPartDrawing: vi.fn(),
  uploadPart3DModel: vi.fn(),
  alert: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  saverFlush: vi.fn(),
  draftLoad: vi.fn(() => null),
  /** pdf-lib 假实现的 `copyPages(src, pageIndices)` 入参记录（见下方 mock 注释）。 */
  copyPages: vi.fn(),
  /** > 0 时：第 N 次 copyPages（1-based）抛错，模拟加密 / xref 异常导致的切页中途失败。 */
  failOnCopyPagesCall: 0,
  /** true 时：`PDFDocument.load` 抛错，模拟 pdf-lib 读不动（加密 / xref 异常）的那份文件。 */
  failOnLoad: false,
  /** true 时：`countPdfPages` 抛错，模拟 pdfjs 都读不出页数（与切页失败是两个失败面）。 */
  pageCountThrows: false,
  /** 非 null 时：`countPdfPages` 先 await 这个 promise，用于把「解析在途」那段挂起来。 */
  pageCountGate: null as Promise<void> | null,
  /** draft.saver.schedule 收到的 payload 队列（末条即最新快照）。 */
  scheduled: [] as Array<Record<string, unknown>>,
}));

// 2026-10-05：`countPdfPages` 是「手动新增装配件」里最慢的一步，也是重入闸门必须占在
// 它之前的原因。挂起（gate）/ 抛错（throws）两个开关都在这里，不塞进用例里各自 stub。
vi.mock('@/utils/pdfjs', () => ({
  countPdfPages: async () => {
    if (mocks.pageCountGate) await mocks.pageCountGate;
    if (mocks.pageCountThrows) throw new Error('Invalid PDF structure');
    return mocks.pageCount;
  },
}));
vi.mock('@/api/parts', () => ({
  batchCreateParts: mocks.batchCreateParts,
  uploadPartDrawing: mocks.uploadPartDrawing,
  uploadPart3DModel: mocks.uploadPart3DModel,
}));
// composable 现在还从 @/api/assembly 取两个封装（建装配件 + 传总装图），必须一并桩掉，
// 否则会拉到真实 axios 实例。
vi.mock('@/api/assembly', () => ({
  createAssembly: mocks.createAssembly,
  uploadAssemblyPdf: mocks.uploadAssemblyPdf,
}));
vi.mock('@/views/parts/new/composables/usePartsNewDraft', () => ({
  usePartsNewDraft: () => ({
    userId: 'u-test',
    load: mocks.draftLoad,
    save: () => undefined,
    clear: () => undefined,
    saver: {
      schedule: (p: Record<string, unknown>) => mocks.scheduled.push(p),
      cancel: () => undefined,
      flush: mocks.saverFlush,
    },
  }),
}));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerPush }),
  useRoute: () => ({ path: '/parts/new', query: {} }),
}));
// 2026-10-05：装配件建行要真调 pdf-lib 切页（此前只在「合并为零件」里切，本 spec 的
// 假 PDF 从没走到那里）。单测里的「PDF」是 3 字节假文件，真解析必炸 ⇒ 最小假实现。
//
// 假实现必须**留痕**，否则测不出「切错页」：只返回固定字节的话，把
// `copyPagesFrom(srcDoc, [0])` 写死（每个子件都发整份 PDF 的第 0 页）也能全绿。
// 留痕方式：`copyPages` 把 pageIndices 入参记进 `mocks.copyPages`；`addPage` 记下本轮
// 文档装进的是源文档的第几页，`save()` 把这个序列编码进字节 ⇒ 切第 k 页的产物字节必然
// 不同，可直接断言「各子件上传的 File 字节不同」。
vi.mock('pdf-lib', () => {
  interface FakePage {
    pageIndex: number;
  }
  /** 一个假文档：`added` 是本轮 addPage 收下的源页下标，save() 把它编码进字节。 */
  const doc = (added: number[] = []) => ({
    copyPages: async (src: unknown, indices: number[]) => {
      mocks.copyPages(src, indices);
      if (
        mocks.failOnCopyPagesCall &&
        mocks.copyPages.mock.calls.length === mocks.failOnCopyPagesCall
      ) {
        throw new Error('Input buffer contains an encrypted PDF');
      }
      return indices.map((pageIndex) => ({ pageIndex }));
    },
    addPage: (p: FakePage) => {
      added.push(p.pageIndex);
    },
    save: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, ...added]),
  });
  return {
    PDFDocument: {
      load: async () => {
        if (mocks.failOnLoad) throw new Error('Input buffer contains an encrypted PDF');
        return doc();
      },
      create: async () => doc(),
    },
  };
});
vi.mock('element-plus', () => ({
  ElMessage: {
    error: mocks.error,
    success: mocks.success,
    warning: mocks.warning,
    info: vi.fn(),
  },
  ElMessageBox: { confirm: vi.fn(), alert: mocks.alert },
}));

import { usePartBatchPdf } from '../composables/usePartBatchPdf';
import type { AssemblyRow, UsePartBatchPdfReturn } from '../composables/usePartBatchPdf';
import type { Customer } from '@/api/customer';
import type { UploadFile } from 'element-plus';

let captured: UsePartBatchPdfReturn | null = null;
const Harness = defineComponent({
  setup() {
    captured = usePartBatchPdf({
      customers: ref<Customer[]>([
        {
          id: 'c-root',
          name: '集团',
          parent_id: null,
          parent_name: null,
          serial_prefix: null,
          version: 1,
          created_at: '',
          updated_at: '',
        },
      ]) as never,
      applicantSearch: {
        applicants: ref([]),
        loading: ref(false),
        loadForCustomer: async () => undefined,
        querySearch: () => undefined,
      },
      successNextTab: ref('manual'),
    });
    return () => h('div');
  },
});

function up(uid: number, name: string): UploadFile {
  return {
    uid,
    name,
    status: 'success',
    raw: new File([new Uint8Array([1, 2, 3])], name),
  } as unknown as UploadFile;
}

/** 造一个后端业务错误（ApiError 形状：message + code），用于「错误码」路径。 */
function apiError(code: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'ApiError', code });
}

/** 造一个没有业务码的网络错误（`api/http.ts` 兜底给 code=0）。 */
function networkError(message: string): Error {
  return Object.assign(new Error(message), { name: 'ApiError', code: 0 });
}

/** `POST /assemblies` 201 响应里实现真正读的字段：`assembly.id` + `created_children[]`。 */
interface FakeAssemblyResult {
  assembly: { id: string; drawing_no: string };
  created_children: Array<{ id: string; serial_no: string; drawing_no: string }>;
}

/**
 * 造一个合法的建装配件响应：`tag` 让每次调用的 id 唯一（顶层 `A<tag>`、子件
 * `A<tag>-01/-02`），`children` 给子件回显的图号（**必须与请求一致**，实现按下标把
 * `created_children[i]` 对回本地子件行，不一致会被判成错序而整组不记账）。
 */
function okAssembly(
  tag: string,
  children: Array<string | { drawing_no: string }>,
): FakeAssemblyResult {
  const nos = children.map((c) => (typeof c === 'string' ? c : c.drawing_no));
  return {
    assembly: { id: `A${tag}`, drawing_no: '' },
    created_children: nos.map((drawingNo, i) => ({
      id: `A${tag}-${String(i + 1).padStart(2, '0')}`,
      // 后端子件序列号格式 `{asm_serial}-{i:02d}`（1-based）
      serial_no: `A${tag}-${String(i + 1).padStart(2, '0')}`,
      drawing_no: drawingNo,
    })),
  };
}

/** 一个装配件行**实际建出**的子件图号（喂给 `okAssembly`，保证回显与请求一致）。
 *  口径必须与 `buildAssemblyPayload` 一致（= `effectiveChildren`）：指定了总装图的那一页
 *  不发出去，用全量 `children` 会与响应的 `created_children` 对不上、整组被判错序。 */
function childNos(asm: AssemblyRow): string[] {
  return need()
    .effectiveChildren(asm)
    .map((c) => c.drawing_no);
}

function need(): UsePartBatchPdfReturn {
  if (!captured) throw new Error('no');
  return captured;
}

beforeEach(() => {
  mocks.pageCount = 1;
  mocks.batchCreateParts.mockReset();
  mocks.createAssembly.mockReset();
  mocks.uploadAssemblyPdf.mockReset();
  mocks.uploadPartDrawing.mockReset();
  mocks.uploadPart3DModel.mockReset();
  mocks.alert.mockReset();
  mocks.success.mockReset();
  mocks.warning.mockReset();
  mocks.error.mockReset();
  mocks.routerPush.mockReset();
  mocks.draftLoad.mockReturnValue(null);
  // 记录型 mock 用 clear 而不是 reset：reset 会把实现清成 undefined，
  // 而「造页 + 把 addPage 记进字节」正是它要证明的东西。
  mocks.copyPages.mockClear();
  mocks.failOnCopyPagesCall = 0;
  mocks.failOnLoad = false;
  mocks.pageCountThrows = false;
  mocks.pageCountGate = null;
  mocks.scheduled.length = 0;
});

describe('onSubmit', () => {
  it('建单 → 后置上传 → 全成功清空', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf'), up(2, 'A-2_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value.forEach((r) => (r.customer_id = 'c-root'));
    expect(api.standaloneParts.value).toHaveLength(2);

    mocks.batchCreateParts.mockResolvedValue({
      created: [
        { id: '9001', sourceIndex: 0 },
        { id: '9002', sourceIndex: 1 },
      ],
      failed: [],
    });
    expect(api.commitStage.value).toBe('idle');
    expect(api.canSubmit.value).toBe(true);
    expect(api.submitLabel.value).toContain('2 个零件');

    await api.onSubmit();
    await flushPromises();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    const items = mocks.batchCreateParts.mock.calls[0]![0] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]!.drawing_file).toBeUndefined();
    expect(items[0]!.model3d_file).toBeUndefined();
    // 2 个 part × 各自 PDF = 2 次上传
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(2);
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0]).sort()).toEqual(['9001', '9002']);
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(api.commitStage.value).toBe('done');
    expect(Object.values(api.pdfUploadCells)).toHaveLength(0);
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    expect(api.standaloneParts.value).toHaveLength(0);
    w.unmount();
  });

  it('服务端拒绝 → 回 idle，一个文件都不上传', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value[0]!.customer_id = 'c-root';

    mocks.batchCreateParts.mockResolvedValue({
      created: [],
      failed: [{ index: 0, message: 'bad' }],
    });
    await api.onSubmit();
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();
    expect(api.commitStage.value).toBe('idle');
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(api.standaloneParts.value).toHaveLength(1);
    w.unmount();
  });

  it('上传失败 → done + 保留现场，重试只重传不重建', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf'), up(2, 'A-2_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value.forEach((r) => (r.customer_id = 'c-root'));
    mocks.batchCreateParts.mockResolvedValue({
      created: [
        { id: '9001', sourceIndex: 0 },
        { id: '9002', sourceIndex: 1 },
      ],
      failed: [],
    });
    mocks.uploadPartDrawing.mockImplementation(async (pid: string) => {
      if (pid === '9002') throw new Error('COS 502');
    });

    await api.onSubmit();
    expect(api.commitStage.value).toBe('done');
    const failedRow = api.standaloneParts.value[1]!;
    expect(api.getRowPdfCell(failedRow)?.status).toBe('error');
    expect(api.standaloneParts.value).toHaveLength(2);
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    expect(api.canSubmit.value).toBe(true);
    expect(mocks.alert).toHaveBeenCalled();

    // 重试
    mocks.uploadPartDrawing.mockReset();
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.retryFailedUploads();
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1); // 没重建
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls[0]![0]).toBe('9002');
    expect(api.standaloneParts.value).toHaveLength(0);
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    w.unmount();
  });

  it('行内单文件重试按 cell key 定位', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value[0]!.customer_id = 'c-root';
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: '9001', sourceIndex: 0 }],
      failed: [],
    });
    mocks.uploadPartDrawing.mockRejectedValue(new Error('boom'));
    await api.onSubmit();
    const row = api.standaloneParts.value[0]!;
    const cell = api.getRowPdfCell(row);
    expect(cell?.status).toBe('error');
    mocks.uploadPartDrawing.mockReset();
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.retryUploadByCell(`pdf:${row.pdfSourceUid}`);
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('装配件：一次 POST /assemblies 建出顶层 + 子件；默认无总装图 ⇒ 顶层不传，子件各传自己那一页', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'ASM-1_总装.pdf')];
    await api.rebuildFromUploads();
    api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1']);
    await api.mergeSelectedAsAssembly();
    const asm = api.assemblies.value[0]!;
    asm.customer_id = 'c-root';
    expect(asm.children).toHaveLength(2);
    // 子件 0 挂一个 3D
    api.threeDModelFiles.value = [up(9, 'ASM-1_总装.step')];
    asm.children[0]!.three_d_index = 0;

    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.uploadPart3DModel.mockResolvedValue({});
    await api.onSubmit();

    // 装配件**不走**批量端点（`POST /parts/batch` 里没有 assembly 概念）
    expect(mocks.batchCreateParts).not.toHaveBeenCalled();
    expect(mocks.createAssembly).toHaveBeenCalledTimes(1);
    const payload = mocks.createAssembly.mock.calls[0]![0] as {
      children: Array<Record<string, unknown>>;
    };
    expect(payload.children).toHaveLength(2);

    // 默认「无总装图」⇒ 一个总装图 job 都不产生（库里就不会有 ASSEMBLY_MASTER 行，
    // 打印时既不出总装图也不出该装配件的序列号背面）
    expect(asm.masterPageIndex).toBeNull();
    expect(asm.masterPdfSourceUid).toBeNull();
    expect(mocks.uploadAssemblyPdf).not.toHaveBeenCalled();
    // 子件图纸 → parts 端点，id 来自响应的 created_children[].id；每份只有自己那一页
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(2);
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0]).sort()).toEqual(['A1-01', 'A1-02']);
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[1].name).sort()).toEqual([
      'ASM-1_总装_p1.pdf',
      'ASM-1_总装_p2.pdf',
    ]);
    // 仅子件 0 挂 3D → 1 次，且打在子件 id 上
    expect(mocks.uploadPart3DModel).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPart3DModel.mock.calls[0]![0]).toBe('A1-01');
    expect(mocks.uploadPart3DModel.mock.calls[0]![1].name).toBe('ASM-1_总装.step');
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(api.commitStage.value).toBe('done');
    // 2026-10-05：子件挂上 assembly_id 后不进入零件一览 ⇒ 成功提示必须说清去哪看，
    // 且「零件 N 条」与「子件 Z 个」是**同一批**（子件本身就是 t_part 行）
    const okText = mocks.success.mock.calls.map((c) => c[0] as string).join('|');
    expect(okText).toContain('2 条零件（其中 2 个为装配件子件） + 1 个装配件');
    expect(okText).toContain('装配件详情页');
    expect(okText).not.toContain('1 个装配件（含');
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    w.unmount();
  });

  it('上传失败时草稿快照保留行数据，且不含任何 partId 映射', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    const row = api.standaloneParts.value[0]!;
    row.customer_id = 'c-root';
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: '9001', sourceIndex: 0 }],
      failed: [],
    });
    mocks.uploadPartDrawing.mockRejectedValue(new Error('boom'));
    await api.onSubmit();
    await flushPromises();
    // 刷新后 File 不复活、行 uid 重新生成 ⇒ 任何 partId 映射都匹配不上新行，
    // 草稿里不落该字段；它只负责保住用户已填的行数据（分厂 / 交期 / 行数）。
    const last = mocks.scheduled.at(-1);
    const pdfTab = last?.pdf_tab as { rows: Array<{ uid: string }>; created_part_ids?: unknown };
    expect(pdfTab.rows.map((r) => r.uid)).toEqual([row.uid]);
    expect(pdfTab.created_part_ids).toBeUndefined();
    w.unmount();
  });
});

/** 装配件（顶层 + N 子件，**每个子件一份单页切片**）解析到 api 上，返回顶层行。 */
async function mountAssembly(api: UsePartBatchPdfReturn, pages = 2): Promise<AssemblyRow> {
  mocks.pageCount = pages;
  api.pdfForm.customerL1Id = 'c-root';
  api.pdfFiles.value = [up(1, 'ASM-1_总装.pdf')];
  await api.rebuildFromUploads();
  api.selectedPages.value = new Set(Array.from({ length: pages }, (_, i) => `pdf-1:${i}`));
  await api.mergeSelectedAsAssembly();
  api.assemblies.value[0]!.customer_id = 'c-root';
  return api.assemblies.value[0]!;
}

describe('上传重试（job 粒度）', () => {
  it('子件 0 的图纸上传失败：行内重试只补传子件 0，已成功的子件 1 不重传', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    expect(asm.children).toHaveLength(2);
    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    // 首轮：子件 1 成功、子件 0 网络失败
    mocks.uploadPartDrawing.mockImplementation(async (pid: string) => {
      if (pid === 'A1-01') throw new Error('COS 502');
    });
    mocks.uploadAssemblyPdf.mockRejectedValue(new Error('不该被调用'));

    await api.onSubmit();

    // 逐页分发：顶层无总装图 ⇒ 只有 2 个子件图纸 job
    expect(mocks.uploadAssemblyPdf).not.toHaveBeenCalled();
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(2);
    // 每个子件一个独立 cell（各自的切片），互不影响
    expect(api.getRowPdfCell(asm.children[0]!)?.status).toBe('error');
    expect(api.getRowPdfCell(asm.children[1]!)?.status).toBe('done');
    expect(api.getRowPdfCell({ pdfSourceUid: asm.masterPdfSourceUid })).toBeUndefined();
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    const firstAlert = mocks.alert.mock.calls[0]![0] as string;
    // 计数口径 = job：1 项 = 1 个工单的 1 个文件，清单也只有那一行
    expect(firstAlert).toContain('1 项上传失败（涉及 1 个工单 / 1 个文件）');
    expect(firstAlert).toContain('第 A1-01 号零件');
    expect(api.assemblies.value).toHaveLength(1);

    // 行内重试：若把已成功的子件 1 也重跑，后端 uk_t_part_file_owner_kind_sha 会回
    // 21108「相同文件已存在」；这里让它们真的报错，验证重试压根没碰它们。
    mocks.uploadPartDrawing.mockReset();
    mocks.uploadPartDrawing.mockRejectedValue(new Error('相同文件已存在'));
    await api.retryUploadByCell(`pdf:${asm.children[0]!.pdfSourceUid}`);

    // 重试只补传，**绝不重新建单**（两个建单端点都无幂等键）
    expect(mocks.createAssembly).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls[0]![0]).toBe('A1-01');
    // 补传仍失败 ⇒ 现场保留在 done 态，不清空不跳页
    expect(api.commitStage.value).toBe('done');
    expect(api.assemblies.value).toHaveLength(1);
    w.unmount();
  });

  it('指定总装图后总装图失败：行内重试只补传总装图（子件不重传）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    // 显式指定第 1 页为总装图（此前「顶层无条件传整份 PDF」，本页会同时是总装图与子件 0）
    api.onAsmMasterPageChange(asm, 0);
    expect(api.effectiveChildren(asm)).toHaveLength(1);
    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.uploadAssemblyPdf.mockRejectedValueOnce(new Error('网络中断'));

    await api.onSubmit();

    expect(mocks.createAssembly).toHaveBeenCalledTimes(1);
    // 顶层只有那一个单页切片；子件只剩 P2
    expect(mocks.uploadAssemblyPdf).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAssemblyPdf.mock.calls[0]![0]).toBe('A1');
    expect(mocks.uploadAssemblyPdf.mock.calls[0]![1].name).toBe('ASM-1_总装_p1.pdf');
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls[0]![0]).toBe('A1-01');
    expect(api.getRowPdfCell({ pdfSourceUid: asm.masterPdfSourceUid })?.status).toBe('error');
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    const firstAlert = mocks.alert.mock.calls[0]![0] as string;
    expect(firstAlert).toContain('装配件 A1');
    expect(firstAlert).not.toContain('A1-01');
    expect(api.assemblies.value).toHaveLength(1);

    // 行内重试：只补总装图，已成功的子件不重传
    mocks.uploadPartDrawing.mockReset();
    mocks.uploadPartDrawing.mockRejectedValue(new Error('相同文件已存在'));
    mocks.uploadAssemblyPdf.mockReset();
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    await api.retryUploadByCell(`pdf:${asm.masterPdfSourceUid}`);

    expect(mocks.createAssembly).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAssemblyPdf).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAssemblyPdf.mock.calls[0]![0]).toBe('A1');
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();
    // 补传成功 ⇒ 正常收口：清空现场 + 跳零件列表
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    expect(api.assemblies.value).toHaveLength(0);
    w.unmount();
  });

  it('行内重试：只补传该 cell 下失败的 job，修好后正常收口（提示 + 清空 + 跳页）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    // 无总装图时子件 0 的切片就是唯一的装配侧文件之一，让它失败以验证行内重试收口
    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadPartDrawing.mockImplementation(async (pid: string) => {
      if (pid === 'A1-01') throw new Error('网络中断');
    });
    await api.onSubmit();
    expect(api.getRowPdfCell(asm.children[0]!)?.status).toBe('error');

    mocks.uploadPartDrawing.mockReset();
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.retryUploadByCell(`pdf:${asm.children[0]!.pdfSourceUid}`);

    expect(mocks.createAssembly).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls[0]![0]).toBe('A1-01');
    // 收口不能漏：否则停在「无失败但主按钮永久禁用」的态
    expect(api.commitStage.value).toBe('done');
    expect(api.canSubmit.value).toBe(false);
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    expect(api.assemblies.value).toHaveLength(0);
    expect(api.pdfFiles.value).toHaveLength(0);
    w.unmount();
  });
});

describe('建单之后的异常', () => {
  it('job 登记前抛错：主按钮仍是可点的「重试上传」，点它现场重建 job（不重复建单）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value[0]!.customer_id = 'c-root';
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: '9001', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    // 建单已成功，但读 File 时炸了（Blob 属性访问抛错）⇒ buildUploadJobs 抛出
    const emptyBlob: Blob = new Blob();
    const broken: Blob = new Proxy(emptyBlob, {
      get() {
        throw new Error('文件对象已失效');
      },
    });
    const src = api.allPdfs.value[0]!;
    api.allPdfs.value = [{ ...src, raw: broken }];

    await api.onSubmit();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();
    // 阶段停在 done；主按钮**不许**退化成永久 disabled 的「提交创建」——
    // 用户看到自己填好的行唯一合理的动作就是再点一次，那会把工单再建一遍。
    expect(api.commitStage.value).toBe('done');
    expect(api.canSubmit.value).toBe(true);
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    expect(api.submitLabel.value).not.toContain('提交创建');
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![1]).toBe('文件上传未开始');

    // 直接再调 onSubmit（用户点主按钮）也进不去建单路径
    await api.onSubmit();
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);

    // File 恢复后点「重试上传」：用 createdTargets 现场重建 job 再补传（不碰建单）
    api.allPdfs.value = [src];
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.retryFailedUploads();
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls[0]![0]).toBe('9001');
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    w.unmount();
  });

  it('job 登记前抛错后重试仍抛错：如实告知，不静默成功也不重建工单', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value[0]!.customer_id = 'c-root';
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: '9001', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    const broken: Blob = new Proxy(new Blob(), {
      get() {
        throw new Error('文件对象已失效');
      },
    });
    api.allPdfs.value = [{ ...api.allPdfs.value[0]!, raw: broken }];

    await api.onSubmit();
    mocks.alert.mockClear();
    await api.retryFailedUploads();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![1]).toBe('文件上传未开始');
    // 出路仍然在：主按钮可点、仍是「重试上传」
    expect(api.canSubmit.value).toBe(true);
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    w.unmount();
  });

  it('重试时文件已不在（行被删）→ 如实说清出路，不静默成功也不无限可重试', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    const row = api.standaloneParts.value[0]!;
    row.customer_id = 'c-root';
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: '9001', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    const broken: Blob = new Proxy(new Blob(), {
      get() {
        throw new Error('文件对象已失效');
      },
    });
    api.allPdfs.value = [{ ...api.allPdfs.value[0]!, raw: broken }];
    await api.onSubmit();

    // 行被删掉 ⇒ 重建 job 时找不到任何 part × 文件的组合
    api.removeStandalonePart(row.uid);
    mocks.alert.mockClear();
    await api.retryFailedUploads();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![0] as string).toContain('找不到对应的文件');
    // 没有「成功创建」的假提示，也没有跳转
    expect(mocks.routerPush).not.toHaveBeenCalled();
    w.unmount();
  });

  it('建单请求整体失败：回 idle 可安全重来', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value[0]!.customer_id = 'c-root';
    mocks.batchCreateParts.mockRejectedValue(new Error('网关 502'));
    await api.onSubmit();
    expect(api.commitStage.value).toBe('idle');
    expect(api.canSubmit.value).toBe(true);
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();

    mocks.batchCreateParts.mockReset();
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: '9001', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.onSubmit();
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('建单结果解析到一半抛错（已有 part 落库）：绝不退成 idle 让用户重来', async () => {
    // 「creating 阶段 catch ⇒ 一定一个工单都没建出来」是能被证伪的：created 里混进
    // 一个畸形元素时，forEach 会在已经把前几个 part 写进 createdTargets 之后抛错。
    // 此时退成 idle = 主按钮重新可点 = 已落库的工单被建第二遍。
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件1.pdf'), up(2, 'A-2_件2.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value.forEach((r) => (r.customer_id = 'c-root'));
    const malformed = {
      created: [{ id: 'p0', sourceIndex: 0 }, null],
      failed: [],
      groupErrors: [],
    };
    mocks.batchCreateParts.mockResolvedValue(malformed);

    await api.onSubmit();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    // 已落库 ⇒ 停在 done，工单事实如实转达；不回 idle
    expect(api.commitStage.value).toBe('done');
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    expect(api.submitLabel.value).not.toContain('提交创建');
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![1]).toBe('提交中断');
    expect(mocks.alert.mock.calls[0]![0] as string).toContain('工单已创建 1 条零件');

    // 再点主按钮进不去建单路径：不重复建单
    await api.onSubmit();
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});

describe('建单「部分行成立」', () => {
  it('建成的行移出表格：再提交只发失败行，绝不重建已建成的 part', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件1.pdf'), up(2, 'A-2_件2.pdf'), up(3, 'A-3_件3.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value.forEach((r) => (r.customer_id = 'c-root'));
    const rejected = api.standaloneParts.value[1]!;
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.batchCreateParts.mockResolvedValue({
      created: [
        { id: 'p1', sourceIndex: 0 },
        { id: 'p3', sourceIndex: 2 },
      ],
      failed: [{ index: 1, message: '图号已存在' }],
      groupErrors: [],
    });

    await api.onSubmit();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    // 建成的 p1 / p3 已从本地表格移除，只剩被拒的那行
    expect(api.standaloneParts.value).toHaveLength(1);
    expect(api.standaloneParts.value[0]!.uid).toBe(rejected.uid);
    // 如实告知「已创建 2 条零件」
    const text = mocks.alert.mock.calls[0]![0] as string;
    expect(text).toContain('已创建 2 条零件');
    expect(text).toContain('图号已存在');
    // 阶段回 idle 是安全的：剩下的行重发不可能碰到 p1 / p3
    expect(api.commitStage.value).toBe('idle');
    expect(api.canSubmit.value).toBe(true);
    expect(api.submitLabel.value).toContain('1 个零件');
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();

    // 再点提交：只有失败行被发出去
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: 'p2', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    await api.onSubmit();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(2);
    const second = mocks.batchCreateParts.mock.calls[1]![0] as Array<{ drawing_no: string }>;
    expect(second).toHaveLength(1);
    expect(second[0]!.drawing_no).toBe(rejected.drawing_no);
    // p1 / p3 没有被重建
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0])).toEqual(['p2']);
    w.unmount();
  });

  it('装配件：组失败 ⇒ 整组（顶层 + 全部子件）留在表里可重提；已成功的组绝不重复建', async () => {
    // 2026-10-05：一次 POST /assemblies 建顶层 + 全部子件 ⇒ 组的粒度就是「整行」，
    // 不再存在「顶层建出、子件被拒」的中间态（那正是展平发 /parts/batch 才有的形态）。
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    // 两个装配件：pdf-1 的前 2 页、pdf-2 的前 2 页
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'ASM-1_总装.pdf'), up(2, 'ASM-2_总装.pdf')];
    await api.rebuildFromUploads();
    for (const [uid, pdfUid] of [
      ['pdf-1', 'pdf-1'],
      ['pdf-2', 'pdf-2'],
    ] as const) {
      api.selectedPages.value = new Set([`${pdfUid}:0`, `${pdfUid}:1`]);
      await api.mergeSelectedAsAssembly();
      api.assemblies.value[api.assemblies.value.length - 1]!.customer_id = 'c-root';
      void uid;
    }
    const [ok1, bad] = api.assemblies.value;
    expect(bad!.children).toHaveLength(2);

    // 第 1 组成功、第 2 组被后端明确拒（20308：L1 客户没有 serial_prefix）
    mocks.createAssembly
      .mockResolvedValueOnce(okAssembly('1', childNos(ok1!)))
      .mockRejectedValueOnce(apiError(20308, '一级客户未配置流水号前缀'));
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    mocks.uploadPartDrawing.mockResolvedValue({});

    await api.onSubmit();

    expect(mocks.createAssembly).toHaveBeenCalledTimes(2);
    // 被拒那组整行留在表里（顶层 + 2 个子件都还在），可改完再提
    expect(api.assemblies.value).toHaveLength(1);
    expect(api.assemblies.value[0]!.uid).toBe(bad!.uid);
    expect(api.assemblies.value[0]!.children).toHaveLength(2);
    // 已成功那组已建出 ⇒ 整行摘掉，不留在表里诱导重提
    expect(api.assemblies.value.map((a) => a.uid)).not.toContain(ok1!.uid);
    // 任一路有行没建出 ⇒ 整轮不上传
    expect(mocks.uploadAssemblyPdf).not.toHaveBeenCalled();
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();
    const text = mocks.alert.mock.calls[0]![0] as string;
    expect(text).toContain('已创建 2 条零件 + 1 个装配件');
    expect(text).toContain('服务端拒绝');
    expect(text).toContain('ASM-2');
    // 回 idle 是安全的：剩下的行里没有已建出的那一组
    expect(api.commitStage.value).toBe('idle');
    expect(api.canSubmit.value).toBe(true);

    // 第二次提交：只发剩下那组，已成功的那组 createAssembly 不会被再调一次
    mocks.createAssembly.mockResolvedValue(okAssembly('3', childNos(bad!)));
    await api.onSubmit();
    expect(mocks.createAssembly).toHaveBeenCalledTimes(3);
    const third = mocks.createAssembly.mock.calls[2]![0] as { drawing_no: string };
    expect(third.drawing_no).toBe(bad!.drawing_no);
    // 补传成功：两个子件各传自己那一页（默认无总装图 ⇒ 顶层不传总装图）
    expect(mocks.uploadAssemblyPdf).not.toHaveBeenCalled();
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0]).sort()).toEqual(['A3-01', 'A3-02']);
    w.unmount();
  });

  it('装配件：网络失败（无业务码）按「成败未知」上报，行留在表里并提示先核对', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    mocks.createAssembly.mockRejectedValue(networkError('网关 502'));

    await api.onSubmit();

    expect(api.assemblies.value).toHaveLength(1);
    const text = mocks.alert.mock.calls[0]![0] as string;
    expect(text).toContain('成功与否未知');
    expect(text).toContain('先到零件 / 装配件列表核对');
    expect(api.commitStage.value).toBe('idle');
    expect(asm.children).toHaveLength(2);
    w.unmount();
  });

  it('装配件：响应的子件数与请求不符 ⇒ 整组不记账（宁可留下核对，也不重提成第二份）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    // 后端只回了 1 个子件（契约要求 2 个）⇒ 这一组的建成事实无法解读
    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm).slice(0, 1)));

    await api.onSubmit();

    expect(api.assemblies.value).toHaveLength(1);
    // 记账为空 ⇒ 主按钮回到「提交创建」，绝不能变成「重试上传」（那会让人以为工单已建）
    expect(api.commitStage.value).toBe('idle');
    expect(mocks.alert.mock.calls[0]![0] as string).toContain('子件数量与请求不一致');
    // 一条上传都不该发（没有可用的 id）
    expect(mocks.uploadAssemblyPdf).not.toHaveBeenCalled();
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();
    w.unmount();
  });

  it('装配件：响应的子件顺序与请求不一致 ⇒ 整组不记账（否则子件 A 的图纸会挂到子件 B 上）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    const nos = childNos(asm);
    expect(nos).toHaveLength(2);
    expect(nos[0]).not.toBe(nos[1]);
    // 长度对得上、只有顺序反了：后端把两个子件建出来了，但返回顺序与请求相反
    mocks.createAssembly.mockResolvedValue(okAssembly('1', [...nos].reverse()));

    await api.onSubmit();

    // 记账必须为空：行留在表里、阶段回 idle（绝不能变成「重试上传」，那会让人以为工单已建）
    expect(api.assemblies.value).toHaveLength(1);
    expect(api.commitStage.value).toBe('idle');
    const text = mocks.alert.mock.calls[0]![0] as string;
    expect(text).toContain('子件顺序与请求不一致');
    // 错序 = 后端很可能已落库（顶层 + 两个子件都建了）⇒ 必须按 unknown 提示先核对
    expect(text).toContain('成功与否未知');
    expect(text).toContain('先到零件 / 装配件列表核对');
    // 一条上传都不该发：错序的 id 对应不上任何一行
    expect(mocks.uploadAssemblyPdf).not.toHaveBeenCalled();
    expect(mocks.uploadPartDrawing).not.toHaveBeenCalled();
    w.unmount();
  });

  it('部分失败后再提交：成功提示只数**本轮**建出的（上一批的记账不许混进来）', async () => {
    // 2026-10-05 回归锁：`onSubmit` 开头的 createdTargets.clear() 曾是零覆盖。
    // 不清的话本轮成功提示会把上一轮「部分失败」时建出的那一批一并数进去，在一个专门
    // 防重复建单的流程里给出自相矛盾的计数（形如「成功创建 3 条零件 + 1 个装配件」，
    // 而本轮只建了 2 个子件 + 1 个装配件）。
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    // 1 个独立零件 + 1 个装配件（2 子件）
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_独立件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value[0]!.customer_id = 'c-root';
    await api.addManualAssembly();
    api.manualAsmForm.drawing_no = 'E42-ASM-009';
    api.manualAsmForm.name = '胶枪内胆总装';
    api.manualAsmForm.file = new File([new Uint8Array([1])], 'manual-asm.pdf');
    await api.confirmManualAssembly();
    const asm = api.assemblies.value[0]!;
    asm.customer_id = 'c-root';
    expect(asm.children).toHaveLength(1);

    // 第一轮：独立零件建成，装配件被明确拒
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: 'P-1', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    mocks.createAssembly.mockRejectedValueOnce(apiError(20308, '一级客户未配置流水号前缀'));
    await api.onSubmit();
    // 独立零件行已建出 ⇒ 被移出表格；装配件行留在表里
    expect(api.standaloneParts.value).toHaveLength(0);
    expect(api.assemblies.value).toHaveLength(1);
    expect(api.commitStage.value).toBe('idle');
    expect(mocks.alert.mock.calls[0]![0] as string).toContain('已创建 1 条零件');

    // 第二轮：只剩装配件这一行
    mocks.createAssembly.mockResolvedValue(okAssembly('9', childNos(asm)));
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.success.mockClear();
    await api.onSubmit();
    await flushPromises();

    // 计数只含本轮：1 个子件（是 t_part 行）+ 1 个装配件。上一轮那条独立零件（P-1）
    // 的记账若没被清掉，这里会变成「2 条零件（其中 1 个为装配件子件）」。
    const okText = mocks.success.mock.calls.map((c) => c[0] as string).join('|');
    expect(okText).toBe(
      '成功创建 1 条零件（其中 1 个为装配件子件） + 1 个装配件\n子件不在零件一览里，请到装配件详情页查看。',
    );
    expect(okText).not.toContain('2 条零件');
    w.unmount();
  });

  it('整组请求失败（多分厂）：已建行移出表格，未知成败的组原样留下并被如实告知', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件1.pdf'), up(2, 'A-2_件2.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value[0]!.customer_id = 'c-a';
    api.standaloneParts.value[1]!.customer_id = 'c-b';
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: 'A1', sourceIndex: 0 }],
      failed: [],
      groupErrors: [{ startIndex: 1, endIndex: 1, customer_id: 'c-b', message: '网关 502' }],
    });

    await api.onSubmit();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(api.standaloneParts.value).toHaveLength(1);
    expect(api.standaloneParts.value[0]!.customer_id).toBe('c-b');
    const text = mocks.alert.mock.calls[0]![0] as string;
    expect(text).toContain('已创建 1 条零件');
    // 该组成败未知，必须说清楚，不能让用户以为「一定没建」
    expect(text).toContain('成功与否未知');
    expect(api.commitStage.value).toBe('idle');

    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: 'B1', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    await api.onSubmit();
    const second = mocks.batchCreateParts.mock.calls[1]![0] as Array<{ customer_id: string }>;
    expect(second).toHaveLength(1);
    expect(second[0]!.customer_id).toBe('c-b');
    w.unmount();
  });
});

describe('并发闸门与「已存在」归一', () => {
  it('提交按钮连点两次只建一次单', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件1.pdf'), up(2, 'A-2_件2.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value.forEach((r) => (r.customer_id = 'c-root'));
    let release: () => void = () => undefined;
    mocks.batchCreateParts.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              created: [
                { id: 'p0', sourceIndex: 0 },
                { id: 'p1', sourceIndex: 1 },
              ],
              failed: [],
              groupErrors: [],
            });
        }),
    );
    mocks.uploadPartDrawing.mockResolvedValue({});

    const first = api.onSubmit();
    const second = api.onSubmit();
    release();
    await Promise.all([first, second]);

    // POST /parts/batch 无幂等键，连点必须只发一次
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0]).sort()).toEqual(['p0', 'p1']);
    w.unmount();
  });

  it('上传响应丢失 → 重试拿到 21108「相同文件已存在」按成功收口', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    const row = api.standaloneParts.value[0]!;
    row.customer_id = 'c-root';
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: '9001', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    // 首轮：后端已写完 t_part_file，响应被掐掉
    mocks.uploadPartDrawing.mockRejectedValueOnce(new Error('请求超时'));

    await api.onSubmit();
    expect(api.getRowPdfCell(row)?.status).toBe('error');
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    expect(mocks.alert.mock.calls[0]![0] as string).toContain('第 9001 号零件');

    // 重试：撞 uk_t_part_file_single（(part_id, kind) 已有文件）
    mocks.alert.mockClear();
    mocks.uploadPartDrawing.mockRejectedValue(apiError(21108, '相同文件已存在'));
    await api.retryFailedUploads();

    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(2);
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    // 21108 归一为「已存在」：不进失败清单、不显示错误、页面正常收口
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(Object.keys(api.pdfUploadCells)).toHaveLength(0);
    expect(api.commitStage.value).toBe('done');
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    w.unmount();
  });

  it('行内重试连点两次只发一次请求', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    const row = api.standaloneParts.value[0]!;
    row.customer_id = 'c-root';
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: '9001', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    mocks.uploadPartDrawing.mockRejectedValue(new Error('boom'));
    await api.onSubmit();
    expect(api.getRowPdfCell(row)?.status).toBe('error');

    // 空闲态允许重试；补传在途时必须置灰（同一 part + kind 重发会撞唯一索引）
    expect(api.cellRetryDisabled.value).toBe(false);
    mocks.uploadPartDrawing.mockReset();
    let release: () => void = () => undefined;
    mocks.uploadPartDrawing.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const first = api.retryUploadByCell(`pdf:${row.pdfSourceUid}`);
    const second = api.retryUploadByCell(`pdf:${row.pdfSourceUid}`);
    expect(api.cellRetryDisabled.value).toBe(true);
    release();
    await Promise.all([first, second]);

    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});

/**
 * 2026-10-04：提交 / 补传在途时表格被改写。
 *
 * `resetCommitState` 会把 `commitStage` 打回 idle，而 `commitStage` 是「第二次建单」唯一
 * 的连点闸门；在途时打掉它，先行的 `onSubmit` 跑完仍会照常收口（成功提示 + 清空 + 跳页），
 * 而 `createdTargets` 已被清空 ⇒ 用户刚建好的行被静默清掉、还收到一条「成功创建 0 条零件」。
 *
 * 两道防线分别锁住：
 *  - `rebuildFromUploads` 的提交在途闸门（第一道，拦住整表换新）；
 *  - `summarizeUploads` 的行集合世代校验（第二道，拦住任何绕过闸门改写行集合的入口）。
 */
describe('提交在途时改写行集合', () => {
  /** 建单成功 + 上传在途（未 resolve）→ 返回「放行全部上传」+ 本次 submit 的 promise。 */
  async function startSubmitInFlight(api: UsePartBatchPdfReturn): Promise<{
    release: () => void;
    done: Promise<void>;
  }> {
    const releases: Array<() => void> = [];
    mocks.uploadPartDrawing.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    mocks.batchCreateParts.mockResolvedValue({
      created: [
        { id: 'p0', sourceIndex: 0 },
        { id: 'p1', sourceIndex: 1 },
      ],
      failed: [],
      groupErrors: [],
    });
    const done = api.onSubmit();
    await flushPromises();
    expect(api.pdfSubmitting.value).toBe(true);
    expect(releases).toHaveLength(2);
    return { release: () => releases.forEach((r) => r()), done };
  }

  it('上传在途时「重新解析」被拦下：行原样保留，不出现假收口', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件1.pdf'), up(2, 'A-2_件2.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value.forEach((r) => (r.customer_id = 'c-root'));
    const uids = api.standaloneParts.value.map((r) => r.uid);
    const { release, done } = await startSubmitInFlight(api);
    mocks.success.mockClear();

    // 用户在上传途中点「重新解析」
    await api.rebuildFromUploads();

    // 第一道防线：解析被拒，表格原样
    expect(mocks.warning).toHaveBeenCalled();
    expect(api.standaloneParts.value.map((r) => r.uid)).toEqual(uids);
    expect(api.pdfBuildingTree.value).toBe(false);
    // 闸门没被 resetCommitState 打掉：阶段仍在 uploading
    expect(api.commitStage.value).toBe('uploading');
    expect(api.canSubmit.value).toBe(false);

    release();
    await done;
    await flushPromises();

    // 正常收口（表格没被换过）：成功提示 + 跳页，且成功数不是 0
    expect(mocks.alert).not.toHaveBeenCalled();
    const okText = mocks.success.mock.calls.map((c) => c[0] as string).join('|');
    expect(okText).toContain('成功创建 2 条零件');
    expect(okText).not.toContain('成功创建 0 条');
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    expect(api.standaloneParts.value).toHaveLength(0);
    w.unmount();
  });

  it('在途时行集合被旁路改写（新增一行）：收口拒绝对不上的表格，不清空不跳页', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件1.pdf'), up(2, 'A-2_件2.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value.forEach((r) => (r.customer_id = 'c-root'));
    const { release, done } = await startSubmitInFlight(api);
    mocks.success.mockClear();

    // 模拟一个不经过第一道闸门的行集合改写（删除行 / 将来新增的入口）——直接往表里
    // 塞一行新行。世代号必须 +1，第二道防线才认得出来。
    api.standaloneParts.value.push({ ...api.standaloneParts.value[0]!, uid: 'bypassed-row' });

    release();
    await done;
    await flushPromises();

    // 绝不静默收口：没有「成功创建」假提示、不跳页、用户新加的行还在
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(api.standaloneParts.value.map((r) => r.uid)).toContain('bypassed-row');
    // 如实说清出路：工单已落库，去零件列表核对
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![1]).toBe('提交结果请到列表核对');
    expect(mocks.alert.mock.calls[0]![0] as string).toContain('工单已经创建');
    // 工单确实建出去了，绝不能退成 idle 让用户重来一遍
    expect(api.commitStage.value).toBe('done');
    w.unmount();
  });
});

// 2026-10-05 新增：含税单价 / 总价随建单一起发（缺陷：表格里填的价三层同时被丢）。
//
// 关键约束（锁死，别在后续重构里放松）：
//   - 后端是 rust `rust_decimal` + `serde-with-str`，**只认字符串**、标度固定 2 位；
//   - 表格里的总价是裸浮点乘（0.1 * 3 === 0.30000000000000004），必须过 `toMoneyString`；
//   - 缺价是 `undefined`（键整个不上线），不是 `null` 也不是 `'0'`。
describe('建单载荷：含税单价 / 总价', () => {
  /** 提交并返回实际发给 batchCreateParts 的 item 数组。 */
  async function submitAndCapture(
    api: UsePartBatchPdfReturn,
    createdCount: number,
  ): Promise<Array<Record<string, unknown>>> {
    mocks.batchCreateParts.mockResolvedValue({
      created: Array.from({ length: createdCount }, (_, i) => ({
        id: `p${i}`,
        sourceIndex: i,
      })),
      failed: [],
    });
    await api.onSubmit();
    await flushPromises();
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    return mocks.batchCreateParts.mock.calls[0]![0] as Array<Record<string, unknown>>;
  }

  it('独立零件：unit_price / total_price 落成 2 位小数字符串', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf'), up(2, 'A-2_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value.forEach((r) => (r.customer_id = 'c-root'));
    const [r0, r1] = api.standaloneParts.value;
    // 整数单价：必须补零到 2 位
    r0!.unit_price = 95;
    r0!.total_price = 190;
    // 浮点尾数：0.1 * 3 = 0.30000000000000004
    r1!.unit_price = 0.1;
    r1!.quantity = 3;
    r1!.total_price = 0.1 * 3;

    const items = await submitAndCapture(api, 2);

    expect(items[0]!.unit_price).toBe('95.00');
    expect(items[0]!.total_price).toBe('190.00');
    expect(items[1]!.unit_price).toBe('0.10');
    expect(items[1]!.total_price).toBe('0.30');
    w.unmount();
  });

  it("缺价：unit_price / total_price 是 undefined（不是 null、不是 '0'）", async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    api.standaloneParts.value[0]!.customer_id = 'c-root';
    expect(api.standaloneParts.value[0]!.unit_price).toBeNull();

    const items = await submitAndCapture(api, 1);

    expect(items[0]!.unit_price).toBeUndefined();
    expect(items[0]!.total_price).toBeUndefined();
    expect(items[0]!.unit_price).not.toBeNull();
    expect(items[0]!.unit_price).not.toBe('0');
    // JSON.stringify 之后这两个键整个消失（后端看不到、走默认 0）
    const wire = JSON.parse(JSON.stringify({ items })) as {
      items: Array<Record<string, unknown>>;
    };
    expect('unit_price' in wire.items[0]!).toBe(false);
    expect('total_price' in wire.items[0]!).toBe(false);
    w.unmount();
  });

  it('装配件：顶层整套价与子件各自的价分开发，不互相污染（走 createAssembly 的 payload）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    // 顶层手填整套价（Excel 口径：整套）
    asm.unit_price = 130;
    asm.total_price = 260;
    // 子件各自手填（Excel 不回填，见 applyExcelToAll）
    asm.children[0]!.unit_price = 7.5;
    asm.children[0]!.total_price = 7.5;
    asm.children[1]!.unit_price = null;
    asm.children[1]!.total_price = null;

    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.onSubmit();

    expect(mocks.createAssembly).toHaveBeenCalledTimes(1);
    const payload = mocks.createAssembly.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.unit_price).toBe('130.00');
    expect(payload.total_price).toBe('260.00');
    const children = payload.children as Array<Record<string, unknown>>;
    expect(children).toHaveLength(2);
    expect(children[0]!.unit_price).toBe('7.50');
    expect(children[0]!.total_price).toBe('7.50');
    // 没填价的子件：键不上线，绝不折成 '0'
    expect(children[1]!.unit_price).toBeUndefined();
    expect(children[1]!.total_price).toBeUndefined();
    w.unmount();
  });

  it('单价联动总价：独立零件 total = unit × quantity；清空单价不动总价', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_件.pdf')];
    await api.rebuildFromUploads();
    const row = api.standaloneParts.value[0];
    if (!row) throw new Error('未生成独立零件行');

    row.quantity = 4;
    api.onUnitPriceChange(row, 12.5);
    expect(row.unit_price).toBe(12.5);
    expect(row.total_price).toBe(50);

    // 清空单价（undefined）只清单价，不动已有总价
    api.onUnitPriceChange(row, undefined);
    expect(row.unit_price).toBeNull();
    expect(row.total_price).toBe(50);
    w.unmount();
  });

  it('单价联动总价：装配件顶层用**套数**、子件用子件数量', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    const [child0] = asm.children;

    // 顶层：quantity 是套数
    asm.quantity = 3;
    api.onAsmUnitPriceChange(asm, 0.1);
    expect(asm.unit_price).toBe(0.1);
    expect(asm.total_price).toBe(0.1 * 3);

    // 子件：quantity 是子件数量
    child0!.quantity = 6;
    api.onChildUnitPriceChange(child0!, 2);
    expect(child0!.unit_price).toBe(2);
    expect(child0!.total_price).toBe(12);

    // 清空单价（undefined）只清单价，不动已有总价
    api.onChildUnitPriceChange(child0!, undefined);
    expect(child0!.unit_price).toBeNull();
    expect(child0!.total_price).toBe(12);
    w.unmount();
  });

  it('草稿快照带出装配件顶层单价 / 总价（刷新后可还原的手填值）', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    asm.unit_price = 88.5;
    asm.total_price = 177;
    await flushPromises();

    const last = mocks.scheduled.at(-1);
    const pdfTab = last?.pdf_tab as {
      assemblies: Array<{ unit_price: number | null; total_price: number | null }>;
    };
    expect(pdfTab.assemblies[0]!.unit_price).toBe(88.5);
    expect(pdfTab.assemblies[0]!.total_price).toBe(177);
    w.unmount();
  });
});

// 2026-10-05：装配件建单载荷（`POST /api/v2/assemblies` 的 `data` JSON）。
//
// 关键约束：
//   - **不传 PDF**（该端点不入库 PDF；总装图走 `/assemblies/{id}/files` 单独上传）；
//   - 顶层字段逐个来自 AssemblyRow，`quantity` 是**套数**；
//   - `children[]` 与表格里的子件行**一一对应、顺序一致**（响应的
//     `created_children[i]` 靠这个顺序对回本地行），子件的价格是子件自己的价；
//   - 金额一律 2 位小数字符串，缺价 = 键不上线（undefined）。
describe('建装配件：payload 形状', () => {
  it('顶层与每个子件的字段逐个落到 data JSON（不传 PDF）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    // 顶层：把所有字段都填成可断言的确定值
    asm.name = '胶枪内胆总装';
    asm.drawing_no = 'E42-GUN-001';
    asm.applicant_name = '程胜志';
    asm.request_date = '2026-10-01';
    asm.planned_delivery_date = '2026-10-20';
    asm.system_delivery_date = '2026-10-15';
    asm.order_no = 'PO-77';
    asm.note = '急';
    asm.is_urgent = true;
    asm.quantity = 3;
    asm.unit_price = 0.1;
    asm.total_price = 0.1 * 3;
    // 子件：逐个填（含价格与交期）
    const [c0, c1] = asm.children;
    c0!.name = '内胆';
    c0!.drawing_no = 'E42-GUN-001-01';
    c0!.quantity = 6;
    c0!.planned_delivery_date = '2026-10-18';
    c0!.unit_price = 0.1;
    c0!.total_price = 0.1 * 6;
    c1!.name = '扳机';
    c1!.drawing_no = 'E42-GUN-001-02';
    c1!.quantity = 1;
    c1!.planned_delivery_date = '2026-10-20';
    c1!.unit_price = null;
    c1!.total_price = null;

    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.onSubmit();

    expect(mocks.createAssembly).toHaveBeenCalledTimes(1);
    const payload = mocks.createAssembly.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({
      name: '胶枪内胆总装',
      drawing_no: 'E42-GUN-001',
      customer_id: 'c-root',
      applicant_name: '程胜志',
      request_date: '2026-10-01',
      planned_delivery_date: '2026-10-20',
      is_urgent: true,
      quantity: 3,
      unit_price: '0.10',
      total_price: '0.30',
      order_no: 'PO-77',
      system_delivery_date: '2026-10-15',
      note: '急',
      children: [
        {
          name: '内胆',
          drawing_no: 'E42-GUN-001-01',
          quantity: 6,
          planned_delivery_date: '2026-10-18',
          unit_price: '0.10',
          total_price: '0.60',
        },
        {
          name: '扳机',
          drawing_no: 'E42-GUN-001-02',
          quantity: 1,
          planned_delivery_date: '2026-10-20',
          unit_price: undefined,
          total_price: undefined,
        },
      ],
    });
    w.unmount();
  });

  it('混合批次：独立零件走 /parts/batch，装配件行走 /assemblies，两路的行绝不串门', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    // 单页 PDF → 独立零件；再手动新增一个装配件（1 页 → 单个子件）
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'A-1_独立件.pdf')];
    await api.rebuildFromUploads();
    const part = api.standaloneParts.value[0]!;
    part.customer_id = 'c-root';
    await api.addManualAssembly();
    api.manualAsmForm.drawing_no = 'E42-ASM-002';
    api.manualAsmForm.name = '胶枪内胆总装';
    api.manualAsmForm.file = new File([new Uint8Array([1])], 'manual-asm.pdf');
    await api.confirmManualAssembly();
    const asm = api.assemblies.value[0]!;
    asm.customer_id = 'c-root';
    expect(asm.children).toHaveLength(1);

    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: 'P-1', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    mocks.createAssembly.mockResolvedValue(okAssembly('2', childNos(asm)));
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.onSubmit();

    // 批量端点只拿到独立零件那一行（装配件的行绝不能被展平塞进来）
    const items = mocks.batchCreateParts.mock.calls[0]![0] as Array<{ drawing_no: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.drawing_no).toBe('A-1');
    expect(items.map((i) => i.drawing_no)).not.toContain('E42-ASM-002');
    // 装配件端点拿到装配件那一行
    const payload = mocks.createAssembly.mock.calls[0]![0] as {
      drawing_no: string;
      children: Array<{ drawing_no: string }>;
    };
    expect(payload.drawing_no).toBe('E42-ASM-002');
    expect(payload.children.map((c) => c.drawing_no)).toEqual(['E42-ASM-002']);
    // 上传各打各的端点：子件图纸打 parts 端点；装配件无总装图 ⇒ 顶层不传
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0])).toEqual(['P-1', 'A2-01']);
    expect(mocks.uploadAssemblyPdf).not.toHaveBeenCalled();
    w.unmount();
  });
});

// 2026-10-05：装配件**逐页分发**。
//
// 缺陷：建行时顶层与全部子件共享同一份原始多页 PDF，上传时每个子件都把整份 PDF 当
// DRAWING 传上去（打印会重复输出全部页），且顶层无条件产生 ASSEMBLY_MASTER（后端
// 「装配件无总装图则跳过总装图页 + 序列号背面」的守卫因此永不生效）。
// 口径：默认无总装图；指定第 k 页为总装图 ⇒ 顶层只传那一个单页切片、该页从子件排除。
describe('装配件逐页分发', () => {
  it('指定总装图：顶层只传那一个单页切片，该页从子件里排除（页不重不漏）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    expect(api.effectiveChildren(asm)).toHaveLength(2);

    api.onAsmMasterPageChange(asm, 0);
    expect(asm.masterPageIndex).toBe(0);
    expect(asm.masterPdfSourceUid).toBe(asm.children[0]!.pdfSourceUid);
    expect(api.effectiveChildren(asm)).toHaveLength(1);
    expect(api.effectiveChildren(asm)[0]!.page_index).toBe(1);
    // 表头计数同步（用户按它核对子件数）
    expect(api.totalAssemblyChildren.value).toBe(1);

    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.onSubmit();

    // 请求里的子件只剩 1 个（= 响应 created_children 长度）
    const payload = mocks.createAssembly.mock.calls[0]![0] as {
      children: Array<Record<string, unknown>>;
    };
    expect(payload.children).toHaveLength(1);
    expect(payload.children[0]!.drawing_no).toBe(asm.children[1]!.drawing_no);
    // 总装图 = 指定的那一页的切片，1 次
    expect(mocks.uploadAssemblyPdf).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAssemblyPdf.mock.calls[0]![0]).toBe('A1');
    expect(mocks.uploadAssemblyPdf.mock.calls[0]![1].name).toBe('ASM-1_总装_p1.pdf');
    // 子件只剩 P2 那一页
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls[0]![0]).toBe('A1-01');
    expect(mocks.uploadPartDrawing.mock.calls[0]![1].name).toBe('ASM-1_总装_p2.pdf');
    const okText = mocks.success.mock.calls.map((c) => c[0] as string).join('|');
    expect(okText).toContain('1 条零件（其中 1 个为装配件子件） + 1 个装配件');
    w.unmount();
  });

  it('改值 / 清空：换页会换切片，清空回到「无总装图」且子件恢复全量', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);

    api.onAsmMasterPageChange(asm, 0);
    expect(asm.masterPdfSourceUid).toBe(asm.children[0]!.pdfSourceUid);
    expect(api.effectiveChildren(asm).map((c) => c.page_index)).toEqual([1]);

    // 换到第 2 页
    api.onAsmMasterPageChange(asm, 1);
    expect(asm.masterPdfSourceUid).toBe(asm.children[1]!.pdfSourceUid);
    expect(api.effectiveChildren(asm).map((c) => c.page_index)).toEqual([0]);

    // 清空（el-select clearable emit undefined）⇒ 无总装图
    api.onAsmMasterPageChange(asm, undefined);
    expect(asm.masterPageIndex).toBeNull();
    expect(asm.masterPdfSourceUid).toBeNull();
    expect(api.effectiveChildren(asm)).toHaveLength(2);
    expect(api.totalAssemblyChildren.value).toBe(2);
    // 表格内容不因「被排除」而丢：切回来时用户填的图号还在
    expect(asm.children.map((c) => c.drawing_no)).toEqual(['ASM-1', 'ASM-1-02']);

    // 选到子件表里不存在的页 ⇒ 不静默，按「无总装图」并提示
    mocks.warning.mockClear();
    api.onAsmMasterPageChange(asm, 7);
    expect(asm.masterPdfSourceUid).toBeNull();
    expect(mocks.warning).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('切片归属：每个子件一份互不相同的单页切片，originPdfUid 指向原始 PDF', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);

    // 切页入参：第 k 个子件切的就是第 k 页（把 copyPagesFrom 写死成 [0] 会被这里抓出来）
    expect(mocks.copyPages.mock.calls.map((c) => c[1])).toEqual([[0], [1]]);

    const uids = asm.children.map((c) => c.pdfSourceUid);
    expect(new Set(uids).size).toBe(2);
    for (const c of asm.children) {
      const src = api.allPdfs.value.find((s) => s.uid === c.pdfSourceUid);
      expect(src).toBeDefined();
      expect(src!.totalPages).toBe(1);
      expect(src!.synthesized).toBe(true);
      expect(src!.originPdfUid).toBe('pdf-1');
      expect(src!.synthesizedFrom).toEqual([{ pdfUid: 'pdf-1', pageIndices: [c.page_index] }]);
      // 顶层 pdfSourceUid 仍指原始 PDF（源文件区预览 / removePdf 级联清理依赖它）
      expect(asm.pdfSourceUid).toBe('pdf-1');
    }
    // 删掉这一行 ⇒ 它持有的切片一并从 allPdfs 摘掉（无人引用）
    const before = api.allPdfs.value.length;
    api.removeAssembly(asm.uid);
    expect(api.allPdfs.value.length).toBe(before - 2);
    w.unmount();
  });

  // 2026-10-05：删原始 PDF 的级联正确性由上面两条约定**共同**成立 ——
  //   ① 顶层 `pdfSourceUid` 指原始 PDF（removePdf 按它摘整行）；
  //   ② 子件切片的 `originPdfUid` 指原始 PDF（removePdf 按它把切片一并摘掉）。
  // 任一条写反的后果不同：② 反了 ⇒ 切片成孤儿留在 allPdfs；① 反了 ⇒ 装配件行不被摘，
  // 它的子件仍指向已被删掉的切片。两条都没用例锁过，这里补。
  it('删掉原始 PDF：装配件整行与它持有的单页切片一并消失（不留孤儿切片）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);

    // 前置：2 个子件切片 + 1 份原始 PDF
    expect(api.allPdfs.value).toHaveLength(3);
    expect(api.allPdfs.value.filter((s) => s.uid.startsWith('syn-'))).toHaveLength(2);
    expect(asm.pdfSourceUid).toBe('pdf-1');

    api.removePdf('pdf-1');

    // 整行摘掉（靠顶层 pdfSourceUid 指原始 PDF）
    expect(api.assemblies.value).toHaveLength(0);
    // 切片一并摘掉（靠切片的 originPdfUid 指原始 PDF），不留指向已删原件的 syn- 条目
    expect(api.allPdfs.value.filter((s) => s.uid.startsWith('syn-'))).toHaveLength(0);
    expect(api.allPdfs.value).toHaveLength(0);
    // 勾选与上传文件也一并清掉（级联的其余两面）
    expect(api.selectedPages.value.size).toBe(0);
    expect(api.pdfFiles.value).toHaveLength(0);
    w.unmount();
  });

  it('切片字节：每个子件上传的是**自己那一页**的字节（整份 PDF 发给每个子件会被抓出来）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);

    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    await api.onSubmit();

    // 假 pdf-lib 把本轮 addPage 的源页下标编码进 save() 的字节 ⇒ 第 k 页切片 = [...PDF, k]
    const bytesOf = async (f: unknown): Promise<number[]> =>
      Array.from(new Uint8Array(await (f as File).arrayBuffer()));
    const byChildId = new Map<string, number[]>();
    for (const [partId, file] of mocks.uploadPartDrawing.mock.calls) {
      byChildId.set(partId as string, await bytesOf(file));
    }
    expect(byChildId.get('A1-01')).toEqual([0x25, 0x50, 0x44, 0x46, 0]);
    expect(byChildId.get('A1-02')).toEqual([0x25, 0x50, 0x44, 0x46, 1]);
    // 显式点出被测的回归：两个子件的字节**不能**相同
    expect(byChildId.get('A1-01')).not.toEqual(byChildId.get('A1-02'));
    w.unmount();
  });

  it('指定总装图：被排除的那一页不产生 3D job（它不建出子件 ⇒ 3D 也不上传）', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    // 3D 索引在这里是手搓的：真实流程里**合并出来的装配件子件拿不到 3D** ——
    // `linkThreeDModelsToRows` 全仓只有一个调用点（`rebuildFromUploads` 内），执行前
    // `assemblies.value` 已清空，而 `onThreeDModelChange` 只追加文件、不重新挂载。
    // 本用例只锁「指定总装图后被排除的那一行不产生 3D job、不占 3D 状态格」这条不变式。
    api.threeDModelFiles.value = [up(9, 'ASM-1_总装.step'), up(10, 'ASM-1-总装-02.step')];
    asm.children[0]!.three_d_index = 0;
    asm.children[1]!.three_d_index = 1;
    api.onAsmMasterPageChange(asm, 0);

    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    // 让唯一那个 3D job 失败：全成功路径会清场（cells + threeDModelFiles 都清空），
    // 失败路径才留得住现场，才能断言「被排除那一行不占 3D 状态格」。
    mocks.uploadPart3DModel.mockRejectedValue(new Error('COS 502'));
    await api.onSubmit();

    // 只剩子件 1（P2）建出子件 ⇒ 只有它的 3D 有 job
    expect(mocks.uploadPart3DModel).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPart3DModel.mock.calls[0]![0]).toBe('A1-01');
    expect(mocks.uploadPart3DModel.mock.calls[0]![1].name).toBe('ASM-1-总装-02.step');
    // 被排除那一行不占 3D 状态格（cell 为 undefined ⇒ 模板什么都不渲染）
    expect(api.getRowThreeDCell(asm.children[0]!)).toBeUndefined();
    expect(api.getRowThreeDCell(asm.children[1]!)?.status).toBe('error');
    w.unmount();
  });

  it('手动新增装配件默认「无总装图」：多页 PDF 也不默认把第 1 页当总装图', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    await api.addManualAssembly();
    api.manualAsmForm.drawing_no = 'E42-ASM-009';
    api.manualAsmForm.name = '胶枪内胆总装';
    api.manualAsmForm.file = new File([new Uint8Array([1])], 'manual-asm.pdf');
    await api.confirmManualAssembly();

    const asm = api.assemblies.value[0]!;
    expect(asm.children).toHaveLength(2);
    expect(asm.masterPageIndex).toBeNull();
    expect(asm.masterPdfSourceUid).toBeNull();
    // 子件各持自己那一页的切片
    expect(new Set(asm.children.map((c) => c.pdfSourceUid)).size).toBe(2);
    w.unmount();
  });

  it('顶层 PDF 状态格：无总装图时为空，指定后指向那个单页切片', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    // null → 不占状态格
    expect(api.getRowPdfCell({ pdfSourceUid: asm.masterPdfSourceUid })).toBeUndefined();

    api.onAsmMasterPageChange(asm, 1);
    mocks.createAssembly.mockResolvedValue(okAssembly('1', childNos(asm)));
    mocks.uploadAssemblyPdf.mockRejectedValue(new Error('COS 502'));
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.onSubmit();

    // 顶层状态格按 masterPdfSourceUid 取；原始 PDF（顶层 pdfSourceUid）不再有 job
    expect(api.getRowPdfCell({ pdfSourceUid: asm.masterPdfSourceUid })?.status).toBe('error');
    expect(api.getRowPdfCell(asm)).toBeUndefined();
    w.unmount();
  });

  it('切页失败：如实提示是哪个文件、不建行、已切出的切片全部回滚', async () => {
    mocks.pageCount = 3;
    // 第 2 次 copyPages 抛错（模拟加密 / xref 异常）⇒ 第 1 页的切片已经进了 allPdfs
    mocks.failOnCopyPagesCall = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'ASM-9_加密.pdf')];
    await api.rebuildFromUploads();
    api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1', 'pdf-1:2']);
    await api.mergeSelectedAsAssembly();

    expect(api.assemblies.value).toHaveLength(0);
    // 提示必须带出是哪个文件
    const errText = mocks.error.mock.calls.map((c) => c[0] as string).join('|');
    expect(errText).toContain('ASM-9_加密.pdf');
    // 已切出的那一片不留悬空：allPdfs 里只剩原始 PDF，没有任何 syn- 切片
    expect(api.allPdfs.value.filter((s) => s.synthesized)).toHaveLength(0);
    expect(api.allPdfs.value).toHaveLength(1);
    w.unmount();
  });

  it('切页在途连点：只建出一行（重入闸门拦住第二次，不产生重复装配件）', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'ASM-2_总装.pdf')];
    await api.rebuildFromUploads();
    api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1']);

    await Promise.all([api.mergeSelectedAsAssembly(), api.mergeSelectedAsAssembly()]);

    expect(api.assemblies.value).toHaveLength(1);
    // 只切了一轮（2 页 = 2 次 copyPages），第二次点击没进切页
    expect(mocks.copyPages).toHaveBeenCalledTimes(2);
    expect(mocks.warning.mock.calls.map((c) => c[0]).join('|')).toContain('正在切页');
    // 第二次点击被闸门挡在切页之前 ⇒ 不该冒出任何切页失败提示
    expect(mocks.error).not.toHaveBeenCalled();
    w.unmount();
  });

  // 2026-10-05：下面这组锁「三个切页入口同一套兜底」。`load` 抛错是 pdf-lib 读不动的
  // 那一类（加密 / xref 异常），它发生在**任何切片登记之前**，比中途失败的用例更靠前。
  it('pdf-lib 读不动：合并为零件（部分页）弹出带文件名的错误、不建行', async () => {
    mocks.pageCount = 3;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'P-7_加密.pdf')];
    await api.rebuildFromUploads();
    api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1']);
    mocks.failOnLoad = true;

    await api.mergeSelectedAsPart();

    expect(api.standaloneParts.value).toHaveLength(0);
    const errText = mocks.error.mock.calls.map((c) => c[0] as string).join('|');
    expect(errText).toContain('P-7_加密.pdf');
    // 失败时一个条目都没登记，不留悬空切片
    expect(api.allPdfs.value.filter((s) => s.synthesized)).toHaveLength(0);
    w.unmount();
  });

  it('pdf-lib 读不动：合并为装配件弹出带文件名的错误、不建行', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'ASM-7_加密.pdf')];
    await api.rebuildFromUploads();
    api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1']);
    mocks.failOnLoad = true;

    await api.mergeSelectedAsAssembly();

    expect(api.assemblies.value).toHaveLength(0);
    const errText = mocks.error.mock.calls.map((c) => c[0] as string).join('|');
    expect(errText).toContain('ASM-7_加密.pdf');
    // load 在 push 原始源之前就抛了 ⇒ allPdfs 只剩重建时那一份
    expect(api.allPdfs.value.filter((s) => s.synthesized)).toHaveLength(0);
    expect(api.allPdfs.value).toHaveLength(1);
    w.unmount();
  });

  it('pdf-lib 读不动：手动新增装配件弹出带文件名的错误、不建行、原始 PDF 回滚', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    await api.addManualAssembly();
    api.manualAsmForm.drawing_no = 'E42-ASM-007';
    api.manualAsmForm.file = new File([new Uint8Array([1])], 'manual-7_加密.pdf');
    mocks.failOnLoad = true;

    await api.confirmManualAssembly();

    expect(api.assemblies.value).toHaveLength(0);
    const errText = mocks.error.mock.calls.map((c) => c[0] as string).join('|');
    expect(errText).toContain('manual-7_加密.pdf');
    // 那份原始 PDF 已进 allPdfs，失败后必须摘掉（否则用户重试会多出一份重复源文件）
    expect(api.allPdfs.value).toHaveLength(0);
    w.unmount();
  });

  it('合并为零件切页在途连点：只建出一行（重入闸门同样覆盖这个入口）', async () => {
    mocks.pageCount = 3;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'P-2_总装.pdf')];
    await api.rebuildFromUploads();
    api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1']);

    await Promise.all([api.mergeSelectedAsPart(), api.mergeSelectedAsPart()]);

    expect(api.standaloneParts.value).toHaveLength(1);
    expect(mocks.warning.mock.calls.map((c) => c[0]).join('|')).toContain('正在切页');
    expect(mocks.error).not.toHaveBeenCalled();
    w.unmount();
  });

  it('合并为零件的全部页分支：不占重入闸门（无合成，后续合并为装配件照常）', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    api.pdfFiles.value = [up(1, 'P-3_单页.pdf')];
    await api.rebuildFromUploads();

    // 全部页 ⇒ 直接复用原 PDF，根本不调 pdf-lib
    api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1']);
    await api.mergeSelectedAsPart();
    expect(mocks.copyPages).not.toHaveBeenCalled();
    expect(api.standaloneParts.value).toHaveLength(1);
    // 没有合成条目，行直接指向原始 PDF
    expect(api.standaloneParts.value[0]!.pdfSourceUid).toBe('pdf-1');
    expect(api.allPdfs.value.filter((s) => s.synthesized)).toHaveLength(0);

    // 闸门没被占死：紧接着合并为装配件（这步要切页）不会被「正在切页」挡掉
    mocks.warning.mockClear();
    api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1']);
    await api.mergeSelectedAsAssembly();
    expect(api.assemblies.value).toHaveLength(1);
    expect(mocks.warning.mock.calls.map((c) => c[0]).join('|')).not.toContain('正在切页');
    w.unmount();
  });

  it('手动新增装配件读不出页数：文案与切页失败区分开、不建行、闸门已复位', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    await api.addManualAssembly();
    api.manualAsmForm.drawing_no = 'E42-ASM-008';
    api.manualAsmForm.file = new File([new Uint8Array([1])], 'manual-8_坏页数.pdf');
    mocks.pageCountThrows = true;

    await api.confirmManualAssembly();

    expect(api.assemblies.value).toHaveLength(0);
    const errText = mocks.error.mock.calls.map((c) => c[0] as string).join('|');
    expect(errText).toContain('manual-8_坏页数.pdf');
    // 两个失败面要说不同的话：读页数失败不许说成切页失败
    expect(errText).toContain('页数');
    expect(errText).not.toContain('切页失败');
    expect(api.allPdfs.value).toHaveLength(0);

    // 闸门已复位（finally 覆盖到 countPdfPages）：换一份正常文件仍能新增
    mocks.error.mockClear();
    mocks.warning.mockClear();
    mocks.pageCountThrows = false;
    await api.addManualAssembly();
    api.manualAsmForm.drawing_no = 'E42-ASM-009';
    api.manualAsmForm.file = new File([new Uint8Array([1])], 'manual-9_正常.pdf');
    await api.confirmManualAssembly();

    expect(api.assemblies.value).toHaveLength(1);
    expect(mocks.warning.mock.calls.map((c) => c[0]).join('|')).not.toContain('正在切页');
    expect(mocks.error).not.toHaveBeenCalled();
    w.unmount();
  });

  it('手动新增装配件在读页数期间连点：只建出一行（闸门占在 countPdfPages 之前）', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    api.pdfForm.customerL1Id = 'c-root';
    await api.addManualAssembly();
    api.manualAsmForm.drawing_no = 'E42-ASM-010';
    api.manualAsmForm.file = new File([new Uint8Array([1])], 'manual-10_总装.pdf');
    // 把「读页数」这一步挂起，模拟大 PDF 的 pdfjs 解析耗时
    let release: () => void = () => undefined;
    mocks.pageCountGate = new Promise<void>((r) => (release = r));

    const p1 = api.confirmManualAssembly();
    const p2 = api.confirmManualAssembly();
    release();
    await Promise.all([p1, p2]);

    expect(api.assemblies.value).toHaveLength(1);
    // 只切了一轮（2 页 = 2 次 copyPages），第二次点击没进切页
    expect(mocks.copyPages).toHaveBeenCalledTimes(2);
    expect(mocks.warning.mock.calls.map((c) => c[0]).join('|')).toContain('正在切页');
    expect(mocks.error).not.toHaveBeenCalled();
    w.unmount();
  });
});
