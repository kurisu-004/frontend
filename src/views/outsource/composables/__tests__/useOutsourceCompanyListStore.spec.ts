// src/views/outsource/composables/__tests__/useOutsourceCompanyListStore.spec.ts
//
// 2026-10-09 新增：外协厂一览页 store 单测，只锁两处回归点：
//
//   1. `options.processOptions` 的**并集**语义 —— 勾选候选全集 =
//      共享 OUTSOURCE 工序列表 ∪ `GET /{id}` 回包的已映射工序。只走共享列表时，
//      「已映射但不在 OUTSOURCE 列表里」（工序被改成 INHOUSE、或被停用）的那一项会
//      从勾选框里凭空消失，用户看不见也取消不掉，保存时那一项被静默删掉。
//   2. `dialogs.onDelete` 失败时**吞掉 rejection**（mutation 的 onError 已弹提示）——
//      OutsourceList 的删除按钮是裸接，不兜就是每次删除失败多一条 unhandledrejection。
//
// mock 策略（照 `useInspectionListStore.spec.ts`）：
//   - `element-plus` 只桩 ElMessage + 列定义 import 的 ElInput / ElTag；
//   - `@/api/outsource` 桩 4 个公司端点（列表是主查询、详情是勾选回包）；
//   - `@/api/process` 桩共享工序下拉（useProcessesQuery 在 store setup 里就 fetch，
//     不桩会走真实 axios 触发未处理 rejection）。
//
// 环境：happy-dom（文件头 pragma）—— `restoreState()` 的持久化恢复要读真实 localStorage。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElInput: { name: 'ElInputStub', template: '<input />' },
  ElTag: { name: 'ElTagStub', template: '<span><slot /></span>' },
}));

vi.mock('@/components/ColumnFilterPopover.vue', () => ({
  default: { name: 'ColumnFilterPopoverStub', template: '<span><slot /></span>' },
}));

const listCompaniesMock = vi.fn();
const getCompanyMock = vi.fn();
const softDeleteCompanyMock = vi.fn();

vi.mock('@/api/outsource', () => ({
  listOutsourceCompanies: (...args: unknown[]) => listCompaniesMock(...args),
  getOutsourceCompany: (...args: unknown[]) => getCompanyMock(...args),
  createOutsourceCompany: vi.fn(),
  updateOutsourceCompany: vi.fn(),
  softDeleteOutsourceCompany: (...args: unknown[]) => softDeleteCompanyMock(...args),
}));

const listProcessesMock = vi.fn();
vi.mock('@/api/process', () => ({
  listProcesses: (...args: unknown[]) => listProcessesMock(...args),
}));

const confirmDangerousMock = vi.fn(async () => true);
vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ dangerous: confirmDangerousMock }),
}));

const { ElMessage } = await import('element-plus');

import { useOutsourceCompanyListStore } from '../useOutsourceCompanyListStore';
import type { OutsourceCompanySchema } from '../outsourceListSchema';

/** OUTSOURCE 工序列表里的两道工序（共享 useProcessesQuery 的返回集）。 */
const PROC_OUT_A = '2000000000001';
const PROC_OUT_B = '2000000000002';
/** 回包里那道不在 OUTSOURCE 列表里的工序（工序被改成 INHOUSE 的历史数据）。 */
const PROC_INHOUSE = '2000000000003';

function setupApp(): QueryClient {
  const app = createApp({});
  app.use(createPinia());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  app.use(VueQueryPlugin, { queryClient });
  setActivePinia(app.config.globalProperties.$pinia);
  return queryClient;
}

