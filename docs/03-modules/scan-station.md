# 工位扫码台

> **目标读者**：前端开发（添加/修改扫码台页面或 HMI 交互）
> **核心价值**：工位机 4 步扫码流程（工牌识别 → 操作选择 → 选件 + 扫码 → 完成确认）；HMI 触摸友好、全屏独立路由树
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、入口与路由

| 路径 | 名称 | 步骤 |
|---|---|---|
| `/scan/badge` | `ScanBadge` | Step 1：工牌识别 |
| `/scan/action` | `ScanAction` | Step 2：操作选择（PICK_UP / RETURN / INSPECT） |
| `/scan/pick` | `ScanPick` | Step 3a：选件领取 |
| `/scan/return` | `ScanReturn` | Step 3b：选件放回 |
| `/scan/inspect` | `ScanInspect` | Step 3c：选件送检 |

路由定义见 `src/router/index.ts`，父级 `/scan` 节点带 `allowRoles: ['SHELF_ACCOUNT']` 短路守卫（**关键**——SHELF_ACCOUNT 默认菜单树不含 `scan_badge`，必须 allowRoles 放行）。整个子树脱离 `MainLayout`，是全屏独立路由树，专为工位机大屏（1080p）设计。

子路由 menuCode 全部填 `scan_badge`（5 个页面共用同一 code）；`/scan` 重定向到 `/scan/badge`。

## 二、关键页面

| 文件 | 职责 |
|---|---|
| `src/views/scan/ScanBadgeGate.vue` | 工牌识别（3.4K）：扫码 / 输入工牌号 → `findWorkerByBadge` → 校验工种 → 写入 `useScanSession` |
| `src/views/scan/ScanActionPicker.vue` | 操作选择（6.5K）：PICK_UP / RETURN / INSPECT 三张大卡片；写入 `useScanSession.action`；多架 SHELF_ACCOUNT 时顶部显示「当前货架」选择器 |
| `src/views/scan/ScanPickParts.vue` | PICK_UP 新流程（24.7K）：点选 + 扫码确认；PICK 后调用 parts/crud pickup-scan |
| `src/views/scan/ScanReturnParts.vue` | RETURN 流程（24.4K）：点选 + 工序 + 货架；调用 return 端点 |
| `src/views/scan/ScanInspectParts.vue` | INSPECT 流程（23.6K）：点选 + 扫码 + 品检货架；通过 `useBulkScanInspect` 批量送检 |

三个选件页（Pick / Return / Inspect）顶部统一显示 `<HeldPartsBadge>`（持有件徽章，跨页面同步）。

## 三、子组件

`src/views/scan/components/` 下 6 个：

| 文件 | 职责 |
|---|---|
| `BatchPickerDialog.vue` | 批次选择弹窗（按状态 / 货架筛选） |
| `QuantityDialog.vue` | 数量输入弹窗 |
| `ShelfPickerDialog.vue` | 货架选择弹窗（基于 `HmiPickerCard kind='shelf'`） |
| `ProcessPickerDialog.vue` | 工序选择弹窗（基于 `HmiPickerCard kind='process'`） |
| `ScrollFabPair.vue` | 悬浮滚动按钮对（FAB） |
| `HeldPartsBadge.vue` | 持有件徽章（顶部条，watch `useScanBus.heldVersion`） |

通用 HMI 触摸友好大卡片见 `src/components/HmiPickerCard.vue`（`kind='process' | 'shelf'`）；旧 `ShelfPickerCard` 已标 deprecated，视觉收口到 `HmiPickerCard`。

## 四、4 步流程

**Step 1：工牌识别**（`ScanBadgeGate`）
扫码或输入工牌号 → 后端校验 → 通过 `useScanSession.setWorker()` 写入模块级 ref → 跳转 `/scan/action`。

**Step 2：操作选择**（`ScanActionPicker`）
PICK_UP / RETURN / INSPECT 三大卡片 → `useScanSession.setAction()` → 跳转对应 `/scan/pick|return|inspect`。多架 SHELF_ACCOUNT 顶部显示「当前货架」选择器（来自 `useActiveShelfSelection`）。

