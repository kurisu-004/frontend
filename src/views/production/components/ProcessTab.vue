<!-- 工序管理 Tab（2026-09-12 从 settings/ProcessList.vue 迁移至 production/components）
     2026-09-12 新增：表格加「颜色」列（width 80，渲染 24x24 色块），
     dialog 加 el-color-picker（color-format="hex8" 输出 #RRGGBBAA）。
-->
<template>
  <div class="process-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="代码">
          <el-input v-model="search.code_like" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="类别">
          <el-select v-model="search.category" clearable style="width: 120px">
            <el-option label="自产" value="INHOUSE" />
            <el-option label="外协" value="OUTSOURCE" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="() => refetchProcesses()"
            ><el-icon><Search /></el-icon><span>查询</span></el-button
          >
          <el-button @click="onReset"
            ><el-icon><RefreshLeft /></el-icon><span>重置</span></el-button
          >
          <el-button v-if="isManager" type="success" @click="onNew"
            ><el-icon><Plus /></el-icon><span>新增工序</span></el-button
          >
        </el-form-item>
      </el-form>
    </el-card>

    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @resetOrder="drag.reset"
      />
    </div>
    <el-table
      ref="tableRef"
      v-loading="loading"
      :data="rows"
      row-key="id"
      stripe
      border
      size="small"
    >
      <template #empty>
        <el-empty description="暂无工序" />
      </template>
      <el-table-column type="index" label="#" width="50" />
      <!--
        2026-08-27 T15：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
        用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
        type=index / fixed="right" 操作列保留为字面量 <el-table-column>。
      -->
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :sortable="d.sortable"
          :align="d.align"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :column-key="d.columnKey ?? d.key"
          :label-class-name="drag.dragLabelClass(d)"
        >
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
          <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
        </el-table-column>
      </template>
      <!-- 2026-09-12 新增：颜色列，固定在操作列之前 -->
      <el-table-column label="颜色" width="80" align="center">
        <template #default="{ row }">
          <span
            class="color-swatch"
            :style="{
              background: (row as Process).color ?? '#ddd',
              width: '24px',
              height: '24px',
              borderRadius: '4px',
              display: 'inline-block',
              border: '1px solid #eee',
            }"
          />
        </template>
      </el-table-column>
      <el-table-column v-if="isManager" label="操作" min-width="180" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="onEdit(row as Process)"
            >编辑</el-button
          >
          <el-button link type="danger" size="small" @click="onDelete(row as Process)"
            >删除</el-button
          >
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      :width="dialogSize.width"
      :top="dialogSize.top"
      :fullscreen="dialogSize.fullscreen"
      @closed="onDialogClosed"
    >
      <el-form :model="form" label-width="80px" label-position="right">
        <el-form-item label="代码" required>
          <el-input
            v-model="form.code"
            :disabled="!!editing"
            placeholder="如 车 / 铣 / CNC / 热处理"
          />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="类别" required>
          <el-select v-model="form.category" style="width: 100%">
            <el-option label="自产" value="INHOUSE" />
            <el-option label="外协" value="OUTSOURCE" />
          </el-select>
        </el-form-item>
        <el-form-item label="需要审批">
          <el-switch
            v-model="form.requires_approval"
            :disabled="form.category === 'INHOUSE'"
            active-text="需要审批"
            inactive-text="直接发送"
            inline-prompt
            style="--el-switch-off-color: #67c23a"
          />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort_order" :min="0" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" />
        </el-form-item>
        <!--
          2026-09-16 升级：el-color-picker 加 show-alpha + 预定义色板（PROCESS_COLOR_PRESETS）。
          color-format="hex8" 输出 #RRGGBBAA 9 字符，与后端 t_process.color VARCHAR(9) 兼容；
          predefine 必须是可变 string[]，故展开 readonly 常量（深拷贝避免引用突变）。
        -->
        <el-form-item label="颜色">
          <el-color-picker
            v-model="form.color"
            color-format="hex8"
            :show-alpha="true"
            :predefine="[...PROCESS_COLOR_PRESETS]"
          />
          <span class="hint">点击预设色板一键填色，hex8 含 alpha</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// 2026-09-26 改造：列表改走共享 query useProcessesQuery（queryKey 进 code_like /
