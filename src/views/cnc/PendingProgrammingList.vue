<!--
  PendingProgrammingList.vue — 待编程一览（chain 含 CNC 工序的零件）

  业务背景（2026-07-14 / 2026-07-20 / 2026-09-29 / 2026-10-01）
  ====================
  - 菜单侧：CNC 编程员专属入口；侧栏挂「待编程」（production_group children，
    2026-09-29 由顶级菜单迁入 + title 精简）。
  - 数据侧：2026-10-01 起调 prod 域 `GET /api/v2/prod/programming/pending`
    （api/programming.ts::fetchPendingProgramming），传 has_cnc_program 区分
    待编程（false）/ 已编程（true）。旧 part 域 `GET /parts/pending-programming`
    恒返空，前端 wrapper（listPendingProgramming）同期删除。
  - 两个 Tab：待编程（chain 有 CNC 但未上传 G 代码） / 已编程（G 代码已上传）。
    默认待编程；activeTab 持久化到 localStorage。
  - 三个动作：
    * 「详情」 → 跳 /parts/{id}（PartDetail 页内有图纸下载 / G 代码上传 / 设定单上传）
    * 「下发到生产」 → 弹 el-dialog 同时选下一道工序 + 目标 PRODUCTION 货架，
      调 POST /api/v2/prod/batches/{batch_id}/release-from-programming
      （PROGRAMMING → IN_PROCESS；2026-10-02 由 part 域迁 prod 域并改为批次锚定，
      批次 id + OCC 版本取列表项的 batch_id / batch_version）。
      仅历史 PROGRAMMING 状态、且有 PROGRAMMING 活跃批次的行可见下发按钮；新流程下
      chain 有 CNC 但 part.status ≠ PROGRAMMING 的零件不展示下发按钮（无 API 可调）。
  - 加急行整行红底 #fde2e2（与 PartsList / InspectionPending 同款）。
  - 自动刷新（5min）按需勾选。

  2026-10-01 架构改造：脱 ListShell + 手写 fetcher，全量走 TanStack Query
  ====================
  - 状态 / 查询 / 写操作 / 列可见性 / 下发对话框态全部下沉到 Pinia setup store
    `usePendingProgrammingStore`（views/cnc/composables/usePendingProgrammingStore.ts），
    本文件只做「渲染壳」：Tab + filter 卡 + 表格 + 分页 + 下发对话框 UI。
    消费侧一律 store.query.xxx / store.release.xxx（禁止解构，见 store 不变量 #3）。
  - **不再用 `<ListShell>`**：ListShell 的分页 / 页大小由内部 PagedTable 自持
    （src/components/ListShell.vue:89），与 TanStack Query 的 reactive params
    （page / pageSize 参与 queryKey）会形成**第二个分页状态源** —— 与
    2026-08-31 修掉的「双实例撕裂」bug（ListShell 实例 A / PagedTable 实例 B
    更新不同 ref，表格空但「共 N 条」正确）同构。故 filter 卡 / 表格 / 分页
    全部自建，列渲染模板块照抄 ListShell.vue:107-152（属性一行不减）。
  - 删掉手动 setInterval 自动刷新定时器（改由 useQuery refetchInterval 承担，
    且显式 refetchIntervalInBackground: true 保持后台轮询语义）。
  - 2026-10-01 review 第 1 轮 I-1：搜索框拆「输入态 / 生效态」。filter 卡的
    el-input v-model 绑 store.query.searchInput（打字 0 请求），@keyup.enter /
    @clear 调 store.query.onSearch() 才提交进生效态并把页码归 1 —— 与 2026-09-29
    之前「只在 Enter / 清空 / 刷新时发请求」的行为一致。直接绑生效态会让每个字符
    换一个 queryKey（每字一次 GET），且打字途中不重置页码。
  - 持久化 key 全部沿用老值（`pending_programming_filter` 筛选项 /
    `pending_programming` 列可见性与列顺序），老用户已配好的列不丢。持久化的只有
    **生效态**（deps 不含 searchInput，否则老快照会被 restore() 的「每个 key 都
    必须存在」校验整份判废），restoreState() 再把生效态同步回输入态。
