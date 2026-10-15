// src/views/hr/schedule/composables/useScheduleQueries.ts
//
// 2026-10-19 新建：排班日历页三条读端点的 useQuery hook。形态照
// `views/wecom/webhooks/composables/useWeComWebhooksQuery.ts`（无自有状态、入参
// `MaybeRefOrGetter`、queryFn 里 Zod 守门、`watch(error) → ElMessage` 桥接、`fetch*` 是
// refetch 的 async 包装）。
//
// 三条端点：
//   - `GET /hr/shifts`             —— 班次栏（`include_inactive: true`，停用项也要看得见，
//                                     否则停用后就再也点不回来改回来）；
//   - `GET /hr/calendar/days`      —— 全局作用域的月历数据；
//   - `GET /hr/shifts/{id}/calendar` —— 班次作用域的月历数据。
//
// 后两条**合成一个 hook**（`useHrCalendarQuery`）：月历只有一个数据源，作用域一变就换端点，
// 拆成两条会让 store 里多出一组「A 作用域用 queryA、B 作用域用 queryB」的 enabled 编排，
// 而它们的下游（`days` / `stats` / loading / 错误条）完全一致。代价是 queryKey 要随作用域
// 变（见下）。
//
// ⚠️ **`data` 是已剥掉信封的数组**（不是 `{items:[...]}`）：三条 hook 都在 queryFn 里
//   parse 完立刻取 `.items`。把 parse 结果当数组用会在每一屏炸 `.map is not a function`。
//
// ⚠️ **不设 `retry`**：信任 `main.ts` 的全局 `queries.retry: 0`。也不设
//   `staleTime` / `refetchOnWindowFocus`：新鲜度靠「每次挂载重取 + 写后 invalidate」。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { getHrShiftCalendar, listHrCalendarDays, listHrShifts } from '@/api/hr';
import { qk } from '@/composables/queries/keys';
import {
  hrCalendarDaysResultSchema,
  hrShiftCalendarResultSchema,
  hrShiftListResultSchema,
  type HrCalendarDayData,
  type HrShiftCalendarDayData,
} from '../hrScheduleSchema';
import { hrErrorText } from '../hrErrorText';
import type { HrCalendarRangeQuery } from '@/types/hr';

/** 本域的编辑作用域：`'global'` = 全局日历；`{kind:'shift'}` = 某个班次的日历。 */
export type ScheduleScope =
  'global' | { kind: 'shift'; id: string; name: string; color: string | null };

/** 班次栏：读全部班次（含**已停用**的 —— 停用是软删，`include_inactive` 不给就再也点不回来）。 */
export function useHrShiftsQuery(options: { enabled: MaybeRefOrGetter<boolean> }) {
  const query = useQuery({
    queryKey: computed(() => qk.hrShifts(true)),
    queryFn: async () =>
      hrShiftListResultSchema.parse(await listHrShifts({ include_inactive: true })).items,
    enabled: computed(() => toValue(options.enabled)),
  });

  async function fetchShifts(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(hrErrorText(e, '班次列表加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchShifts };
}

/**
 * 月历数据（随作用域切端点）。
 *
 * ⚠️ **queryKey 随作用域变**：全局走 `qk.hrCalendarDays(from, to)`、班次走
 *   `qk.hrShiftCalendar(id, from, to)`。切作用域就是换一条缓存（两条数据本来就不一样，
 *   共用一条 key 只会互相覆盖），切回来命中各自的缓存、不重新打。
 */
export function useHrCalendarQuery(options: {
  enabled: MaybeRefOrGetter<boolean>;
  scope: MaybeRefOrGetter<ScheduleScope>;
  range: MaybeRefOrGetter<HrCalendarRangeQuery>;
}) {
  const query = useQuery({
    queryKey: computed(() => {
      const scope = toValue(options.scope);
      const { from, to } = toValue(options.range);
      return scope === 'global'
        ? qk.hrCalendarDays(from, to)
        : qk.hrShiftCalendar(scope.id, from, to);
    }),
    queryFn: async (): Promise<HrCalendarDayData[] | HrShiftCalendarDayData[]> => {
      const scope = toValue(options.scope);
      const { from, to } = toValue(options.range);
      if (scope === 'global') {
        return hrCalendarDaysResultSchema.parse(await listHrCalendarDays({ from, to })).items;
      }
      return hrShiftCalendarResultSchema.parse(await getHrShiftCalendar(scope.id, { from, to }))
        .items;
    },
    enabled: computed(() => toValue(options.enabled)),
  });

  async function fetchCalendar(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(hrErrorText(e, '日历加载失败'));
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchCalendar,
  };
}
