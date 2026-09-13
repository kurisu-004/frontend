<!--
  打印模板设计器（2026-09-14 重写）：
  - 用 `@amdosion/vue3-print` 包（design API + PrintTemplate）替代旧自研三栏实现。
  - 顶部 bar：模板名（可改名）+ 保存 / 加载 / 导出 JSON / 打印预览。
  - 主区域：包版设计器（左组件面板 + 中画布 + 右属性面板 + 顶工具栏）。
  - 底部 bar：mock 数据 textarea（用于打印预览的占位数据）。
  - 模板存储走模块级 composable `useAmdPrintTemplates`（localStorage 持久化）。
  - 路由级 CSS import：vue3-print.css / print-lock.css 只在加载本 view 时打入。
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue';
import {
  hiprint,
  defaultElementTypeProvider,
  type DesignerController,
  type PrintTemplate,
  type TemplateJson,
} from '@amdosion/vue3-print';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Document, FolderOpened, Promotion, Printer, Refresh } from '@element-plus/icons-vue';

// 路由级 CSS（2026-09-14 调整）：之前放在 main.ts 全量 import，会污染所有页面。
// 改成在 view 顶部 import，配合 lazy chunk 自然隔离，访问其他路由时不会下载。
import '@amdosion/vue3-print/dist/vue3-print.css';
import '@amdosion/vue3-print/dist/print-lock.css';

import {
  useAmdPrintTemplates,
  createBlankTemplate,
  type AmdPrintTemplate,
} from '@/composables/useAmdPrintTemplates';

const store = useAmdPrintTemplates();

/** 当前在设计器里编辑的模板 json（每次 toolbar onSave 都会刷新）。 */
const currentJson = ref<TemplateJson | null>(null);
/** 当前模板的 name（独立存于 composable 层，不依赖解析 JSON）。 */
const currentName = ref<string>('');
/** 包版 PrintTemplate 实例：buildDesigner 的 onReady 回调里捕获，用于主动 push 到设计器。 */
let tpl: PrintTemplate | null = null;
let designer: DesignerController | undefined;

const MOCK_DATA_DEFAULT = JSON.stringify(
  [
    { name: '示例 1', qty: 3, note: '第一行' },
    { name: '示例 2', qty: 7, note: '第二行' },
  ],
  null,
  2,
);
/** 打印预览用的 mock 数据（JSON 数组）。 */
const mockDataText = ref<string>(MOCK_DATA_DEFAULT);

const templateCount = computed(() => store.templates.value.length);

onMounted(() => {
  hiprint.init({
    providers: [new defaultElementTypeProvider()],
    lang: 'zh-CN',
  });
  designer = hiprint.buildDesigner('#hiprintDesigner', {
    templateOptions: {
      template: {
        panels: [{ paperType: 'A4', width: 210, height: 297, printElements: [] }],
      },
      history: true,
    },
    toolbarOptions: {
      showPanelManager: true,
      onSave: (next: PrintTemplate) => {
        currentJson.value = next.getJson();
        ElMessage.success('已捕获当前模板 JSON（可点击顶部「保存」持久化）');
      },
      onPrint: (next: PrintTemplate) => {
        runPrint(next);
      },
    },
    onReady: (next: PrintTemplate) => {
      tpl = next;
    },
  }) as DesignerController;
});

onUnmounted(() => {
  designer?.destroy();
  tpl = null;
});

/** 把当前模板 JSON 写入 storage（带改名 prompt）。 */
async function onSaveClick(): Promise<void> {
  const json = currentJson.value ?? tpl?.getJson() ?? null;
  if (!json) {
    ElMessage.warning('设计器内还没有可保存的模板');
    return;
  }
  let name = currentName.value || '未命名模板';
  if (!currentName.value) {
    // 第一次保存：弹 prompt 让用户命名。
    try {
      const { value } = await ElMessageBox.prompt('请输入模板名', '保存模板', {
        inputValue: '新模板',
        inputValidator: (v) => (v.trim() ? true : '模板名不能为空'),
        confirmButtonText: '保存',
        cancelButtonText: '取消',
      });
      name = value.trim();
    } catch {
      // 用户点取消：什么都不做
      return;
    }
  }
  const existing = store.getById(store.activeId.value);
  const next: AmdPrintTemplate = existing
    ? { ...existing, name, json }
    : { ...createBlankTemplate(name), name, json };
  store.upsert(next);
  store.setActive(next.id);
  currentName.value = next.name;
  ElMessage.success(`已保存「${next.name}」到本地存储`);
}

