// 2026-10-09 新建：外协看板（板级壳与两个投放容器之间）的 provide/inject 契约类型。
//
// 为什么单独一个 types 文件：`BatchContextMenu` 的 `select` 事件只派发
// `(key, batch)` —— 卡片自带的 batch_id / version 两个字段。而外协看板的右键动作
// **需要更多上下文**：
//   - 「回收生产 / 回收品检」要 `companies[]` 那一列的 company_id（在途卡 DTO 上
//     **没有**公司字段，只挂在列上），缺它组不出 `from.company_id`；
//   - 白名单守卫要候选行的 `send_mode` / `company_options` / `can_send`，它们只在
//     左列候选 DTO 上；
//   - 拆批要批次的 `quantity`（卡片 model 上有）与 OCC `version`。
// 故右键落点经 inject 把「这张卡来自哪个容器 + 那侧的行对象」一并发给板级 opener，
// 板级按容器渲染不同的菜单项并分发到不同动作。
//
// provide 键用字面量字符串（与生产队列域 QueueBoard 的 provide 键同款）：它们不是
// 跨模块的公共契约，两侧都在本目录内。

import type { BatchCardModel } from '@/types/batchCard';
import type {
  OutsourceQueueCandidateData,
  OutsourceQueueHeldBatchData,
} from './composables/outsourceQueueSchema';

/** 右键菜单项 key。与后端动作名对齐便于对账，分发方是板级的 `onCtxMenuSelect`。 */
export type OutsourceBatchMenuKey = 'receive-production' | 'receive-inspection' | 'split';

/** 左列「可发送候选池」卡片的上下文。 */
export interface OutsourceCandidateCardContext {
  kind: 'candidate';
  /** 候选行 DTO（发送守卫的五条锚全在这里）。 */
  candidate: OutsourceQueueCandidateData;
  /** 外协工序名 —— 候选 DTO 上没有该字段，由 tab body 从响应根 `process` 取。 */
  processName: string;
}

/** 右列「外协公司列」卡片的上下文。 */
export interface OutsourceHeldCardContext {
  kind: 'held';
  /** 在途卡 DTO（回收的 OCC 锚与接收可免填性在这里）。 */
  held: OutsourceQueueHeldBatchData;
  /** 所在外协公司 id —— 回收请求 `from.company_id` 的唯一来源。 */
  companyId: string;
  companyName: string;
}

export type OutsourceBatchCardContext = OutsourceCandidateCardContext | OutsourceHeldCardContext;

/** 板级右键 opener 签名。消费方两个投放容器各调一次（第二参 / 第三参不同）。 */
export type OpenOutsourceBatchMenu = (
  evt: MouseEvent,
  batch: BatchCardModel,
  ctx: OutsourceBatchCardContext,
) => void;

/** provide 键：右键菜单 opener。 */
export const OPEN_OUTSOURCE_BATCH_MENU = 'openOutsourceBatchMenu';
/** provide 键：发送写操作包装（`useOutsourceQueueMove().sendToCompany`）。 */
export const SEND_TO_COMPANY = 'sendToCompany';
/** provide 键：当前激活的外协工序 id（ComputedRef<string>）—— 扫码选中的作用域闸门。 */
export const ACTIVE_OUTSOURCE_PROCESS_ID = 'activeOutsourceProcessId';

/** 候选行是否可拖 / 可选。
 *
 * 判据只有 `shelf_id` 非空（**空串**是「`PENDING` 且未上架」的真实形态，不是 null）：
 * 这类行没有 holder，发送请求的 `from.shelf_id` 必被后端 `from` 守卫拒收。 */
export function isCandidateDraggable(candidate: OutsourceQueueCandidateData): boolean {
  return candidate.shelf_id !== '';
}

/** 置灰提示文案 —— 同时用于候选池工具条上的 el-tooltip。
 *  收在这里是因为「文案」与「判据」必须同处：改了判据忘了改文案，提示就会与实际
 *  拦截条件脱节。 */
export const NOT_SHELVED_HINT = '该批次尚未上架，请先下发到生产货架';

/** 扫码未命中当前 tab 候选时的提示。⚠️ 必须写明「只在当前工序匹配」—— 不写清的话
 *  操作员会把「需要切 tab」误当成状态 / 报价问题，从错误方向排查。 */
export const SCAN_MISS_HINT = '该批次不在当前工序的可发送候选中，请先切到对应工序';

/** 回收对话框的两种模式。 */
export type OutsourceReceiveMode = 'production' | 'inspection';

/** 回收对话框的提交载荷。`nextProcessId` 只在回收生产时有值（品检流转不带工序）。 */
export interface OutsourceReceiveSubmit {
  /** 目标货架 id（`to.shelf_id`）。 */
  toShelfId: string;
  /** 回收生产的下一道工序（`to.next_process_id`）；品检模式恒 null。 */
  nextProcessId?: string | null;
}

/** 拆分对话框的被拆目标（由右键卡片带进来的最小信息）。 */
export interface OutsourceSplitTarget {
  batch_id: string;
  /** `t_part_batch.version` —— `POST /batches/split` 必填的 OCC 锚（缺它返 422 纯文本）。 */
  version: number;
  /** 当前余量，决定拆出数量的 `:max = quantity - 1`。 */
  quantity: number;
  /** 展示用（卡片 model 已带 'B' 前缀）。 */
  batch_no: string;
  part_name: string;
}