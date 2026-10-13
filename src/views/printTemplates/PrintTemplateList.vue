<!--
  PrintTemplateList.vue — 送货单打印模板管理页（`/print-templates`）

  2026-10-16 新建。职责只有**拼装 + 生命周期**：一级客户筛选 + 上传（带逐格校验）+ 模板
  列表 + 下载 / 软删。全部页面态在 `composables/usePrintTemplatesStore.ts`（Pinia setup
  store，4 不变量见该文件头），守门 schema 在 `printTemplateSchema.ts`。

  ⚠️ **本页只做「上传 + 查看已有模板」，不做可视化模板编辑器**：前者（x-data-spreadsheet
  可视化设计器）随该库弃用于 2026-09-24 一并下线，用户已拍板不再复活。模板内容的唯一编辑
  手段是「在 Excel 里改好再上传」，而**上传前的逐格校验**（`assertTemplateMatches`）就是这条
  链路的护栏 —— 坏模板在入库前就被拦下，不会飘到客户签字的收货凭证上。

  ⚠️ **上传的目标客户 = 当前筛选的那一个一级客户**，两者是同一个 `store.query.customerId`：
  后端的绑定维度就是「一份模板 ↔ 一个一级客户」（同一 L1 二次上传 = 替换），所以「先选客户、
  再上传」不是两步表单，而是一处状态。未选客户时上传按钮禁用 —— 没有 customer_id 的
  multipart 是后端 40001，不是易用性洁癖。

  消费 store **不写 .value**（Pinia 深代理自动解包），统一 `store.切片.字段`。
-->
<template>
  <div class="print-template-list">
    <el-card shadow="never">
      <div class="toolbar-row">
        <span class="toolbar-label">一级客户</span>
        <el-select
          :model-value="store.query.customerId"
          placeholder="全部客户"
          filterable
          clearable
          style="width: 260px"
          :loading="customersQuery.isFetching.value"
          @update:model-value="onCustomerChange"
        >
          <el-option v-for="c in l1Customers" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>

        <!-- ⚠️ `:limit="1"` 的坑：第二次选**同一个**文件不触发 on-change，必须先 clearFiles()
             清掉 el-upload 的内部列表（仓内同款注释与实现见打印对话框的 `onExceed`）。 -->
        <el-upload
          ref="uploadRef"
          :auto-upload="false"
          :show-file-list="false"
          :accept="PRINT_TEMPLATE_ACCEPT"
          :limit="1"
          :disabled="!store.query.customerId || !canManage || store.upload.busy"
          :on-change="onFileChange"
          :on-exceed="onExceed"
        >
          <el-button
            type="primary"
            :loading="store.upload.busy"
            :disabled="!store.query.customerId || !canManage"
          >
            上传模板
          </el-button>
        </el-upload>

        <el-button @click="onRefresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>

        <span class="toolbar-hint">
          {{
            store.query.customerId
              ? '上传的模板会绑定到上面选中的这个一级客户，打印该客户的送货单时自动选用。'
              : '先选一个一级客户才能上传：模板是按一级客户绑定的（同一客户再次上传即替换）。'
          }}
        </span>
      </div>
    </el-card>

    <!-- 校验差异逐条上屏：模板一列错位，导出的送货单在客户那边就是废纸 ⇒ 差异必须让用户自己
         看出「改错了哪一格」，而不是只给一句「校验失败」。守卫见
         `views/com/delivery/utils/__tests__/deliveryNoteTemplate.spec.ts`。 -->
    <el-alert
      v-if="store.upload.diffs.length > 0"
      class="upload-diffs"
      type="error"
      show-icon
      :closable="false"
      :title="`模板校验未通过，共 ${store.upload.diffs.length} 处差异（已取消上传）`"
    >
      <div v-for="(d, i) in store.upload.diffs" :key="i" class="upload-diff">{{ d }}</div>
    </el-alert>

    <el-card shadow="never">
      <el-empty
        v-if="!store.query.loading && store.query.rows.length === 0"
        :description="store.query.customerId ? '该一级客户还没有绑定模板' : '还没有上传过模板'"
      />
      <el-table v-else v-loading="store.query.loading" :data="store.query.rows" row-key="id">
        <el-table-column label="客户" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.customer_name || '（已删除的客户）' }}</template>
        </el-table-column>
        <el-table-column
          prop="original_filename"
          label="文件名"
          min-width="220"
          show-overflow-tooltip
        />
        <el-table-column label="大小" width="100">
          <template #default="{ row }">{{ formatBytes(row.file_size) }}</template>
        </el-table-column>
        <!-- sha256 只展示前 8 位：全串 64 个字符会把表格撑成横向滚动，而这一列的用途只是
             「两行的内容是不是同一份」的肉眼比对，不是复制粘贴。 -->
        <el-table-column label="内容指纹" width="120">
          <template #default="{ row }">
            <span v-if="row.content_sha256" class="sha">{{ row.content_sha256.slice(0, 8) }}</span>
            <span v-else class="cell-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="updated_at" label="更新时间" width="180" />
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :loading="store.actions.downloadingRowId === row.id"
              @click="store.actions.download(row as PrintTemplateData)"
            >
              下载
            </el-button>
            <el-popconfirm
              title="确认删除这份模板？删除后该一级客户打印送货单时需要手动选择模板。"
              width="340"
              confirm-button-text="确认删除"
              cancel-button-text="取消"
              @confirm="store.actions.remove(row as PrintTemplateData)"
            >
              <template #reference>
                <el-button
                  link
                  type="danger"
                  :disabled="!canManage"
                  :loading="store.actions.deletingRowId === row.id"
                >
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// views/printTemplates/PrintTemplateList.vue
//
// 2026-10-16 新建：见文件头。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { useCustomersQuery } from '@/composables/queries/useCustomersQuery';
import { canManagePrintTemplates } from '@/utils/printTemplatePermissions';
import { usePrintTemplatesStore } from './composables/usePrintTemplatesStore';
import { PRINT_TEMPLATE_ACCEPT, type PrintTemplateData } from './printTemplateSchema';

