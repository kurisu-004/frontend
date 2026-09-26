<!--
  ProcessDesignView.vue
  工序制定页（三栏 splitter 布局：左 PartPicker / 中 DrawingPreview / 右 ProcessStepCardList）。
  2026-09-11 新增。
  2026-09-12 改造：CSS flex → <el-splitter> 三栏可拖拽，宽度持久化到 localStorage
                   （views/production/composables/useResizablePane.ts，key='process_design_layout'）。
  2026-09-14 改造：切真接口后，删除「默认选中种子零件」逻辑（fixture-only）；
                   改为「选中第一个零件」或保持空态让用户手动选。composable 内
                   loadParts / loadProcesses / loadFlowForPart 均走 `api`（2026-09-15
                   Phase 5 业务全切 v2 后 baseURL `/api/v2`，原 `apiV2` 已合并删除）。
-->
<template>
  <div class="process-design">
    <el-card shadow="never" class="layout-card">
      <el-splitter class="layout-splitter" @resize-end="pane.onResizeEnd">
        <!-- 左：PartPickerList -->
        <el-splitter-panel :size="pane.leftSize.value" :min="240">
          <PartPickerList :selected-part-id="selectedPartId" @select="onSelectPart" />
        </el-splitter-panel>

        <!-- 中：DrawingPreviewPane -->
        <el-splitter-panel :size="pane.centerSize.value" :min="400">
          <DrawingPreviewPane :part="selectedPart" />
        </el-splitter-panel>

        <!-- 右：ProcessStepCardList -->
        <!-- 2026-09-12 第三轮：右栏加 :max="'20%'" 限制最大宽度，drag 超过自动回弹。 -->
        <el-splitter-panel :size="pane.rightSize.value" :min="320" max="20%">
          <ProcessStepCardList :part-id="selectedPartId" />
        </el-splitter-panel>
      </el-splitter>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { PartListItem } from '@/types/parts';
import PartPickerList from './components/PartPickerList.vue';
import DrawingPreviewPane from './components/DrawingPreviewPane.vue';
import ProcessStepCardList from './components/ProcessStepCardList.vue';
import { usePartProcessDesign } from './composables/usePartProcessDesign';
import { useResizablePane } from '@/views/production/composables/useResizablePane';

const { parts, loadParts, loadProcesses } = usePartProcessDesign();

// 2026-09-12 新增：三栏宽度持久化。默认 20% / 60% / 20%，中间图纸占主。
const pane = useResizablePane('process_design_layout', { left: 20, center: 60, right: 20 });

const selectedPartId = ref<string | null>(null);

const selectedPart = computed<PartListItem | null>(() => {
  if (!selectedPartId.value) return null;
  return parts.value.find((p) => p.id === selectedPartId.value) ?? null;
});

function onSelectPart(partId: string): void {
  selectedPartId.value = partId;
}

onMounted(async () => {
  await Promise.all([loadParts(), loadProcesses()]);
  // 2026-09-14：不再有 fixture 种子零件；保持未选中态让用户手动选（与生产对齐）。
  // 旧 fixture 模式下默认选中 `5000000000001`/`5000000000003` 是为了 demo；切真接口后
  // 这些 ID 在生产数据库不一定存在，留空让用户从左栏列表选。
});
</script>

<style lang="scss" scoped>
.process-design {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - 160px);
}
.layout-card {
  flex: 1;
  min-height: 0;
  :deep(.el-card__body) {
    height: 100%;
    padding: 8px;
  }
}
.layout-splitter {
  height: 100%;
}
</style>
