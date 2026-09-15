<!--
  PartsBatchBar.vue

  2026-08-22 从 PartsList.vue 抽出：底部批量操作栏（计数 + tooltip + 全选/清空 +
  打印进度条 + 操作按钮）。

  2026-09-15 重构：状态全部来自 usePartsListStore（Pinia setup store），原 :ctx prop
  模式删除；selectedIds 是 reactive Set，经 store 深代理后身份保持、.size 可跟踪，
  模板直接 store.batch.selectedIds.size 即可触发响应式更新（无需 computed 包一层）。

  隐藏 iframe（批量打印预览）保留在 PartsList.vue 壳内，不在此组件渲染：
  iframe 与 store.print.iframeRef 在 onMounted 里同步赋值，确保 store.print.onBatchPrint
  触发时 iframe 已挂载。
-->
<template>
  <div v-if="store.canEdit && store.batch.batchMode" class="batch-bar">
    <div class="bar-info">
      <span v-if="store.batch.batchSelectedPartCount > 0">
        零件 <strong>{{ store.batch.batchSelectedPartCount }}</strong> 件
      </span>
      <span v-if="store.batch.batchSelectedAssemblyCount > 0" class="bar-info__assembly">
        装配件 <strong>{{ store.batch.batchSelectedAssemblyCount }}</strong> 件
        <el-tooltip placement="top" :show-after="0">
          <template #content> 勾选装配件行将打印该装配件的<b>全部子件</b>图纸 </template>
          <el-icon class="batch-hint"><WarningFilled /></el-icon>
        </el-tooltip>
      </span>
      <el-button link size="small" @click="store.batch.onSelectAllPage">全选当前页</el-button>
      <el-button link size="small" @click="store.batch.onClearSelection">清空选择</el-button>
    </div>

    <!-- 打印进度 -->
    <div v-if="store.print.batchPrintTotal > 0" class="batch-print-progress">
      <el-progress
        :percentage="store.print.batchPrintProgress"
        :stroke-width="16"
        :text-inside="true"
        :show-text="true"
      />
      <div class="batch-print-progress__text">
        正在生成打印文件 {{ store.print.batchPrintCurrent }}/{{ store.print.batchPrintTotal }}
      </div>
    </div>

    <el-button
      v-if="store.batch.batchAction === 'print'"
      type="primary"
      :loading="store.print.batchPrinting"
      :disabled="store.batch.selectedIds.size === 0 || store.print.batchPrintTotal > 0"
      @click="store.print.onBatchPrint"
    >
      <el-icon><Printer /></el-icon>
      <span>打印预览（{{ store.batch.selectedIds.size }} 件）</span>
    </el-button>
    <el-button
      v-else
      type="primary"
      :disabled="store.batch.selectedIds.size === 0"
      @click="store.dispatch.onOpenBatchDispatch"
    >
      <el-icon><Promotion /></el-icon>
      <span>批量下发（{{ store.batch.selectedIds.size }} 件）</span>
    </el-button>
  </div>
</template>

<script setup lang="ts">
// views/parts/components/PartsBatchBar.vue
//
// 2026-09-15 重构：状态全部来自 usePartsListStore（Pinia setup store）。
// 计数 / 进度 / 操作按钮直接 store.batch.* / store.print.* / store.dispatch.* 访问。
import { Printer, Promotion, WarningFilled } from '@element-plus/icons-vue';
import { usePartsListStore } from '../composables/usePartsListStore';

const store = usePartsListStore();
</script>

<style lang="scss" scoped>
// 2026-08-22：从 PartsList.vue 原 3138-3181 行原样搬入 scoped。
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  padding: 10px 14px;
  background: #ecf5ff;
  border: 1px solid #d9ecff;
  border-radius: 6px;
}
.batch-bar .bar-info {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #303133;
  font-size: 13px;
}
.batch-bar .bar-info strong {
  color: #409eff;
  font-weight: 600;
}
// 2026-07-31：装配件计数与提示图标
.batch-bar .bar-info__assembly {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.batch-bar .batch-hint {
  color: var(--el-color-warning);
  cursor: help;
  font-size: 14px;
}
.batch-print-progress {
  flex: 1;
  margin: 0 12px;
}
.batch-bar .batch-print-progress__text {
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
