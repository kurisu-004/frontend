<!--
  PartPickerList.vue
  工序制定页左栏：搜索 + 三 section（装配件 / 待制定 / 已制定）+ 树表 lazy load 子件展开。
  2026-09-11 新增。
  2026-09-12 重构：
    - 删除 <el-card #header>（标题信息降级为 section 上方小节文字）
    - 单表 → 双表（pendingParts / designedParts 通过 step_count 拆开）
    - 序列号 + 名称两列；图号作 hover tooltip（CLAUDE.md #11 加 :disabled 守卫）
    - 树表 lazy load 复用 PartsTable.vue:291-295 / 297-332 模式（rowKey 前缀化 + matched_children 优先 / getAssembly fallback）
    - 子件 row 点击 → emit('select') → 父组件切换 selectedPartId（CLAUDE.md #11 row 空值守卫）
  2026-09-12 第五轮：装配件（row_type='ASSEMBLY'）单独展示在顶部「装配件」section。
  装配件本身不能指定工序（点选时 ProcessStepCardList 显示提示），但仍可点击预览总装图。
  「待制定 / 已制定」section 只展示 row_type='PART' 的零件。
-->
<template>
  <el-card shadow="never" class="picker-card">
    <el-input
      v-model="searchKeyword"
      placeholder="按图号 / 名称搜索"
      clearable
      size="small"
      class="picker-search"
      :prefix-icon="Search"
    />

    <!-- 2026-09-12 第五轮：装配件（row_type='ASSEMBLY'）单独显示在一个 section 里。
         装配件本身不能指定工序（点击右栏会显示提示），但仍可点击预览其总装图。
         「待制定 / 已制定」两张表只展示 row_type='PART' 的零件。 -->
    <div v-if="filteredAssemblies.length > 0" class="picker-section picker-section--assemblies">
      <div class="section-title">
        <span>装配件</span>
        <el-tag size="small" type="warning" effect="plain">{{ filteredAssemblies.length }}</el-tag>
      </div>
      <el-table
        v-loading="loading"
        :data="filteredAssemblies"
        lazy
        :load="loadChildren"
        :tree-props="{ hasChildren: 'has_children', children: 'children' }"
        :row-key="rowKey"
        :current-row-key="selectedPartId ?? undefined"
        highlight-current-row
        size="small"
        stripe
        class="picker-table"
        @row-click="onSelect"
      >
        <el-table-column prop="serial_no" label="序列号" min-width="110" show-overflow-tooltip />
        <el-table-column label="名称" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tooltip
              :content="row?.drawing_no ?? ''"
              placement="top"
              :disabled="!row?.drawing_no"
            >
              <span class="picker-name">
                {{ row?.name ?? '—' }}
                <el-tag size="small" type="warning" effect="plain">装配件</el-tag>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="picker-section">
      <div class="section-title">
        <span>待制定</span>
        <el-tag size="small" effect="plain">{{ filteredPending.length }}</el-tag>
      </div>
      <el-table
        v-loading="loading"
        :data="filteredPending"
        lazy
        :load="loadChildren"
        :tree-props="{ hasChildren: 'has_children', children: 'children' }"
        :row-key="rowKey"
        :current-row-key="selectedPartId ?? undefined"
        highlight-current-row
        size="small"
        stripe
        class="picker-table"
        @row-click="onSelect"
      >
        <el-table-column prop="serial_no" label="序列号" min-width="110" show-overflow-tooltip />
        <el-table-column label="名称" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tooltip
              :content="row?.drawing_no ?? ''"
              placement="top"
              :disabled="!row?.drawing_no"
            >
              <span class="picker-name">
                {{ row?.name ?? '—' }}
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="picker-section">
      <div class="section-title">
        <span>已制定</span>
        <el-tag size="small" effect="plain">{{ filteredDesigned.length }}</el-tag>
      </div>
      <el-table
        v-loading="loading"
        :data="filteredDesigned"
        lazy
        :load="loadChildren"
        :tree-props="{ hasChildren: 'has_children', children: 'children' }"
        :row-key="rowKey"
        :current-row-key="selectedPartId ?? undefined"
        highlight-current-row
        size="small"
        stripe
        class="picker-table"
        @row-click="onSelect"
      >
        <el-table-column prop="serial_no" label="序列号" min-width="110" show-overflow-tooltip />
        <el-table-column label="名称" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tooltip
              :content="row?.drawing_no ?? ''"
              placement="top"
              :disabled="!row?.drawing_no"
            >
              <span class="picker-name">
                {{ row?.name ?? '—' }}
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Search } from '@element-plus/icons-vue';
import type { PartListItem } from '@/types/parts';
import { getAssembly } from '@/api/assembly';
import { usePartProcessDesign } from '../composables/usePartProcessDesign';