// 不变量 #1：壳 setup 顶部首调 store（$dispose 绑到首个创建它的组件）。
const store = usePrintTemplatesStore();

/** 一级客户全集。⚠️ **必须筛 `parent_id === null`**：客户是两级结构，模板只绑一级
 *  （后端对 `parent_id != null` 的客户返 20104）。把二级客户也放进下拉，用户选了必然吃
 *  一个 20104，且提示还很难懂（「客户不存在」而不是「不能选二级客户」）。 */
const customersQuery = useCustomersQuery();
const l1Customers = computed(() =>
  (customersQuery.data.value?.items ?? []).filter((c) => c.parent_id === null),
);

/** 写操作闸门（后端三条写端点 MANAGER 独占，见 `utils/printTemplatePermissions.ts`）。 */
const canManage = canManagePrintTemplates();

/** el-upload 的实例句柄：`:limit="1"` 时必须 `clearFiles()` 才能重选同一个文件。 */
const uploadRef = ref<{ clearFiles: () => void } | null>(null);

function onExceed(): void {
  uploadRef.value?.clearFiles();
}

/**
 * 选好文件 → 交给 store 做「扩展名闸 → 逐格校验 → 上传」三步。
 *
 * ⚠️ `:auto-upload="false"` 意味着 el-upload **不会**自己发请求（那会绕过我们的校验与
 * FormData 组装）；真正的请求在 `store.upload.run` 里，走 `api/printTemplates.ts::uploadPrintTemplate`。
 */
async function onFileChange(file: { raw?: File }): Promise<void> {
  if (!file?.raw) return;
  await store.upload.run(file.raw, store.query.customerId);
  // 无论成败都清空内部列表：留在列表里会让「再选同一个文件」不触发 on-change
  // （`:limit="1"` 的既有行为），用户会以为上传器坏了。
  uploadRef.value?.clearFiles();
}

/** 切一级客户筛选。`clearable` 会给出 `undefined`，归一成空串（= 不筛选）。 */
function onCustomerChange(v: string | undefined): void {
  store.query.customerId = v ?? '';
}

function onRefresh(): void {
  void store.query.refresh();
}

/** 字节数的可读化（与零件详情那套同款：`B` / `KB` / `MB` 三档）。 */
function formatBytes(v: string | number): string {
  const n = Number(v);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

onMounted(() => {
  // 开 enabled 闸门 → 列表首屏 fetch。
  store.query.openGate();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开本页时销毁，下次进入重建 fresh 状态。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.print-template-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-label {
  font-weight: 600;
  color: var(--text-primary, #303133);
}

.toolbar-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.upload-diffs {
  margin-bottom: 0;
}

.upload-diff {
  line-height: 18px;
}

.sha {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
}

.cell-muted {
  color: var(--text-secondary);
}
</style>
