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
          placeholder="可选报价零件（在外协工序货架上的在制件；按图号/名称筛选）"
          @update:model-value="
            (v: string | number | boolean | undefined) => $emit('update:part-id', String(v ?? ''))
          "
          @change="(v: string) => $emit('partChange', v)"
        >
          <!--
            2026-10-03：picker 数据源的行粒度是「一个 (零件, OUTSOURCE 工序) 组合一行」
            （后端 DISTINCT ON 去重），同一 part_id 可以出多行。
            - :key 走 quotablePartRowKey 组合键，否则同零件多行会出重复 key。
            - label 尾部带出 货架 · 下一工序，否则多行 label 完全相同，操作员无从分辨。
            - :value 仍是裸 part_id：el-select 的 model（form.part_id）也是裸 part_id，
              改成组合键会让 select 匹配不到 option、把雪花 id 直接显示在框里。
              代价是同零件多行时「选中后按第一行渲染 label」，故自动填工序一侧
              （onCreatePartChange）遇到多行不猜，改为提示手动选工序。
          -->
          <el-option
            v-for="p in parts"
            :key="quotablePartRowKey(p)"
            :label="`${p.serial_no ?? '—'} | ${p.drawing_no ?? ''} | ${p.name} | ${p.shelf_code} · ${p.next_process_name}`"
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
import { quotablePartRowKey, type CreateQuoteForm } from '../composables/useOutsourceQuoteForm';
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
