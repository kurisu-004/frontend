// views/parts/detail/composables/usePartEventsQuery.ts
//
// 零件事件历史查询（`GET /api/v2/parts/{part_id}/events` 的 `PartEventOut[]`）。
//
// 形态与 `usePartDetailQuery.ts` 完全同款（同一个文件的两条读端点，闸门 / staleTime /
// fetch 别名 / ElMessage 桥接都一致），只有两处不同：
//   - **出参是裸数组，不是 `{items,total}` 信封**：端点不接 `limit` / `offset`，后端
//     `Vec<PartEventOut>` 直接序列化。守门因此是 `z.array(partEventSchema)`
//     （`partDetailSchema.ts::partEventListSchema`），不是对象信封；
//   - 它是**写侧数据**：详情页 7 个写端点每一个都会往 `t_part_event` 追加行，所以
//     失效链上它与详情键、批次键同批刷（见 `usePartDetailActions.ts` 的
//     `invalidatePartDetailCaches`）。仍是有限 staleTime —— 别的域（生产队列 / 外协 /
//     送货）也会写事件，本页不是这些写的调用方，穷举失效不可持续。
//
// 字段集以**后端 VO** 为准（`PartEventOut`）：11 个核心字段 + 4 个由后端
// `feat/part-detail-contract` 分支补的展示字段。`batch_no` 是**工单内批次序号**
//（i32 ⇒ JSON number，不是雪花 ID 字符串）、`worker_name` / `operator_name` /
// `operator_username` 三个人名字段可空且声明成 `.nullish()`（键在后端分支上，未进
// master）—— 事件卡（`PartHistoryCard`）的批次标签 / 工人名 / 操作者三段展示全部读
// 它们，键缺失时那三段 `v-if` 恒假、静默不渲染，而不是让整条响应 parse 失败。
// ⚠️ 本 schema **不接** `.strict()`（与详情键的 28 字段 `.strict()` 不同）：事件行是
// 追加流，后端加派生列不应让历史卡整块白屏，而「少一个必填键就炸」这一半已经由
// 必填键声明兜住。
//
// 2026-10-10 新增：`isActive` 入参与详情键同款 —— keep-alive 下本页被缓存后
// `route.params.id` 跟的是 vue-router 的**全局** currentRoute，切去别的页面时它照样
// 变（后果与详情键一致：静默渲染成另一个零件的事件流），只能在 `enabled` 侧收。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listPartEvents } from '@/api/parts';
import { qk } from '@/composables/queries/keys';
import { partEventListSchema } from './partDetailSchema';

export function usePartEventsQuery(
  partId: MaybeRefOrGetter<string | null | undefined>,
  /** 本页是否仍是当前路由（keep-alive 缓存页必需，见文件头注释）。省略 = 恒真。 */
  isActive: MaybeRefOrGetter<boolean> = true,
) {
  const queryKey = computed(() => qk.partEvents(toValue(partId) ?? ''));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // id 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const id = queryKey[1] as string;
      // 闸门外的二次守卫，理由同 usePartDetailQuery。
      if (!id) throw new Error('缺少零件 id');
      // 端点无分页 ⇒ 出参是裸数组，守门 schema 也是裸数组（不是 {items,total}）。
      return partEventListSchema.parse(await listPartEvents(id));
    },
    enabled: computed(() => Boolean(toValue(partId)) && Boolean(toValue(isActive))),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  /** fetchEvents 别名 = refetch 的 async 包装（shell 的刷新按钮与测试驱动）。 */
  async function fetchEvents(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '加载历史记录失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchEvents,
  };
}
