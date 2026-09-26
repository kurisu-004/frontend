<!--
  PartBatchNew.vue

  /parts/new  批量新建零件页（与 /parts 并列）—— 装配壳。

  2026-08-25 拆分：原 3000+ 行单文件拆为：
    - 本 shell：el-tabs + 两个 Tab 组件挂载
    - components/PartBatchManualTab.vue：Tab 1「录入」
    - components/PartBatchPdfTab.vue：Tab 2「PDF 批量上传」
    - composables/usePartBatchShared.ts：纯工具函数
    - composables/usePartBatchManual.ts：Tab 1 状态 + handler
    - composables/usePartBatchPdf.ts：Tab 2 状态 + handler

  流程（两个 Tab 各自独立）：
    - Tab 1「录入」：点空白区 / 「+ 添加零件」 → 弹 Dialog 填一条零件 → 入队
      → 点行查看 / 提交 N 条 → POST /api/v1/parts/batch
    - Tab 2「PDF 批量上传」：拖 PDF + 可选 Excel + 可选 3D 模型 → 按文件名解析图号 →
      单页直接进独立零件 / 多页走源文件区选页合并 → 提交

  提交成功后两 Tab 都跳 /parts?status=PENDING。
-->

<template>
  <div class="batch-new">
    <el-tabs v-model="activeTab" class="batch-tabs">
      <el-tab-pane label="录入" name="manual">
        <!-- 2026-09-13 PR-2：子组件 emit('update:form') 把本地编辑结果合并回
             usePartBatchManual 持有的 form（v-bind 摊开 props 后再单独监听 emit）。 -->
        <PartBatchManualTab v-bind="manual" @update:form="onManualFormChange" />
      </el-tab-pane>
      <el-tab-pane label="PDF 批量上传" name="pdf">
        <PartBatchPdfTab
          v-bind="pdf"
          @update:pdf-form="onPdfFormChange"
          @update:manual-part-form="onManualPartFormChange"
          @update:manual-asm-form="onManualAsmFormChange"
        />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { Customer } from '@/api/customer';
// 2026-09-26：客户全集改走共享 query useCustomersQuery（CustomerList 写后失效自动 refetch）。
// 原 customers ref + loadCustomers() 删除；ComputedRef<Customer[]> 与
// usePartBatchManual / usePartBatchPdf 的 Ref<Customer[]> 入参在 Vue 3 类型层兼容
// （ComputedRef 继承 Ref）。
import { useCustomersQuery } from '@/composables/queries/useCustomersQuery';
import { useApplicantSearch } from '@/composables/useApplicantSearch';
import PartBatchManualTab from './components/PartBatchManualTab.vue';
import PartBatchPdfTab from './components/PartBatchPdfTab.vue';
import { usePartBatchManual } from './composables/usePartBatchManual';
import { usePartBatchPdf } from './composables/usePartBatchPdf';

const router = useRouter();
const route = useRoute();

// ============ 客户全集（两 Tab 共用，避免重复拉） ============
// 2026-09-26：useCustomersQuery 自动 fetch；下游 composable 通过 .value 读 computed 结果。
const { data: customersData, error: customersError } = useCustomersQuery();
const customers = computed<Customer[]>(() => customersData.value?.items ?? []);
// 错误桥接：query.error 一次 watch → ElMessage（与 useCustomerTree 同款）。
watch(
  () => customersError.value,
  (err) => {
    if (err) ElMessage.error(err.message ?? '客户列表加载失败');
  },
);

// ============ 申请人搜索（两 Tab 共用 cache） ============
const applicantSearch = useApplicantSearch({
  resolveRootCustomerId: (pickedId) => {
    if (!pickedId) return null;
    const picked = customers.value.find((c) => c.id === pickedId);
    if (!picked) return null;
    if (picked.parent_id === null) return picked.id;
    return picked.parent_id;
  },
});

// ============ 当前激活 tab ============
// URL ?tab=manual|pdf 双向同步；缺省 manual。
const activeTab = ref<string>(typeof route.query.tab === 'string' ? route.query.tab : 'manual');
watch(activeTab, (v) => {
  router.replace({ query: { ...route.query, tab: v } });
});

// PDF Tab 提交成功后切到的 tab 名（默认 manual）。
const successNextTab = ref<string>('manual');

// ============ 两 Tab composable ============
// 2026-08-25：包一层 reactive() 让 v-bind="..." 能把嵌套 ref / computed 在
// 类型层面「解包」成普通值，避开 Vue 3.4 对 v-bind object 静态类型严格校验。
const manual = reactive(usePartBatchManual({ customers, applicantSearch }));
const pdf = reactive(usePartBatchPdf({ customers, applicantSearch, successNextTab }));

// 2026-08-25 fix：监听 PDF Tab 提交成功后由 composable 写入的 successNextTab，
// 切回 activeTab。原 PartBatchNew.vue 提交后直接 activeTab='manual'，拆 Tab 后
// 这部分代码归 PDF Tab composable，shell 负责 tab 切换。
watch(successNextTab, (v) => {
  if (v) activeTab.value = v;
});

// PR-2 2026-09-13：子组件用本地 reactive 副本做双向 v-model，emit('update:form')
// 通知 shell 把最新值合并回 usePartBatchManual / usePartBatchPdf 持有的 form。
// 这样子组件读到的 props.form 在 onAddConfirm / onConfirmManualPart 等 handler
// 触发时就是当前编辑的内容。
function onManualFormChange(v: Parameters<typeof Object.assign>[1]): void {
  Object.assign(manual.form, v);
}
function onPdfFormChange(v: Parameters<typeof Object.assign>[1]): void {
  Object.assign(pdf.pdfForm, v);
}
function onManualPartFormChange(v: Parameters<typeof Object.assign>[1]): void {
  Object.assign(pdf.manualPartForm, v);
}
function onManualAsmFormChange(v: Parameters<typeof Object.assign>[1]): void {
  Object.assign(pdf.manualAsmForm, v);
}
</script>

<style lang="scss" scoped>
.batch-new {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
