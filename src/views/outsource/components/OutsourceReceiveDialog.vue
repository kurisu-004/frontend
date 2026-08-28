<!--
  OutsourceReceiveDialog.vue — 接收外协件 dialog（2026-08-25 T12 从 OutsourceSendReceive.vue 抽出）

  设计要点：
  - 纯受控组件：所有状态由外部传入；shelves / filteredProcesses 也由外部派生传入。
  - 避免 T9 readonly-prop 陷阱：用 :model-value + @update:model-value 显式双向。
  - branch / shelf / process / quantity / submitting 都是双向；target 是只读快照。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="接收外协件"
    :width="dialogSize.width"
    :top="dialogSize.top"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => $emit('update:model-value', v)"
    @closed="$emit('closed')"
  >
    <el-form label-width="120px">
      <!-- 2026-08-22 a11y：单包 el-radio-group 触发 for= 指向非 labelable 元素警告 -->
      <el-form-item label="接收分支" :for="''">
        <el-radio-group
          :model-value="branch"
          aria-label="接收分支"
          @update:model-value="(v: string | number | boolean | undefined) => $emit('update:branch', (v ?? 'production') as Branch)"
        >
          <el-radio value="production">进入生产货架</el-radio>
          <el-radio value="inspection">进入品检货架</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="branch === 'production' ? '生产货架' : '品检货架'" required>
        <el-select
          :model-value="shelf"
          :placeholder="branch === 'production' ? '生产区' : '品检区'"
          filterable
          style="width: 100%"
          @update:model-value="(v: string | number | boolean | undefined) => $emit('update:shelf', String(v ?? ''))"
        >
          <el-option
            v-for="s in (branch === 'production' ? productionShelves : inspectionShelves)"
            :key="s.id"
            :label="`${s.code} — ${s.name}`"
            :value="s.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item v-if="branch === 'production'" label="下一道工序" required>
        <el-select
          :model-value="process"
          filterable
          style="width: 100%"
          @update:model-value="(v: string) => $emit('update:process', v)"
        >
          <el-option
            v-for="p in filteredInhouseProcesses"
            :key="p.id"
            :label="`${p.code} — ${p.name}`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="接收数量">
        <el-input-number
          :model-value="quantity"
          :min="1"
          :max="target?.quantity ?? 1"
          :controls="false"
          size="small"
          style="width: 120px"
          @update:model-value="(v: number | undefined) => $emit('update:quantity', typeof v === 'number' ? v : 0)"
        />
        <span v-if="target" style="margin-left: 8px; color: var(--el-text-color-secondary);">/ {{ target.quantity }} 件</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:model-value', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="$emit('confirm')">
        确认接收（{{ branchLabel }}）
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts" generic="P extends { id: string; code: string; name: string }, S extends { id: string; code: string; name: string; zone: string; is_active: boolean }">
import { useDialogSize } from '@/composables/useDialogSize'
import type { OutsourceInFlightItem } from '@/types/outsource'

type Branch = 'production' | 'inspection'

defineProps<{
  modelValue: boolean
  target: OutsourceInFlightItem | null
  branch: Branch
  shelf: string
  process: string
  quantity: number
  submitting: boolean
  branchLabel: string
  productionShelves: readonly S[]
  inspectionShelves: readonly S[]
  filteredInhouseProcesses: readonly P[]
}>()

defineEmits<{
  (e: 'update:model-value', value: boolean): void
  (e: 'update:branch', value: Branch): void
  (e: 'update:shelf', value: string): void
  (e: 'update:process', value: string): void
  (e: 'update:quantity', value: number): void
  (e: 'closed'): void
  (e: 'confirm'): void
}>()

const dialogSize = useDialogSize({ desktopWidth: 560 })
</script>