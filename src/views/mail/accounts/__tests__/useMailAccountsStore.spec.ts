// @vitest-environment happy-dom
// src/views/mail/accounts/__tests__/useMailAccountsStore.spec.ts
//
// 2026-10-16 新建：邮箱账号页 store（`composables/useMailAccountsStore`）单测。覆盖本域
// 最容易静默出错的六类点：
//
//  1. **4 不变量**：enabled 闸门在 `openGate()` 之前**零请求**、开闸后两条 query 各发一次；
//     `$dispose()` 后重建拿到全新弹窗态（Pinia 单例不 dispose 会把「填了一半的弹窗」泄漏
//     到下次进入）；消费侧全走 `store.切片.字段` 不解构（嵌套 ref 自动解包 + 代理 set 可写回）。
//  2. **失效编排**：四条写端点**成功与失败都**失效 `qk.mailPrefix`。失败也失效的理由不是
//     「怕漏刷自己那笔」，而是 21708（被定时任务引用禁止删除）说明本端副本已经不等于真源。
//  3. **授权码语义**：建档必填、改档**留空 = 不改**（wire 上是空串）；列表/弹窗都拿不到它。
//  4. **错误码分流**：21706 / 21707 / 21708 各弹对应的人话（21708 点名引用方）。
//  5. **前端校验前置**：名称空 / 账号空 / 预设未选 / 建档授权码空时**不发请求**，只标红字段。
//  6. **幂等 + OCC 锚**：已是默认的那条再点「设为默认」**不发请求**；删除 / 设为默认
//     两条动作端点的 body **必带 `version`**（漏传是 422 纯文本、拿不到业务码）。
//  7. **改档时保存按钮也要转圈**（`saving` 覆盖建档 + 改档两条 mutation）。
//
// mock 策略：`vi.mock('@/api/mailAccounts')` 全桩；`vi.mock('element-plus')` 把 ElMessage
// 桩成 no-op。顺序硬约束：pinia 先、VueQueryPlugin 后（store setup 首行 `useQueryClient()`）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listMailAccountsMock = vi.fn();
const fetchMailMetaMock = vi.fn();
const createMailAccountMock = vi.fn();
const updateMailAccountMock = vi.fn();
const deleteMailAccountMock = vi.fn();
const setDefaultMailAccountMock = vi.fn();

vi.mock('@/api/mailAccounts', () => ({
  listMailAccounts: (...args: unknown[]) => listMailAccountsMock(...args),
  fetchMailMeta: (...args: unknown[]) => fetchMailMetaMock(...args),
  createMailAccount: (...args: unknown[]) => createMailAccountMock(...args),
  updateMailAccount: (...args: unknown[]) => updateMailAccountMock(...args),
  deleteMailAccount: (...args: unknown[]) => deleteMailAccountMock(...args),
  setDefaultMailAccount: (...args: unknown[]) => setDefaultMailAccountMock(...args),
}));

import { ElMessage } from 'element-plus';
import { useMailAccountsStore } from '../composables/useMailAccountsStore';
import { MAIL_ACCOUNT_ERROR_CODES, MAIL_ACCOUNT_ERROR_TEXT } from '../mailAccountErrorText';
import type { MailAccountData } from '../mailAccountSchema';

function account(over: Partial<MailAccountData> = {}): MailAccountData {
  return {
    id: '9000000000000902',
    version: 1,
    name: '采购部邮箱',
    preset: 'NET_EASE_163',
    preset_label: '网易 163',
    account: 'purchase@example.com',
    host: 'smtp.163.com',
    port: 465,
    tls_mode: 'WRAPPED',
    is_default: false,
    created_at: '2026-10-16 08:00:00',
    updated_at: '2026-10-16 08:00:00',
    ...over,
  };
}

const ACCOUNTS = [
  account({ is_default: true }),
  // ⚠️ 第二条刻意给一个**与第一条不同的 `version`**：两条都是 1 时，把 `mutationFn` 里的
  // `row.version` 换成常量 `1` 全仓测试照样绿 —— 那就等于没钉住「OCC 锚取的是**被操作那一
  // 行**」。W2 / W3 / W4 三条断言各自锚在这个 7 上。
  account({ id: '9000000000000903', name: '仓库邮箱', version: 7 }),
];

