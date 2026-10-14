// src/views/wecom/webhooks/composables/useWeComWebhooksStore.ts
//
// 2026-10-17 新建：企业微信 webhook 通道页的页面级 Pinia setup store。形态照
// `views/mail/accounts/composables/useMailAccountsStore.ts`（切片形态 + `$dispose` 契约 +
// query hook 外提 + Zod 守门 + mutation 统一失效 + 统一错误入口）。
//
// 不变量（改动前必读，抄自 useUsersListStore）：
// 1. 必须在 WeComWebhooksTab.vue 的 setup 内首调。组件外（路由守卫 / 其它 store）禁止。
// 2. WeComWebhooksTab.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，不 dispose
//    会把「填了一半的弹窗 / 弹窗显隐态」泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问，不写 .value
//    （深代理自动解包）。store 内部闭包持 raw 态，照写 .value。
// 4. 不 import vue-router（本页没有导航需求）。
//
// ⚠️ **本页的 store 与每日总结的 store 是两个独立 Pinia 实例**（`wecom-webhooks` /
//   `wecom-daily`），共享的只有 `qk.wecomWebhooks()` 那一条 query 缓存 —— 切 tab 时通道列表
//   不重新打（同屏去重），但**表单态互不可见**（这正是 `$dispose` 契约想要的）。

import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  createWeComWebhook,
  deleteWeComWebhook,
  setDefaultWeComWebhook,
  testWeComWebhook,
  updateWeComWebhook,
} from '@/api/wecomWebhooks';
import { qk } from '@/composables/queries/keys';
import type { CreateWeComWebhookPayload, UpdateWeComWebhookPayload } from '@/types/wecom';
import {
  makeWeComWebhookFormSchema,
  toWeComWebhookFieldErrors,
  type WeComWebhookData,
  type WeComWebhookFormFieldErrors,
  type WeComWebhookFormMode,
  type WeComWebhookFormModel,
} from '../weComWebhookSchema';
import { WECOM_WEBHOOK_ERROR_CODES, weComWebhookErrorText } from '../weComWebhookErrorText';
import { useWeComWebhooksQuery } from './useWeComWebhooksQuery';

/** 弹窗表单初值。 */
function initialFormModel(): WeComWebhookFormModel {
  return {
    name: '',
    // ⚠️ **不给 `webhook_url` 一个业务默认值**：它是写入型 secret，用户必须自己从群里复制
    // 过来；预填任何东西都等于替他做了一个他没做的决定（且完整地址一旦预填就会出现在 DOM
    // 里 / 浏览器 autofill 历史里）。
    webhook_url: '',
  };
}

