<!--
  PartsBatchBar.vue

  2026-08-22 从 PartsList.vue 抽出：底部批量操作栏（计数 + tooltip + 全选/清空 +
  打印进度条 + 操作按钮）。

  隐藏 iframe（批量打印预览）保留在 PartsList.vue 壳内，不在此组件渲染：
  iframe 与 ctx.print.iframeRef 在 onMounted 里同步赋值，确保 ctx.print.onBatchPrint
  触发时 iframe 已挂载。
-->
<template>
  <div v-if="canEdit && batchMode" class="batch-bar">
    <div class="bar-info">
      <span v-if="batchSelectedPartCount > 0">
        零件 <strong>{{ batchSelectedPartCount }}</strong> 件
      </span>
      <span v-if="batchSelectedAssemblyCount > 0" class="bar-info__assembly">
        装配件 <strong>{{ batchSelectedAssemblyCount }}</strong> 件
        <el-tooltip placement="top" :show-after="0">
          <template #content>
            勾选装配件行将打印该装配件的<b>全部子件</b>图纸
          </template>
          <el-icon class="batch-hint"><WarningFilled /></el-icon>
        </el-tooltip>
      </span>
      <el-button link size="small" @click="onSelectAllPage">全选当前页</el-button>
      <el-button link size="small" @click="onClearSelection">清空选择</el-button>
    </div>

    <!-- 打印进度 -->
    <div v-if="batchPrintTotal > 0" class="batch-print-progress">
      <el-progress
        :percentage="batchPrintProgress"
        :stroke-width="16"
        :text-inside="true"
        :show-text="true"
      />
      <div class="batch-print-progress__text">
        正在生成打印文件 {{ batchPrintCurrent }}/{{ batchPrintTotal }}
      </div>
    </div>

    <el-button
      v-if="batchAction === 'print'"
      type="primary"
      :loading="batchPrinting"
      :disabled="selectedIdsSize === 0 || batchPrintTotal > 0"
      @click="onBatchPrint"
    >
      <el-icon><Printer /></el-icon>
      <span>打印预览（{{ selectedIdsSize }} 件）</span>
    </el-button>
    <el-button
      v-else
      type="primary"
      :disabled="selectedIdsSize === 0"
      @click="onOpenBatchDispatch"
    >
      <el-icon><Promotion /></el-icon>
      <span>批量下发（{{ selectedIdsSize }} 件）</span>
    </el-button>
  </div>
</template>

<script setup lang="ts">
// views/parts/components/PartsBatchBar.vue
//
// 2026-08-22 从 PartsList.vue 抽出：底部批量栏。
// 计数 / 进度 / 操作按钮全部来自 ctx.batch.* / ctx.print.* / ctx.dispatch.*。
// 模板只对顶层 ref 自动解包 —— 从 props.ctx.* 取的嵌套 ref 必须先解构到 script 顶层。

import { computed } from 'vue'
import { Printer, Promotion, WarningFilled } from '@element-plus/icons-vue'
import type { PartsListCtx } from '../composables/partsListCtx'

const props = defineProps<{ ctx: PartsListCtx }>()

// 解构 ctx → 顶层局部变量（模板自动解包）
const { batch, print, dispatch, canEdit } = props.ctx

const {
  batchMode,
  batchAction,
  selectedIds,
  batchSelectedPartCount,
  batchSelectedAssemblyCount,
  onSelectAllPage,
  onClearSelection,
} = batch

const {
  batchPrinting,
  batchPrintProgress,
  batchPrintCurrent,
  batchPrintTotal,
  onBatchPrint,
} = print

const { onOpenBatchDispatch } = dispatch

// selectedIds 是 reactive Set，模板里 .size 不会自动响应；用 computed 包一层
// 确保 selectedIds.size 变化时模板重新渲染。
const selectedIdsSize = computed(() => selectedIds.size)
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
.batch-print-progress__text {
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
