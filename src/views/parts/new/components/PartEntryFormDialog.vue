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
  - 2026-10-17（客户无限层级改造）：options 改吃 `buildCustomerTree` 的产物（任意
    深度），cascader label 改走 `customer_path`；「必须落叶子」的校验在父组件
    `onAddConfirm`，本组件只负责展示。
  - 2026-10-15（翻转时序）：图纸区的 `<CosUploader>` 换成 `<el-upload
    :auto-upload="false">`，**只暂存本地 File**。五个上传回调 prop 与对应的 emit 全部
    删除，改成一个 `drawingFileChange(file: File | null)`。上传发生在建单成功之后，
    由父 composable 的 `runDrawingUploadPhase` 负责。
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
              :options="cascaderOptions"
              :props="CASCADER_PROPS"
              placeholder="选择客户（末级部门）"
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
          <!-- 2026-10-15 翻转时序：这里**只暂存本地 File，不发任何请求**。
               - :auto-upload="false" + 不给 action：el-upload 不会把文件发给任何地址；
               - :limit="1"：单 PDF 限（换选 = 替换）；
               - :on-change：选中新文件 → 暂存并重建 blob URL（预览用）；
               - :on-remove：清暂存。
               真正的上传发生在「提交创建」成功之后（`usePartBatchManual` 的
               `runDrawingUploadPhase`），走直传链路。 -->
          <el-upload
            :auto-upload="false"
            :show-file-list="true"
            :limit="1"
            accept=".pdf"
            :file-list="drawingFileList"
            :on-change="onDrawingChange"
            :on-remove="onDrawingRemove"
          >
            <el-button plain>选择 PDF 图纸（可选）</el-button>
          </el-upload>
          <p class="form-hint">
            仅支持 PDF（最大 300MB）。图纸会在**零件创建成功后**自动上传；点「提交创建」之前不会
            发起任何上传。
          </p>
          <p v-if="localForm.drawingName" class="form-hint">
            已选择：{{ localForm.drawingName }}
            <template v-if="editing">（重新选择将替换）</template>
          </p>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button
        type="primary"
        :loading="dialogSubmitting"
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

import { computed, reactive, toRaw, watch } from 'vue';
import type {
  CascaderOption,
  UploadFile,
  UploadFiles,
  UploadRawFile,
} from 'element-plus';
import type { FormState } from '../composables/usePartBatchManual';
import type { PartEntryFieldErrors, PartEntryInput } from '../partEntrySchema';
import type { Applicant } from '@/types/applicant';
import type { CustomerTreeNode } from '@/api/customer.tree';

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
  /**
   * 客户 cascader 选项树（父组件 customerTree computed = buildCustomerTree 产物，
   * **任意深度**）。节点带 `customer_path`，cascader 的 label 吃它。
   */
  customerTree: CustomerTreeNode[];
  /** 申请人搜索相关 props（透传父 composable 的 applicantSearch 子集）。 */
  applicantLoading: boolean;
  querySearch: (queryString: string, cb: (items: Applicant[]) => void) => void;
  /** 父 composable handler（事件透传，避免在子组件里重复 import 业务逻辑）。
   *  命名不带 on 前缀（与 script 内 helper 区分，避免 vue/no-dupe-keys）。 */
  customerChange: (pickedId: unknown) => Promise<void>;
  applicantSelect: (item: Record<string, unknown>) => void;
  /**
   * 2026-10-15：图纸暂存回调（**不是上传**）。传新选的文件；传 null 表示用户移除。
   * 父组件只暂存 File，真正的上传发生在建单成功之后。
   */
  drawingFileChange: (file: File | null) => void;
  /** 「加入列表」按钮 loading。 */
  dialogSubmitting: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:form': [v: FormState];
  confirm: [];
  close: [];
  closed: [];
  validateField: [field: keyof PartEntryInput];
}>();

