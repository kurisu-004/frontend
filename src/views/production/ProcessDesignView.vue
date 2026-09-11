<!--
  ProcessDesignView.vue
  工序制定页（三栏布局：左 PartPicker / 中 DrawingPreview / 右 ProcessStepCardList）。
  2026-09-11 新增。

  阶段一（mock）：composable 内部直接读 fixtures，零件/工序都从 fixture 加载；
  localStorage 持久化流程编辑。阶段二切真接口后，composable 内 listParts / listProcesses
  替换为 apiV2 调用，新增 apiV2.post(...) 提交流程表，CLAUDE.md #2 合规。
-->
<template>
  <div class="process-design">
    <el-card shadow="never" class="layout-card">
      <div class="layout">
        <!-- 左：PartPickerList -->
        <div class="pane-left">
          <PartPickerList :selected-part-id="selectedPartId" @select="onSelectPart" />
        </div>

        <!-- 中：DrawingPreviewPane -->
        <div class="pane-center">
          <DrawingPreviewPane :part="selectedPart" />
        </div>

        <!-- 右：ProcessStepCardList -->
        <div class="pane-right">
          <ProcessStepCardList :part-id="selectedPartId" />
        </div>
      </div>
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

const { parts, loadParts, loadProcesses } = usePartProcessDesign()

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
  }
}
.layout {
  display: flex;
  gap: 16px;
  height: 100%;
  min-height: 480px;
}
.pane-left {
  flex: 0 0 320px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.pane-center {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.pane-right {
  flex: 1.2;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
</style>
