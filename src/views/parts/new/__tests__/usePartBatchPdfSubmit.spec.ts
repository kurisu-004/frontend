// 2026-10-04 新增：Tab 2「PDF 批量上传」单按钮提交流程（建工单 + 逐 part 后置上传）。
//
// 同目录 usePartBatchPdf.spec.ts 锁的是 Excel 回填口径，本 spec 锁提交链路：
//   - 一次点击 = 建工单（POST /parts/batch）+ 逐 part 补传图纸 / 3D；
//   - item 不带 drawing_file / model3d_file（文件走后置上传）；
//   - 服务端拒行 → 回 idle，**一个文件都不上传**；
//   - 建单「部分行成立」→ 建成的行移出本地表格，再提交只发剩下的失败行；
//   - 上传失败 → done 态 + 保留现场 + 弹失败清单，重试**只重传不重复建单**；
//   - 同一份 PDF 被装配件 master + N 子件共享 → N+1 次上传（每 part 各一次）；
//   - 重试按 **job**（part × 文件）粒度：共享 PDF 部分失败时只补传失败的那一个，
//     已成功的绝不重传（重传会撞后端 uk_t_part_file_single 报 21108）；
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
  uploadPartDrawing: vi.fn(),
  uploadPart3DModel: vi.fn(),
  alert: vi.fn(),
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
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
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

function need(): UsePartBatchPdfReturn {
  if (!captured) throw new Error('no');
  return captured;
}

