<!--
  ProcessChainCard.vue

  工序链卡（PartDetail 工序链可视化卡，2026-09-17 新增）：
  - el-timeline 渲染 steps（按 sort_order ASC）
  - 当前选中 batch 的 current_process_step_id 对应的 step 高亮
    （< currentIndex → success，= currentIndex → primary，> currentIndex → info）
  - 工序名优先走 processesLookup[process_id].name，回退 step.process_id
  - 加载状态由 useProcessChain.fetchProcessChain 控制

  数据流：useProcessChain → steps / currentStepId / loading → 本组件
  processesLookup 由父级 usePartDetail（或 shell 的 ensureShelvesProcesses）注入；
  当前 shell 已经从 /processes 拉到 processes 列表，O(1) 字典构造即可。
-->
<template>
  <el-card v-loading="loading" shadow="never" class="chain-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">
          <el-icon><Connection /></el-icon>
          <span>工序链</span>
        </span>
        <span v-if="steps.length > 0" class="muted">共 {{ steps.length }} 步</span>
      </div>
    </template>

    <el-timeline v-if="steps.length > 0">
      <el-timeline-item
        v-for="(step, idx) in steps"
        :key="step.id ?? `${step.process_id}-${idx}`"
        :timestamp="step.note || undefined"
        placement="top"
        :type="stepType(idx)"
        :class="{ 'current-step': idx === currentIndex }"
      >
        <div class="step-line">
          <span class="step-index">{{ idx + 1 }}</span>
          <span class="step-name">
            {{ stepName(step.process_id) }}
          </span>
          <span v-if="step.estimated_minutes > 0" class="step-mins muted">
            约 {{ step.estimated_minutes }} 分钟
          </span>
        </div>
      </el-timeline-item>
    </el-timeline>
    <el-empty v-else description="暂无工序链" />
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Connection } from '@element-plus/icons-vue';
import type { ProcessChainStepDto } from '@/api/processChain.contract';

const props = defineProps<{
  steps: ProcessChainStepDto[];
  currentStepId: string | null;
  loading: boolean;
  /**
   * 工序字典查找表：process_id → { code, name }。
   * 由父级 usePartDetail.ensureShelvesProcesses 缓存后注入；查不到时回退
   * 显示 process_id 字符串。
   */
  processesLookup?: Record<string, { code: string; name: string }>;
}>();

const currentIndex = computed<number>(() => {
  if (!props.currentStepId) return -1;
  return props.steps.findIndex((s) => s.id === props.currentStepId);
});

function stepName(processId: string): string {
  return props.processesLookup?.[processId]?.name ?? processId;
}

function stepType(idx: number): 'primary' | 'success' | 'info' {
  if (currentIndex.value < 0) return 'info';
  if (idx < currentIndex.value) return 'success';
  if (idx === currentIndex.value) return 'primary';
  return 'info';
}
</script>

<style lang="scss" scoped>
.chain-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.muted {
  color: var(--text-secondary);
  font-size: 13px;
}

.step-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--el-color-info-light-9);
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 12px;
}
.step-name {
  color: var(--text-primary);
  font-weight: 500;
}
.step-mins {
  font-size: 12px;
}

// 当前选中步骤：高亮 node（圆点）
.current-step {
  :deep(.el-timeline-item__node) {
    box-shadow: 0 0 0 4px var(--el-color-primary-light-9);
  }
}
</style>
