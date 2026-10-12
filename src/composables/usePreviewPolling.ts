// src/composables/usePreviewPolling.ts
//
// 图纸预览的「转图轮询」编排（2026-10-13 新增）。
//
// 后端 `GET /files/objects/{id}/preview` 把转码状态做成**显式两态**而不是让前端
// 自己猜：`PENDING` 时给一个建议重试间隔 `retry_after_ms`。**失败不在 `state` 里**
// —— 失败一律走 HTTP 5xx + 信封业务码（21117 / 21118），所以失败语义一律按
// `ApiError.code` 分流，见 `types/part_file.ts` 的「转图失败的错误码分流」。
//
// 本 composable 是建议重试间隔的唯一执行者 —— api 层（`api/files/objects.ts::
// getPartFilePreview`）只发一次请求，不带任何定时器。
//
// 状态互斥优先级：`loading` > `degraded` > `ready`。
//   - `ready`    = 转图完成，`pages` 非空 → 承载点渲染 `<ImagePager :pages>`；
//   - `loading`  = 首次请求在途 / PENDING 等待中（含退避间隔）→ 承载点转圈；
//   - `degraded` = 端点不支持 / 转码失败 / 轮询预算耗尽 → 承载点**回落 `/content`
//                  原始 PDF 路径**，并把 `degradedReason` 显式挂到 UI 上。
//
// ⚠️ **降级必须是有告知的**：`degraded` 不是静默兜底。每个降级原因都会填进
// `degradedReason`，承载点必须把它渲染出来（一行提示即可）—— 否则 CI 挂了没人
// 知道，现场只会看到「预览变慢了 / 变成 PDF 了」而查不出原因。
//
// ⚠️ **本文件不自己写一套错误分类**。错误一律是 `api/http.ts` 抛出的 `ApiError`
// （信封 `{code, message}` + 网络错误 code 0），本层只做三件事：认
// `isPreviewUnsupportedError` 那组「重试没有意义」的码（立即降级）、认
// `isPreviewSelfHealError` 那组「允许有限自愈」的码（按次数上限后降级）、
// 其余原样带上 `message` 继续退避重试；预算耗尽时把**最后一次错误的 message**
// 写进 `degradedReason`。判定「该不该重试」的语义全在后端码表里，不在前端另立一套。
//
// 并发控制：竞态守卫沿 `PartDrawingPreviewDialog.vue` 的 `previewToken` 范式
// （自增 token + 响应回来比对），并额外用 `AbortSignal` **真正中断在途请求** ——
// 只比对 token 的话，连续切文件时旧请求仍占着连接与后端转码队列。

import { computed, onScopeDispose, ref, toValue, watch } from 'vue';
import type { ComputedRef, MaybeRefOrGetter } from 'vue';
import { getPartFilePreview } from '@/api/files/objects';
import {
  isPreviewSelfHealError,
  isPreviewUnsupportedError,
  PREVIEW_SELF_HEAL_MAX_RETRY,
  type FilePreviewResult,
} from '@/types/part_file';

// ============ 轮询预算 ============
//
// 三条闸取同一个量级理由：后端 CI 转码一份典型工程图（几十页 PDF）通常**几秒到
// 几十秒**，冷启动（CI runner 拉镜像 + 装 poppler）最坏到分钟级。三条闸任一到点就
// 降级，理由是「用户点开图纸愿意等的时长」有上限 —— 车间工控机上让人对着转圈等两
// 分钟不可接受，不如退回原始 PDF 立即可看。
//
// 为什么同时要「次数上限」和「墙钟上限」两条，它们各堵一个退化方向（下列量级都按
// MIN / MAX_RETRY_DELAY_MS 的实参算出，不是估算）：
//   - 只看次数：后端把 `retry_after_ms` 调大（如 8s，即本层封顶值）时，30 次能撑到
//     ≈ 4 分钟，远超人能等的时长；
//   - 只看墙钟：若后端持续不给建议间隔（退避落 MIN_RETRY_DELAY_MS = 1s），120s 墙钟
//     内能打出去 120 次 —— 次数闸不管时这个量级足以把后端转码队列冲垮。
/** 单次请求之间的最小等待：不给 0，防止后端未配 `retry_after_ms` 时变请求风暴。 */
const MIN_RETRY_DELAY_MS = 1_000;
/** 单次等待的硬上限：后端给了 60s 也只等这么多，否则一轮退避就能吃掉整个预算。 */
const MAX_RETRY_DELAY_MS = 8_000;
/** 轮询总次数上限（含首次请求）。 */
const MAX_ATTEMPTS = 30;
/** 轮询墙钟上限：与 MAX_ATTEMPTS 谁先到谁生效。 */
const MAX_ELAPSED_MS = 120_000;
/** 指数退避倍率：第 n 次等待 = min(建议值 × BACKOFF_FACTOR^(n-1), MAX_RETRY_DELAY_MS)。 */
const BACKOFF_FACTOR = 1.6;