-->
<template>
  <div class="pending-programming">
    <!-- 2026-09-29 新增：Tab 化 —— 待编程 / 已编程 通过 activeTab + has_cnc_program 区分 -->
    <div class="tabs-wrap">
      <el-tabs v-model="store.query.activeTab" @tab-change="store.query.onTabChange">
        <el-tab-pane name="pending" label="待编程" />
        <el-tab-pane name="programmed" label="已编程" />
      </el-tabs>
    </div>

    <!--
      2026-10-01：filter 卡自建（脱 ListShell）—— 样式与 ListShell.filter-card 同款。
      v-model 绑 **searchInput（输入态）** 而非 search（生效态）：打字只改输入态，
      0 请求；@keyup.enter / @clear 调 onSearch() 才把输入态提交进生效态并把页码归 1
      （review 第 1 轮 I-1）。「刷新」按钮走 fetchList() = refetch 当前生效态，
      同样不会把没提交的半截字带进请求。
    -->
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <el-input
          v-model="store.query.searchInput.keyword"
          placeholder="图号 / 名称（前缀搜索）"
          clearable
          style="width: 260px"
          @keyup.enter="store.query.onSearch"
          @clear="store.query.onSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <el-input
          v-model="store.query.searchInput.serialNo"
          placeholder="序列号"
          clearable
          style="width: 180px"
          @keyup.enter="store.query.onSearch"
          @clear="store.query.onSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <el-checkbox v-model="store.query.autoRefresh">自动刷新（5min）</el-checkbox>

        <el-button @click="store.query.fetchList()">
          <el-icon><RefreshLeft /></el-icon>
          <span>刷新</span>
        </el-button>
        <span v-if="store.query.total > 0" class="total-hint">共 {{ store.query.total }} 条</span>
        <!--
          2026-10-01 review 第 1 轮 M-6：补回旧 ListShell.vue:68-70 的空态 tag
          （脱壳时漏了）。emptyText 优先透传后端错误信息（store 内
          errorMsg ?? '当前无待编程零件'），让「队列空」与「后端挂了」在 filter 卡
          上也一眼可分 —— 表格的 :empty-text 只是兜底。
        -->
        <el-tag v-else-if="!store.query.loading" type="info" effect="plain" size="small">
          {{ store.query.emptyText }}
        </el-tag>
      </div>
    </el-card>

    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="store.columnDefs"
        :model-value="store.columnVisibility.currentMap"
        @update:model-value="store.columnVisibility.update"
        @reset="store.columnVisibility.showAll"
        @resetOrder="store.drag.reset"
      />
    </div>

    <!--
      2026-10-01：列渲染模板块照抄 src/components/ListShell.vue:107-152
      （含 cellRender / ColumnDragHandle / :label-class-name="drag.dragLabelClass(d)"
      等全部属性，属性一行不减 —— 列可见性 + 列顺序拖动语义与 ListShell 内一致）。
      注意 store proxy 自动解包嵌套 ref：orderedDefs 是 ComputedRef，模板里写
      store.drag.orderedDefs（**不写 .value**，写了拿到 undefined —— 与
      ListShell 组件内的 drag.orderedDefs.value 写法不同）。
    -->
    <el-table
      ref="tableRef"
      v-loading="store.query.loading"
      :data="store.query.items"
      row-key="id"
      :empty-text="store.query.emptyText"
      stripe
      border
      size="small"
      :row-class-name="rowClassName"
    >
      <template v-for="d in store.drag.orderedDefs" :key="columnIdentifier(d)">
        <el-table-column
          v-if="store.columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :type="d.type"
          :width="d.width"
          :min-width="d.minWidth"
          :fixed="d.fixed"
          :sortable="d.sortable"
          :align="d.align"
          :header-align="d.headerAlign"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :formatter="d.formatter"
          :index="d.index"
          :selectable="d.selectable"
          :filters="d.filters"
          :filter-multiple="d.filterMultiple"
          :filter-method="d.filterMethod"
          :filtered-value="d.filteredValue"
          :sort-method="d.sortMethod"
          :sort-by="d.sortBy"
          :sort-orders="d.sortOrders"
          :resizable="d.resizable"
          :class-name="d.className"
          :label-class-name="store.drag.dragLabelClass(d)"
          :column-key="d.columnKey ?? d.key"
        >
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
          <!-- 可拖列（非 type / 非 fixed）的表头追加拖动手柄 -->
          <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
        </el-table-column>
      </template>
    </el-table>

    <div class="pagination">
      <!--
        2026-10-01 review 第 1 轮 M-5：不传 :page-sizes，沿 EP 默认
        （[10,20,30,40,50,100]），与旧的 PagedTable.vue:34-43 一致 —— 脱壳时擅自收窄成
        [10,20,50,100] 属于计划外改动，不在本次任务范围。
      -->
      <el-pagination
        v-model:current-page="store.query.page"
        v-model:page-size="store.query.pageSize"
        :total="store.query.total"
        layout="total, sizes, prev, pager, next, jumper"
        :pager-count="7"
        background
        size="small"
      />
    </div>

    <!-- 下发到 CNC 货架 对话框（PROGRAMMING → IN_PROCESS） —— 与 PartDetail 同款 -->
    <el-dialog
      v-model="store.release.dialogVisible"
      title="下发到 CNC 货架"
      :width="releaseDlg.width"
      :top="releaseDlg.top"
      @closed="store.release.onDialogClosed"
    >
      <el-form label-width="96px">
        <el-form-item label="下一道工序" required>
          <el-select
            v-model="store.release.processId"
            placeholder="请先选择下一道工序"
            style="width: 100%"
            filterable
            clearable
          >
            <el-option
              v-for="p in store.release.filteredProcesses"
              :key="p.id"
              :label="`${p.code} / ${p.name}`"
              :value="p.id"
            />
            <template #empty>
              <span class="muted">
                {{
                  store.release.processesPending
                    ? '正在加载工序…'
                    : store.release.processesError
                      ? '工序加载失败，请重试'
                      : '没有可用的工序'
                }}
              </span>
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="目标生产货架" required>
          <el-select
            v-model="store.release.shelfId"
            placeholder="先选工序；货架候选按映射过滤"
            style="width: 100%"
            filterable
            clearable
            :disabled="!store.release.processId"
          >
            <el-option
              v-for="s in store.release.filteredShelves"
              :key="s.id"
              :label="`${s.code} — ${s.name}`"
              :value="s.id"
              :disabled="!s.is_active"
            >
              <span>{{ s.code }} — {{ s.name }}</span>
              <span v-if="!s.is_active" class="muted">（已停用）</span>
            </el-option>
            <!--
              2026-10-01 review 第 1 轮 M-1：数据源从「点下发才 await 拉完再开弹窗」
              换成共享 query（setup 期就发）后，冷缓存首访可能空开。空态必须能区分
              「数据还在路上」与「真的没配映射」—— 后者的文案会引导用户去「货架管理 →
              工序映射」改配置，数据没到时显示它是主动误导。取舍说明见 store 内
              processesPending / shelvesPending 的注。
              2026-10-01 review 第 2 轮 N-1：再补一层「加载失败」—— isPending 在
              失败时是 false（query-core queryObserver.js:346），不加这一层空态会在
              接口挂掉时落回下面那句「未映射，请去配置映射」，把网络故障说成配置缺失。
              失败优先级最高，其次在途，最后才是业务判断。
            -->
            <template #empty>
              <span class="muted">
                {{
                  store.release.shelvesError
                    ? '生产货架加载失败，请重试'
                    : store.release.shelvesPending
                      ? '正在加载生产货架…'
                      : store.release.processId
                        ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                        : '请先选择下一道工序'
                }}
              </span>
            </template>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="store.release.dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="store.release.submitting"
          :disabled="!store.release.shelfId || !store.release.processId"
          @click="onReleaseConfirm"
          >确认下发</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// 2026-10-01 重写：脱 <ListShell> + 手写 fetcher，数据层全部走
