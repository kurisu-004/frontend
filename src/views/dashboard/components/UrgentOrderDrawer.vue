<!--
  UrgentOrderDrawer.vue
  2026-09-29 新增：dashboard「紧急工单」右侧抽屉。

  形态：
    - 顶部 header：序号 + 图号 + 名称 + 客户路径 + 状态 ElTag + 大号倒计 chip
    - 主体 el-tabs 三 tab：图纸 / 详情 / 事件（事件 tab 占位）
    - 图纸 tab：调 usePartFilesListQuery(part.id) 拉 part 全量文件 → 过滤
      kind='DRAWING' → 第一张 PDF/图片展示（沿 DrawingPreviewPane.vue:130-192
      loadPreviewUrl 范式），blob URL 在 onBeforeUnmount URL.revokeObjectURL 释放

  Props / Events：
    - modelValue：boolean（v-model 双向绑定，控制 drawer 开关）
    - part：PartListItem | null（父组件传入选中行；null 表示未选）
    - @update:modelValue：双向同步
-->
<template>
  <el-drawer
    :model-value="modelValue"
    direction="rtl"
    :size="480"
    :with-header="false"
    :append-to-body="true"
    :destroy-on-close="true"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div v-if="!part" class="drawer-empty">
      <el-empty :image-size="60" description="请选择工单" />
    </div>

    <div v-else class="drawer-body">
      <!-- 顶部 header -->
      <div class="drawer-header">
        <div class="header-row-1">
          <span class="header-serial">{{ part.serial_no ?? '—' }}</span>
          <span class="header-drawing">{{ part.drawing_no }}</span>
          <el-tag :type="ORDER_STATUS_TAG_TYPE[part.status]" size="small" effect="plain">
            {{ ORDER_STATUS_LABEL[part.status] }}
          </el-tag>
        </div>
        <div class="header-row-2">
          <span class="header-name" :title="part.name">{{ part.name }}</span>
        </div>
        <div class="header-row-3">
          <span class="header-customer" :title="customerPath">
            <el-icon><OfficeBuilding /></el-icon>
            <span>{{ customerPath || '—' }}</span>
          </span>
          <span :class="['header-due', deliveryUrgencyClass(part.planned_delivery_date)]">
            <el-icon :size="14"><Clock /></el-icon>
            <span>
              {{ deliveryDaysLeftText(part.planned_delivery_date) || formatDeliveryDate(part.planned_delivery_date) || '未设交期' }}
            </span>
          </span>
        </div>
      </div>

      <!-- tabs -->
      <el-tabs v-model="activeTab" class="drawer-tabs">
        <!-- 图纸 tab -->
        <el-tab-pane label="图纸" name="drawings">
          <div v-if="filesLoading" class="tab-loading">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>加载文件中…</span>
          </div>
          <div v-else-if="filesError" class="tab-error">
            <el-icon color="#f56c6c"><WarningFilled /></el-icon>
            <span>{{ filesError }}</span>
          </div>
          <div v-else-if="!selectedFile" class="tab-empty">
            <el-empty description="该工单暂无图纸" :image-size="60" />
          </div>
          <div v-else class="tab-preview">
            <PdfViewer
              v-if="isPdf(selectedFile.file_type)"
              :key="selectedFile.id"
              :url="previewBlob ?? ''"
            />
            <el-image
              v-else-if="isImage(selectedFile.file_type)"
              :src="previewBlob ?? ''"
              :preview-src-list="previewBlob ? [previewBlob] : []"
              fit="contain"
              class="image-preview"
            />
            <div v-else class="tab-empty">
              <el-empty description="该文件类型暂不支持预览" :image-size="60" />
            </div>
          </div>
        </el-tab-pane>

        <!-- 详情 tab -->
        <el-tab-pane label="详情" name="details">
          <dl class="detail-list">
            <div class="detail-row">
              <dt>图号</dt>
              <dd>{{ part.drawing_no }}</dd>
            </div>
            <div class="detail-row">
              <dt>名称</dt>
              <dd>{{ part.name }}</dd>
            </div>
            <div class="detail-row">
              <dt>客户</dt>
              <dd>{{ customerPath || '—' }}</dd>
            </div>
            <div class="detail-row">
              <dt>数量</dt>
              <dd>{{ part.quantity }}</dd>
            </div>
            <div class="detail-row">
              <dt>订单号</dt>
              <dd>{{ part.order_no || '—' }}</dd>
            </div>
            <div class="detail-row">
              <dt>请购日期</dt>
              <dd>{{ part.request_date }}</dd>
            </div>
            <div class="detail-row">
              <dt>计划交期</dt>
              <dd>{{ part.planned_delivery_date || '—' }}</dd>
            </div>
            <div v-if="part.system_delivery_date" class="detail-row">
              <dt>系统交期</dt>
              <dd>{{ part.system_delivery_date }}</dd>
            </div>
            <div class="detail-row">
              <dt>申请人</dt>
              <dd>{{ part.applicant_name || '—' }}</dd>
            </div>
            <div class="detail-row">
              <dt>单价</dt>
              <dd>{{ part.unit_price || '—' }}</dd>
            </div>
            <div class="detail-row">
              <dt>总价</dt>
              <dd>{{ part.total_price || '—' }}</dd>
            </div>
            <div v-if="part.note" class="detail-row">
              <dt>备注</dt>
              <dd>{{ part.note }}</dd>
            </div>
          </dl>
        </el-tab-pane>

        <!-- 事件 tab（占位） -->
        <el-tab-pane label="事件" name="events">
          <div class="tab-empty">
            <el-empty description="事件历史功能开发中" :image-size="60" />
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
// 2026-09-29 新增：dashboard「紧急工单」右侧抽屉展示壳。
//
// 数据流：
//   1. props.part 切换 → usePartFilesListQuery(() => part?.id ?? null) 内部
//      queryKey computed 跟随变化；enabled 闸门 = !!part.id；
//   2. files = items.filter(f => f.kind === 'DRAWING' && (isPdf / isImage))，
//      取第一张做 selectedFile；
//   3. selectedFile 变化 → watch(loadPreviewUrl) 拉 fetchPartFileContent(id) blob
//      + URL.createObjectURL；
//   4. onBeforeUnmount URL.revokeObjectURL 释放 blob（防内存泄漏，沿
//      DrawingPreviewPane.vue 范式）。
//
// 视觉：
//   - 顶部 header 序列号 / 图号 / 客户 / 大号倒计 chip（沿用 deliveryDaysLeftText）
//   - 倒计 chip 颜色与 UrgentOrdersList 行底色一致：overdue → 红色、due-soon → 橙色
//   - tabs：图纸 / 详情 / 事件（事件 tab 占位「未来接入 part-events」）

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  Clock,
  Loading,
  OfficeBuilding,
  WarningFilled,
} from '@element-plus/icons-vue';
import { usePartFilesListQuery } from '@/composables/queries/usePartFilesListQuery';
import { fetchPartFileContent } from '@/api/parts/file';
import PdfViewer from '@/components/PdfViewer.vue';
import {
  deliveryDaysLeftText,
  deliveryUrgencyClass,
  formatDeliveryDate,
} from '@/utils/deliveryDate';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  type PartListItem,
} from '@/types/parts';
import type { PartFileSchema } from '@/composables/queries/schemas';

