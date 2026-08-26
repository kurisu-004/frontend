# 零件 / 订单

> **目标读者**：前端开发（添加/修改本域页面）
> **核心价值**：零件 CRUD + 批量新建 + 投标 Excel 导入 + 装配件合并 + 状态机驱动 — myERP 最复杂、最大的业务域
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

零件域是整个 myERP 的中心。零件从下单到出库完整状态机贯穿本域 + 品检 + 送货 + 外协 + 货架 + 工人花名册等所有关联域。装配件（assembly）作为零件的特殊形态，2026-07-30 起合并到本域（`/assemblies` 重定向到 `/parts`），共享同一套 CRUD + 状态机。代码量上，本域含 5 个主页面 + 12 个子组件 + 12 个页级 composable + 4 个 API 子文件，是前端改造/重构重点。

## 一、入口与路由

| Path | Name | menuCode | 守卫 | 备注 |
|---|---|---|---|---|
| `/parts` | `PartsList` | `parts_list` | requireAuth | 零件一览（含装配件，rowType 过滤） |
| `/parts/new` | `PartsNew` | `parts_new` | requireAuth | 批量新建（双 Tab：手动录入 / PDF 批量上传） |
| `/parts/:id` | `PartsDetail` | — | requireAuth | 零件详情（共享 menuCode 校验沿父路由；id 雪花字符串） |
| `/parts/import/bid` | — | — | requireAuth | 投标 Excel 导入（旧 `/parts/new/bid-import` 兼容路径） |
| `/assemblies` | — | — | redirect → `/parts` | 装配件一览退役 |
| `/assemblies/:id` | `AssemblyDetail` | — | requireAuth | 装配件详情（独立路由壳，UI 走装配视图） |

全部在 `MainLayout` 子树下，定义于 `src/router/index.ts`。

## 二、关键页面

| 文件 | 大小 | 职责 |
|---|---|---|
| `src/views/parts/PartsList.vue` | 12.8K | 零件一览装配壳：filter-card + `PartsTable` + `PartsBatchBar` + 分页 + 4 个下发 dialog + 隐藏 iframe（批量打印预览）；`canEdit` 决定下发/导入按钮可见性 |
| `src/views/parts/PartBatchNew.vue` | 3.9K | 批量新建壳：el-tabs 挂载「录入」+「PDF 批量上传」两个 Tab 组件；成功后两 Tab 都跳 `/parts?status=PENDING` |
| `src/views/parts/PartDetail.vue` | 24.8K | 零件详情壳：9 张卡（7 子组件 + 3 个 FileListCard）+ 底部操作栏（品检通过 / 指定工序 / 外协回收 / 取消订单 / 删除）；dialog 状态由 shell 局部维护 |
| `src/views/parts/PartBidImport.vue` | 25.8K | 投标 Excel 导入：选 L1 客户 + 请购日期 + 上传 .xlsx → 解析 → 预览（每行按部门名解析到 L2 + 可手挂 PDF） → 提交（dedupe 申请人 → bulkGetOrCreate → batchCreateParts multipart） → 跳 `/parts?status=PENDING` |
| `src/views/assemblies/AssemblyDetail.vue` | 6.7K | 装配件详情壳：`AssemblyInfoCard` + `AssemblyChildrenTable` + 总装 PDF + 编辑对话框；调 `useAssemblyDetail` composable |

### 子组件（`src/views/parts/components/`）

| 文件 | 职责 |
|---|---|
| `PartInfoCard.vue` | 信息卡 + 行内编辑（editing 切换；form 由 usePartDetail 持有） |
| `PartHistoryCard.vue` | 历史事件卡（事件列表 + 标签映射） |
| `PartCncCard.vue` | CNC 文件卡（G 代码 / 设定单上传下载，list/upload/delete 走 `api/cnc.ts`） |
| `PartQuoteCard.vue` | 报价卡（外协报价关联） |
| `PartDeliveryNoteLinkCard.vue` | 送货单关联卡（仅 `part.delivery_note_id != null` 时显示） |
| `PartAssemblyLinkCard.vue` | 装配件关联卡（仅 `part.assembly_id != null` 时显示） |
| `PartBatchMonitorCard.vue` | 批次监控卡（批次列表 + 拆分 / 取消批次） |
| `PartBatchManualTab.vue` | 批量新建 Tab 1「录入」：Dialog 入队 → 提交 N 条 |
| `PartBatchPdfTab.vue` | 批量新建 Tab 2「PDF 批量上传」：拖 PDF + 可选 Excel + 可选 3D 模型 → 单页独立零件 / 多页装配件 |
| `PartsTable.vue` | 零件一览纯 el-table：列定义 / 行内编辑 / 批量选中 / 表头 popover；懒加载树（`has_children` / `children`） |
| `PartsBatchBar.vue` | 批量操作栏（批量下发 / 批量品检通过 / 批量打印） |
| `PartsDispatchDialog.vue` | 单件下发对话框（选目标 PRODUCTION 货架 + 下一道工序） |
| `PartsBatchDispatchDialog.vue` | 批量下发对话框 |
| `PurchaseOrderImportDialog.vue` | 采购订单 Excel 导入对话框（解析系统交期 + 订单号） |

