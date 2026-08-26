# 外协

> **目标读者**：前端开发（添加/修改本域页面）
> **核心价值**：外协公司主数据 + 报价审批流 + 发送/接收流水 + 对账一览，构成完整外协业务闭环
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

外协域是 myERP 中业务流程最长、状态机最丰富的业务域。它把零件的「工艺工序」外包给外协厂，从报价到对账全程留痕。所有数据统一沉淀在 `t_outsource_quote` 事实表上，对账页直接按公司 + 时间窗口聚合；2026-07-29 起移除「已接收历史」tab 后，对账完全承接该职责。

## 一、入口与路由

| Path | Name | menuCode | 守卫 | 备注 |
|---|---|---|---|---|
| `/outsource` | — | — | redirect → `/outsource/companies` | 旧入口重定向 |
| `/outsource/companies` | `OutsourceCompaniesList` | `outsource_companies_list` | requireAuth | 外协厂一览 |
| `/outsource/quotes` | `OutsourceQuoteList` | `outsource_quotes_list` | requireAuth | 报价一览（MANAGER + CLERK） |
| `/outsource/send-receive` | `OutsourceSendReceive` | `outsource_send_receive_list` | requireAuth | 发送 / 接收（合并页，含两个 Tab） |
| `/outsource/send` | — | — | redirect → `/outsource/send-receive?tab=sendable` | 旧路径兼容 |
| `/outsource/receive` | — | — | redirect → `/outsource/send-receive?tab=receiving` | 旧路径兼容 |
| `/outsource/companies/:id/sent-parts` | `OutsourceCompanySentParts` | `outsource_companies_list` | requireAuth | 外协对账（一览入口；不暴露为独立菜单，从公司列表「对账」链接进入） |

全部在 `MainLayout` 子树下，定义于 `src/router/index.ts`。

## 二、关键页面

| 文件 | 职责 |
|---|---|
| `src/views/outsource/OutsourceList.vue` | 外协厂一览：CRUD + 工序映射 + 列可见性 + 状态（启用/停用）筛选；行内「对账」链接跳 `OutsourceCompanySentParts` |
| `src/views/outsource/OutsourceQuoteList.vue` | 报价一览：壳 + `OutsourceQuoteTable` + 3 个 dialog + `OutsourceQuotePdfPreview`；列头 popover 筛选 + 列头排序 + 分页 sizes |
| `src/views/outsource/OutsourceSendReceive.vue` | 发送 / 接收页（壳）：两个 Tab；URL `?tab=sendable\|receiving` 记忆选择 |
| `src/views/outsource/OutsourceSendableTab.vue` | Tab 1「可发送」：列出至少有一条 APPROVED 报价的零件；行内「发送」弹 `OutsourceSendDialog` |
| `src/views/outsource/OutsourceReceivingTab.vue` | Tab 2「待接收」：列出 status=OUTSOURCE 的零件；行内「接收」弹 `OutsourceReceiveDialog` |
| `src/views/outsource/OutsourceCompanySentParts.vue` | 外协对账：按公司聚合 `t_outsource_quote`，单价/总价/发送/回收时间 + 行内编辑（双击改单价/数量/对账标记；Enter 确认 / Esc 取消）+ 合计行 |

### 子组件（`src/views/outsource/components/`）

| 文件 | 职责 |
|---|---|
| `OutsourceQuoteTable.vue` | 报价 el-table：列头 popover + 排序 + 行类名（按状态着色）+ 行内操作按权限禁用 |
| `OutsourceQuoteCreateDialog.vue` | 新建报价：选零件（仅「绑定了外协工序的货架」上的零件，按 `listQuotableParts`） + 工序 + 公司 + 单价/总价；提交后自动跳 list 刷新 |
| `OutsourceQuoteReviewDialog.vue` | 审批 / 拒绝 dialog：仅 MANAGER + SUBMITTED 可触发；批注必填 |
| `OutsourceQuotePdfPreview.vue` | 报价 PDF 预览：调后端生成 PDF（与图纸打印同链路 pdfjs 渲染） |
| `OutsourceSendDialog.vue` | 发送对话框：选外协公司 + 确认发送（基于已批报价） |
| `OutsourceReceiveDialog.vue` | 接收对话框：扫码确认 + 选落点货架 + 下一道工序 |

## 三、主要 API 调用

均走 v1 客户端（`src/api/http.ts` 的 `api`），尚未切 v2。

| 文件 | 关键端点 |
|---|---|
| `src/api/outsource.ts` | 公司 CRUD：`GET /outsource-companies`、`GET/POST /outsource-companies/{id}/...`、`POST /outsource-companies/{id}/processes`（工序映射） |
| `src/api/outsource.ts` | 报价 CRUD：`GET /outsource-quotes`、`POST /outsource-quotes`、`/submit`、`/approve`、`/reject`、`/soft-delete` |
| `src/api/outsource.ts` | 发送侧：`GET /outsource-quotes/approved-for-send`、`GET /outsource-quotes/quotable-parts`（picker 默认筛选） |
| `src/api/outsource.ts` | 对账：`GET /outsource-companies/{id}/sent-parts`（filter: keyword / sent_from / sent_to / received_from / received_to + sort_by）、`POST /outsource-shipments/{shipmentId}/reconcile-update`（行编辑） |
| `src/api/outsource.ts` | 外协中批次：`GET /parts/outsource-in-flight`（跨域；返回 plain list，分页 total 取列表长度） |

