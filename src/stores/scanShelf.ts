// src/stores/scanShelf.ts
//
// 2026-10-04 新增：Pinia setup store，承载报工台的「当前作业架」—— 取件 / 送检两页
// 提交时 `shelf_id` 的唯一来源。放回页（/scan/return）也发 `shelf_id`，但那个值来自
// for-return picker 的**现场选架**，不走本 store：作业架是「工位固定所在的架」，放回是
// 「这件放到哪个架上」，两者语义不同，前者才需要跨路由记忆。
//
// 为什么是 store 而不是页面级 composable：跨路由要共享的状态不能住在「每次调用返回
// 全新实例」的 composable 里。`/scan/action` 与 `/scan/pick` / `/scan/inspect` 是兄弟
// 路由，`router.push` 会卸载前者并连同其实例销毁，于是取件页读到的 `selectedShelfId`
// 恒 null、守卫 100% 触发、请求根本没发出。store 跨路由存活，且消费点一律在**读值前**
// `await initShelves()`。
//
// 语义：
// - 单架 SHELF_ACCOUNT：自动选唯一架，不需要工人手动选。
// - 多架 SHELF_ACCOUNT（≥ 2 架）：只在「sessionStorage 里有值、且该值仍在本次候选集内」
//   时沿用，否则不选。⚠️ 多架账号在页面上**没有选架入口**（`/scan/action` 只渲染取件 /
//   放回 / 送检三个动作按钮）⇒ 沿用值对不对系统无从判断（列表跨架，工人可能站在另一架
//   上作业），只能在提交前提示一句「沿用上次会话的 {code}」；完全没值时提交会被
//   `resolveWorkingShelfId` 拦下，唯一的出路是找管理员把绑定收窄成唯一作业架。
//   「补选架 UI」是产品决策，不在本仓实现范围内 —— 本 store 与守卫文案都按「无入口」
//   这个既成事实书写，不假设工人能自己改选。
// - wildcard SHELF_ACCOUNT（未绑任何 active 架）：候选为空、不选（picker 走通配）。
// - 候选集与选中值落 sessionStorage（key 含 user id，跨账号自动隔离）。当前唯一的写入
//   点是单架账号的自动选中；多架分支只读不写。
// - 重载闸门是「账号 id + 绑定集」的指纹（`loadSignature`）：换账号必须重载（不让 A 账号
//   的选择被 B 账号继承），**同账号换绑定**（管理员改绑定、`/iam/me` 刷新带回新的
//   `shelf_ids`）同样重载。
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
  /** initialized 成立时的「账号 + 绑定集」指纹。比对 userId 是不够的：管理员可以在
   *  不换人的情况下改绑定（/iam/me 刷新把新的 shelf_ids 带回来，user.id 不变），只比
   *  userId 会让旧候选一直活到页面刷新（见 initShelves 与 loadSignature）。 */
  const loadedSignature = ref<string | null>(null);
  /** 当前作业架是否沿用了 sessionStorage 里上次会话落盘的值（仅多架账号可能为 true）。
   *  单架账号的自动选是**唯一确定**的选择，不置位 —— 否则每次提交都提示，变成噪音。 */
  const restoredFromSessionValue = ref(false);

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

  /** 多架且当前没自动选 —— 即「账号绑定不唯一、且系统给不出作业架」的状态。
   *  2026-10-04：无生产消费方（页面上没有选架入口，见文件头）；保留为该状态的显式
   *  表达，也是将来若补选架 UI 时唯一需要的判定。 */
  const showShelfSelector = computed<boolean>(
    () => optionsValue.value.length >= 2 && selectedShelfIdValue.value === null,
  );

  /** 当前作业架沿用自上次会话落盘的值（多架账号专用）。消费方用它区分「系统自动定的架」
   *  与「沿用上次会话的架」—— 后者系统无从判断对错（页面上没有选架入口），只能提示
   *  工人知情，不能拦（拦了就是死路，见文件头「无选架入口」）。 */
  const restoredFromSession = computed<boolean>(() => restoredFromSessionValue.value);

  // ===== actions =====
  /**
   * 加载候选架并决定当前作业架。消费点**必须 await 它再读值** —— 未 await 就读
   * `selectedShelfId` 拿到的是 null，提交守卫会把它误报成「账号没绑货架」。
   *
   * 幂等：同一账号 + 同一绑定集已加载过就直接返回（`force` 除外），因此取件 / 送检 /
   * 操作选择三页各自 onBeforeMount 调一次不会重复请求。
   */
  async function initShelves(options?: { force?: boolean }): Promise<void> {
    const userId = auth.user?.id ?? null;
    // 本次加载归属的账号 + 绑定集快照：`signature` 与 await 后的复核都用它，
    // 不读可能已变的 auth。
    const bound = auth.boundShelves;
    const signature = loadSignature(userId, bound);
    if (!options?.force && initialized.value && loadedSignature.value === signature) return;
    restoredFromSessionValue.value = false;

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
      // 2026-10-04：`limit: 200` 是「取全」的假设，车间货架数是否真的不超过它未经验证。
      // 超出时未解析出的绑定架不会进 `options`，多架分支因此不认存储值里的那个 id，
      // 最终按「没选出作业架」处理 —— 不会拿一个未解析的架当作业架发出去。
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
    // 兜底：货架端点失败 / 不全时按绑定 id 补候选，但 **zone 不猜**。猜 PRODUCTION 会让
    // 品检架被当成生产架放行（`selectedZone` 变 PRODUCTION ⇒ 守卫三条分支全过 ⇒ 带着猜
    // 出来的架发请求，得后端 20501），正是本 store 要消灭的那类烂错误。zone 填
    // 'UNKNOWN' ⇒ `selectedZone` 为 null ⇒ 守卫的「无法识别所属区域」分支拦下。
    // zone 的权威来源只有货架端点与 `/iam/me`，要消除这个 UNKNOWN 得后端在那两处直给。
    if (details.length === 0) {
      for (const sid of bound) {
        details.push({ id: String(sid), code: `shelf#${sid}`, zone: 'UNKNOWN' });
      }
      optionsValue.value = details;
    }

    // 决定 selectedShelfId
    if (details.length === 1) {
      // 单架：自动选（当前唯一的 sessionStorage 写入点）
      selectedShelfIdValue.value = details[0].id;
      persistToSession(selectedShelfIdValue.value);
    } else if (details.length >= 2) {
      // 多架：只认「解析得出、且确实在本次候选集内」的存储值。判 `details` 而非
      // `auth.boundShelves`：绑定集里可能有 listShelves 没返到的架（见上面 limit 注释），
      // 拿它当作业架会得到「selectedShelfId 有值但 selectedZone 为 null」——既发不出
      // 请求，守卫文案也会说错成因。
      const stored = restoreFromSession();
      if (stored && details.some((o) => o.id === stored)) {
        selectedShelfIdValue.value = stored;
        // 沿用上次会话的架：列表是跨架的，工人完全可能站在另一个架上作业，而系统无从
        // 判断（没有选架入口）。记下来供守卫提示一句「沿用上次会话」，**不拦**。
        restoredFromSessionValue.value = true;
      } else {
        // 不自动选：本仓没有选架入口，多架账号只能由管理员收窄绑定（见文件头）。
        selectedShelfIdValue.value = null;
      }
    } else {
      selectedShelfIdValue.value = null;
    }
    markLoaded(signature);
  }

  /** 本次加载归属的指纹：账号 id + 绑定集（排序后拼接，顺序变化不算换绑定）。
   *  2026-10-04：只比 userId 会漏掉「同账号换绑定」—— `/iam/me` 刷新带回新的
   *  `shelf_ids` 而 `user.id` 不变，闸门会把旧候选挡在门外，最坏是给已解绑的架发请求
   *  （后端 40301 SHELF_MISMATCH 兜底，非数据损坏）。 */
  function loadSignature(userId: string | null, bound: string[]): string {
    return `${userId ?? ''}|${[...bound].sort().join(',')}`;
  }

  function markLoaded(signature: string): void {
    initialized.value = true;
    loadedSignature.value = signature;
  }

  return {
    /** 当前作业架 id。**只读** —— 没有选架入口就没有写入方。会话终止或绑定变化也不需要
     *  显式清理：重算的签名与 `loadedSignature` 对不上即触发重载（见 initShelves）。 */
    selectedShelfId: computed(() => selectedShelfIdValue.value),
    options: computed(() => optionsValue.value),
    selectedZone,
    showShelfSelector,
    /** 候选架是否已为**当前账号 + 当前绑定集**加载过（只读；消费方通常只需
     *  `await initShelves()`，拿它是为了判断「深链进入时到底有没有货架可读」而不必自己
     *  再调一次）。 */
    initialized: computed(() => initialized.value),
    restoredFromSession,
    initShelves,
  };
});