/** el-cascader 的 props 配置（2026-10-17 客户无限层级改造后重写注释）。
 *
 *  - `checkStrictly: true` **保留**：草稿 / 编辑态允许选任意层级的节点（用户在组装草稿
 *    时可能先定部门再定班组）。「必须落叶子」是**提交时**的校验，走父组件
 *    `onAddConfirm` 的业务层（schema 那层拿不到客户树结构，见 partEntrySchema 文件头）。
 *  - `emitPath: false`：v-model 直接拿到单个 id（父组件 onCustomerChange 按此解包）。
 *  - `label: 'customer_path'`：每级显示「从第 2 层到本级」的 ` / ` 拼接，**不含 L1**
 *    （L1 是根列，按后端口径等于自己的名字）。三条理由：
 *      ① 输入框里只显示**选中节点**那一个 label —— label 若是 `name`，选完只看到
 *         「装配班」三个字，同名部门跨分支时完全无法分辨挂到了哪家；
 *      ② el-cascader 每列已按父级分组，层级上下文来自列的位置，不需要每列都把 L1
 *         重复一遍（`customer_path` 本来就不含 L1，不会重复）；
 *      ③ 深度 ≤ 2 时 `customer_path === name`，零视觉变化；深度 ≥ 3 时增长的是祖先链，
 *         而消歧价值恰好出现在这一档。代价是深层列变宽，由面板自身省略号兜底。
 */
const CASCADER_PROPS = {
  value: 'id',
  label: 'customer_path',
  children: 'children',
  checkStrictly: true,
  emitPath: false,
} as const;

/**
 * el-cascader 的 `options` 形参声明是 `CascaderOption[]`（带 `[key: string]: any`
 * 索引签名），而 `CustomerTreeNode` 是我们自己的精确类型、没有索引签名 ⇒ 直接传会
 * 报 TS2322。**只有这一处需要放宽**：cascader 运行时按 `CASCADER_PROPS` 里的
 * `value` / `label` / `children` 三个键取值，读不到别的键，也不会往节点上写任何东西
 * （checkStrictly 的勾选态是组件内部维护的）。不带 this 断言会红（见本文件类型检查）。
 */
const cascaderOptions = computed(() => props.customerTree as unknown as CascaderOption[]);

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

/**
 * el-upload 的 `:file-list`：把父 composable 暂存的 File 包成一条 el-upload 行。
 *
 * 受控用法（而不是让 el-upload 自管内部列表）—— 暂存的权威是父组件的 `form`，
 * el-upload 只是它的视图。
 *
 * ⚠️ `uid` 是 **number**（EP 的 `UploadFile.uid` 声明），所以不能拿文件名当键；这里用
 * 「字节数 + 修改时间」哈希成整数（同一份文件在两次渲染里必须落同一个 uid，否则
 * el-upload 会把它当新行、列表越点越长）。纯前端展示用的键，不需要跨会话唯一。
 */
function fileUidOf(f: File): number {
  let h = f.size % 2147483647;
  for (const ch of f.name) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
  return h;
}

const drawingFileList = computed<UploadFile[]>(() => {
  const f = props.form.drawingFile;
  if (!f) return [];
  const uid = fileUidOf(f);
  // ⚠️ EP 的 `UploadFile.raw` 类型是 `UploadRawFile`（= File & { uid: number }），
  // 所以这里要包一层带 uid 的 File。`new File([f], ...)` **不复制字节**（Blob 按引用
  // 传），成本可忽略；而省掉它就会在 on-change 里丢 uid。
  const raw = Object.assign(new File([f], f.name, { type: f.type }), { uid }) as UploadRawFile;
  return [{ name: props.form.drawingName ?? f.name, uid, status: 'ready', raw }];
});

/** el-upload on-change：只暂存，不上传。选了新文件即替换（:limit=1 的语义）。 */
function onDrawingChange(file: UploadFile, _files: UploadFiles): void {
  const raw = file.raw as File | undefined;
  if (!raw) return;
  props.drawingFileChange(raw);
}

/** el-upload on-remove：清暂存。 */
function onDrawingRemove(): void {
  props.drawingFileChange(null);
}

/**
 * el-dialog @closed 钩子：让父 composable 走 onDialogClosed 清 form / formErrors。
 *
 * 2026-10-15：这里原本还要 `await uploaderRef.value?.clear()`（清理 COS tmp 对象）——
 * 直传链路下对话框里根本没有上传过任何东西，那一步整体删除。
 */
function handleClosed(): void {
  emit('closed');
}

// cascader / applicant 事件直接透传 — 父 composable 持有状态机。
function onCustomerChangeLocal(pickedId: unknown): Promise<void> {
  return props.customerChange(pickedId);
}
function onApplicantSelectLocal(item: Record<string, unknown>): void {
  props.applicantSelect(item);
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
