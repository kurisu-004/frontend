<!--
  表格编辑器（2026-09-14 新增）：
  - 顶部工具条：列 / 行 / 模板元信息（纸张/方向/边距）操作
  - 中部可编辑表格：表头行 + 数据行；每个单元格是 el-input，支持 {{row.x}} 占位
  - 底部 mock 数据预览区（可手动改 JSON）
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Delete, Plus } from '@element-plus/icons-vue';
import type { PrintTemplate } from '@/views/print-templates/types';

const props = defineProps<{
  modelValue: PrintTemplate | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [t: PrintTemplate];
}>();

/** 本地草稿：所有编辑操作都改 draft，由 watch 同步回 modelValue。
 *  这样父组件的 v-model 可以双向绑定且不会因局部输入抖动。 */
const draft = ref<PrintTemplate | null>(null);

watch(
  () => props.modelValue,
  (next) => {
    // 深拷贝到本地，避免直接 mutate 父组件引用导致 Pinia / store 状态串改
    draft.value = next ? (JSON.parse(JSON.stringify(next)) as PrintTemplate) : null;
  },
  { immediate: true },
);

watch(
  draft,
  (next) => {
    if (next) emit('update:modelValue', JSON.parse(JSON.stringify(next)) as PrintTemplate);
  },
  { deep: true },
);

const colCount = computed(() => draft.value?.columns.length ?? 0);
const rowCount = computed(() => draft.value?.rowCells.length ?? 0);

/** 校验：列数与表头 / 行 cells 长度对齐。 */
function ensureShape(): void {
  if (!draft.value) return;
  const c = draft.value.columns.length;
  // 表头 cells 补齐 / 截断
  const hdr = draft.value.headerCells.slice(0, c);
  while (hdr.length < c) hdr.push('');
  draft.value.headerCells = hdr;

  // 行 cells 补齐 / 截断
  draft.value.rowCells = draft.value.rowCells.map((row) => {
    const r = row.slice(0, c);
    while (r.length < c) r.push('');
    return r;
  });
}

function addColumn(atIndex?: number): void {
  if (!draft.value) return;
  const c = draft.value.columns.length;
  const idx = atIndex ?? c;
  const newKey = `col${c + 1}_${Date.now().toString(36).slice(-4)}`;
  draft.value.columns.splice(idx, 0, { key: newKey, label: `列 ${c + 1}`, width: '1fr' });
  draft.value.headerCells.splice(idx, 0, `表头 ${c + 1}`);
  draft.value.rowCells.forEach((r) => r.splice(idx, 0, ''));
}

function removeColumn(idx: number): void {
  if (!draft.value) return;
  if (draft.value.columns.length <= 1) {
    ElMessage.warning('至少保留 1 列');
    return;
  }
  draft.value.columns.splice(idx, 1);
  draft.value.headerCells.splice(idx, 1);
  draft.value.rowCells.forEach((r) => r.splice(idx, 1));
}

function addRow(): void {
  if (!draft.value) return;
  const c = draft.value.columns.length;
  draft.value.rowCells.push(new Array(c).fill(''));
}

function removeRow(idx: number): void {
  if (!draft.value) return;
  if (draft.value.rowCells.length <= 1) {
    ElMessage.warning('至少保留 1 行');
    return;
  }
  draft.value.rowCells.splice(idx, 1);
}

function clearCell(rowIdx: number, colIdx: number): void {
  if (!draft.value) return;
  draft.value.rowCells[rowIdx][colIdx] = '';
}

/** mock 数据解析：失败 → 显示错误，模板仍可继续编辑。 */
const dataParseError = ref<string | null>(null);
const parsedMockData = computed(() => {
  if (!draft.value) return [];
  if (draft.value.dataSource !== 'manual' && draft.value.dataSource !== 'mock') return [];
  const raw = draft.value.manualDataJson;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      dataParseError.value = 'mock 数据必须是 JSON 数组';
      return [];
    }
    dataParseError.value = null;
    return parsed;
  } catch (e) {
    dataParseError.value = (e as Error).message;
    return [];
  }
});

function applyTemplateData(): void {
  // 用 parsedMockData 同步 mock 区域显示（避免 JSON 解析后回填引入格式漂移）
  if (!draft.value) return;
  if (dataParseError.value) {
    ElMessage.error(`mock 数据格式错误：${dataParseError.value}`);
    return;
  }
  if (draft.value.dataSource === 'mock') {
    draft.value.manualDataJson = JSON.stringify(parsedMockData.value, null, 2);
    ElMessage.success('mock 数据已格式化');
  }
}

defineExpose({ ensureShape, parsedMockData });
</script>

