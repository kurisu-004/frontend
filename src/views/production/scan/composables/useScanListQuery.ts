// 报工台（工人扫码台）两条 list 的 query hook（`useScanPickableQuery` /
// `useScanHeldQuery`），守门 schema 与它们同目录（`./scanSchema.ts`）。
//
// 设计要点：
//   - **reactive params 范式**：`queryKey: computed(() => qk.scanXxx(toValue(params)))`，
//     `queryFn` **从 queryKey 读 params**（键是唯一真相源），不闭包捕获 stale 值。
//     params 整体进键（`{ workerId, limit }` 这种形状），换工人 / 换 limit 即换一份
//     cache identity。
//   - **params 允许为 `null`**（未扫工牌 / 工人无工种）：此时 `queryKey` 落占位形态
//     `qk.scanXxx(null)`，`enabled=false` 且 queryFn 内二次守卫拦掉 ⇒ 不发请求。
//     这条闸门是**必需**的而非优化：两条端点的过滤键后端走 `deserialize_i64` 且必填，
//     漏传会被 axum `QueryRejection` 拒成 **HTTP 400 纯文本**（不进 `R<T>` 信封）。
//   - `staleTime: 30_000` / `gcTime: 5 * 60 * 1000`（CLAUDE.md「TanStack Query 降级为
//     30s 短时请求去重层」的取值）。⚠️ **gcTime 保持有限值**，不得改成
//     POSITIVE_INFINITY —— 那是 dashboard 域的例外，成立前提是该域有 WS 事件 invalidate、
//     不靠 GC；报工台没有失效通道，GC 设成无限会让「切走 5 分钟后回来」命中陈旧持有件。
//   - 错误桥接：useQuery 的 error 不在 setup 抛错（抛错会让整页 setup 失败），走
//     `watch(error)` + `ElMessage.error`，文案由域内 `scanListErrorText` 收口成一句人话
//     （Zod 契约漂移的细节只进 console）。
//   - 不写 retry：信任 main.ts 全局 `queries.retry: 0`。
//   - `fetchList` 别名 = `refetch` 的 async 包装，供视图层的「刷新」按钮与测试零改动驱动。
//
// **本轮接入的真实收益**：`HeldPartsBadge` 徽章与放回页 / 送检页此前各自
// `fetchScanHeld(workerId, { limit: 200 })` —— 同一屏对同一个工人**发 2 次同参请求**，
// 且切页无缓存（每次进页面重新拉）。共用 `qk.scanHeld` 一条键后，同键去重成 1 次请求，
// 30s 内切页也不再重拉。
//
// ⚠️ **共用一条键 ⇒ 同一个 query 上会挂着多个 observer**（页面的 hook + 徽章的 hook）。
// 若每个 observer 都弹一次 ElMessage.error，同一次失败会弹**两条**一模一样的 toast。
// 故 hook 带一个 `silent` 开关：页面的 hook 负责弹 toast，`HeldPartsBadge` 传
// `silent: true`、把错误渲染进抽屉内的 `errorMsg` 行（那是徽章原有的呈现方式）。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchScanHeld, fetchScanPickable } from '@/api/productionScan';
import { qk } from '@/composables/queries/keys';
import { scanPartListResultSchema } from './scanSchema';
import { scanListErrorText } from './scanListErrorMessage';

/** 两条 list hook 的共同开关。 */
export interface UseScanListQueryOptions {
  /** 跳过 `watch(error) → ElMessage.error` 桥接。页面的 hook 保持默认（弹 toast）；
   *  徽章传 `true`，把错误渲染进抽屉内的 `errorMsg` 行 —— 否则共用一条 query key 时
   *  同一个失败会被多个 observer 各弹一次 toast。 */
  silent?: boolean;
}

/**
 * 取件列表（`GET /api/v2/prod/scan/pickable`）。
 *
 * @param params `{ workTypeId, limit?, offset? }`；`null` / 空 `workTypeId` 时不发请求
 *   （工人未分配工种 —— 取件页据此显示「未分配工种」空态）。
 *
 * 用法：
 * ```ts
 * const pickable = useScanPickableQuery(() => {
 *   const wt = worker.value?.work_type_id;
 *   return wt ? { workTypeId: wt, limit: 200 } : null;
 * });
 * const items = computed(() => pickable.query.data.value?.items ?? []);
 * ```
 */
export function useScanPickableQuery(
  params: MaybeRefOrGetter<{ workTypeId: string; limit?: number; offset?: number } | null>,
  opts: UseScanListQueryOptions = {},
) {
  const queryKey = computed(() => {
    const p = toValue(params);
    return qk.scanPickable(
      p ? { workTypeId: p.workTypeId, limit: p.limit, offset: p.offset } : null,
    );
  });

  const query = useQuery({
    queryKey,
    // 从 queryKey 读 params（reactive params 范式），不闭包捕获 stale 值。
    queryFn: async () => {
      const p = queryKey.value[2];
      // 二次守卫：键缺失时后端返 400 纯文本（在守卫处早退，症状是「列表空 + 一次
      // console 提示」，比 400 好定位）。
      if (!p) throw new Error('pickable 查询缺少 work_type_id');
      return scanPartListResultSchema.parse(
        await fetchScanPickable({ workTypeId: p.workTypeId, limit: p.limit, offset: p.offset }),
      );
    },
    // params 为 null（未扫工牌 / 无工种）时不发请求 —— 见文件头的闸门说明。
    enabled: computed(() => queryKey.value[2] !== null),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  if (!opts.silent) {
    watch(query.error, (e) => {
      if (e) ElMessage.error(scanListErrorText(e, '加载可领件列表失败'));
    });
  }

  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  return { query, fetchList };
}

/**
 * 持有件列表（`GET /api/v2/prod/scan/held`）。
 *
 * @param params `{ workerId, limit?, offset? }`；`null` / 空 `workerId` 时不发请求
 *   （未扫工牌时三页的守卫本来就会把工人打回扫码入口，这里只是让 query 层也独立安全）。
 *
 * 三个消费方（放回页 / 送检页 / `HeldPartsBadge` 徽章）对同一工人传的是**同一组 params**，
 * 因此共用一条 query key —— 这正是同屏去重的来源，见文件头。
 */
export function useScanHeldQuery(
  params: MaybeRefOrGetter<{ workerId: string; limit?: number; offset?: number } | null>,
  opts: UseScanListQueryOptions = {},
) {
  const queryKey = computed(() => {
    const p = toValue(params);
    return qk.scanHeld(p ? { workerId: p.workerId, limit: p.limit, offset: p.offset } : null);
  });

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const p = queryKey.value[2];
      if (!p) throw new Error('held 查询缺少 worker_id');
      return scanPartListResultSchema.parse(
        await fetchScanHeld({ workerId: p.workerId, limit: p.limit, offset: p.offset }),
      );
    },
    enabled: computed(() => queryKey.value[2] !== null),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  if (!opts.silent) {
    watch(query.error, (e) => {
      if (e) ElMessage.error(scanListErrorText(e, '加载持有零件列表失败'));
    });
  }

  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  return { query, fetchList };
}
