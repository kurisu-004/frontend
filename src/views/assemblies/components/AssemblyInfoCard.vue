<!--
  AssemblyInfoCard.vue

  装配件信息卡（AssemblyDetail 第 1 张卡）：
  - 纯展示：状态标签 + 序列号 / 图号 / 名称 / 客户 / 日期 等
  - 头部操作按钮（返回 / 编辑 / 取消 / 删除）走 <AssemblyActionBar> 子组件
  - 不持有任何业务状态；权限判定由 shell 通过 canCancel / canDelete / canEditContent 传入

  2026-08-25 frontend-overall-refactor：从 AssemblyDetail.vue 抽出。
-->
<template>
  <el-card v-if="assembly" shadow="never" class="info-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">
          装配件详情
          <el-tag :type="statusTagType(assembly.status)" size="small" effect="dark">
            {{ statusLabel(assembly.status) }}
          </el-tag>
        </span>
        <AssemblyActionBar
          :can-edit-content="canEditContent"
          :can-cancel="canCancel"
          :can-delete="canDelete"
          :has-serial="!!assembly.serial_no"
          @back="emit('back')"
          @edit="emit('edit')"
          @cancel="emit('cancel')"
          @delete="emit('delete')"
        />
      </div>
    </template>

    <el-descriptions :column="descCol" border>
      <el-descriptions-item label="序列号">
        <span v-if="assembly.serial_no" class="mono">{{ assembly.serial_no }}</span>
        <el-tag v-else size="small" type="info" effect="plain">暂无（旧数据）</el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="总图图号">
        <span class="mono">{{ assembly.drawing_no }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="装配体名称">
        {{ assembly.name }}
      </el-descriptions-item>
      <el-descriptions-item label="客户">
        {{ assembly.customer_path || '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="申请人">
        {{ assembly.applicant_name || '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="子零件数">
        <el-tag type="info" size="small" effect="plain">
          {{ assembly.child_count }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="加急">
        <el-tag v-if="assembly.is_urgent" type="danger" size="small" effect="dark">加急</el-tag>
        <span v-else class="muted">否</span>
      </el-descriptions-item>
      <el-descriptions-item label="请购日期">
        {{ assembly.request_date }}
      </el-descriptions-item>
      <el-descriptions-item label="计划交期">
        {{ assembly.planned_delivery_date }}
      </el-descriptions-item>
      <el-descriptions-item label="实际送货">
        {{ assembly.actual_delivery_date || '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="创建时间">
        {{ formatDateTime(assembly.created_at) }}
      </el-descriptions-item>
      <el-descriptions-item label="更新时间">
        {{ formatDateTime(assembly.updated_at) }}
      </el-descriptions-item>
      <el-descriptions-item label="ID">
        <span class="mono">{{ assembly.id }}</span>
      </el-descriptions-item>
    </el-descriptions>
  </el-card>
</template>

<script setup lang="ts">
import type { AssemblyItem, AssemblyStatus } from '@/types/assembly'
import { formatDateTime } from '@/utils/date'
import AssemblyActionBar from './AssemblyActionBar.vue'

interface Props {
  assembly: AssemblyItem | null
  /** 描述列数（默认 3） */
  descCol?: number
  /** 权限 flag（shell 计算好传入） */
  canEditContent: boolean
  canCancel: boolean
  canDelete: boolean
  /** 状态 → label / tag-type 注入（composable 提供） */
  statusLabel: (s: AssemblyStatus | string) => string
  statusTagType: (s: AssemblyStatus | string) => 'info' | 'warning' | 'success' | 'danger' | 'primary'
}

const props = withDefaults(defineProps<Props>(), {
  descCol: 3,
})

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'edit'): void
  (e: 'cancel'): void
  (e: 'delete'): void
}>()
</script>

<style lang="scss" scoped>
.info-card {
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
  font-size: 16px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: var(--text-regular);
}
.muted {
  color: var(--text-secondary);
}
</style>
