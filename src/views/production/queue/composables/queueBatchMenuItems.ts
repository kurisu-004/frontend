// 2026-10-09 新建：生产队列三区（待下发池 / 工序候选池 / 工人列）的右键菜单项**派生**。
//
// 为什么是纯函数而不是板级 computed：菜单项的矩阵是「区域 × 角色 × 批次状态 × 目标集」
// 四维派生，其中只有「角色」与「目标集」依赖运行时数据，区域与批次状态都是常量判据。
// 抽成纯函数后这四维可以逐格单测（见 __tests__/queueBatchMenuItems.spec.ts），板级只
// 负责把 composable 的写操作包装、query 数据塞进来。
//
// 菜单**本体**在 `@/composables/useBatchContextMenu.ts`（库函数模式 + 固定传参），本文件
// 只产出 `MenuItem[]`，零 UI 依赖、零 api / store 依赖。

import type { MenuItem } from '@imengyu/vue3-context-menu';
import type { BatchArea } from '@/composables/useBatchContextMenu';
import type { BatchCardModel } from '@/types/batchCard';

/** 生产队列侧的区域枚举（共享 `BatchArea` 的子集 —— 与另三个外协区域互斥）。 */
export type QueueBatchArea = Extract<BatchArea, 'pending' | 'pool' | 'worker'>;

/** 「发送到工序」的目标项（取自共享 `useProcessesQuery` 的全量工序列表）。 */
export interface QueueMenuProcess {
  id: string;
  code: string;
  name: string;
}

/** 「发送到工人」的目标项（取自当前 tab 的 `board.workers[]`）。 */
export interface QueueMenuWorker {
  worker_id: string;
  name: string;
}

export interface QueueBatchMenuInput {
  /** 卡片所在区域 —— 菜单项矩阵的第一维。 */
  area: QueueBatchArea;
  /** 被右键的那张卡（只读 `quantity` / `batch_id` / `version` / `shelf_id`）。 */
  batch: BatchCardModel;
  /** 召回权限（MANAGER + CLERK）。待下发池不消费它（见下方「不给召回」的注释）。 */
  canRecall: boolean;
  /** 拆批权限（MANAGER + CLERK）。**只管角色**，批次自身的可拆性（余量 > 1）由派生
   *  函数叠加 —— 两道闸的来源不同，混在一个布尔里就看不出是权限问题还是批次问题。 */
  canSplit: boolean;
  /** area='pending' 的下发目标（全量工序，INHOUSE + OUTSOURCE 都要）。 */
  processes?: QueueMenuProcess[];
  /** area='pool'（派活）/ 'worker'（转交）的目标工人（当前 tab 的工人列）。 */
  workers?: QueueMenuWorker[];
  /** area='worker' 时**容器自己**的 worker id —— 自己这一列不进「转交给工人」列表
   *  （转交给自己不构成一次移动，与拖拽路径的早退判据一致）。
   *
   *  ⚠️ 它同时是「这条转交能不能成立」的**唯一锚**：`moveBatchBetweenWorkers` 的
   *  `from` 就是它，而那个包装只守 `version`、**对 `fromWorkerId` 零校验**，空串会
   *  原样发出去由后端拒。所以这里取不到（非空串）时**整项不给**，而不是给一个点下去
   *  必然失败的入口。取不到只发生在「切 tab 的过渡窗口」：el-tab-pane 用 `v-show`
   *  常驻，旧 pane 的卡仍可右键，而 `activeTab` 已指向新 tab、其看板缓存里没有这张卡。 */
  selfWorkerId?: string;
  /** 召回到待下发（内含二次确认 + 失效链，见 useQueueRecall.recallBatch）。 */
  onRecall: () => void;
  /** 打开拆批对话框（对话框本身 dumb，失效链由板级在 `done` 上编排）。 */
  onSplit: () => void;
  /** 待下发池 → 指定工序（`dispatchMutation.mutate({ batchIds, targetProcessId })`）。 */
  onDispatch: (targetProcessId: string) => void;
  /** 工序候选池 → 工人（`moveBatchToWorker`，POOL→WORKER）。 */
  onMoveToWorker: (workerId: string) => void;
  /** 工人 → 另一名工人（`moveBatchBetweenWorkers`，WORKER→WORKER）。 */
  onTransfer: (workerId: string) => void;
}