## 三、主要 API 调用

`src/api/parts.ts` 是兼容 shim（`export * from './parts'`），实际代码在 `src/api/parts/` 子目录：

| 文件 | 职责 | v1 / v2 |
|---|---|---|
| `src/api/parts/index.ts` | 聚合 4 子文件 re-export | — |
| `src/api/parts/crud.ts` | 单件 CRUD + 全生命周期（创建 / 更新 / 上下架 / 扫码 / 品检 / 外协送收 / 返修 / 完成 / 取消 / 释放编程 / failInspection 等） | `scanInspect` 单件 2026-08-25 切 v2 |
| `src/api/parts/batch.ts` | 批量新建 + PDF 树形批量 + 批次 CRUD + `listInspectionBatches` + `batchPassInspection` + `batchScanInspect` | `batchPassInspection` / `batchScanInspect` 2026-08-25 切 v2 |
| `src/api/parts/bid.ts` | 应标 Excel 解析后批量匹配 + 回填订单号 / 系统交期 | v1 |
| `src/api/parts/file.ts` | 图纸双面打印 PDF 生成（单件 `/print-drawing` + 批量合并 `/print-drawing-batch`） | v1 |
| `src/api/assembly.ts` | 装配件 CRUD（已合并到本域，老路由保留兼容） | v1 |

## 四、相关 composable / utils

**通用 composable**（在 `src/composables/`）：

| 文件 | 用途 |
|---|---|
| `usePartLocationTree` | 零件「所在位置」5 大类（OFFICE / PRODUCTION_SHELF / WORKER / INSPECTION_SHELF / OUTSOURCE_COMPANY）+ holder 叶子树；模块级 Promise 缓存 + `splitLocationSelection` 把 el-tree-select 多选值拆成后端 `locations` + `holder_ids` |
| `useBulkPassInspection` | 批量品检通过 v2 端点封装；单次 round-trip，`{passed, failed}` 部分失败语义；保留 `BulkPassItem[]` 契约（弹窗依赖） |
| `useBulkScanInspect` | 批量一键送检 v2 端点封装；与 `useBulkPassInspection` 形态对称；主要消费方：扫码建单弹窗 `BatchSubmitInspectionConfirmDialog` |
| `useListFilterPersist` | 列表 filter / sort / pageSize 持久化（`useListStatePersist` / `usePartsColumnFilters` 共用底层） |

**页级 composable**（在 `src/views/parts/composables/`）：

| 文件 | 用途 |
|---|---|
| `usePartDetail` | 详情页业务状态：fetchPart / editing / saving / 取消订单 / 删除 / 品检通过 / 指定工序 / 外协回收 / 批次拆分取消 |
| `usePartFiles` | 详情页文件列表 / 上传 / 删除 |
| `usePartCncGroups` | 详情页 CNC 文件分组（G 代码 / 设定单） |
| `usePartQuote` | 详情页报价关联 |
| `usePartsListQuery` | 列表查询状态机（search / items / total / loading / sort / page）；URL `?status=` 注入或 localStorage 恢复 |
| `usePartsColumnFilters` | 列头 popover 筛选（多列并发 + draft 同步） |
| `usePartInlineEdit` | 行内编辑（form / saving / 提交 / 取消） |
| `usePartDispatch` | 单件 / 批量下发对话框状态 |
| `useBatchPrint` | 批量打印（隐藏 iframe + 合并 PDF Blob） |
| `usePartBatchSelection` | 列表多选状态 |
| `usePartBatchManual` | 批量新建 Tab 1 状态 + handler |
| `usePartBatchPdf` | 批量新建 Tab 2 状态 + handler（PDF 解析 + 树形提交） |
| `usePartBatchShared` | 两 Tab 纯工具函数 |
| `partsListCtx` | 列表 context（共享 parts / selection / columnVisibility） |

## 五、业务流程与状态机

```
DRAFT ──submit──▶ QUOTING ──quote──▶ QUOTED ──confirm──▶ PENDING
                                                    │
                                                    ├──▶ IN_PRODUCTION ──inspect──▶ INSPECTION
                                                    │                                    │
                                                    │                                    ├── pass ──▶ READY_TO_SHIP ──deliver──▶ COMPLETED
                                                    │                                    │
                                                    │                                    └── fail ──▶ IN_PROCESS (回流)
                                                    │
                                                    └──▶ OUTSOURCE ──receive──▶ INSPECTION（同上）

PROGRAMMING（CNC 子态）：IN_PRODUCTION 之前可能有 PROGRAMMING 中间态（CNC 待编程）
REPAIRING（返修子态）：INSPECTION 触发打回或返修接收标记
```