**Step 3a/3b/3c：选件 + 扫码**（三页之一）
点选候选列表 + 扫码确认 → 调后端 API。

**Step 4：完成确认**
- PICK_UP：调 `parts/crud.ts` 的 `pickup-scan` / `pickup`（v1）。
- RETURN：调 return 端点（v1）。
- INSPECT：通过 `useBulkScanInspect`（**v2**）批量送检。

每步完成 / 退出均 `useScanBus.emitHeldChanged()`，触发持有件徽章跨页面同步。

## 五、主要 API 调用

| 端点 | 实例 | 用途 |
|---|---|---|
| `POST /workers/find-by-badge` | `api`（v1） | 工牌识别 |
| `POST /parts/{id}/pickup-scan` | `api`（v1） | 扫码领取（单件） |
| `POST /parts/{id}/pickup` | `api`（v1） | 确认领取（点选） |
| `POST /parts/{id}/return` | `api`（v1） | 放回 |
| `POST /parts/batch-scan-inspect` | `apiV2` | 批量送检（INSPECT 页消费 `useBulkScanInspect`） |
| `GET /shelves` | `api`（v1） | 当前作业货架列表 |
| `GET /parts/by-serial/{serial_no}` | `api`（v1） | 错页时 `findPartBySerialAndPrompt` 提示 |

v1/v2 混合期：PICK_UP / RETURN 走 v1（生命周期在 Rust 主仓尚未实施），INSPECT 已切 v2（共享批量送检端点）。

## 六、相关 composable（5 大模块级）

### `useScanSession` — 跨路由共享 worker + action（关键 singleton）
- 模块级 `worker` ref + `action` ref；`setWorker` / `setAction` / `reset` 三个 mutator。
- 守卫：`requireWorker(router)` / `requireWorkerAndAction(router)` —— worker 或 action 缺失自动 redirect 回对应入口。
- action 类型：`'PICK_UP' | 'RETURN' | 'INSPECT' | 'DELIVER'`（`DELIVER` 仅司机送货台用）；路由 query slug 互转 `pickup|return|inspect|deliver`。

### `useBarcodeScanner` — 全局扫码枪 keydown 监听
- 模块级单例；`window.keydown` listener 只挂一次（HMR 友好）。
- 时间窗：`SCAN_INTERVAL_MS = 30`（两次按键间隔 ≤ 30ms 视为扫码，超过则视作人工输入）。
- 缓冲区：`SCAN_MAX_LENGTH = 50`（超长保护，丢弃）。
- Enter 收尾：识别到完整扫码后 `preventDefault`（避免同时提交表单）+ `dispatch(code)`。
- 跳过 `INPUT` / `TEXTAREA` / `SELECT` / `contentEditable` —— 让用户在搜索框 / 表单里正常打字。
- 订阅者抛错 try/catch，单个页面报错不应让全局监听崩。
- 提供 `onScan(handler)` / `setEnabled(value)` / `clearBuffer()` / `lastScan` / `lastScanAt`。

### `useScanBus` — 跨页面扫码事件总线
- 模块级 `heldVersion: ref(0)` 信号量；任何 PICK_UP / RETURN / INSPECT 状态变更后 `emitHeldChanged()` 自增。
- `onHeldChanged(fn)` 注册回调 + 返回 off 函数；`heldVersion` 是 readonly ref，徽章组件 watch 它。
- 保持轻量信号语义：不在总线放大型 payload。

### `useScanPartsSort` — 报工台三页共享客户端排序
- 排序键（依次）：`is_urgent DESC` → `system_delivery_date IS NOT NULL DESC`（硬优先级）→ 同组内日期 ASC NULLS LAST → 雪花 ID 字符串 DESC（稳定 tie-break）。
- 替代后端 SQL `is_urgent DESC → planned_delivery_date ASC NULLS LAST → id DESC` 硬编码承诺，引入「系统交期」硬优先级：有 `system_delivery_date` 的工件整体提到无 `system_delivery_date` 的工件之前。
- 雪花 ID 字符串降序：单调递增 + 字典序等价于数值序，避免 `Number()` 精度丢失。

