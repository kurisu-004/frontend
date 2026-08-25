<!--
  PartAssemblyLinkCard.vue

  所属装配件卡（PartDetail 第 4 张卡）：
  - 仅当 part.assembly_id 非空时由 shell 渲染
  - 通过 usePartDetail.fetchAssembly() 拉装配件详情
  - 包含兄弟零件 chips（点击跳转）
  - 无 dialog / form
-->
<template>
  <el-card
    shadow="never"
    class="assembly-card"
    v-loading="assemblyLoading"
  >
    <template #header>
      <div class="card-header">
        <span class="card-title">
          <el-icon><Connection /></el-icon>
          <span>所属装配件</span>
        </span>
        <el-button
          link
          type="primary"
          size="small"
          @click="goToAssembly"
        >
          查看装配件详情
          <el-icon><ArrowRight /></el-icon>
        </el-button>
      </div>
    </template>
    <el-descriptions v-if="assemblyDetail" :column="descCol" border>
      <el-descriptions-item label="总图图号">
        <span class="mono">{{ assemblyDetail.assembly.drawing_no }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="装配体名称">
        {{ assemblyDetail.assembly.name }}
      </el-descriptions-item>
      <el-descriptions-item label="装配件状态">
        <el-tag :type="assemblyDetail.assembly.status === 'COMPLETED' ? 'success' : 'info'" size="small">
          {{ assemblyDetail.assembly.status }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="客户">
        {{ assemblyDetail.assembly.customer_path || '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="子零件数">
        <el-tag type="info" size="small" effect="plain">
          {{ assemblyDetail.assembly.child_count }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="计划交期">
        {{ assemblyDetail.assembly.planned_delivery_date }}
      </el-descriptions-item>
    </el-descriptions>

    <div v-if="assemblyDetail" class="siblings">
      <div class="siblings-title">兄弟零件（点击跳转）</div>
      <div class="siblings-grid">
        <el-tag
          v-for="sib in assemblyDetail.children"
          :key="sib.id"
          :type="sib.id === part.id ? 'primary' : 'info'"
          :effect="sib.id === part.id ? 'dark' : 'plain'"
          class="sibling-chip"
          @click="goToSibling(sib.id)"
        >
          <span class="sib-serial">{{ sib.serial_no || '—' }}</span>
          <span class="sib-name">{{ sib.drawing_no }}</span>
          <span class="sib-label">{{ sib.name }}</span>
        </el-tag>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { ArrowRight, Connection } from '@element-plus/icons-vue'
import type { PartItem } from '@/api/parts'
import type { AssemblyDetail } from '@/types/assembly'

const props = defineProps<{
  part: PartItem
  assemblyDetail: AssemblyDetail | null
  assemblyLoading: boolean
}>()

const router = useRouter()
const descCol = 3

function goToAssembly() {
  if (props.part.assembly_id != null) {
    router.push(`/assemblies/${props.part.assembly_id}`)
  }
}

function goToSibling(siblingId: string) {
  router.push(`/parts/${siblingId}`)
}
</script>

<style lang="scss" scoped>
.assembly-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}
.siblings {
  margin-top: 16px;
}
.siblings-title {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.siblings-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.sibling-chip {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 4px;
  transition: transform 0.15s;
  &:hover {
    transform: translateY(-1px);
  }
}
.sib-serial {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 600;
}
.sib-name {
  color: var(--text-secondary);
  font-size: 12px;
}
.sib-label {
  font-size: 12px;
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
</style>
