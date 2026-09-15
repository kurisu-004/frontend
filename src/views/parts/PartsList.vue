<!--
  PartsList.vue

  2026-09-15 重构：壳仅保留 filter-card / PartsTable / PartsBatchBar / iframe /
  分页 / 两个下发 dialog / 采购单导入 dialog；其余六切片装配、列定义、列可见性、
  getTable 闭包、ctx 字面量装配、顶层解构块 / void 抑制全部迁入 `usePartsListStore`
  （Pinia setup store，详见 src/views/parts/composables/usePartsListStore.ts）。

  本壳职责：
  - 顶部 filter-card（行类型 + 重置 + 操作按钮组）；
  - PartsTable（承载全部表格逻辑，状态全部来自 store）；
  - PartsBatchBar（批量操作栏，状态来自 store.batch / store.print / store.dispatch）；
  - 隐藏 iframe（批量打印预览，必须留在壳内以便 onMounted 同步 store.print.iframeRef）；
  - el-pagination；
  - PartsDispatchDialog / PartsBatchDispatchDialog；
  - PurchaseOrderImportDialog（采购订单 Excel 导入）；
  - 路由 / 生命周期编排：restoreState、iframe DOM 同步、表头 sort 恢复、
    扫码订阅 / 卸载、store.$dispose()。

  2026-08-22 同步移除所有手机适配（保持）：
  - 删除 ResponsiveList 卡片视图；
  - 删除 el-drawer 手机筛选抽屉；
  - 删除 isMobile / paginationLayout / locationText / anyFilterActive /
    openMobileFilter / confirmMobileFilter / resetMobileFilter /
    syncStatusDraft / syncNextProcessDraft / syncLocationDraft 等移动端相关代码与样式；
  - 原 @include until(sm) 全部清除。
-->
<template>
  <div class="parts-list">
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <!-- 行类型 + 重置（2026-08-20 保留在顶部 filter-card） -->
        <div class="filter-group filter-group--rowtype">
          <el-select
            v-model="store.query.search.rowType"
            placeholder="类型"
            style="width: 140px"
            @change="store.query.onRowTypeChange"
          >
            <el-option label="全部" value="ALL" />
            <el-option label="仅零件" value="PART" />
            <el-option label="仅装配件" value="ASSEMBLY" />
          </el-select>

          <el-button @click="store.query.onReset">
            <el-icon><RefreshLeft /></el-icon>
            <span>重置</span>
          </el-button>
        </div>

        <!-- 操作组 -->
        <div class="filter-group filter-group--actions">
          <!-- INSPECTOR 看不到导入按钮（PR-I 2026-07-20）；
               2026-08-05：CNC 与 INSPECTOR 同样对待（看不到导入/批量/下发） -->
          <el-button v-if="store.canEdit" @click="router.push('/parts/new?tab=pdf')">
            <el-icon><Document /></el-icon>
            <span>从 PDF/Excel 批量导入</span>
          </el-button>

          <!-- 2026-08-12：采购订单 Excel 导入（解析系统交期和订单号；同 canEdit 闸门） -->
          <el-button v-if="store.canEdit" @click="orderImportVisible = true">
            <el-icon><Upload /></el-icon>
            <span>解析系统交期和订单号</span>
          </el-button>

          <!-- 批量打印 / 批量下发 toggle（2026-07-17 打印；2026-07-22 下发；INSPECTOR 不可见） -->
          <template v-if="store.canEdit">
            <template v-if="!store.batch.batchMode">
              <el-button type="success" plain @click="store.batch.onEnterBatchMode">
                <el-icon><Printer /></el-icon>
                <span>批量打印图纸</span>
              </el-button>
              <el-button type="primary" plain @click="store.batch.onEnterBatchDispatchMode">
                <el-icon><Promotion /></el-icon>
                <span>批量下发</span>
              </el-button>
            </template>
            <el-button v-else type="warning" @click="store.batch.onExitBatchMode">
              <el-icon><Close /></el-icon>
              <span>退出批量模式</span>
            </el-button>
          </template>

          <el-tag v-if="store.isCncProgrammer" type="warning" effect="plain" size="small">
            编程员视图：默认查看「编程中」零件
          </el-tag>
          <span v-if="store.query.total > 0" class="total-hint">共 {{ store.query.total }} 条</span>
        </div>
      </div>
    </el-card>

    <PartsTable ref="partsTableRef" />

    <PartsBatchBar v-if="store.batch.batchMode" />

    <!-- 隐藏 iframe：批量打印用（仿 FileListCard.vue 的 print 实现）。
         必须留在壳内：onMounted 时同步赋值给 store.print.iframeRef，确保 onBatchPrint
         触发时 iframe 已挂载。 -->
    <iframe
      ref="iframeRef"
      style="
        position: fixed;
        right: 0;
        bottom: 0;
        width: 1px;
        height: 1px;
        border: 0;
        opacity: 0;
        pointer-events: none;
      "
      title="批量打印预览"
    />

    <div class="pagination">
      <el-pagination
        v-model:current-page="store.query.page"
        v-model:page-size="store.query.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="store.query.total"
        layout="total, sizes, prev, pager, next, jumper"
        :pager-count="7"
        background
        size="small"
        @current-change="store.query.fetchList"
        @size-change="store.query.onPageSizeChange"
      />
    </div>

    <PartsDispatchDialog />
    <PartsBatchDispatchDialog />

    <!-- 2026-08-12：采购订单 Excel 导入对话框（解析系统交期和订单号） -->
    <PurchaseOrderImportDialog v-model="orderImportVisible" @success="store.query.fetchList" />
  </div>
