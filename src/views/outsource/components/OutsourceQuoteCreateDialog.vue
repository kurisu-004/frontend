<!--
  OutsourceQuoteCreateDialog.vue — 新建 DRAFT 报价对话框（2026-08-25 T13 从 OutsourceQuoteList.vue 抽出）

  纯受控组件（仿 T9 风格）：
  - 可见性 + 表单 state + companies + 校验 由外部 form composable 持有
  - 用 :model-value + @update:model-value 显式双向，避免 readonly prop 写入失效
  - 内部不做业务调用：'confirm' / 'part-change' 事件上抛
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="新建外协报价"
    :width="dialogSize.width"
    :top="dialogSize.top"
    @update:model-value="(v: boolean) => $emit('update:model-value', v)"
  >
    <el-form
      :ref="(el) => $emit('form-ref', el as FormInstance | null)"
      :model="form"
      :rules="rules"
      label-width="100px"
    >
      <el-form-item label="零件" prop="part_id">
        <el-select
          :model-value="form.part_id"
          filterable
          style="width:100%"
          placeholder="可选报价零件（在外协工序货架上的在制件；按图号/名称筛选）"
          @update:model-value="(v: string | number | boolean | undefined) => $emit('update:part-id', String(v ?? ''))"
          @change="(v: string) => $emit('part-change', v)"
        >
          <el-option
            v-for="p in parts"
            :key="p.id"
            :label="`${p.serial_no ?? '—'} | ${p.drawing_no ?? ''} | ${p.name} | ${p.shelf_code ?? ''}`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="工序" prop="process_id">
        <el-select
          :model-value="form.process_id"
          filterable
          style="width:100%"
          @update:model-value="(v: string | number | boolean | undefined) => $emit('update:process-id', String(v ?? ''))"
        >
          <el-option
            v-for="p in processes"
            :key="p.id"
            :label="`${p.code} ${p.name}`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="外协公司" prop="outsource_company_id">
        <el-select
          :model-value="form.outsource_company_id"
          filterable
          :disabled="!form.process_id"
          :loading="companiesLoading"
          placeholder="请先选择工序"
          style="width:100%"
          @update:model-value="(v: string | number | boolean | undefined) => $emit('update:company-id', String(v ?? ''))"
        >
          <el-option
            v-for="c in companies"
            :key="c.id"
            :label="c.name"
            :value="c.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="单价(元)" prop="price">
        <el-input
          :model-value="form.price"
          type="number"
          :precision="2"
          :step="0.01"
          @update:model-value="(v: string | number) => $emit('update:price', typeof v === 'number' ? String(v) : v)"
        />
      </el-form-item>
      <el-form-item label="备注">
        <el-input
          :model-value="form.note"
          type="textarea"
          @update:model-value="(v: string | number) => $emit('update:note', typeof v === 'number' ? String(v) : v)"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:model-value', false)">取消</el-button>
      <el-button type="primary" @click="$emit('confirm')">保存草稿</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { useDialogSize } from '@/composables/useDialogSize'
import type { FormInstance, FormRules } from 'element-plus'
import type { CreateQuoteForm } from '../composables/useOutsourceQuoteForm'
import type { PartListItem } from '@/types/parts'
import type { Process } from '@/types/process'

defineProps<{
  modelValue: boolean
  form: CreateQuoteForm
  rules: FormRules
  parts: readonly PartListItem[]
  processes: readonly Process[]
  companies: readonly { id: string; name: string }[]
  companiesLoading: boolean
}>()

defineEmits<{
  (e: 'update:model-value', value: boolean): void
  (e: 'update:part-id', value: string): void
  (e: 'update:process-id', value: string): void
  (e: 'update:company-id', value: string): void
  (e: 'update:price', value: string): void
  (e: 'update:note', value: string): void
  (e: 'form-ref', value: FormInstance | null): void
  (e: 'part-change', partId: string): void
  (e: 'confirm'): void
}>()

const dialogSize = useDialogSize({ desktopWidth: 640 })
</script>