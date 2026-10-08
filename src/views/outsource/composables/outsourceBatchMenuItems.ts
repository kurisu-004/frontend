// 2026-10-09 新建：外协两区（可发送候选池 / 外协公司列）的右键菜单项**派生**。
//
// 与生产队列侧同款分层：菜单本体在 `@/composables/useBatchContextMenu.ts`，本文件只
// 产出 `MenuItem[]`。派生矩阵是「区域 × 角色 × 批次状态 × 报价路径」四维，抽成纯函数
// 后逐格单测（见 __tests__/outsourceBatchMenuItems.spec.ts）。
//
// 区域枚举来自共享的 `BatchArea`；板的 provide/inject 契约另在 outsourceBoardTypes.ts。

import type { MenuItem } from '@imengyu/vue3-context-menu';
import type { BatchArea } from '@/composables/useBatchContextMenu';
import type { BatchCardModel } from '@/types/batchCard';
import type { OutsourceQueueCandidateData } from './outsourceQueueSchema';

/** 外协侧的区域枚举（共享 `BatchArea` 的子集 —— 与三个生产队列区域互斥）。 */
export type OutsourceBatchArea = Extract<BatchArea, 'outsource-candidate' | 'outsource-company'>;

/** 「发送到外协公司」的目标项（当前 tab 的 `companies[]` 列）。 */
export interface OutsourceMenuCompany {
  company_id: string;
  name: string;
}

export interface OutsourceBatchMenuInput {
  /** 卡片所在区域 —— 菜单项矩阵的第一维。 */
  area: OutsourceBatchArea;
  /** 被右键的那张卡（只读 `quantity` / `batch_id` / `version`）。 */
  batch: BatchCardModel;
  /** 收发权限（MANAGER + CLERK + INSPECTOR）。只闸「回收生产」。 */
  canMove: boolean;
  /** 拆批权限（MANAGER + CLERK）。Inspector 能收发但**不能**拆批。 */
  canSplit: boolean;
  /** 召回到待下发权限（MANAGER + CLERK）。只闸候选池区。 */
  canRecall: boolean;
  /** area='outsource-candidate'：候选行 DTO —— 发送白名单的五条锚（`send_mode` /
   *  `quote_id` / `outsource_company_id` / `company_options` / `can_send`）都在它上面。 */
  candidate?: OutsourceQueueCandidateData;
  /** area='outsource-candidate'：当前 tab 的公司列。既是目标集的**上游全集**，也是
   *  公司显示名的来源（`company_options` 里的 name 是下拉快照，可能与列名不同步）。 */
  companies?: OutsourceMenuCompany[];
  /** area='outsource-candidate'：该行是否「`PENDING` 未上架」—— 判据就是候选行的
   *  `shelf_id` 为**空串**（见 outsourceBoardTypes.isCandidateDraggable，与拖拽落点的
   *  置灰判据同源）。这种行本来就在待下发区，给召回是召回自己；且 `location` 是 null
   *  而非在某个生产架上，`from.kind=PRODUCTION_SHELF` 守卫必拒，所以「发送到」整块
   *  不给。 */
  candidateIsPending?: boolean;
  /** 发送到指定外协公司（`sendToCompany`，自带报价路径 / 未上架 / 白名单三道早退）。 */
  onSend: (companyId: string) => void;
  /** 召回到待下发（复用生产队列域的 `useQueueRecall`，失效链按前缀全刷，跨域也成立）。 */
  onRecall: () => void;
  /** 打开拆批对话框（对话框本身 dumb，失效链由板级在 `done` 上编排）。 */
  onSplit: () => void;
  /** 从外协公司回收至生产（打开回收对话框，提交走 `receiveToProduction`）。 */
  onReceiveProduction: () => void;
}

/** 该候选行可发送的公司 id 白名单。
 *
 *  两条报价路径的目标公司来源完全不同，不能互相借用（与拖拽落点的
 *  `CompanyColumn.isAllowedTarget` 同款判据，两条路径必须一起改）：
 *   - APPROVAL：目标是**报价锁定**的那家公司（`quote_id` 对应的
 *     `outsource_company_id`），改投别家必被后端拒（20104）；
 *   - DIRECT：目标是 `company_options` 里任一家（该数组就是 DIRECT 的公司下拉源）。
 *
 *  `can_send` 是后端**派生**的可发送判据（APPROVAL，或 DIRECT 且 company_options
 *  非空），false 的行整个不进列表 —— 前端不自己再算一遍派生逻辑。
 *
 *  返回的是**无序交集**：调用方再与当前 tab 的 `companies[]` 求交（只有看板上真的画了
 *  一列的公司才是可点的目标）。 */