// usePendingProgrammingStore（TanStack Query）。
//
// 不变量（与 usePartsListStore 同源）：
//   1. setup 顶部首调 store（子组件 setup 晚于父组件，天然满足）；
//   2. onBeforeUnmount 调 store.$dispose()（Pinia 单例，泄漏对话框态到下次进入）；
//   3. 消费侧禁止解构 store（写 store.query.xxx / store.release.xxx，深代理
//      自动解包嵌套 ref）；
//   4. router 由视图持有，store 通过 store.registerRouter 拿跳转能力
//      （store 不 import vue-router，见 store 不变量 #4）。
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import { columnIdentifier } from '@/composables/useColumnDrag';
import { resolveDraggable } from '@/composables/useColumnVisibility';
import { useDialogSize } from '@/composables/useDialogSize';
import {
  usePendingProgrammingStore,
  type PendingProgrammingRow,
} from './composables/usePendingProgrammingStore';

const store = usePendingProgrammingStore();
const router = useRouter();

// 列拖动：把 el-table 实例交给 store 的 drag composable（内部解析表头 <tr> +
// MutationObserver 自愈，覆盖 EP 重建表头 / 数据到达后表头首次渲染）
const tableRef = ref();
onMounted(() => {
  store.query.restoreState();
  store.drag.applyDrag(tableRef);
});

