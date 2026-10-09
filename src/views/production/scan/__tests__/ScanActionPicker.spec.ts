// @vitest-environment happy-dom
// src/views/production/scan/__tests__/ScanActionPicker.spec.ts
//
// /scan/action 的回归守卫：**按钮显隐按「账号绑定货架的 zone 并集」决定**，以及点了之后
// 跳哪一页。
//
// 2026-10-10 改写：本文件原先守的是「选架接线 + 送检前置」（当前作业货架横条 +
// WorkingShelfDialog + 弹窗 confirm 之后才 push）。那个功能随「目标货架改由后端按负载
// 自动选择」整体下线，相关用例随之删除；留下来的判定规则（哪个按钮出现）改由本文件
// 继续守 —— 它是**现场账号权限**的一部分（SHELF_ACCOUNT 绑了哪些架决定这个工位能做
// 哪几件事），不是货架选择的附属品。
//
// 判据链路（这三段必须一起看，中间任一段写错都只表现为「按钮少了一个」，没有报错）：
//   auth.boundShelves（`/iam/me` 带回来的绑定集）∩ GET /iam/shelves（拿到 zone）
//     → boundZones → showPickUp / showReturn / showInspect
// 所以「工位绑了哪些架」与「货架端点的 zone」两侧都要有 fixture，缺一侧断言就失真。
//
// 2026-10-11 追加守「查看持有」：它是第四个入口、**不是**报工动作（不进 useScanSession、
// 不跳页），显隐只看「扫到工人」，与三个动作按钮的 zone 判定完全无关。所以下面三处都改了：
//   - `actionLabels` 必须把「查看」排除在动作按钮之外，否则 zone 判定的断言会被它污染；
//   - 「查看持有」读的是**同一条** `qk.scanHeld`（params 与徽章 / 三页逐字一致），本 spec
//     把 `@/api/productionScan` 一并桩掉，顺带钉住「本页不新增请求口径」；
//   - `el-dialog` 等组件在 vitest 下没有自动注册（vitest.config.ts 不带
//     unplugin-vue-components），必须显式 stub。
//
// 桩的取舍：
//   - `vue-router`：只桩 `useRouter`，把 `push` / `replace` 抓出来断言跳转。`useScanSession`
//     是模块级 ref 单例、不需要注入，工人身份靠它自己的 setter 建立。
//   - `@/api/shelves` 整模块桩掉：按钮显隐走共享 query `useProductionShelvesQuery`，
//     它的 queryFn 就是 `listShelves` + Zod 守门。
//   - `element-plus` 桩成 `{ ElMessage: { ...vi.fn() } }`：按 CLAUDE.md 约定。
//   - mount 必须装 pinia + VueQueryPlugin，且两者都经 `global.plugins` 挂在 VTU 挂载的
//     那个 app 上（组件自己 `useProductionShelvesQuery` 读按钮显隐 ⇒ VueQueryPlugin 必须
//     在场；组件读 `useAuthStore()` ⇒ pinia 必须在场）。挂在别的 `createApp` 上没有用
//     —— VTU mount 自建 app，不继承外部 app 的插件。
//     auth store 也在 setup 第一行调 `useQueryClient()`，登录态靠预置
//     `localStorage.auth_session` 建立。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// vi.mock 的工厂会被提升到文件顶部，不能引用后声明的 const ⇒ 桩函数集中放进 vi.hoisted。
const h = vi.hoisted(() => ({
  listShelves: vi.fn(),
  fetchScanHeld: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/shelves', () => ({ listShelves: h.listShelves }));

// 「查看持有」的列表源（与徽章 / 放回页 / 送检页同一条 qk.scanHeld）。
vi.mock('@/api/productionScan', () => ({ fetchScanHeld: h.fetchScanHeld }));

vi.mock('element-plus', () => ({ ElMessage: h.ElMessage }));

vi.mock('vue-router', () => ({ useRouter: () => ({ push: h.push, replace: h.replace }) }));

import ScanActionPicker from '@/views/production/scan/ScanActionPicker.vue';
import { useScanSession } from '@/views/production/scan/composables/useScanSession';
import type { CurrentUser } from '@/types/user';
import type { Shelf, ShelfListResult } from '@/types/shelf';
import type { Worker } from '@/types/worker';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';

const SHELF_P1 = { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' };
const SHELF_P2 = { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' };
const SHELF_I1 = { id: '8800000000003', code: 'SH-I01', zone: 'INSPECTION' };

function makeUser(userId: string, shelfIds: string[]): CurrentUser {
  return {
    id: userId,
    username: `hmi-${userId}`,
    full_name: `工位 ${userId}`,
    is_active: true,
    roles: ['SHELF_ACCOUNT'],
    shelf_ids: shelfIds,
    menus: [],
  };
}

function seedSession(user: CurrentUser): void {
  localStorage.setItem(
    'auth_session',
    JSON.stringify({ token: `tok-${user.id}`, refresh_token: null, user }),
  );
}

/** listShelves 的桩响应：只保留消费侧真读的字段。 */
function mockShelves(rows: Array<Pick<Shelf, 'id' | 'code' | 'zone'>>): void {
  const result: ShelfListResult = {
    items: rows.map((r) => ({
      version: 1,
      name: r.code,
      location: null,
      is_active: true,
      capacity: null,
      current_load: 0,
      display_order: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...r,
    })),
    total: rows.length,
    limit: 500,
    offset: 0,
  };
  vi.mocked(h.listShelves).mockResolvedValue(result);
}

/** 工人身份：`/scan/action` 的入口守卫 requireWorker 要求它存在，否则跳 /scan/badge。 */
function seedWorker(): void {
  const worker: Worker = {
    id: '190000000000009',
    version: 1,
    badge_code: 'B1',
    name: '工人甲',
    work_type_id: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  useScanSession().setWorker(worker);
}

/** 后端 `ScanListItem` 的合法 17 字段行（held VO 没有额外的必填/选填键）。 */
function heldRow(id: string, over: Partial<ScanPartRowSchema> = {}): ScanPartRowSchema {
  return {
    id,
    serial_no: `SN-${id}`,
    name: '法兰盘',
    drawing_no: 'DWG-1',
    quantity: 3,
    is_urgent: false,
    planned_delivery_date: '2026-10-20',
    system_delivery_date: null,
    process_chain_id: null,
    has_process_chain: false,
    chain_state: 'NONE',
    chain_next_process_id: '0',
    chain_next_process_name: null,
    chain_current_process_name: null,
    batch_id: `1900000000000${id}`,
    batch_version: 1,
    location: null,
    ...over,
  };
}

function mockHeld(ids: string[]): void {
  vi.mocked(h.fetchScanHeld).mockResolvedValue({
    items: ids.map((id) => heldRow(id)),
    total: ids.length,
    limit: 200,
    offset: 0,
  });
}

/** 装好 pinia + query plugin、注入登录态与工人身份，然后挂载本页。 */
async function mountPicker(user: CurrentUser): Promise<VueWrapper> {
  seedSession(user);
  seedWorker();
  const w = mount(ScanActionPicker, {
    global: {
      plugins: [
        createPinia(),
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) },
        ],
      ],
      stubs: {
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span class="mock-tag"><slot /></span>' },
        'el-divider': { template: '<span class="mock-divider" />' },
        // `emits: ['click']` 不能少：少声明时父组件的 `@click` 会**同时**被 stub 的
        // `$emit('click')` 接住、又作为 fallthrough 落到根 <button> 的原生监听器上，
        // 一次点击触发两次 `selectAction`（⇒ router.push 两次）。旧版本没声明是因为
        // 老用例只断言「跳到哪一页」不断言次数，这条隐藏的双发就是这么活下来的。
        'el-button': {
          props: ['type', 'size', 'plain'],
          emits: ['click'],
          template:
            '<button :class="[\'mock-btn\', $attrs.class]" @click="$emit(\'click\')"><slot /></button>',
        },
        // 「查看持有」弹窗。`modelValue` 不声明成 prop 也能拿到 fallthrough attr，
        // 但按仓内既有写法统一声明成 prop，渲染条件才写在模板里。
        'el-dialog': {
          name: 'ElDialogStub',
          props: ['modelValue'],
          template: '<div v-if="modelValue" class="mock-dialog"><slot /></div>',
        },
      },
    },
  });
  await flushPromises();
  return w;
}

/**
 * 三个**动作**按钮的标签（按 `.action-label` 取 —— 直接取按钮全文会混进 desc 句）。
 *  `.action-label` / `.action-grid` 是模板里的 class，与桩无关，EP 组件被桩掉也还在。
 *
 * 必须排除「查看持有」按钮（2026-10-11 起它也在 `.action-grid` 里、也有 `.action-label`）：
 * 它不是报工动作，显隐与 zone 无关，混进来会把这组 zone 断言全部污染成假失败。
 */
function actionLabels(w: VueWrapper): string[] {
  return w
    .findAll('.action-grid .mock-btn')
    .filter((b) => b.attributes('data-testid') !== 'held-btn')
    .map((b) => b.find('.action-label').text().replace(/\s+/g, ''));
}

/** 「查看持有」按钮（`data-testid="held-btn"`）是否存在。 */
function hasHeldButton(w: VueWrapper): boolean {
  return w.find('[data-testid="held-btn"]').exists();
}

/** 弹窗内的持有行数（`HeldPartsList` 的 `.held-row`）。 */
function heldRowCount(w: VueWrapper): number {
  return w.findAll('.mock-dialog .held-row').length;
}

async function clickAction(w: VueWrapper, label: string): Promise<void> {
  const btn = w
    .findAll('.action-grid .mock-btn')
    .filter((b) => b.attributes('data-testid') !== 'held-btn')
    .find(
      (b) => b.find('.action-label').exists() && b.find('.action-label').text().includes(label),
    );
  expect(btn, `找不到动作按钮「${label}」`).toBeTruthy();
  await btn!.trigger('click');
  await flushPromises();
}

describe('ScanActionPicker：按钮显隐按绑定架 zone 并集', () => {
  beforeEach(() => {
    localStorage.clear();
    h.push.mockReset();
    h.replace.mockReset();
    vi.mocked(h.listShelves).mockReset();
    vi.mocked(h.fetchScanHeld).mockReset().mockResolvedValue({
      items: [],
      total: 0,
      limit: 200,
      offset: 0,
    });
    h.ElMessage.success.mockReset();
  });

  it('B1：只绑生产架 → 取件 + 放回，没有送检', async () => {
    mockShelves([SHELF_P1, SHELF_P2]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_P2.id]));
    expect(actionLabels(w).sort()).toEqual(['取件', '放回']);
  });

  it('B2：只绑品检架 → 只有送检', async () => {
    mockShelves([SHELF_I1]);
    const w = await mountPicker(makeUser('u2', [SHELF_I1.id]));
    expect(actionLabels(w)).toEqual(['送检']);
  });

  it('B3：两类都绑 → 三个动作按钮全在', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u3', [SHELF_P1.id, SHELF_I1.id]));
    expect(actionLabels(w).sort()).toEqual(['取件', '放回', '送检']);
  });

  // 反向守卫：绑定集里**没有**的架（货架端点返了全量货架，按钮只认绑定集里的）不能点亮
  // 按钮。少了这一条，「账号绑 A1 却看到 B2 的品检按钮」这类越权显示测不出来。
  it('B4：绑定集之外的架不参与 zone 并集（端点返全量货架也不给按钮）', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    // 账号只绑了生产架
    const w = await mountPicker(makeUser('u4', [SHELF_P1.id]));
    expect(actionLabels(w)).not.toContain('送检');
  });

  // 2026-10-10：横条下线后「零按钮」只剩一种成因 —— 账号真的一个架都没绑（wildcard）。
  // 端点挂掉 / 绑定集里有架但 zone 认不出来时**不给文案**：那时没有别处能摆这句，
  // 而「点了才知道按钮不出现」比一句来路不明的解释更好排查。
  it('B5：一个架都没绑 → 零按钮 + 「未绑定货架」提示', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u5', []));
    expect(actionLabels(w)).toEqual([]);
    expect(w.text()).toContain('本账号未绑定货架');
  });

  it('B6：零按钮时不给「未绑定货架」文案（账号其实绑了架，只是货架端点挂了）', async () => {
    vi.mocked(h.listShelves).mockRejectedValue(new Error('500 boom'));
    const w = await mountPicker(makeUser('u6', [SHELF_P1.id]));
    // 「零按钮」说的是**动作**按钮；「查看持有」与 zone 无关，货架端点挂了它照样在
    expect(actionLabels(w)).toEqual([]);
    expect(hasHeldButton(w)).toBe(true);
    expect(w.text()).not.toContain('本账号未绑定货架');
  });
});

