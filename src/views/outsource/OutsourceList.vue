<template>
  <div class="outsource-list">
    <!--
      2026-10-09：顶部 filter 卡收缩 —— 公司名 / 状态两个筛选项搬进表头
      （照零件一览 / 待品检的范式），顶部只留「新增」+「重置筛选」。
    -->
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <el-button type="success" @click="onNew">
          <el-icon><Plus /></el-icon><span>新增外协公司</span>
        </el-button>
        <el-button @click="onResetFilters">
          <el-icon><RefreshLeft /></el-icon><span>重置筛选</span>
        </el-button>
        <span v-if="store.query.total > 0" class="total-hint">共 {{ store.query.total }} 家</span>
      </div>
    </el-card>

    <el-card shadow="never">
      <div class="table-toolbar">
        <el-button size="small" @click="onResetFilters">重置筛选</el-button>
        <ColumnVisibilityPopover
          :defs="store.columnDefs"
          :model-value="store.columnVisibility.currentMap"
          @update:model-value="store.columnVisibility.update"
          @reset="store.columnVisibility.showAll"
          @resetOrder="drag.reset"
        />
      </div>
      <el-table
        ref="tableRef"
        v-loading="store.query.loading"
        :data="store.query.items"
        row-key="id"
        stripe
        border
        size="small"
        :empty-text="store.query.emptyText"
        @filter-change="store.query.onNativeFilterChange"
      >
        <template #empty>
          <el-empty :description="store.query.emptyText" />
        </template>
        <el-table-column type="index" label="#" width="50" />
        <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
          <el-table-column
            v-if="store.columnVisibility.isVisible(d.key)"
            :prop="d.prop ?? d.key"
            :label="d.label"
            :width="d.width"
            :min-width="d.minWidth"
            :sortable="d.sortable"
            :align="d.align"
            :filters="d.filters"
            :filter-multiple="d.filterMultiple"
            :filtered-value="d.filteredValue"
            :show-overflow-tooltip="d.showOverflowTooltip"
            :column-key="d.columnKey ?? d.key"
            :label-class-name="drag.dragLabelClass(d)"
          >
            <template
              v-if="d.headerRender || (resolveDraggable(d) && !d.type && !d.fixed)"
              #header="scope"
            >
              <component :is="d.headerRender(scope)" v-if="d.headerRender" />
              <span v-else>{{ d.label }}</span>
              <ColumnDragHandle
                v-if="resolveDraggable(d) && !d.type && !d.fixed"
                :title="`拖动 ${d.label} 列`"
              />
            </template>
            <template v-if="d.cellRender" #default="scope">
              <component :is="d.cellRender(scope)" />
            </template>
          </el-table-column>
        </template>
        <el-table-column label="操作" min-width="220" fixed="right" align="center">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              @click="store.dialogs.openEdit(row as OutsourceCompanySchema)"
              >编辑</el-button
            >
            <el-button
              link
              type="success"
              size="small"
              @click="onBilling(row as OutsourceCompanySchema)"
              >对账</el-button
            >
            <el-button
              link
              type="danger"
              size="small"
              @click="store.dialogs.onDelete(row as OutsourceCompanySchema)"
              >删除</el-button
            >
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination">
        <el-pagination
          v-model:current-page="store.query.page"
          v-model:page-size="store.query.pageSize"
          :page-sizes="[20, 50, 100, 200]"
          :total="store.query.total"
          layout="total, sizes, prev, pager, next, jumper"
          :pager-count="7"
          background
          size="small"
        />
      </div>
    </el-card>

    <!--
      2026-10-09：编辑 / 新建两个对话框**合并为一个** —— 原先「编辑外协公司」与
      「维护工序」是两次保存（两个 POST），后端本轮已把工序能力的整体替换吸收进
      `POST /{id}/update` 的 `process_ids`（三态可分），拆开两个弹窗反而会让「勾了工序
      却忘了点维护工序那侧的保存」这类半截操作存在。操作列的「维护工序」按钮随之删除。
    -->
    <el-dialog
      v-model="store.dialogs.visible"
      :title="store.dialogs.editingId ? '编辑外协公司' : '新增外协公司'"
      :width="companyDlg.width"
      :top="companyDlg.top"
      :close-on-click-modal="false"
    >
      <el-form :model="store.dialogs.form" label-width="100px">
        <el-form-item label="公司名" required>
          <el-input
            v-model="store.dialogs.form.name"
            :disabled="!!store.dialogs.editingId"
            placeholder="如 福州精工外协"
          />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="store.dialogs.form.contact_name" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="store.dialogs.form.contact_phone" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="store.dialogs.form.address" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="store.dialogs.form.is_active" />
        </el-form-item>
        <!-- 勾选项取「共享 OUTSOURCE 工序列表 ∪ GET /{id} 回包的已映射工序」并集
             （store.options.processOptions）：已映射但不在 OUTSOURCE 列表里的工序
             必须仍可见可取消，否则保存时它被静默删掉。 -->
        <!-- el-checkbox-group 根元素非 labelable ⇒ 显式 for="" + aria-label（a11y） -->
        <el-form-item label="工序能力" for="">
          <el-checkbox-group
            v-model="store.dialogs.form.process_ids"
            class="process-check-group"
            aria-label="工序能力"
          >
            <el-checkbox v-for="p in store.options.processOptions" :key="p.id" :value="p.id">
              {{ p.label }}
            </el-checkbox>
            <span v-if="store.options.processOptions.length === 0" class="muted">
              没有 OUTSOURCE 工序，请先在「设置 → 工序管理」中新增
            </span>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="store.dialogs.visible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="store.dialogs.saving"
          @click="store.dialogs.onSave"
          >保存</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// views/outsource/OutsourceList.vue — 外协厂一览
