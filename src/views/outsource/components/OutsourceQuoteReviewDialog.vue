<!--
  OutsourceQuoteReviewDialog.vue — 审批通过 / 拒绝 对话框（2026-08-25 T13 从 OutsourceQuoteList.vue 抽出）

  单一组件支持两种模式：`mode: 'approve' | 'reject'`。
  - 可见性 + reviewNote 由外部 form composable 持有
  - 用 :model-value + @update:model-value 显式双向，避免 readonly prop 写入失效
  - mode='approve'：标题「审批通过」+ 警告提示 + 可空 reviewNote + 「通过」按钮（绿色）
  - mode='reject'：标题「审批拒绝（必填原因）」+ 必填 reviewNote + 「拒绝」按钮（红色）
-->
<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    :width="dialogSize.width"
    :top="dialogSize.top"
    @update:model-value="(v: boolean) => $emit('update:model-value', v)"
  >
    <el-form label-width="100px">
      <el-alert
        v-if="mode === 'approve'"
        type="warning"
        :closable="false"
        style="margin-bottom: 12px"
      >
        通过后将自动拒绝该零件同工序的其他报价。
      </el-alert>
      <el-form-item :label="label" :required="mode === 'reject'">
        <el-input
          :model-value="reviewNote"
          type="textarea"
          :placeholder="mode === 'approve' ? '可留空' : '请填写拒绝原因'"
          @update:model-value="(v: string | number) => $emit('update:note', typeof v === 'number' ? String(v) : v)"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:model-value', false)">取消</el-button>
      <el-button :type="confirmButtonType" @click="$emit('confirm')">
        {{ confirmText }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDialogSize } from '@/composables/useDialogSize'

type ReviewMode = 'approve' | 'reject'

const props = defineProps<{
  modelValue: boolean
  mode: ReviewMode
  reviewNote: string
}>()

defineEmits<{
  (e: 'update:model-value', value: boolean): void
  (e: 'update:note', value: string): void
  (e: 'confirm'): void
}>()

const dialogSize = useDialogSize({ desktopWidth: 480 })

const title = computed(() => props.mode === 'approve' ? '审批通过' : '审批拒绝（必填原因）')
const label = computed(() => props.mode === 'approve' ? '审批意见' : '拒绝原因')
const confirmButtonType = computed(() => props.mode === 'approve' ? 'success' : 'danger')
const confirmText = computed(() => props.mode === 'approve' ? '通过' : '拒绝')
</script>