beforeEach(() => {
  mocks.pageCount = 1;
  mocks.batchCreateParts.mockReset();
  mocks.uploadPartDrawing.mockReset();
  mocks.uploadPart3DModel.mockReset();
  mocks.alert.mockReset();
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

  it('装配件：master + N 子件共享同一 PDF → N+1 次上传；子件 3D 各传一次', async () => {
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

    mocks.batchCreateParts.mockResolvedValue({
      created: [
        { id: 'M1', sourceIndex: 0 },
        { id: 'C1', sourceIndex: 1 },
        { id: 'C2', sourceIndex: 2 },
      ],
      failed: [],
    });
    await api.onSubmit();
    // 3 个 part 都引用同一 PDF → 3 次图纸上传；仅 C1 挂 3D → 1 次
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(3);
    expect(mocks.uploadPart3DModel).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPart3DModel.mock.calls[0]![0]).toBe('C1');
    expect(mocks.uploadPart3DModel.mock.calls[0]![1].name).toBe('ASM-1_总装.step');
    expect(mocks.alert).not.toHaveBeenCalled();
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

/** 装配件（master + N 子件共享同一 PDF）解析到 api 上，返回顶层行。 */
async function mountAssembly(api: UsePartBatchPdfReturn): Promise<AssemblyRow> {
  api.pdfForm.customerL1Id = 'c-root';
  api.pdfFiles.value = [up(1, 'ASM-1_总装.pdf')];
  await api.rebuildFromUploads();
  api.selectedPages.value = new Set(['pdf-1:0', 'pdf-1:1']);
  await api.mergeSelectedAsAssembly();
  api.assemblies.value[0]!.customer_id = 'c-root';
  return api.assemblies.value[0]!;
}

describe('上传重试（job 粒度）', () => {
  it('共享 PDF 部分失败：重试只补传失败的那个 part，已成功的不重传', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    expect(asm.children).toHaveLength(2);
    mocks.batchCreateParts.mockResolvedValue({
      created: [
        { id: 'M1', sourceIndex: 0 },
        { id: 'C1', sourceIndex: 1 },
        { id: 'C2', sourceIndex: 2 },
      ],
      failed: [],
    });
    // 首轮：master + C1 成功，C2 网络失败
    mocks.uploadPartDrawing.mockImplementation(async (pid: string) => {
      if (pid === 'C2') throw new Error('网络中断');
    });

    await api.onSubmit();
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(3);
    // 三个 part 共用一个 cell：任一 job 失败即 error
    expect(api.getRowPdfCell(asm)?.status).toBe('error');
    expect(api.submitLabel.value).toBe('重试上传（1 项）');
    const firstAlert = mocks.alert.mock.calls[0]![0] as string;
    // 计数口径 = job：1 项 = 1 个零件的 1 个文件，清单也只有那一行
    expect(firstAlert).toContain('1 项上传失败（涉及 1 个零件 / 1 个文件）');
    expect(firstAlert).toContain('第 C2 号零件');
    expect(firstAlert).not.toContain('第 M1 号零件');
    expect(api.assemblies.value).toHaveLength(1);

    // 重试：若把已成功的 M1/C1 也重跑，后端 uk_t_part_file_single 会回
    // 21108「相同文件已存在」；这里让它们真的报错，验证重试压根没碰它们。
    mocks.uploadPartDrawing.mockReset();
    mocks.uploadPartDrawing.mockImplementation(async (pid: string) => {
      if (pid !== 'C2') throw new Error('相同文件已存在');
    });
    await api.retryFailedUploads();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls[0]![0]).toBe('C2');
    // 补传成功 ⇒ 正常收口：清空现场 + 跳零件列表
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.routerPush).toHaveBeenCalledWith('/parts?status=PENDING');
    expect(api.assemblies.value).toHaveLength(0);
    w.unmount();
  });

  it('行内重试：只补传该 cell 下失败的 job，修好后正常收口（提示 + 清空 + 跳页）', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    mocks.batchCreateParts.mockResolvedValue({
      created: [
        { id: 'M1', sourceIndex: 0 },
        { id: 'C1', sourceIndex: 1 },
        { id: 'C2', sourceIndex: 2 },
      ],
      failed: [],
    });
    mocks.uploadPartDrawing.mockImplementation(async (pid: string) => {
      if (pid === 'C2') throw new Error('网络中断');
    });
    await api.onSubmit();
    expect(api.getRowPdfCell(asm)?.status).toBe('error');

    mocks.uploadPartDrawing.mockReset();
    mocks.uploadPartDrawing.mockImplementation(async (pid: string) => {
      if (pid !== 'C2') throw new Error('相同文件已存在');
    });
    await api.retryUploadByCell('pdf:pdf-1');

    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing.mock.calls[0]![0]).toBe('C2');
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
    // 如实告知「已创建 M 条工单」
    const text = mocks.alert.mock.calls[0]![0] as string;
    expect(text).toContain('已创建 2 条工单');
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

  it('装配件：顶层 + 一个子件建出、另一个子件被拒 → 只发剩下那个子件', async () => {
    mocks.pageCount = 2;
    const w = mount(Harness);
    await flushPromises();
    const api = need();
    const asm = await mountAssembly(api);
    const rejected = asm.children[0]!;
    mocks.uploadPartDrawing.mockResolvedValue({});
    mocks.batchCreateParts.mockResolvedValue({
      created: [
        { id: 'M1', sourceIndex: 0 },
        { id: 'C2', sourceIndex: 2 },
      ],
      failed: [{ index: 1, message: '子件被拒' }],
      groupErrors: [],
    });

    await api.onSubmit();

    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    // 行留着（被拒子件的数据在这里），建出的子件已摘走
    expect(api.assemblies.value).toHaveLength(1);
    expect(api.assemblies.value[0]!.uid).toBe(asm.uid);
    expect(api.assemblies.value[0]!.children.map((c) => c.uid)).toEqual([rejected.uid]);
    expect(api.commitStage.value).toBe('idle');

    // 第二次只发被拒的那个子件：顶层 M1 已建出，重发就是重复建单
    mocks.batchCreateParts.mockResolvedValue({
      created: [{ id: 'C1', sourceIndex: 0 }],
      failed: [],
      groupErrors: [],
    });
    await api.onSubmit();
    const second = mocks.batchCreateParts.mock.calls[1]![0] as Array<{ drawing_no: string }>;
    expect(second).toHaveLength(1);
    expect(second[0]!.drawing_no).toBe(rejected.drawing_no);
    expect(mocks.uploadPartDrawing.mock.calls.map((c) => c[0])).toEqual(['C1']);
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
    expect(text).toContain('已创建 1 条工单');
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
