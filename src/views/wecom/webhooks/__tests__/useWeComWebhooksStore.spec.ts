// @vitest-environment happy-dom
// src/views/wecom/webhooks/__tests__/useWeComWebhooksStore.spec.ts
//
// 2026-10-17 新建：webhook 通道页 store（`composables/useWeComWebhooksStore`）单测。覆盖本域
// 最容易静默出错的六类点：
//
//  1. **4 不变量**：enabled 闸门在 `openGate()` 之前**零请求**、开闸后打一次；`$dispose()` 后
//     重建拿到全新弹窗态（Pinia 单例不 dispose 会把填了一半的弹窗泄漏到下次进入）；消费侧全
//     走 `store.切片.字段` 不解构（嵌套 ref 自动解包 + 代理 set 可写回）。
//  2. **完整地址永不回显**：编辑弹窗的 `webhook_url` 恒为空串、`editingUrlMasked` 给的是掩码。
//  3. **OCC 硬约束**：改档 / 软删 / 置默认三条的 payload 必带 `version`（取**目标行当前**的
//     version）；只传 id 会发出 `{}` ⇒ 后端 422 纯文本、连业务码都没有。
//  4. **错误码分流**：40901 走 warning（不弹 error）；21808 等走人话。⚠️ 所有 `apiError(…)`
//     的码实参一律引 `WECOM_WEBHOOK_ERROR_CODES` 具名常量，不写裸数字。
//  5. **前端校验前置**：名称为空 / 地址格式非法时**不发请求**，只标红字段。
//  6. **失效编排**：四条写端点在成功**与失败**两条路径上都失效 `qk.wecomWebhooksPrefix`；
//     ⚠️ **测连通刻意不失效**（它不写 `t_wecom_daily_log`）。
//
// mock 策略：`vi.mock('@/api/wecomWebhooks')` 五个函数全桩；`vi.mock('element-plus')` 把
// ElMessage 桩成 no-op。顺序硬约束：pinia 先、VueQueryPlugin 后（store setup 首行
// `useQueryClient()`）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listWeComWebhooksMock = vi.fn();
const createWeComWebhookMock = vi.fn();
const updateWeComWebhookMock = vi.fn();
const deleteWeComWebhookMock = vi.fn();
const setDefaultWeComWebhookMock = vi.fn();
const testWeComWebhookMock = vi.fn();

vi.mock('@/api/wecomWebhooks', () => ({
  listWeComWebhooks: (...args: unknown[]) => listWeComWebhooksMock(...args),
  createWeComWebhook: (...args: unknown[]) => createWeComWebhookMock(...args),
  updateWeComWebhook: (...args: unknown[]) => updateWeComWebhookMock(...args),
  deleteWeComWebhook: (...args: unknown[]) => deleteWeComWebhookMock(...args),
  setDefaultWeComWebhook: (...args: unknown[]) => setDefaultWeComWebhookMock(...args),
  testWeComWebhook: (...args: unknown[]) => testWeComWebhookMock(...args),
}));

import { ElMessage } from 'element-plus';
import { useWeComWebhooksStore } from '../composables/useWeComWebhooksStore';
import { WECOM_WEBHOOK_ERROR_CODES } from '../weComWebhookErrorText';
import type { WeComWebhookData } from '../weComWebhookSchema';

function row(over: Partial<WeComWebhookData> = {}): WeComWebhookData {
  return {
    id: '9000000000000903',
    version: 1,
    name: '生产群',
    url_masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
    is_default: false,
    created_at: '2026-10-17 08:00:00',
    updated_at: '2026-10-17 08:00:00',
    ...over,
  };
}

const LIST = { items: [row(), row({ id: '9000000000000904', name: '质量群', is_default: true })] };

/** 起一套 pinia + vue-query 环境，返回 QueryClient（失效调用点要 spy 它）。 */
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

/** 等 useQuery 的 scheduler 跑过一轮（TanStack 内部是 setTimeout(…, 0)）。 */
function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 造一个带 ApiError 形态 code 的异常（http.ts 的响应拦截器抛的就是它）。 */
function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

let qc: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  qc = setupApp();
  listWeComWebhooksMock.mockResolvedValue(LIST);
  createWeComWebhookMock.mockResolvedValue(row());
  updateWeComWebhookMock.mockResolvedValue(row({ version: 2 }));
  deleteWeComWebhookMock.mockResolvedValue(undefined);
  setDefaultWeComWebhookMock.mockResolvedValue(row({ is_default: true, version: 2 }));
  testWeComWebhookMock.mockResolvedValue(undefined);
});

