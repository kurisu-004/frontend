<template>
  <div class="shelf-page">
    <div class="page-header">
      <h2>货架管理</h2>
      <el-button type="primary" @click="showCreate = true">新增货架</el-button>
    </div>
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
      :data="items"
      row-key="id"
      empty-text="暂无货架"
      stripe
      :default-sort="{ prop: 'display_order', order: 'ascending' }"
    >
      <template #empty>
        <el-empty description="暂无货架" />
      </template>
      <!--
        2026-08-27 T15：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
        用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
        fixed="right" 操作列保留为字面量 <el-table-column>。
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
      <el-table-column label="操作" min-width="160" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link size="small" @click="editShelf(row as Shelf)">编辑</el-button>
          <el-popconfirm
            v-if="row.is_active"
            title="确认停用？"
            @confirm="doDeactivate(String(row.id))"
          >
            <template #reference
              ><el-button link size="small" type="danger">停用</el-button></template
            >
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="showCreate"
      :title="editingShelf ? '编辑货架' : '新增货架'"
      :width="shelfDlg.width"
      :top="shelfDlg.top"
      :fullscreen="shelfDlg.fullscreen"
      @closed="resetForm"
    >
      <el-form ref="shelfFormRef" :model="shelfForm" :rules="shelfRules" label-width="80px">
        <el-form-item label="代码" prop="code"
          ><el-input v-model="shelfForm.code" :disabled="!!editingShelf" placeholder="如 PROD-A1"
        /></el-form-item>
        <el-form-item label="名称" prop="name"
          ><el-input v-model="shelfForm.name" placeholder="如 生产区-A1 货架"
        /></el-form-item>
        <el-form-item label="区域" prop="zone">
          <el-select v-model="shelfForm.zone" style="width: 100%">
            <el-option label="生产区" value="PRODUCTION" /><el-option
              label="品检区"
              value="INSPECTION"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="位置" prop="location"
          ><el-input v-model="shelfForm.location" placeholder="可选的自由文本"
        /></el-form-item>
        <el-form-item label="物理顺序" prop="display_order">
          <el-input-number
            v-model="shelfForm.display_order"
            :min="0"
            :step="1"
            controls-position="right"
            placeholder="0=未设置"
          />
          <span class="field-hint">用于共享 HMI 卡片网格 picker 的物理顺序；0=未设置</span>
        </el-form-item>
        <el-form-item label="工序">
          <el-select
            v-model="selectedProcessIds"
            multiple
            filterable
            placeholder="选择该货架可执行的工序（可多选）"
            style="width: 100%"
          >
            <el-option
              v-for="p in allProcesses"
              :key="p.id"
              :label="`${p.code} — ${p.name}`"
              :value="p.id"
            >
              <span style="font-weight: 600">{{ p.code }}</span>
              <span style="margin-left: 4px">{{ p.name }}</span>
              <el-tag
                :type="p.category === 'INHOUSE' ? 'primary' : 'warning'"
                size="small"
                style="margin-left: 6px"
                >{{ PROCESS_CATEGORY_LABEL[p.category] }}</el-tag
              >
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveShelf">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, h } from 'vue';
import { ElMessage, ElTag, ElForm, type FormInstance } from 'element-plus';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag';
import { useDialogSize } from '@/composables/useDialogSize';
import {
  listShelves,
  createShelf,
  updateShelf,
  deactivateShelf,
  getShelfProcesses,
  setShelfProcesses,
  toShelfProcessIds,
  toShelfProcessesPayload,
} from '@/api/shelves';
import { listProcesses } from '@/api/process';
import type { Shelf } from '@/types/shelf';
import type { Process } from '@/types/process';
import { PROCESS_CATEGORY_LABEL } from '@/types/process';

// ============ 列可见性 + 列顺序拖动 ============
// 「操作」列不放进 defs → 始终可见。
// 2026-08-27 T15：补 prop / width / minWidth / align + 复杂单元格走 cellRender。
const columnDefs: ColumnDef[] = [
  { key: 'code', label: '代码', prop: 'code', minWidth: 110, align: 'center' },
  { key: 'name', label: '名称', prop: 'name', minWidth: 140, align: 'center' },
  {
    key: 'zone',
    label: '区域',
    minWidth: 90,
    align: 'center',
    cellRender: ({ row }) =>
      h(
        ElTag,
        { type: (row as Shelf).zone === 'PRODUCTION' ? 'primary' : 'warning', size: 'small' },
        () => ((row as Shelf).zone === 'PRODUCTION' ? '生产' : '品检'),
      ),
  },
  { key: 'location', label: '位置', prop: 'location', minWidth: 120, align: 'center' },
  {
    key: 'display_order',
    label: '物理顺序',
    prop: 'display_order',
    minWidth: 100,
    align: 'center',
    sortable: true,
    cellRender: ({ row }) =>
      h(
        ElTag,
        {
          type: (row as Shelf).display_order > 0 ? 'info' : 'warning',
          size: 'small',
          effect: 'plain',
        },
        () => ((row as Shelf).display_order > 0 ? String((row as Shelf).display_order) : '未设置'),
      ),
  },
  // 2026-10-02 摘除「账号数」列：配套后端删除 ShelfOut.account_count
  //（用户已拍板舍弃该字段）。列 key 变更后 useColumnVisibility 的 lenient 恢复
  // 策略会把 localStorage 里残留的 account_count 项忽略掉，无需清缓存。
  {
    key: 'is_active',
    label: '状态',
    minWidth: 80,
    align: 'center',
    cellRender: ({ row }) =>
      h(ElTag, { type: (row as Shelf).is_active ? 'success' : 'danger', size: 'small' }, () =>
        (row as Shelf).is_active ? '启用' : '停用',
      ),
  },
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'shelf_list' });
const drag = useColumnDrag(columnDefs, { listKey: 'shelf_list' });