/**
 * 与后端节流的关系（两侧各有一道闸，**不打架**，改任一侧前先读这段）。
 *
 * 后端 `PreviewService` 用 `next_poll_at` 节流：`PENDING` 且未到期时直接返 PENDING，
 * **一次外部 IO（python describe / COS）都不打**。本层的单次等待被夹在
 * `[MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS]`、后端缺省 2s（可经 env `PREVIEW_POLL_BACKOFF_SECONDS` 调，1..=5）
 * ⇒ 本层第 1 次等待就是 2s，与后端节流齐平；之后指数退避只会让本层**比后端更慢**
 * （2s → 3.2s → 5.1s → 8s），永远不会抢在节流戳前面把后端打成热路径（2026-10-13 订正：后端该节流值改为 env 可配）。
 * 反向也不构成浪费：本层若偶发抢快（错误重试路径固定 1s），后端也只是多返一次
 * 「未到期 + 剩余 retry_after_ms」的零 IO 响应。⇒ 两侧是叠加的闸，不是竞争的重试。
 */

/** 消费侧拿到的预览状态。 */
export type PreviewPollingState = 'IDLE' | 'PENDING' | 'READY' | 'DEGRADED';

export interface UsePreviewPollingOptions {
  /** 预览的文件对象 id（**不是** part / assembly id）；null / undefined / 空串 ⇒ 不发请求。 */
  fileId: MaybeRefOrGetter<string | null | undefined>;
  /**
   * 宿主开关（如弹窗是否打开、tab 是否激活）。false ⇒ 立即中断在途请求并清零状态，
   * 回到 `IDLE`。默认 true。
   */
  enabled?: MaybeRefOrGetter<boolean>;
}

export interface UsePreviewPollingReturn {
  /** 转图完成后的逐页图片直链；非 `READY` 态恒为空数组（消费侧不必判空再取长度）。 */
  pages: ComputedRef<string[]>;
  /** 转码总页数；仅 `READY` 时有意义（后端在 `PENDING` 阶段可能还不知道）。 */
  pageCount: ComputedRef<number>;
  /** 当前状态，四态见 `PreviewPollingState`。 */
  state: ComputedRef<PreviewPollingState>;
  /** 转图是否就绪（`state === 'READY'`）。 */
  ready: ComputedRef<boolean>;
  /** 是否处于「在途 / PENDING 等待」态，承载点据此转圈。 */
  loading: ComputedRef<boolean>;
  /** 是否已降级（端点不支持 / CI 失败 / 预算耗尽）⇒ 承载点应走原始 PDF 路径。 */
  degraded: ComputedRef<boolean>;
  /**
   * 降级原因（人类可读）。**承载点必须把它渲染出来** —— 静默降级会让 CI 故障无人察觉。
   */
  degradedReason: ComputedRef<string | null>;
  /** 手动重试（承载点「重试」按钮）；重置预算并重新发首请求。 */
  retry: () => void;
  /** 主动中断（关弹窗 / 切文件时由 watcher 自动调，也可手动调）。 */
  stop: () => void;
}

/**
 * 图纸预览转码轮询。
 *
 * 用法：
 * ```ts
 * const preview = usePreviewPolling(() => props.fileId, () => props.visible);
 * ```
 * 模板侧见各承载点，四条互斥分支固定为 `loading` → `degraded`（原始 PDF + 一行
 * `degradedReason`）→ `ready`（`<ImagePager>`）→ 空态。
 *
 * ⚠️ composable 必须在 `setup` 同步段调用（内部有 `watch` + `onScopeDispose`）。
 */