export const useWeComWebhooksStore = defineStore('wecom-webhooks', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();

  // enabled 闸门：默认 false，由壳的 onMounted 调 `query.openGate()` 开闸。
  // 本页没有持久化筛选（配置型 CRUD），所以**不叫 restoreState**。
  const ready = ref(false);

  /** 开闸（壳的 onMounted 调）：true 之后唯一那条 query 首打一次。
   *
   *  ⚠️ **why 不在 setup 里直接 `enabled: true`**：`useQuery` 在 setup 期就发请求，而本 store
   *  是壳 setup 里的首调 —— 那时组件还没挂载（`el-table` 都还没到位），首屏会先打一发「组件
   *  没准备好就要拿数」的请求。闸门把首打推到 onMounted（照 CLAUDE.md「enabled 闸门：页面
   *  store 内 useQuery 默认 enabled=false」）。 */
  function openGate(): void {
    ready.value = true;
  }

  // ============ 切片：query（唯一一条读端点）============
  const webhooksQuery = useWeComWebhooksQuery({ enabled: ready });

  /** webhook 通道列表。**恒为数组**（拿不到时给 `[]`，页面据此渲染空态而不是 `undefined`）。 */
  const webhooks = computed<WeComWebhookData[]>(() => webhooksQuery.data.value ?? []);
  const loading = webhooksQuery.isFetching;
  /** 是否至少有一条**带默认标记**的通道（判据 = 有行 `is_default`）。后端**新建永不设默认**、
   *  **删掉默认也不会自动转给别的** ⇒ 「零个默认」是正常使用下必然出现的中间态，壳据此提示
   *  「为什么『默认』这一列全是空的」。
   *
   *  ⚠️ **这条判据与推送无关**：后端对 `is_default` 的全部消费只有列表排序与「至多一条为
   *  true」的唯一索引，推哪条通道由每日总结配置里的 `webhook_id` 决定。所以它既不 gate 任何
   *  写操作、也不进任何请求体。 */
  const hasDefault = computed(() => webhooks.value.some((w) => w.is_default));
  const listErrorText = computed<string | null>(() => {
    const e = webhooksQuery.error.value;
    return e ? weComWebhookErrorText(e, 'Webhook 列表加载失败') : null;
  });

  // ============ 切片：dialogs（新增 / 编辑弹窗）============
  const dialogVisible = ref(false);
  /** 弹窗模式：`create` = 新建（地址必填）/ `edit` = 改档（地址留空 = 不改）。 */
  const dialogMode = ref<WeComWebhookFormMode>('create');
  /** 正在编辑的那一行（`null` = 新建）。只读它取 `version`（OCC 锚）与 `url_masked`
   *  （编辑弹窗展示「当前地址（掩码）」那一行）。 */
  const editing = ref<WeComWebhookData | null>(null);
  const form = reactive<WeComWebhookFormModel>(initialFormModel());
  /** 字段级红字。键见 `WeComWebhookFormField`。 */
  const fieldErrors = ref<WeComWebhookFormFieldErrors>({});
  /** 正在编辑那一行的**掩码**地址（编辑弹窗展示用）。完整地址永不出参 ⇒ 无从回显。 */
  const editingUrlMasked = computed(() => editing.value?.url_masked ?? '');

  /** 新建：清空表单 + 打开弹窗。 */
  function openCreate(): void {
    dialogMode.value = 'create';
    editing.value = null;
    Object.assign(form, initialFormModel());
    fieldErrors.value = {};
    dialogVisible.value = true;
  }

  /** 改档：把服务端那一行填进表单。
   *
   *  ⚠️ **`webhook_url` 一律留空**：完整地址加密入库、出参只给 `url_masked`
   *  （`weComWebhookSchema` 的 `.strict()` 保证连误带出来都会当场抛）。所以编辑弹窗永远没有
   *  「回显原地址」这回事，placeholder 写「留空表示不修改」，提交空串 = 后端保留原密文。 */
  function openEdit(row: WeComWebhookData): void {
    dialogMode.value = 'edit';
    editing.value = row;
    Object.assign(form, { name: row.name, webhook_url: '' });
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
    const parsed = makeWeComWebhookFormSchema(dialogMode.value).safeParse({ ...form });
    if (!parsed.success) {
      fieldErrors.value = toWeComWebhookFieldErrors(parsed.error.issues);
      ElMessage.warning('请先修正表单中标红的字段');
      return false;
    }
    // 校验通过 ⇒ 把 trim 后的规范化值写回（前后空格在这一刻归一）。
    Object.assign(form, parsed.data);
    fieldErrors.value = {};
    return true;
  }

  /** 正在软删 / 置默认 / 测连通的行 id（`null` = 无）。**按行**而不是布尔：布尔量挂到每一行上
   *  会让每一行的按钮一起转圈，看不出是哪一条在处理。 */
  const deletingRowId = ref<string | null>(null);
  const settingDefaultRowId = ref<string | null>(null);
  const testingRowId = ref<string | null>(null);

  // ============ 切片：actions（五条写端点）============
  /** 写完立即失效本域（唯一那条读键；「写完立即看到自己那笔」的优化，非一致性保证）。 */
  function invalidateWeComWebhooks(): Promise<void> {
    return qc.invalidateQueries({ queryKey: qk.wecomWebhooksPrefix }).then(() => undefined);
  }

  /**
   * 四条**有对象出参**的 mutation 的 onError 统一入口。
   *
   * ⚠️ **失败也失效**：21808（被每日总结引用禁止删除）说明本端副本在失败那一刻**已经不等于
   * 真源** —— 引用关系只有后端知道，列表页无从自证；21806 / 21807 同理。理由同
   * `useQueueDispatch` 的 OCC 失败分支。
   *
   * ⚠️ 40901 单独分支：它是 OCC 冲突，提示与动作都与业务失败不同 —— warning 而非 error。
   *
   * ⚠️ 文案一律经 `weComWebhookErrorText` 按码查表，**不写裸数字** —— 本域码段（21803 /
   * 21806..08）与 wecom-daily 域的（21801 / 21802 / 21804 / 21805）**同段相邻**，裸字面量漏改
   * 一处就是静默失配：用户拿到的仍是兜底文案，功能性断言还测不出来。
   */
  async function handleWriteError(e: Error & { code?: number }, fallback: string): Promise<void> {
    await invalidateWeComWebhooks();
    if (e?.code === WECOM_WEBHOOK_ERROR_CODES.VERSION_CONFLICT) {
      ElMessage.warning('配置已被他人修改，请刷新后重试');
      return;
    }
    ElMessage.error(weComWebhookErrorText(e, fallback));
  }

  const createMutation = useMutation({
    mutationKey: ['wecom', 'create-webhook'],
    mutationFn: (payload: CreateWeComWebhookPayload) => createWeComWebhook(payload),
    onSuccess: async () => {
      await invalidateWeComWebhooks();
      ElMessage.success('Webhook 已创建');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '创建 Webhook 失败'),
  });

  const updateMutation = useMutation({
    mutationKey: ['wecom', 'update-webhook'],
    mutationFn: (payload: { id: string; body: UpdateWeComWebhookPayload }) =>
      updateWeComWebhook(payload.id, payload.body),
    onSuccess: async () => {
      await invalidateWeComWebhooks();
      ElMessage.success('Webhook 已保存');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '保存失败'),
  });

  const deleteMutation = useMutation({
    mutationKey: ['wecom', 'delete-webhook'],
    // ⚠️ 收**整行**而不是 id：软删端点的 body 必填 `version`（OCC 锚），只把 id 传下去就
    // 必然发一个 `{}` 出去 ⇒ 后端 422 纯文本、连业务码都没有。
    mutationFn: (row: WeComWebhookData) => deleteWeComWebhook(row.id, { version: row.version }),
    onSuccess: async () => {
      await invalidateWeComWebhooks();
      ElMessage.success('Webhook 已删除');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '删除失败'),
  });

  const setDefaultMutation = useMutation({
    mutationKey: ['wecom', 'set-default-webhook'],
    mutationFn: (row: WeComWebhookData) => setDefaultWeComWebhook(row.id, { version: row.version }),
    onSuccess: async () => {
      await invalidateWeComWebhooks();
      // ⚠️ 文案**只报这一次写操作做了什么**（把某行标成默认），不暗示它会改变推送行为：
      // 推哪条通道由每日总结配置里选的那条决定，`is_default` 只管列表排序（后端零消费方）。
      ElMessage.success('已设为默认');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '设置默认失败'),
  });

  const testMutation = useMutation({
    mutationKey: ['wecom', 'test-webhook'],
    mutationFn: (row: WeComWebhookData) => testWeComWebhook(row.id),
    onSuccess: async () => {
      // ⚠️ **`/test` 不写 `t_wecom_daily_log`**（它是通道探测、不是内容推送）⇒ 成功分支
      // **刻意不失效**任何 query：失效了只会让每日总结页的发送历史闪一下 loading，而历史里
      // 本来就什么都没多。
      ElMessage.success('测试消息已发出，请到群里确认收到');
    },
    // ⚠️ 失败分支**同样不失效**：它同样没有改变任何一行的数据，失效只会在管理员点「测连通」
    //   失败时把整张表刷一遍、白闪一次 loading。
    onError: (e: Error & { code?: number }) => {
      ElMessage.error(weComWebhookErrorText(e, '测试消息发送失败'));
    },
  });

  /** 提交弹窗：按 `dialogMode` 分派新建 / 改档。校验不过不发请求。 */
  async function submit(): Promise<boolean> {
    if (!validateForm()) return false;
    const body = { name: form.name, webhook_url: form.webhook_url };
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

  /** 软删。调用方（壳的 `el-popconfirm`）负责二次确认。
   *
   *  收**整行**（不是 id）：动作端点的 body 必填 `version`，取的是**这一行当前**的 OCC 锚。
   *  `deletingRowId` 让壳把 loading 挂在**正在删的那一行**上。 */
  async function remove(row: WeComWebhookData): Promise<void> {
    deletingRowId.value = row.id;
    try {
      await deleteMutation.mutateAsync(row);
    } catch {
      /* 错误已由 onError 提示 */
    } finally {
      deletingRowId.value = null;
    }
  }

  /** 设为默认（⚠️ **只影响列表排序，不影响推送**：推哪条通道由每日总结配置里 `webhook_id`
   *  选中的那条决定，后端不回落到本字段）。已是默认的那条**不发请求**（幂等：后端那趟往返
   *  没有任何作用，而失败路径会弹一条「请刷新」之类的噪音）。 */
  async function makeDefault(row: WeComWebhookData): Promise<void> {
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

  /** 测连通。**不需要二次确认**（它只发一条 text 探针、内容固定、可在群里忽略）。 */
  async function test(row: WeComWebhookData): Promise<void> {
    testingRowId.value = row.id;
    try {
      await testMutation.mutateAsync(row);
    } catch {
      /* 同上 */
    } finally {
      testingRowId.value = null;
    }
  }

  const query = {
    webhooks,
    hasDefault,
    loading,
    listErrorText,
    /** 开 enabled 闸门（壳的 onMounted 调）。放在 query 切片里：它是「让这条 query 开跑」的
     *  动作，与它们同属一组。 */
    openGate,
    refresh: webhooksQuery.fetchList,
  };

  const dialogs = {
    visible: dialogVisible,
    mode: dialogMode,
    editing,
    editingUrlMasked,
    form,
    fieldErrors,
    openCreate,
    openEdit,
    closeDialog,
  };

  const actions = {
    /** 弹窗保存按钮的转圈态：**新建与改档共用弹窗**，只挂 create 会让改档时按钮不转圈、
     *  用户以为没点上而连点（第二次必然撞 40901）。 */
    saving: computed(() => createMutation.isPending.value || updateMutation.isPending.value),
    /** 正在软删的行 id（`null` = 无）。壳据此把 loading 挂在那一行的按钮上。 */
    deletingRowId,
    /** 正在置默认的行 id（`null` = 无）。 */
    settingDefaultRowId,
    /** 正在测连通的行 id（`null` = 无）。 */
    testingRowId,
    submit,
    remove,
    makeDefault,
    test,
  };

  return {
    query,
    dialogs,
    actions,
  };
});