/** 等 useQuery 的 scheduler 跑过一轮（与零件一览 / 待品检那份 spec 同款）。 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

function makeRow(overrides: Partial<OutsourceCompanySchema> = {}): OutsourceCompanySchema {
  return {
    id: '9000000000001',
    name: '福州精工外协',
    contact_name: null,
    contact_phone: null,
    address: null,
    is_active: true,
    version: 3,
    ...overrides,
  };
}

function makeProcess(
  id: string,
  code: string,
  name: string,
): Record<string, unknown> {
  return {
    id,
    version: 1,
    code,
    name,
    category: 'OUTSOURCE',
    sort_order: 0,
    requires_approval: false,
    color: null,
    is_cnc: false,
    created_at: '2026-10-01T08:00:00',
    updated_at: '2026-10-01T08:00:00',
  };
}

describe('useOutsourceCompanyListStore —— options 切片的工序勾选并集', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmDangerousMock.mockResolvedValue(true);
    listProcessesMock.mockResolvedValue({
      items: [
        makeProcess(PROC_OUT_A, 'OP10', '外协粗车'),
        makeProcess(PROC_OUT_B, 'OP20', '外协热处理'),
      ],
      total: 2,
      limit: 200,
      offset: 0,
    });
    listCompaniesMock.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    getCompanyMock.mockResolvedValue({
      ...makeRow(),
      processes: [
        { process_id: PROC_OUT_A, process_code: 'OP10', process_name: '外协粗车' },
        { process_id: PROC_INHOUSE, process_code: 'IP10', process_name: '自产车削' },
      ],
    });
    setupApp();
    try {
      localStorage.clear();
    } catch {
      // node 环境不可用时忽略
    }
  });

  it('CL1：新建态（无回包）→ 勾选项就是全部 OUTSOURCE 工序', async () => {
    const store = useOutsourceCompanyListStore();
    store.query.restoreState();
    await tick();

    expect(store.options.processOptions.map((o) => o.id)).toEqual([PROC_OUT_A, PROC_OUT_B]);
  });

  it('CL2：编辑态 → 回包里不在 OUTSOURCE 列表的已映射工序被补进勾选项（可见可取消）', async () => {
    const store = useOutsourceCompanyListStore();
    store.query.restoreState();
    await tick();

    await store.dialogs.openEdit(makeRow());
    await tick();

    expect(store.options.processOptions.map((o) => o.id)).toEqual([
      PROC_OUT_A,
      PROC_OUT_B,
      PROC_INHOUSE,
    ]);
    expect(store.options.processOptions[2].label).toContain('（非外协工序）');
    // 勾选值由回包整份回填 —— 用户取消那一位后保存才会真的删掉映射。
    expect(store.dialogs.form.process_ids).toEqual([PROC_OUT_A, PROC_INHOUSE]);
  });

  it('CL3：编辑态下已在 OUTSOURCE 列表里的已映射工序不重复出现（并集去重）', async () => {
    const store = useOutsourceCompanyListStore();
    store.query.restoreState();
    await tick();

    await store.dialogs.openEdit(makeRow());
    await tick();

    const ids = store.options.processOptions.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('useOutsourceCompanyListStore —— dialogs.onDelete 的错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmDangerousMock.mockResolvedValue(true);
    listProcessesMock.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    listCompaniesMock.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    softDeleteCompanyMock.mockResolvedValue(undefined);
    setupApp();
  });

  it('CL4：软删失败 → 包装 resolve、ElMessage.error 一次（onError 已提示）', async () => {
    softDeleteCompanyMock.mockRejectedValueOnce(new Error('21205 公司仍映射工序'));
    const store = useOutsourceCompanyListStore();

    await expect(store.dialogs.onDelete(makeRow())).resolves.toBeUndefined();
    expect(ElMessage.error).toHaveBeenCalledWith('21205 公司仍映射工序');
  });

  it('CL5：用户在确认框点取消 → 零请求', async () => {
    confirmDangerousMock.mockResolvedValueOnce(false);
    const store = useOutsourceCompanyListStore();

    await store.dialogs.onDelete(makeRow());

    expect(softDeleteCompanyMock).not.toHaveBeenCalled();
  });
});