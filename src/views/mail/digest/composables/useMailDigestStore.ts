// src/views/mail/digest/composables/useMailDigestStore.ts
//
// 2026-10-13 新建：交期汇总邮件页的页面级 Pinia setup store。形态照
// `views/users/composables/useUsersListStore.ts`（切片形态 + `$dispose` 契约 +
// query hook 外提 + Zod 守门 + mutation 统一失效 + 统一错误入口）。
//
// ⚠️ 本页与账号管理页有一处**刻意的结构差异**：`MailScheduleSection` /
// `MailRecipientsSection` / `MailContentSection` / `MailPreviewDialog` /
// `MailLogTable` 五个子组件**不首调 store**，改成纯 props + emits（表单模型从 props
// 进、补丁从 emit 出）。原因：本页的主体不是「一张带筛选的表」而是**一张配置表单**，
// 五个 section 之间的耦合只有「同一个表单模型」，让它们各自持 store 会把 store 变成
// 隐性全局（单测要拖 pinia + vue-query + 三条 query 才能验一个「关掉开关就禁用输入项」
// 的渲染分支）。壳 `MailDigestSettings.vue` 是唯一的 store 消费方与组装方。
//
// 不变量（改动前必读，抄自 useUsersListStore）：
// 1. 必须在 MailDigestSettings.vue 的 setup 内首调。组件外（路由守卫 / 其它 store）禁止。
// 2. MailDigestSettings.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，
//    不 dispose 会把「未保存的表单改动 / 预览弹窗态 / 日志页码」泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问，不写
//    .value（深代理自动解包）。store 内部闭包持 raw 态，照写 .value。
// 4. 不 import vue-router（弹窗全在本页，不需要导航）。

import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { previewMailDigest, saveMailDigestConfig, sendMailDigestNow } from '@/api/mailDigest';
import { qk } from '@/composables/queries/keys';
import type { MailDigestRunPayload } from '@/types/mailDigest';
import {
  DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS,
  DEFAULT_MAIL_DIGEST_FREQUENCY_OPTIONS,
  makeMailDigestFormSchema,
  toMailDigestFieldErrors,
  type MailDigestConfigData,
  type MailDigestFormField,
  type MailDigestFormFieldErrors,
  type MailDigestFormModel,
  type MailDigestFrequencyFlagMap,
  type MailDigestPreviewData,
} from '../mailDigestSchema';
import { MAIL_DIGEST_ERROR_CODES, mailDigestErrorText } from '../mailDigestErrorText';
import {
  useMailDigestConfigQuery,
  useMailDigestLogsQuery,
  useMailDigestMetaQuery,
} from './useMailDigestQuery';

/** 表单初值。刻意不用 `meta.defaults`：本 store 的表单态由 `GET /config` 单方面 hydrate
 *  （config 是真源、meta.defaults 只是后端给的参考值），两者不一致时以 config 为准。 */
function initialFormModel(): MailDigestFormModel {
  return {
    enabled: false,
    frequency: 'MANUAL_ONLY',
    send_hour: null,
    send_minute: null,
    weekday: null,
    day_of_month: null,
    recipients: [],
    cc_recipients: [],
    include_overdue: true,
    include_upcoming: false,
    upcoming_days: 7,
    visible_columns: [],
    subject_template: '',
  };
}

/** 表单态快照（判 dirty 用）。固定键序 + JSON，够用且零依赖：dirty 的判据只是
 *  「与上次服务端快照是否逐字相同」，不需要结构化比较。 */
function snapshot(form: MailDigestFormModel): string {
  return JSON.stringify(form);
}