/** 弹对话框列出已存模板，单击选 → 推回设计器。 */
async function onLoadClick(): Promise<void> {
  const items = store.list();
  if (items.length === 0) {
    ElMessage.warning('本地还没有任何模板，先保存一份吧');
    return;
  }
  // 自定义 HTML 列表 + radio：选中的 id 通过 querySelector 重读（EP MessageBox
  // 的 inputType:'radio' 在 2.7 没有完整 value 回调，所以走 HTML 渲染 + DOM
  // 抓取方式更稳）。dangerouslyUseHTMLString 开了，所有转义都在手工拼接时做完。
  const radios = items
    .map(
      (t) =>
        `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 4px;border-radius:4px;">` +
        `<input type="radio" name="amd-tpl-radio" value="${escapeAttr(t.id)}" style="margin:0;">` +
        `<span>${escapeHtml(t.name)}（更新于 ${escapeHtml(new Date(t.updatedAt).toLocaleString())}）</span>` +
        `</label>`,
    )
    .join('');
  try {
    await ElMessageBox({
      title: '选择要加载的模板',
      message: `<div style="display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto;">${radios}</div>`,
      dangerouslyUseHTMLString: true,
      confirmButtonText: '加载',
      cancelButtonText: '取消',
      showCancelButton: true,
    });
    // 用户点「加载」成功（未抛 cancel）：querySelector 取选中的 radio value
    const checked = document.querySelector<HTMLInputElement>('input[name="amd-tpl-radio"]:checked');
    if (!checked) {
      ElMessage.warning('请先选择一个模板');
      return;
    }
    const target = store.getById(checked.value);
    if (!target) {
      ElMessage.error('模板不存在或已被删除');
      return;
    }
    if (!tpl) {
      ElMessage.error('设计器还没就绪');
      return;
    }
    tpl.update(target.json);
    store.setActive(target.id);
    currentJson.value = target.json;
    currentName.value = target.name;
    ElMessage.success(`已加载「${target.name}」到设计器`);
  } catch {
    // 用户点「取消」
  }
}

