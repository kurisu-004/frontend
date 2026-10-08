// 2026-10-09 新建：外协看板（板级壳与两个投放容器之间）的 provide/inject 契约类型。
//
// 为什么单独一个 types 文件：右键菜单改为**函数模式**（菜单本体在
// `@/composables/useBatchContextMenu.ts`，无组件实例、无 select 事件），板级只在
// 右键那一刻经 opener 派生菜单项并直接开菜单。外协看板的右键动作**需要卡片之外的
// 上下文**：
//   - 「回收生产 / 回收品检」要 `companies[]` 那一列的 company_id（在途卡 DTO 上
//     **没有**公司字段，只挂在列上），缺它组不出 `from.company_id`；
//   - 发送白名单守卫要候选行的 `send_mode` / `company_options` / `can_send`，它们只在
//     左列候选 DTO 上；
//   - 拆批要批次的 `quantity`（卡片 model 上有）与 OCC `version`。
// 故右键落点经 inject 把「这张卡来自哪个区域 + 那侧的行对象」一并发给板级 opener，
// 板级按区域派生菜单项（`buildOutsourceBatchMenuItems`）并分发到不同动作。
//
// `area` 是**容器**给的常量区域标签（`OutsourceBatchArea`），不是从数据反推的：同一张
// 候选卡在两个容器里字段集一模一样，数据侧无从分辨，而两个区域的动作集合不同。
//
// provide 键用字面量字符串（与生产队列域 QueueBoard 的 provide 键同款）：它们不是
// 跨模块的公共契约，两侧都在本目录内。

import type { BatchCardModel } from '@/types/batchCard';
import type { OutsourceBatchArea } from './composables/outsourceBatchMenuItems';
import type {
  OutsourceQueueCandidateData,
  OutsourceQueueHeldBatchData,
} from './composables/outsourceQueueSchema';

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

/** 板级右键 opener 签名。消费方两个投放容器各调一次（第三 / 四参按区域不同）。 */
export type OpenOutsourceBatchMenu = (
  evt: MouseEvent,
  batch: BatchCardModel,
  area: OutsourceBatchArea,
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
 * 这类行 `location IS NULL`，发送请求的 `from.kind=PRODUCTION_SHELF` 必被后端 from
 * 守卫拒收（要求 `batch.location == 'PRODUCTION_SHELF'`）。 */
export function isCandidateDraggable(candidate: OutsourceQueueCandidateData): boolean {
  return candidate.shelf_id !== '';
}

/** 置灰提示文案 —— 同时用于候选池工具条上的 el-tooltip。
 *  收在这里是因为「文案」与「判据」必须同处：改了判据忘了改文案，提示就会与实际
 *  拦截条件脱节。
 *
 *  ⚠️ 文案只说**事实**、不给「去下发」这个出路：零件一览 / 零件详情 / cnc 三处的
 *  「下发」入口已下线，而把批次放上货架的后端端点（`place-on-shelf`）当前**前端零入口**
 *  ⇒ 写「请先下发到生产货架」会让操作员去找一个不存在的按钮。出路要么是后端/产品补
 *  一个上架入口，要么是这类行由别的途径产生；在那之前只如实说「尚未上架」。 */
export const NOT_SHELVED_HINT = '该批次尚未上架，暂时不能发送到外协';

/** 扫码未命中当前 tab 候选时的提示。⚠️ 必须写明「只在当前工序匹配」—— 不写清的话
 *  操作员会把「需要切 tab」误当成状态 / 报价问题，从错误方向排查。 */
export const SCAN_MISS_HINT = '该批次不在当前工序的可发送候选中，请先切到对应工序';

/** 回收对话框的提交载荷。
 *
 *  2026-10-10：只有下一道工序一项 —— 目标货架改由后端按负载自动选；「回收品检」模式
 *  （`kind='INSPECTION_SHELF'` 变体）随该端点一起下线，本载荷只剩一种形态。 */
export interface OutsourceReceiveSubmit {
  /** 回收生产的下一道工序（`to.next_process_id`）。 */
  nextProcessId?: string | null;
}
