<!--
  OutsourceSendDialog.vue — 发送外协确认 dialog（2026-08-25 T12 从 OutsourceSendReceive.vue 抽出）

  设计要点：
  - 纯受控组件：可见性 / target / company / quantity / submitting 全部由外部传入。
  - 避免 T9 readonly-prop 陷阱：用 :model-value + @update:model-value 显式双向，
    不用 v-model。
  - 内部不做业务调用；'confirm' 事件把「外部该按当前状态发起发送」语义上抛给父组件。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="确认发送外协"
    :width="dialogSize.width"
    :top="dialogSize.top"
    @update:model-value="(v: boolean) => $emit('update:model-value', v)"
  >
    <template v-if="target">
      <div v-if="target.send_mode === 'DIRECT'" style="margin-bottom: 12px;">
        <el-tag type="success" size="default">免审批，直接发送</el-tag>
        <span style="margin-left: 8px; color: var(--el-text-color-secondary);">
          无需报价，要求位于绑定了外协工序的货架（当前 C2 等）
        </span>
      </div>
      <el-descriptions :column="1" border>
        <el-descriptions-item label="序列号">{{ target.part_serial_no }}</el-descriptions-item>
        <el-descriptions-item label="图号">{{ target.part_drawing_no }}</el-descriptions-item>
        <el-descriptions-item label="名称">{{ target.part_name }}</el-descriptions-item>
        <el-descriptions-item v-if="target.send_mode === 'APPROVAL'" label="外协公司">
          {{ target.outsource_company_name }}
        </el-descriptions-item>
        <el-descriptions-item v-else label="外协公司">
          <el-select
            :model-value="selectedCompanyId"
            style="width: 100%"
            @update:model-value="(v: string) => $emit('update:selected-company-id', v)"
          >
            <el-option
              v-for="opt in target.company_options"
              :key="opt.id"
              :label="opt.name"
              :value="opt.id"
            />
          </el-select>
        </el-descriptions-item>
        <el-descriptions-item label="外协工序">{{ target.next_process_name ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="单价">
          {{ target.send_mode === 'DIRECT' ? '—' : `${target.price} 元` }}
        </el-descriptions-item>
        <el-descriptions-item label="发送数量">
          <el-input-number
            :model-value="quantity"
            :min="1"
            :max="target.batch_quantity"
            :controls="false"
            size="small"
            style="width: 120px"
            @update:model-value="(v: number | undefined) => $emit('update:quantity', typeof v === 'number' ? v : 0)"
          />
          <span style="margin-left: 8px; color: var(--el-text-color-secondary);">/ {{ target.batch_quantity }} 件</span>
        </el-descriptions-item>
      </el-descriptions>
    </template>
    <template #footer>
      <el-button @click="$emit('update:model-value', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="$emit('confirm')">
        确认发送
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { useDialogSize } from '@/composables/useDialogSize'
import type { SendableItem } from '../composables/useOutsourceSendableList'

defineProps<{
  modelValue: boolean
  target: SendableItem | null
  selectedCompanyId: string
  quantity: number
  submitting: boolean
}>()

defineEmits<{
  (e: 'update:model-value', value: boolean): void
  (e: 'update:selected-company-id', value: string): void
  (e: 'update:quantity', value: number): void
  (e: 'confirm'): void
}>()

const dialogSize = useDialogSize({ desktopWidth: 520 })
</script>