// @vitest-environment happy-dom
// src/views/scan/__tests__/ScanActionPicker.spec.ts
//
// 2026-10-04 新增（review 第 1 轮补）：/scan/action「选当前作业货架 + 送检前置」这条接线
// 的回归守卫。
//
// 为什么值得单独立一个文件：这一段是报工台选架功能的**全部**接线都在的地方，而它此前
// 零覆盖 —— `scanShelf.spec.ts` 只验「`selectShelf` 写不写 store」，`WorkingShelfDialog.spec.ts`
// 只验「弹窗 emit 了什么」，中间那段（点送检是**先开弹窗**而不是直接跳页、confirm 之后才
// `push`、cancel 中止）一条断言都没有。删掉 `selectAction` 里那个 `if (a === 'INSPECT' &&
// needShelf.value)` 不会有任何测试变红，而多架账号的送检立刻回到「作业架判不出 ⇒ 一次都
// 提交不出去」的死结。本仓对这个形态有前科：`stores/__tests__/scanShelf.spec.ts` 的文件头
// 记着上一版（页面级 composable、跨路由被卸载）的同类 bug 正是因为零覆盖才活了下来。
//
// 本文件同时钉住横条的判据（review 重要 1）：警示态的来源是「作业架**能不能提交**」
// （复用送检页的 `workingShelfProblem`），不是「多架未选」。后者漏掉「只绑了品检架」的账号
// —— 那种账号单架自动选中、判据为假，横条会显示「自动：SH-I02」，一个 worker-scan 必然
// 20501 打回的架号，工人据此点进送检页才发现一次都提交不出去。
//
// 桩的取舍（沿 `ScanReturnChainFlow.spec.ts` 的同款理由）：
//   - `vue-router`：只桩 `useRouter`，把 `push` / `replace` 抓出来断言跳转。`useScanSession`
//     是模块级 ref 单例、不需要注入，工人身份靠它自己的 setter 建立。
//   - `@/api/shelves` 整模块桩掉：本页只经 store 调 `listShelves`。
//   - `WorkingShelfDialog` 桩成带标记 class 的空壳并透出两个触发按钮：本文件要验的是
//     **本页怎么用**弹窗的回执，不是弹窗自己怎么列候选（那是 `WorkingShelfDialog.spec.ts`
//     的活）。空壳把 `modelValue` 透成 class，用例据此断言「弹窗开没开」。
//   - `element-plus` 桩成 `{ ElMessage: { ...vi.fn() } }`：按 CLAUDE.md 约定。
//   - mount 必须装 pinia + VueQueryPlugin：store setup 里 `useAuthStore()`，而 auth store
//     在 setup **第一行**调 `useQueryClient()`（Pinia 只给 setup 注入上下文）。登录态靠
//     预置 `localStorage.auth_session` 建立（auth store 首次 useAuthStore() 时自执行
//     loadFromStorage()）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// vi.mock 的工厂会被提升到文件顶部，不能引用后声明的 const ⇒ 桩函数集中放进 vi.hoisted。
const h = vi.hoisted(() => ({
  listShelves: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  /** 空壳弹窗 confirm 时要 emit 的架 id：用例在点「完成」前写它，模拟「工人点了哪张卡」。 */
  dialogConfirmId: '' as string,
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/shelves', () => ({ listShelves: h.listShelves }));

vi.mock('element-plus', () => ({ ElMessage: h.ElMessage }));

vi.mock('vue-router', () => ({ useRouter: () => ({ push: h.push, replace: h.replace }) }));

// 空壳弹窗：把 modelValue 透成 class（验「开没开」），并给两个按钮触发 confirm / cancel。
// confirm 的 id 从 `h.dialogConfirmId` 现取 —— 不能用 attr 传（`$attrs` 只读，改它还会
// 触发 Vue warn），所以走 setup 返回一个取值函数，模板在点击那一刻才读。
vi.mock('@/views/scan/components/WorkingShelfDialog.vue', () => ({
  default: {
    name: 'WorkingShelfDialogStub',
    props: ['modelValue', 'options', 'currentShelfId', 'emptyText'],
    setup() {
      return { confirmId: () => h.dialogConfirmId };
    },
    template: `
      <div class="stub-dialog" :class="{ 'is-open': modelValue }">
        <span class="stub-current">{{ currentShelfId ?? '' }}</span>
        <span class="stub-empty">{{ emptyText ?? '' }}</span>
        <button class="stub-confirm" @click="$emit('confirm', confirmId())">confirm</button>
        <button class="stub-cancel" @click="$emit('cancel')">cancel</button>
      </div>
    `,
  },
}));

import ScanActionPicker from '@/views/scan/ScanActionPicker.vue';
import { useScanShelfStore } from '@/stores/scanShelf';
import { useScanSession } from '@/composables/useScanSession';
import type { CurrentUser } from '@/types/user';
import type { Shelf, ShelfListResult } from '@/types/shelf';
import type { Worker } from '@/types/worker';

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

/** listShelves 的桩响应：只保留消费侧真读的字段（`Shelf` 10 个字段恰好全覆盖）。 */
function mockShelves(rows: Array<Pick<Shelf, 'id' | 'code' | 'zone'>>): void {
  const result: ShelfListResult = {
    items: rows.map((r) => ({
      version: 1,
      name: r.code,
      location: null,
      is_active: true,
      display_order: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...r,
    })),
    total: rows.length,
    limit: 200,
    offset: 0,
  };
  vi.mocked(h.listShelves).mockResolvedValue(result);
}

/** 装好 pinia + query plugin、注入登录态与工人身份，然后挂载本页。 */
async function mountPicker(user: CurrentUser): Promise<ReturnType<typeof mount>> {
  seedSession(user);
  const app = createApp({});
  app.use(createPinia());
  app.use(VueQueryPlugin, {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }),
  });
  setActivePinia(app.config.globalProperties.$pinia);
  // 工人身份：`/scan/action` 的入口守卫 requireWorker 要求它存在，否则跳 /scan/badge。
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

  const w = mount(ScanActionPicker, {
    global: {
      stubs: {
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span class="mock-tag"><slot /></span>' },
        'el-divider': { template: '<span class="mock-divider" />' },
        'el-button': {
          props: ['type', 'size', 'plain'],
          template: '<button :class="[\'mock-btn\', $attrs.class]" @click="$emit(\'click\')"><slot /></button>',
        },
      },
    },
  });
  await flushPromises();
  return w;
}

/** 三个动作按钮：按 class 找（`.action-btn` 的 class 被 el-button 桩透在根元素上）。 */
function actionButtons(w: ReturnType<typeof mount>): ReturnType<typeof w.findAll> {
  return w.findAll('.action-grid .mock-btn');
}

async function clickAction(w: ReturnType<typeof mount>, label: string): Promise<void> {
  const btn = actionButtons(w).find((b) => b.text().includes(label));
  expect(btn, `找不到动作按钮「${label}」`).toBeTruthy();
  await btn!.trigger('click');
  await flushPromises();
}

describe('ScanActionPicker：选架接线 + 送检前置', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    h.push.mockReset();
    h.replace.mockReset();
    vi.mocked(h.listShelves).mockReset();
    h.dialogConfirmId = '';
    h.ElMessage.success.mockReset();
    h.ElMessage.error.mockReset();
    h.ElMessage.warning.mockReset();
  });

  // ── 重要 2 的四条：送检前置的那段接线 ──────────────────────────────────────

  it('A1：多架未选时点送检 → 不跳页、先开选架弹窗（绝不直接 push 到送检页）', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_I1.id]));

    expect(useScanShelfStore().showShelfSelector).toBe(true);
    await clickAction(w, '送 检');

    // 没跳页 —— 这一条是本文件存在的全部理由：跳过去就回���「作业架判不出 ⇒ 提交不出去」
    expect(h.push).not.toHaveBeenCalled();
    // 弹窗开了，且把当前候选与当前选中值传了进去
    expect(w.find('.stub-dialog').classes()).toContain('is-open');
    expect(w.find('.stub-current').text()).toBe('');
  });

  it('A2：弹窗 confirm 选中某个架 → 写进 store，并补上这次送检跳转', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_I1.id]));

    await clickAction(w, '送 检');
    // 模拟「工人在弹窗里点了 SH-P01 并按完成」
    h.dialogConfirmId = SHELF_P1.id;
    await w.find('.stub-confirm').trigger('click');
    await flushPromises();

    expect(useScanShelfStore().selectedShelfId).toBe(SHELF_P1.id);
    expect(sessionStorage.getItem('active_shelf_selection:u1')).toBe(SHELF_P1.id);
    // confirm 之后才跳页，且只跳这一次
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith('/scan/inspect');
    // 弹窗同步关闭
    expect(w.find('.stub-dialog').classes()).not.toContain('is-open');
  });

  it('A3：弹窗 cancel → 不写 store、不跳页，工人停在 /scan/action（不是死路：横条仍在）', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_I1.id]));

    await clickAction(w, '送 检');
    await w.find('.stub-cancel').trigger('click');
    await flushPromises();

    expect(h.push).not.toHaveBeenCalled();
    expect(useScanShelfStore().selectedShelfId).toBeNull();
    // 横条仍在、警示态仍在、按钮仍在 ⇒ 工人能立刻重试，不是走进死胡同
    expect(w.find('.working-shelf').exists()).toBe(true);
    expect(w.find('.working-shelf').classes()).toContain('is-warn');
  });

  it('A4：多架但已选出作业架 → 点送检直接进页，不经弹窗', async () => {
    // 必须绑一个 INSPECTION 架「送检」按钮才会出现（按钮显隐按绑定架 zone 并集，见组件头）
    mockShelves([SHELF_P1, SHELF_P2, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_P2.id, SHELF_I1.id]));
    // 预置上一会话选过的架（store 的多架分支会从 sessionStorage 恢复）
    sessionStorage.setItem('active_shelf_selection:u1', SHELF_P2.id);
    await w.vm.$nextTick();
    // 重新加载候选（换绑定 → 指纹变化，强制重载）
    await useScanShelfStore().initShelves({ force: true });
    await flushPromises();

    expect(useScanShelfStore().selectedShelfId).toBe(SHELF_P2.id);
    expect(useScanShelfStore().showShelfSelector).toBe(false);

    await clickAction(w, '送 检');

    expect(h.push).toHaveBeenCalledWith('/scan/inspect');
    expect(w.find('.stub-dialog').classes()).not.toContain('is-open');
  });

  // ── 重要 1：横条的判据是「能不能提交」，不是「多架未选」 ────────────────────

  it('B1：只绑了品检架的单架账号 → 横条转警示态并说明原因（不显示「自动：SH-I01」）', async () => {
    mockShelves([SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_I1.id]));

    const bar = w.find('.working-shelf');
    // store 侧的 showShelfSelector 此时是 false（只有一个候选）—— 判据必须不是它
    expect(useScanShelfStore().showShelfSelector).toBe(false);
    expect(bar.exists()).toBe(true);
    expect(bar.classes()).toContain('is-warn');
    // 自解释：把守卫的原因摆出来，而不是一个会被后端 20501 打回的架号
    expect(w.find('.working-shelf-value').text()).toBe(
      '本账号当前绑定的货架在品检区，缺少生产区作业货架，请联系管理员为本账号绑定生产货架',
    );
    expect(w.find('.working-shelf-value').text()).not.toContain(SHELF_I1.code);
    // 有候选就必须给选架入口，点了能看到空态说明（出路）
    expect(w.find('.working-shelf .mock-btn').exists()).toBe(true);
  });

  it('B2：只绑了品检架时点送检 → 先开弹窗（而不是直接进一个必然被拦死的页）', async () => {
    mockShelves([SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_I1.id]));

    await clickAction(w, '送 检');

    expect(h.push).not.toHaveBeenCalled();
    expect(w.find('.stub-dialog').classes()).toContain('is-open');
  });

  it('B3：单架生产账号 → 横条是「自动：{code}」正常态（单架不进警示态）', async () => {
    mockShelves([SHELF_P1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id]));

    const bar = w.find('.working-shelf');
    expect(bar.classes()).not.toContain('is-warn');
    expect(w.find('.working-shelf-value').text()).toBe(`自动：${SHELF_P1.code}`);
  });

  it('B4：多架已选 → 横条是「当前：{code}」+ 更换按钮；且把当前选中值传进弹窗做预选', async () => {
    mockShelves([SHELF_P1, SHELF_P2]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_P2.id]));
    sessionStorage.setItem('active_shelf_selection:u1', SHELF_P1.id);
    await useScanShelfStore().initShelves({ force: true });
    await flushPromises();

    const bar = w.find('.working-shelf');
    expect(bar.classes()).not.toContain('is-warn');
    expect(w.find('.working-shelf-value').text()).toBe(`当前：${SHELF_P1.code}`);
    expect(w.find('.working-shelf .mock-btn').text()).toBe('更换');
    // 打开弹窗时把 store 的当前值传下去（WorkingShelfDialog 据此预选那张卡）
    expect(w.find('.stub-current').text()).toBe(SHELF_P1.id);
  });

  // ── 选架入口本身（不经过送检按钮） ─────────────────────────────────────────

  it('C1：点「选择货架」开弹窗、confirm 选中即写入 store（不跳页：这次没点送检）', async () => {
    mockShelves([SHELF_P1, SHELF_P2]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_P2.id]));

    const shelfBtn = w.find('.working-shelf .mock-btn');
    expect(shelfBtn.text()).toBe('选择货架');
    await shelfBtn.trigger('click');
    expect(w.find('.stub-dialog').classes()).toContain('is-open');

    h.dialogConfirmId = SHELF_P2.id;
    await w.find('.stub-confirm').trigger('click');
    await flushPromises();

    expect(useScanShelfStore().selectedShelfId).toBe(SHELF_P2.id);
    // 关键：只选了架、没有点送检 ⇒ 不许把人带进送检页（pendingInspect 的作用范围）
    expect(h.push).not.toHaveBeenCalled();
  });

  it('C2：选架失败（越界 id）→ 报 error、不跳页，且不留下「待跳转」的残留', async () => {
    mockShelves([SHELF_P1, SHELF_P2, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_P2.id, SHELF_I1.id]));

    await clickAction(w, '送 检');
    // 模拟一个不在候选集内的 id（管理员刚解绑 / listShelves 没返到）
    h.dialogConfirmId = '8800000000999';
    await w.find('.stub-confirm').trigger('click');
    await flushPromises();

    expect(h.ElMessage.error).toHaveBeenCalledWith('该货架不在本账号的可用货架内，请重新选择');
    expect(useScanShelfStore().selectedShelfId).toBeNull();
    expect(h.push).not.toHaveBeenCalled();

    // 残留检查：这次失败留下的「待跳转」标记必须已被清掉 —— 否则工人接着正常选一次架
    // （比如点「更换」后随手 confirm）就会被意外带进送检页。
    h.dialogConfirmId = SHELF_P1.id;
    await w.find('.stub-confirm').trigger('click');
    await flushPromises();

    expect(useScanShelfStore().selectedShelfId).toBe(SHELF_P1.id);
    expect(h.push).not.toHaveBeenCalled();
  });

  // ── 取件 / 放回：不得受作业架影响（F1 的回归护栏） ─────────────────────────

  it('D1：多架未选时点取件 / 放回 → 直接进页，不被作业架拦住（取件已解绑）', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_I1.id]));
    expect(useScanShelfStore().showShelfSelector).toBe(true);

    await clickAction(w, '取 件');
    expect(h.push).toHaveBeenCalledWith('/scan/pick');
    expect(w.find('.stub-dialog').classes()).not.toContain('is-open');

    h.push.mockClear();
    await clickAction(w, '放 回');
    expect(h.push).toHaveBeenCalledWith('/scan/return');
    expect(w.find('.stub-dialog').classes()).not.toContain('is-open');
  });

  // ── 2026-10-04 review 第 2 轮：空态文案由调用方给 + noActionReason 降噪 ────────

  // 守卫的 `shelfProblem` 回答的是「为什么当前作业架不可提交」，空态要回答的是「为什么这里
  // 列不出卡」。绑 ≥ 2 个非生产架时两者会分叉：守卫说「请先在「操作选择」页选择当前作业
  // 货架」，而工人此刻就站在那一页、弹窗里一张卡都没有 —— 那是循环指引，且选择解决不了。
  it('B5：绑 ≥2 个非生产架 → 空态文案不说「请去选择货架」（不制造循环指引）', async () => {
    mockShelves([SHELF_I1, { id: '8800000000004', code: 'SH-I02', zone: 'INSPECTION' }]);
    const w = await mountPicker(makeUser('u1', ['8800000000003', '8800000000004']));

    expect(useScanShelfStore().selectedShelfId).toBeNull();
    expect(useScanShelfStore().showShelfSelector).toBe(true);
    await clickAction(w, '送 检');
    expect(w.find('.stub-dialog').classes()).toContain('is-open');

    const empty = w.find('.stub-empty').text();
    expect(empty).toContain('没有生产区作业货架');
    expect(empty).not.toContain('请先在「操作选择」页选择');
    expect(empty).not.toContain('在品检区，缺少');
  });

  it('B6：候选里有生产架 → 不传空态文案（弹窗有卡可列，文案用不上）', async () => {
    mockShelves([SHELF_P1, SHELF_I1]);
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id, SHELF_I1.id]));

    expect(w.find('.stub-empty').text()).toBe('');
  });

  // 降噪：候选非空但 zone 一个都认不出来（listShelves 失败 ⇒ store 兜底填 UNKNOWN）时，
  // noActionReason 不再与横条重复同一段话。wildcard 那支必须保持原样（横条不渲染）。
  it('E1：zone 全 UNKNOWN → 横条自解释，noActionReason 不再重复（降噪）', async () => {
    vi.mocked(h.listShelves).mockRejectedValue(new Error('boom'));
    const w = await mountPicker(makeUser('u1', [SHELF_P1.id]));

    // 横条说了「无法识别」
    expect(w.find('.working-shelf').classes()).toContain('is-warn');
    expect(w.find('.working-shelf-value').text()).toBe(
      '无法识别当前货架所属区域，不能作为作业货架，请联系管理员核对本账号的货架绑定',
    );
    // 三个动作按钮全隐藏（没有可认出的 zone），但**不再**额外渲染一段近义文案。
    // 两条候选文案都断言「不在」：只钉住降噪前那一句的话，把降噪改成返回**另一句**错文案
    // （例如误落到 wildcard 那一支）会漏过。
    expect(actionButtons(w)).toHaveLength(0);
    expect(w.text()).not.toContain('本账号绑定的货架所属区域无法识别');
    expect(w.text()).not.toContain('本账号未绑定货架');
  });

  it('D2：候选为空（wildcard）→ 不渲染横条，走既有 noActionReason 文案', async () => {
    vi.mocked(h.listShelves).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    const w = await mountPicker(makeUser('u1', []));

    expect(w.find('.working-shelf').exists()).toBe(false);
    expect(w.text()).toContain('本账号未绑定货架，请联系管理员在「账号管理」为本账号绑定货架');
  });
});