const props = defineProps<{
  selectedPartId: string | null;
}>();

const emit = defineEmits<(e: 'select', partId: string) => void>();

const { parts, loadingParts, allSummaries } = usePartProcessDesign();
const loading = loadingParts;

const searchKeyword = ref('');

/** 2026-09-12 第五轮：装配件单独展示在一个 section 里（顶部「装配件」表）。
 *  装配件本身不能指定工序，只能为其子零件制定工序。点选装配件时右栏显示提示，
 *  但仍可点击行预览总装图（通过 emit('select') 走同一选中通路）。 */
const assemblies = computed<PartListItem[]>(() =>
  parts.value.filter((p) => p.row_type === 'ASSEMBLY'),
);

/** 按 step_count 拆成「待制定 / 已制定」两份。
 *  2026-09-12 新增：原 3 列表格（图号 / 名称 / 状态）改为双表分组展示；
 *  状态信息已通过「待制定 / 已制定」section 标题表达。
 *  2026-09-12 第五轮：这两张表只展示 row_type='PART' 的零件（装配件在独立的「装配件」section 里）。 */
const pendingParts = computed<PartListItem[]>(() =>
  parts.value.filter(
    (p) => p.row_type !== 'ASSEMBLY' && (allSummaries.value[p.id]?.step_count ?? 0) === 0,
  ),
);
const designedParts = computed<PartListItem[]>(() =>
  parts.value.filter(
    (p) => p.row_type !== 'ASSEMBLY' && (allSummaries.value[p.id]?.step_count ?? 0) > 0,
  ),
);

function filterByKw(arr: PartListItem[]): PartListItem[] {
  const kw = searchKeyword.value.trim().toLowerCase();
  if (!kw) return arr;
  return arr.filter((p) => {
    if (!p) return false;
    return (
      (p.drawing_no ?? '').toLowerCase().includes(kw) || (p.name ?? '').toLowerCase().includes(kw)
    );
  });
}

const filteredPending = computed(() => filterByKw(pendingParts.value));
const filteredDesigned = computed(() => filterByKw(designedParts.value));
const filteredAssemblies = computed(() => filterByKw(assemblies.value));

function onSelect(row: PartListItem): void {
  if (row && row.id) emit('select', row.id);
}

/** 2026-07-30：树表 row-key（避免顶层与子件 id 冲突）。
 *  复用 PartsTable.vue:291-295 模式。 */
function rowKey(row: PartListItem): string {
  if (!row) return '';
  if (row.row_type === 'ASSEMBLY') return `ASM_${row.id}`;
  if ((row as { __is_child?: boolean }).__is_child) return `CHILD_${row.id}`;
  return `PART_${row.id}`;
}

/** 2026-09-12 新增：懒加载装配件子件（复用 PartsTable.vue:297-332 模式）。
 *  mock 阶段 fixture 没有 matched_children，fallback `getAssembly` 会 401；
 *  此时直接 resolve([])，UI 仍展示展开箭头（点开为空），不影响演示。 */
async function loadChildren(
  row: PartListItem,
  _treeNode: unknown,
  resolve: (children: PartListItem[]) => void,
): Promise<void> {
  if (!row || row.row_type !== 'ASSEMBLY') {
    resolve([]);
    return;
  }
  if (row.matched_children) {
    resolve(
      row.matched_children.map((c) => ({
        ...c,
        __is_child: true,
        row_type: 'PART' as const,
        has_children: false,
      })),
    );
    return;
  }
  try {
    const detail = await getAssembly(row.id);
    const children = (detail.children ?? []).map((child) => ({
      ...child,
      __is_child: true,
      row_type: 'PART' as const,
      has_children: false,
    })) as PartListItem[];
    resolve(children);
  } catch {
    resolve([]);
  }
}
</script>

<style lang="scss" scoped>
.picker-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    padding: 10px;
  }
}
.picker-search {
  flex-shrink: 0;
}
.picker-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 0;
}
// 2026-09-12 第五轮：装配件 section 不强制 flex 1（不需要抢占大量空间，列表通常很短）
.picker-section--assemblies {
  flex: 0 0 auto;
  max-height: 35%;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.picker-table {
  flex: 1;
  min-height: 0;
}
.picker-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