// 不变量 #4：把 router 注入 store（操作列「详情」按钮的跳转能力）
store.registerRouter(() => router);

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开页面销毁，下次进入重建 fresh 状态
  // （query / release 走 plain object slice，$dispose 后不会从 pinia.state hydrate 回来）
  store.$dispose();
});

/** 加急行红底。 */
function rowClassName({ row }: { row: PendingProgrammingRow; rowIndex: number }): string {
  return row.is_urgent ? 'row-urgent' : '';
}

const releaseDlg = useDialogSize({ desktopWidth: 440 });

async function onReleaseConfirm(): Promise<void> {
  await store.release.confirm(router);
}
</script>

<style lang="scss" scoped>
.pending-programming {
  padding: 0;
}
// 2026-09-29 新增：tabs 容器样式 —— 列表上方紧凑的 tab 栏
.tabs-wrap {
  margin-bottom: 12px;
  :deep(.el-tabs__header) {
    margin-bottom: 0;
  }
}
.filter-card {
  margin-bottom: 12px;
  :deep(.el-card__body) {
    padding: 12px 16px;
  }
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: nowrap;
}
.total-hint {
  margin-left: auto;
  font-size: 13px;
  color: var(--text-secondary);
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 12px 4px 0;
}
.name-link {
  color: var(--el-color-primary);
  text-decoration: none;
}
.name-link:hover {
  text-decoration: underline;
}
.muted {
  color: var(--text-secondary);
}
// 加急红底（与 PartsList / InspectionPending / ListShell 同款 #fde2e2）
:deep(.row-urgent) {
  background: #fde2e2 !important;
}
:deep(.row-urgent td) {
  background: #fde2e2 !important;
}
// 2026-08-27 T15：EP thead th 上的 col-no-drag 类让 sortablejs filter 跳过；
// 同时禁用默认 cursor（不可拖列不放 handle，应显示普通箭头）
:deep(.col-no-drag) {
  cursor: default !important;
}
// sortablejs 拖动时的视觉反馈（与 EP 主题色协调，藏青/蓝/浅蓝系）
:deep(.sortable-ghost) {
  opacity: 0.5;
  background: #eaf2fb !important;
}
:deep(.sortable-chosen) {
  background: #cce0f4 !important;
}
:deep(.sortable-drag) {
  background: #fff !important;
}
</style>
