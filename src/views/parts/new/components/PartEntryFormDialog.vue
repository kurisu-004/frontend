<!--
  PartEntryFormDialog.vue

  「录入」Tab 添加 / 编辑零件对话框（展示壳）。

  2026-09-24 新增：原 PartBatchManualTab.vue 第 181-359 行 dialog 整段 + form 双向
  同步脚本抽到本组件，与 auth 范本一致：父组件 usePartBatchManual 持 form + zod
  校验，本组件是纯展示壳（emit confirm / closed / update:form）。

  关键设计：
  - 本组件本地持有 localForm 副本 + watch 双向同步（PR-2026-09-13 折中保留），
    规避 vue/no-mutating-props；emit('update:form') 把本地编辑结果合并回父
    组件持有的 form（ref/reactive 在 composable 内）。
  - 单字段错误由父组件 formErrors（PartEntryFieldErrors）通过 :error prop 渲染
    到 el-form-item；本组件通过 emit('validateField', fieldName) 触发父组件
    的 validateField(field)（LoginView 同款 onBlur / onChange）。
  - 父组件 onAddConfirm / onDialogClosed 不再吃 FormInstance：zod 化后
    formRef.validate() / clearValidate() 失去存在意义；本组件挂载的 el-form
    仅为 el-form-item 容器，ref 不再需要。
  - emit confirm / closed / update:form；visible 走 prop + close 触发父组件 mutator。
-->

