// src/views/production/composables/useBatchRecall.ts
//
// 2026-10-06 新增：生产队列「已下发批次召回为待下发」的写操作 composable。
// 消费方是 WorkerQueueBoard（右键菜单 → 二次确认 → 召回），批次可以在
// **货架上**（工序候选池 / PoolDrawer）或**工人持有中**（工人列 / WorkerColumn），
// 两条消费路径都把卡片原样交给本 composable，故召回逻辑只此一份。
//
// 后端契约：`POST /api/v2/prod/batches/{batch_id}/recall-to-pending`
//   - 入参 `{ version, note? }`，**version 必填**（后端 `RecallToPendingRequest`
//     的 version 是 `i32` 且无 `#[serde(default)]`，缺省 40001）；
//   - 出参 `PartItem` —— 本次**零字段消费**；
//   - RBAC：MANAGER 或 CLERK（后端 require_any_role([Manager, Clerk])，其余 40300）；
//   - 副作用：status → PENDING，且 location / current_holder_id /
//     current_process_id / current_process_step_id 四列一起清 NULL；
//   - 允许的源状态：IN_PROCESS（货架在池 / 工人持有）或历史 PROGRAMMING。
//
// 为什么不走 parts 域既有封装：`recallToPending`（api/parts/crud.ts）本来就是本端点
// 的唯一前端封装，直接复用，本文件只做 mutation + 权限 + 确认 + 失效编排。
//
// 出参不做 Zod 守门（与 useWorkerQueue.moveMutation 的做法不同，理由）：
//   CLAUDE.md 的「queryFn Zod 守门」约束的是**查询**出参 —— 那些字段要驱动渲染，
//   契约漂移会静默把 undefined 塞进模板。这里是 mutation，出参 `PartItem` 一个字段
//   都不消费（召回成功与否由 HTTP 状态码 + onSuccess 判定），为此新造一个覆盖
//   数十字段的大 schema 只会带来漂移噪音、零收益。若将来开始消费某字段（例如要回显
//   新 version），届时再补 schema 并在此处说明。
//
// 已知缺口（不在本次范围，不顺手改）：`views/parts/list/composables/usePartDispatch`
// 的召回调用方传的是 undefined payload（发 `{}`）⇒ 必然 40001；那条路径本就是坏的
// （`GET /parts` 不返回 batch_id，见该文件的 RECALL_NO_BATCH_HINT）。

import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import type { UseMutationReturnType } from '@tanstack/vue-query';
import { recallToPending } from '@/api/parts/crud';
import { useAuthStore } from '@/stores/auth';
import { qk } from '@/composables/queries/keys';
import { invalidatePendingBatchesQuery } from '@/composables/queries/usePendingBatchesQuery';
import { invalidateWorkerPoolByProcessAll } from '@/composables/queries/useWorkerPoolByProcessQuery';
import { invalidateWorkerPoolCountsQuery } from '@/composables/queries/useWorkerPoolCountsQuery';
import { invalidateWorkerStateByWorkerAll } from '@/composables/queries/useWorkerStateByWorkerQuery';
import type { BatchCardModel } from '@/types/batchCard';

/** 召回 mutation 的入参。出参不建模（后端返 `PartItem`，本次零字段消费，见文件头），
 *  故 TData 由 mutationFn 的返回值（`void`）自然推断，不显式标注。 */
export interface BatchRecallVars {
  batchId: string;
  /** t_part_batch.version —— 后端必填（缺省 40001），取自卡片 model。 */
  version: number;
}

export interface UseBatchRecallReturn {
  /** 是否有召回权限（MANAGER / CLERK，与后端 require_any_role 对齐）。
   *  右键菜单在 open 之前用它闸掉无权角色 —— 后端对其它角色返 40300，
   *  前端不该让用户点完才知道。 */
  canRecall: ComputedRef<boolean>;
  /** 召回 mutation（mutation.isPending / mutate）。 */
  recallMutation: UseMutationReturnType<void, Error, BatchRecallVars, unknown>;
  /** 召回一张卡片的完整交互：权限校验 → 二次确认 → mutate。 */
  recallBatch: (batch: BatchCardModel) => Promise<void>;
}

