// src/views/wecom/daily/composables/useWeComDailyStore.ts
//
// 2026-10-17 新建：每日总结页的页面级 Pinia setup store。形态照
// `views/mail/digest/composables/useMailDigestStore.ts` 与
// `views/users/composables/useUsersListStore.ts`（切片形态 + `$dispose` 契约 + query hook
// 外提 + Zod 守门 + mutation 统一失效 + 统一错误入口）。
//
// ⚠️ 本页与 webhook 配置页有一处**刻意的结构差异**：`WeComScheduleSection` /
//   `WeComContentSection` / `WeComPreviewDialog` / `WeComLogTable` 四个子组件**不首调 store**，
//   改成纯 props + emits（表单模型从 props 进、补丁从 emit 出）。原因：与邮件域同款 —— 本页
//   的主体不是「一张带筛选的表」而是**一张配置表单**，四个 section 之间的耦合只有「同一个表单
//   模型」，让它们各自持 store 会把 store 变成隐性全局（单测要拖 pinia + vue-query + 三条
//   query 才能验一个「关掉开关就禁用输入项」的渲染分支）。壳 `WeComDailySettings.vue` 是唯一
//   的 store 消费方与组装方。
//
// 不变量（改动前必读，抄自 useUsersListStore）：
// 1. 必须在 WeComDailySettings.vue 的 setup 内首调。组件外（路由守卫 / 其它 store）禁止。
// 2. WeComDailySettings.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，不
//    dispose 会把「未保存的表单改动 / 预览弹窗态 / 日志页码」泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问，不写
//    .value（深代理自动解包）。store 内部闭包持 raw 态，照写 .value。
// 4. 不 import vue-router（弹窗全在本页，不需要导航）。

import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { previewWeComDaily, saveWeComDailyConfig, sendWeComDailyNow } from '@/api/wecomDaily';
import { qk } from '@/composables/queries/keys';
import type { SaveWeComDailyConfigPayload, WeComDailyRunPayload } from '@/types/wecom';
import type { WeComWebhookData } from '@/views/wecom/webhooks/weComWebhookSchema';
// ⚠️ **跨域只读复用**：webhook 列表的读 hook 从**另一个子域**
//   （`views/wecom/webhooks/`）import。这条边是允许的：它只引 query hook（无自有状态、无写
//   端点），且两条 useQuery 共用同一条 `qk.wecomWebhooks()` 缓存 —— 「Webhook 配置」tab 与本页
//   的推送通道下拉拿到的是同一份数据（切 tab 不重新打）。守门 schema 仍留在 webhook 子域自己
//   的目录里（CLAUDE.md「域 schema 与 query hook 同居」），本 store 不引它。照
//   `useMailDigestStore.ts` 引 `useMailAccountsQuery` 的同款做法。
import { useWeComWebhooksQuery } from '@/views/wecom/webhooks/composables/useWeComWebhooksQuery';
import {
  DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS,
  DEFAULT_WECOM_DAILY_FREQUENCY_OPTIONS,
  DEFAULT_WECOM_DAILY_RANGES,
  DEFAULT_WECOM_DAILY_WORKER_METRIC_OPTIONS,
  makeWeComDailyFormSchema,
  toWeComDailyFieldErrors,
  type WeComDailyConfigData,
  type WeComDailyFormField,
  type WeComDailyFormFieldErrors,
  type WeComDailyFormModel,
  type WeComDailyFrequencyFlagMap,
  type WeComDailyPreviewData,
  type WeComDailyRanges,
} from '../weComDailySchema';
import { WECOM_DAILY_ERROR_CODES, weComDailyErrorText } from '../weComDailyErrorText';
import {
  useWeComDailyConfigQuery,
  useWeComDailyLogsQuery,
  useWeComDailyMetaQuery,
} from './useWeComDailyQuery';

/** 表单初值。刻意不用 `meta.defaults`：本 store 的表单态由 `GET /config` 单方面 hydrate
 *  （config 是真源、meta.defaults 只是后端给的参考值），两者不一致时以 config 为准。 */
