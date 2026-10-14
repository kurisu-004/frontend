// @vitest-environment happy-dom
// src/views/parts/list/composables/__tests__/useSerialRelease.spec.ts
//
// 2026-10-19 新增：`useSerialRelease`（一键释放终态工单占用的序列号）的行为守卫。
//
// ⚠️ **U2 是本 spec 存在的理由**：api 层按 CLAUDE.md「守门点随分层搬家」只发请求、
// 不做 parse（parse 返回深拷贝，api 层再走一遍等于同一份数据被校验并克隆两遍），所以
// 一旦有人把 mutationFn 里的 `releaseTerminalSerialsOutSchema.parse(...)` 整段删掉，
// api 层那份负向守卫（`src/api/__tests__/serial.spec.ts` 断言 api 不 parse）**照样全绿**，
// 而线上是「后端漏发一个字段 → 确认框里少渲染一列，且不可撤销的释放已执行」。
// 只有在这里 mock 一份**缺必填字段的坏响应**、断言它进不了 preview，才能把这个洞补上。
//
// 覆盖：
//   - U1：预览成功 ⇒ previewOpen 变 true，计数与明细原样带出（dry_run 段）；
//   - U2：api 返坏响应（缺 assembly_count）⇒ mutationFn 抛 ⇒ 对话框不开 + ElMessage.error；
//   - U3：released_total === 0 ⇒ 空态上屏 + 确认按钮 disabled（挂对话框组件断言，EP 走模板桩）；
//   - U4：实跑成功 ⇒ 五个域前缀**各失效一次**（逐个断言 queryKey）；
//   - U5：实跑失败 ⇒ 同样失效 + ElMessage.error（响应可能在 commit 之后丢失）；
//   - U6：入口判据是角色 MANAGER（ADMIN 由 hasRole 通配；CLERK 看不到入口）；
//   - U7：取消只关对话框、不发写请求；
//   - U8：确认入口的**函数级闸** —— 无 preview / 零条可释放 ⇒ 零请求 + warning
//         （按钮的 `:disabled` 不是唯一闸门）；
//   - U9：关对话框的**两条路径**（× 与「取消」）都清掉已消费的明细快照；
//   - U10：实跑回显 dry_run=true（请求的是实跑）⇒ 报错而不是报成功；
//   - U11：预览回显 dry_run=false（请求的是预览）⇒ 报错 + 对话框不开（与 U10 成对；这条
//         方向的后果更重 —— 一次本该只读的请求真跑了不可逆释放，管理员却以为只是预览）。
//
// 依赖处理：
// - useSerialRelease 内部调 useQueryClient（需要 app.runWithContext 提供 inject 上下文）；
// - useAuthStore（Pinia setup store）内含 useQueryClient ⇒ 注册 VueQueryPlugin + QueryClient；
// - ElMessage 桩成 no-op（node 环境真实 ElMessage 会因 `document is not defined` 污染输出）；
// - api 层桩掉，只留形状可断言的响应。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, type App } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const releaseMock = vi.fn();

vi.mock('@/api/serial', () => ({
  releaseTerminalSerials: (payload: unknown) => releaseMock(payload),
}));

// useAuthStore 从这里取 login / logout / me，不桩会发真实请求。
vi.mock('@/api/iam', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}));

import { useSerialRelease } from '../useSerialRelease';
import SerialReleasePreviewDialog from '../../components/SerialReleasePreviewDialog.vue';
import { useAuthStore } from '@/stores/auth';
import { ElMessage } from 'element-plus';
import { qk } from '@/composables/queries/keys';
import type { CurrentUser } from '@/types/user';
import type { ReleaseTerminalSerialsData } from '../serialReleaseSchema';

// ---------------------------------------------------------------- fixtures

function makeOut(overrides: Partial<ReleaseTerminalSerialsData> = {}): ReleaseTerminalSerialsData {
  return {
    dry_run: true,
    assembly_count: 1,
    part_count: 1,
    released_total: 2,
    truncated: false,
    affected: [
      {
        kind: 'ASSEMBLY',
        id: '1900000000000000001',
        serial_no: 'WO-2026-0001',
        drawing_no: 'DWG-A-01',
        status: 'COMPLETED',
      },
      {
        kind: 'PART',
        id: '1900000000000000002',
        serial_no: 'WO-2026-0002',
        // ⚠️ 恒非空（后端两列均 NOT NULL，`dto.rs` 声明成 `String`）。这里写 `null` 会让
        // fixture 自身过不了守门，而 makeOut 的返回值类型也不再与 `*Data` 一致。
        drawing_no: 'DWG-B-02',
        status: 'CANCELLED',
      },
    ],
    ...overrides,
  };
}

