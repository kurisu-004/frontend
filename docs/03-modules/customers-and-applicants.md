# 客户 / 申请人

> **目标读者**：前端开发（添加/修改本域页面）
> **核心价值**：两级客户树（L1 + L2）+ 申请人主数据，零件 / 订单 / 外协报价 / 投标导入的共同前置
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

客户与申请人构成 myERP 的「客户管理」菜单组。客户是订单的归属方，**两级结构**（L1 集团 + L2 分厂）配 `serial_prefix`（A-Z 单字符，订单号前缀）；申请人挂在 L1 根下，被零件 dialog、投标 Excel 导入、外协报价的「申请人」自动补全共同消费。本域代码量不大，但被订单 / 外协 / 大屏间接引用频次极高。

## 一、入口与路由

| Path | Name | menuCode | 守卫 | 备注 |
|---|---|---|---|---|
| `/customers` | `CustomerList` | `customers_list` | requireAuth | 侧栏客户管理 → 客户一览 |
| `/applicants` | `ApplicantList` | `applicants_list` | requireAuth | 侧栏客户管理 → 申请人一览 |

两路由均在 `MainLayout` 子树之下，路由定义在 `src/router/index.ts`。`menuCode` 与后端菜单表 `t_menu.code` 对齐——前置守卫 `allowByMenuCode`（DFS 在 `user.menus` 中查 code）即单一权限源，不通过的访问会被降级到菜单树首个可达 path。

## 二、关键页面

| 文件 | 职责 |
|---|---|
| `src/views/customers/CustomerList.vue` | 客户树（L1 + L2 两级），el-tree + 节点 hover 操作（+ / 编辑 / 删除），新增根/叶弹窗含 `serial_prefix` 输入（L1 必填、L2 禁用继承父） |
| `src/views/applicants/ApplicantList.vue` | 申请人平铺表格，按所属一级客户 + 姓名模糊筛选；新增/编辑 dialog 强制选 L1 根（不允许挂到 L2） |

## 三、主要 API 调用

均走 v1 客户端（`src/api/http.ts` 的 `api` 实例，baseURL `/api/v1`），尚未切 v2。

| 文件 | 关键端点 | 实例 | 后端契约 |
|---|---|---|---|
| `src/api/customer.ts` | `GET /customers`、`GET /customers/{id}`、`POST /customers`、`POST /customers/{id}/update`、`POST /customers/{id}/soft-delete` | `api` (v1) | 待迁移 v2 |
| `src/api/applicant.ts` | `GET /applicants`、`GET /applicants/search`、`POST /applicants/bulk-get-or-create`、`GET/POST/applicants/{id}/...` | `api` (v1) | 待迁移 v2 |

`bulkGetOrCreateApplicants(items)` 是本域唯一复合端点：传入 `{name, customer_id}[]`，后端按 `(name, l1_root_id)` 幂等去重，返回 `{name, customer_id, applicant_id}[]`。投标 Excel 导入流程依赖它一次性建好缺失申请人，避免前端循环 `createApplicant` 的 race。

## 四、权限要求

| 操作 | MANAGER | CLERK | INSPECTOR | SHELF_ACCOUNT |
|---|---|---|---|---|
| 客户增/改 | 允许 | 允许 | 只读 | 只读 |
| 客户软删 | 允许 | 允许 | 否 | 否 |
| 申请人增/改 | 允许 | 允许 | 只读 | 只读 |
| 申请人软删 | 允许 | 允许 | 否 | 否 |

权限由两层叠加：
- **路由级**：`menuCode` 守卫决定能否进入页面；
- **UI 级**：el-button / el-form-item 用 `v-if="canEdit"` 控显隐，`canEdit` 由当前用户角色组合（MANAGER ∪ CLERK 即 true）计算。

## 五、相关 composable / utils

| 文件 | 用途 |
|---|---|
| `src/composables/useCustomerTree.ts` | 客户级联树一次性加载（onMounted 拉全量），产出 `tree: CascaderNode[]` + `resolveRootCustomerId(pickedId)`（任选叶子 → 解析到所属 L1 根 id） |
| `src/composables/useApplicantSearch.ts` | 申请人 autocomplete：只在切换客户时拉一次全集（limit=200），客户端子串过滤；缓存命中同客户不重拉 |

这两个 composable 是**跨域** 复用：除本域页面外，`PartBatchNew` 的两个 Tab、装配件创建、外协报价表单的「申请人」自动补全都消费它们。

## 六、客户树结构

两级，物理约束如下：

- **L1 客户**（`parent_id IS NULL`）：必须填 `serial_prefix`（A-Z 单字符，全局唯一）；订单号 `<prefix>-<date>-<seq>` 的前缀即由此决定；展示时根节点名前挂 el-tag 显示当前字母。
- **L2 客户**（`parent_id = <L1.id>`）：`serial_prefix` 字段恒 null，永远继承父；不允许再下挂孙节点（前端 el-tree 仅两层，后端也会拒）。
- **删除约束**：后端检查下级客户 + 关联申请人 + 关联零件 / 装配体，任意被引用即拒绝软删（前端按钮 hover 提示引用计数）。
- **导入流程**：投标 Excel 导入 (`PartBidImport`) 走「按一级部门名解析到 L2」；缺失分厂的行标红挡住提交；最终缺失的申请人通过 `bulkGetOrCreateApplicants` 幂等补建。

## 七、后端契约锚链

- `~/Code/hsh-erp-rust/docs/api/customers.md`（v2 迁移后生效）
- `~/Code/hsh-erp-rust/docs/api/applicants.md`（v2 迁移后生效）

## 八、关键约束与陷阱

- **雪花 ID 全程 string**：`Customer.id` / `Applicant.id` 在前端永远是字符串，不可 `Number()`（雪花 ID 超 2^53，精度会丢）。
- **serial_prefix 唯一**：L1 改字母时后端会校验与其他 L1 不冲突，前端不必二次校验，但建议在 dialog 关闭前调 `listCustomers()` 做客户端去重提示。
- **客户对账视图锚链**：每个 L1 客户详情可链接到「外协对账」（`OutsourceCompanySentParts`），是关联域跨域跳转的入口点之一。
- **批量 get-or-create 幂等性**：`bulkGetOrCreateApplicants` 按 `(name, l1_root_id)` 去重；同名申请人在不同 L1 下视为不同记录。
- **`useCustomerTree` 模块级缓存**：多个 dialog 同时挂载同一棵树时共享同一份响应数据；客户变更后必须调 `load()` 主动刷新。

## 九、未来扩展位

### #future-pages

- **N 级客户层级**：当前两级硬编码于前端 tree + 后端 schema；如需支持集团 → 公司 → 分厂 → 车间四级，需重构 schema + `useCustomerTree` 的 DFS 拼树逻辑。
- **客户合并工具**：当一个 L2 客户被错拆为多条时，需要「合并到目标客户并迁移关联」工具；后端迁移脚本 + 前端向导页。
- **申请人别名 / 多联系方式**：当前 Applicant 仅 `name` + `customer_id`；可扩展 phone / email / 部门字段。
- **客户黑名单 / 信用额度**：与外协对账联动。
