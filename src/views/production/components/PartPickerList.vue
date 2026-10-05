<!--
  PartPickerList.vue
  工序制定页左栏：搜索 + 双 section（待制定 / 已制定）。
  2026-09-11 新增。
  2026-09-12 重构：
    - 删除 <el-card #header>（标题信息降级为 section 上方小节文字）
    - 单表 → 双表（pendingParts / designedParts 拆开；2026-09-16 起按 process_chain_id 分组）
    - 序列号 + 名称两列；图号作 hover tooltip（CLAUDE.md #11 加 :disabled 守卫）
    - 子件 row 点击 → emit('select') → 父组件切换 selectedPartId（CLAUDE.md #11 row 空值守卫）
  2026-09-16：「待制定 / 已制定」分组改为 part.process_chain_id 驱动
  （null → 待制定 / 非 null → 已制定），替代原 step_count 懒加载派生。
  2026-09-29 改造：删除顶部「装配件」section 与装配件 lazy 展开（loadChildren）。
  所有行按 process_chain_id 进入待制定/已制定分组。
  2026-09-29 简化：序列号列改 width="80"（最长 F1234-99 ≈75px），名称列 min-width="140" 收紧。

  2026-10-05 改造：
    - 数据源切 useProcessDesignStore（store.query.parts / loading / total / sortDir），
      搜索仍是**本地过滤**（新端点不接收 keyword，见 api/processChain.ts 的入参注释）；
    - 序列号列加 sortable="custom" + @sort-change：排序是**服务端**行为（后端排序键
      固定 serial_no，无 sort_by），故不发 localSort，方向写进 store 的 sortDir 触发
      refetch；两张表各带一个表头箭头，点哪张表哪张显示方向（EP 的 default-sort 只在
      初始化时读一次，不做两表箭头同步）；
    - 用 assembly_id 标出装配件子件（序列号列前置「子」角标 + 名称列缩进）—— 新端点
      刻意不加 `AND assembly_id IS NULL`，子件与独立零件同表混排，不标的话用户分不清
      哪些件属于某个装配件；
    - 截断提示：后端一次只返 limit 条（total 是全量口径），超限时左栏明示
      「仅显示前 N / 共 M」，避免用户以为列表是全的。
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

    <!-- 2026-10-05：后端 total 是全量口径、本页一次只取 limit 条，超限时明示截断 -->
    <div v-if="truncated" class="picker-truncated">
      仅显示前 {{ parts.length }} / 共 {{ total }} 条，请用上方搜索缩小范围
    </div>

    <div class="picker-section">
      <div class="section-title">
        <span>待制定</span>
        <el-tag size="small" effect="plain">{{ filteredPending.length }}</el-tag>
      </div>
      <el-table
        v-loading="loading"
        :data="filteredPending"
        :row-key="rowKey"
        :current-row-key="selectedPartId ?? undefined"
        highlight-current-row
        size="small"
        stripe
        class="picker-table"
        @row-click="onSelect"
        @sort-change="onSortChange"
      >
        <el-table-column prop="serial_no" label="序列号" width="92" sortable="custom">
          <template #default="{ row }">
            <!-- assembly_id 非空 = 装配件的子件（与独立零件同表混排） -->
            <span v-if="row?.assembly_id" class="child-flag" title="装配件子件">子</span>
            <span :class="{ 'is-child': row?.assembly_id }">{{ row?.serial_no ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="名称" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tooltip
              :content="row?.drawing_no ?? ''"
              placement="top"
              :disabled="!row?.drawing_no"
            >
              <span :class="['picker-name', { 'is-child': row?.assembly_id }]">
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
        :row-key="rowKey"
        :current-row-key="selectedPartId ?? undefined"
        highlight-current-row
        size="small"
        stripe
        class="picker-table"
        @row-click="onSelect"
        @sort-change="onSortChange"
      >
        <el-table-column prop="serial_no" label="序列号" width="92" sortable="custom">
          <template #default="{ row }">
            <span v-if="row?.assembly_id" class="child-flag" title="装配件子件">子</span>
            <span :class="{ 'is-child': row?.assembly_id }">{{ row?.serial_no ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="名称" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tooltip
              :content="row?.drawing_no ?? ''"
              placement="top"
              :disabled="!row?.drawing_no"
            >
              <span :class="['picker-name', { 'is-child': row?.assembly_id }]">
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
import type { ProcessDesignPartSchema } from '@/composables/queries/schemas';
import { useProcessDesignStore } from '../composables/useProcessDesignStore';
import { splitPartsByProcessDesign } from '../utils/partDesignGrouping';

defineProps<{
  selectedPartId: string | null;
}>();

const emit = defineEmits<(e: 'select', partId: string) => void>();

// 不变量 #3：消费侧禁止解构 store，一律 store.query.xxx / store.editor.xxx。
const store = useProcessDesignStore();

const parts = computed<ProcessDesignPartSchema[]>(() => store.query.parts);
const loading = computed<boolean>(() => store.query.loading);
const total = computed<number>(() => store.query.total);

/** 后端 total 是全量口径（COUNT 与 limit/offset 无关），本页一次只取 limit 条。
 *  total > 已取行数即发生静默截断，必须让用户看见。 */
const truncated = computed<boolean>(() => total.value > parts.value.length);

const searchKeyword = ref('');

/** 按 process_chain_id 拆成「待制定 / 已制定」两份。
 *  2026-09-12 新增：原 3 列表格（图号 / 名称 / 状态）改为双表分组展示；
 *  状态信息已通过「待制定 / 已制定」section 标题表达。
 *  2026-09-16 改造：分组依据从「本地懒加载缓存的 step_count > 0」改为
 *  part.process_chain_id（后端 /parts 出参新增字段；null → 待制定 / 非 null → 已制定）。
 *  2026-09-29 简化：删除「装配件不参与分组」分支（PartPickerList 已移除独立 section），
 *  所有行（纯 t_part）按 process_chain_id 直入待制定/已制定。
 *  拆分逻辑抽在 utils/partDesignGrouping.ts（纯函数，便于 node 环境 vitest 直测）。 */
const pendingParts = computed<ProcessDesignPartSchema[]>(
  () => splitPartsByProcessDesign(parts.value).pending,
);
const designedParts = computed<ProcessDesignPartSchema[]>(
  () => splitPartsByProcessDesign(parts.value).designed,
);

/** 本地过滤（端点不接收 keyword，见 api/processChain.ts::ListProcessDesignPartsParams）。 */
function filterByKw(arr: ProcessDesignPartSchema[]): ProcessDesignPartSchema[] {
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

function onSelect(row: ProcessDesignPartSchema): void {
  if (row && row.id) emit('select', row.id);
}

/** 序列号列排序：**服务端**排序（sortable="custom" ⇒ 不做 localSort），
 *  方向写进 store 的 sortDir → queryKey 变化 → useQuery 自动 refetch。 */
function onSortChange({ order }: { order: 'ascending' | 'descending' | null }): void {
  store.query.onSortChange(order);
}

/** 2026-07-30：树表 row-key（避免顶层与子件 id 冲突）。
 *  复用 PartsTable.vue:291-295 模式。
 *  2026-09-29 简化：删除装配件懒加载后无需前缀化（无 id 冲突）。 */
function rowKey(row: ProcessDesignPartSchema): string {
  if (!row) return '';
  return `PART_${row.id}`;
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
// 2026-10-05：截断提示（一行小字）
.picker-truncated {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--el-color-warning);
  line-height: 1.4;
}
.picker-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 0;
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
// 2026-10-05：装配件子件标记 —— 序列号列前置「子」角标，名称列同步缩进
.child-flag {
  display: inline-block;
  margin-right: 4px;
  padding: 0 3px;
  border: 1px solid var(--el-color-info);
  border-radius: 3px;
  font-size: 10px;
  line-height: 14px;
  color: var(--el-color-info);
  vertical-align: 1px;
}
.is-child {
  padding-left: 8px;
  border-left: 2px solid var(--el-color-info-light-5);
}
</style>