**批量新建双 Tab**：

- Tab 1「录入」：点空白区 / 「+ 添加零件」 → 弹 Dialog 填一条 → 入队 → 提交 N 条 → `POST /api/v1/parts/batch`（multipart `data` + `files[]`，按下标对齐）。
- Tab 2「PDF 批量上传」：拖 PDF + 可选 Excel + 可选 3D 模型 → 按文件名解析图号 → 单页直接进独立零件 / 多页走源文件区选页合并 → 提交 `POST /api/v1/parts/batch-with-pdfs`（10min 超时，量大）。

**投标导入**：解析 Excel（`bidExcelParser` 纯函数，致命错抛） → 预览（每行按部门名解析到 L2） → 提交（先 `bulkGetOrCreateApplicants` 幂等建缺失申请人，再 `batchCreateParts`） → 跳 `/parts?status=PENDING`。

## 六、权限要求

| 操作 | MANAGER | CLERK | INSPECTOR | SHELF_ACCOUNT | CNC_PROGRAMMER |
|---|---|---|---|---|---|
| `/parts` 列表 | 允许 | 允许 | 允许（按列过滤） | 通过扫码台间接 | 否 |
| `/parts/new` 批量新建 | 允许 | 允许 | 否 | 否 | 否 |
| 详情行内编辑 | 允许 | 允许 | 只读 | 只读 | 只读 |
| 批量 PDF 上传 | 允许 | 允许 | 否 | 否 | 否 |
| 投标 Excel 导入 | 允许 | 允许 | 否 | 否 | 否 |
| 品检通过 | 是 | 否 | 是 | 否 | 否 |
| 取消 / 删除 | 允许 | 允许 | 否 | 否 | 否 |

权限两层叠加：
- **路由级**：`menuCode` 守卫；
- **UI 级**：`canEdit` / `canManageDrawings` / `canEditPart` 等 computed 控制按钮 / 表单禁用。

## 七、后端契约锚链

- `~/Code/hsh-erp-rust/docs/api/parts.md`（**当前 v2 端点：单件 + 批量 scanInspect + 单件 + 批量 batchPassInspection**，详见 docs 文件头部表格）

其余 CRUD / 装配 / 投标 / 批次等仍走 v1；迁移节奏按 `docs/03-modules/README.md` 的进度表跟踪。

## 八、关键约束与陷阱

- **批量 PDF 上传触发 nginx `client_max_body_size 300m`**：单批超过会 nginx 直接 413；前端无解，必须分批。`batchCreatePartsWithPdfs` 单点延长到 10min。
- **雪花 ID 字符串**：`part_id` / `shelf_id` / `process_id` / `customer_id` 全程 string，`Number()` 会丢精度（CLAUDE.md §3）。
- **零件 ↔ 装配件 1:N 关系**：装配件已合并到本域；`part.assembly_id != null` 时显示装配件关联卡；装配件详情页 `AssemblyChildrenTable` 列子件。
- **大文件 list 性能**：`is_active` / 库存预警列加索引（后端）；前端 `usePartsColumnFilters` + `useListFilterPersist` 持久化筛选避免重复 fetch。
- **`auto-imports.d.ts` 不影响 API 名称**：unplugin-auto-import 只扫模板中的 el-* 组件；API 调用都是显式 import，与自动导入无关。
- **xlsx 解析风险**：依赖 `xlsx@0.18.5`（已知原型污染 + ReDoS 高危漏洞，npm 仓库无修复版）；仅做内部只读解析（4 个 parser 工具函数 + 3 个视图收口），攻击面可控；后续可能迁移到 SheetJS CDN 版或 exceljs（见 CLAUDE.md §08）。
- **批量品检部分失败语义**：`batchPassInspection` / `batchScanInspect` 走 v2 端点，per-item 失败走响应 `data.failed[]`；前端必须按 part_id 对齐弹「部分失败」二次确认或继续后续动作。
- **行内编辑与持久化**：`usePartInlineEdit` 改 `form` 不直接调 API，需 `usePartDetail.onSave` 统一提交；与版本号（`version`）配合避免并发覆盖。

## 九、未来扩展位

### #future-pages

- **零件模板（一键新建同类）**：把常用 drawing_no / 工序 / 客户组合存为模板，新建时一键套用（避免重复填表）。
- **图纸版本管理**：当前图纸上传覆盖旧文件，无版本号；可扩展为 part_files 表加 `version` 字段 + 历史回溯。
- **跨车间调度**：当前仅支持单一车间货架绑定；扩展后可按工序动态派发到不同车间的货架。
- **批量打印模板自定义**：目前仅「图纸双面打印 + 右下角条形码」一种模板；可扩展为可配置模板（指定附加字段 + 二维码位置）。
- **订单交付周期预测**：基于历史数据 + 当前队列，给出预计完成时间。
