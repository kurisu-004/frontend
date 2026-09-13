<!--
  模板预览面板（2026-09-14 新增）：
  - 接收 PrintTemplate，按当前纸张/方向/边距渲染预览表格。
  - 数据源 mock/manual 直接 JSON.parse(template.manualDataJson)；api:* 显示「后端接口待接入」占位。
  - root 容器 class="print-preview-area"，父级 @media print 仅打印这块。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { Printer } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { renderTable } from '@/views/print-templates/interpolate';
import type { PrintRowData, PrintTemplate, PaperSize } from '@/views/print-templates/types';

const props = defineProps<{
  template: PrintTemplate | null;
}>();

const emit = defineEmits<{
  print: [];
}>();

/** 标准纸张的毫米尺寸（ISO 216）。 */
const STANDARD_PAPER_MM: Record<Exclude<PaperSize, 'custom'>, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  B5: { w: 176, h: 250 },
};

/** 计算当前纸张的物理尺寸（mm），含方向旋转。 */
const paperSize = computed(() => {
  if (!props.template) return { w: 210, h: 297 };
  const t = props.template;
  const base =
    t.paper === 'custom'
      ? { w: t.customWidthMm ?? 210, h: t.customHeightMm ?? 297 }
      : STANDARD_PAPER_MM[t.paper];
  return t.orientation === 'landscape' ? { w: base.h, h: base.w } : base;
});

/** 安全解析 mock/manual 数据。失败 → 空数组（不抛错，避免打印链断）。 */
const parsedData = computed<PrintRowData[]>(() => {
  if (!props.template) return [];
  const t = props.template;
  if (!t.dataSource || (t.dataSource !== 'mock' && t.dataSource !== 'manual')) return [];
  try {
    const v = JSON.parse(t.manualDataJson);
    if (!Array.isArray(v)) return [];
    return v as PrintRowData[];
  } catch {
    return [];
  }
});

const isApiSource = computed(() => {
  if (!props.template) return false;
  return props.template.dataSource?.startsWith('api:') ?? false;
});

const renderedTable = computed(() => {
  if (!props.template) return { header: [], rows: [] };
  return renderTable(props.template, parsedData.value);
});

/** 列宽数组：统一转 CSS grid-template-columns。 */
const gridTemplateColumns = computed(() => {
  if (!props.template) return '';
  return props.template.columns.map((c) => c.width || '1fr').join(' ');
});

const paperLabel = computed(() => {
  if (!props.template) return '';
  return props.template.paper === 'custom'
    ? `${props.template.customWidthMm ?? 0}×${props.template.customHeightMm ?? 0}mm`
    : props.template.paper;
});

function onPrint(): void {
  if (!props.template) {
    ElMessage.warning('请先选择模板');
    return;
  }
  emit('print');
}
</script>

<template>
  <div class="preview-panel">
    <div class="preview-toolbar">
      <el-space>
        <el-tag size="small" type="info">{{ paperLabel }}</el-tag>
        <el-tag size="small" type="info">
          {{ template?.orientation === 'landscape' ? '横向' : '纵向' }}
        </el-tag>
        <el-text size="small" type="info">
          {{ template?.margin.top }} / {{ template?.margin.bottom }} / {{ template?.margin.left }} /
          {{ template?.margin.right }} mm
        </el-text>
        <el-text v-if="!isApiSource" size="small" type="success">
          {{ parsedData.length }} 条 mock 数据
        </el-text>
        <el-text v-else size="small" type="warning">
          dataSource: {{ template?.dataSource }}（后端接口待接入）
        </el-text>
      </el-space>
      <el-button type="primary" :disabled="!template" @click="onPrint">
        <el-icon><Printer /></el-icon>
        打印
      </el-button>
    </div>

    <div class="preview-scroll">
      <!-- 占位 -->
      <div v-if="!template" class="empty">
        <el-empty description="从左侧选择模板以预览" :image-size="80" />
      </div>

      <!-- api 数据源占位 -->
      <div v-else-if="isApiSource" class="api-placeholder">
        <el-empty
          :description="`后端接口 ${template.dataSource.replace('api:', '')} 待接入，本期以 mock 数据预览`"
          :image-size="80"
        />
      </div>

      <!-- 实际预览 -->
      <div
        v-else
        class="print-preview-area"
        :style="{
          width: paperSize.w + 'mm',
          height: paperSize.h + 'mm',
          padding:
            template.margin.top +
            'mm ' +
            template.margin.right +
            'mm ' +
            template.margin.bottom +
            'mm ' +
            template.margin.left +
            'mm',
          gridTemplateColumns,
        }"
      >
        <div class="preview-grid">
          <div
            v-for="(cell, idx) in renderedTable.header"
            :key="`h-${idx}`"
            class="preview-cell preview-header"
          >
            {{ cell }}
          </div>
          <template v-for="(row, ri) in renderedTable.rows" :key="`r-${ri}`">
            <div v-for="(cell, ci) in row" :key="`c-${ri}-${ci}`" class="preview-cell preview-data">
              {{ cell }}
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f5f7fa;
  border-left: 1px solid var(--el-border-color-lighter);
}
.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #fff;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}
.preview-scroll {
  flex: 1;
  overflow: auto;
  padding: 24px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}
.api-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.print-preview-area {
  background: #fff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  box-sizing: border-box;
  font-size: 11px;
  line-height: 1.5;
  color: #1f2d3d;
  /* flex-shrink: 0 让父级 flex 不把纸张按容器宽度强行压缩（210mm 必须真按 mm 算）。
     父容器 .preview-scroll overflow:auto，超出滚动即可。 */
  flex-shrink: 0;
}
.preview-grid {
  display: grid;
  grid-template-columns: subgrid;
  grid-auto-rows: min-content;
  width: 100%;
  height: 100%;
}
.preview-cell {
  padding: 4px 6px;
  border: 1px solid #dcdfe6;
  word-break: break-all;
  display: flex;
  align-items: center;
}
.preview-header {
  background: #f0f2f5;
  font-weight: 600;
}
/* zebra：偶数行浅灰 */
.preview-data {
  background: #fff;
}
.preview-grid > .preview-data:nth-child(odd) {
  /* 第 1 列每条数据行是奇数子元素 → 浅灰 */
  background: #fafbfc;
}
</style>