describe('ScanActionPicker：点了跳哪一页', () => {
  beforeEach(() => {
    localStorage.clear();
    h.push.mockReset();
    h.replace.mockReset();
    vi.mocked(h.listShelves).mockReset();
    vi.mocked(h.fetchScanHeld).mockReset().mockResolvedValue({
      items: [],
      total: 0,
      limit: 200,
      offset: 0,
    });
    h.ElMessage.success.mockReset();
  });

  // 2026-10-10：点送检**直接** push —— 原来有一段「作业架判不出就先开选架弹窗、
  // confirm 之后才 push」的中转，功能下线后不再有任何前置闸门。
  it('N1：点送检直接跳 /scan/inspect（不再有任何选架中转）', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_I1.id]));
    await clickAction(w, '送 检');
    expect(h.push.mock.calls).toEqual([['/scan/inspect']]);
    expect(h.ElMessage.success).toHaveBeenCalledWith('已选择: 送检');
  });

  it('N2：取件 / 放回分别跳 /scan/pick 与 /scan/return', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_I1.id]));
    await clickAction(w, '取 件');
    expect(h.push).toHaveBeenLastCalledWith('/scan/pick');
    await clickAction(w, '放 回');
    expect(h.push).toHaveBeenLastCalledWith('/scan/return');
  });

  // 没有工人身份 ⇒ 入口守卫把页面弹回 /scan/badge，不该有任何动作按钮可用。
  it('N3：worker 缺失 → 弹回 /scan/badge', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    useScanSession().setWorker(null);
    seedSession(makeUser('u1', [SHELF_P1.id, SHELF_I1.id]));
    mount(ScanActionPicker, {
      global: {
        plugins: [
          createPinia(),
          [
            VueQueryPlugin,
            { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) },
          ],
        ],
        stubs: { 'el-button': true },
      },
    });
    await flushPromises();
    expect(h.replace).toHaveBeenCalledWith('/scan/badge');
  });
});