### `useActiveShelfSelection` — 当前作业货架
- sessionStorage 持久化（不是 localStorage）—— 跨账号切换会自动失效；key 含 username 防账号互窜。
- 单架 SHELF_ACCOUNT：自动选唯一架，UI 不显示选择器。
- 多架 SHELF_ACCOUNT（≥ 2 架同/异 zone）：不自动选，ScanActionPicker 顶部弹「当前货架」选择器。
- 通配 SHELF_ACCOUNT（未绑任何 active 架）：不显示选择器；PICK 列表跨架、RETURN/INSPECT 后端返回 400 提示配置。

## 七、守卫（router）

| 项 | 值 |
|---|---|
| `allowRoles` | `['SHELF_ACCOUNT']`（短路守卫，**关键**） |
| `requireAuth` | `true` |
| `menuCode` | `scan_badge`（子路由共用） |

`SHELF_ACCOUNT` 默认菜单树不含 `scan_badge`，所以**必须** `allowRoles` 放行，否则前置守卫会把工人挡在扫码台外。

## 八、HMI 触摸优化

- 全屏布局（工位机大屏 1080p），脱离 `MainLayout`。
- 48px 最小点击区（防止工人误操作）。
- `useHoldToScroll(containerRef)` 长按滚动（点位按 → 200ms 后进入长按模式 → raf 持续滚动；`atTop` / `atBottom` 自动隐藏 FAB）。
- 大字体（默认 16px+，操作卡片 18px+）。
- `HmiPickerCard` 视觉规范统一（kind='process' | 'shelf'），48px 网格间距。

## 九、相关 utils

`src/utils/scanHelpers.ts`：

| 函数 | 作用 |
|---|---|
| `findAllByCode(rows, code)` | 按 serial_no \|\| drawing_no 找全部匹配（同一工件多批次） |
| `findBySerialNo(rows, code)` | 仅按 serial_no 严格匹配（送货单 picker 用） |
| `findPartBySerialAndPrompt(code)` | 错页提示：调 `GET /parts/by-serial/{code}`，阻塞弹窗显示当前位置；message 传 **VNode**（不是 plain string，Element Plus 对 plain string 不渲染 `\n` 为换行） |

## 十、权限要求

| 角色 | 权限 |
|---|---|
| `SHELF_ACCOUNT` | 主用户（仓库工人） |
| `MANAGER`（debug 时用） | 可进入扫码台 |

## 十一、后端契约锚链

| 文档 | 路径 |
|---|---|
| 批量送检（含单件 / 批量端点） | `~/Code/hsh-erp-rust/docs/api/parts.md` |
| 扫码送检需求 | `docs/api-requirements/scan-inspect.md` |

## 十二、关键约束与陷阱

- **`allowRoles: ['SHELF_ACCOUNT']` 短路守卫**：删掉这条守卫会立即导致 SHELF_ACCOUNT 进不去扫码台（menuCode 校验失败被降级到菜单树第一个可达 path）。
- **共享 HMI 通配 SHELF_ACCOUNT 处理**：wildcard SHELF_ACCOUNT（未绑任何 active 架）走通配逻辑；PICK 列表跨架；RETURN / INSPECT 后端返回 400 提示配置。
- **雪花 ID 必为 string**：`worker_id` / `shelf_id` / `batch_id` 全部 `string`，`Number()` 会丢精度。
- **扫码事件必须全局共享**：不要在每个页面单独挂 keydown；用 `useBarcodeScanner.onScan(handler)` 订阅，避免多页面重复监听。
- **持有件列表跨页面同步**：状态变更后必须 `useScanBus.emitHeldChanged()`，否则 `HeldPartsBadge` 不刷新。
- **Enter 必须先判断**：`event.key === 'Enter'` 长度是 5，会被 `event.key.length > 1` 过滤掉就废了。

## 十三、未来扩展位

- 多工人协同扫码（同一货架多工人并发）
- 扫码异常自动告警（错页率 / 失败率阈值告警）
- 离线扫码队列（网络抖动时本地累积，恢复后批量提交）
- 工序跳过智能提示（基于历史最优路径推荐 next_process）
