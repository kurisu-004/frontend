// src/utils/productionPermissions.ts
//
// 生产域（队列 / 批次 / 品检）权限点常量（2026-10-15 新增，RBAC 面板第二批闸门）。
//
// 形态对齐 `src/utils/partsPermissions.ts` 的 `PART_DRAWING_PRINT_PERMISSION`：此处只
// 存放权限点 code 常量，判定一律由消费侧调 `auth.hasPermission(常量)` 完成
// （ADMIN 元角色在 `stores/auth.ts` 的 `hasPermission` 里通配短路）。本文件**不 import
// auth store**，是纯常量表 —— 与 `partsPermissions.ts` 的 helper 形态不同，因为生产域
// 各消费点的入参（批次 / 工序 / 卡片）形态各异，套一层 helper 只是转发。
//
// ⚠️ **每个 code 必须与后端 seeds 逐字一致**（`production.view` / `production.config` /
// `queue.*` / `batch.*` / `inspection.view`）。拼错的表现是「权限配了但入口不出现」且零
// 报错 —— 由 `__tests__/productionPermissions.spec.ts` 逐字锁定防漂移。
//
// ⚠️ **部署顺序：后端必须先上** —— 旧后端的 `/iam/me` 不返这些权限点，闸门对非 ADMIN
// 账号恒为 false；存量会话（localStorage 里已缓存的 user 对象）也要刷新 / 重登后才会
// 拿到带新权限点的 `permissions`。
//
// 读点（`production.view` / `queue.view` / `inspection.view`）由后端权限与菜单共同决定，
// **前端不加按钮闸**；此处列出它们仅为常量表完整（消费方按需 import）。

/** 生产域查看（页面 / 菜单级读点，前端无按钮闸）。 */
export const PRODUCTION_VIEW_PERMISSION = 'production.view';

/** 生产配置（工序映射保存等设置类写操作）。 */
export const PRODUCTION_CONFIG_PERMISSION = 'production.config';

/** 生产队列查看（页面级读点，前端无按钮闸）。 */
export const QUEUE_VIEW_PERMISSION = 'queue.view';

/** 生产队列「发送到工序」（候选池下发 / 自动下发）。 */
export const QUEUE_DISPATCH_PERMISSION = 'queue.dispatch';

/** 生产队列「召回到待下发」。 */
export const QUEUE_RECALL_PERMISSION = 'queue.recall';

/** 生产队列移动（派活 / 撤回候选池 / 工人间转交 / 自动分配）。 */
export const QUEUE_ALLOCATE_PERMISSION = 'queue.allocate';

/** 拆批（`POST /batches/split`）。 */
export const BATCH_SPLIT_PERMISSION = 'batch.split';

/** 批次流转（品检通过 / 指定工序 / 送检 / 强制送检，`POST /prod/batches/{id}/to-*`）。
 *  ⚠️ 强制送检（2026-10-17）**没有**新增权限点：它与普通送检**同端点**
 *  （`to-inspection`）、只是多一个可选入参 `force: true`，故刻意复用本码。 */
export const BATCH_TRANSITION_PERMISSION = 'batch.transition';

/** 批次交付（`POST /prod/batches/{id}/deliver` 等，本批无 UI 闸）。 */
export const BATCH_DELIVER_PERMISSION = 'batch.deliver';

/** 取消批次（`POST /prod/batches/{id}/cancel`）。 */
export const BATCH_CANCEL_PERMISSION = 'batch.cancel';

/** 返修下发（`POST /prod/batches/{id}/repair-dispatch`）。 */
export const BATCH_REPAIR_PERMISSION = 'batch.repair';

/** 待品检查看（页面级读点，前端无按钮闸）。 */
export const INSPECTION_VIEW_PERMISSION = 'inspection.view';
