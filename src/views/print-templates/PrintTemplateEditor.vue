<!--
  打印模板编辑器主页面（2026-09-14 新增）：
  - 三栏布局：左 TemplateListPanel / 中 TemplateTableEditor / 右 TemplatePreviewPanel
  - 顶部 bar：标题 + 当前模板名 + 保存 / 模板设置 / 打印
  - 「打印」按钮：加 .is-printing class 到 root + window.print()，afterprint 移除
  - @media print：仅显示 .print-preview-area
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { Document, Printer, Setting } from '@element-plus/icons-vue';
import TemplateListPanel from '@/views/print-templates/components/TemplateListPanel.vue';
import TemplateTableEditor from '@/views/print-templates/components/TemplateTableEditor.vue';
import TemplatePreviewPanel from '@/views/print-templates/components/TemplatePreviewPanel.vue';
import TemplateSettingsDialog from '@/views/print-templates/components/TemplateSettingsDialog.vue';
import { usePrintTemplates, createBlankTemplate } from '@/composables/usePrintTemplates';
import type { PrintTemplate } from '@/views/print-templates/types';

const { activeId, getById, upsert, setActive } = usePrintTemplates();

/** 当前选中的模板（来自 store）。 */
const storeTemplate = computed<PrintTemplate | null>(() => getById(activeId.value));

/** 本地编辑态：避免 store reload 把未保存改动冲掉。 */
const localTemplate = ref<PrintTemplate | null>(null);
/** 「是否有未保存修改」标记：仅用于顶部 bar 状态展示。 */
const isDirty = ref(false);

/** 监听 store 端 activeId 切换 → 同步到本地。 */
watch(
  () => storeTemplate.value,
  (next) => {
    localTemplate.value = next ? (JSON.parse(JSON.stringify(next)) as PrintTemplate) : null;
    isDirty.value = false;
  },
  { immediate: true },
);

/** 编辑器回写（update:modelValue from TemplateTableEditor）→ 更新本地。
 *  深比较防递归：TemplateTableEditor 内部 watch(draft, deep) 会因 props.modelValue
 *  变更触发 emit（即便内容相同，引用也变），如果不防抖会无限循环
 *  （parent → child → parent → child ...）。用 JSON 字符串深比较，
 *  真正修改才同步本地，避免死循环。 */
function onEditorUpdate(t: PrintTemplate): void {
  const incoming = JSON.stringify(t);
  const current = JSON.stringify(localTemplate.value);
  if (incoming === current) return;
  localTemplate.value = JSON.parse(incoming) as PrintTemplate;
  isDirty.value = true;
}

/** 左侧 create 事件：createBlankTemplate 已经写在 TemplateListPanel.onNew 里调用了 upsert，
 *  这里只需要同步 local。TemplateListPanel 会 emit('create')，但 store 侧已经 setActive，
 * 所以 watch(storeTemplate) 会自动同步。如果无 store 同步（比如 setActive 没触发 ref 变化），
 * 主动拉一次兜底。 */
function onListCreate(): void {
  // 兜底：store 的 activeId 可能没及时刷新
  if (storeTemplate.value) {
    localTemplate.value = JSON.parse(JSON.stringify(storeTemplate.value)) as PrintTemplate;
    isDirty.value = false;
  }
}

function onSave(): void {
  if (!localTemplate.value) {
    ElMessage.warning('没有可保存的模板');
    return;
  }
  upsert(JSON.parse(JSON.stringify(localTemplate.value)) as PrintTemplate);
  isDirty.value = false;
  ElMessage.success('已保存到本地存储');
}

/** 模板设置对话框 */
const settingsOpen = ref(false);

function onSettingsOpen(): void {
  if (!localTemplate.value) {
    ElMessage.warning('请先选择模板');
    return;
  }
  settingsOpen.value = true;
}

function onSettingsUpdate(t: PrintTemplate): void {
  // dialog 内部已经校验通过；只更新 name / paper / orientation / margin / customSize
  if (!localTemplate.value) return;
  localTemplate.value = {
    ...localTemplate.value,
    name: t.name,
    paper: t.paper,
    customWidthMm: t.customWidthMm,
    customHeightMm: t.customHeightMm,
    orientation: t.orientation,
    margin: t.margin,
  };
  isDirty.value = true;
}

/** 打印：root 加 .is-printing class → window.print() → afterprint 移除。 */
const isPrinting = ref(false);
function onPrint(): void {
  if (!localTemplate.value) {
    ElMessage.warning('没有可打印的模板');
    return;
  }
  isPrinting.value = true;
  // 等一帧让样式生效再调 print
  window.requestAnimationFrame(() => {
    window.print();
  });
}

function onAfterPrint(): void {
  isPrinting.value = false;
}

onMounted(() => {
  window.addEventListener('afterprint', onAfterPrint);
});

