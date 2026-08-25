<!--
  AssemblyActionBar.vue

  装配件信息卡头部操作按钮组（返回 / 编辑 / 取消 / 删除）。
  纯展示组件，权限 + serial 由父组件传入；点击只 emit，不做任何业务调用。

  2026-08-25 frontend-overall-refactor：从 AssemblyDetail.vue 抽出。
-->
<template>
  <div class="card-actions">
    <el-button @click="emit('back')">
      <el-icon><Back /></el-icon>
      <span>返回列表</span>
    </el-button>
    <!-- 编辑元数据（CLERK+；终态由后端拒绝） -->
    <el-button
      v-if="canEditContent"
      type="primary"
      plain
      @click="emit('edit')"
    >
      <el-icon><Edit /></el-icon>
      <span>编辑元数据</span>
    </el-button>
    <!-- 取消（CLERK+）：非终态可触发（serial 必须有） -->
    <el-button
      v-if="canCancel"
      type="warning"
      plain
      :disabled="!hasSerial"
      @click="emit('cancel')"
    >
      <el-icon><CircleClose /></el-icon>
      <span>取消装配件</span>
    </el-button>
    <!-- 删除（MANAGER-only）：不论状态都可触发 -->
    <el-button
      v-if="canDelete"
      type="danger"
      plain
      :disabled="!hasSerial"
      @click="emit('delete')"
    >
      <el-icon><Delete /></el-icon>
      <span>删除装配件</span>
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { Back, CircleClose, Delete, Edit } from '@element-plus/icons-vue'

interface Props {
  canEditContent: boolean
  canCancel: boolean
  canDelete: boolean
  /** serial_no 必须有才能执行取消 / 删除 */
  hasSerial: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'edit'): void
  (e: 'cancel'): void
  (e: 'delete'): void
}>()
</script>

<style lang="scss" scoped>
.card-actions {
  display: flex;
  gap: 8px;
}
</style>
