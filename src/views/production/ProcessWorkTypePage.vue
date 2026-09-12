<!-- 工序工种 tabbed 页（2026-09-12 新增）
     合并原 设置/工种管理 + 设置/工序管理 + 设置/工种-工序映射 三菜单到一个 tabbed 页。
     路由 /production/process-work-type，menuCode process_work_type。

     3 个 tab：
     - 工种管理（默认）：工种 CRUD
     - 工序管理：工序 CRUD（含颜色字段）
     - 工序映射：工种 ↔ 工序 多对多映射（master-detail）

     URL ?tab=work-types|processes|mapping 记忆上次选择；初次进入默认 工种管理。
     参考实现：OutsourceSendReceive.vue（send/receive tab 模式）。
-->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkTypeTab from './components/WorkTypeTab.vue'
import ProcessTab from './components/ProcessTab.vue'
import ProcessWorkTypeMappingTab from './components/ProcessWorkTypeMappingTab.vue'

type TabName = 'work-types' | 'processes' | 'mapping'

const route = useRoute()
const router = useRouter()

// ============================================================
// Tab 状态（URL ?tab= 同步）
// ============================================================
function readTabFromQuery(): TabName {
  const t = route.query.tab
  if (t === 'processes' || t === 'mapping') return t
  return 'work-types'
}
const activeTab = ref<TabName>(readTabFromQuery())

watch(() => route.query.tab, (q) => {
  if (q === 'work-types' || q === 'processes' || q === 'mapping') {
    activeTab.value = q
  }
})

function onTabChange(name: string | number): void {
  const n = name as TabName
  activeTab.value = n
  router.replace({ path: '/production/process-work-type', query: { tab: n } })
}
</script>

<template>
  <div class="page">
    <el-card shadow="never">
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <!-- ====================== Tab 1: 工种管理 ====================== -->
        <el-tab-pane name="work-types" label="工种管理">
          <WorkTypeTab />
        </el-tab-pane>

        <!-- ====================== Tab 2: 工序管理 ====================== -->
        <el-tab-pane name="processes" label="工序管理">
          <ProcessTab />
        </el-tab-pane>

        <!-- ====================== Tab 3: 工序映射 ====================== -->
        <el-tab-pane name="mapping" label="工序映射">
          <ProcessWorkTypeMappingTab />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<style lang="scss" scoped>
.page {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
:deep(.el-tabs__content) {
  overflow: visible;
}
:deep(.el-tab-pane) {
  padding: 12px 0 0 0;
}
</style>
