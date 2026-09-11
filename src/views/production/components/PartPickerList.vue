<!--
  PartPickerList.vue
  工序制定页左栏：搜索 + 零件列表（el-table + 高亮选中）+ 摘要角标。
  2026-09-11 新增。
-->
<template>
  <el-card shadow="never" class="picker-card">
    <template #header>
      <div class="picker-header">
        <span class="picker-title">零件</span>
        <el-tag size="small" effect="plain">{{ filteredParts.length }} 个</el-tag>
      </div>
    </template>
    <el-input
      v-model="searchKeyword"
      placeholder="按图号 / 名称搜索"
      clearable
      size="small"
      class="picker-search"
      :prefix-icon="Search"
    />
    <el-table
      :data="filteredParts"
      v-loading="loading"
      highlight-current-row
      :row-key="(r: PartListItem) => r.id"
      :current-row-key="selectedPartId ?? undefined"
      @row-click="onSelect"
      size="small"
      stripe
      height="calc(100% - 100px)"
      class="picker-table"
    >
      <el-table-column prop="drawing_no" label="图号" min-width="110" show-overflow-tooltip />
      <el-table-column prop="name" label="名称" min-width="90" show-overflow-tooltip />
      <el-table-column label="状态" width="64" align="center">
        <template #default="{ row }">
          <el-tag v-if="row && row.id" size="small" effect="plain" :type="summaryType(row.id)">
            {{ summaryLabel(row.id) }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import type { PartListItem } from '@/types/parts'
import { usePartProcessDesign } from '../composables/usePartProcessDesign'

const props = defineProps<{
  selectedPartId: string | null
}>()

const emit = defineEmits<{
  (e: 'select', partId: string): void
}>()

const { parts, loadingParts, allSummaries } = usePartProcessDesign()
const loading = loadingParts

const searchKeyword = ref('')

const filteredParts = computed<PartListItem[]>(() => {
  const kw = searchKeyword.value.trim().toLowerCase()
  if (!kw) return parts.value
  return parts.value.filter((p) => {
    if (!p) return false
    return (
      (p.drawing_no ?? '').toLowerCase().includes(kw) ||
      (p.name ?? '').toLowerCase().includes(kw)
    )
  })
})

function onSelect(row: PartListItem): void {
  if (row && row.id) emit('select', row.id)
}

/** 摘要角标：有流程显示 N 步；含外协显示 warning。 */
function summaryType(partId: string): 'success' | 'warning' | undefined {
  const s = allSummaries.value[partId]
  if (!s || s.step_count === 0) return undefined
  return s.has_outsource_approval ? 'warning' : 'success'
}

function summaryLabel(partId: string): string {
  const s = allSummaries.value[partId]
  if (!s || s.step_count === 0) return '未配置'
  return `${s.step_count}步/${s.total_minutes}分`
}
</script>

<style lang="scss" scoped>
.picker-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
}
.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.picker-title {
  font-weight: 600;
  font-size: 14px;
}
.picker-search {
  flex-shrink: 0;
}
.picker-table {
  flex: 1;
  min-height: 0;
}
</style>