const META = {
  presets: [
    {
      value: 'NET_EASE_163',
      label: '网易 163',
      host: 'smtp.163.com',
      port: 465,
      tls_mode: 'WRAPPED',
    },
    {
      value: 'TENCENT_QQ',
      label: 'QQ',
      host: 'smtp.qq.com',
      port: 465,
      tls_mode: 'WRAPPED',
    },
  ],
};

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

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 造一个带 ApiError 形态 code 的异常（`api/http.ts` 的响应拦截器抛的就是它）。 */
function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  const e = new Error(message) as Error & { code: number };
  e.code = code;
  return e;
}

let qc: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  qc = setupApp();
  listMailAccountsMock.mockResolvedValue({ items: ACCOUNTS });
  fetchMailMetaMock.mockResolvedValue(META);
  createMailAccountMock.mockResolvedValue(account({ version: 1 }));
  updateMailAccountMock.mockResolvedValue(account({ version: 2 }));
  // 后端 `R<()>` ⇒ `data: null`，api 层返回 undefined（没有出参可守）
  deleteMailAccountMock.mockResolvedValue(undefined);
  setDefaultMailAccountMock.mockResolvedValue(account({ is_default: true }));
});

describe('I — 4 不变量', () => {
  it('I1：openGate() 之前零请求，开闸后两条 query 各打一次', async () => {
    const store = useMailAccountsStore();
    await tick();
    expect(listMailAccountsMock).not.toHaveBeenCalled();
    expect(fetchMailMetaMock).not.toHaveBeenCalled();

    store.query.openGate();
    await tick();
    expect(listMailAccountsMock).toHaveBeenCalledTimes(1);
    expect(fetchMailMetaMock).toHaveBeenCalledTimes(1);
    expect(store.query.accounts).toHaveLength(2);
  });

  it('I2：切片读不写 .value（嵌套 ref 自动解包），且代理 set 能写回', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    expect(store.query.accounts[0]?.name).toBe('采购部邮箱');
    expect(store.query.presetOptions).toHaveLength(2);
    expect(store.dialogs.visible).toBe(false);
    // 「有邮箱但一个默认都没有」的提示判据：ACCOUNTS[0] 是默认 ⇒ true
    expect(store.query.hasDefault).toBe(true);
  });

  it('I3：$dispose() 后重建 store 拿到全新弹窗态（不泄漏上一次的未保存输入）', async () => {
    const first = useMailAccountsStore();
    first.query.openGate();
    await tick();
    first.dialogs.openCreate();
    first.dialogs.form.name = '填了一半';
    expect(first.dialogs.visible).toBe(true);

    first.$dispose();

    const second = useMailAccountsStore();
    second.query.openGate();
    await tick();
    expect(second.dialogs.visible).toBe(false);
    expect(second.dialogs.form.name).toBe('');
  });
});

describe('Q — 预设描述行取自 meta', () => {
  it('Q1：选中预设后给出 host:port:tls_mode（前端不推导）', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    expect(store.query.selectedPresetDetail).toBeNull();
    store.dialogs.form.preset = 'TENCENT_QQ';
    expect(store.query.selectedPresetDetail?.host).toBe('smtp.qq.com');
    expect(store.query.selectedPresetDetail?.port).toBe(465);
  });
});

describe('D — 弹窗开合与授权码语义', () => {
  it('D1：openEdit 把服务端那一行填进表单，但 secret **恒为空串**（出参没有授权码）', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openEdit(ACCOUNTS[1]!);
    expect(store.dialogs.mode).toBe('edit');
    expect(store.dialogs.editing?.id).toBe('9000000000000903');
    expect(store.dialogs.form.name).toBe('仓库邮箱');
    // ⚠️ 授权码不回显：列表里恒显示「已配置」，编辑弹窗只能「留空 = 不改」
    expect(store.dialogs.form.secret).toBe('');
  });

  it('D2：openCreate 清空上一条残留并切回 create 模式', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openEdit(ACCOUNTS[0]!);
    store.dialogs.openCreate();
    expect(store.dialogs.mode).toBe('create');
    expect(store.dialogs.editing).toBeNull();
    expect(store.dialogs.form.name).toBe('');
    expect(store.dialogs.form.secret).toBe('');
  });

  it('D3：closeDialog 关弹窗但不清表单（清表单是 openCreate / openEdit 的职责）', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openCreate();
    store.dialogs.form.name = '采购部邮箱';
    store.dialogs.closeDialog();
    expect(store.dialogs.visible).toBe(false);
    expect(store.dialogs.form.name).toBe('采购部邮箱');
  });
});

