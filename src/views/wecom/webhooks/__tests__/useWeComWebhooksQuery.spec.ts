// @vitest-environment happy-dom
// src/views/wecom/webhooks/__tests__/useWeComWebhooksQuery.spec.ts
//
// 2026-10-17 新增：webhook 列表 query hook 的**坏响应守门**守卫（与 api 层那份负向守卫成对）。
//
// ⚠️ **本 spec 存在的唯一理由**（照 `useMailAccountsQuery.spec.ts` / `useMailDigestQuery.spec.ts`
//   的同款纪律）：api 层按 CLAUDE.md「queryFn Zod 守门」只发请求、不做 parse，所以一旦有人把
//   queryFn 里的 `weComWebhookListSchema.parse(...)` 整段删掉，api 层那份负向守卫
//   （`src/api/__tests__/wecomWebhooks.contract.spec.ts::N1`，断言读端点不 parse）**照样全绿**，
//   而线上是「后端漏发一个字段 → 那一列整列 undefined，且零报错」。只有在这里 mock 一份**坏
//   响应**、断言它进不了 data，才能把这个洞补上。
//
// 覆盖：
//   - W3a：行少 `url_masked` ⇒ 进 error 态（列表页那一列整列 undefined 且零提示）；
//   - W3d：信封形状错（`items` 不是数组）⇒ 进 error 态（写成 z.array 时的典型症状）；
//   - W3e：信封顶层是裸数组 ⇒ 进 error 态；
//   - W2：好响应落值基线 + **恰好打一次**请求（负向用例的前提：请求真发了）；
//   - G1：`enabled=false` 时零网络请求（闸门由 store 的 `openGate()` 在 onMounted 末尾开）。
//
// 环境：happy-dom（vue-query 的 `useQuery` 需要一个 app 上下文跑 watch）；
// element-plus 桩成 no-op（真 `ElMessage` 在 node env 会因 `document is not defined` 抛）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type MaybeRefOrGetter } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listWeComWebhooksMock = vi.fn();

vi.mock('@/api/wecomWebhooks', () => ({
  listWeComWebhooks: () => listWeComWebhooksMock(),
}));

import { ElMessage } from 'element-plus';
import { useWeComWebhooksQuery } from '../composables/useWeComWebhooksQuery';

const ROW = {
  id: '9000000000000903',
  version: 1,
  name: '生产群',
  url_masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
  is_default: false,
  created_at: '2026-10-17 08:00:00',
  updated_at: '2026-10-17 08:00:00',
};

const LIST = { items: [ROW] };

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/**
 * 把 query hook 挂进独立 `effectScope`（`scope.stop()` 即卸载）。
 *
 * ⚠️ **形参必须真的流进 hook**（经下面那条适配器转成 hook 的 `{ enabled }` 入参），G1 全靠它
 *   成立。形参若被收下却不用、适配器退化成写死 `true`，`mount(ref(false), …)` 会**绿着骗人**。
 */
function mount<T>(enabled: MaybeRefOrGetter<boolean>, use: (e: MaybeRefOrGetter<boolean>) => T) {
  const scope = effectScope();
  let comp: T | undefined;
  scope.run(() => {
    comp = testApp.runWithContext(() => use(enabled));
  });
  return { scope, comp: comp! };
}

/** hook 自身的入参是**对象形**（`{ enabled }`），不是位置形，故不能直接把 hook 丢给 `mount`。
 *  ⚠️ **这两行是本 spec 唯一把闸门接进 hook 的线，而 TS 守不住它**：适配器被改成零参形
 *   同样类型合法 —— 只有 G1 会红。两条牙关（G1 + 形参流进）当成一对看。 */
const useWebhooks = (e: MaybeRefOrGetter<boolean>) => useWeComWebhooksQuery({ enabled: e });

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  vi.clearAllMocks();
  listWeComWebhooksMock.mockResolvedValue(LIST);
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

afterEach(() => {
  testQueryClient.unmount();
});

describe('useWeComWebhooksQuery — 好响应落值（坏响应守卫的基线）', () => {
  it('W2：好响应落进 data（已剥掉信封的数组），且**恰好**打一次请求', async () => {
    const { scope, comp } = mount(ref(true), useWebhooks);
    await tick();

    expect(comp.query.error.value).toBeNull();
    // ⚠️ data 是**数组**不是 `{items:[…]}`：信封留在 hook 内部（见该 hook 的说明），
    // 漏剥一次的症状是 `.map is not a function`。
    expect(comp.data.value).toHaveLength(1);
    expect(comp.data.value?.[0]?.id).toBe('9000000000000903');
    expect(listWeComWebhooksMock).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});

describe('useWeComWebhooksQuery — enabled 闸门', () => {
  it('G1：enabled=false ⇒ 零网络请求、data 恒 undefined', async () => {
    // ⚠️ 零请求是**这条用例的全部价值**：闸门被摘掉（或退化成写死 `true`）时症状是「页面还没
    // 挂载就先打一轮请求」—— 首屏多一次往返，且 store 的 hydrate 可能拿着半路回来的数据覆盖
    // 管理员正在填的表单态。正面那条（W2）是它的对照，两条一起才框住闸门的行为边界。
    const { scope, comp } = mount(ref(false), useWebhooks);
    await tick();

    expect(listWeComWebhooksMock, '闸门未开时不该发请求').not.toHaveBeenCalled();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });
});

describe('useWeComWebhooksQuery — 坏响应守门（W3 组）', () => {
  it('W3a：行少 url_masked ⇒ 进 error 态、data 不落值', async () => {
    const { url_masked: _drop, ...noMasked } = ROW;
    listWeComWebhooksMock.mockResolvedValue({ items: [noMasked] });

    const { scope, comp } = mount(ref(true), useWebhooks);
    await tick();

    expect(comp.query.error.value, '缺 url_masked 应当抛').not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    // 错误桥接必须弹一次（否则坏契约在页面上是彻底静默的：表空 + 无提示）。
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });

  it('W3d：信封形状错（items 不是数组）⇒ 进 error 态', async () => {
    // 守门写成 z.array 时症状是「每一屏都抛、列表恒空、零告警」；反过来把出参当裸数组消费则
    // 会在守门通过后拿到对象、`.map is not a function`。
    listWeComWebhooksMock.mockResolvedValue({ items: ROW });

    const { scope, comp } = mount(ref(true), useWebhooks);
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('W3e：信封顶层是裸数组 ⇒ 进 error 态', async () => {
    listWeComWebhooksMock.mockResolvedValue([ROW]);

    const { scope, comp } = mount(ref(true), useWebhooks);
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('W3f：多一个键必抛（.strict() 的对称代价）', async () => {
    listWeComWebhooksMock.mockResolvedValue({ items: [{ ...ROW, webhook_url: 'https://…' }] });

    const { scope, comp } = mount(ref(true), useWebhooks);
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    scope.stop();
  });
});