/** 工序目标的菜单文案：`code name`（工序 code 是操作员在现场认工序的主线索，name 补全）。 */
function processLabel(p: QueueMenuProcess): string {
  return `${p.code} ${p.name}`.trim();
}

/** 生产队列三区的菜单项矩阵。
 *
 *  | 区域     | 召回到待下发 | 拆分批次 | 发送到（二级菜单） |
 *  |----------|--------------|----------|--------------------|
 *  | 待下发池 | 不给         | 给      | 各个工序            |
 *  | 工序池   | 给           | 给      | 工人（派活）        |
 *  | 工人列   | 给           | 不给    | 其他工人（转交）    |
 *
 *  「待下发池不给召回」：批次本来就在待下发区，召回等于召回自己，无意义。
 *
 *  「工人列不给拆批」：拆批的用途是「一部分走这条路、一部分走那条路」（部分下发 / 部分
 *  外协），而工人持有的批次只有「整体转交给别人」与「整体召回到待下发」两条出路 ——
 *  拆出来的子批次同样在这名工人手上、同样得立刻转交，拆批在这里没有可执行的下一步。
 *  ⚠️ 这是**产品侧取舍**，不是对齐后端：`split_batch` 端点没有「按批次状态」的闸，
 *  MANAGER 拿一个在工人手上的批次去拆后端也照办。
 *
 *  「拆分批次」的批次闸是 `quantity > 1`：后端要求拆出数量 ∈ [1, quantity - 1]，
 *  余量 ≤ 1 时给选项就是给一个必然失败的入口。 */
export function buildQueueBatchMenuItems(input: QueueBatchMenuInput): MenuItem[] {
  const { area, batch } = input;
  const items: MenuItem[] = [];

  if (area !== 'pending' && input.canRecall) {
    items.push({ label: '召回到待下发', onClick: () => input.onRecall() });
  }

  // 拆批只给待下发池与工序池：工人列的批次拆出来的子批次同样在这名工人手上，没有可执行
  // 的下一步（见函数头的矩阵表）。
  if (area !== 'worker' && input.canSplit && batch.quantity > 1) {
    items.push({ label: '拆分批次', onClick: () => input.onSplit() });
  }

  if (area === 'pending') {
    // 目标过多不自己截断 —— 交给 `showBatchContextMenu` 固定的 maxHeight 让二级菜单滚动。
    const children = (input.processes ?? []).map((p) => ({
      label: processLabel(p),
      onClick: () => input.onDispatch(p.id),
    }));
    // 目标集为空（工序列表还在加载 / 真的一道工序都没有）时**不给**这一项：给一个点开是
    // 空白的二级菜单比不给更难解释。
    if (children.length > 0) {
      items.push({ label: '发送到工序', children });
    }
    return items;
  }

  // 工人列：转交需要一个非空的 `from`（自己所在列），取不到就整项不给 —— 见
  // `selfWorkerId` 的注释。与拖拽路径的差别：拖拽是从 evt.item 的 dataset 反查 worker
  // 属性的，拿不到时 `onAdd` 不落库；这里是从板级看板缓存反查，判据同源。
  if (area === 'worker' && !input.selfWorkerId) return items;

  const targets = (input.workers ?? []).filter(
    (w) => area === 'pool' || w.worker_id !== input.selfWorkerId,
  );
  const children = targets.map((w) => ({
    label: w.name,
    onClick: () =>
      area === 'pool' ? input.onMoveToWorker(w.worker_id) : input.onTransfer(w.worker_id),
  }));
  if (children.length > 0) {
    items.push({
      label: area === 'pool' ? '派给工人' : '转交给工人',
      children,
    });
  }
  return items;
}