<template>
  <div v-if="!draft" class="empty">
    <el-empty description="从左侧选择模板，或点击「新建」开始设计" :image-size="100" />
  </div>
  <div v-else class="editor">
    <!-- 顶部工具条 -->
    <div class="toolbar">
      <el-space wrap>
        <el-button-group>
          <el-button size="small" @click="addColumn()">
            <el-icon><Plus /></el-icon>添加列
          </el-button>
        </el-button-group>
        <el-button-group>
          <el-button size="small" @click="addRow">
            <el-icon><Plus /></el-icon>添加行
          </el-button>
        </el-button-group>
        <el-tag size="small" type="info">{{ colCount }} 列 × {{ rowCount }} 行模板</el-tag>
      </el-space>
      <el-text size="small" type="info">
        单元格支持
        <code
          ><span v-pre>{{ row.字段名 }}</span></code
        >
        占位 · 也可写
        <code
          ><span v-pre>{{ $index }}</span></code
        >
      </el-text>
    </div>

    <!-- 可编辑表格 -->
    <div class="table-scroll">
      <table class="editor-table">
        <colgroup>
          <col style="width: 40px" />
          <col
            v-for="c in draft.columns"
            :key="c.key"
            :style="{ width: c.width === '1fr' ? '160px' : c.width }"
          />
          <col style="width: 48px" />
        </colgroup>
        <thead>
          <tr>
            <th class="row-head">#</th>
            <th v-for="(c, i) in draft.columns" :key="`hdr-${c.key}`" class="col-head">
              <div class="col-head-row">
                <el-input v-model="draft.columns[i].label" size="small" placeholder="列标题" />
                <el-tooltip content="删除此列" placement="top">
                  <el-button size="small" link type="danger" @click="removeColumn(i)">
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </el-tooltip>
              </div>
              <el-input
                v-model="draft.headerCells[i]"
                size="small"
                placeholder="表头文本（支持 {{}}）"
                class="header-cell-input"
              />
              <el-input
                v-model="draft.columns[i].width"
                size="small"
                placeholder="宽度（如 1fr / 30mm）"
                class="width-input"
              />
            </th>
            <th class="row-head">
              <el-tooltip content="在末尾添加列" placement="top">
                <el-button size="small" link @click="addColumn()">
                  <el-icon><Plus /></el-icon>
                </el-button>
              </el-tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in draft.rowCells" :key="`row-${ri}`">
            <td class="row-head">
              <div class="row-head-row">
                <span class="row-num">R{{ ri + 1 }}</span>
                <el-tooltip content="删除此行" placement="top">
                  <el-button size="small" link type="danger" @click="removeRow(ri)">
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </el-tooltip>
              </div>
            </td>
            <td v-for="(cell, ci) in row" :key="`cell-${ri}-${ci}`">
              <el-input
                v-model="draft.rowCells[ri][ci]"
                size="small"
                :placeholder="`{{row.${draft.columns[ci]?.key ?? 'x'}}}`"
              />
              <el-button
                size="small"
                link
                class="cell-clear"
                title="清空"
                @click="clearCell(ri, ci)"
              >
                ×
              </el-button>
            </td>
            <td class="row-head"></td>
          </tr>
          <tr>
            <td class="row-head"></td>
            <td :colspan="draft.columns.length" class="add-row-cell">
              <el-button size="small" @click="addRow">
                <el-icon><Plus /></el-icon>添加一行
              </el-button>
            </td>
            <td class="row-head"></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- mock 数据 -->
    <div class="mock-data">
      <div class="mock-data-header">
        <span>数据预览（JSON 数组）</span>
        <el-space>
          <el-radio-group v-model="draft.dataSource" size="small">
            <el-radio-button value="mock">内置 mock</el-radio-button>
            <el-radio-button value="manual">手动 JSON</el-radio-button>
            <el-radio-button value="api" disabled>后端接口（待接入）</el-radio-button>
          </el-radio-group>
          <el-button size="small" @click="applyTemplateData">格式化</el-button>
        </el-space>
      </div>
      <el-input
        v-model="draft.manualDataJson"
        type="textarea"
        :rows="6"
        resize="vertical"
        spellcheck="false"
        class="mock-data-input"
      />
      <div v-if="dataParseError" class="parse-error">
        <el-text size="small" type="danger">JSON 解析错误：{{ dataParseError }}</el-text>
      </div>
      <div v-else class="mock-summary">
        <el-text size="small" type="success">已解析 {{ parsedMockData.length }} 条数据</el-text>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  background: #fafbfc;
}
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #fff;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}
.table-scroll {
  flex: 1;
  overflow: auto;
  padding: 12px;
  background: #f5f7fa;
}
.editor-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: #fff;
  border: 1px solid var(--el-border-color-light);
  border-radius: 4px;
  overflow: hidden;
}
.editor-table th,
.editor-table td {
  border-bottom: 1px solid var(--el-border-color-lighter);
  border-right: 1px solid var(--el-border-color-lighter);
  padding: 6px;
  vertical-align: top;
  background: #fff;
}
.editor-table th:last-child,
.editor-table td:last-child {
  border-right: none;
}
.editor-table tr:last-child td {
  border-bottom: none;
}
.col-head {
  background: #f5f7fa;
  min-width: 160px;
}
.row-head {
  background: #f5f7fa;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  padding: 6px 4px;
}
.col-head-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}
.col-head-row :deep(.el-input) {
  flex: 1;
}
.header-cell-input {
  margin-bottom: 4px;
}
.width-input {
  font-family: monospace;
}
.row-head-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.row-num {
  font-weight: 600;
  color: var(--el-color-primary);
}
.cell-clear {
  position: absolute;
  right: -2px;
  top: -2px;
  font-size: 10px;
  opacity: 0;
  transition: opacity 0.15s;
}
td:has(.cell-clear) {
  position: relative;
}
td:hover .cell-clear {
  opacity: 0.6;
}
.add-row-cell {
  text-align: center;
  background: #fafbfc;
}
.mock-data {
  border-top: 1px solid var(--el-border-color-lighter);
  background: #fff;
  padding: 10px 12px;
  flex-shrink: 0;
}
.mock-data-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.mock-data-input :deep(textarea) {
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: 12px;
}
.parse-error,
.mock-summary {
  margin-top: 4px;
}
code {
  background: #f5f7fa;
  padding: 1px 4px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 12px;
}
</style>
