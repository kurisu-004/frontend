// 2026-07-17：货架↔工序 双向 reactive 过滤 composable
//
// 用法：
//   const { filteredShelves, filteredProcesses, loaded } = useShelfProcessFilter(
//     shelves,       // Ref<readonly Shelf[]>
//     processes,     // Ref<readonly Process[]>
//     shelfId,       // Ref<string | null>
//     processId,     // Ref<string | null>
//   )
//
// 后端走 `GET /prod/shelf-processes` 一次取所有 active 映射（避免 N+1；
// 2026-10-02 域拆分硬切自 `/shelves/processes`，旧路径现在是 400 裸文本非 `R` 信封）。
// watch 会自动在 shelfId / processId 变化时双向 refilter，
// 并在选了不兼容的对端时清空对端 + ElMessage.warning 提示。
//
// 历史（留档，说明「为什么是现在这个形状」）：
//   - 2026-10-02：修「静默清空 8 个页面下拉」的 BUG-3。该端点返回**扁平行**（一行一个
//     (货架, 工序) 对），旧实现按 v1(Python) 的「一架子集一行」读 `item.process_ids`
//     （恒 undefined）导致 mapping 全是空集。契约断言见
//     __tests__/useShelfProcessFilter.spec.ts。
//   - 2026-10-02（Phase C）：数据源从**裸 async `load()`** 迁到共享基础数据层 query
//     （useShelfProcessMappingsQuery），`load` 从对外 API 删除。收益三条：
//       1. **Zod 守门**（首要目标）：此前零守门，BUG-3 那类契约漂移要靠人眼在 UI 上
//          发现空白下拉才定位得到；现在 shelfProcessMappingsResultSchema.parse 在
//          queryFn 里拦，漂移 → query 进 error 态 → 手上没有 data → loaded 保持
//          false → 走全量兜底（**不会**把半截数据喂给过滤逻辑）；
//       2. **请求去重**：10 处调用实例共用同一常量 queryKey + 30s staleTime，同一次
//          操作流程里从不同页面开不同对话框不再重复拉；
//       3. 派生状态全部走 computed，没有 watch 手动同步的中间态。
//   - 2026-10-02（review 第 1 轮 I-1）：`loaded` 判据从 `isSuccess` 改成
//     `q.data !== undefined`。v5 在 **refetch 失败**时保留 data 却把 status 翻成
//     error，拿 isSuccess 会让下拉在失败窗口里静默变回全量（相对迁移前是回归，
//     旧实现的 loaded 一旦 true 就粘住）。详见 loaded 的注释。
//   - 2026-10-02（review 第 1 轮 I-2）：补 `watch(q.error)` 桥接（console.error +
//     去重后的 ElMessage.error）。迁移前裸 load() 的 catch 里有 console.error，迁移后
//     若不桥接，可诊断性反而更差 —— 守门成了「静默失败」。
//   - 2026-10-10：目标货架改由后端按负载自动选，全仓 10 处「货架 ↔ 工序」下拉里
//     9 处（扫码台放回 / 送检、外协回收、品检打回与送检、生产队列撤回、cnc /
//     零件一览 / 零件详情的下发、返修下发）整体删除，本 composable 只剩**一个**消费方：
//     零件详情页的「外协回收」弹窗（`receive-from-outsource` 的 `shelf_id` 后端未删，
//     不在本轮口径内）。保留本文件而不整体删除，就是为这一处。

import { computed, watch, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useShelfProcessMappingsQuery } from '@/composables/queries/useShelfProcessMappingsQuery';