<template>
  <el-dialog
    :model-value="visible"
    :title="editing ? '编辑零件' : '添加零件'"
    :width="addDlg.width"
    :top="addDlg.top"
    :fullscreen="addDlg.fullscreen"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => !v && emit('close')"
    @closed="handleClosed"
  >
    <el-form :model="localForm" label-width="100px" label-position="right">
      <div class="form-grid">
        <div>
          <el-form-item label="图号" :error="formErrors.drawingNo">
            <el-input
              v-model="localForm.drawingNo"
              placeholder="例如：LT39822"
              @blur="emit('validateField', 'drawingNo')"
            />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="名称" :error="formErrors.name">
            <el-input
              v-model="localForm.name"
              placeholder="请输入品名 / 零件名称"
              @blur="emit('validateField', 'name')"
            />
          </el-form-item>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <el-form-item label="客户" :error="formErrors.customerId">
            <el-cascader
              v-model="localForm.customerId"
              :options="customerTree"
              :props="{
                value: 'id',
                label: 'name',
                children: 'children',
                checkStrictly: true,
                emitPath: false,
              }"
              placeholder="选择一级 / 二级客户"
              style="width: 100%"
              clearable
              @change="onCustomerChangeLocal"
            />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="申请人" :error="formErrors.applicantName">
            <el-autocomplete
              v-model="localForm.applicantName"
              value-key="name"
              :fetch-suggestions="querySearch"
              :trigger-on-focus="true"
              :debounce="0"
              :loading="applicantLoading"
              :disabled="!localForm.customerId"
              placeholder="选择或输入申请人姓名（不在表中则提交时自动新增）"
              style="width: 100%"
              clearable
              @select="onApplicantSelectLocal"
              @blur="emit('validateField', 'applicantName')"
            />
          </el-form-item>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <el-form-item label="数量" :error="formErrors.quantity">
            <el-input-number
              v-model="localForm.quantity"
              :min="1"
              :step="1"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="加急">
            <el-switch v-model="localForm.isUrgent" />
          </el-form-item>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <el-form-item label="请购日期" :error="formErrors.requestDate">
            <el-date-picker
              v-model="localForm.requestDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="请选择"
              style="width: 100%"
            />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="计划交期" :error="formErrors.plannedDeliveryDate">
            <el-date-picker
              v-model="localForm.plannedDeliveryDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="请选择"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </div>

      <!-- 送货单字段（PR-F 2026-07-17） -->
      <div class="form-grid">
        <div>
          <el-form-item label="订单号">
            <el-input v-model="localForm.orderNo" placeholder="如 6200037950（可选）" />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="系统交期">
            <el-date-picker
              v-model="localForm.systemDeliveryDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="订单方系统内部交期（可选）"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </div>

      <el-form-item label="备注">
        <el-input v-model="localForm.note" placeholder="文员手填备注（可选，送货单可见）" />
      </el-form-item>

      <el-form-item label="图纸">
        <div class="drawing-uploader">
          <!-- 2026-09-17 M4：图纸上传走 CosUploader（前端直传 COS tmp 区）。
               - accept=".pdf" + :multiple=false：单 PDF 限；
               - :max-size-m-b="300"：与 nginx 300m 上限对齐；
               - 不开 computeHash：sha 由 composable.requestDrawingUpload 内
                 computeSha256 算一次（避免大 PDF 算两次）；
               - @change 本地 wrapper trim 旧项只留最新（绕开 el-upload :limit
                 统计坑：cosUploader.removeItem 不会清 el-upload 内部列表）。
          -->
          <CosUploader
            ref="uploaderRef"
            :request-upload="requestDrawingUpload"
            accept=".pdf"
            :multiple="false"
            :max-size-m-b="300"
            tip="仅支持 PDF；提交时自动随表图号列点击预览（待新增一览 → 点图号）。"
            empty-text="未选择图纸（可选）"
            @change="handleUploaderChange"
            @uploaded="onDrawingUploadedLocal"
            @all-done="emit('drawingAllDone')"
            @error="onDrawingUploadErrorLocal"
          />
          <p v-if="editing && localForm.drawingName" class="form-hint">
            当前图纸：{{ localForm.drawingName }}；重新上传将替换。
          </p>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button
        type="primary"
        :loading="dialogSubmitting"
        :disabled="drawingUploading"
        @click="emit('confirm')"
      >
        {{ editing ? '保存到列表' : '加入列表' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// 2026-09-24：录入对话框展示壳。form 状态归父组件，本组件持本地副本 + emit 回写
// （与 auth 范本 LoginCard / LoginView 拆法一致 —— LoginCard 不持表单状态，
// 本组件同样把表单状态所有权放在父 composable usePartBatchManual）。
//
// emit 命名遵循 vue/custom-event-name-casing（仓库 lint 规则）：camelCase，
// 仅 update:* 协议事件可含连字符。

import { reactive, ref, toRaw, watch } from 'vue';
import CosUploader from '@/components/CosUploader.vue';
import type {
  CosUploadedItem,
  CosUploaderItem,
  CosUploadSession,
} from '@/composables/useCosUploader';
import type { FormState } from '../composables/usePartBatchManual';
import type { PartEntryFieldErrors, PartEntryInput } from '../partEntrySchema';
import type { Applicant } from '@/types/applicant';

interface Props {
  visible: boolean;
  /** 是否处于编辑模式（控制标题与按钮文案）。 */
  editing: boolean;
  /** 父组件持有 form；本组件通过本地副本 + emit('update:form') 同步回写。 */
  form: FormState;
  /** zod schema 校验错误聚合（替代 EP FormRules）。 */
  formErrors: PartEntryFieldErrors;
  /** 单字段校验入口（父组件 validateField，LoginView 同款）。 */
  validateField: (field: keyof PartEntryInput) => void;
  /** dialog 桌面宽度配置（useDialogSize 结果）。 */
  addDlg: { width: string | number; top: string; fullscreen: false };
  /** 客户 cascader 选项树（父组件 customerTree computed）。 */
  customerTree: Array<{ id: string; name: string; children?: Array<{ id: string; name: string }> }>;
  /** 申请人搜索相关 props（透传父 composable 的 applicantSearch 子集）。 */
  applicantLoading: boolean;
  querySearch: (queryString: string, cb: (items: Applicant[]) => void) => void;
  /** 父 composable handler（事件透传，避免在子组件里重复 import 业务逻辑）。
   *  命名不带 on 前缀（与 script 内 helper 区分，避免 vue/no-dupe-keys）。 */
  customerChange: (pickedId: unknown) => Promise<void>;
  applicantSelect: (item: Record<string, unknown>) => void;
  /** 2026-09-17 M4：图纸上传五回调。 */
  requestDrawingUpload: (files: File[]) => Promise<CosUploadSession>;
  drawingUploaded: (item: CosUploadedItem) => void;
  drawingItemsChange: (items: CosUploaderItem[]) => void;
  drawingAllDone: () => void;
  drawingUploadError: (item: CosUploaderItem) => void;
  /** 「加入列表」按钮 loading + 图纸上传中 disabled。 */
  dialogSubmitting: boolean;
  drawingUploading: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:form': [v: FormState];
  confirm: [];
  close: [];
  closed: [];
  validateField: [field: keyof PartEntryInput];
  drawingItemsChange: [items: CosUploaderItem[]];
  drawingUploaded: [item: CosUploadedItem];
  drawingAllDone: [];
  drawingUploadError: [item: CosUploaderItem];
}>();

// 走 as unknown as 两次断言绕开 TS "object literal" 报错（consistent-type-assertions 不触发，因为是 unknown 中转）
const localForm = reactive({} as unknown as FormState);
watch(
  () => props.form,
  (v) => {
    Object.assign(localForm, structuredClone(toRaw(v)));
  },
  { deep: true, immediate: true },
);
watch(
  localForm,
  (v) => {
    emit('update:form', { ...v });
  },
  { deep: true },
);

// 2026-09-17 M4：CosUploader ref（用于 handleUploaderChange trim + @closed 清队列）。
const uploaderRef = ref<InstanceType<typeof CosUploader> | null>(null);

/**
 * 本地 @change wrapper：cosUploader.removeItem 不会清 el-upload 内部列表，
 * `:limit="1"` 会导致永远超限。我们绕开方案：:limit="0"（不限）+ :multiple="false"，
 * 选第 N 个文件后这里 trim：保留最新一条，把前 N-1 条从 cos-uploader 内部移出。
 */
async function handleUploaderChange(items: CosUploaderItem[]): Promise<void> {
  if (items.length > 1) {
    const trimCount = items.length - 1;
    for (let i = 0; i < trimCount; i += 1) {
      const it = items[i];
      if (it) {
        await uploaderRef.value?.removeItem(it.client_ref);
      }
    }
  }
  emit('drawingItemsChange', items);
}

/**
 * el-dialog @closed 钩子：先清 CosUploader 队列（best-effort 清理 COS tmp 对象），
 * 再发 'closed' 让父 composable 走 onDialogClosed 清 form / formErrors / 临时状态。
 */
function handleClosed(): void {
  void uploaderRef.value?.clear();
  emit('closed');
}

// cascader / applicant / drawing 事件直接透传 — 父 composable 持有状态机。
function onCustomerChangeLocal(pickedId: unknown): Promise<void> {
  return props.customerChange(pickedId);
}
function onApplicantSelectLocal(item: Record<string, unknown>): void {
  props.applicantSelect(item);
}
function onDrawingUploadedLocal(item: CosUploadedItem): void {
  emit('drawingUploaded', item);
}
function onDrawingUploadErrorLocal(item: CosUploaderItem): void {
  emit('drawingUploadError', item);
}
</script>

<style lang="scss" scoped>
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}
.form-hint {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
