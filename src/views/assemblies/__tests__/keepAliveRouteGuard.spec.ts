// @vitest-environment happy-dom
// src/views/assemblies/__tests__/keepAliveRouteGuard.spec.ts
//
// 2026-10-10 新增：keep-alive 下「后台页拿别的页面的 id 打自己域端点」的回归守卫。
//
// 缺陷（已实测复现，每次必现）：用户从装配件详情点子零件进零件详情时，控制台必出一条
//   WARN http_request{method=GET path=/api/v2/assemblies/219276974948876288 ...}: 404
// 并弹一个 ElMessage 错误 —— 那个 id 是 `t_part` 的 id，`t_assembly` 里没有它。
//
// 四步根因链（本 spec 逐条钉住其中可测的部分）：
//   1. MainLayout 的 `<keep-alive :include="tags.cachedViewNames">` 按**名字**匹配，
//      本页路由名 `AssemblyDetail` = 组件文件名 ⇒ 访问过一次就常驻缓存；
//   2. `useRoute()` 注入的是 vue-router 的**全局**响应式 currentRoute，不是「组件挂载
//      那一刻的地址快照」；
//   3. `assemblyId = computed(() => String(route.params.id))` 跟着全局路由走；
//   4. keep-alive 把本页切到后台时 watcher 不会停（只有 onUnmounted 才停）⇒ 全局路由一变，
//      被缓存的本页照样 fetchData，拿别的页面的 id 打 `/assemblies/{id}` ⇒ 404。
//
// 本 spec 用**真组件 + 假路由 + 假 composable**测第 4 步的守卫：
//   - `vue-router` 的 `useRoute` 返回一个普通 reactive 对象，测试直接改它的
//     `params.id` / `name` 模拟全局路由变化；
//   - `./composables/useAssemblyDetail` 整个 mock 掉，其 `fetchData` 是 vi.fn 计数
//     函数 —— 它就是「有没有发 GET /assemblies/*」的等价物（真实发请求在该 composable
//     内部）。mock 它也让本 spec 不必拉起 auth store / TanStack Query / element-plus。
//   - 子组件全部 stub，`detail` 恒 null ⇒ 模板不进 `v-if` 分支，只跑 setup 里的路由逻辑。
//   - 注册 pinia：本页 setup 里的 `useTagsViewStore()`（标签页标题动态化）要 active
//     pinia。本 spec 不关心标题，只是不注册会在 setup 阶段直接抛。
//
// 同样形态的守卫也加在 `PartDetail.vue`（route.name = 'PartDetail'）、
// `DeliveryNoteDetail.vue`（query 的 enabled 侧）、`OutsourceCompanySentParts.vue`；
// 本 spec 只守装配件详情这一处 —— 另三处的守卫形状相同、数据流不同（其中两处是
// queryKey / 导航，不是 fetchData）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AssemblyDetail from '../AssemblyDetail.vue';

// —— 假路由：一个普通 reactive 对象，测试直接改它模拟「全局路由变了」——
const routeState = reactive({
  name: 'AssemblyDetail' as string | undefined,
  params: { id: '219276974734966784' as string },
});

// `vi.mock` 的工厂会被提升到文件顶部，不能引用后声明的 const ⇒ 全部塞进 vi.hoisted。
const h = vi.hoisted(() => ({ fetchData: vi.fn(async () => {}) }));

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// 子组件整模块 mock 掉（而不是只挂 stub）：`FileListCard` 的静态 import 链会一路拉到
// pdfjs-dist 的 worker（`?url` 导入在 vitest 的 ssr 环境下直接被拒），stub 只挡渲染、
// 挡不住 import 本身。
vi.mock('@/components/FileListCard.vue', () => ({ default: { name: 'FileListCardStub' } }));
vi.mock('../components/AssemblyInfoCard.vue', () => ({
  default: { name: 'AssemblyInfoCardStub' },
}));
vi.mock('../components/AssemblyChildrenTable.vue', () => ({
  default: { name: 'AssemblyChildrenTableStub' },
}));
vi.mock('../components/AssemblyEditDialog.vue', () => ({
  default: { name: 'AssemblyEditDialogStub' },
}));