const props = defineProps<{
  modelValue: boolean;
  part: PartListItem | null;
}>();

const emit = defineEmits<(e: 'update:modelValue', v: boolean) => void>();

const activeTab = ref<'drawings' | 'details' | 'events'>('drawings');

/** 客户路径展示 —— l1 + customer（如有）。 */
const customerPath = computed<string>(() => {
  const l1 = props.part?.l1_customer_name ?? '';
  const cur = props.part?.customer_name ?? '';
  if (l1 && cur && l1 !== cur) return `${l1} / ${cur}`;
  return cur || l1;
});

// ============ 文件查询（lazy fetch 闸门） ============
// usePartFilesListQuery reactive ownerPartId：part 变化自动 refetch；
// enabled 闸门 = !!part.id；part === null 时不发请求。
const filesQuery = usePartFilesListQuery(() => props.part?.id ?? null);
const files = computed<PartFileSchema[]>(() => filesQuery.data.value?.items ?? []);
const filesLoading = computed(() => filesQuery.isFetching.value);
const filesError = computed<string | null>(() => {
  const e = filesQuery.error.value;
  return e ? e.message : null;
});

/** 2026-09-29 新增：过滤 kind='DRAWING' 的 PDF / 图片，取第一张作为 selectedFile。 */
const selectedFile = computed<PartFileSchema | null>(() => {
  const drawings = files.value.filter(
    (f) => f.kind === 'DRAWING' && (isPdf(f.file_type) || isImage(f.file_type)),
  );
  return drawings[0] ?? null;
});