describe('ScanActionPicker：查看持有（2026-10-11 新增）', () => {
  beforeEach(() => {
    localStorage.clear();
    h.push.mockReset();
    h.replace.mockReset();
    vi.mocked(h.listShelves).mockReset();
    vi.mocked(h.fetchScanHeld).mockReset().mockResolvedValue({
      items: [],
      total: 0,
      limit: 200,
      offset: 0,
    });
    h.ElMessage.success.mockReset();
  });

  it('H1：按钮恒在（只看扫到工人，与绑定架无关），角标按已加载件数', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    mockHeld(['101', '102', '103']);
    const w = await mountPicker(makeUser('h1', [SHELF_P1.id, SHELF_I1.id]));
    expect(hasHeldButton(w)).toBe(true);
    // 角标写在描述行里：`items.length`（已加载件数），不是 total
    expect(w.find('[data-testid="held-btn"]').text()).toContain('3 件');
  });

  it('H2：没扫到工人 ⇒ 按钮不显示（显隐条件只有一个：worker.id）', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    useScanSession().setWorker(null);
    seedSession(makeUser('h2', [SHELF_P1.id, SHELF_I1.id]));
    const w = mount(ScanActionPicker, {
      global: {
        plugins: [
          createPinia(),
          [
            VueQueryPlugin,
            { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) },
          ],
        ],
        stubs: { 'el-button': true, 'el-dialog': true },
      },
    });
    await flushPromises();
    expect(hasHeldButton(w)).toBe(false);
  });

  it('H3：点「查看持有」打开弹窗并渲染持有行，且不发跳转', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    mockHeld(['101', '102']);
    const w = await mountPicker(makeUser('h3', [SHELF_P1.id, SHELF_I1.id]));

    expect(w.find('.mock-dialog').exists(), '弹窗默认不该打开').toBe(false);
    await w.find('[data-testid="held-btn"]').trigger('click');
    await flushPromises();

    expect(w.find('.mock-dialog').exists()).toBe(true);
    expect(heldRowCount(w)).toBe(2);
    // 展示字段取自现有 17 字段：序列号 / 图号 / 名称 / 数量
    const text = w.find('.mock-dialog').text();
    expect(text).toContain('SN-101');
    expect(text).toContain('DWG-1');
    expect(text).toContain('法兰盘');
    expect(text).toContain('3 件');
    // 「查看持有」不是报工动作：不跳页、不提示「已选择」
    expect(h.push).not.toHaveBeenCalled();
    expect(h.ElMessage.success).not.toHaveBeenCalled();
  });

  it('H4：params 与徽章 / 三页逐字一致（{ workerId, limit: 200 }）⇒ 必然同一条 qk.scanHeld', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    mockHeld([]);
    await mountPicker(makeUser('h4', [SHELF_P1.id, SHELF_I1.id]));
    expect(h.fetchScanHeld).toHaveBeenCalled();
    expect(h.fetchScanHeld.mock.calls[0]![0]).toEqual({ workerId: '190000000000009', limit: 200 });
    // 本页的按钮角标与弹窗各挂了一个 observer，同键 ⇒ 同屏只发**一次**请求。这是子任务
    // 的核心验收点（「不新增任何请求」），只钉入参钉不住它 —— 有人把弹窗的 params 改成
    // 另一个形状时键会分裂成两条、入参断言仍绿。
    expect(h.fetchScanHeld).toHaveBeenCalledTimes(1);
  });

  it('H5：加急 / 交期 / 工序各有值才渲染；没有工序链时工序整块不出现（不显示假占位）', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    vi.mocked(h.fetchScanHeld).mockResolvedValue({
      items: [
        heldRow('201', { is_urgent: true, planned_delivery_date: '2026-11-01' }),
        heldRow('202', {
          is_urgent: false,
          planned_delivery_date: '',
          chain_current_process_name: '钻孔',
          chain_next_process_name: null,
        }),
        heldRow('203', { is_urgent: false, planned_delivery_date: '' }),
      ],
      total: 3,
      limit: 200,
      offset: 0,
    });
    const w = await mountPicker(makeUser('h5', [SHELF_P1.id, SHELF_I1.id]));
    await w.find('[data-testid="held-btn"]').trigger('click');
    await flushPromises();

    const rows = w.findAll('.mock-dialog .held-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('加急');
    expect(rows[0]!.text()).toContain('交期 2026-11-01');
    expect(rows[1]!.text()).toContain('工序 钻孔');
    // 交期空 + 无工序链 ⇒ 副信息整块不渲染（不是渲染一个空的 tag）
    expect(rows[1]!.find('.held-row-sub').exists()).toBe(true);
    expect(rows[2]!.find('.held-row-sub').exists()).toBe(false);
  });
});