describe('V — 前端校验前置（不过不发请求）', () => {
  it('V1：建档时授权码为空 ⇒ 不发请求 + 标红 secret', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openCreate();
    store.dialogs.form.name = '采购部邮箱';
    store.dialogs.form.preset = 'NET_EASE_163';
    store.dialogs.form.account = 'purchase@example.com';
    const ok = await store.actions.submit();

    expect(ok).toBe(false);
    expect(createMailAccountMock).not.toHaveBeenCalled();
    expect(store.dialogs.fieldErrors.secret).toBeDefined();
    expect(ElMessage.warning).toHaveBeenCalled();
  });

  it('V2：名称只有空白 ⇒ 不发请求 + 标红 name', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openCreate();
    store.dialogs.form.name = '   ';
    store.dialogs.form.preset = 'NET_EASE_163';
    store.dialogs.form.account = 'purchase@example.com';
    store.dialogs.form.secret = 'abc123';

    expect(await store.actions.submit()).toBe(false);
    expect(createMailAccountMock).not.toHaveBeenCalled();
    expect(store.dialogs.fieldErrors.name).toBe('请填写名称');
  });

  it('V3：预设未选 ⇒ 不发请求（前端刻意不设业务默认值，用户必须显式选一次）', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openCreate();
    store.dialogs.form.name = '采购部邮箱';
    store.dialogs.form.account = 'purchase@example.com';
    store.dialogs.form.secret = 'abc123';

    expect(await store.actions.submit()).toBe(false);
    expect(createMailAccountMock).not.toHaveBeenCalled();
    expect(store.dialogs.fieldErrors.preset).toBeDefined();
  });
});

describe('W — 四条写端点', () => {
  it('W1：建档成功 ⇒ 发四个键（无 version）+ 关弹窗 + 失效本域 + success 提示', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openCreate();
    store.dialogs.form.name = ' 采购部邮箱 ';
    store.dialogs.form.preset = 'NET_EASE_163';
    store.dialogs.form.account = ' purchase@example.com ';
    store.dialogs.form.secret = 'abc123';

    expect(await store.actions.submit()).toBe(true);
    expect(createMailAccountMock).toHaveBeenCalledWith({
      name: '采购部邮箱',
      preset: 'NET_EASE_163',
      account: 'purchase@example.com',
      secret: 'abc123',
    });
    expect(store.dialogs.visible).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mail'] });
    expect(ElMessage.success).toHaveBeenCalledWith('邮箱已创建');
  });

  it('W2：改档 ⇒ body 必带 version（OCC 锚）+ secret 空串 = 不改', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openEdit(ACCOUNTS[1]!);
    store.dialogs.form.account = 'warehouse@qq.com';
    // secret 保持空串

    expect(await store.actions.submit()).toBe(true);
    expect(updateMailAccountMock).toHaveBeenCalledWith('9000000000000903', {
      version: 7,
      name: '仓库邮箱',
      preset: 'NET_EASE_163',
      account: 'warehouse@qq.com',
      secret: '',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mail'] });
  });

  it('W2b：改档进行中 `saving` 为 true（保存按钮转圈；只挂 create 的话改档时按钮不转）', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    let resolveUpdate: ((v: MailAccountData) => void) | undefined;
    updateMailAccountMock.mockImplementation(
      () =>
        new Promise<MailAccountData>((r) => {
          resolveUpdate = r;
        }),
    );
    store.dialogs.openEdit(ACCOUNTS[1]!);
    const p = store.actions.submit();
    await tick();
    expect(store.actions.saving).toBe(true);
    resolveUpdate?.(account({ id: '9000000000000903', version: 2 }));
    await p;
    expect(store.actions.saving).toBe(false);
  });

  it('W3：删除 ⇒ 打 id **+ version**（OCC 锚），成功后失效 + success', async () => {
    // ⚠️ 动作端点的 body 必填 `version` 且无 serde default ⇒ 发 `{}` 是 HTTP 422 纯文本，
    // 连业务码都拿不到（查表文案全落空）。收「整行」而不是 id 就是为了这个 version。
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    await store.actions.remove(ACCOUNTS[1]!);
    expect(deleteMailAccountMock).toHaveBeenCalledWith('9000000000000903', { version: 7 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mail'] });
    expect(ElMessage.success).toHaveBeenCalledWith('邮箱已删除');
  });

  it('W3b：删除进行中 exposing 那一行的 id（壳据此把 loading 挂在**那一行**上）', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    let resolveDelete: (() => void) | undefined;
    deleteMailAccountMock.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveDelete = r;
        }),
    );
    const p = store.actions.remove(ACCOUNTS[1]!);
    await tick();
    expect(store.actions.deletingRowId).toBe('9000000000000903');
    resolveDelete?.();
    await p;
    expect(store.actions.deletingRowId).toBeNull();
  });

  it('W4：设为默认 ⇒ 打 id **+ version**；**已是默认的那条不发请求**（幂等）', async () => {
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    await store.actions.makeDefault(ACCOUNTS[0]!);
    expect(setDefaultMailAccountMock).not.toHaveBeenCalled();

    await store.actions.makeDefault(ACCOUNTS[1]!);
    expect(setDefaultMailAccountMock).toHaveBeenCalledWith('9000000000000903', { version: 7 });
  });
});