export const useMailDigestStore = defineStore('mail-digest', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();

  // enabled 闸门：默认 false，由壳的 onMounted 调 `query.openGate()` 开闸。
  // 本页没有持久化筛选（配置表单不该跨会话恢复），所以**不叫 restoreState** ——
  // 叫那个名字会让人去找一份并不存在的 localStorage 快照。
  const ready = ref(false);

  // ============ 切片：form（服务端配置 hydrate 出来的可编辑模型）============
  const form = reactive<MailDigestFormModel>(initialFormModel());
  /** 字段级红字（Zod 校验失败，或后端 21703 / 21704 的映射）。键见 `MailDigestFormField`。 */
  const fieldErrors = ref<MailDigestFormFieldErrors>({});
  /** 需要高亮的字段（Zod 校验或后端错误码指出来的「该改这儿」）。壳把它传给各 section，
   *  section 据此给对应输入项加 `is-focus` 样式 —— 照 users 域「20602 →
   *  formFocusUsername」那条字段聚焦范式。 */
  const focusField = ref<MailDigestFormField | null>(null);
  /** 上一次 hydrate / 保存成功时的表单快照，用于算 dirty。初始即取当前值，
   *  否则首屏在配置到达前会被判成「有未保存改动」而拒绝 hydrate。 */
  const savedSnapshot = ref(snapshot(form));
  /** 与服务端快照有差异。**不做 watcher 判定**：用快照比对天然免疫「hydrate 写字段
   *  顺带把 dirty 置真」这类自触发问题。 */
  const dirty = computed(() => snapshot(form) !== savedSnapshot.value);

  /** 服务端配置 → 表单态。`Object.assign` 整体覆盖（不逐字段 merge）：配置行只有一个,
   *  「服务端没这个字段」不存在。 */
  function applyConfigToForm(config: MailDigestConfigData): void {
    Object.assign(form, {
      enabled: config.enabled,
      frequency: config.frequency,
      send_hour: config.send_hour,
      send_minute: config.send_minute,
      weekday: config.weekday,
      day_of_month: config.day_of_month,
      // 数组一律拷贝：直接挂服务端对象上的数组会让「编辑后对比 savedSnapshot」之外
      // 还多一条隐患（响应对象被换掉时表单跟着跳）。
      recipients: [...config.recipients],
      cc_recipients: [...config.cc_recipients],
      include_overdue: config.include_overdue,
      include_upcoming: config.include_upcoming,
      upcoming_days: config.upcoming_days,
      visible_columns: [...config.visible_columns],
      // 留空串 = 用后端默认标题（提交时转 null），页面不绑 null。
      subject_template: config.subject_template ?? '',
    });
    savedSnapshot.value = snapshot(form);
  }

  /**
   * section 子组件 emit 出来的整份表单模型 → 表单态。
   *
   * ⚠️ **必须 `Object.assign` 整体覆盖、不能整份替换对象**：store 内部闭包（`dirty` /
   *  `validateForm` / `buildRunPayload` / 三条 mutation 的入参组装）都持的是**本函数
   *  创建的那个 reactive 对象**的引用；壳若直接 `store.query.form = next` 换掉引用，
   * 页面看着改了、保存时发的却还是旧值（且 dirty 恒为 false —— 比对的是旧对象）。
   */
  function applyForm(next: MailDigestFormModel): void {
    Object.assign(form, next);
  }

  // ============ 切片：query（三条读端点）============
  const configQuery = useMailDigestConfigQuery({ enabled: ready });
  const metaQuery = useMailDigestMetaQuery({ enabled: ready });

  // 日志分页：页码 / 每页条数是 store 的私有态（壳只绑 v-model）。
  const logsPage = ref(1);
  const logsPageSize = ref(20);
  const logsParams = computed(() => ({
    limit: logsPageSize.value,
    offset: (logsPage.value - 1) * logsPageSize.value,
  }));
  const logsQuery = useMailDigestLogsQuery({ params: logsParams, enabled: ready });

  const items = computed(() => logsQuery.data.value?.items ?? []);
  const logsTotal = computed(() => logsQuery.data.value?.total ?? 0);
  const logsLoading = logsQuery.isFetching;
  const configLoading = configQuery.isFetching;
  /** SMTP 是否已配置。**三态**：`null` = meta 还没回来（此刻不该弹「未配置」告警，
   *  否则首屏会先闪一条假告警再消失）。判据的单一真源是 `GET /meta` 的 `smtp.configured`。 */
  const smtpConfigured = computed<boolean | null>(() => {
    const configured = metaQuery.data.value?.smtp.configured;
    return typeof configured === 'boolean' ? configured : null;
  });
  /** SMTP 明确**未**配置（只在此时弹告警 + 禁用「立即发送」）。 */
  const smtpMissing = computed(() => smtpConfigured.value === false);
  const configErrorText = computed<string | null>(() => {
    const e = configQuery.error.value;
    return e ? mailDigestErrorText(e, '定时配置加载失败') : null;
  });

  /** 频率选项：meta 到达后以 meta 为准（含 label 与三个 needs_*），未到达时用兜底表，
   *  否则首屏频率单选组会是空的、用户连频率都切不了。 */
  const frequencyOptions = computed(
    () => metaQuery.data.value?.frequencies ?? DEFAULT_MAIL_DIGEST_FREQUENCY_OPTIONS,
  );
  /** 表格列白名单候选（meta 驱动，**不**在前端硬编码列名）。 */
  const columnOptions = computed(() => metaQuery.data.value?.columns ?? []);
  /** 「未来 N 天」的取值范围（meta 驱动，后端收窄时前端自动跟随）。 */
  const upcomingDaysRange = computed(
    () => metaQuery.data.value?.upcoming_days_range ?? { min: 1, max: 60 },
  );

  /** 表单校验用的频率判据表：meta 的三个 needs_* 覆盖兜底表。 */
  const frequencyFlags = computed<MailDigestFrequencyFlagMap>(() => {
    const flags: MailDigestFrequencyFlagMap = { ...DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS };
    for (const opt of metaQuery.data.value?.frequencies ?? []) {
      flags[opt.value] = {
        needs_time: opt.needs_time,
        needs_weekday: opt.needs_weekday,
        needs_day_of_month: opt.needs_day_of_month,
      };
    }
    return flags;
  });

  /**
   * 配置 hydrate。两条 options 都是必需的：
   *
   * - `immediate: true`：**缓存命中时 watcher 不会触发**。第二次进页面（30s staleTime
   *   内）时 `useQuery` 创建出来的 `data` 已经是缓存里那份，`watch` 只监听「之后的变化」，
   *   不带 immediate 的话表单永远停在初值 —— 表现为「第二次进页面配置全空，但刷新一下
   *   又好了」。带 immediate 后，store 创建那一刻就 hydrate 一次（此刻 `dirty` 为 false，
   *   不会吃掉用户改动）。
   * - `flush: 'sync'`：40901 分支与「刷新」都是「置 forceHydrate → await 重拉 → 复位
   *   标志」，默认的 pre-flush watcher 会在 await 之后才跑、标志已被复位 ⇒ 强制 hydrate
   *   静默失效（表现为「提示了刷新但表单还是旧值」）。同步 flush 让赋值当场触发回调，
   *   顺序确定。
   */
  const forceHydrate = ref(false);
  watch(
    configQuery.data,
    (config) => {
      if (!config) return;
      // 有未保存改动时不覆盖（后台 refetch / 缓存回填不该吃掉用户正在编辑的内容），
      // 除非是显式的强制重拉（40901 / 刷新按钮）。
      if (dirty.value && !forceHydrate.value) return;
      applyConfigToForm(config);
    },
    { immediate: true, flush: 'sync' },
  );

  /** 重拉配置。`force=true` 时覆盖本地未保存改动（40901 与「刷新」两条路径）。 */
  async function reloadConfig(force: boolean): Promise<void> {
    forceHydrate.value = force;
    try {
      await configQuery.fetchConfig();
    } finally {
      forceHydrate.value = false;
    }
  }

  function openGate(): void {
    ready.value = true;
  }

  /** 「刷新」按钮：三条读端点全刷，配置强制覆盖（用户主动要的就是服务端那份）。 */
  async function refreshAll(): Promise<void> {
    await Promise.all([reloadConfig(true), metaQuery.fetchMeta(), logsQuery.fetchLogs()]);
  }

  const query = {
    form,
    applyForm,
    fieldErrors,
    focusField,
    dirty,
    configLoading,
    configErrorText,
    smtpConfigured,
    smtpMissing,
    frequencyOptions,
    columnOptions,
    upcomingDaysRange,
    items,
    logsTotal,
    logsLoading,
    logsPage,
    logsPageSize,
    openGate,
    refreshAll,
    reloadConfig,
  };

  // ============ 切片：preview（预览弹窗）============
  const previewVisible = ref(false);
  const previewResult = ref<MailDigestPreviewData | null>(null);

  function closePreview(): void {
    previewVisible.value = false;
  }

  // ============ 切片：actions（保存 / 预览 / 立即发送）============
  /** 当前表单 → 三条动作共用的请求体（配置部分，**不含 version**）。
   *
   * `subject_template` 留空 → `null`（= 用后端默认标题），这是「可空标题」在 wire 上的
   *  唯一表示（发空串会让后端拿空标题当模板渲染出无主题邮件）。 */
  function buildRunPayload(): MailDigestRunPayload {
    return {
      enabled: form.enabled,
      frequency: form.frequency,
      send_hour: form.send_hour,
      send_minute: form.send_minute,
      weekday: form.weekday,
      day_of_month: form.day_of_month,
      recipients: [...form.recipients],
      cc_recipients: [...form.cc_recipients],
      include_overdue: form.include_overdue,
      include_upcoming: form.include_upcoming,
      upcoming_days: Number(form.upcoming_days ?? 0),
      visible_columns: [...form.visible_columns],
      subject_template: form.subject_template.trim() === '' ? null : form.subject_template.trim(),
    };
  }

  /**
   * 三条动作共用的前置校验：Zod 过一遍，把 issue 聚合成字段红字 + 高亮字段。
   *
   * @returns true = 可提交（并已把 trim 后的规范化值写回表单）；false = 已提示、已标红。
   */
  function validateForm(): boolean {
    const parsed = makeMailDigestFormSchema(frequencyFlags.value).safeParse({ ...form });
    if (!parsed.success) {
      fieldErrors.value = toMailDigestFieldErrors(parsed.error.issues);
      // 聚焦到第一个出错的字段（数组序即 schema 的声明序，等价于「从上往下第一个问题」）。
      focusField.value =
        (Object.keys(fieldErrors.value)[0] as MailDigestFormField | undefined) ?? null;
      ElMessage.warning('请先修正表单中标红的字段');
      return false;
    }
    // 校验通过 ⇒ 把 trim 后的规范化值写回（邮箱前后空格、后端默认标题的空串都在这里归一）。
    Object.assign(form, parsed.data);
    fieldErrors.value = {};
    focusField.value = null;
    return true;
  }

  /** 写完立即失效本域（配置 + meta + 日志三键一把；「写完看到自己那笔」的优化，
   *  非一致性保证）。 */
  function invalidateMailDigestDomain(): Promise<void> {
    return qc.invalidateQueries({ queryKey: qk.mailDigestPrefix }).then(() => undefined);
  }

  /**
   * 三条 mutation 的 onError 统一入口。
   *
   * 40901 单独分支：它是 OCC 冲突（本端副本已被他人改动），提示与动作都与业务失败不同 ——
   * warning 而非 error，并**强制重拉配置**，否则用户拿着旧 version 再点一次必然再冲突。
   *
   * 21703 / 21704 走字段聚焦：前端校验本该拦下，但服务端是最终判据（邮箱规则、频率组合
   * 都可能比前端严），被拒时必须告诉用户改哪一项，而不是甩一句「操作失败」。
   *
   * ⚠️ 2026-10-14：三处判据一律走 `MAIL_DIGEST_ERROR_CODES` 具名常量，不写裸数字 ——
   * 本域的码段从 215xx 迁到 217xx（215xx 已被后端 outsource 发货域占用）时，漏改一处
   * 裸字面量的后果是**静默失配**：分支不命中 ⇒ 用户拿到的仍是兜底文案、且 focusField
   * 不置位，功能性断言反而测不出来。
   */
  async function handleWriteError(e: Error & { code?: number }, fallback: string): Promise<void> {
    const code = e?.code;
    if (code === MAIL_DIGEST_ERROR_CODES.VERSION_CONFLICT) {
      ElMessage.warning('配置已被他人修改，请刷新后重试');
      await reloadConfig(true);
      return;
    }
    if (code === MAIL_DIGEST_ERROR_CODES.INVALID_RECIPIENT) {
      focusField.value = 'recipients';
    }
    if (code === MAIL_DIGEST_ERROR_CODES.INVALID_FREQUENCY_COMBO) {
      focusField.value = 'frequency';
    }
    ElMessage.error(mailDigestErrorText(e, fallback));
  }

  const saveMutation = useMutation({
    mutationKey: ['mail-digest', 'save-config'],
    mutationFn: (payload: Parameters<typeof saveMailDigestConfig>[0]) =>
      saveMailDigestConfig(payload),
    onSuccess: async (saved) => {
      applyConfigToForm(saved);
      await invalidateMailDigestDomain();
      ElMessage.success('已保存');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '保存失败'),
  });

  const previewMutation = useMutation({
    mutationKey: ['mail-digest', 'preview'],
    mutationFn: (payload: MailDigestRunPayload) => previewMailDigest(payload),
    onSuccess: (result) => {
      previewResult.value = result;
      previewVisible.value = true;
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '预览失败'),
  });

  const sendMutation = useMutation({
    mutationKey: ['mail-digest', 'send'],
    mutationFn: (payload: MailDigestRunPayload) => sendMailDigestNow(payload),
    onSuccess: async () => {
      // 成功也刷日志（这次要立刻看到自己那行）。
      await invalidateMailDigestDomain();
      ElMessage.success('邮件已发送');
    },
    onError: async (e: Error & { code?: number }) => {
      // ⚠️ **失败也刷日志**：后端对 21701 / 21702 已经记了一条 FAILED 日志，只在成功
      // 分支失效的话，用户看到的仍是「发送前的历史」⇒ 刚失败的那次凭空消失，
      // 而「为什么没发出去」正是用户接下来要找的信息。
      await invalidateMailDigestDomain();
      await handleWriteError(e, '发送失败');
    },
  });

  /** 保存。`version` 取 `GET /config` 的 `version`（无行时后端返 0，正是建行锚）。 */
  async function save(): Promise<void> {
    // 焦点标志在每次提交入口复位：它在 handleWriteError 里置真、只在成功分支/再次提交
    // 时复位，不复位的话改完重试会因「true → true」不触发、字段高亮与红字都不再出现。
    focusField.value = null;
    if (!validateForm()) return;
    const version = configQuery.data.value?.version ?? 0;
    try {
      await saveMutation.mutateAsync({
        version,
        enabled: form.enabled,
        frequency: form.frequency,
        send_hour: form.send_hour,
        send_minute: form.send_minute,
        weekday: form.weekday,
        day_of_month: form.day_of_month,
        recipients: [...form.recipients],
        cc_recipients: [...form.cc_recipients],
        include_overdue: form.include_overdue,
        include_upcoming: form.include_upcoming,
        upcoming_days: Number(form.upcoming_days ?? 0),
        visible_columns: [...form.visible_columns],
        subject_template: form.subject_template.trim() === '' ? null : form.subject_template.trim(),
      });
    } catch {
      /* 错误已由 mutation 的 onError 提示，表单保持打开让用户改完重试 */
    }
  }

  /** 预览（**不落库、不发信**）。传的是当前**未保存**的表单态，让用户先看效果再决定保存。 */
  async function preview(): Promise<void> {
    focusField.value = null;
    if (!validateForm()) return;
    try {
      await previewMutation.mutateAsync(buildRunPayload());
    } catch {
      /* 同上 */
    }
  }

  /** 立即发送。调用方（壳的 `el-popconfirm`）负责二次确认 —— 真发不可撤销。 */
  async function sendNow(): Promise<void> {
    focusField.value = null;
    if (!validateForm()) return;
    try {
      await sendMutation.mutateAsync(buildRunPayload());
    } catch {
      /* 同上 */
    }
  }

  const dialogs = {
    preview: {
      visible: previewVisible,
      result: previewResult,
      loading: previewMutation.isPending,
      close: closePreview,
    },
  };

  const actions = {
    saving: saveMutation.isPending,
    previewing: previewMutation.isPending,
    sending: sendMutation.isPending,
    save,
    preview,
    sendNow,
    /** 壳的「立即发送」按钮的禁用判据：正在发 / SMTP 明确未配置。
     *  `smtpConfigured === null`（meta 未回来）**不禁用** —— 那会让按钮在首屏无故灰着，
     *  真发失败时后端会返 21701，页面照样弹人话提示。 */
    sendDisabled: computed(() => sendMutation.isPending.value || smtpMissing.value),
  };

  return {
    query,
    dialogs,
    actions,
  };
});