function initialFormModel(): WeComDailyFormModel {
  return {
    enabled: false,
    frequency: 'MANUAL_ONLY',
    send_hour: null,
    send_minute: null,
    weekday: null,
    day_of_month: null,
    // 推送通道默认「未选」。刻意**不**默认成列表第一条、也不自动选那条 `is_default` ——
    // 那是在替用户做「用哪个通道推」的决定。空选的真代价是「发不出去」（后端 21801），不是
    // 选错通道，所以由告警 + 按钮禁用承担（见 `sendDisabled`）。
    webhook_id: null,
    upcoming_days: 3,
    // 2026-10-23 新增：第三节每个交期分组最多列多少条（0 = 不限，不逐条列出、只出「另有 N 条
    // 未列出」脚注）。
    order_list_limit: 30,
    worker_metric: 'QUANTITY',
    worker_top_n: 15,
    // 2026-10-23：后端把这一项的缺省由 3 提到 6（日报第三节每行 ≈135 字节，4 个分组 × 30 条
    // ≈ 16.4 KB ≈ 5 片，缺省 3 会让一份正常日报直接超限失败）。这段初值只是配置到达前的
    // 一瞬，hydrate 之后一律以 `GET /config` 为准。
    max_chunks: 6,
    include_overview: true,
    include_delivery: true,
    include_orders: true,
    // 2026-10-23 新增：第三节工单行默认挂图纸预览链接。
    include_drawings: true,
    include_workers: true,
    subject_template: '',
  };
}

/** 表单态快照（判 dirty 用）。固定键序 + JSON，够用且零依赖：dirty 的判据只是
 * 「与上次服务端快照是否逐字相同」，不需要结构化比较。 */
function snapshot(form: WeComDailyFormModel): string {
  return JSON.stringify(form);
}

