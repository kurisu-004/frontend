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
import type { MailAccountData } from '@/views/mail/accounts/mailAccountSchema';
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
// 2026-10-16：邮箱列表的读 hook 从**另一个域**（`views/mail/accounts/`）引。
// 这条边是允许的：它只引 query hook（无自有状态、无写端点），且两条 useQuery 共用
// 同一条 `qk.mailAccounts()` 缓存 —— 「邮箱设置」tab 与本页的「发信邮箱」下拉拿到的
// 是同一份数据。守门 schema 仍留在 accounts 域自己的目录里（CLAUDE.md「域 schema 与
// query hook 同居」），本 store 不引它。
import { useMailAccountsQuery } from '@/views/mail/accounts/composables/useMailAccountsQuery';

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
    // 2026-10-16：发信邮箱默认「未选」。刻意**不**默认成列表第一条、也不自动选那条
    // `is_default` —— 那是在替用户做「用哪个邮箱发信」的决定。空选的真代价是「发不出信」
    // （后端 21701），不是选错邮箱，所以由告警 + 按钮禁用承担（见 `sendDisabled`）。
    sender_account_id: null,
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
   *  「服务端没这个字段」不存在。
   *
   *  ⚠️ 2026-10-14（review 第 1 轮 M-2）：写入前**按频率判据归一**「当前频率用不到的
   *  配套字段」—— `!needs_time ⇒ send_hour/send_minute = null`，weekday / day_of_month
   *  同理。**为什么必须有这一步**（不是洁癖，是死路）：
   *    - 这三项的输入框由 `MailScheduleSection` 按 `needs_*` 决定显隐，`MANUAL_ONLY`
   *      下**整行连同红字一起不渲染**；
   *    - 而表单里若留着非空的时刻，schema 的「多填即非法」issue 挂在 `send_time` 上 ⇒
   *      屏幕上没有任何红字，`save()` / `preview()` / `sendNow()` 三条路全被
   *      `validateForm()` 拦死，唯一的脱困路径是切到 DAILY 再切回来，UI 上没有任何提示
   *      指向它；
   *    - 而 `GET /config` 完全可能返这样一行：后端 `validate_time` 在 `!needs_time` 时
   *      **直接 Ok、原样存回**（既不清空也不校验），默认行 / 非本页面写入的改动都会留下
   *      这种组合。归一后 form 永远自洽。
   *  归一用的是 `frequencyFlags`（meta 的判据优先，兜底表见
   *  `DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS`）而不是写死的某一张表。两条 read 是并行的，
   *  config 先落地时用的是兜底表 —— 与后端内置语义一致；真正不一致（meta 与前端兜底表
   *  互相矛盾）时表单会在 `validateForm` 里被后到的判据再拦一次，那属于后端与前端默认
   *  值打架，不是本页能单方面消解的。
   *  ⚠️ 本函数声明在 `frequencyFlags` 之前但只在 store setup 跑完之后才被调用
   *  （hydrate watcher 与 mutation 的 onSuccess），不存在 TDZ。
   */
  function applyConfigToForm(config: MailDigestConfigData): void {
    const flags = frequencyFlags.value[config.frequency];
    Object.assign(form, {
      enabled: config.enabled,
      frequency: config.frequency,
      send_hour: flags.needs_time ? config.send_hour : null,
      send_minute: flags.needs_time ? config.send_minute : null,
      weekday: flags.needs_weekday ? config.weekday : null,
      day_of_month: flags.needs_day_of_month ? config.day_of_month : null,
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
      // 2026-10-16：发信邮箱 id 原样搬过来（雪花 ID 恒为 string，不做数字化）。
      sender_account_id: config.sender_account_id,
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

  // 2026-10-16：SMTP 不再是部署级环境变量，改由**页面内可维护的邮箱账号实体**承载
  // （后端 `/api/v2/mail/accounts`，前端 `views/mail/accounts/`）。本页因此多挂一条
  // `qk.mailAccounts()` 的 query —— 与「邮箱设置」那个 tab **共用同一条缓存**（同屏去重
  // / 切 tab 不重新打）。发信地址、授权码、选哪条发信三件事全在这个域里。
  const accountsQuery = useMailAccountsQuery({ enabled: ready });
  /** 可选的发信邮箱（`MailScheduleSection` 的「发信邮箱」下拉选项）。 */
  const senderAccounts = computed<readonly MailAccountData[]>(() => accountsQuery.data.value ?? []);
  /** 邮箱列表是否已到达（`null` = 还在飞）。**三态**不是为了花哨，是因为首屏有一条
   *  「还没有可用邮箱 / 尚未选择发信邮箱」的告警 —— 用二值判据（`length === 0`）会在
   *  列表还在飞时**先闪一条假告警再消失**（与原 `smtpMissing` 同一坑，同一处处置）。 */
  const accountsLoaded = computed<boolean | null>(() =>
    accountsQuery.data.value === undefined ? null : true,
  );
  /** 明确**没有**任何邮箱账号（只在此时说「还没有可用邮箱」）。 */
  const noAccounts = computed(
    () => accountsLoaded.value === true && senderAccounts.value.length === 0,
  );
  /** 明确**尚未选择**发信邮箱（邮箱存在、但本条配置没指定）。⚠️ 判据里**不含**
   *  「当前选中的 id 在列表里找不到」那一支：那属于数据不一致（别的会话删了它），
   *  由写端点的 21706 报，页面照常显示已选中的 id、不擅自把用户的配置改掉。 */
  const senderMissing = computed(
    () =>
      accountsLoaded.value === true && senderAccounts.value.length > 0 && !form.sender_account_id,
  );
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
   * - `immediate: true`：**缓存命中时 watcher 不会触发**。第二次进页面时 `useQuery`
   *   创建出来的 `data` 已经是缓存里那份（⚠️ 2026-10-14 订正：staleTime 走 main.ts 全局
   *   默认 0 ⇒ 挂载即 stale 并后台重取，**同步先交出的是缓存那份**；原文写的「30s
   *   staleTime 内」是错的，本域一个 staleTime 都没设），`watch` 只监听「之后的变化」，
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

  /** 「刷新」按钮：本域三条读端点 + 邮箱列表（2026-10-16 起）全刷。
   *
   *  邮箱列表在这里**不是**补偿某个失效缺口：交期汇总的「发信邮箱」下拉与「邮箱设置」列表
   *  **共用 `qk.mailAccounts()` 那一条 key**，邮箱域四条写端点失效 `qk.mailPrefix` 时会连带
   *  刷到它 ⇒ 同页改完名切回来，下拉已经是新的。把 `fetchList()` 放在这里是**用户显式点了
   *  「刷新」**（语义是「全部给我重来一遍」），不是修补跨前缀失效 —— 真正刷不到的是别的
   *  标签页 / 别的管理员改的名（另一个 QueryClient 实例，本域零 WS 失效通道），那属于
   *  CLAUDE.md「跨页面写操作不做穷举失效」的既定策略。
   *
   *  配置强制覆盖（用户主动要的就是服务端那份）。
   *  ⚠️ 2026-10-14（review 第 1 轮 T-2，非缺陷、记一笔）：`dirty` 为真时点本按钮会
   *  **无提示地丢弃未保存改动**（工具条上只有「有未保存的修改」这句提示，没有二次确认）。
   *  刻意不加 `ElMessageBox.confirm`：刷新是低频的自我纠错动作，而这里每个动作都弹一次
   *  确认会把它变成肌肉记忆式的「随手点掉」；真要防误触，入口级的 dirty 提示已经在了。 */
  async function refreshAll(): Promise<void> {
    await Promise.all([
      reloadConfig(true),
      metaQuery.fetchMeta(),
      logsQuery.fetchLogs(),
      accountsQuery.fetchList(),
    ]);
  }

  const query = {
    form,
    applyForm,
    fieldErrors,
    focusField,
    dirty,
    configLoading,
    configErrorText,
    // 2026-10-16：原 `smtpConfigured` / `smtpMissing` 一对换成下面三个（理由见定义处
    // 的注释）。**改动点提醒**：`smtpConfigured` 已**无消费方**（页面顶部与「立即发送」
    // 的禁用判据都改读 `senderAccounts` / `senderMissing`），故不保留。
    accountsLoaded,
    noAccounts,
    senderMissing,
    senderAccounts,
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
  // ⚠️ 2026-10-14（review 第 1 轮 N-4）：这里原先还有一个 `closePreview()` action
  // 挂在 `dialogs.preview.close` 上，但壳（`MailDigestSettings.vue`）走 `v-model`
  // 直接写 `store.dialogs.preview.visible` ⇒ 全仓零消费方，留着只会让人以为关弹窗有两条
  // 路径。**已删**：关弹窗的唯一路径就是壳的 v-model。
  const previewVisible = ref(false);
  const previewResult = ref<MailDigestPreviewData | null>(null);

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
      // 2026-10-16：发信邮箱 id（雪花 ID ⇒ JSON string，**不要**过 Number()）。
      sender_account_id: form.sender_account_id,
    };
  }

  /**
   * 三条动作共用的前置校验：Zod 过一遍，把 issue 聚合成字段红字 + 高亮字段。
   *
   * @returns true = 可提交（并已把 trim 后的规范化值写回表单）；false = 已提示、已标红。
   */
  function validateForm(): boolean {
    // 两个形参都走 meta 派生的判据（frequencyFlags / upcomingDaysRange）：schema 与
    // 输入项（`:min/:max`）共用同一份真源，后端改范围时前端不会一边放行一边拦。
    const parsed = makeMailDigestFormSchema(
      frequencyFlags.value,
      upcomingDaysRange.value,
    ).safeParse({ ...form });
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
        sender_account_id: form.sender_account_id,
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
    },
  };

  const actions = {
    saving: saveMutation.isPending,
    previewing: previewMutation.isPending,
    sending: sendMutation.isPending,
    save,
    preview,
    sendNow,
    /** 壳的「立即发送」按钮的禁用判据：正在发 / 明确一个可用邮箱都没有 / 有邮箱但本条配置
     *  **没选**。⚠️ 后两条缺一不可，而它们背后的后端事实是：`mail_digest::service::
     *  resolve_sender` 对 `sender_account_id IS NULL` **直接返 21701（HTTP 503）**，
     *  **没有任何回落到默认邮箱的分支**（全仓 `is_default` 在 `mail_digest/` 下零命中，
     *  它只被 `scheduled_task::repo` 用于列表排序与那条唯一索引）。所以「不选也能发」是
     *  一句**假承诺**：不可撤销的「立即发送」上给这种承诺 = 用户点一次、确认一次、
     *  然后吃一个 503。
     *
     *  `accountsLoaded === null`（列表还在飞）**不禁用** —— 那会让按钮在首屏无故灰着；
     *  真发失败时后端会返 21701，页面照样弹人话提示。 */
    sendDisabled: computed(
      () => sendMutation.isPending.value || noAccounts.value || senderMissing.value,
    ),
  };

  return {
    query,
    dialogs,
    actions,
  };
});