// category，搜索条件变化自动 refetch，不再手写 fetchList + watcher）。
// 写点（createProcess / updateProcess / softDeleteProcess）包 useMutation +
// invalidateProcessesQuery(qc) 完成「写后失效 + ElMessage」原子流程。
// mutation 全局 retry: 0：信任 main.ts 已显式 queries/mutations.retry: 0。
//
// 2026-09-26 修复 review B-1：useProcessesQuery 升级为接受 MaybeRefOrGetter
// 入参，queryKey 走 computed，user 改 search.code_like / category 后 vue-query
// 自动 refetch；删除外置 watcher（reactives + computed queryKey 已自带响应式）；
// 「查询」按钮显式 @click 触发 refetch（兼容习惯点查询的用户）。
import { computed, h, onMounted, reactive, ref } from 'vue';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox, ElTag } from 'element-plus';
import { Search, RefreshLeft, Plus } from '@element-plus/icons-vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag';
import { useDialogSize } from '@/composables/useDialogSize';
import { usePermissions } from '@/composables/usePermissions';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import {
  invalidateProcessesQuery,
  useProcessesQuery,
} from '@/composables/queries/useProcessesQuery';
import { createProcess, softDeleteProcess, updateProcess } from '@/api/process';
import type { Process, ProcessCategory } from '@/types/process';
import { PROCESS_CATEGORY_LABEL, PROCESS_COLOR_PRESETS } from '@/types/process';

const { isManager } = usePermissions();
const dialogSize = useDialogSize({ desktopWidth: 460 });
const qc = useQueryClient();

// ============ 列表：共享 query ============
// 2026-09-26：search.code_like / search.category 进 queryKey，cleanParams 剥掉
// 空值后独立缓存；用户改筛选条件即自动 refetch，无需手动调 fetchList 或挂 watcher。
const search = reactive<{ code_like: string; category: ProcessCategory | undefined }>({
  code_like: '',
  category: undefined,
});
const queryParams = computed(() => ({
  code_like: search.code_like || undefined,
  category: search.category,
  limit: 200,
}));
// 2026-09-26（review B-1 修复）：useProcessesQuery 升级为接受 MaybeRefOrGetter，
// 把 queryParams computed 直接传进去；queryKey 走 computed(toValue(params))，
// search.code_like / search.category 任一变化 → queryKey 变化 → useQuery
// 自动 refetch（无需外置 watcher）；queryFn 从 queryKey[2] 读最新 params。
const { data: queryData, isFetching, refetch: refetchProcesses } = useProcessesQuery(
  queryParams,
);
const rows = computed<Process[]>(() => (queryData.value?.items ?? []) as Process[]);
const loading = computed<boolean>(() => isFetching.value);
const saving = ref(false);

// ============ 筛选状态持久化 ============
const { restore: restoreProcessFilter } = useListStatePersist('process_list', { search });

// ============ 列可见性 + 列顺序拖动 ============
// 「#」「颜色」「操作」列不放进 defs → 始终可见。
// 2026-08-27 T15：补 prop / minWidth / align + 复杂单元格走 cellRender。
const columnDefs: ColumnDef[] = [
  { key: 'code', label: '代码', prop: 'code', minWidth: 120, align: 'center' },
  { key: 'name', label: '名称', prop: 'name', minWidth: 160, align: 'center' },
  {
    key: 'category',
    label: '类别',
    minWidth: 100,
    align: 'center',
    cellRender: ({ row }) =>
      h(
        ElTag,
        { type: (row as Process).category === 'INHOUSE' ? 'primary' : 'warning', size: 'small' },
        () => PROCESS_CATEGORY_LABEL[(row as Process).category],
      ),
  },
  {
    key: 'requires_approval',
    label: '审批模式',
    minWidth: 110,
    align: 'center',
    cellRender: ({ row }) =>
      h(
        ElTag,
        { type: (row as Process).requires_approval ? 'warning' : 'success', size: 'small' },
        () => ((row as Process).requires_approval ? '需要审批' : '直接发送'),
      ),
  },
  { key: 'sort_order', label: '排序', prop: 'sort_order', minWidth: 80, align: 'center' },
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'process_list' });
const drag = useColumnDrag(columnDefs, { listKey: 'process_list' });
// 2026-08-27 T15：列拖动 onMounted 挂 useDraggable 到表头 <tr>（列换序；绑 thead 会变成拖整行，2026-08-27 修正）
const tableRef = ref();

const dialogVisible = ref(false);
const editing = ref<Process | null>(null);
const dialogTitle = computed(() => (editing.value ? '编辑工序' : '新增工序'));
// 2026-09-12 新增：color 字段（后端 tri-state：undefined=leave / null=clear / string=set）
const form = reactive<{
  code: string;
  name: string;
  category: ProcessCategory;
  sort_order: number;
  description: string;
  requires_approval: boolean;
  color: string | null;
}>({
  code: '',
  name: '',
  category: 'INHOUSE',
  sort_order: 0,
  description: '',
  requires_approval: true, // OUTSOURCE 默认；INHOUSE 在保存时由后端强制为 false
  color: null,
});

