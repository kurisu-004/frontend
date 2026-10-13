// src/views/mail/accounts/composables/useMailAccountsStore.ts
//
// 2026-10-16 新建：邮箱账号页的页面级 Pinia setup store。形态照
// `views/mail/digest/composables/useMailDigestStore.ts` 与
// `views/users/composables/useUsersListStore.ts`（切片形态 + `$dispose` 契约 +
// query hook 外提 + Zod 守门 + mutation 统一失效 + 统一错误入口）。
//
// 不变量（改动前必读，抄自 useUsersListStore）：
// 1. 必须在 MailAccountsTab.vue 的 setup 内首调。组件外（路由守卫 / 其它 store）禁止。
// 2. MailAccountsTab.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，
//    不 dispose 会把「填了一半的弹窗 / 弹窗显隐态」泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问，不写
//    .value（深代理自动解包）。store 内部闭包持 raw 态，照写 .value。
// 4. 不 import vue-router（本页没有导航需求）。
//
// ⚠️ **本页的 store 与交期汇总的 store 是两个独立 Pinia 实例**（`mail-accounts` /
// `mail-digest`），共享的只有 `qk.mailAccounts()` 那一条 query 缓存 —— 切 tab 时邮箱列表
// 不重新打（同屏去重），但**表单态互不可见**（这正是 `$dispose` 契约想要的：切走 tab 回来
// 交期汇总页的未保存改动不会留在一个已被销毁的 store 上）。

import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  createMailAccount,
  deleteMailAccount,
  setDefaultMailAccount,
  updateMailAccount,
} from '@/api/mailAccounts';
import { qk } from '@/composables/queries/keys';
import type { SaveMailAccountPayload, UpdateMailAccountPayload } from '@/types/mailAccount';
import {
  makeMailAccountFormSchema,
  toMailAccountFieldErrors,
  type MailAccountData,
  type MailAccountFormFieldErrors,
  type MailAccountFormMode,
  type MailAccountFormModel,
  type MailPresetOptionData,
} from '../mailAccountSchema';
import { mailAccountErrorText } from '../mailAccountErrorText';
import { useMailAccountsQuery, useMailMetaQuery } from './useMailAccountsQuery';

/** 弹窗表单初值。⚠️ **刻意不给 `preset` 一个业务默认**：预设枚举是后端
 *  `GET /mail/meta` 的事，前端硬编一个默认值就等于在「用户没选」与「用户选了 163」之间
 *  做了不可见的决定；`''` 会让 zod 的枚举校验当场标红、逼用户显式选一次。 */
function initialFormModel(): MailAccountFormModel {
  return {
    name: '',
    preset: '' as MailAccountFormModel['preset'],
    account: '',
    secret: '',
  };
}