export const useWeComDailyStore = defineStore('wecom-daily', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();

  // enabled 闸门：默认 false，由壳的 onMounted 调 `query.openGate()` 开闸。
  // 本页没有持久化筛选（配置表单不该跨会话恢复），所以**不叫 restoreState**。
  const ready = ref(false);

  // ============ 切片：form（服务端配置 hydrate 出来的可编辑模型）============
  const form = reactive<WeComDailyFormModel>(initialFormModel());
  /** 字段级红字（Zod 校验失败，或后端 21804 的映射）。键见 `WeComDailyFormField`。 */
  const fieldErrors = ref<WeComDailyFormFieldErrors>({});
  /** 需要高亮的字段（Zod 校验或后端错误码指出来的「该改这儿」）。壳把它传给各 section，
   * section 据此给对应输入项加 `is-focus` 样式。 */
  const focusField = ref<WeComDailyFormField | null>(null);
  /** 上一次 hydrate / 保存成功时的表单快照，用于算 dirty。初始即取当前值，否则首屏在配置
   *  到达前会被判成「有未保存改动」而拒绝 hydrate。 */
  const savedSnapshot = ref(snapshot(form));
  /** 与服务端快照有差异。**不做 watcher 判定**：用快照比对天然免疫「hydrate 写字段顺带把
   *  dirty 置真」这类自触发问题。 */
  const dirty = computed(() => snapshot(form) !== savedSnapshot.value);

  /** 服务端配置 → 表单态。`Object.assign` 整体覆盖（不逐字段 merge）：配置行只有一个，
   *  「服务端没这个字段」不存在。
   *
   *  ⚠️ 写入前**按频率判据归一**「当前频率用不到的配套字段」—— `!needs_time ⇒
   *  send_hour/send_minute = null`，weekday / day_of_month 同理。**为什么必须有这一步**（不是
   *  洁癖，是死路）：
   *    - 这三项的输入框由 `WeComScheduleSection` 按 `needs_*` 决定显隐，`MANUAL_ONLY`
   *      下**整行连同红字一起不渲染**；
   *    - 而表单里若留着非空的时刻，schema 的「多填即非法」issue 挂在 `send_time` 上 ⇒ 屏幕
   *      上没有任何红字，`save()` / `preview()` / `sendNow()` 三条路全被 `validateForm()`
   *      拦死，唯一的脱困路径是切到 DAILY 再切回来，UI 上没有任何提示指向它；
   *    - 而 `GET /config` 完全可能返这样一行：后端 `validate_time` 在 `!needs_time` 时直接
   *      Ok、原样存回（默认行 / 非本页面写入的改动都会留下这种组合）。归一后 form 永远自洽。
   *  归一用的是 `frequencyFlags`（meta 的判据优先，兜底表见
   *  `DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS`）而不是写死的某一张表。两条 read 是并行的，config
   *  先落地时用的是兜底表 —— 与后端内置语义一致；真正不一致（meta 与前端兜底表互相矛盾）时
   *  表单会在 `validateForm` 里被后到的判据再拦一次，那属于后端与前端默认值打架，不是本页能
   *  单方面消解的。
   *  ⚠️ 本函数声明在 `frequencyFlags` 之前但只在 store setup 跑完之后才被调用（hydrate
   *  watcher 与 mutation 的 onSuccess），不存在 TDZ。
   */
  function applyConfigToForm(config: WeComDailyConfigData): void {
    const flags = frequencyFlags.value[config.frequency];
    Object.assign(form, {
      enabled: config.enabled,
      frequency: config.frequency,
      send_hour: flags.needs_time ? config.send_hour : null,
      send_minute: flags.needs_time ? config.send_minute : null,
      weekday: flags.needs_weekday ? config.weekday : null,
      day_of_month: flags.needs_day_of_month ? config.day_of_month : null,
      // 通道 id 原样搬过来（雪花 ID 恒为 string，不做数字化）。
      webhook_id: config.webhook_id,
      upcoming_days: config.upcoming_days,
      order_list_limit: config.order_list_limit,
      worker_metric: config.worker_metric,
      worker_top_n: config.worker_top_n,
      max_chunks: config.max_chunks,
      include_overview: config.include_overview,
      include_delivery: config.include_delivery,
      include_orders: config.include_orders,
      include_drawings: config.include_drawings,
      include_workers: config.include_workers,
      // 留空串 = 用后端默认标题（提交时转 null），页面不绑 null。
      subject_template: config.subject_template ?? '',
    });
    savedSnapshot.value = snapshot(form);
  }

  /**
   * section 子组件 emit 出来的整份表单模型 → 表单态。
   *
   * ⚠️ **必须 `Object.assign` 整体覆盖、不能整份替换对象**：store 内部闭包（`dirty` /
   * `validateForm` / `buildRunPayload` / 三条 mutation 的入参组装）都持的是**本函数创建的
   * 那个 reactive 对象**的引用；壳若直接 `store.query.form = next` 换掉引用，页面看着改了、
   * 保存时发的却还是旧值（且 dirty 恒为 false —— 比对的是旧对象）。
   */
  function applyForm(next: WeComDailyFormModel): void {
    Object.assign(form, next);
  }

  // ============ 切片：query（三条读端点 + 一条跨域复用的 webhook 列表）============
  const configQuery = useWeComDailyConfigQuery({ enabled: ready });
  const metaQuery = useWeComDailyMetaQuery({ enabled: ready });

  // 日志分页：页码 / 每页条数是 store 的私有态（壳只绑 v-model）。
  const logsPage = ref(1);
  const logsPageSize = ref(20);
  const logsParams = computed(() => ({
    limit: logsPageSize.value,
    offset: (logsPage.value - 1) * logsPageSize.value,
  }));
  const logsQuery = useWeComDailyLogsQuery({ params: logsParams, enabled: ready });

  const items = computed(() => logsQuery.data.value?.items ?? []);
  const logsTotal = computed(() => logsQuery.data.value?.total ?? 0);
  const logsLoading = logsQuery.isFetching;
  const configLoading = configQuery.isFetching;

  // webhook 通道列表（与「Webhook 配置」tab **共用 `qk.wecomWebhooks()` 那一条缓存**，同屏
  // 去重 / 切 tab 不重新打）。
  const webhooksQuery = useWeComWebhooksQuery({ enabled: ready });
  /** 可选的推送通道（两个 section 的通道下拉选项）。 */
  const webhooks = computed<readonly WeComWebhookData[]>(() => webhooksQuery.data.value ?? []);
  /** 通道列表是否已到达（`null` = 还在飞）。**三态**不是为了花哨，是因为首屏有两条告警 ——
   *  用二值判据（`length === 0`）会在列表还在飞时**先闪一条假告警再消失**。 */
  const webhooksLoaded = computed<boolean | null>(() =>
    webhooksQuery.data.value === undefined ? null : true,
  );
  /** 明确**一条通道都没有**（只在此时说「还没有可用通道」）。 */
  const noWebhooks = computed(() => webhooksLoaded.value === true && webhooks.value.length === 0);
  /** 明确**尚未选择**推送通道（通道存在、但本条配置没指定）。⚠️ 判据里**不含**「当前选中的 id
   *  在列表里找不到」那一支：那属于数据不一致（别的会话删了它），由写端点的 21806 报，页面
   *  照常显示已选中的 id、不擅自把用户的配置改掉。 */
  const webhookMissing = computed(
    () => webhooksLoaded.value === true && webhooks.value.length > 0 && !form.webhook_id,
  );
  const configErrorText = computed<string | null>(() => {
    const e = configQuery.error.value;
    return e ? weComDailyErrorText(e, '每日总结配置加载失败') : null;
  });

  /** 频率选项：meta 到达后以 meta 为准（含 label 与三个 needs_*），未到达时用兜底表，否则
   *  首屏频率单选组会是空的、用户连频率都切不了。 */
  const frequencyOptions = computed(
    () => metaQuery.data.value?.frequencies ?? DEFAULT_WECOM_DAILY_FREQUENCY_OPTIONS,
  );
  /** 条形图指标选项（meta 驱动，**不**在前端硬编码口径）。 */
  const workerMetricOptions = computed(
    () => metaQuery.data.value?.worker_metrics ?? DEFAULT_WECOM_DAILY_WORKER_METRIC_OPTIONS,
  );
  /** 三段取值范围（meta 驱动，后端收窄 / 放宽时前端自动跟随）。 */
  const ranges = computed<WeComDailyRanges>(() => ({
    upcoming_days:
      metaQuery.data.value?.upcoming_days_range ?? DEFAULT_WECOM_DAILY_RANGES.upcoming_days,
    worker_top_n:
      metaQuery.data.value?.worker_top_n_range ?? DEFAULT_WECOM_DAILY_RANGES.worker_top_n,
    max_chunks: metaQuery.data.value?.max_chunks_range ?? DEFAULT_WECOM_DAILY_RANGES.max_chunks,
  }));

  /** 表单校验用的频率判据表：meta 的三个 needs_* 覆盖兜底表。 */
  const frequencyFlags = computed<WeComDailyFrequencyFlagMap>(() => {
    const flags: WeComDailyFrequencyFlagMap = { ...DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS };
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
   * 配置 hydrate。两个 options 都是必需的：
   *
   * - `immediate: true`：**缓存命中时 watcher 不会触发**。第二次进页面时 `useQuery` 创建出来
   *   的 `data` 已经是缓存里那份（⚠️ 本域没设 staleTime ⇒ 走 TanStack v5 默认 0 ⇒ 挂载即
   *   stale 并后台重取，**同步先交出的是缓存那份**），`watch` 只监听「之后的变化」，不带
   *   immediate 的话表单永远停在初值 —— 表现为「第二次进页面配置全空，但刷新一下又好了」。
   *   带 immediate 后，store 创建那一刻就 hydrate 一次（此刻 `dirty` 为 false，不会吃掉用户
   *   改动）。
   * - `flush: 'sync'`：40901 分支与「刷新」都是「置 forceHydrate → await 重拉 → 复位标志」，
   *   默认的 pre-flush watcher 会在 await 之后才跑、标志已被复位 ⇒ 强制 hydrate 静默失效
   *   （表现为「提示了刷新但表单还是旧值」）。同步 flush 让赋值当场触发回调，顺序确定。
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

  /** 重拉配置并**强制覆盖**本地未保存改动。**只有两条路径会走到这里**（40901 冲突后重试、
   *  用户显式点「刷新」），两条的诉求都是「给我服务端那份」⇒ 不提供「不强制」的开关 ——
   *  后台 refetch（缓存过期 / 别的写点失效 / 另一个管理员改了）不经过本函数，它由上面 watcher
   *  的 `dirty` 闸门自己挡掉（守卫见 `__tests__/useWeComDailyStore.spec.ts` 的 H2）。
   *
   *  `forceHydrate` 必须跨 `await` 保持为真并在 `finally` 里复位：TanStack 在 fetch 落地时才把
   *  新 data 推给 watcher，而 watcher 是 `flush: 'sync'` 同步跑的 ⇒ 复位早一步就等于没强制。 */
  async function reloadConfig(): Promise<void> {
    forceHydrate.value = true;
    try {
      await configQuery.fetchConfig();
    } finally {
      forceHydrate.value = false;
    }
  }

  function openGate(): void {
    ready.value = true;
  }

  /** 「刷新」按钮：本域三条读端点 + 通道列表全刷。
   *
   *  通道列表在这里**不是**补偿某个失效缺口：「Webhook 配置」列表与本页的通道下拉**共用
   *  `qk.wecomWebhooks()` 那一条 key**，webhook 域四条写端点失效 `qk.wecomWebhooksPrefix` 时会
   *  连带刷到它 ⇒ 同页里改完通道名切回来，下拉已经是新的。把 `fetchList()` 放在这里是**用户
   *  显式点了「刷新」**（语义是「全部给我重来一遍」），不是修补跨前缀失效 —— 真正刷不到的是
   *  别的标签页 / 别的管理员改的名（另一个 QueryClient 实例，本域零 WS 失效通道），那属于
   *  CLAUDE.md「跨页面写操作不做穷举失效」的既定策略。
   *
   *  ⚠️ 配置强制覆盖（用户主动要的就是服务端那份）。`dirty` 为真时点本按钮会**无提示地丢弃
   *  未保存改动**（工具条上只有「有未保存的修改」这句提示，没有二次确认）—— 刻意不加
   *  `ElMessageBox.confirm`：刷新是低频的自我纠错动作，而这里每个动作都弹一次确认会把它变成
   *  肌肉记忆式的「随手点掉」；真要防误触，入口级的 dirty 提示已经在了。
   */
  async function refreshAll(): Promise<void> {
    await Promise.all([
      reloadConfig(),
      metaQuery.fetchMeta(),
      logsQuery.fetchLogs(),
      webhooksQuery.fetchList(),
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
    // 顶部两条告警 + 「立即发送」按钮禁用判据的数据源（各自三态，见定义处）。
    webhooksLoaded,
    noWebhooks,
    webhookMissing,
    webhooks,
    frequencyOptions,
    workerMetricOptions,
    ranges,
    items,
    logsTotal,
    logsLoading,
    logsPage,
    logsPageSize,
    openGate,
    refreshAll,
  };

  // ============ 切片：preview（预览弹窗）============
  const previewVisible = ref(false);
  const previewResult = ref<WeComDailyPreviewData | null>(null);

  // ============ 切片：actions（保存 / 预览 / 立即发送）============
  /** 当前表单 → 三条动作共用的请求体（配置部分，**不含 version**）。
   *
   * `subject_template` 留空 → `null`（= 用后端默认标题），这是「可空标题」在 wire 上的唯一
   * 表示（发空串会让后端拿空标题当模板渲染出无主题消息）。 */
  function buildRunPayload(): WeComDailyRunPayload {
    return {
      enabled: form.enabled,
      frequency: form.frequency,
      send_hour: form.send_hour,
      send_minute: form.send_minute,
      weekday: form.weekday,
      day_of_month: form.day_of_month,
      // 通道 id（雪花 ID ⇒ JSON string，**不要**过 Number()）。
      webhook_id: form.webhook_id,
      upcoming_days: Number(form.upcoming_days ?? 0),
      order_list_limit: Number(form.order_list_limit ?? 0),
      worker_metric: form.worker_metric,
      worker_top_n: Number(form.worker_top_n ?? 0),
      max_chunks: Number(form.max_chunks ?? 0),
      include_overview: form.include_overview,
      include_delivery: form.include_delivery,
      include_orders: form.include_orders,
      include_drawings: form.include_drawings,
      include_workers: form.include_workers,
      subject_template: form.subject_template.trim() === '' ? null : form.subject_template.trim(),
    };
  }

  /**
   * 三条动作共用的前置校验：Zod 过一遍，把 issue 聚合成字段红字 + 高亮字段。
   *
   * @returns true = 可提交（并已把 trim 后的规范化值写回表单）；false = 已提示、已标红。
   */
  function validateForm(): boolean {
    // 两个形参都走 meta 派生的判据（frequencyFlags / ranges）：schema 与输入项
    // （`:min/:max`）共用同一份真源，后端改范围时前端不会一边放行一边拦。
    const parsed = makeWeComDailyFormSchema(frequencyFlags.value, ranges.value).safeParse({
      ...form,
    });
    if (!parsed.success) {
      fieldErrors.value = toWeComDailyFieldErrors(parsed.error.issues);
      // 聚焦到第一个出错的字段（数组序即 schema 的声明序，等价于「从上往下第一个问题」）。
      focusField.value =
        (Object.keys(fieldErrors.value)[0] as WeComDailyFormField | undefined) ?? null;
      ElMessage.warning('请先修正表单中标红的字段');
      return false;
    }
    // 校验通过 ⇒ 把 trim 后的规范化值写回（标题模板前后空格、空串→null 都在这里归一）。
    Object.assign(form, parsed.data);
    fieldErrors.value = {};
    focusField.value = null;
    return true;
  }

  /** 保存成功 / 预览失败后失效本域前缀（config + meta 两键一把；**不含 logs** —— 保存配置不
   *  改变任何一条历史行，理由见 `keys.ts` 的 wecom-daily 段）。 */
  function invalidateWeComDailyConfig(): Promise<void> {
    return qc.invalidateQueries({ queryKey: qk.wecomDailyPrefix }).then(() => undefined);
  }

  /** 立即发送成败都失效**日志那一条精确键**（不是前缀！理由见 `keys.ts`：翻页 / 存配置都不该
   *  连带刷它，而发送成败必须刷它 —— 失败时后端仍记了一条 FAILED 流水）。 */
  function invalidateWeComDailyLogs(): Promise<void> {
    return qc
      .invalidateQueries({ queryKey: qk.wecomDailyLogs(logsParams.value) })
      .then(() => undefined);
  }

  /**
   * 三条 mutation 的 onError 统一入口。
   *
   * 40901 单独分支：它是 OCC 冲突（本端副本已被他人改动），提示与动作都与业务失败不同 ——
   * warning 而非 error，并**强制重拉配置**，否则用户拿着旧 version 再点一次必然再冲突。
   *
   * 21804 走字段聚焦：前端校验本该拦下，但服务端是最终判据（频率组合 / 数值范围都可能比前端
   * 严），被拒时必须告诉用户改哪一项，而不是甩一句「操作失败」。
   *
   * ⚠️ 判据一律走 `WECOM_DAILY_ERROR_CODES` 具名常量，不写裸数字 —— 本域与 webhook 子域同段
   * 相邻，裸字面量漏改一处的后果是**静默失配**：分支不命中 ⇒ 用户拿到的仍是兜底文案、且
   * focusField 不置位，功能性断言反而测不出来。
   */
  async function handleWriteError(e: Error & { code?: number }, fallback: string): Promise<void> {
    const code = e?.code;
    if (code === WECOM_DAILY_ERROR_CODES.VERSION_CONFLICT) {
      ElMessage.warning('配置已被他人修改，请刷新后重试');
      await reloadConfig();
      return;
    }
    if (code === WECOM_DAILY_ERROR_CODES.CONFIG_INVALID) {
      focusField.value = 'frequency';
    }
    ElMessage.error(weComDailyErrorText(e, fallback));
  }

  const saveMutation = useMutation({
    mutationKey: ['wecom-daily', 'save-config'],
    mutationFn: (payload: SaveWeComDailyConfigPayload) => saveWeComDailyConfig(payload),
    onSuccess: async (saved) => {
      applyConfigToForm(saved);
      await invalidateWeComDailyConfig();
      ElMessage.success('已保存');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '保存失败'),
  });

  const previewMutation = useMutation({
    mutationKey: ['wecom-daily', 'preview'],
    mutationFn: (payload: WeComDailyRunPayload) => previewWeComDaily(payload),
    onSuccess: (result) => {
      previewResult.value = result;
      previewVisible.value = true;
    },
    // ⚠️ 预览**刻意不失效**：它只渲染、不发送、不落流水，服务端的配置 / meta / 日志三个
    //  数据源一个字节都没变。失效只会让弹窗打开的同时背景表格闪一下 loading。
    onError: (e: Error & { code?: number }) => handleWriteError(e, '预览失败'),
  });

  const sendMutation = useMutation({
    mutationKey: ['wecom-daily', 'send'],
    mutationFn: (payload: WeComDailyRunPayload) => sendWeComDailyNow(payload),
    onSuccess: async () => {
      // 成功也刷日志（这次要立刻看到自己那行）。
      await invalidateWeComDailyLogs();
      ElMessage.success('企业微信消息已发送');
    },
    onError: async (e: Error & { code?: number }) => {
      // ⚠️ **失败也刷日志**：后端对 21801 / 21802 已经记了一条 FAILED 流水，只在成功分支失效
      // 的话，用户看到的仍是「发送前的历史」⇒ 刚失败的那次凭空消失，而「为什么没发出去」正是
      // 用户接下来要找的信息。
      await invalidateWeComDailyLogs();
      await handleWriteError(e, '发送失败');
    },
  });

  /** 保存。`version` 取 `GET /config` 的 `version`（无行时后端返 0，正是建行锚）。
   *
   *  ⚠️ 请求体**逐字段写全**而不是 `{ version, ...buildRunPayload() }`：后者是
   *  `Partial<…>`，要变成 `SaveWeComDailyConfigPayload` 得靠一次 `as` 断言 —— 而断言正是「后端
   *  新增一个必填配置字段、本地漏发、用户在浏览器过、后端 422」这条路的入口。逐字段写全时，
   *  后端加字段后 `typecheck` 会当场把这里判红。 */
  async function save(): Promise<void> {
    // 焦点标志在每次提交入口复位：它在 handleWriteError 里置真、只在成功分支/再次提交时复位，
    // 不复位的话改完重试会因「true → true」不触发、字段高亮与红字都不再出现。
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
        webhook_id: form.webhook_id,
        upcoming_days: Number(form.upcoming_days ?? 0),
        order_list_limit: Number(form.order_list_limit ?? 0),
        worker_metric: form.worker_metric,
        worker_top_n: Number(form.worker_top_n ?? 0),
        max_chunks: Number(form.max_chunks ?? 0),
        include_overview: form.include_overview,
        include_delivery: form.include_delivery,
        include_orders: form.include_orders,
        include_drawings: form.include_drawings,
        include_workers: form.include_workers,
        subject_template: form.subject_template.trim() === '' ? null : form.subject_template.trim(),
      });
    } catch {
      /* 错误已由 mutation 的 onError 提示，表单保持打开让用户改完重试 */
    }
  }

  /** 预览（**不落库、不发送、不写流水**）。传的是当前**未保存**的表单态，让用户先看效果、
   *  看清楚「这次要发几条」再决定保存。 */
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
    },
  };

  const actions = {
    saving: saveMutation.isPending,
    previewing: previewMutation.isPending,
    sending: sendMutation.isPending,
    save,
    preview,
    sendNow,
    /** 壳的「立即发送」按钮的禁用判据：正在发 / 明确一个可用通道都没有 / 有通道但本条配置
     *  **没选**。⚠️ 后两条缺一不可，而它们背后的后端事实是：对 `webhook_id IS NULL`（或指向已
     *  被软删的行）**直接返 21801**，**没有任何回落到 `is_default` 的分支**（后端对
     *  `is_default` 的全部消费只有列表排序与那条唯一索引）。所以「不选也能发」是一句**假承诺**：
     * 不可撤销的「立即发送」上给这种承诺 = 用户点一次、确认一次、然后吃一个 21801。
     *
     *  `webhooksLoaded === null`（列表还在飞）**不禁用** —— 那会让按钮在首屏无故灰着；真发
     *  失败时后端会返 21801，页面照样弹人话提示。 */
    sendDisabled: computed(
      () => sendMutation.isPending.value || noWebhooks.value || webhookMissing.value,
    ),
  };

  return {
    query,
    dialogs,
    actions,
  };
});