## 四、相关 composable / utils

| 文件 | 用途 |
|---|---|
| `src/utils/outsourceQuotePermissions.ts` | 报价权限纯函数（`canCreate` / `canEdit` / `canApprove` / `canReject` / `canWithdraw` / `canSoftDelete`），不依赖 auth session；供 vitest 单测 |
| `src/views/outsource/composables/useOutsourceQuoteTable.ts` | 报价表格状态机（search / sort / popover / 列可见性 / 行类名） |
| `src/views/outsource/composables/useOutsourceQuoteForm.ts` | 报价 form / dialog 状态（create / approve / reject / delete / submit） |
| `src/views/outsource/composables/useOutsourceSendableList.ts` | Tab 1 fetcher |
| `src/views/outsource/composables/useOutsourceReceivingList.ts` | Tab 2 fetcher |

通用 composable 也复用：`useCustomerTree`（客户下拉）、`useColumnVisibility`（列可见性）、`useListStatePersist`（filter / sort 持久化）。

## 五、业务流程与状态机

```
报价（t_outsource_quote.status）
DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED ──send──▶ OUTSOURCING ──receive──▶ RECEIVED ──bill──▶ BILLED
  │                    │                                                                          
  │                    └─reject──▶ REJECTED ──┐                                                    
  │                                         │                                                    
  └────────────────── soft-delete ───────────┘                                                    

对账事实：发送 / 接收 / 单价 / 总价 / 对账标记（reconcile_update 行编辑）
```

**端到端时序**：

1. CLERK 创建报价（DRAFT）→ 提交（SUBMITTED）；
2. MANAGER 审批（APPROVED）或拒绝（REJECTED）；CLERK 可撤回 SUBMITTED 改 DRAFT；
3. 发送：从 APPROVED 报价派生，按零件选外协公司 + 数量 → 调「发送」端点 → 状态 OUTSOURCING；
4. 接收：扫码确认（外协厂回件） → 选落点货架 + 下一道工序 → 状态 RECEIVED；
5. 对账：按公司 + 时间窗口聚合，对账员可双击改单价/数量/对账标记（不修改 `t_outsource_quote`，写对账视图）。

## 六、权限要求

| 操作 | MANAGER | CLERK | 其他 |
|---|---|---|---|
| 外协厂 CRUD | 允许 | 允许 | 只读 / 否 |
| 报价 CRUD | 允许 | 仅 DRAFT 自己 | 只读 |
| 报价 submit / withdraw | 允许 | 允许 | 否 |
| 报价 approve / reject | 允许 | 否 | 否 |
| 发送 / 接收 | 允许 | 允许 | 否 |
| 对账行编辑 | 允许 | 允许 | 否 |

UI 控显隐按 `rolesArrayToMap(user.roles)` 产出的 `RoleLike` + `canXxx()` 组合判定，与 `useAuthSession` 解耦（不直接读 store）。

## 七、后端契约锚链

- `~/Code/hsh-erp-rust/docs/api/outsource.md`（v2 迁移后生效）

## 八、关键约束与陷阱

- **旧路径重定向保留**：`/outsource/send` `/outsource/receive` 通过 `redirect: {path, query: {tab}}` 跳新页 + 自动带 `?tab=`；直链 / 收藏夹均能正确路由。
- **报价 PDF 渲染**走 `src/utils/pdfjs.ts`（带缓存穿透版本串 + CMap 兜底），**不要**直接 `import 'pdfjs-dist'`。
- **对账 Excel 复用**：`historicalPriceExcelParser` 在外协对账导入历史价确认单时复用；解析失败抛错挡住提交（沿用项目 xlsx 0.18.5 已知风险，仅内部只读解析）。
- **`t_outsource_quote` 是统一事实表**：发送 / 接收 / 对账全部从这一张表聚合，不再有冗余 sent_part 表。
- **「已接收历史」tab 已移除**（2026-07-29 PR-H）：该功能完全由 `OutsourceCompanySentParts` 承接；维护旧引用时记得迁移。
- **「外协中批次」返回 plain list**：`/parts/outsource-in-flight` 不带 total，分页 total 取列表长度（这是临时妥协，按需提需求）。

## 九、未来扩展位

### #future-pages

- **报价模板**：把常用零件 + 公司 + 单价组合存为模板，新建报价时一键套用。
- **自动化对账报表**：按月 / 按公司的应收应付汇总 + 自动对账（按对账标记生成应收单）。
- **外协厂评级 / 历史合作统计**：与对外协发送合格率 / 交期达成率挂钩。
- **对接财务系统**：报价审批流接入电子签；BILLED 状态联动开票。
