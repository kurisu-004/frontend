// src/stores/scanShelf.ts
//
// 2026-10-04 新增：Pinia setup store，承载报工台的「当前作业架」—— **只有送检页**
// （/scan/inspect）提交 `shelf_id` 的唯一来源。放回页（/scan/return）也发 `shelf_id`，
// 但那个值来自 for-return picker 的**现场选架**，不走本 store：作业架是「工位固定所在
// 的架」，放回是「这件放到哪个架上」，两者语义不同。取件页（/scan/pick）**不再发**
// `shelf_id`（后端已改成可选且缺省不做校验），也与本 store 无关。
//
// 为什么是 store 而不是页面级 composable：跨路由要共享的状态不能住在「每次调用返回
// 全新实例」的 composable 里。`/scan/action`（选架入口）与 `/scan/inspect` 是兄弟路由，
// `router.push` 会卸载前者并连同其实例销毁，于是送检页读到的 `selectedShelfId` 恒 null、
// 守卫 100% 触发、请求根本没发出。store 跨路由存活，且消费点一律在**读值前**
// `await initShelves()`。
//
// 语义：
// - 单架 SHELF_ACCOUNT：自动选唯一架，不需要工人手动选。
// - 多架 SHELF_ACCOUNT（≥ 2 架）：只在「sessionStorage 里有值、且该值仍在本次候选集内」
//   时沿用，否则不选。选架入口在 `/scan/action` 顶部的「当前作业货架」区（多架未选时
//   是警示态 + 「选择货架」按钮，已选时是「当前：{code}」+「更换」）；写入口唯一是
//   `selectShelf`。
// - wildcard SHELF_ACCOUNT（未绑任何 active 架）：候选为空、不选（picker 走通配）。
// - 候选集与选中值落 sessionStorage（key 含 user id，跨账号自动隔离）。写入点有三个：
//   单架账号的自动选中、**多架账号经 `selectShelf` 的显式选择**、以及解绑后的清理。
// - 重载闸门是「账号 id + 绑定集」的指纹（`loadSignature`）：换账号必须重载（不让 A 账号
//   的选择被 B 账号继承），**同账号换绑定**（管理员改绑定、`/iam/me` 刷新带回新的
//   `shelf_ids`）同样重载。
// - 候选解析不出来时（货架端点失败 / 返回不全）按绑定 id 兜底、zone 填 'UNKNOWN' ⇒ 作业架
//   不可用，守卫会拦。**兜底不置幂等闸门**，只记一段冷却窗（`FALLBACK_RETRY_COOLDOWN_MS`）
//   ⇒ 端点恢复后「再进一次页面」即可自愈，不必 F5；但也别把端点打满，所以窗内不重试。
//
// 消费侧禁止解构 store：统一 `const scanShelf = useScanShelfStore(); scanShelf.xxx`
// （标量 getter 不带括号，函数式 getter 带括号；沿 auth store 不变量）。

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { listShelves } from '@/api/shelves';
import { useAuthStore } from '@/stores/auth';
import type { Shelf } from '@/types/shelf';

export interface ShelfOption {
  id: string;
  code: string;
  zone: 'PRODUCTION' | 'INSPECTION' | string;
}

const SESSION_KEY_PREFIX = 'active_shelf_selection:';

/** 兜底后不重打货架端点的冷却时长。2026-10-04：调用方只有三个页面的 onBeforeMount
 *  （取件 / 送检 / 操作选择），请求速率本就由人的切页节奏决定、封不了顶；这段窗口只是
 *  挡住「一次端点抖动被连着几页各打一次」这种放大，窗外立刻恢复自动重试。 */
const FALLBACK_RETRY_COOLDOWN_MS = 10_000;

