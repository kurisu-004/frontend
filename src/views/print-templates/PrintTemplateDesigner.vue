<!--
  表格编辑器（2026-09-16 改造）：
  - 替换原 @amdosion/vue3-print 包版设计器为 X-spreadsheet 表格编辑器
    （包名 x-data-spreadsheet@1.1.9）。原方案需要打印模板坐标 / 数据绑定 / 元素层
    等较重的可视化设计，本期简化成"通用表格编辑器"，用户可直接编辑二维表内容。
  - 顶部 bar：标题 + 一行说明 + 「重置示例」按钮（仅清回示例 5x5 数据，不持久化）。
  - 主区域：x-spreadsheet 实例化的容器，showToolbar/showGrid/showContextmenu 全开，
    视图尺寸 view.height=600 / view.width=容器 clientWidth。
  - 数据完全 in-memory：刷新页面即清空，**不**写 localStorage、不做导入/导出/保存。
  - 路由级 CSS import：x-data-spreadsheet 的样式只在加载本 view 时打入。
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
// x-data-spreadsheet 是 CommonJS 包，运行时仅依赖 DOM API（仅客户端）。
// 2026-09-16：xspreadsheet.css 由路由级 import 在本 view 顶部引入，避免污染其它路由。
import 'x-data-spreadsheet/dist/xspreadsheet.css';
import Spreadsheet, { type SheetData } from 'x-data-spreadsheet';
// @ts-expect-error - x-data-spreadsheet/types 仅声明根模块，未声明子路径 src/locale/* 的导出形态
import zhCn from 'x-data-spreadsheet/src/locale/zh-cn.js';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';

/** X-spreadsheet 实例（仅 onMounted 后挂载）。 */
const sheet = ref<Spreadsheet | null>(null);
/** 容器 DOM ref。 */
const sheetEl = ref<HTMLDivElement | null>(null);

/** 5 行 × 5 列示例数据（name / qty / unit / note / price）。 */
const SAMPLE_ROWS = 5;
const SAMPLE_COLS = 5;
const sampleData = (): SheetData => {
  const colLabels = ['名称', '数量', '单位', '备注', '单价'];
  const cols: NonNullable<SheetData['cols']> = {
    len: SAMPLE_COLS,
  };
  for (let i = 0; i < SAMPLE_COLS; i += 1) {
    cols[i] = { width: 120 };
  }
  const rows: NonNullable<SheetData['rows']> = {};
  for (let r = 0; r < SAMPLE_ROWS; r += 1) {
    const cells: NonNullable<SheetData['rows']>[number]['cells'] = {};
    for (let c = 0; c < SAMPLE_COLS; c += 1) {
      const sample = [
        `零件 ${r + 1}-${c + 1}`,
        String((r + 1) * (c + 1)),
        '件',
        c === 3 ? '示例备注' : '',
        c === 4 ? String(((r + 1) * 10).toFixed(2)) : '',
      ];
      cells[c] = { text: sample[c] ?? '' };
    }
    // x-spreadsheet 用字符串 key 索引 row/cell，这里强制断言成 numeric-keyed record。
    rows[r] = { cells: cells as unknown as NonNullable<SheetData['rows']>[number]['cells'] };
  }
  // setData 的 cols 期望是 Record<string, ColProperties>，与 SheetData['cols'] 的 numeric-keyed 不完全匹配，
  // 实际运行时两边都能接受。这里 cast 一下避免类型警告轰炸。
  const data: SheetData = {
    name: 'sheet1',
    rows: rows as unknown as SheetData['rows'],
    cols: cols as unknown as SheetData['cols'],
  };
  // 第一列放列名作为展示（x-spreadsheet 默认 row[0] 不是 header，靠 cols 的 label？实际 cols.label 不存在；
  // 用户首屏看到的"行 1 / 列 1"是默认坐标。我们用 row[0] 当中文表头更直观——追加一行）。
  const headerCells: Record<number, { text: string }> = {};
  for (let c = 0; c < SAMPLE_COLS; c += 1) {
    headerCells[c] = { text: colLabels[c] ?? `列${c + 1}` };
  }
  // 把示例数据 row[r] 的索引从 r+1 开始，让 row[0] 作为中文表头。
  const newRows: Record<number, { cells: Record<number, { text: string }> }> = {};
  newRows[0] = { cells: headerCells };
  for (let r = 0; r < SAMPLE_ROWS; r += 1) {
    newRows[r + 1] = rows[r] as { cells: Record<number, { text: string }> };
  }
  data.rows = newRows as unknown as SheetData['rows'];
  return data;
};

onMounted(() => {
  if (!sheetEl.value) return;
  // 注册中文 locale（x-spreadsheet 默认英文）：先注册再实例化，否则 menu 还是英文。
  Spreadsheet.locale('zh-cn', zhCn);
  sheet.value = new Spreadsheet(sheetEl.value, {
    showToolbar: true,
    showGrid: true,
    showContextmenu: true,
    view: {
      height: () => 600,
      width: () => sheetEl.value?.clientWidth ?? 800,
    },
  });
  // x-spreadsheet 构造器不消费 options.data，初始数据通过 loadData 注入。
  sheet.value.loadData([sampleData()]);
});

onUnmounted(() => {
  // x-spreadsheet 实例本身会往 DOM 注入大量节点并挂监听；清空容器即可。
  if (sheetEl.value) sheetEl.value.innerHTML = '';
  sheet.value = null;
});

/** 重置示例：把当前 sheet 数据回退到初始 5x5 样本。 */
function onResetClick(): void {
  if (!sheet.value || !sheetEl.value) return;
  sheet.value.loadData([sampleData()]);
  ElMessage.success('已重置为示例数据');
}
</script>

<template>
  <div class="xss-designer">
    <!-- 顶部 bar：标题 + 说明 + 重置按钮 -->
    <div class="xss-topbar">
      <div class="xss-topbar-left">
        <span class="xss-title">表格编辑器</span>
        <span class="xss-subtitle">基于 X-spreadsheet，编辑内容仅在本会话保留（刷新清空）</span>
      </div>
      <div class="xss-topbar-right">
        <el-button @click="onResetClick">
          <el-icon><Refresh /></el-icon>
          重置示例
        </el-button>
      </div>
    </div>

    <!-- X-spreadsheet 容器（实例化由 onMounted 完成） -->
    <div ref="sheetEl" class="xss-host"></div>
  </div>
</template>

<style scoped>
.xss-designer {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--content-bg);
}
.xss-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 20px;
  background: var(--el-color-primary);
  color: #fff;
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
  gap: 16px;
}
.xss-topbar-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.xss-title {
  font-size: 16px;
  font-weight: 600;
  flex-shrink: 0;
}
.xss-subtitle {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.xss-topbar-right {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.xss-topbar-right :deep(.el-button) {
  background: #fff;
  color: var(--el-color-primary);
  border-color: #fff;
}
.xss-host {
  flex: 1;
  min-height: 600px;
  background: #fff;
  overflow: auto;
}
</style>
