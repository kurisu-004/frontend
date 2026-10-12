// 扫码找件 · 只读诊断的 query hook（`useScanLocateQuery`）。
//
// 2026-10-15 新增。数据源 `GET /api/v2/prod/scan/locate`（后端 `prod::scan` 域第 6 条
// 端点），守门 schema 与本 hook 同目录（`./scanSchema.ts`），形态照
// `useScanListQuery.ts` 的 `useScanPickableQuery` / `useScanHeldQuery`。
//
// **为什么报工台三页要它**：三页扫到 0 匹配时的兜底出口此前走
// `src/utils/scanHelpers.ts::findPartBySerialAndPrompt` → `GET /parts/by-serial/{sn}`，
// 而那条端点的后端闸门是 `[Manager, Clerk, Inspector, CncProgrammer]`、**不含
// `SHELF_ACCOUNT`** ⇒ 工人一体机账号恒 403。报工台自有的端点全部放行 `SHELF_ACCOUNT`，
// 故兜底改接本 hook。
//
// 设计要点（逐条与两条 list 的 query hook 同款，不要各拍一次）：
//   - **reactive params 范式**：`queryKey: computed(() => qk.scanLocate(toValue(params)))`，
//     `queryFn` **从 queryKey 读 params**（键是唯一真相源），不闭包捕获 stale 值；
//   - **params 允许为 `null`**（弹窗未打开 / 没有工人）：落占位键 + `enabled=false` 闸门
//     + queryFn 内二次守卫 ⇒ 不发请求。这条闸门是**必需**的：`serial_no` 后端必填、
//     `worker_id` 只吃字符串，漏传会被 `QueryRejection` 拒成 **HTTP 400 纯文本**
//     （不进 `R<T>` 信封，连业务码都读不到）；
//   - **worker_id 必发**（三页都有工人）：不传则后端 `action` / `disabled_reason` 恒
//     `null`，诊断行一颗按钮都渲染不出来；
//   - `staleTime: 30_000` / `gcTime: 5 * 60 * 1000`，与同域两条 list 同值（⚠️ gcTime
//     **保持有限值**，不得改成 POSITIVE_INFINITY —— 报工台没有 WS 失效通道，无限 GC 会让
//     「切走 5 分钟后回来」命中陈旧诊断）；
//   - 错误桥接：`watch(error)` + `ElMessage.error`，文案走同目录既有的
//     `scanListErrorText`（契约漂移给工人一句固定文案、细节只进 console），不新造一套；
//     唯一例外是 `20101`（工单未命中）—— 它是弹窗的空态职责、不弹 toast（见 watch 处）；
//   - 不写 retry：信任 main.ts 全局 `queries.retry: 0`；
//   - `fetchList` 别名 = `refetch` 的 async 包装，供弹窗的「刷新」按钮与测试驱动。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { ApiError } from '@/api/http';
import { fetchScanLocate } from '@/api/productionScan';
import { qk } from '@/composables/queries/keys';
import { locateResultSchema } from './scanSchema';
import { scanListErrorText } from './scanListErrorMessage';

/** 诊断查询的入参形状（与 `qk.scanLocate` 的键位逐字一致）。 */
export interface UseScanLocateParams {
  /** 扫到的序列号（后端只查 `t_part.serial_no`，**不回退 `t_assembly`**）。 */
  serialNo: string;
  /** 工人雪花 ID 字符串；不传则后端不算 `action`（三页都必传）。 */
  workerId: string;
}

/**
 * 扫码找件诊断（`GET /api/v2/prod/scan/locate`）。
 *
 * @param params `{ serialNo, workerId }`；`null` 时不发请求（占位键 + 闸门 + 二次守卫）。
 *
 * 用法：
 * ```ts
 * const locate = useScanLocateQuery(() =>
 *   open.value && code.value && workerId.value
 *     ? { serialNo: code.value, workerId: workerId.value }
 *     : null,
 * );
 * const batches = computed(() => locate.data.value?.batches ?? []);
 * ```
 */
export function useScanLocateQuery(params: MaybeRefOrGetter<UseScanLocateParams | null>) {
  const queryKey = computed(() => {
    const p = toValue(params);
    return qk.scanLocate(p ? { serialNo: p.serialNo, workerId: p.workerId } : null);
  });

  const query = useQuery({
    queryKey,
    // 从 queryKey 读 params（reactive params 范式），不闭包捕获 stale 值。
    queryFn: async () => {
      const p = queryKey.value[2];
      // 二次守卫：缺键时后端返 400 纯文本（这里早退，症状是「弹窗空 + 一条守卫信息」，
      // 比一句裸 400 好定位）。
      if (!p) throw new Error('locate 查询缺少 serial_no');
      if (!p.workerId) throw new Error('locate 查询缺少 worker_id（不传则不算 action）');
      return locateResultSchema.parse(
        await fetchScanLocate({ serialNo: p.serialNo, workerId: p.workerId }),
      );
    },
    // params 为 null（弹窗未打开 / 无工人）时不发请求 —— 见文件头的闸门说明。
    enabled: computed(() => queryKey.value[2] !== null),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  watch(query.error, (e) => {
    if (!e) return;
    // `20101`（工单未命中）**不弹错误 toast**：本查询的最高频输入形态就是「扫了个不存在
    // 的条码」——弹窗只在三页扫到 0 匹配时打开，那时它要回答的正是「这个条码在哪」。
    // 未命中由 `LocateDialog` 的空态承担（灰态 + 「若这是装配件请扫子件」），
    // 在此再弹一条红字 toast 等于同一件事说两遍、其中一遍还在说「你操作错了」。
    if (e instanceof ApiError && e.code === 20101) return;
    ElMessage.error(scanListErrorText(e, '查询零件位置失败'));
  });

  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  return { query, data: query.data, error: query.error, fetchList };
}
