// 2026-10-04 新增：Tab 2「PDF 批量上传」单按钮提交流程（建工单 + 逐 part 后置上传）。
//
// 同目录 usePartBatchPdf.spec.ts 锁的是 Excel 回填口径，本 spec 锁提交链路：
//   - 一次点击 = 建工单（POST /parts/batch）+ 逐 part 补传图纸 / 3D；
//   - item 不带 drawing_file / model3d_file（文件走后置上传）；
//   - 服务端拒行 → 回 idle，**一个文件都不上传**；
//   - 上传失败 → done 态 + 保留现场 + 弹失败清单，重试**只重传不重复建单**；
//   - 同一份 PDF 被装配件 master + N 子件共享 → N+1 次上传（每 part 各一次）；
//   - 重试按 **job**（part × 文件）粒度：共享 PDF 部分失败时只补传失败的那一个，
//     已成功的绝不重传（重传会撞后端 uk_t_part_file_single 报 21108）；
//   - 建单之后任何抛错都不许把阶段退回 idle（否则再点一次 = 同一批工单建第二遍）。
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
  it('job 登记前抛错：不回 idle、不重复建单', async () => {
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
    // 阶段停在 done：主按钮禁用，再点也进不去建单路径
    expect(api.commitStage.value).toBe('done');
    expect(api.canSubmit.value).toBe(false);
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![1]).toBe('文件上传未开始');

    await api.onSubmit();
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
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
    });
    mocks.uploadPartDrawing.mockResolvedValue({});
    await api.onSubmit();
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(mocks.uploadPartDrawing).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});
