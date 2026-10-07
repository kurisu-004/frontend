<!-- 2026-10-09 新建：外协看板单个外协工序 tab 的 body。
     本组件是该 tab body 的**唯一** query 持有者（`useOutsourceQueueProcessQuery`）——
     父级 `OutsourceBoard` 只管 tab 壳（工序集合 / 徽标 / 深链），tab 内的一切数据由本
     组件负责。`:lazy="true"` ⇒ 切到该 tab 才 mount 才发请求，30s staleTime 保证切回
     已激活过的 tab 不重拉。

     渲染：el-splitter 30/70（左「可发送候选池」CandidatePool / 右「外协公司列」
     CompanyColumn×N）+ skeleton / empty 兜底三分支。

     勾选集合（selectedIds）在本组件持有而不是容器各自持有：候选池的勾选框与公司列的
     多选拖拽发送是**同一个集合**的两端，拆到两个容器就必然不同步。

     公司列数据 `companies[].held_batches` 由后端内联 ⇒ CompanyColumn 零请求。 -->
<template>
  <div class="process-board-tab">
    <div v-if="detail.isLoading.value" class="loading-state">
      <el-skeleton :rows="6" animated />
    </div>
    <div v-else-if="detail.error.value" class="error-state">
      <el-empty description="加载失败" />
    </div>
    <el-splitter v-else-if="data" class="board-splitter">
      <el-splitter-panel size="30%" :min="240">
        <CandidatePool
          :items="data.items"
          :process-id="data.process.process_id"
          :process-name="data.process.process_name"
          :selected-ids="selectedIds"
          @update:selected-ids="selectedIds = $event"
        />
      </el-splitter-panel>
      <el-splitter-panel size="70%" :min="400">
        <div class="columns-container">
          <CompanyColumn
            v-for="c in data.companies"
            :key="c.company_id"
            :company="c"
            :candidates="data.items"
            :selected-ids="selectedIds"
            @update:selected-ids="selectedIds = $event"
          />
        </div>
        <div v-if="data.companies.length === 0" class="no-companies">
          该外协工序未映射启用的外协公司
        </div>
      </el-splitter-panel>
    </el-splitter>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOutsourceQueueProcessQuery } from '../composables/useOutsourceQueueProcessQuery';
import CandidatePool from './CandidatePool.vue';
import CompanyColumn from './CompanyColumn.vue';

const props = defineProps<{
  processId: string;
}>();

// tab 懒加载数据源 —— 键是 `qk.outsourceQueueProcess(processId)`，30s staleTime 去重。
const detail = useOutsourceQueueProcessQuery(() => props.processId);

/** 响应体（守卫已在 queryFn 里 parse 过）。 */
const data = computed(() => detail.data.value ?? null);

/** 跨容器共享的勾选集合。整体换新 Set（容器侧 emit 新集合），不做原地 mutate。 */
const selectedIds = ref<Set<string>>(new Set());
</script>

<style scoped>
.process-board-tab {
  width: 100%;
  height: 100%;
}
.loading-state,
.error-state {
  padding: 40px;
}
.board-splitter {
  /* 撑满高度的是 EP 自带的 `.el-splitter { height: 100% }`；下面两行沿用生产队列域的
     同款写法（父级 .el-tab-pane 是块容器，实际不生效），只作显式声明。 */
  flex: 1;
  min-height: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  margin-top: 12px;
}
.columns-container {
  display: flex;
  gap: 16px;
  padding: 12px;
  height: 100%;
  overflow-x: auto;
  box-sizing: border-box;
}
.no-companies {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  padding: 40px;
}
</style>