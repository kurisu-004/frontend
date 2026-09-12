<!--
  ProcessDesignView.vue
  工序制定页（三栏 splitter 布局：左 PartPicker / 中 DrawingPreview / 右 ProcessStepCardList）。
  2026-09-11 新增。
  2026-09-12 改造：CSS flex → <el-splitter> 三栏可拖拽，宽度持久化到 localStorage
                   （src/composables/useResizablePane.ts，key='process_design_layout'）。

  阶段一（mock）：composable 内部直接读 fixtures，零件/工序都从 fixture 加载；
  localStorage 持久化流程编辑。阶段二切真接口后，composable 内 listParts / listProcesses
  替换为 apiV2 调用，新增 apiV2.post(...) 提交流程表，CLAUDE.md #2 合规。
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
        <el-splitter-panel :size="pane.rightSize.value" :min="320">
          <ProcessStepCardList :part-id="selectedPartId" />
        </el-splitter-panel>
      </el-splitter>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PartListItem } from '@/types/parts'
import PartPickerList from './components/PartPickerList.vue'
import DrawingPreviewPane from './components/DrawingPreviewPane.vue'
import ProcessStepCardList from './components/ProcessStepCardList.vue'
import { usePartProcessDesign } from './composables/usePartProcessDesign'
import { useResizablePane } from '@/composables/useResizablePane'

const { parts, loadParts, loadProcesses } = usePartProcessDesign()

// 2026-09-12 新增：三栏宽度持久化。默认 20% / 60% / 20%，中间图纸占主。
const pane = useResizablePane('process_design_layout', { left: 20, center: 60, right: 20 })

const selectedPartId = ref<string | null>(null)

const selectedPart = computed<PartListItem | null>(() => {
  if (!selectedPartId.value) return null
  return parts.value.find((p) => p.id === selectedPartId.value) ?? null
})

function onSelectPart(partId: string): void {
  selectedPartId.value = partId
}

onMounted(async () => {
  await Promise.all([loadParts(), loadProcesses()])
  // 默认选中第一个有流程的零件，方便用户首次进入就看到示例
  const seeded = ['5000000000001', '5000000000003']
  const first = parts.value.find((p) => seeded.includes(p.id))
  if (first) selectedPartId.value = first.id
})
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
