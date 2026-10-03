// src/stores/scanShelf.ts
//
// 2026-10-04 新增：Pinia setup store，承载报工台的「当前作业架」。
// 从 views/scan/composables/useActiveShelfSelection.ts 整体搬入（后者已随之删除），
// 搬运的理由与 2026-09-26 auth store 从模块级单例迁 Pinia 同类：跨路由要共享的状态
// 不能住在「每次调用返回全新实例」的 composable 里。
//
// 故障缘由（本次要拦住的回归）：原 composable 的 ref 写在函数体内，`/scan/action`
// 与 `/scan/pick` 是兄弟路由 —— `router.push('/scan/pick')` 卸载前者、连同其实例，
// 于是 `ScanPickParts` 里 `selectedShelfId` 恒 null，取件页守卫 100% 触发
// 「未找到零件所在货架信息」，请求根本没发出；`/scan/action` 写进 sessionStorage 的
// 选择也没有任何读者（`restoreFromSession` 只在 initShelves 内被调）。改成 store 后
// 状态跨路由存活，且每个消费点都在**读值前** await `initShelves()`。
//
// 设计目标（语义自 2026-07-13 起未变）：
// - 单架 SHELF_ACCOUNT：自动选唯一架；不需要工人手动选。
// - 多架 SHELF_ACCOUNT（≥ 2 架同/异 zone）：不自动选。
// - wildcard SHELF_ACCOUNT（未绑任何 active 架）：候选为空、不选。
// - 选择跨页持久化：sessionStorage（不是 localStorage）—— 跨账号切换会自动失效；
//   key 含 user id 防账号互窜。
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

export const useScanShelfStore = defineStore('scanShelf', () => {
  const auth = useAuthStore();

  // ===== state =====
  /** 当前选中的货架 id（字符串雪花 id）。null = 未选 / wildcard。 */
  const selectedShelfIdValue = ref<string | null>(null);
  /** 用户能选的候选（绑定架详情；wildcard → 空数组）。 */
  const optionsValue = ref<ShelfOption[]>([]);
  /** 候选架是否已加载过（幂等闸门，避免每次进路由都重打 listShelves）。 */
  const initialized = ref(false);
  /** initialized 成立时的账号 id：换账号后旧选择立即失效（见 initShelves）。 */
  const loadedForUserId = ref<string | null>(null);

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

  const selectedZone = computed<'PRODUCTION' | 'INSPECTION' | null>(() => {
    const opt = selectedOption.value;
    if (!opt) return null;
    return opt.zone === 'PRODUCTION' || opt.zone === 'INSPECTION' ? opt.zone : null;
  });

  // 多架（≥ 2 候选） + 当前没自动选 → 显示选择器
  const showShelfSelector = computed<boolean>(
    () => optionsValue.value.length >= 2 && selectedShelfIdValue.value === null,
  );

  // ===== actions =====
  /**
   * 加载候选架并决定当前作业架。消费点**必须 await 它再读值** —— 未 await 就读
   * `selectedShelfId` 拿到的是 null，正是本次修的故障形态。
   *
   * 幂等：同一账号已加载过就直接返回（`force` 除外），因此取件 / 送检 / 操作选择
   * 三页各自 onBeforeMount 调一次不会重复请求。
   *
   * 换账号：Pinia store 跨「登出 → 换账号登录（不刷新页面）」存活，而 sessionStorage
   * 的 key 含 user id —— 故把加载归属的账号 id 记在 `loadedForUserId`，账号一变就
   * 重新加载（读新账号自己的 sessionStorage），不让 A 账号的选择被 B 账号继承。
   */
  async function initShelves(options?: { force?: boolean }): Promise<void> {
    const userId = auth.user?.id ?? null;
    if (!options?.force && initialized.value && loadedForUserId.value === userId) return;

    const bound = auth.boundShelves;
    if (bound.length === 0) {
      // wildcard：候选为空（界面不显示选择器，picker 走通配）
      optionsValue.value = [];
      selectedShelfIdValue.value = null;
      persistToSession(null);
      markLoaded(userId);
      return;
    }

    // 拉所有 active 架（limit 200 足够车间用；超过说明架构问题）
    let shelves: Shelf[] = [];
    try {
      shelves = (await listShelves({ is_active: true, limit: 200 })).items;
    } catch {
      shelves = [];
    }

    // 把 user.shelf_ids 转成详情列表（保持 user.shelf_ids 顺序）
    const boundSet = new Set(bound);
    const details: ShelfOption[] = [];
    for (const sid of bound) {
      const s = shelves.find((x) => String(x.id) === String(sid));
      if (s) {
        details.push({ id: String(s.id), code: s.code, zone: s.zone });
      }
    }
    optionsValue.value = details;
    // 兜底：万一后端 list_shelves 不全（不应发生），按绑定 id 补一道，zone 一律猜
    // PRODUCTION。⚠️ 这条猜测本身是隐患：品检架会被当成生产架，下游按 zone 做的判断
    // （选件 / 送检要求作业架在 PRODUCTION 区）据此放行，最终由后端 20501 兜底报错。
    // 保留是「不让 list_shelves 抖动直接废掉整个扫码台」，真修法是后端在
    // /iam/me 或货架端点上直接给 zone，不在前端猜。
    if (details.length === 0) {
      for (const sid of bound) {
        details.push({ id: String(sid), code: `shelf#${sid}`, zone: 'PRODUCTION' });
      }
      optionsValue.value = details;
    }

    // 决定 selectedShelfId
    if (details.length === 1) {
      // 单架：自动选
      selectedShelfIdValue.value = details[0].id;
      persistToSession(selectedShelfIdValue.value);
    } else if (details.length >= 2) {
      // 多架：先看 sessionStorage 是否有之前的选择（且仍在 options 内）
      const stored = restoreFromSession();
      if (stored && boundSet.has(stored)) {
        selectedShelfIdValue.value = stored;
      } else {
        // 不自动选；让用户在 action picker 顶部选
        selectedShelfIdValue.value = null;
      }
    } else {
      selectedShelfIdValue.value = null;
    }
    markLoaded(userId);
  }

  /** 显式清空选择（账号切换 / 重置用）。 */
  function reset(): void {
    selectedShelfIdValue.value = null;
    optionsValue.value = [];
    initialized.value = false;
    loadedForUserId.value = null;
    persistToSession(null);
  }

  /** 显式写当前作业架（选择器 / 测试写回），同步落 sessionStorage。 */
  function setSelected(id: string | null): void {
    selectedShelfIdValue.value = id;
    persistToSession(id);
  }

  function markLoaded(userId: string | null): void {
    initialized.value = true;
    loadedForUserId.value = userId;
  }

  return {
    /** 当前作业架 id；可写（写入走 setSelected，同时落 sessionStorage）。 */
    selectedShelfId: computed({
      get: () => selectedShelfIdValue.value,
      set: (v: string | null) => setSelected(v),
    }),
    options: computed(() => optionsValue.value),
    selectedZone,
    showShelfSelector,
    /** 候选架是否已为**当前账号**加载过（只读；消费方通常只需 `await initShelves()`，
     *  拿它是为了判断「深链进入时到底有没有货架可读」而不必自己再调一次）。 */
    initialized: computed(() => initialized.value),
    initShelves,
    reset,
  };
});