function loginAs(roles: string[]): void {
  const auth = useAuthStore();
  const user: CurrentUser = {
    id: '1',
    username: 'u',
    full_name: '测试',
    is_active: true,
    roles: roles as CurrentUser['roles'],
    shelf_ids: [],
    menus: [],
    permissions: [],
  };
  auth.user = user;
}

// ---------------------------------------------------------------- EP 桩（U3 挂对话框）

const MockElDialog = defineComponent({
  name: 'ElDialog',
  props: ['modelValue', 'title'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'mock-dialog' }, [
        h('div', { class: 'mock-dialog-title' }, String(props.title ?? '')),
        props.modelValue ? slots.default?.() : null,
        slots.footer?.(),
      ]);
  },
});

/** `el-button` 桩：把 `disabled` 渲染成真实 `<button disabled>` 以便断言，
 *  `loading` / `onClick` 一并透传（确认按钮的 disabled 由 `released_total === 0` 驱动）。 */
const ElButtonStub = defineComponent({
  name: 'ElButton',
  inheritAttrs: false,
  props: ['type', 'loading', 'disabled'],
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'button',
        {
          class: ['mock-button', `mock-button-${String(props.type ?? 'default')}`],
          disabled: Boolean(props.disabled),
          'data-loading': String(Boolean(props.loading)),
          onClick: () => (attrs.onClick as (() => void) | undefined)?.(),
        },
        slots.default?.(),
      );
  },
});

const MockElEmpty = defineComponent({
  name: 'ElEmpty',
  props: ['description'],
  setup(props) {
    return () => h('div', { class: 'mock-empty' }, String(props.description ?? ''));
  },
});

const MockElTag = defineComponent({
  name: 'ElTag',
  inheritAttrs: false,
  props: ['type', 'size', 'effect'],
  setup(_p, { slots }) {
    return () => h('span', { class: 'mock-tag' }, slots.default?.());
  },
});

/** `el-table` / `el-table-column` 桩：只渲染 `data` 逐行（明细行文案可断言），
 * 列的 slot 渲染不了（真实 el-table 的 scope slot 需要列实例上下文）—— 本 spec 只
 * 断言「行数上屏 + 空态 / 确认按钮禁用」，表格逐格渲染由 serialReleaseSchema 的
 * 逐键守卫兜住。 */
const MockElTable = defineComponent({
  name: 'ElTable',
  props: ['data'],
  setup(props) {
    return () =>
      h(
        'div',
        { class: 'mock-table' },
        (props.data as { serial_no: string }[]).map((r) => h('div', r.serial_no)),
      );
  },
});

const MockElTableColumn = defineComponent({
  name: 'ElTableColumn',
  setup() {
    return () => null;
  },
});

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text);
}

function mountDialog(preview: ReleaseTerminalSerialsData | null, applyPending = false) {
  return mount(SerialReleasePreviewDialog, {
    props: { modelValue: true, preview, applyPending },
    global: {
      components: {
        'el-dialog': MockElDialog,
        'el-button': ElButtonStub,
        'el-empty': MockElEmpty,
        'el-tag': MockElTag,
        'el-table': MockElTable,
        'el-table-column': MockElTableColumn,
      },
    },
  });
}

// ---------------------------------------------------------------- 用例