vi.mock('../composables/useAssemblyDetail', () => ({
  useAssemblyDetail: () => ({
    detail: ref(null),
    loading: ref(false),
    masterFiles: computed(() => []),
    childDrawingMap: computed(() => ({})),
    canCancel: computed(() => false),
    canDelete: computed(() => false),
    canEditContent: computed(() => false),
    canAddChild: computed(() => false),
    canUploadTotalPdf: computed(() => false),
    editForm: reactive({}),
    addChildForm: reactive({}),
    populateEditForm: vi.fn(),
    leafCustomers: ref([]),
    queryApplicants: vi.fn(),
    fetchData: h.fetchData,
    loadLeafCustomers: vi.fn(),
    updateAssembly: vi.fn(),
    cancelAssembly: vi.fn(),
    deleteAssembly: vi.fn(),
    addChild: vi.fn(),
    uploadPdf: vi.fn(),
    fetchDrawingBlob: vi.fn(),
    statusLabel: (s: string) => s,
    statusTagType: () => 'info',
    partStatusLabel: (s: string) => s,
    partStatusTagType: () => 'info',
    childRowClass: () => '',
    $dispose: vi.fn(),
  }),
}));

const stubs = {
  ElDialog: true,
  ElInput: true,
  ElButton: true,
};

const mounted: ReturnType<typeof mount>[] = [];

function mountPage() {
  // 2026-10-10：本页加了「标签页标题动态化」，setup 里有 `useTagsViewStore()`
  // ⇒ mount 时必须注册 pinia（tagsView store 的 setup 路径不读 localStorage、
  // 不碰 vue-query，所以只要一个 createPinia 即可）。
  const pinia = createPinia();
  const w = mount(AssemblyDetail, { global: { stubs, plugins: [pinia] } });
  mounted.push(w);
  return w;
}

/** 切到「别的页面」：全局路由的 name 与 id 一起变（用户点子零件进零件详情就是这个形状）。 */
function navigateAway(name: string, id: string) {
  routeState.name = name;
  routeState.params.id = id;
}

beforeEach(() => {
  routeState.name = 'AssemblyDetail';
  routeState.params.id = '219276974734966784';
  h.fetchData.mockClear();
});

// 用例里的断言一旦失败就会跳过 `w.unmount()`，留下的实例仍挂着 watcher，会在下一个
// 用例改 routeState 时被触发 ⇒ 计数串场。统一在这里收摊。
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
});

describe('keep-alive 路由守卫（AssemblyDetail）', () => {
  it('K1：本页仍活跃、只是换 id（同路由换参数）⇒ 必须重取', async () => {
    // ⚠️ 这条不能被守卫误伤：vue-router 对同一条路由记录只改 param 时会**复用组件
    // 实例、不触发 onMounted**，守卫一旦写成「id 没变就不动」或直接删掉 watcher，
    // 从装配件 A 跳到 B 时页面会停在 A 的数据上。
    const w = mountPage();
    await w.vm.$nextTick();
    expect(h.fetchData).toHaveBeenCalledTimes(1); // onMounted 首调

    routeState.params.id = '219276999999999999';
    await w.vm.$nextTick();

    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });

  it('K2：切到别的页面（route.name 变了 + id 变成子零件 id）⇒ 一律不重取（404 回归守卫）', async () => {
    const w = mountPage();
    await w.vm.$nextTick();
    expect(h.fetchData).toHaveBeenCalledTimes(1);

    // 现场复现的动作：装配件详情 → 点子零件 → router.push('/parts/{part_id}')
    navigateAway('PartDetail', '219276974948876288');
    await w.vm.$nextTick();

    expect(h.fetchData).toHaveBeenCalledTimes(1);
  });

  it('K3：id 又变了、但 name 仍是别的页面 ⇒ 同样不重取（判据只有 name 一个）', async () => {
    // 守卫若写成「id 变了就重取」就会漏掉这条 —— 后台页被别的页面连着切两次时，
    // 它会拿第二个页面的 id 打自己的端点。判据只有一个：**当前全局路由是不是本页**。
    const w = mountPage();
    await w.vm.$nextTick();

    navigateAway('PartDetail', '219276974948876288');
    await w.vm.$nextTick();
    expect(h.fetchData).toHaveBeenCalledTimes(1);

    routeState.params.id = '219276888888888888';
    await w.vm.$nextTick();

    expect(h.fetchData).toHaveBeenCalledTimes(1);
  });

  it('K4：切走再切回本页 ⇒ 切回来那一跳正常重取（守卫没有把本页永久钉死）', async () => {
    const w = mountPage();
    await w.vm.$nextTick();
    expect(h.fetchData).toHaveBeenCalledTimes(1);

    navigateAway('PartDetail', '219276974948876288');
    await w.vm.$nextTick();
    expect(h.fetchData).toHaveBeenCalledTimes(1);

    // 回到本页且换了一个 id —— vue-router 复用同一实例，仍由 watcher 驱动
    routeState.name = 'AssemblyDetail';
    routeState.params.id = '219276777777777777';
    await w.vm.$nextTick();

    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });
});