describe('useWeComWebhooksStore — 不变量（闸门 / 切片解包 / $dispose）', () => {
  it('I1：openGate() 之前零请求；开闸后列表打一次', async () => {
    const store = useWeComWebhooksStore();
    await tick();
    expect(listWeComWebhooksMock).not.toHaveBeenCalled();

    store.query.openGate();
    await tick();
    expect(listWeComWebhooksMock).toHaveBeenCalledTimes(1);
  });

  it('I2：切片读不写 .value（嵌套 ref 自动解包），且代理 set 能写回', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    expect(store.query.webhooks).toHaveLength(2);
    expect(store.query.hasDefault).toBe(true);

    store.dialogs.form.name = '临时';
    expect(store.dialogs.form.name).toBe('临时');
  });

  it('I3：$dispose() 后重建 store 拿到全新弹窗态（不泄漏上一次的输入）', async () => {
    const first = useWeComWebhooksStore();
    first.query.openGate();
    await tick();
    first.dialogs.openCreate();
    first.dialogs.form.name = '填了一半';
    expect(first.dialogs.visible).toBe(true);

    first.$dispose();

    const second = useWeComWebhooksStore();
    expect(second.dialogs.visible).toBe(false);
    expect(second.dialogs.form.name).toBe('');
  });
});

describe('useWeComWebhooksStore — 弹窗与「地址不回显」', () => {
  it('D1：openEdit 只把名称填进表单，webhook_url 恒为空串（完整地址不出参）', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    store.dialogs.openEdit(store.query.webhooks[0]!);
    expect(store.dialogs.mode).toBe('edit');
    expect(store.dialogs.form.name).toBe('生产群');
    expect(store.dialogs.form.webhook_url).toBe('');
    expect(store.dialogs.editingUrlMasked).toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
    );
  });

  it('D2：openCreate 复位表单与模式', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();
    store.dialogs.openEdit(store.query.webhooks[0]!);
    store.dialogs.closeDialog();
    store.dialogs.openCreate();

    expect(store.dialogs.mode).toBe('create');
    expect(store.dialogs.form.name).toBe('');
    expect(store.dialogs.editingUrlMasked).toBe('');
  });
});

describe('useWeComWebhooksStore — 保存（OCC 硬约束）', () => {
  const GOOD_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a0000-1111-2222-3333-44445555ffff';

  it('S1：新建 payload 带 name + webhook_url', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    store.dialogs.openCreate();
    store.dialogs.form.name = '  新群  ';
    store.dialogs.form.webhook_url = `  ${GOOD_URL}  `;
    const ok = await store.actions.submit();

    expect(ok).toBe(true);
    expect(createWeComWebhookMock).toHaveBeenCalledTimes(1);
    // trim 已归一（schema 的链式顺序 trim 在前）
    expect(createWeComWebhookMock.mock.calls[0]![0]).toEqual({ name: '新群', webhook_url: GOOD_URL });
    expect(ElMessage.success).toHaveBeenCalledWith('Webhook 已创建');
    // 成功后弹窗关闭（唯一的提交出口走完）
    expect(store.dialogs.visible).toBe(false);
  });

  it('S2：改档 payload 带 version（取**正在编辑那一行**的当前值）', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    store.dialogs.openEdit(store.query.webhooks[0]!);
    store.dialogs.form.name = '生产群（改名）';
    // ⚠️ 地址留空 = 后端「沿用旧密文」，前端**不能**替它填任何东西。
    const ok = await store.actions.submit();

    expect(ok).toBe(true);
    expect(updateWeComWebhookMock).toHaveBeenCalledTimes(1);
    // api 层的形参是 `(id, body)` 两个位置形（id 经 encodeURIComponent 的活儿在 api 层），
    // store 的 mutationFn 把 `{id, body}` 拆开传。
    expect(updateWeComWebhookMock.mock.calls[0]).toEqual([
      '9000000000000903',
      { version: 1, name: '生产群（改名）', webhook_url: '' },
    ]);
  });

  it('S3：校验不过时**不发请求**，只标红字段', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    store.dialogs.openCreate();
    store.dialogs.form.name = '';
    store.dialogs.form.webhook_url = 'https://example.com/hook';
    const ok = await store.actions.submit();

    expect(ok).toBe(false);
    expect(createWeComWebhookMock).not.toHaveBeenCalled();
    expect(store.dialogs.fieldErrors.name).toBe('请填写名称');
    expect(store.dialogs.fieldErrors.webhook_url).toContain('地址格式不正确');
    expect(ElMessage.warning).toHaveBeenCalledWith('请先修正表单中标红的字段');
  });

  it('S4：改档态地址留空能过校验（合法保存 = 不改地址）', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    store.dialogs.openEdit(store.query.webhooks[0]!);
    const ok = await store.actions.submit();
    expect(ok).toBe(true);
    expect(updateWeComWebhookMock).toHaveBeenCalledTimes(1);
  });
});

