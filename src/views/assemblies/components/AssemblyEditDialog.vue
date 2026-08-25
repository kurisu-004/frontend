<!--
  AssemblyEditDialog.vue

  编辑装配件元数据对话框（CLERK + MANAGER）。
  - form reactive 由 shell / composable 持有并通过 prop 注入（本组件直接 v-model）
  - form ref + 表单 rules + 校验逻辑在本组件内
  - 父组件通过 v-model:visible 控制可见性
  - @open 时触发父组件刷新客户列表（loadLeafCustomers）
  - 校验通过后 emit('submit', payload)；shell 决定是否关闭 dialog
    （基于 composable.updateAssembly 的 Promise<boolean> 返回值）

  2026-08-25 frontend-overall-refactor：从 AssemblyDetail.vue 抽出。
-->
<template>
  <el-dialog
    :model-value="visible"
    title="编辑装配件元数据"
    :width="dlg.width"
    :top="dlg.top"
    :fullscreen="dlg.fullscreen"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:visible', v)"
    @open="emit('open')"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
    >
      <el-form-item label="总图图号" prop="drawing_no">
        <el-input v-model="form.drawing_no" placeholder="例如：E42FX1020107101" />
      </el-form-item>
      <el-form-item label="装配体名称" prop="name">
        <el-input v-model="form.name" placeholder="例如：精研挡料座" />
      </el-form-item>
      <el-form-item label="客户" prop="customer_id">
        <el-select
          v-model="form.customer_id"
          filterable
          placeholder="选择二级客户"
          style="width: 100%"
        >
          <el-option
            v-for="c in customers"
            :key="c.id"
            :label="formatCustomerOptionLabel(c)"
            :value="c.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="申请人">
        <el-autocomplete
          v-model="form.applicant_name"
          :fetch-suggestions="queryApplicants"
          placeholder="输入或选择申请人"
          value-key="name"
          style="width: 100%"
          @select="onApplicantSelected"
        />
        <!-- applicant_id 留作隐藏 / 调试用；选 applicant 时自动同步 -->
      </el-form-item>
      <el-form-item label="请购日期" prop="request_date">
        <el-date-picker
          v-model="form.request_date"
          type="date"
          value-format="YYYY-MM-DD"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item label="计划交期" prop="planned_delivery_date">
        <el-date-picker
          v-model="form.planned_delivery_date"
          type="date"
          value-format="YYYY-MM-DD"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item label="实际送货">
        <el-date-picker
          v-model="form.actual_delivery_date"
          type="date"
          value-format="YYYY-MM-DD"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item label="加急" prop="is_urgent">
        <el-switch v-model="form.is_urgent" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        @click="onSubmit"
      >
        保存
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { FormInstance } from 'element-plus'
import { useDialogSize } from '@/composables/useDialogSize'
import type { Customer } from '@/api/customer'
import type { Applicant } from '@/types/applicant'
import {
  ASSEMBLY_EDIT_RULES,
  formatCustomerOptionLabel,
  type AssemblyEditForm,
} from '../composables/useAssemblyDetail'
import type { AssemblyUpdatePayload } from '@/types/assembly'

interface Props {
  visible: boolean
  submitting: boolean
  customers: Customer[]
  /** form 数据；shell 在 open 前已通过 composable.populateEditForm 填好。 */
  form: AssemblyEditForm
  /** applicant autocomplete 的查询函数（直接绑给 :fetch-suggestions） */
  queryApplicants: (qs: string, cb: (items: Applicant[]) => void) => void
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'submit', payload: AssemblyUpdatePayload): void
  /** open 时 shell 调 loadLeafCustomers（composable 注入） */
  (e: 'open'): void
}>()

const dlg = useDialogSize({ desktopWidth: 640 })

const formRef = ref<FormInstance>()
const rules = ASSEMBLY_EDIT_RULES

function onApplicantSelected(applicant: { id?: string; name?: string }): void {
  if (applicant?.id != null) {
    props.form.applicant_id = String(applicant.id)
  }
}

async function onSubmit(): Promise<void> {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  // 把表单内部空字符串 / falsy 还原成 payload schema 的 null / undefined 语义。
  const f = props.form
  const payload: AssemblyUpdatePayload = {
    drawing_no: f.drawing_no,
    name: f.name,
    customer_id: f.customer_id,
    applicant_name: f.applicant_name || null,
    applicant_id: f.applicant_id || null,
    request_date: f.request_date,
    planned_delivery_date: f.planned_delivery_date,
    actual_delivery_date: f.actual_delivery_date || null,
    is_urgent: f.is_urgent,
  }
  emit('submit', payload)
}
</script>

<style lang="scss" scoped>
:deep(.el-dialog__body) {
  padding-top: 12px;
}
</style>