describe('E — 失败路径：失效 + 文案', () => {
  it('E1：21708（被定时任务引用）⇒ 失败**也**失效本域 + 弹点名引用方的文案', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    deleteMailAccountMock.mockRejectedValue(
      apiError(MAIL_ACCOUNT_ERROR_CODES.ACCOUNT_IN_USE, '后端 message'),
    );
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();
    invalidateSpy.mockClear();

    await store.actions.remove(ACCOUNTS[1]!);

    // ⚠️ 失败也失效：引用关系只有后端知道，本端副本在那一刻已不等于真源。
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mail'] });
    expect(ElMessage.error).toHaveBeenCalledWith(
      MAIL_ACCOUNT_ERROR_TEXT[MAIL_ACCOUNT_ERROR_CODES.ACCOUNT_IN_USE],
    );
  });

  it('E2：21707（名称重复）⇒ 弹「换一个名称」，弹窗保持打开让用户改完重试', async () => {
    createMailAccountMock.mockRejectedValue(apiError(MAIL_ACCOUNT_ERROR_CODES.NAME_DUPLICATED));
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    store.dialogs.openCreate();
    store.dialogs.form.name = '采购部邮箱';
    store.dialogs.form.preset = 'NET_EASE_163';
    store.dialogs.form.account = 'purchase@example.com';
    store.dialogs.form.secret = 'abc123';

    expect(await store.actions.submit()).toBe(false);
    expect(store.dialogs.visible).toBe(true);
    expect(ElMessage.error).toHaveBeenCalledWith(
      MAIL_ACCOUNT_ERROR_TEXT[MAIL_ACCOUNT_ERROR_CODES.NAME_DUPLICATED],
    );
  });

  it('E3：21706（账号不存在）⇒ 弹「刷新列表后重试」', async () => {
    setDefaultMailAccountMock.mockRejectedValue(
      apiError(MAIL_ACCOUNT_ERROR_CODES.ACCOUNT_NOT_FOUND),
    );
    const store = useMailAccountsStore();
    store.query.openGate();
    await tick();

    await store.actions.makeDefault(ACCOUNTS[1]!);
    expect(ElMessage.error).toHaveBeenCalledWith(
      MAIL_ACCOUNT_ERROR_TEXT[MAIL_ACCOUNT_ERROR_CODES.ACCOUNT_NOT_FOUND],
    );
  });
});