export const useMailAccountsStore = defineStore('mail-accounts', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();

  // enabled 闸门：默认 false，由壳的 onMounted 调 `query.openGate()` 开闸。
  // 本页没有持久化筛选（配置型 CRUD），所以**不叫 restoreState**。
  const ready = ref(false);

  /** 开闸（壳的 onMounted 调）：true 之后两条 query 各首打一次。
   *
   *  ⚠️ **why 不在 setup 里直接 `enabled: true`**：`useQuery` 在 setup 期就发请求，而
   *  本 store 是壳 setup 里的首调 —— 那时组件还没挂载（`v-loading` 指令、`el-table` 都
   *  还没到位），首屏会先打一发「组件没准备好就要拿数」的请求。闸门把首打推到 onMounted。
   *  照 CLAUDE.md「enabled 闸门：页面 store 内 useQuery 默认 enabled=false」。 */
  function openGate(): void {
    ready.value = true;
  }

  // ============ 切片：query（两条读端点）============
  const accountsQuery = useMailAccountsQuery({ enabled: ready });
  const metaQuery = useMailMetaQuery({ enabled: ready });

  /** 邮箱账号列表。**恒为数组**（拿不到时给 `[]`，页面据此渲染空态而不是 `undefined`）。 */
  const accounts = computed<MailAccountData[]>(() => accountsQuery.data.value ?? []);
  /** 是否至少有一条**带默认标记**的邮箱（判据 = 有行 `is_default`）。后端**新建永不设
   *  默认**、**删掉默认也不会自动转给别的** ⇒ 「零个默认」是正常使用下必然出现的中间态，
   *  壳据此提示「为什么『默认』这一列全是空的」。
   *
   *  ⚠️ **这条判据与发信无关**：后端对 `is_default` 的全部消费只有列表排序与「至多一条为
   *  true」的唯一索引，发信邮箱由 `mail_digest_config.sender_account_id` 决定。所以它
   *  既不 gate 任何写操作、也不进任何请求体。 */
  const hasDefault = computed(() => accounts.value.some((a) => a.is_default));
  const loading = accountsQuery.isFetching;
  /** SMTP 预设选项（`GET /mail/meta`），弹窗下拉的唯一来源。
   *  **三态**：`[]` = meta 还在飞（弹窗里的描述行留空，别显示成「未选预设」）。 */
  const presetOptions = computed<readonly MailPresetOptionData[]>(
    () => metaQuery.data.value?.presets ?? [],
  );

  // ============ 切片：dialogs（新增 / 编辑弹窗）============
  const dialogVisible = ref(false);
  /** 弹窗模式：`create` = 建档（授权码必填）/ `edit` = 改档（授权码留空 = 不改）。 */
  const dialogMode = ref<MailAccountFormMode>('create');
  /** 正在编辑的那一行（`null` = 建档）。只读它取 `version`（OCC 锚）。 */
  const editing = ref<MailAccountData | null>(null);
  const form = reactive<MailAccountFormModel>(initialFormModel());
  /** 字段级红字。键见 `MailAccountFormField`。 */
  const fieldErrors = ref<MailAccountFormFieldErrors>({});

  /** 当前选中预设对应的 server 描述（`host:port:tls_mode`）。读 meta 下发值，前端不推导。 */
  const selectedPresetDetail = computed<MailPresetOptionData | null>(
    () => presetOptions.value.find((p) => p.value === form.preset) ?? null,
  );

  /** 建档：清空表单 + 打开弹窗。 */
  function openCreate(): void {
    dialogMode.value = 'create';
    editing.value = null;
    Object.assign(form, initialFormModel());
    fieldErrors.value = {};
    dialogVisible.value = true;
  }

  /** 改档：把服务端那一行填进表单。
   *
   *  ⚠️ **`secret` 一律留空**：授权码加密入库、出参不带（`mailAccountSchema` 的
   *  `.strict()` 保证连误带出来都会当场抛）。所以编辑弹窗永远没有「回显原授权码」这回事，
   *  placeholder 写「留空表示不修改」，提交空串 = 后端保留原密文。 */
  function openEdit(row: MailAccountData): void {
    dialogMode.value = 'edit';
    editing.value = row;
    Object.assign(form, {
      name: row.name,
      preset: row.preset,
      account: row.account,
      secret: '',
    });
    fieldErrors.value = {};
    dialogVisible.value = true;
  }

  function closeDialog(): void {
    dialogVisible.value = false;
  }

  /**
   * 表单校验：Zod 过一遍，把 issue 聚合成字段红字。
   *
   * @returns true = 可提交（并已把 trim 后的规范化值写回表单）；false = 已提示、已标红。
   */
  function validateForm(): boolean {
    const parsed = makeMailAccountFormSchema(dialogMode.value).safeParse({ ...form });
    if (!parsed.success) {
      fieldErrors.value = toMailAccountFieldErrors(parsed.error.issues);
      ElMessage.warning('请先修正表单中标红的字段');
      return false;
    }
    // 校验通过 ⇒ 把 trim 后的规范化值写回（前后空格在这一刻归一）。
    Object.assign(form, parsed.data);
    fieldErrors.value = {};
    return true;
  }

  /** 正在删除 / 正在设为默认的行 id（`null` = 无）。**按行**而不是布尔：布尔量挂到每一行上
   *  会让每一行的按钮一起转圈，看不出是哪一条在处理。 */
  const deletingRowId = ref<string | null>(null);
  const settingDefaultRowId = ref<string | null>(null);

  // ============ 切片：actions（四条写端点）============
  /** 写完立即失效本域（两条读键一把；「写完立即看到自己那笔」的优化，非一致性保证）。 */
  function invalidateMailDomain(): Promise<void> {
    return qc.invalidateQueries({ queryKey: qk.mailPrefix }).then(() => undefined);
  }

  /**
   * 四条 mutation 的 onError 统一入口。
   *
   * ⚠️ **失败也失效**（下面第一行）：21708（被定时任务引用禁止删除）说明本端副本在失败
   * 那一刻**已经不等于真源** —— 引用关系只有后端知道，列表页无从自证；21706 / 21707
   * 同理（那两条都是「你的副本错了」的信号）。理由同 `useQueueDispatch` 的 OCC 失败分支。
   *
   * ⚠️ 文案一律经 `mailAccountErrorText` 按码查表，**不写裸数字** —— 本域码段
   * （21706..21708）与 mail-digest 域的（21701..21705）**同段相邻**，裸字面量漏改一处
   * 就是静默失配：用户拿到的仍是兜底文案，功能性断言还测不出来。
   */
  async function handleWriteError(e: Error & { code?: number }, fallback: string): Promise<void> {
    await invalidateMailDomain();
    ElMessage.error(mailAccountErrorText(e, fallback));
  }

  const createMutation = useMutation({
    mutationKey: ['mail', 'create-account'],
    mutationFn: (payload: SaveMailAccountPayload) => createMailAccount(payload),
    onSuccess: async () => {
      await invalidateMailDomain();
      ElMessage.success('邮箱已创建');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '创建邮箱失败'),
  });

  const updateMutation = useMutation({
    mutationKey: ['mail', 'update-account'],
    mutationFn: (payload: { id: string; body: UpdateMailAccountPayload }) =>
      updateMailAccount(payload.id, payload.body),
    onSuccess: async () => {
      await invalidateMailDomain();
      ElMessage.success('邮箱已保存');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '保存失败'),
  });

  const deleteMutation = useMutation({
    mutationKey: ['mail', 'delete-account'],
    // ⚠️ 收**整行**而不是 id：两条动作端点（删除 / 设为默认）都必填 `version`（OCC 锚），
    // 只把 id 传下去就必然发一个 `{}` 出去 ⇒ 后端 422 纯文本、连业务码都没有。
    mutationFn: (row: MailAccountData) => deleteMailAccount(row.id, { version: row.version }),
    onSuccess: async () => {
      await invalidateMailDomain();
      ElMessage.success('邮箱已删除');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '删除失败'),
  });

  const setDefaultMutation = useMutation({
    mutationKey: ['mail', 'set-default-account'],
    mutationFn: (row: MailAccountData) => setDefaultMailAccount(row.id, { version: row.version }),
    onSuccess: async () => {
      await invalidateMailDomain();
      // ⚠️ 文案**只报这一次写操作做了什么**（把某行标成默认），不暗示它会改变发信行为：
      // 发信邮箱由交期汇总配置里选的那条决定，`is_default` 只管列表排序（后端零消费方）。
      ElMessage.success('已设为默认');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '设置默认邮箱失败'),
  });

  /** 提交弹窗：按 `dialogMode` 分派建档 / 改档。校验不过不发请求。 */
  async function submit(): Promise<boolean> {
    if (!validateForm()) return false;
    const body = {
      name: form.name,
      preset: form.preset,
      account: form.account,
      // 改档时这里就是空串 = 后端「不改授权码」；建档时校验已保证非空。
      secret: form.secret,
    };
    try {
      if (dialogMode.value === 'edit' && editing.value) {
        await updateMutation.mutateAsync({
          id: editing.value.id,
          // version 是 OCC 锚，必须取**正在编辑那一行**的当前值（后端 40901 会拒过期锚）。
          body: { ...body, version: editing.value.version },
        });
      } else {
        await createMutation.mutateAsync(body);
      }
      closeDialog();
      return true;
    } catch {
      // 错误已由 mutation 的 onError 提示，弹窗保持打开让用户改完重试。
      return false;
    }
  }

  /** 删除。调用方（壳的 `el-popconfirm`）负责二次确认。
   *
   *  收**整行**（不是 id）：动作端点的 body 必填 `version`，取的是**这一行当前**的 OCC 锚。
   *  `deletingRowId` 让壳把 loading 挂在**正在删的那一行**上 —— 布尔量挂在每一行上会让每一行
   *  的按钮一起转圈，而它原来的处境更糟：这两个 loading 暴露在切片里却零消费方，删除进行中
   *  界面毫无反馈、用户会连点好几次（第二次的 OCC 必然 40901）。 */
  async function remove(row: MailAccountData): Promise<void> {
    deletingRowId.value = row.id;
    try {
      await deleteMutation.mutateAsync(row);
    } catch {
      /* 错误已由 onError 提示 */
    } finally {
      deletingRowId.value = null;
    }
  }

  /** 设为默认（⚠️ **只影响列表排序，不影响发信**：发信邮箱由交期汇总配置里
   *  `sender_account_id` 选中的那条决定，后端 `resolve_sender` 不看 `is_default`）。
   *  已是默认的那条**不发请求**（幂等：后端那趟往返没有任何作用，
   *  而失败路径会弹一条「请刷新」之类的噪音）。 */
  async function makeDefault(row: MailAccountData): Promise<void> {
    if (row.is_default) return;
    settingDefaultRowId.value = row.id;
    try {
      await setDefaultMutation.mutateAsync(row);
    } catch {
      /* 同上 */
    } finally {
      settingDefaultRowId.value = null;
    }
  }

  const query = {
    accounts,
    hasDefault,
    loading,
    presetOptions,
    selectedPresetDetail,
    /** 开 enabled 闸门（壳的 onMounted 调）。放在 query 切片里而不是 shell：
     *  它是「让这两条 query 开跑」的动作，与它们同属一组。 */
    openGate,
    refresh: accountsQuery.fetchList,
    fetchMeta: metaQuery.fetchMeta,
  };

  const dialogs = {
    visible: dialogVisible,
    mode: dialogMode,
    editing,
    form,
    fieldErrors,
    openCreate,
    openEdit,
    closeDialog,
  };

  const actions = {
    /** 弹窗保存按钮的转圈态：**建档与改档共用弹窗**，只挂 create 会让改档时按钮不转圈、
     *  用户以为没点上而连点（第二次必然撞 40901）。 */
    saving: computed(() => createMutation.isPending.value || updateMutation.isPending.value),
    /** 正在删除的行 id（`null` = 无）。壳据此把 loading 挂在那一行的按钮上。 */
    deletingRowId,
    /** 正在设为默认的行 id（`null` = 无）。 */
    settingDefaultRowId,
    submit,
    remove,
    makeDefault,
  };

  return {
    query,
    dialogs,
    actions,
  };
});