// ============ PDF / 图片 blob URL（沿 DrawingPreviewPane.vue:148-176 范式） ============
const previewBlob = ref<string | null>(null);
const previewLoading = ref(false);
const currentPreviewFileId = ref<string | null>(null);

async function loadPreviewUrl(file: PartFileSchema): Promise<void> {
  if (currentPreviewFileId.value === file.id) return; // 同文件短路
  revokePreviewBlob();
  previewLoading.value = true;
  try {
    const blob = await fetchPartFileContent(file.id);
    previewBlob.value = URL.createObjectURL(blob);
    currentPreviewFileId.value = file.id;
  } catch (e) {
    console.error('fetch preview error', e);
  } finally {
    previewLoading.value = false;
  }
}

function revokePreviewBlob(): void {
  if (previewBlob.value) {
    URL.revokeObjectURL(previewBlob.value);
    previewBlob.value = null;
  }
  currentPreviewFileId.value = null;
}

watch(
  [selectedFile, activeTab],
  async ([f, tab]) => {
    if (tab === 'drawings' && f) await loadPreviewUrl(f);
    else revokePreviewBlob();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  revokePreviewBlob();
});

// ============ helpers ============
function isPdf(t: string): boolean {
  return t.toUpperCase() === 'PDF';
}
function isImage(t: string): boolean {
  const up = t.toUpperCase();
  return ['PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'WEBP'].includes(up);
}
</script>

<style lang="scss" scoped>
.drawer-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.drawer-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.drawer-header {
  padding: 16px 18px 12px;
  border-bottom: 1px solid #eee;
  background: #fafbfc;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.header-row-1 {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.header-serial {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--el-color-primary-light-9);
  color: var(--primary-color);
  padding: 2px 8px;
  border-radius: 4px;
}
.header-drawing {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text-secondary);
}
.header-row-2 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.header-row-3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
.header-customer {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.header-due {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  font-size: 13px;
  &.overdue {
    color: var(--el-color-danger);
  }
  &.due-soon {
    color: var(--el-color-warning);
  }
}
.drawer-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 12px;
  :deep(.el-tabs__content) {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  :deep(.el-tab-pane) {
    height: 100%;
  }
}
.tab-loading,
.tab-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 0;
  font-size: 13px;
  color: var(--text-secondary);
}
.tab-error {
  color: var(--el-color-danger);
}
.tab-empty {
  padding: 40px 0;
  display: flex;
  justify-content: center;
}
.tab-preview {
  height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: #fafbfc;
  padding: 8px;
}
.image-preview {
  max-width: 100%;
  max-height: 70vh;
  display: block;
  margin: 0 auto;
}
.detail-list {
  margin: 0;
  padding: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.detail-row {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 8px;
  font-size: 13px;
  dt {
    color: var(--text-secondary);
  }
  dd {
    margin: 0;
    color: var(--text-primary);
    word-break: break-all;
  }
}
</style>
