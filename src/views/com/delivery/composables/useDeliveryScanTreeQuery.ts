// src/views/com/delivery/composables/useDeliveryScanTreeQuery.ts
//
// 扫码取三层树的 **useMutation**（不是 useQuery）。
//
// 为什么是 mutation：扫码是**用户触发的单次拉取** —— 扫一下弹一次树，弹窗关闭后这次
// 拉取就作废；不是「页面持有的一份需要在窗口聚焦 / 轮询时保持新鲜的读数据」。
// 用 useQuery 表达它会带来两个都不想要的语义：缓存（同一 serial 再扫一次要命中 stale
// 条目，用户看不到服务端的新批次状态）与后台重取（refetchOnMount / 窗口聚焦会再发一次
// 弹窗根本没有的请求）。
//
// 守门 parse 因此留在 **api 层**（`getDeliveryScanTree` 内
// `deliveryScanTreeSchema.parse`）—— CLAUDE.md「Zod schema-first」给运行时值 import
// 留的唯一合法边就是这种「没有 queryFn 承载的单次拉取」。本 hook 只 `import type`。

import { ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { getDeliveryScanTree } from '@/api/com/deliveryNote';
import type { DeliveryScanTreeData } from './deliveryScanTreeSchema';

export function useDeliveryScanTreeMutation() {
  const tree = ref<DeliveryScanTreeData | null>(null);

  const scanTreeMutation = useMutation({
    mutationKey: ['delivery', 'scan-tree'],
    mutationFn: (serialNo: string) => getDeliveryScanTree(serialNo),
    onSuccess: (data) => {
      tree.value = data;
    },
  });

  /** 关闭对话框时清树：不清的话下次扫码请求在飞时会先闪出上一次的树。 */
  function clearScanTree(): void {
    tree.value = null;
    scanTreeMutation.reset();
  }

  return { tree, scanTreeMutation, clearScanTree };
}