// 报工台两条写路径的 mutation（`useScanPickUpMutation` / `useScanWorkerScanMutation`）。
//
// 角色：
//   - pick-up（取件，`POST /api/v2/prod/scan/batches/{batch_id}/pick-up`）；
//   - worker-scan（放回 / 送检，`POST /api/v2/prod/scan/worker-scan`）。
//   两者共享同一套失效链，故收在同一个文件里：报工台只有这两条写路径，分成两个文件
//   只会让「写完要失效什么」这条口径散成两份。
//
// **失效链**（onSuccess 与 onError 都走，见下）：
//   `qk.scanPickablePrefix` + `qk.scanHeldPrefix` **两条前缀全失效**，不是只刷一个。
//   取件把行从 pickable 移走**同时**加进 held；放回 / 送检把行从 held 移走，**同时**
//   worker-scan 同事务跑的 refill 会给该工人抢进新批次（可能落回 pickable）。单失效一个
//   会留下半截陈旧列表 —— 表现是「取件后候选列表里还有刚领走的那张卡」或「放回后徽章
//   少算了一件」。
//
// **onError 也要走全套失效**：报工台最常见的失败恰恰是 40901（OCC 版本冲突，批次已被别人
// 处置）与 20103（状态机非法），两者都意味着**服务端那份数据已经变了**、本端副本已过期。
// 只在 onSuccess 失效的话，工人会盯着一条已经作废的列表继续操作。理由同
// `views/production/queue/composables/useQueueDispatch.ts` 的 dispatch mutation。
//
// mutationFn **不做** Zod 守门：worker-scan 的响应（`scan.event_type` / `refill.taken[]`）
// 由视图层在 `mutateAsync` 的返回值上直接消费，而它不需要跨域复用；pick-up 的响应
// （part 级 `PartOut`）报工台完全不读行字段 —— 领取成功这件事由「没有抛错」表达。
// 把它们写成 schema 只会守一个没人看的形状。**真正的守门在两条 list 的 queryFn 里**
// （`./scanSchema.ts`），那才是驱动渲染的数据。
//
// 不写 retry：信任 main.ts 全局 `mutations.retry: 0`。

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/vue-query';
import { pickUpBatch, scanWorker } from '@/api/productionScan';
import type {
  ScanPickUpRequest,
  ScanWorkerRequest,
  ScanWorkerResultDto,
} from '@/api/productionScan.contract';
import { qk } from '@/composables/queries/keys';

/** 失效报工台两条 list（写操作完成后调；返回 Promise<void> 让调用方可 await）。
 *
 *  顺序固定：pickable 先、held 后 —— 无关紧要，但固定下来让测试能逐字断言调用序。 */
export async function invalidateScanLists(qc: QueryClient): Promise<void> {
  await qc.invalidateQueries({ queryKey: qk.scanPickablePrefix });
  await qc.invalidateQueries({ queryKey: qk.scanHeldPrefix });
}

/**
 * 取件（pick-up）mutation。
 *
 * 入参 `{ batchId, version, workerId, quantity? }`：
 *   - `batchId` 走路径参数；`version` 是 `t_part_batch.version`（OCC 锚，**普通 number**），
 *     `workerId` 是**工人雪花 ID 字符串**（不是 badge_code）；`quantity` **必须发 JSON 字符串**
 *     （后端 `deserialize_i64_opt` 只解 String），缺省 = 整批。
 *   三个 number/string 之差的坑与逐条理由见 `api/productionScan.contract.ts`。
 */
export function useScanPickUpMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['scan', 'pick-up'],
    mutationFn: async (vars: {
      batchId: string;
      version: number;
      workerId: string;
      quantity?: string | null;
      note?: string | null;
    }): Promise<unknown> => {
      const payload: ScanPickUpRequest = {
        version: vars.version,
        worker_id: vars.workerId,
        quantity: vars.quantity ?? null,
        note: vars.note ?? null,
      };
      return pickUpBatch(vars.batchId, payload);
    },
    // 包一层闭包：onSuccess/onError 的入参是 (data, variables) 而不是 QueryClient，
    // 直接把 invalidateScanLists 挂上去会拿 data 当 qc 用。
    onSuccess: () => invalidateScanLists(qc),
    onError: () => invalidateScanLists(qc),
  });
}

/**
 * 放回 / 送检（worker-scan）mutation。
 *
 * 返回 `ScanWorkerResultDto`，视图层在 `mutateAsync` 的结果上读两处：
 *   - `scan.event_type`：**WS 广播名**（`WORKER_SCAN_RETURNED` / `WORKER_SCAN_INSPECTED`），
 *     放回页的成功文案按它分支 —— 客户端发 `RETURNED`，但当该批次当前工序是工序链最后
 *     一道时后端自动改投品检、回来的是 `WORKER_SCAN_INSPECTED`，照请求说「已放回 → 下一道」
 *     会让工人以为工件还在待加工区；
 *   - `refill.taken[]`：同事务自动补料抢到的批次，非空时弹窗告知（空数组 = 池空 / 已持满）。
 */
export function useScanWorkerScanMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['scan', 'worker-scan'],
    mutationFn: (payload: ScanWorkerRequest): Promise<ScanWorkerResultDto> => scanWorker(payload),
    onSuccess: () => invalidateScanLists(qc),
    onError: () => invalidateScanLists(qc),
  });
}