// 2026-10-02（review 第 1 轮 I-2）：模块级「已上报」记录，挡住 10 处调用实例把同一次
// 失败放大成 10 条 console.error + 10 个 toast。
//
// 用**错误对象身份**而不是布尔标志位去重：10 个 useQuery 实例 watch 的是**同一个
// query** 的 state，error 字段是同一个 Error 实例被按引用分发到各 observer ⇒ 第一次
// 上报后其余 9 个 watch 拿到的还是同一引用，直接跳过。这样做还有一个附带好处：**不会
// 在测试之间泄漏**——每次失败都由 queryFn 新建一个 Error（守门抛 ZodError、网络层抛
// ApiError，见 src/api/http.ts），新一轮失败自然是新引用；而 `e == null`（回到成功）时
// 复位，使「失败 → 成功 → 再失败」两轮各自上报一次。若改用布尔标志位，本文件里多个
// 失败用例（F6 / F7 / F11）会互相吞掉后者的上报，测试也就断言不到「一次失败一响」。
let lastReportedError: unknown = null;

/**
 * 最小接口：composable 只关心 id（雪花 ID 字符串）。
 * 调用方可以传 Shelf[] / Process[] 或任何带 `{id: string}` 字段的对象。
 */
export interface Identifiable {
  id: string;
}

