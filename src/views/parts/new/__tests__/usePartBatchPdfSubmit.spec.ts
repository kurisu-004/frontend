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
//   - 同一份 PDF 被装配件顶层 + N 子件共享 → N+1 次上传（每个实体各一次）；
//   - 重试按 **job**（目标实体 × 文件）粒度：共享 PDF 部分失败时只补传失败的那一个，
//     已成功的绝不重传（重传会撞后端 uk_t_part_file_owner_kind_sha 报 21108）；
//   - 建单之后任何抛错都不许把阶段退回 idle（否则再点一次 = 同一批工单建第二遍）；
//   - job 列表没登记上时主按钮必须仍是可点的「重试上传」，出路是现场重建 job。
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
  /** draft.saver.schedule 收到的 payload 队列（末条即最新快照）。 */
  scheduled: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/utils/pdfjs', () => ({ countPdfPages: async () => mocks.pageCount }));
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

/** `POST /assemblies` 201 响应里实现真正读的字段：`assembly.id` + `created_children[].id`。 */
interface FakeAssemblyResult {
  assembly: { id: string };
  created_children: Array<{ id: string; serial_no: string }>;
}

/**
 * 按子件数造一个合法的建装配件响应。`tag` 让每次调用的 id 唯一（顶层 `A<tag>`、
 * 子件 `A<tag>-01/-02`），这样「哪一次请求建的」在断言里一目了然。
 */
function okAssembly(tag: string, childCount: number): FakeAssemblyResult {
  return {
    assembly: { id: `A${tag}` },
    created_children: Array.from({ length: childCount }, (_, i) => ({
      id: `A${tag}-${String(i + 1).padStart(2, '0')}`,
      // 后端子件序列号格式 `{asm_serial}-{i:02d}`（1-based）
      serial_no: `A${tag}-${String(i + 1).padStart(2, '0')}`,
    })),
  };
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

  it('装配件：一次 POST /assemblies 建出顶层 + 子件；总装图打 /assemblies/{id}/files、子件图纸打 /parts/{id}/upload-drawing', async () => {
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

    mocks.createAssembly.mockResolvedValue(okAssembly('1', 2));
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

    // 总装图 → 装配件端点（一次，assemblyId = 响应的 assembly.id）
    expect(mocks.uploadAssemblyPdf).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAssemblyPdf.mock.calls[0]![0]).toBe('A1');
    expect(mocks.uploadAssemblyPdf.mock.calls[0]![1].name).toBe('ASM-1_总装.pdf');
    // 子件图纸 → parts 端点，id 来自响应的 created_children[].id
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(2);
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0]).sort()).toEqual(['A1-01', 'A1-02']);
    // 仅子件 0 挂 3D → 1 次，且打在子件 id 上
    expect(mocks.uploadPart3DModel).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPart3DModel.mock.calls[0]![0]).toBe('A1-01');
    expect(mocks.uploadPart3DModel.mock.calls[0]![1].name).toBe('ASM-1_总装.step');
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(api.commitStage.value).toBe('done');
    // 2026-10-05：子件挂上 assembly_id 后不进入零件一览 ⇒ 成功提示必须说清去哪看
    const okText = mocks.success.mock.calls.map((c) => c[0] as string).join('|');
    expect(okText).toContain('1 个装配件（含 2 个子件）');
    expect(okText).toContain('装配件详情页');
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

/** 装配件（顶层 + N 子件共享同一 PDF）解析到 api 上，返回顶层行。 */
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
  it('共享 PDF 部分失败：重试只补传失败的那个实体，已成功的不重传', async () => {
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    expect(asm.children).toHaveLength(2);
    mocks.createAssembly.mockResolvedValue(okAssembly('1', 2));
    // 首轮：两个子件图纸成功，装配件总装图网络失败
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.uploadAssemblyPdf.mockRejectedValueOnce(new Error('网络中断'));

    await api.onSubmit();
    // 1 个装配件 + 2 个子件共 3 次图纸上传
    expect(mocks.uploadAssemblyPdf).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(2);
    // 三个实体共用一个 cell：任一 job 失败即 error
    expect(api.getRowPdfCell(asm)?.status).toBe('error');
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    const firstAlert = mocks.alert.mock.calls[0]![0] as string;
    // 计数口径 = job：1 项 = 1 个工单的 1 个文件，清单也只有那一行；装配件顶层标「装配件 A1」
    expect(firstAlert).toContain('1 项上传失败（涉及 1 个工单 / 1 个文件）');
    expect(firstAlert).toContain('装配件 A1');
    expect(firstAlert).not.toContain('A1-01');
    expect(api.assemblies.value).toHaveLength(1);

    // 重试：若把已成功的两个子件也重跑，后端 uk_t_part_file_owner_kind_sha 会回
    // 21108「相同文件已存在」；这里让它们真的报错，验证重试压根没碰它们。
    mocks.uploadPartDrawing.mockReset();
    mocks.uploadPartDrawing.mockRejectedValue(new Error('相同文件已存在'));
    mocks.uploadAssemblyPdf.mockReset();
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    await api.retryFailedUploads();

    // 重试只补传，**绝不重新建单**（两个建单端点都无幂等键）
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
    await mountAssembly(api);
    mocks.createAssembly.mockResolvedValue(okAssembly('1', 2));
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.uploadAssemblyPdf.mockRejectedValue(new Error('网络中断'));
    await api.onSubmit();
    expect(api.getRowPdfCell(api.assemblies.value[0]!)?.status).toBe('error');

    mocks.uploadAssemblyPdf.mockReset();
    mocks.uploadAssemblyPdf.mockResolvedValue([]);
    await api.retryUploadByCell('pdf:pdf-1');

    expect(mocks.createAssembly).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAssemblyPdf).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAssemblyPdf.mock.calls[0]![0]).toBe('A1');
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

    // File 恢复后点「重试上传」：用 createdPartIds + itemRowUids 现场重建 job 再补传
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
    // 一个畸形元素时，forEach 会在已经把前几个 part 写进 createdPartIds 之后抛错。
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
      .mockResolvedValueOnce(okAssembly('1', 2))
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
    mocks.createAssembly.mockResolvedValue(okAssembly('3', 2));
    await api.onSubmit();
    expect(mocks.createAssembly).toHaveBeenCalledTimes(3);
    const third = mocks.createAssembly.mock.calls[2]![0] as { drawing_no: string };
    expect(third.drawing_no).toBe(bad!.drawing_no);
    // 补传成功：总装图打装配件端点、两个子件图纸打 parts 端点
    expect(mocks.uploadAssemblyPdf.mock.calls.map((c) => c[0])).toEqual(['A3']);
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
    await mountAssembly(api);
    // 后端只回了 1 个子件（契约要求 2 个）⇒ 这一组的建成事实无法解读
    mocks.createAssembly.mockResolvedValue(okAssembly('1', 1));

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
 * 而 `createdPartIds` 已被清空 ⇒ 用户刚建好的行被静默清掉、还收到一条「成功创建 0 条零件」。
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

    mocks.createAssembly.mockResolvedValue(okAssembly('1', 2));
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

    mocks.createAssembly.mockResolvedValue(okAssembly('1', 2));
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
    mocks.createAssembly.mockResolvedValue(okAssembly('2', 1));
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
    // 上传各打各的端点
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0])).toEqual(['P-1', 'A2-01']);
    expect(mocks.uploadAssemblyPdf.mock.calls.map((c) => c[0])).toEqual(['A2']);
    w.unmount();
  });
});
