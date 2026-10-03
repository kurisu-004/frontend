// 2026-08-26 新增：工人队列调度看板的领域类型定义。
// 雪花 ID 全部 string（CLAUDE.md #3）；字段命名对齐 Rust 后端 WorkerPoolState / TakenItem。
//
// 2026-09-30：删 `AssignRequest` / `ReturnRequest` —— 它们描述的是后端
// `POST /admin/worker-pool/{assign,remove}` 的旧请求体，已被
// `POST /prod/pool/move` 的 `MoveRequest`（tagged enum from/to）取代；
// 类型本体见 src/api/workerPool.contract.ts，无消费者故直接删除。
//
// 2026-10-03：`BatchCardModel` 迁出到 `src/types/batchCard.ts` —— BatchCard 已升级
// 为全仓共享组件（生产队列 + 外协看板两套域消费），卡片 view-model 不再挂在
// workerPool 这个域的名字下。本文件只留生产队列域自有的看板结构（Worker /
// ProcessPoolView）。

import type { BatchCardModel } from '@/types/batchCard';

export interface Worker {
  /** 雪花 ID，string */
  id: string;
  name: string;
  badge_code: string;
  /** 工种 code，决定可承接工序集合 */
  work_type_code: string;
  /** 最大持有批次数 */
  max_held: number;
  /** 当前持有批次数 */
  current_held: number;
  /** max_held - current_held */
  capacity_remaining: number;
  is_online: boolean;
  /** 该工人可加工工序 ID 列表（用于 tab 过滤）；
   *  后端尚未暴露 work_type.process_ids 映射，前端在 fixture 落地 */
  process_ids: string[];
}

export interface ProcessPoolView {
  process_id: string;
  process_code: string;
  process_name: string;
  batches: BatchCardModel[];
}