export const useScanShelfStore = defineStore('scanShelf', () => {
  const auth = useAuthStore();

  // ===== state =====
  /** 当前选中的货架 id（字符串雪花 id）。null = 未选 / wildcard。 */
  const selectedShelfIdValue = ref<string | null>(null);
  /** 用户能选的候选（绑定架详情；wildcard → 空数组）。 */
  const optionsValue = ref<ShelfOption[]>([]);
  /** 候选架是否已加载过（幂等闸门，避免每次进路由都重打 listShelves）。走兜底分支
   *  时**刻意不置位**（见 fallbackAt）—— 那一批候选不可用，不该让它挡住重试。 */
  const initialized = ref(false);
  /** initialized 成立时的「账号 + 绑定集」指纹。比对 userId 是不够的：管理员可以在
   *  不换人的情况下改绑定（/iam/me 刷新把新的 shelf_ids 带回来，user.id 不变），只比
   *  userId 会让旧候选一直活到页面刷新（见 initShelves 与 loadSignature）。 */
  const loadedSignature = ref<string | null>(null);
  /** 兜底那一刻的时刻与它归属的签名（null = 本会话还没走过兜底）。 */
  const fallbackAtValue = ref<{ signature: string; at: number } | null>(null);

  // ===== sessionStorage =====
  const sessionKey = computed<string | null>(() =>
    auth.user ? `${SESSION_KEY_PREFIX}${auth.user.id}` : null,
  );

  function restoreFromSession(): string | null {
    const key = sessionKey.value;
    if (!key || typeof window === 'undefined') return null;
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function persistToSession(value: string | null): void {
    const key = sessionKey.value;
    if (!key || typeof window === 'undefined') return;
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch {
      // 忽略 storage 异常
    }
  }

  // ===== getters =====
  const selectedOption = computed<ShelfOption | null>(() => {
    const id = selectedShelfIdValue.value;
    if (!id) return null;
    return optionsValue.value.find((o) => o.id === id) ?? null;
  });

  /** null = 未选 / 该架不在 options 内 / zone 不是两个已知值之一，三者不可区分。 */
  const selectedZone = computed<'PRODUCTION' | 'INSPECTION' | null>(() => {
    const opt = selectedOption.value;
    if (!opt) return null;
    return opt.zone === 'PRODUCTION' || opt.zone === 'INSPECTION' ? opt.zone : null;
  });

  /** 多架且当前没选出作业架 —— 即「账号绑定不唯一、且系统给不出作业架」的状态。
   *  `/scan/action` 顶部的「当前作业货架」区据此渲染警示态 + 「选择货架」入口；
   *  送检按钮也据此先开选架弹窗再跳转（不把按钮置灰：HMI 上置灰是死路）。 */
  const showShelfSelector = computed<boolean>(
    () => optionsValue.value.length >= 2 && selectedShelfIdValue.value === null,
  );

  // ===== actions =====
  /**
   * 加载候选架并决定当前作业架。消费点**必须 await 它再读值** —— 未 await 就读
   * `selectedShelfId` 拿到的是 null，提交守卫会把它误报成「账号没绑货架」。
   *
   * 幂等：同一账号 + 同一绑定集已加载过就直接返回（`force` 除外），因此送检 / 操作选择
   * 两页各自 onBeforeMount 调一次不会重复请求。走兜底的批次**不**置这个闸门，改用
   * `FALLBACK_RETRY_COOLDOWN_MS` 冷却窗（见下方兜底分支）。
   */
  async function initShelves(options?: { force?: boolean }): Promise<void> {
    const userId = auth.user?.id ?? null;
    // 本次加载归属的账号 + 绑定集快照：`signature` 与 await 后的复核都用它，
    // 不读可能已变的 auth。
    const bound = auth.boundShelves;
    const signature = loadSignature(userId, bound);
    if (!options?.force) {
      if (initialized.value && loadedSignature.value === signature) return;
      // 同一签名的兜底还在冷却窗内 ⇒ 不重打货架端点（车间网络差时不至于每页都重试）。
      // 窗外的兜底**不拦**这里，让本次真的重试 —— 见 initShelves 的兜底分支。
      const fb = fallbackAtValue.value;
      if (fb && fb.signature === signature && Date.now() - fb.at < FALLBACK_RETRY_COOLDOWN_MS) {
        return;
      }
    }

    if (bound.length === 0) {
      // wildcard：候选为空（界面不显示选择器，picker 走通配）
      optionsValue.value = [];
      selectedShelfIdValue.value = null;
      persistToSession(null);
      markLoaded(signature);
      return;
    }

    let shelves: Shelf[] = [];
    try {
      // 2026-10-04：`limit: 200` 是「取全」的假设，车间货架数是否真的不超过它未经验证
      // （`docs/api/shelves.md` 的上限是 500）。超出时未解析出的绑定架不会进 `options`，
      // 多架分支因此不认存储值里的那个 id，最终按「没选出作业架」处理 —— 不会拿一个未解析
      // 的架当作业架发出去。
      // ⚠️ 单架账号同样中招，且此时是**长期**拦截而非抖动：`details.length === 0` 落进兜底
      // ⇒ UNKNOWN ⇒ 守卫拦下。车间 active 货架一旦超过 200，被绑在第 201 名之后的工位会
      // 一直停在拦截态（要管理员收窄绑定才行）。真要根治得后端给 zone 视图，本 store
      // 只能如实拦下。
      shelves = (await listShelves({ is_active: true, limit: 200 })).items;
    } catch {
      shelves = [];
    }
    // 2026-10-04：await 期间可能已登出 / 换账号。此处若继续，就会拿 A 账号的绑定集
    // 去 markLoaded，把 B 账号的读取判成「已加载」而永不重拉。返回即可 —— 下一次
    // initShelves 重算的签名与这里的对不上，会正常重载。
    if (auth.user?.id !== userId) return;

    // 把 user.shelf_ids 转成详情列表（保持 user.shelf_ids 顺序）
    const details: ShelfOption[] = [];
    for (const sid of bound) {
      const s = shelves.find((x) => String(x.id) === String(sid));
      if (s) {
        details.push({ id: String(s.id), code: s.code, zone: s.zone });
      }
    }
    optionsValue.value = details;
    // 兜底：货架端点失败 / 返回不全时按绑定 id 补候选，但 **zone 不猜**。猜 PRODUCTION 会让
    // 品检架被当成生产架放行（`selectedZone` 变 PRODUCTION ⇒ 守卫三条分支全过 ⇒ 带着猜
    // 出来的架发请求，得后端 20501），正是本 store 要消灭的那类烂错误。zone 填
    // 'UNKNOWN' ⇒ `selectedZone` 为 null ⇒ 守卫的「无法识别所属区域」分支拦下。
    // zone 的权威来源只有货架端点与 `/iam/me`，要消除这个 UNKNOWN 得后端在那两处直给。
    //
    // 2026-10-04：兜底**不置幂等闸门**，改记一条冷却窗（`fallbackAtValue`）。这一批候选
    // 是猜不出 zone 的，拿它当「已加载」就把该账号钉死在 UNKNOWN 上 —— 端点抖一下就得
    // F5 才能恢复。冷却窗只挡住「窗内重打端点」，窗外下一次进路由自动重试，于是恢复手段
    // 是「再进一次页面」而不是刷新。
    if (details.length === 0) {
      for (const sid of bound) {
        details.push({ id: String(sid), code: `shelf#${sid}`, zone: 'UNKNOWN' });
      }
      optionsValue.value = details;
      fallbackAtValue.value = { signature, at: Date.now() };
      decideShelf(details);
      return;
    }
    decideShelf(details);
    markLoaded(signature);
  }

  /**
   * 选架唯一写入口：把 `id` 设为当前作业架并落盘。
   *
   * 校验 `id ∈ options` 后才写 —— 越界 id 返回 false 且**不写任何状态**。这条校验不是
   * 形式主义：候选集是「本账号绑定 ∩ 货架端点返得出的架」，界外 id 要么已解绑、要么是
   * `listShelves` 没返到的那批（`limit: 200` 隐患，见 initShelves）。写进去的坏状态是
   * 「`selectedShelfId` 有值但 `selectedZone` 为 null」，既发不出请求、守卫文案也会说错
   * 成因。返回 boolean 让调用方能区分「选上了」与「这个架不可用」。
   */
  function selectShelf(id: string): boolean {
    if (!optionsValue.value.some((o) => o.id === id)) return false;
    selectedShelfIdValue.value = id;
    persistToSession(id);
    return true;
  }

  /** 按候选集决定 `selectedShelfId`。**不碰幂等闸门** —— 置闸门由调用方按分支决定
   *  （兜底那一支刻意不置，见上）。拆成独立函数只为让两条分支共用同一段判定。 */
  function decideShelf(details: ShelfOption[]): void {
    // 决定 selectedShelfId
    if (details.length === 1) {
      // 单架：自动选，唯一确定、不需要工人选
      selectedShelfIdValue.value = details[0].id;
      persistToSession(selectedShelfIdValue.value);
    } else if (details.length >= 2) {
      // 多架：先试 sessionStorage 恢复（旧会话 / 本会话内已经选过一次），恢复不回来
      // 就不选 —— 由 `/scan/action` 顶部的选架入口让工人自己指。判 `details` 而非
      // `auth.boundShelves`：绑定集里可能有 listShelves 没返到的架（见上面 limit 注释）。
      const stored = restoreFromSession();
      selectedShelfIdValue.value = stored && details.some((o) => o.id === stored) ? stored : null;
    } else {
      selectedShelfIdValue.value = null;
    }
  }

  /** 本次加载归属的指纹：账号 id + 绑定集（排序后拼接，顺序变化不算换绑定）。
   *  2026-10-04：只比 userId 会漏掉「同账号换绑定」—— `/iam/me` 刷新带回新的
   *  `shelf_ids` 而 `user.id` 不变，闸门会把旧候选挡在门外，最坏是给已解绑的架发请求。
   *  worker-scan 有 scope 校验（`shelf_id` / `target_inspection_shelf_id` 必须在
   *  `current.shelf_ids` 内或 `current.shelf_wildcard`）⇒ 未授权货架返
   *  `40301 SHELF_MISMATCH`（`docs/api/parts/inspection.md`）。 */
  function loadSignature(userId: string | null, bound: string[]): string {
    return `${userId ?? ''}|${[...bound].sort().join(',')}`;
  }

  function markLoaded(signature: string): void {
    initialized.value = true;
    loadedSignature.value = signature;
    // 上一条兜底记录作废：候选刚重新解析成功，不再处于「等冷却窗重试」的状态。
    fallbackAtValue.value = null;
  }

  return {
    /** 当前作业架 id。会话终止或绑定变化不需要显式清理：重算的签名与
     *  `loadedSignature` 对不上即触发重载（见 initShelves）。写入口是 `selectShelf`。 */
    selectedShelfId: computed(() => selectedShelfIdValue.value),
    options: computed(() => optionsValue.value),
    selectedZone,
    showShelfSelector,
    /** 候选架是否已为**当前账号 + 当前绑定集**加载过（只读；消费方通常只需
     *  `await initShelves()`，拿它是为了判断「深链进入时到底有没有货架可读」而不必自己
     *  再调一次）。兜底那次加载**不置位**（见 initShelves 兜底分支）—— 那批候选的 zone
     *  全是 UNKNOWN、本就不可用，判成「没加载」反而让「有没有货架可读」答得更准。 */
    initialized: computed(() => initialized.value),
    initShelves,
    selectShelf,
  };
});
