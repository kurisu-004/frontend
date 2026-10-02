<!--
  ProcessChainCard.vue

  工序链卡（PartDetail 工序链可视化卡，2026-09-17 新增）：
  - el-timeline 渲染 steps（按 sort_order ASC）
  - 当前选中 batch 的 current_process_step_id 对应的 step 高亮
    （< currentIndex → success，= currentIndex → primary，> currentIndex → info）
  - 工序名优先走 processesLookup[process_id].name，回退 step.process_id（带 title 兜底）
  - currentIndex < 0（未选中批次 / 批次未绑定步骤）时 header 下显式提示，不静默全灰
  - 加载状态由 useProcessChain.fetchProcessChain 控制

  数据流：useProcessChain → steps / currentStepId / loading → 本组件
  processesLookup 由父级（shell 订阅共享 useProcessesQuery）注入，O(1) 字典构造。
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

    <!--
      2026-10-02：currentIndex === -1（未选中批次，或该批次未绑定工序链步骤）时，
      header 明说原因，不再让整条时间轴静默全灰 —— 用户看不出是「没数据」还是
      「没选中」。
    -->
    <el-alert
      v-if="steps.length > 0 && currentIndex < 0"
      type="info"
      :closable="false"
      class="chain-hint"
      title="所选批次未绑定工序链步骤"
    />

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
          <span class="step-name" :title="stepName(step.process_id)">
            {{ stepName(step.process_id) }}
          </span>
          <span v-if="idx === currentIndex" class="step-badge current-badge">当前</span>
          <span v-else-if="idx < currentIndex" class="step-badge done-badge">已完成</span>
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
   * 由父级订阅共享 useProcessesQuery 后注入；查不到时回退显示 process_id 字符串
   * （模板上带 title，悬停可见完整 id，不会撑破布局）。
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

// 2026-10-02：当前步骤高亮加强 —— 原先只有节点圆点一层 box-shadow，
// 在 el-timeline 的细线视觉里几乎看不出「哪一步是当前」。现在整行铺浅色底 +
// 左侧 primary 竖条 + 内缩 padding，圆点与序号同步切 primary。
.current-step {
  background: var(--el-color-primary-light-9);
  border-left: 3px solid var(--el-color-primary);
  border-radius: 4px;
  padding: 6px 10px;
  margin-left: -13px;

  :deep(.el-timeline-item__node) {
    background: var(--el-color-primary);
    box-shadow: 0 0 0 4px var(--el-color-primary-light-8);
  }
  :deep(.el-timeline-item__tail) {
    border-left-color: var(--el-color-primary-light-5);
  }
  :deep(.el-timeline-item__timestamp) {
    color: var(--el-color-primary);
  }
  .step-index {
    background: var(--el-color-primary);
    color: #fff;
  }
  .step-name {
    color: var(--el-color-primary);
  }
}

// 步骤徽标：当前 / 已完成
.step-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 12px;
  line-height: 1;
  flex: none;
}
.current-badge {
  background: var(--el-color-primary);
  color: #fff;
}
.done-badge {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.chain-hint {
  margin-bottom: 8px;
}
</style>
