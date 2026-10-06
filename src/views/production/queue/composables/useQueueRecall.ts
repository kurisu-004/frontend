// 生产队列「已下发批次召回为待下发」的写操作 composable（`POST /prod/queue/recall`）。
// 消费方是 QueueBoard（右键菜单 → 二次确认 → 召回）。批次可以在**货架上**
// （工序候选池 / PoolDrawer）或**工人持有中**（工人列 / WorkerColumn），两条消费
// 路径都把卡片原样交给本 composable，故召回逻辑只此一份。
//
// 2026-10-08 入口收敛：召回入口统一收敛到生产队列页右键菜单；零件列表页原有入口
// 随端点下线一并移除（该页的批次列表本来就不返回 `batch_id`，旧入口发出去的请求
// 必然缺锚点）。
//
// 后端契约：
//   - 入参 `{ batch_id, version, note? }` —— `batch_id` 是 **body 字段**且必须发
//     **JSON 字符串**（后端 `deserialize_i64` 只接受字符串，发数字返 40001）；
//   - `version` 必填（OCC 乐观锁，无 `#[serde(default)]` ⇒ 缺省 40001），取卡片
//     model 的 `t_part_batch.version`；
//   - 出参 `RecallOut { batch_id, part_id, version }`，`version` 是召回后的新版本；
//   - RBAC：MANAGER 或 CLERK（后端 require_any_role，其余 40300）；
//   - 副作用：status → PENDING，且 location / current_holder_id / current_process_id
//     / current_process_step_id 四列一起清 NULL；
//   - 允许的源状态：IN_PROCESS（货架在池 / 工人持有）或历史 PROGRAMMING。
//
// 出参经 `recallOutSchema.parse()` 守门（出参只有 3 个字段，schema 很薄；与 move
// 同款做法）。⚠️ 召回成功后前端**不消费** version：列表下一次 invalidate 会拿到新值，
// 就地回显新 version 会让两处缓存短暂不一致。

import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation, useQueryClient, type UseMutationReturnType } from '@tanstack/vue-query';
import { recallToPending } from '@/api/productionQueue';
import type { RecallOutDto } from '@/api/productionQueue.contract';
import { useAuthStore } from '@/stores/auth';
import { qk } from '@/composables/queries/keys';
import type { BatchCardModel } from '@/types/batchCard';
import { recallOutSchema } from './productionQueueSchema';
import { invalidateQueueBoardAll } from './useQueueBoard';
import { invalidateQueuePendingAll } from './useQueueDispatch';
import { invalidateQueueSnapshot } from './useQueueSnapshot';

/** 召回 mutation 的入参。出参建模为 `RecallOutDto`（3 字段，见 recallOutSchema）。 */
export interface QueueRecallVars {
  batchId: string;
  /** `t_part_batch.version` —— 后端必填（缺省 40001），取自卡片 model。 */
  version: number;
}

export interface UseQueueRecallReturn {
  /** 是否有召回权限（MANAGER / CLERK，与后端 require_any_role 对齐）。
   *  右键菜单在 open 之前用它闸掉无权角色 —— 后端对其它角色返 40300，
   *  前端不该让用户点完才知道。 */
  canRecall: ComputedRef<boolean>;
  /** 召回 mutation（mutation.isPending / mutate）。 */
  recallMutation: UseMutationReturnType<RecallOutDto, Error, QueueRecallVars, unknown>;
  /** 召回一张卡片的完整交互：权限校验 → 二次确认 → mutate。 */
  recallBatch: (batch: BatchCardModel) => Promise<void>;
}

export function useQueueRecall(): UseQueueRecallReturn {
  // useQueryClient() 必须在 setup 第一行捕获，不能挪进回调惰性取。
  const qc = useQueryClient();
  // 消费侧禁止解构 auth store（store proxy 已自动解包 ref）。
  const auth = useAuthStore();

  /** 权限闸门 —— 与后端 `require_any_role([Manager, Clerk])` 逐字对齐：
   *  少放一个角色 ⇒ 用户点了吃 40300；多放一个 ⇒ 用户点了才知道没权限。 */
  const canRecall = computed<boolean>(() => auth.hasRole('MANAGER') || auth.hasRole('CLERK'));

  /** 召回后集中失效，逐条理由：
   *   - 待下发列表：批次回到「待下发」池（列表 + 徽标 + 排序全变）；
   *   - 工序看板：批次离开原工序候选池 / 原工人的持有列；
   *   - 队列快照：tab 标题 (N) 徽标 + 右栏工序卡徽标；
   *   - parts（`qk.partsPrefix`）：工单级派生状态（下一道工序指针、批次成员资格），
   *     与 useQueueDispatch.invalidateAll 的同款理由。
   *  全部按**前缀**全失效而非精刷：批次可以从任意工序的候选池或任意工人的手里被
   *  召回，前端拿不到「它原本在哪个 processId / workerId」（菜单只带卡片 model）。 */
  async function invalidateRecallDomains(): Promise<void> {
    await invalidateQueuePendingAll(qc);
    await invalidateQueueBoardAll(qc);
    await invalidateQueueSnapshot(qc);
    await qc.invalidateQueries({ queryKey: qk.partsPrefix }).then(() => undefined);
  }

  const recallMutation = useMutation({
    mutationKey: ['production-queue', 'recall'],
    // 不写 retry（信任 main.ts 全局 mutations.retry: 0）。
    mutationFn: async ({ batchId, version }: QueueRecallVars) =>
      recallOutSchema.parse(await recallToPending({ batch_id: batchId, version })),
    onSuccess: async () => {
      await invalidateRecallDomains();
      ElMessage.success('已召回到待下发');
    },
    onError: async (e: Error) => {
      ElMessage.error(e.message ?? '召回失败');
      // 失败也失效：409 OCC 冲突（40901，他人并发改动）说明本端看到的是过期数据，
      // 只能与服务器对账；这与 useQueueMove.moveMutation.onError 的做法一致。
      await invalidateRecallDomains();
    },
  });

  /** 单卡召回的完整交互链。两条早退都**不发请求**：
   *   - 无权限：菜单本不该能被打开（QueueBoard 的 provide 里已用 canRecall 闸过一道），
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
        { type: 'warning', confirmButtonText: '召回', cancelButtonText: '取消' },
      );
    } catch {
      // 用户取消：不动任何数据
      return;
    }
    recallMutation.mutate({ batchId: batch.batch_id, version: batch.version });
  }

  return { canRecall, recallMutation, recallBatch };
}