describe('useWeComWebhooksStore — 动作端点与失效编排', () => {
  it('A1：软删 payload 带 version（不是光 id）', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.actions.remove(store.query.webhooks[0]!);
    await tick();

    expect(deleteWeComWebhookMock).toHaveBeenCalledWith('9000000000000903', { version: 1 });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['wecom'] });
    expect(ElMessage.success).toHaveBeenCalledWith('Webhook 已删除');
    // loading 标志复位
    expect(store.actions.deletingRowId).toBeNull();
  });

  it('A2：置默认 payload 带 version；已是默认的那条**不发请求**（幂等）', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    await store.actions.makeDefault(store.query.webhooks[1]!);
    expect(setDefaultWeComWebhookMock).not.toHaveBeenCalled();

    await store.actions.makeDefault(store.query.webhooks[0]!);
    expect(setDefaultWeComWebhookMock).toHaveBeenCalledWith('9000000000000903', { version: 1 });
    expect(store.actions.settingDefaultRowId).toBeNull();
  });

  it('A3：软删失败（21808 被引用）也失效本域前缀 + 弹人话', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    deleteWeComWebhookMock.mockRejectedValue(
      apiError(WECOM_WEBHOOK_ERROR_CODES.IN_USE, 'in use'),
    );

    await store.actions.remove(store.query.webhooks[0]!);
    await tick();

    expect(spy).toHaveBeenCalledWith({ queryKey: ['wecom'] });
    expect(ElMessage.error).toHaveBeenCalledWith('该 Webhook 已被每日总结配置引用，不能删除');
  });

  it('A4：40901 走 **warning** 而不是 error（OCC 冲突的处置与业务失败不同）', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();
    createWeComWebhookMock.mockRejectedValue(
      apiError(WECOM_WEBHOOK_ERROR_CODES.VERSION_CONFLICT, 'OCC'),
    );

    store.dialogs.openCreate();
    store.dialogs.form.name = '新群';
    store.dialogs.form.webhook_url =
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a0000-1111-2222-3333-44445555ffff';
    await store.actions.submit();
    await tick();

    expect(ElMessage.warning).toHaveBeenCalledWith('配置已被他人修改，请刷新后重试');
    expect(ElMessage.error).not.toHaveBeenCalled();
  });

  it('A5：测连通**刻意不失效任何 query**（`/test` 不写 t_wecom_daily_log）', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.actions.test(store.query.webhooks[0]!);
    await tick();

    expect(testWeComWebhookMock).toHaveBeenCalledWith('9000000000000903');
    expect(spy).not.toHaveBeenCalled();
    expect(ElMessage.success).toHaveBeenCalledWith('测试消息已发出，请到群里确认收到');
    expect(store.actions.testingRowId).toBeNull();
  });

  it('A6：测连通失败也**不失效**（它同样没改变任何一行的数据）', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    testWeComWebhookMock.mockRejectedValue(
      apiError(WECOM_WEBHOOK_ERROR_CODES.NOT_FOUND, 'gone'),
    );

    await store.actions.test(store.query.webhooks[0]!);
    await tick();

    expect(spy).not.toHaveBeenCalled();
    expect(ElMessage.error).toHaveBeenCalledWith('Webhook 不存在或已删除，请刷新后重试');
  });
});

describe('useWeComWebhooksStore — 派生判据', () => {
  it('N1：hasDefault 从列表派生（列表空时给 false 而不是 undefined）', async () => {
    listWeComWebhooksMock.mockResolvedValue({ items: [] });
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    expect(store.query.webhooks).toEqual([]);
    expect(store.query.hasDefault).toBe(false);
    // ⚠️ 「一个通道都没有」**刻意不**做成 store 派生字段：它的唯一消费方
    // （`WeComWebhooksTab.vue` 的引导空态）就地读 `webhooks.length === 0`，第二条派生字段
    // 只会多一处要同步的地方。上面 `webhooks` 为空即该判据成立。
  });

  it('N2：refresh() 打一次 refetch', async () => {
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();
    listWeComWebhooksMock.mockClear();

    await store.query.refresh();
    await tick();
    expect(listWeComWebhooksMock).toHaveBeenCalledTimes(1);
  });

  it('N3：列表坏响应时 listErrorText 有值（顶部错误条的数据源）', async () => {
    listWeComWebhooksMock.mockResolvedValue({ items: [{ id: '9000000000000903' }] });
    const store = useWeComWebhooksStore();
    store.query.openGate();
    await tick();

    expect(store.query.listErrorText).toBe('服务端返回的数据格式不符合预期，请联系管理员');
    expect(store.query.webhooks).toEqual([]);
  });
});