export function sendableCompanyIds(candidate: OutsourceQueueCandidateData): string[] {
  if (!candidate.can_send) return [];
  return candidate.send_mode === 'APPROVAL'
    ? candidate.outsource_company_id
      ? [candidate.outsource_company_id]
      : []
    : candidate.company_options.map((o) => o.id);
}

/** 外协两区的菜单项矩阵。
 *
 *  | 区域       | 召回到待下发 | 拆分批次 | 发送到（二级菜单）   |
 *  |------------|--------------|----------|--------------------|
 *  | 候选池     | 给（PENDING 行不给） | 给 | 可发送的外协公司 |
 *  | 公司列     | 不给         | 给      | 不给（见下）      |
 *
 *  「公司列不给召回」：后端状态机白名单里 `OUTSOURCE` 只通 `IN_PROCESS` / `INSPECTION` /
 *  `CANCELLED`；且批次在外协手上时 `t_outsource_shipment` 有一张**开口单**（一个批次
 *  最多一张，由 `uq_t_outsource_shipment_open_batch` 保证），直接召回会让 shipment 与
 *  批次状态脱节。正确出路是「回收生产 / 回收品检」，那条链路会连带收口开口单。
 *
 *  「公司列不给发送到」：在途卡已经在某家外协公司手上，再「发送」是换一个开口单而不是
 *  推进工序 —— 公司列给的是回收两项 + 拆批。
 *
 *  「拆分批次」的批次闸是 `quantity > 1`：后端要求拆出数量 ∈ [1, quantity - 1]，
 *  余量 ≤ 1 时给选项就是给一个必然失败的入口。
 *
 *  另有一条与区域无关的抑制：未上架的候选行**不给**「发送到」（判据见
 *  `candidateIsPending`）—— 与拖拽落点的置灰同源，两条路径必须一起改。 */
export function buildOutsourceBatchMenuItems(input: OutsourceBatchMenuInput): MenuItem[] {
  const { area, batch } = input;
  const items: MenuItem[] = [];

  if (area === 'outsource-company') {
    if (input.canMove) {
      items.push({ label: '回收生产', onClick: () => input.onReceiveProduction() });
    }
    if (input.canSplit && batch.quantity > 1) {
      items.push({ label: '拆分批次', onClick: () => input.onSplit() });
    }
    return items;
  }

  // 候选池区：已经是 PENDING（未上架）的行本来就在待下发区，召回自己无意义。
  if (input.canRecall && !input.candidateIsPending) {
    items.push({ label: '召回到待下发', onClick: () => input.onRecall() });
  }
  if (input.canSplit && batch.quantity > 1) {
    items.push({ label: '拆分批次', onClick: () => input.onSplit() });
  }

  const candidate = input.candidate;
  // 未上架的行**整块不给**（含「发送到」）：`candidateIsPending` 与拖拽路径的置灰判据
  // 同源（`outsourceBoardTypes.isCandidateDraggable`，即 `shelf_id` 为空串）。这种行
  // `location` 是 null，`from.kind=PRODUCTION_SHELF` 守卫必拒 —— 拖拽路径正是
  // 据此置灰 + 给 NOT_SHELVED_HINT，菜单路径必须一起收窄，否则给一个点下去必失败的入口。
  if (candidate && !input.candidateIsPending) {
    // 与当前 tab 的公司列求交：白名单里的公司若没被映射进本工序，看板上根本没有那一列，
    // 给一个点下去发不出请求的目标。
    const allowed = new Set(sendableCompanyIds(candidate));
    const children = (input.companies ?? [])
      .filter((c) => allowed.has(c.company_id))
      .map((c) => ({ label: c.name, onClick: () => input.onSend(c.company_id) }));
    // 目标过多不自己截断 —— 交给 `showBatchContextMenu` 固定的 maxHeight 让二级菜单滚动。
    if (children.length > 0) {
      items.push({ label: '发送到外协公司', children });
    }
  }
  return items;
}