</template>

<script setup lang="ts">
// views/parts/PartsList.vue
//
// 2026-09-15 重构壳：仅保留 filter-card / PartsTable / PartsBatchBar / iframe /
// 分页 / 两个下发 dialog / 采购单导入 dialog；其余全部下沉到 usePartsListStore
// （Pinia setup store，详见 src/views/parts/composables/usePartsListStore.ts）。
//
// 不再 import 任何业务 composable 与 ColumnDef — 全部从 store 取。
// 移除所有手机适配代码（ResponsiveList 卡片视图、el-drawer 移动筛选抽屉等）。

import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Close, Document, Printer, Promotion, RefreshLeft, Upload } from '@element-plus/icons-vue';
import PartsTable from './components/PartsTable.vue';
import PartsBatchBar from './components/PartsBatchBar.vue';
import PartsDispatchDialog from './components/PartsDispatchDialog.vue';
import PartsBatchDispatchDialog from './components/PartsBatchDispatchDialog.vue';
import PurchaseOrderImportDialog from './components/PurchaseOrderImportDialog.vue';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import { usePartsListStore } from './composables/usePartsListStore';
import { PART_SORT_KEY_TO_PROP } from '@/types/parts';

// 2026-09-15：壳 setup 顶部首调 store（不变量 #1：子组件 setup 晚于父组件，天然满足）。
const store = usePartsListStore();

const route = useRoute();
const router = useRouter();

// ============ 表格 ref + iframe ref ============
const partsTableRef = ref<InstanceType<typeof PartsTable> | null>(null);
// 2026-09-15：把 el-table getter 注册到 store（store 内部持有闭包）。壳卸载时 store.$dispose()
// 自动让闭包变 null，未挂载时调 getTable() 返回 null 不炸。
store.registerTableGetter(() => partsTableRef.value?.tableRef ?? null);

const iframeRef = ref<HTMLIFrameElement | null>(null);

// ============ 采购订单 Excel 导入对话框可见性 ============
const orderImportVisible = ref(false);

// ============ 扫码：序列号直搜 ============
// 2026-09-15：从 store 读 edit.editingId / filters.onSerialNoScan（深代理自动解包）。
const { onScan } = useBarcodeScanner();
const unsubPartsListScan = onScan((code) => {
  // 2026-08-04：扫码命中序列号时给输入框加 0.6s 脉冲动画（视觉反馈）
  // editingId 守卫放在 composable 内部（onSerialNoScan 内部判 editingId != null）
  // —— 这里直接转发即可。
  if (store.edit.editingId != null) return;
  store.filters.onSerialNoScan(code);
});

onMounted(async () => {
  // 1) 优先从 URL ?status= 注入；否则从 localStorage 恢复
  store.query.restoreState(route.query.status);
  void store.query.fetchList();

  // 2026-07-29 PR-fix-0.2.0：表头排序箭头要等 el-table 挂载后手动调一次 sort()，
  // 否则离开页面再回来时 refs 已恢复但表头不显示箭头（:default-sort 是 one-time prop）。
  await nextTick();
  const sortProp = PART_SORT_KEY_TO_PROP[store.query.sortBy] ?? 'planned_delivery_date';
  const sortOrder = store.query.sortDir === 'ASC' ? 'ascending' : 'descending';
  partsTableRef.value?.tableRef?.sort(sortProp, sortOrder);

  // 隐藏 iframe 必须在 onBatchPrint 跑之前挂上 ref
  store.print.iframeRef = iframeRef.value;

  // 加载下一道工序选项供原生 :filters 展示
  void store.filters.loadNextProcessOptions();
});

onBeforeUnmount(() => {
  unsubPartsListScan();
  // 2026-09-15：Pinia 单例，离开页面销毁，下次进入重建 fresh 状态（不变量 #2）。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.parts-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

// 2026-08-22：原 mobile `@include until(sm)` 已全部清除；filter-row 保持一行布局。
.filter-card {
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

.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

// 操作组靠右
.filter-group--actions {
  margin-left: auto;
}

.total-hint {
  font-size: 13px;
  color: var(--text-secondary);
}

.pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 0 4px;
}
</style>
