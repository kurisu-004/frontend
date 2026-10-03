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
      :ref="(el) => $emit('formRef', el as FormInstance | null)"
      :model="form"
      :rules="rules"
      label-width="100px"
    >
      <el-form-item label="零件" prop="part_id">
        <el-select
          :model-value="form.part_id"
          filterable
          style="width: 100%"
          placeholder="可选报价零件（有待下发批次的在制件；按图号/名称筛选）"
          @update:model-value="
            (v: string | number | boolean | undefined) => $emit('update:part-id', String(v ?? ''))
          "
          @change="(v: string) => $emit('partChange', v)"
        >
          <!--
            2026-10-03：picker 候选源改成「有活跃 PENDING 批次的在制件」，行粒度是
            **一个零件一行**（不再按 OUTSOURCE 工序货架展开），所以：
            - :key 直接用 p.id —— 此前同零件多行需要组合键，现在行不再重复；
            - label 不带货架 / 工序尾段 —— VO 已经没有这四个字段（见
              `QuotablePart` 注释），且候选语义是「还没下发的零件」而非「在某个外协
              工序货架上」，带出来反而误导。
            副作用：picker 无法推断报价工序，工序必须在下面的下拉里手选。改前
            el-select 的 :value 是裸 part_id，同零件多行时会出现「label 暗示工序 A、
            实际手选工序 B」的串号隐患；改成一零件一行后该隐患自动消失。
          -->
          <el-option
            v-for="p in parts"
            :key="p.id"
            :label="`${p.serial_no ?? '—'} | ${p.drawing_no ?? ''} | ${p.name}`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="工序" prop="process_id">
        <el-select
          :model-value="form.process_id"
          filterable
          style="width: 100%"
          @update:model-value="
            (v: string | number | boolean | undefined) =>
              $emit('update:process-id', String(v ?? ''))
          "
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
          style="width: 100%"
          @update:model-value="
            (v: string | number | boolean | undefined) =>
              $emit('update:company-id', String(v ?? ''))
          "
        >
          <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="单价(元)" prop="price">
        <el-input
          :model-value="form.price"
          type="number"
          :precision="2"
          :step="0.01"
          @update:model-value="
            (v: string | number) => $emit('update:price', typeof v === 'number' ? String(v) : v)
          "
        />
      </el-form-item>
      <el-form-item label="备注">
        <el-input
          :model-value="form.note"
          type="textarea"
          @update:model-value="
            (v: string | number) => $emit('update:note', typeof v === 'number' ? String(v) : v)
          "
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
import { useDialogSize } from '@/composables/useDialogSize';
import type { FormInstance, FormRules } from 'element-plus';
import type { CreateQuoteForm } from '../composables/useOutsourceQuoteForm';
import type { QuotablePart } from '@/types/outsource';
import type { Process } from '@/types/process';

defineProps<{
  modelValue: boolean;
  form: CreateQuoteForm;
  rules: FormRules;
  parts: readonly QuotablePart[];
  processes: readonly Process[];
  companies: readonly { id: string; name: string }[];
  companiesLoading: boolean;
}>();

defineEmits<{
  'update:model-value': [value: boolean];
  'update:part-id': [value: string];
  'update:process-id': [value: string];
  'update:company-id': [value: string];
  'update:price': [value: string];
  'update:note': [value: string];
  formRef: [value: FormInstance | null];
  partChange: [partId: string];
  confirm: [];
}>();

const dialogSize = useDialogSize({ desktopWidth: 640 });
</script>