describe('useSerialRelease — 一键释放终态序列号（2026-10-19）', () => {
  let app: App;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    releaseMock.mockReset();
    releaseMock.mockResolvedValue(makeOut());
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    app = createApp({});
    app.use(createPinia());
    app.use(VueQueryPlugin, { queryClient });
    setActivePinia(app.config.globalProperties.$pinia);
    loginAs(['MANAGER']);
  });

  afterEach(() => {
    queryClient.unmount();
    vi.restoreAllMocks();
  });

  it('U1：预览成功 ⇒ 对话框打开，计数与明细原样带出（只打 dry_run 段）', async () => {
    const serial = app.runWithContext(() => useSerialRelease());
    expect(serial.previewOpen.value).toBe(false);

    await serial.onOpenPreview();

    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith({ dry_run: true });
    expect(serial.previewOpen.value).toBe(true);
    expect(serial.preview.value?.assembly_count).toBe(1);
    expect(serial.preview.value?.part_count).toBe(1);
    expect(serial.preview.value?.released_total).toBe(2);
    expect(serial.preview.value?.affected).toHaveLength(2);
  });

  it('U2：api 返坏响应（缺 assembly_count）⇒ 守门抛错，对话框不开 + ElMessage.error', async () => {
    // 缺必填键的坏响应（后端形状漂移的最小模拟）。**把 mutationFn 里的 parse 整段删掉
    // 时本条必须变红** —— 那正是 api 层负向守卫（断言 api 不 parse）看不见的一半。
    const bad = makeOut();
    delete (bad as unknown as Record<string, unknown>).assembly_count;
    releaseMock.mockResolvedValue(bad);

    const serial = app.runWithContext(() => useSerialRelease());
    await serial.onOpenPreview();

    expect(serial.previewOpen.value).toBe(false);
    expect(serial.preview.value).toBeNull();
    expect(ElMessage.error).toHaveBeenCalledTimes(1);
  });

  it('U3：released_total === 0 ⇒ 空态上屏 + 确认按钮 disabled', async () => {
    releaseMock.mockResolvedValue(
      makeOut({ assembly_count: 0, part_count: 0, released_total: 0, affected: [] }),
    );
    const serial = app.runWithContext(() => useSerialRelease());
    await serial.onOpenPreview();
    expect(serial.preview.value?.released_total).toBe(0);

    const wrapper = mountDialog(serial.preview.value, serial.applyPending.value);
    expect(wrapper.find('.mock-empty').text()).toBe('没有需要释放的序列号');
    expect(buttonByText(wrapper, '确认释放')?.attributes('disabled')).toBeDefined();
    wrapper.unmount();

    // 非空时确认按钮可点（避免「永远禁用」这种把功能做死的实现也能过本条）
    releaseMock.mockResolvedValue(makeOut());
    const other = app.runWithContext(() => useSerialRelease());
    await other.onOpenPreview();
    const ok = mountDialog(other.preview.value, false);
    expect(ok.findAll('.mock-table > div').map((n) => n.text())).toEqual([
      'WO-2026-0001',
      'WO-2026-0002',
    ]);
    expect(buttonByText(ok, '确认释放')?.attributes('disabled')).toBeUndefined();
    ok.unmount();
  });

  it('U4：实跑成功 ⇒ 五个域前缀各失效一次，关对话框 + ElMessage.success', async () => {
    // ⚠️ 两次请求的回显**必须分开设**：preview 那一次要回显 `dry_run: true`（preview 路径
    // 带回显断言，回 false 会被当场拒绝、对话框根本不开），实跑那一次才回 false。
    releaseMock.mockResolvedValue(makeOut());
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const serial = app.runWithContext(() => useSerialRelease());
    await serial.onOpenPreview();
    invalidateSpy.mockClear();

    releaseMock.mockResolvedValue(
      makeOut({ dry_run: false, assembly_count: 3, part_count: 5, released_total: 8 }),
    );
    await serial.onConfirmRelease();

    expect(releaseMock).toHaveBeenCalledTimes(2);
    expect(releaseMock.mock.calls[1]![0]).toEqual({ dry_run: false });
    expect(invalidateSpy).toHaveBeenCalledTimes(5);
    for (const key of [
      qk.partsPrefix,
      qk.assemblyPrefix,
      qk.partDetailPrefix,
      qk.statisticsPrefix,
      qk.dashboardPrefix,
    ]) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: key });
    }
    // 刻意不含生产队列前缀（判据是 status，本次只改 serial_no）
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: qk.productionQueueSnapshotPrefix });

    expect(serial.previewOpen.value).toBe(false);
    expect(ElMessage.success).toHaveBeenCalledWith('已释放 3 个装配件 / 5 个零件的序列号');
    // 明细快照由 previewOpen 的 watch 统一清掉（pre-flush，flush 后才生效，见 U9）
    await flushPromises();
    expect(serial.preview.value).toBeNull();
  });

  it('U5：实跑失败 ⇒ 同样失效五个前缀 + ElMessage.error（响应可能在 commit 之后丢失）', async () => {
    const serial = app.runWithContext(() => useSerialRelease());
    await serial.onOpenPreview();

    releaseMock.mockRejectedValueOnce(new Error('网关超时'));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    invalidateSpy.mockClear();

    await serial.onConfirmRelease();

    expect(invalidateSpy).toHaveBeenCalledTimes(5);
    expect(ElMessage.error).toHaveBeenCalledWith('网关超时');
    expect(ElMessage.success).not.toHaveBeenCalled();
    // 失败时对话框留在原处（管理员能重试，也能看清刚才那份明细）
    expect(serial.previewOpen.value).toBe(true);
  });

  it('U6：入口判据是角色 —— MANAGER / ADMIN 可见，CLERK 不可见', () => {
    loginAs(['MANAGER']);
    expect(app.runWithContext(() => useSerialRelease()).canReleaseSerials.value).toBe(true);
    // ADMIN 由 hasRole 元角色通配（直接枚举 roles 会绕过它，CLAUDE.md「RBAC」一节）
    loginAs(['ADMIN']);
    expect(app.runWithContext(() => useSerialRelease()).canReleaseSerials.value).toBe(true);
    loginAs(['CLERK', 'INSPECTOR']);
    expect(app.runWithContext(() => useSerialRelease()).canReleaseSerials.value).toBe(false);
  });

  it('U7：取消只关对话框、不发写请求', async () => {
    const serial = app.runWithContext(() => useSerialRelease());
    await serial.onOpenPreview();
    releaseMock.mockClear();

    serial.onCancelPreview();

    expect(serial.previewOpen.value).toBe(false);
    await flushPromises();
    expect(serial.preview.value).toBeNull();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('U8：确认入口的函数级闸 —— 无 preview / 零条可释放 ⇒ 零请求 + warning（按钮 disabled 不是唯一闸门）', async () => {
    // 直接调公开方法、**绕过对话框的 `:disabled`**：两个场景都要零请求。
    // 把 onConfirmRelease 的守卫整段删掉时本条必须变红（对话框那条 disabled 挡不住调用方）。
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const serial = app.runWithContext(() => useSerialRelease());

    // ① 还没预览过（preview === null）
    await serial.onConfirmRelease();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('没有可释放的序列号，未执行');

    // ② 预览过但一条都不可释放（released_total === 0）
    releaseMock.mockResolvedValue(
      makeOut({ assembly_count: 0, part_count: 0, released_total: 0, affected: [] }),
    );
    await serial.onOpenPreview();
    releaseMock.mockClear();

    await serial.onConfirmRelease();
    expect(releaseMock).not.toHaveBeenCalled();
    // 两个场景各弹一次 warning（① 的那一次不清 mock，用累计次数断言，避开直接摸 .mock 的类型口子）
    expect(ElMessage.warning).toHaveBeenCalledTimes(2);
    expect(ElMessage.warning).toHaveBeenLastCalledWith('没有可释放的序列号，未执行');
    // 早退不发请求也不做失效对账（一个请求都没发，后端数据原封不动）
    expect(invalidateSpy).not.toHaveBeenCalled();
    await flushPromises();
  });

  it('U9：关对话框的两条路径都清掉已消费的明细快照（× 与「取消」逐字同一条路）', async () => {
    const serial = app.runWithContext(() => useSerialRelease());
    await serial.onOpenPreview();
    expect(serial.preview.value).not.toBeNull();

    // ① 「取消」按钮 → onCancelPreview
    serial.onCancelPreview();
    expect(serial.previewOpen.value).toBe(false);
    await flushPromises();
    expect(serial.preview.value).toBeNull();

    // ② 右上角 × → 只翻 previewOpen（组件只 emit `update:modelValue`，不发业务事件）
    await serial.onOpenPreview();
    expect(serial.preview.value).not.toBeNull();
    serial.previewOpen.value = false;
    await flushPromises();
    expect(serial.preview.value).toBeNull();
  });

  it('U10：实跑回显 dry_run=true（请求的是实跑）⇒ 报错而非报成功', async () => {
    // 后端 `dry_run` 是 `#[serde(default)]`，空 body 即真跑；出参承诺「原样回显，供前端确认
    // 这次到底是预览还是实跑」。回显错位时若照常弹「已释放 N 个」，管理员会以为号已回池。
    const serial = app.runWithContext(() => useSerialRelease());
    await serial.onOpenPreview();
    releaseMock.mockClear();

    releaseMock.mockResolvedValue(makeOut({ dry_run: true, assembly_count: 3, part_count: 5 }));
    await serial.onConfirmRelease();

    expect(ElMessage.success).not.toHaveBeenCalled();
    expect(ElMessage.error).toHaveBeenCalledTimes(1);
    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('dry_run=true'));
    // 走的是既有 onError（失效 + 报错），对话框留在原处供管理员重试
    expect(serial.previewOpen.value).toBe(true);
    await flushPromises();
  });

  it('U11：预览回显 dry_run=false（请求的是预览）⇒ 报错 + 对话框不开', async () => {
    // 与 U10 成对，两个方向的后果**不对称**：apply 回显错位只是「假成功提示」，preview
    // 回显错位却是**一次本该只读的请求真跑了不可逆释放**，而管理员以为只是预览。后端
    // `dry_run` 带 `#[serde(default)]`（空 body 即真跑）正是这条路径的入口。把 preview
    // 那条断言摘掉时本条必须变红。
    releaseMock.mockResolvedValue(makeOut({ dry_run: false }));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const serial = app.runWithContext(() => useSerialRelease());
    await serial.onOpenPreview();

    expect(ElMessage.success).not.toHaveBeenCalled();
    expect(ElMessage.error).toHaveBeenCalledTimes(1);
    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('dry_run=false'));
    // 对话框不开：一份「预览」明细若摆上去，管理员点确认就是在对着错误前提做不可逆操作
    expect(serial.previewOpen.value).toBe(false);
    expect(serial.preview.value).toBeNull();
    // 预览失败不触发任何失效（它什么都没写）
    expect(invalidateSpy).not.toHaveBeenCalled();
    await flushPromises();
  });
});