onBeforeUnmount(() => {
  window.removeEventListener('afterprint', onAfterPrint);
});

/** 顶部标题：没有模板时给空态文案。 */
const currentName = computed(() => localTemplate.value?.name ?? '');

/** 「新建模板」快捷入口（如果列表为空，bar 上也能建）。 */
function onQuickNew(): void {
  const tpl = createBlankTemplate(`新模板 ${Date.now().toString(36).slice(-4)}`);
  upsert(tpl);
  setActive(tpl.id);
}
</script>

<template>
  <div :class="['print-template-editor', { 'is-printing': isPrinting }]">
    <!-- 顶部 bar -->
    <div class="pte-topbar">
      <div class="pte-topbar-left">
        <span class="pte-title">打印模板编辑器</span>
        <span v-if="currentName" class="pte-subtitle">· {{ currentName }}</span>
        <el-tag v-if="isDirty" size="small" type="warning" effect="plain">有未保存修改</el-tag>
      </div>
      <div class="pte-topbar-right">
        <el-button :disabled="!localTemplate" @click="onQuickNew">
          <el-icon><Document /></el-icon>
          新建
        </el-button>
        <el-button type="primary" :disabled="!localTemplate" @click="onSave">保存</el-button>
        <el-button :disabled="!localTemplate" @click="onSettingsOpen">
          <el-icon><Setting /></el-icon>
          模板设置
        </el-button>
        <el-button type="primary" :disabled="!localTemplate" @click="onPrint">
          <el-icon><Printer /></el-icon>
          打印
        </el-button>
      </div>
    </div>

    <!-- 三栏布局 -->
    <div class="pte-body">
      <aside class="pte-aside-left">
        <TemplateListPanel @select="() => undefined" @create="onListCreate" />
      </aside>
      <main class="pte-main">
        <TemplateTableEditor :model-value="localTemplate" @update:model-value="onEditorUpdate" />
      </main>
      <aside class="pte-aside-right">
        <TemplatePreviewPanel :template="localTemplate" @print="onPrint" />
      </aside>
    </div>

    <!-- 模板设置 dialog -->
    <TemplateSettingsDialog
      v-model="settingsOpen"
      :template="localTemplate"
      @update:template="onSettingsUpdate"
    />
  </div>
</template>

<style scoped>
.print-template-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--content-bg);
}
.pte-topbar {
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
.pte-topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pte-title {
  font-size: 16px;
  font-weight: 600;
}
.pte-subtitle {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pte-topbar :deep(.el-tag) {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.4);
  color: #fff;
}
.pte-topbar :deep(.el-tag--warning) {
  background: #f8985;
}
.pte-topbar-right {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
/* 顶栏按钮：深色背景下用白底蓝字；EP 默认样式在 primary 背景上对比度差 */
.pte-topbar-right :deep(.el-button:not(.el-button--primary):not(.is-disabled)) {
  background: #fff;
  color: var(--el-color-primary);
  border-color: #fff;
}
.pte-topbar-right :deep(.el-button--primary) {
  background: #fff;
  color: var(--el-color-primary);
  border-color: #fff;
}
.pte-topbar-right :deep(.el-button.is-disabled) {
  background: rgba(255, 255, 255, 0.4);
  color: rgba(255, 255, 255, 0.7);
  border-color: transparent;
}
.pte-body {
  display: grid;
  grid-template-columns: 280px 1fr 480px;
  flex: 1;
  min-height: 0;
}
.pte-aside-left {
  background: #fff;
  border-right: 1px solid var(--el-border-color-lighter);
  min-height: 0;
  overflow: hidden;
}
.pte-main {
  background: #fff;
  min-height: 0;
  overflow: hidden;
}
.pte-aside-right {
  background: #f5f7fa;
  border-left: 1px solid var(--el-border-color-lighter);
  min-height: 0;
  overflow: hidden;
}

/* 打印态：只显示 .print-preview-area。 */
@media print {
  .print-template-editor .pte-topbar,
  .print-template-editor .pte-aside-left,
  .print-template-editor .pte-main,
  .print-template-editor .pte-aside-right,
  .print-template-editor :deep(.el-overlay),
  .print-template-editor :deep(.el-dialog) {
    display: none !important;
  }
  .print-template-editor.is-printing .pte-aside-right {
    display: block !important;
    width: 100%;
    height: 100vh;
    border: none;
    background: #fff;
  }
  .print-template-editor.is-printing .preview-toolbar {
    display: none !important;
  }
  .print-template-editor.is-printing .preview-scroll {
    padding: 0 !important;
    overflow: visible !important;
    height: auto !important;
  }
  .print-template-editor.is-printing .print-preview-area {
    box-shadow: none !important;
    margin: 0 auto !important;
  }
}
</style>