const items = ref<Shelf[]>([]);
const loading = ref(false);
const shelfDlg = useDialogSize({ desktopWidth: 400 });
// 2026-08-27 T15：列拖动 onMounted 挂 useDraggable 到表头 <tr>（列换序；绑 thead 会变成拖整行，2026-08-27 修正）
const tableRef = ref();

const showCreate = ref(false);
const saving = ref(false);
const allProcesses = ref<Process[]>([]);
const selectedProcessIds = ref<string[]>([]);
const editingShelf = ref<Shelf | null>(null);
// 2026-09-21 对齐 TS 严格：模板 ref 收紧为 EP FormInstance；null 初值避免 dialog 关闭态访问 .validate
const shelfFormRef = ref<FormInstance | null>(null);
const shelfForm = reactive({
  code: '',
  name: '',
  zone: 'PRODUCTION' as string,
  location: '',
  display_order: 0,
});
const shelfRules = {
  code: [{ required: true, message: '必填' }],
  name: [{ required: true, message: '必填' }],
  zone: [{ required: true, message: '必选' }],
};

async function fetchData() {
  loading.value = true;
  try {
    items.value = (await listShelves({ limit: 200 })).items;
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  shelfForm.code = '';
  shelfForm.name = '';
  shelfForm.zone = 'PRODUCTION';
  shelfForm.location = '';
  shelfForm.display_order = 0;
  selectedProcessIds.value = [];
  editingShelf.value = null;
}
async function editShelf(s: Shelf) {
  // 2026-09-21 收紧：原 `s: any` + `as Shelf` 双层断言合并为单一参数类型
  editingShelf.value = s;
  shelfForm.code = s.code;
  shelfForm.name = s.name;
  shelfForm.zone = s.zone;
  shelfForm.location = s.location ?? '';
  shelfForm.display_order = s.display_order ?? 0;
  showCreate.value = true;
  try {
    const sp = await getShelfProcesses(String(s.id));
    // 2026-10-02 修 BUG-2：后端返 `{items: [...]}`，旧代码读 `sp.processes`
    // 恒 undefined → `.map` 抛 TypeError → 被下面的裸 catch 吞掉 → 每次打开编辑
    // 弹窗已选工序必被清空，用户不察觉点保存就静默清空整组映射。
    // 形态还原（items + sort_order 升序）收口到 api/shelves::toShelfProcessIds，
    // 由 src/api/shelfProcesses.spec.ts 钉死，避免读形态再漂。
    selectedProcessIds.value = toShelfProcessIds(sp);
  } catch (e: unknown) {
    // 2026-10-02 不再吞异常：加载失败时**保持原状**（不覆盖 selectedProcessIds），
    // 而不是清空。清空 = 用户没察觉就点保存 = 静默清空整组映射，比报错危险得多；
    // 保持原状最坏也只是「这次没刷出来」，且用户能从提示知道需要重试。
    console.error('getShelfProcesses failed', e);
    ElMessage.warning('工序映射加载失败，请关闭后重试；本次未改动已选工序');
  }
}

async function saveShelf() {
  const valid = await shelfFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  saving.value = true;
  try {
    let shelfId: string;
    if (editingShelf.value) {
      await updateShelf(String(editingShelf.value.id), {
        name: shelfForm.name,
        location: shelfForm.location || undefined,
        display_order: shelfForm.display_order,
      });
      shelfId = String(editingShelf.value.id);
    } else {
      const created = await createShelf({
        code: shelfForm.code,
        name: shelfForm.name,
        zone: shelfForm.zone,
        location: shelfForm.location || undefined,
        display_order: shelfForm.display_order,
      });
      shelfId = String(created.id);
    }
    // 2026-10-02 修 BUG-1（用户报的 422）：后端 SetShelfProcessesRequest 的
    // `items` 必填且无 serde default，旧的 `{process_ids: [...]}` 直接 40001 →
    // HTTP 422（该功能自 v1 迁 v2 以来从未成功过一次）。
    // payload 构造收口到 api/shelves::toShelfProcessesPayload（sort_order = 数组
    // 下标，沿 v1「提交顺序即 sort_order」语义），并由 src/api/shelfProcesses.spec.ts
    // 逐字钉死形态，避免调用方再编出 v1 形态。
    await setShelfProcesses(shelfId, toShelfProcessesPayload(selectedProcessIds.value));
    showCreate.value = false;
    await fetchData();
    ElMessage.success('已保存');
  } catch (e: unknown) {
    // 2026-09-21 收紧：catch 由 any 改为 unknown，按 TS 严格模式要求做 Error 判别
    const msg = e instanceof Error ? e.message : String(e);
    ElMessage.error(msg || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function doDeactivate(id: string) {
  await deactivateShelf(id);
  await fetchData();
  ElMessage.success('已停用');
}

onMounted(async () => {
  await fetchData();
  try {
    const res = await listProcesses({ limit: 200 });
    allProcesses.value = res.items;
  } catch {
    /* ignore */
  }
  // 2026-08-28 改造：传 el-table 实例 ref 即可，composable 内部解析表头 <tr> +
  // MutationObserver 自愈（表头首次出现 / EP 重建都能覆盖）。
  drag.applyDrag(tableRef);
});
</script>

<style lang="scss" scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  h2 {
    margin: 0;
    font-size: 18px;
  }
}
.field-hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>
