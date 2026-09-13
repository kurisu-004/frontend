<!--
  模板列表面板（2026-09-14 新增）：
  - 列出所有已保存模板 + 「新建模板」/「复制」/「删除」操作。
  - 当前选中模板高亮；点击切换由父组件 watch activeId 加载到编辑器。
-->
<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, DocumentCopy, Plus } from '@element-plus/icons-vue';
import {
  usePrintTemplates,
  createBlankTemplate,
  cloneTemplate,
} from '@/composables/usePrintTemplates';
import type { PrintTemplate } from '@/views/print-templates/types';

const emit = defineEmits<{
  /** 父组件决定加载/卸载逻辑；这里只发信号。 */
  select: [template: PrintTemplate];
  /** 「新建模板」快捷入口触发：父组件新建并切到草稿态。 */
  create: [];
}>();

const { templates, activeId, upsert, remove, setActive } = usePrintTemplates();

function onSelect(t: PrintTemplate): void {
  setActive(t.id);
  emit('select', t);
}

function onNew(): void {
  const tpl = createBlankTemplate(`新模板 ${templates.value.length + 1}`);
  upsert(tpl);
  setActive(tpl.id);
  emit('select', tpl);
  emit('create');
}

async function onClone(t: PrintTemplate): Promise<void> {
  const copy = cloneTemplate(t);
  upsert(copy);
  setActive(copy.id);
  emit('select', copy);
  ElMessage.success(`已复制为「${copy.name}」`);
}

async function onDelete(t: PrintTemplate): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除「${t.name}」？此操作不可撤销。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  remove(t.id);
  ElMessage.success('已删除');
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
</script>

<template>
  <div class="tpl-list-panel">
    <div class="tpl-list-header">
      <span class="title">打印模板</span>
      <el-button type="primary" size="small" @click="onNew">
        <el-icon><Plus /></el-icon>
        新建
      </el-button>
    </div>

    <div class="tpl-list-body">
      <el-empty
        v-if="!templates.length"
        description="暂无模板，点击「新建」开始"
        :image-size="80"
      />
      <ul v-else class="tpl-list">
        <li
          v-for="t in templates"
          :key="t.id"
          :class="['tpl-item', { active: t.id === activeId }]"
          @click="onSelect(t)"
        >
          <div class="tpl-item-main">
            <div class="tpl-name">{{ t.name }}</div>
            <div class="tpl-meta">
              {{ t.paper }} · {{ t.orientation === 'portrait' ? '纵向' : '横向' }} ·
              {{ t.columns.length }} 列 · 更新于 {{ formatDate(t.updatedAt) }}
            </div>
          </div>
          <div class="tpl-item-actions" @click.stop>
            <el-tooltip content="复制" placement="top">
              <el-button size="small" link @click="onClone(t)">
                <el-icon><DocumentCopy /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="删除" placement="top">
              <el-button size="small" link type="danger" @click="onDelete(t)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.tpl-list-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
  border-right: 1px solid var(--el-border-color-lighter);
}
.tpl-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: #fafbfc;
}
.title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.tpl-list-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}
.tpl-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tpl-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background-color 0.15s ease;
}
.tpl-item:hover {
  background: #f5f7fa;
}
.tpl-item.active {
  background: #ecf5ff;
  border-left-color: var(--el-color-primary);
}
.tpl-item-main {
  flex: 1;
  min-width: 0;
}
.tpl-name {
  font-size: 14px;
  color: var(--el-text-color-primary);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tpl-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}
.tpl-item-actions {
  display: flex;
  gap: 4px;
  opacity: 0.6;
  transition: opacity 0.15s ease;
}
.tpl-item:hover .tpl-item-actions {
  opacity: 1;
}
</style>
