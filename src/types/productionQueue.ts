// 2026-10-08：生产队列域的 view-model 从「后端域改名前的旧文件名」收敛到本文件，
// 并删掉 `Worker` 这个中间 view-model。
//
// 删 `Worker` 的理由：它是「工人列 props」的骨架（id / name / badge_code /
// work_type_code / 三个容量字段 / is_online / process_ids），原先由
// `WorkerPoolTab` 拿工序列表里的工人简报拼出来、把 `max_held` / `current_held` /
// `capacity_remaining` 全部填 0 占位，真正的容量与持有批次由工人列自己再发一次
// 单工人请求拿（两个数据源对不上时以自己那次为准）。后端把容量三字段与持有批次
// 内联进工序看板的 `workers[]` 后，工人列直接透传 `QueueWorkerSchema`，
// 这层中间 view-model 零存在理由。`is_online` 同样随之消失（后端不给在线状态，
// 前端也不需要 —— 列头「离线」tag 的条件恒为 false）。
//
// 保留 `ProcessPoolView`：它是左侧候选池抽屉（PoolDrawer）的 props 形态，
// 「工序三字段 + 适配好的卡片数组」，与工序看板端点一一对应，仍是本域独有的结构。

import type { BatchCardModel } from '@/types/batchCard';

/** 工序候选池抽屉的 props 形态（工序元数据 + 已适配好的批次卡片）。
 *  消费方：PoolDrawer.vue。`batches` 已是 `BatchCardModel[]`（经
 *  `views/production/queue/utils/queueItemToCard.ts` 适配），抽屉组件零 DTO 依赖。 */
export interface ProcessPoolView {
  process_id: string;
  process_code: string;
  process_name: string;
  batches: BatchCardModel[];
}