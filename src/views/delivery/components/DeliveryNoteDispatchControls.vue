<!--
  DeliveryNoteDispatchControls.vue

  送货单详情「状态操作」卡（DeliveryNoteDetail 第 3 张卡）：
  - 左侧：状态机操作（提交 / 撤回 / 打印送货单 / 打印标签）
  - 右侧：删除草稿（仅 DRAFT）

  权限判定由父组件通过 props 传入；按钮 click 只 emit。

  2026-08-25 frontend-overall-refactor：从 DeliveryNoteDetail.vue 抽出。
-->
<template>
  <el-card v-if="note" shadow="never" class="actions-card">
    <template #header>
      <span>状态操作</span>
    </template>
    <div class="actions-row">
      <el-space wrap>
        <el-button
          v-if="canSubmit(note.status, role)"
          type="primary"
          @click="emit('submit')"
        >
          提交
        </el-button>
        <el-button
          v-if="canRecall(note.status, role)"
          type="warning"
          @click="emit('recall')"
        >
          撤回
        </el-button>
        <el-button
          v-if="canPrint(role, note.part_count)"
          type="success"
          @click="emit('print')"
        >
          打印送货单
        </el-button>
        <el-button
          v-if="canPrint(role, note.part_count)"
          type="success"
          plain
          @click="emit('print-labels')"
        >
          打印标签
        </el-button>
      </el-space>
      <el-button
        v-if="canSoftDelete(note.status, role)"
        type="danger"
        plain
        @click="emit('soft-delete')"
      >
        删除草稿
      </el-button>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import type { DeliveryNoteStatus } from '@/types/deliveryNote'
import type { DeliveryNoteRoleMap } from '../composables/useDeliveryNoteDetail'
import {
  canPrint,
  canRecall,
  canSoftDelete,
  canSubmit,
} from '@/utils/deliveryNotePermissions'

interface Props {
  note: { status: DeliveryNoteStatus; part_count: number; delivery_note_no: string }
  role: DeliveryNoteRoleMap
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'submit'): void
  (e: 'recall'): void
  (e: 'print'): void
  (e: 'print-labels'): void
  (e: 'soft-delete'): void
}>()
</script>

<style lang="scss" scoped>
.actions-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
