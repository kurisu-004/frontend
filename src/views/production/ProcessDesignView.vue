<!--
  ProcessDesignView.vue
  工序制定页（三栏 splitter 布局：左 PartPicker / 中 DrawingPreview / 右 ProcessStepCardList）。
  2026-09-11 新增。
  2026-09-12 改造：CSS flex → <el-splitter> 三栏可拖拽，宽度持久化到 localStorage
                   （views/production/composables/useResizablePane.ts，key='process_design_layout'）。
  2026-10-05 改造：数据层切页面级 Pinia store（useProcessDesignStore，替代模块级
                   单例 composable usePartProcessDesign）：
                   - onMounted 统一调 store.query.restoreState()（开 enabled 闸门），
                     不再手动 loadParts / loadProcesses；
                   - onBeforeUnmount 调 store.$dispose()（页面级 store 不变量 #2，
                     否则 Pinia 单例把「上次选中的零件 + 未保存草稿」泄漏到下次进入）；
                   - 选中零件改由 store 持有（store.query.selectedPartId），
                     本组件只做「左栏 emit → store.query.selectPart」的事件接线；
                   - 数据源由 part 域 GET /api/v2/parts?status=PENDING 切到
                     prod 域 GET /api/v2/prod/process-design/parts（含装配件子件）。
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
import { computed, onBeforeUnmount, onMounted } from 'vue';
import PartPickerList from './components/PartPickerList.vue';
import DrawingPreviewPane from './components/DrawingPreviewPane.vue';
import ProcessStepCardList from './components/ProcessStepCardList.vue';
import { useProcessDesignStore } from './composables/useProcessDesignStore';
import { useResizablePane } from '@/views/production/composables/useResizablePane';
import type { ProcessDesignPartSchema } from '@/composables/queries/schemas';

// 不变量 #3：消费侧禁止解构 store，一律 store.query.xxx / store.editor.xxx。
const store = useProcessDesignStore();

// 2026-09-12 新增：三栏宽度持久化。默认 20% / 60% / 20%，中间图纸占主。
const pane = useResizablePane('process_design_layout', { left: 20, center: 60, right: 20 });

const selectedPartId = computed<string | null>(() => store.query.selectedPartId);

const selectedPart = computed<ProcessDesignPartSchema | null>(
  () => store.query.parts.find((p) => p.id === selectedPartId.value) ?? null,
);

function onSelectPart(partId: string): void {
  store.query.selectPart(partId);
}

onMounted(() => {
  // 恢复页面状态 + 开 enabled 闸门（首屏请求由 useQuery 自行发起，视图不再手动 fetch）
  store.query.restoreState();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开页面销毁，下次进入重建 fresh 状态
  // （对外状态走 query / editor 两个 plain object slice，$dispose 后不会从
  //   pinia.state hydrate 回来）
  store.$dispose();
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