export function useBatchRecall(): UseBatchRecallReturn {
  // CLAUDE.md：useQueryClient() 必须在 setup 第一行捕获，不能挪进回调惰性取。
  const qc = useQueryClient();
  // 消费侧禁止解构 auth store（store proxy 已自动解包 ref）。
  const auth = useAuthStore();

  /** 权限闸门 —— 与后端 `require_any_role([Manager, Clerk])` 逐字对齐：
   *  少放一个角色 ⇒ 用户点了吃 40300；多放一个 ⇒ 用户点了才知道没权限。 */
  const canRecall = computed<boolean>(() => auth.hasRole('MANAGER') || auth.hasRole('CLERK'));

  /** 召回后集中失效五域，逐条理由：
   *   - pending-batches：批次回到「待下发」池（列表 + 徽标 + 排序全变）；
   *   - worker-pool by-process：批次离开原工序候选池；
   *   - worker-pool counts：tab 标题 (N) 徽标 + 「待下发」工序卡徽标；
   *   - worker-pool state：离开工人列，且该工人工位 current_held 减少；
   *   - parts（qk.partsPrefix）：part 级派生状态（下一道工序指针、批次成员资格），
   *     与 usePendingDispatch.invalidateAll 的同款理由。
   *  按前缀全失效而非精刷：批次可以从任意工序的候选池或任意工人的手里被召回，
   *  前端拿不到「它原本在哪个 processId / workerId」（菜单只带卡片 model）。 */
  async function invalidateRecallDomains(): Promise<void> {
    await invalidatePendingBatchesQuery(qc);
    await qc.invalidateQueries({ queryKey: qk.partsPrefix }).then(() => undefined);
    await invalidateWorkerPoolByProcessAll(qc);
    await invalidateWorkerPoolCountsQuery(qc);
    await invalidateWorkerStateByWorkerAll(qc);
  }

  const recallMutation = useMutation({
    mutationKey: ['production-batch', 'recall-to-pending'],
    // 不写 retry（信任 main.ts 全局 mutations.retry: 0）。
    mutationFn: async ({ batchId, version }: BatchRecallVars) => {
      await recallToPending(batchId, { version });
    },
    onSuccess: async () => {
      await invalidateRecallDomains();
      ElMessage.success('已召回到待下发');
    },
    onError: async (e: Error) => {
      ElMessage.error(e.message ?? '召回失败');
      // 失败也失效：409 OCC 冲突（40901，他人并发改动）说明本端看到的是过期数据，
      // 只能与服务器对账；这与 useWorkerQueue.moveMutation.onError 的既有做法一致。
      await invalidateRecallDomains();
    },
  });

  /** 单卡召回的完整交互链。两条早退都**不发请求**：
   *   - 无权限：菜单本不该能被打开（Board 的 provide 里已用 canRecall 闸过一道），
   *     这里是第二道，纯属防御；
   *   - version 缺失：后端必填，缺了必然 40001，直接提示比发一个注定失败的请求好。
   *     两个适配器（poolItemToCard / heldToCard）都填了 version，故理论上到不了这里。 */
  async function recallBatch(batch: BatchCardModel): Promise<void> {
    if (!canRecall.value) {
      ElMessage.warning('没有召回已下发批次的权限');
      return;
    }
    if (typeof batch.version !== 'number') {
      ElMessage.warning('批次版本信息缺失，无法召回');
      return;
    }
    const label = batch.batch_no || batch.part_name || batch.batch_id;
    try {
      await ElMessageBox.confirm(
        `确认将批次「${label}」召回到待下发？召回后该批次将从货架/工人处移除，回到待下发池。`,
        '召回确认',
        {
          type: 'warning',
          confirmButtonText: '召回',
          cancelButtonText: '取消',
        },
      );
    } catch {
      // 用户取消：不动任何数据
      return;
    }
    recallMutation.mutate({ batchId: batch.batch_id, version: batch.version });
  }

  return { canRecall, recallMutation, recallBatch };
}