/** HTML 实体转义（attr 值）：防注入 / 破坏引号。 */
function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** HTML 实体转义（文本节点）：防注入。 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** 把当前模板 JSON 序列化成文件下载。 */
function onExportClick(): void {
  const json = currentJson.value ?? tpl?.getJson();
  if (!json) {
    ElMessage.warning('设计器内还没有可导出的模板');
    return;
  }
  const blob = new Blob([JSON.stringify(json, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentName.value || 'amd-template'}_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 用 textarea 里的 mock 数据调 `tpl.print()`。 */
async function runPrint(source?: PrintTemplate): Promise<void> {
  const target = source ?? tpl;
  if (!target) {
    ElMessage.warning('设计器还没就绪');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(mockDataText.value);
  } catch (e) {
    ElMessage.error(`mock 数据不是合法 JSON：${(e as Error).message}`);
    return;
  }
  if (!Array.isArray(parsed)) {
    ElMessage.warning('mock 数据必须是 JSON 数组');
    return;
  }
  // headless 环境 iframe.print() 会被 Playwright 接住；浏览器里会弹系统打印对话框。
  target.print(parsed);
  ElMessage.success(`已触发打印预览（${parsed.length} 行）`);
}

/** 改名快捷入口：直接在 bar 上 edit。 */
async function onRenameClick(): Promise<void> {
  if (!store.activeId.value) {
    ElMessage.warning('先加载或保存一个模板才能改名');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt('请输入新模板名', '重命名模板', {
      inputValue: currentName.value,
      inputValidator: (v) => (v.trim() ? true : '模板名不能为空'),
    });
    store.rename(store.activeId.value, value.trim());
    currentName.value = value.trim();
    ElMessage.success('已重命名');
  } catch {
    // 取消
  }
}

/** 清空 localStorage（调试入口，探针期暂留）。 */
function onResetClick(): void {
  ElMessageBox.confirm('确认清空所有打印模板？此操作不可恢复。', '清空模板', {
    confirmButtonText: '确认清空',
    cancelButtonText: '取消',
    type: 'warning',
  })
    .then(() => {
      store._reset();
      currentName.value = '';
      currentJson.value = null;
      ElMessage.success('已清空');
    })
    .catch(() => {
      /* cancel */
    });
}
</script>

<template>
  <div class="amd-print-designer">
    <!-- 顶部 bar：模板名 + 保存 / 加载 / 导出 / 打印预览 -->
    <div class="amd-topbar">
      <div class="amd-topbar-left">
        <span class="amd-title">打印模板设计器</span>
        <span v-if="currentName" class="amd-subtitle">· {{ currentName }}</span>
        <span v-else class="amd-subtitle amd-subtitle--muted">· 尚未命名</span>
        <el-tag size="small" type="info" effect="plain">已存 {{ templateCount }}</el-tag>
      </div>
      <div class="amd-topbar-right">
        <el-button :disabled="!store.activeId.value" @click="onRenameClick">
          <el-icon><Document /></el-icon>
          改名
        </el-button>
        <el-button @click="onLoadClick">
          <el-icon><FolderOpened /></el-icon>
          加载
        </el-button>
        <el-button type="primary" @click="onSaveClick">
          <el-icon><Document /></el-icon>
          保存
        </el-button>
        <el-button @click="onExportClick">
          <el-icon><Promotion /></el-icon>
          导出 JSON
        </el-button>
        <el-button type="primary" @click="runPrint()">
          <el-icon><Printer /></el-icon>
          打印预览
        </el-button>
        <el-button :disabled="templateCount === 0" @click="onResetClick">
          <el-icon><Refresh /></el-icon>
          清空
        </el-button>
      </div>
    </div>

    <!-- 包版设计器（buildDesigner 自动挂载） -->
    <div class="amd-designer-host">
      <div id="hiprintDesigner" class="amd-designer-canvas"></div>
    </div>

    <!-- 底部 mock 数据条：用于打印预览的占位 JSON 数组 -->
    <div class="amd-mock-bar">
      <span class="amd-mock-label">打印预览 mock 数据（JSON 数组）：</span>
      <el-input
        v-model="mockDataText"
        type="textarea"
        :rows="3"
        resize="none"
        placeholder='[{"name":"...","qty":1}]'
        spellcheck="false"
      />
    </div>
  </div>
</template>

<style scoped>
.amd-print-designer {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--content-bg);
}
.amd-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 20px;
  background: var(--el-color-primary);
  color: #fff;
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
}
.amd-topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.amd-title {
  font-size: 16px;
  font-weight: 600;
}
.amd-subtitle {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.amd-subtitle--muted {
  color: rgba(255, 255, 255, 0.55);
  font-style: italic;
}
.amd-topbar :deep(.el-tag) {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.4);
  color: #fff;
}
.amd-topbar-right {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.amd-topbar-right :deep(.el-button:not(.el-button--primary):not(.is-disabled)) {
  background: #fff;
  color: var(--el-color-primary);
  border-color: #fff;
}
.amd-topbar-right :deep(.el-button--primary) {
  background: #fff;
  color: var(--el-color-primary);
  border-color: #fff;
}
.amd-topbar-right :deep(.el-button.is-disabled) {
  background: rgba(255, 255, 255, 0.4);
  color: rgba(255, 255, 255, 0.7);
  border-color: transparent;
}
.amd-designer-host {
  flex: 1;
  min-height: 0;
  background: #fff;
  overflow: hidden;
}
.amd-designer-canvas {
  height: 100%;
  width: 100%;
  min-height: 600px;
}
.amd-mock-bar {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 20px;
  background: #f5f7fa;
  border-top: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}
.amd-mock-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  padding-top: 6px;
  flex-shrink: 0;
}
.amd-mock-bar :deep(.el-textarea) {
  flex: 1;
}
.amd-mock-bar :deep(.el-textarea__inner) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  min-height: 64px;
}
</style>