export function useShelfProcessFilter<S extends Identifiable, P extends Identifiable>(
  allShelves: Ref<readonly S[]>,
  allProcesses: Ref<readonly P[]>,
  shelfId: Ref<string | null>,
  processId: Ref<string | null>,
) {
  // 2026-10-02（Phase C）：闸门 = 两个下拉候选源都非空。
  // 这精确复刻各调用点旧代码的取数时机 —— 它们无一例外都是
  // `await Promise.all([listShelves(...), listProcesses(...)])`（或 reloadShelves /
  // ensureShelvesProcesses 等等价物）完成之后才 `load()`；两个源为空时过滤本就无意义
  // （filteredXxx 会走全量兜底），发请求只是白拉一份没人用的映射。
  // 依赖 `shelves` / `processes` 两个**已存在**的形参推导，不新增任何状态参数。
  const mappingsEnabled = computed(
    () => allShelves.value.length > 0 && allProcesses.value.length > 0,
  );
  const q = useShelfProcessMappingsQuery(mappingsEnabled);

  // shelfId (str) → Set<processId (str)>。纯 computed 派生（不用 watch 手动同步）：
  // 切页 / refetch 期间没有「旧 mapping + 新 loaded」的中间态。
  const mapping = computed<Map<string, Set<string>>>(() => {
    // 2026-10-02 修 BUG-3：后端 GET /prod/shelf-processes 返**扁平行**（一行一个
    // (货架, 工序) 对，同一 shelf_id 多行），不是 v1(Python) 的「一架子集一行」。
    // 错误实现 `m.set(item.shelf_id, new Set(item.process_ids))` 里 process_ids
    // 恒 undefined → new Set(undefined) 得空集 → 同一 shelf 的多行互相覆盖成
    // 空集 → loaded=true 后 filteredProcesses / filteredShelves 把候选池全过滤
    // 掉，8 个调用点的货架 / 工序下拉被静默清空。
    // 正确做法：遍历扁平行往对应 shelf 的 Set 里 add（regroup）。
    const m = new Map<string, Set<string>>();
    for (const item of q.data.value?.items ?? []) {
      let set = m.get(item.shelf_id);
      if (!set) {
        set = new Set<string>();
        m.set(item.shelf_id, set);
      }
      set.add(item.process_id);
    }
    return m;
  });

  /** 映射是否就绪 —— 判据是「我手上有没有映射数据」（`q.data !== undefined`），
   *  **不是** `isSuccess`。
   *
   *  2026-10-02（review 第 1 轮 I-1）：TanStack v5 在 **refetch 失败**（不是首调失败）
   *  时会保留上一次的 data，但把 status 翻成 'error' ⇒ isSuccess 变 false。若拿
   *  isSuccess 当 loaded：下拉在这个窗口里静默变回全量（用户视角是「刚选好的货架 /
   *  工序关系突然失效」），两个双向 watch 的 `if (!loaded) return` 也静默 no-op，
   *  可能留下一对未经验证的不兼容 货架/工序，等到下次成功 refetch 才突然围绕它收窄。
   *  迁移前的旧实现里 loaded 一旦 true 就**粘住**（只在 load() 首次失败时置 false），
   *  所以这是相对 main 的行为回归。
   *
   *  `data !== undefined` 对三种情形都正确：闸门未开 / 首调失败（含守门抛错）→ 无
   *  data → false，走全量兜底；refetch 失败 → data 还在 → true，照常过滤（严格更优）。*/
  const loaded = computed<boolean>(() => q.data.value !== undefined);

  /** 请求在飞 —— 用 isFetching（不是 isPending）以对齐旧语义：旧 `loading` 只表示
   *  「load() 在飞」，闸门未开（query 压根没跑）时不该报 true。注意 isPending 在
   *  enabled=false 时同样是 true，拿它派生会让「没发请求」被显示成「正在加载」。 */
  const loading = computed<boolean>(() => q.isFetching.value);

  // 2026-10-02（review 第 1 轮 I-2）：**Zod 守门必须留下痕迹**。
  // 迁移前裸 load() 的 catch 里有 console.error；迁到 query 后 error 只落在 query
  // state 里，不桥接的话「守门」就只是让过滤退回全量，契约漂移的表现（8 个页面的
  // 下拉静默变宽）与迁移前一模一样却查无实据 —— 可诊断性反而比迁移前更差。
  // 按 CLAUDE.md 架构条目 §9 走 watch(error) 桥接：console.error 供排障，
  // ElMessage.error 让用户知道「映射这次没生效」；两者都经 lastReportedError 去重，
  // 10 处实例只打扰一次。
  watch(q.error, (e) => {
    if (!e) {
      // 回到成功 → 复位，下一轮失败允许再上报一次。
      lastReportedError = null;
      return;
    }
    if (lastReportedError === e) return;
    lastReportedError = e;
    console.error(
      '[shelf] 货架↔工序映射不可用，货架/工序下拉本次不做映射过滤（详见上一行 ZodError）',
      e,
    );
    ElMessage.error('工序映射加载失败，货架与工序下拉暂未按映射收窄');
  });

  /** 给定 shelfId 返回 Set<processId>；无映射 → null */
  function processesForShelf(sid: string | null | undefined): Set<string> | null {
    if (!sid) return null;
    return mapping.value.get(sid) ?? null;
  }

  /** 选了某 shelf → 过滤可选 process */
  const filteredProcesses = computed<readonly P[]>(() => {
    if (!loaded.value || !shelfId.value) return allProcesses.value;
    const allowed = processesForShelf(shelfId.value);
    if (!allowed) return allProcesses.value;
    return allProcesses.value.filter((p) => allowed.has(p.id));
  });

  /** 选了某 process → 过滤可选 shelf */
  const filteredShelves = computed<readonly S[]>(() => {
    if (!loaded.value || !processId.value) return allShelves.value;
    return allShelves.value.filter((s) => mapping.value.get(s.id)?.has(processId.value as string));
  });

  // 选了 process，但当前 shelf 不支持 → 清空 shelf + 提示
  watch(processId, (pid) => {
    if (!pid || !shelfId.value || !loaded.value) return;
    const allowed = processesForShelf(shelfId.value);
    if (!allowed || !allowed.has(pid)) {
      shelfId.value = null;
      ElMessage.warning('已清空货架选择：当前货架不支持该工序');
    }
  });

  // 选了 shelf，但当前 process 不在它的映射里 → 清空 process（静默，避免双向 toast）
  watch(shelfId, (sid) => {
    if (!sid || !processId.value || !loaded.value) return;
    const allowed = processesForShelf(sid);
    if (!allowed || !allowed.has(processId.value)) {
      processId.value = null;
    }
  });

  return {
    filteredShelves,
    filteredProcesses,
    loaded,
    loading,
    /** 给工具方法用：当前 shelf 是否支持某 process（不触发 reactive） */
    processesForShelf,
  };
}