export function usePreviewPolling(options: UsePreviewPollingOptions): UsePreviewPollingReturn {
  const pages = ref<string[]>([]);
  const pageCount = ref(0);
  const state = ref<PreviewPollingState>('IDLE');
  const degradedText = ref<string | null>(null);
  const inFlight = ref(false);

  // 竞态守卫：每次起跑自增，响应回来比对，不符即丢弃（沿 previewToken 范式）。
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 中断在途请求与待触发的下一次轮询，并把状态清零。 */
  function stop(): void {
    token += 1;
    clearTimer();
    controller?.abort();
    controller = null;
    inFlight.value = false;
    state.value = 'IDLE';
    pages.value = [];
    pageCount.value = 0;
    degradedText.value = null;
  }

  /**
   * 降级并停手。`reason` 直接进 `degradedReason`，承载点必须显示它 ——
   * 「预览退回原始 PDF」这件事用户要知道，否则 CI 挂了会静默很久。
   */
  function degrade(reason: string): void {
    clearTimer();
    inFlight.value = false;
    state.value = 'DEGRADED';
    pages.value = [];
    degradedText.value = reason;
  }

  /** 等 `ms`；期间 token 被改（切文件 / 卸载）则 resolve(false)，调用方立刻收手。 */
  function sleep(ms: number, myToken: number): Promise<boolean> {
    return new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        resolve(myToken === token);
      }, ms);
    });
  }

  /**
   * 第 `attempt` 次（1-based）的等待时长。
   *
   * - **有建议间隔** ⇒ 以它为基数做指数退避（`base × 1.6^(n-1)`），封顶
   *   `MAX_RETRY_DELAY_MS`；
   * - **没有建议间隔**（后端未配 / 请求直接失败）⇒ 固定用下限，**不叠退避**。理由：
   *   没有建议间隔本身就意味着「后端也给不出量级」，此时固定 1s + 次数闸已经把请求数
   *   钉死在 30 次 / ~30 秒，再叠指数只会拉长等待却不降低请求总数（总数已被次数闸封顶）。
   *
   * 两条路径都进同一个 `sleep`，所以**错误重试与 PENDING 重试一样有节流** —— 这里漏掉
   * 就会变成「持续 5xx 时零间隔连打 30 次」。
   */
  function delayOf(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs === null || retryAfterMs <= 0) return MIN_RETRY_DELAY_MS;
    const base = Math.min(Math.max(retryAfterMs, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
    return Math.min(Math.round(base * BACKOFF_FACTOR ** (attempt - 1)), MAX_RETRY_DELAY_MS);
  }

  async function run(myToken: number, fileId: string): Promise<void> {
    const startedAt = Date.now();
    let attempt = 0;
    /** 末次错误文案：预算耗尽时用它说明「为什么退回」，让降级原因可追因。 */
    let lastErrMsg: string | null = null;
    /** 已用掉的自愈重试次数：后端对 21117 的自愈 = 重新提交一个按页计费的 CI job，故封顶。 */
    let selfHealLeft = PREVIEW_SELF_HEAL_MAX_RETRY;

    while (myToken === token) {
      if (attempt >= MAX_ATTEMPTS) {
        degrade(
          `图纸转图等待超时（已重试 ${MAX_ATTEMPTS} 次）${lastErrMsg ? `：${lastErrMsg}` : ''}，已改用原始 PDF 预览`,
        );
        return;
      }
      if (Date.now() - startedAt >= MAX_ELAPSED_MS) {
        degrade(
          `图纸转图等待超时（已等 ${Math.round(MAX_ELAPSED_MS / 1000)} 秒）${lastErrMsg ? `：${lastErrMsg}` : ''}，已改用原始 PDF 预览`,
        );
        return;
      }
      attempt += 1;
      inFlight.value = true;
      const myController = new AbortController();
      controller = myController;

      // 结果与异常都不在 catch 里处理，先摊平成两个变量再走下面的分支：
      //   - catch 里带 await（错误重试要 sleep）会把 finally 拖到 sleep 之后，
      //     期间 controller 仍挂着一次已经结束请求的旧 controller；
      //   - 摊平后 token 比对只有一处，不会漏掉「响应回来时已切文件」这条。
      let result: FilePreviewResult | null = null;
      let caught: unknown = null;
      try {
        result = await getPartFilePreview(fileId, myController.signal);
      } catch (e) {
        caught = e;
      } finally {
        // 只清自己那一个：中途 stop() + 新一轮 start() 可能已经把 controller 换成
        // 新的，无条件置 null 会把新那轮的 AbortController 顺手摘掉，此后 stop()
        // 就 abort 不到在途请求了。
        if (controller === myController) controller = null;
      }

      if (myToken !== token) return;

      if (caught !== null) {
        lastErrMsg = (caught as Error)?.message || '网络异常';
        // 重试没有意义的码（不支持转图 / 转发链路不通 / 无信封的代理层错误）⇒ 立即降级。
        if (isPreviewUnsupportedError(caught)) {
          degrade(`图纸转图预览不可用（${lastErrMsg}），已改用原始 PDF 预览`);
          return;
        }
        // 转码终态失败：后端下一次调用会把 FAILED 重置并**重新提交一个 CI job**，
        // 而 CI 按页计费 ⇒ 只给 `PREVIEW_SELF_HEAL_MAX_RETRY` 次机会，用完即降级。
        if (isPreviewSelfHealError(caught)) {
          if (selfHealLeft <= 0) {
            degrade(`图纸转码失败（${lastErrMsg}），已改用原始 PDF 预览`);
            return;
          }
          selfHealLeft -= 1;
          lastErrMsg = `${lastErrMsg}（转码失败，正在重试 ${PREVIEW_SELF_HEAL_MAX_RETRY - selfHealLeft}/${PREVIEW_SELF_HEAL_MAX_RETRY}）`;
          if (!(await sleep(delayOf(attempt, null), myToken))) return;
          continue;
        }
        // 其余（网络抖动、5xx）⇒ 记一笔，**按固定下限退避后**再重试；预算耗尽时自然
        // 落到 degrade，那时 lastErrMsg 会跟着进降级原因，不会静默吞掉。
        // ⚠️ 这行 sleep 不能省：直接 continue 就是「持续 5xx 时零间隔连打 30 次」的
        // 请求风暴，而次数闸只能封顶打**多少**次、封不住打得多密。
        if (!(await sleep(delayOf(attempt, null), myToken))) return;
        continue;
      }

      // 后端 `state` 只可能是 READY / PENDING 两个取值（失败走 5xx 信封，不在 state 里）。
      // 这里先按 `string` 取出来，好让「不认识的值」也能被显式处理而不是悄悄落进
      // PENDING 分支空转到预算耗尽。
      const wireState: string = result!.state;
      if (wireState === 'READY') {
        pages.value = result!.pages;
        pageCount.value = result!.page_count;
        state.value = 'READY';
        inFlight.value = false;
        return;
      }
      if (wireState !== 'PENDING') {
        // 后端将来加了新的非终态值：按「不认识就降级」处理并把实际值带进原因，
        // 让现场能一眼看出是后端加了状态而不是前端坏了。
        degrade(`图纸转图返回了未知的转码状态（${wireState}），已改用原始 PDF 预览`);
        return;
      }

      // PENDING：按后端建议间隔 + 指数退避继续等。
      lastErrMsg = null;
      state.value = 'PENDING';
      inFlight.value = false;
      if (!(await sleep(delayOf(attempt, result!.retry_after_ms), myToken))) return;
    }
  }

  function start(): void {
    stop();
    const fileId = toValue(options.fileId);
    if (toValue(options.enabled ?? true) === false || !fileId) return;
    void run(token, fileId);
  }

  watch([() => toValue(options.fileId), () => toValue(options.enabled ?? true)], start, {
    immediate: true,
  });

  // 组件卸载 / 作用域销毁 ⇒ 中断在途请求（否则回调会写已销毁组件的 ref）。
  onScopeDispose(stop);

  return {
    pages: computed(() => pages.value),
    pageCount: computed(() => pageCount.value),
    state: computed(() => state.value),
    ready: computed(() => state.value === 'READY'),
    loading: computed(() => state.value === 'PENDING' || inFlight.value),
    degraded: computed(() => state.value === 'DEGRADED'),
    degradedReason: computed(() => degradedText.value),
    retry: start,
    stop,
  };
}