function onReset(): void {
  search.code_like = '';
  search.category = undefined;
  // queryKey 变化自动 refetch，无需手动 fetchList
}
function onNew(): void {
  editing.value = null;
  Object.assign(form, {
    code: '',
    name: '',
    category: 'INHOUSE',
    sort_order: 0,
    description: '',
    requires_approval: true,
    color: null,
  });
  dialogVisible.value = true;
}
function onEdit(row: Process): void {
  editing.value = row;
  Object.assign(form, {
    code: row.code,
    name: row.name,
    category: row.category,
    sort_order: row.sort_order,
    description: row.description ?? '',
    requires_approval: row.requires_approval ?? true,
    color: row.color ?? null,
  });
  dialogVisible.value = true;
}

// 2026-09-26：3 个写操作统一 useMutation + onSuccess 走 invalidateProcessesQuery
// + ElMessage。不写 retry（信任全局 defaultOptions）。
const createMutation = useMutation({
  mutationKey: ['processes', 'create'],
  mutationFn: (payload: Parameters<typeof createProcess>[0]) => createProcess(payload),
  onSuccess: async () => {
    await invalidateProcessesQuery(qc);
    ElMessage.success('已新增');
  },
  onError: (e: Error) => ElMessage.error(e.message ?? '保存失败'),
});
const updateMutation = useMutation({
  mutationKey: ['processes', 'update'],
  mutationFn: (vars: { id: string; payload: Parameters<typeof updateProcess>[1] }) =>
    updateProcess(vars.id, vars.payload),
  onSuccess: async () => {
    await invalidateProcessesQuery(qc);
    ElMessage.success('已保存');
  },
  onError: (e: Error) => ElMessage.error(e.message ?? '保存失败'),
});
const deleteMutation = useMutation({
  mutationKey: ['processes', 'delete'],
  mutationFn: (id: string) => softDeleteProcess(id),
  onSuccess: async () => {
    await invalidateProcessesQuery(qc);
    ElMessage.success('已删除');
  },
  onError: (e: Error) => ElMessage.error(e.message ?? '删除失败'),
});

async function onSave(): Promise<void> {
  if (!form.code.trim() || !form.name.trim()) {
    ElMessage.warning('代码与名称不能为空');
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      // 2026-09-16 修复：update 走差量。category 是业务唯一键（保护 t_part.next_process_id
      // 等外键引用），后端 20104 拒绝 category 变更；前端必须只在用户**主动改 category**
      // 时才发该字段，未改则省略 → 后端 Option<None> 走 leave 语义。
      const payload: Parameters<typeof updateProcess>[1] = {
        name: form.name.trim(),
        sort_order: form.sort_order,
        description: form.description.trim() || null,
        requires_approval: form.requires_approval,
        // color 三态：未改 = 上一次的值（picker 默认保留）；此处显式传当前值，
        // 后端按 string|null 覆盖语义处理；与原值相等也是无副作用的 set。
        color: form.color ?? null,
      };
      if (form.category !== editing.value.category) {
        payload.category = form.category;
      }
      await updateMutation.mutateAsync({ id: editing.value.id, payload });
    } else {
      await createMutation.mutateAsync({
        code: form.code.trim(),
        name: form.name.trim(),
        category: form.category,
        sort_order: form.sort_order,
        description: form.description.trim() || null,
        requires_approval: form.requires_approval,
        // create：picker 默认 null（不选色），string 表示选了色
        color: form.color ?? null,
      });
    }
    dialogVisible.value = false;
  } catch {
    // mutation onError 已 ElMessage 提示；此处吞掉即可
  } finally {
    saving.value = false;
  }
}

function onDialogClosed(): void {
  editing.value = null;
  Object.assign(form, {
    code: '',
    name: '',
    category: 'INHOUSE',
    sort_order: 0,
    description: '',
    requires_approval: true,
    color: null,
  });
}

async function onDelete(row: Process): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除工序「${row.name}」?被引用时拒绝。`, '提示', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await deleteMutation.mutateAsync(row.id);
  } catch {
    // mutation onError 已 ElMessage 提示
  }
}

onMounted(() => {
  // 先尝试恢复 localStorage 中的搜索条件（影响 queryParams → queryKey，自动 refetch）
  const persisted = restoreProcessFilter();
  if (persisted) {
    Object.assign(search, persisted.search);
  }
  // 2026-08-28 改造：传 el-table 实例 ref 即可，composable 内部解析表头 <tr> +
  // MutationObserver 自愈（表头首次出现 / EP 重建都能覆盖）。
  drag.applyDrag(tableRef);
});
</script>

<style lang="scss" scoped>
.process-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.color-swatch {
  vertical-align: middle;
}
.hint {
  margin-left: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