//
// 2026-10-09 三项变更：
//   1. 主查询改走域内 query hook `useOutsourceCompaniesQuery`（替掉手工 `PagedTable`
//      fetcher + `limit/offset` 手工换算），分页改为 `el-pagination` + store 私有页码；
//   2. 表头筛选：公司名（popover 文本）+ 状态（EP 原生 `:filters`），顶部 filter 卡收缩；
//   3. 编辑 / 新建合并为一个对话框，保存走 `POST /{id}/update`（**必传 `version`** 与
//      `process_ids` 三态）—— 此前 onSave 漏传 version，后端本轮已把它设为必填，漏传
//      恒 422，等于编辑功能 100% 失败（本次修掉的线上缺陷）。
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { TableInstance } from 'element-plus';
import { Plus, RefreshLeft } from '@element-plus/icons-vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import { resolveDraggable } from '@/composables/useColumnVisibility';
import { useDialogSize } from '@/composables/useDialogSize';
import { useOutsourceCompanyListStore } from './composables/useOutsourceCompanyListStore';
import type { OutsourceCompanySchema } from './composables/outsourceListSchema';
// 2026-10-09：`outsourceCompanyColumnDefs.ts` 用 h() 直挂 ElTag 渲染「状态」列，而
// unplugin-vue-components 只处理**模板**里用到的标签，.ts 文件里的值 import 拿不到样式
// 注入（`src/styles/__tests__/elementPlusManualImportStyles.spec.ts` 登记的已知盲区）。
// 这里显式补副作用 import，免得本路由下 tag 样式靠别处顺带注入。
import 'element-plus/es/components/tag/style/css';

const router = useRouter();
const companyDlg = useDialogSize({ desktopWidth: 520 });

// store 必须在本组件 setup 内首调（不变量 #1：切片链路上的 onMounted / onBeforeUnmount
// 会绑到首个创建 store 的组件 = 本组件）。
const store = useOutsourceCompanyListStore();

const columnDefs = store.columnDefs;
const drag = useColumnDrag(columnDefs, { listKey: 'outsource_company_list' });
const tableRef = ref<TableInstance | null>(null);

function onNew(): void {
  store.dialogs.openCreate();
}

function onResetFilters(): void {
  store.query.resetAllFilters();
}

function onBilling(row: OutsourceCompanySchema): void {
  void router.push(`/outsource/companies/${row.id}/sent-parts`);
}

onMounted(() => {
  drag.applyDrag(tableRef);
  store.query.restoreState();
});

onBeforeUnmount(() => {
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.outsource-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.filter-card :deep(.el-card__body) {
  padding: 12px 16px;
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.total-hint {
  margin-left: auto;
  font-size: 13px;
  color: var(--text-secondary);
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.process-check-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}
.muted {
  color: #909399;
  font-size: 12px;
}
// 原生 :filters 列的激活态视觉（蓝字加粗 + 计数），与零件一览同款。
.status-header {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.status-count {
  font-weight: 600;
}
</style>