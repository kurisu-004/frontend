<!--
  PartPickerList.vue
  工序制定页左栏：搜索 + 双 section（待制定 / 已制定）。
  2026-09-11 新增。
  2026-09-12 重构：
    - 删除 <el-card #header>（标题信息降级为 section 上方小节文字）
    - 单表 → 双表（pendingParts / designedParts 拆开；2026-09-16 起按 process_chain_id 分组）
    - 序列号 + 名称两列；图号作 hover tooltip（CLAUDE.md #11 加 :disabled 守卫）
    - 树表 lazy load 复用 PartsTable.vue:291-295 / 297-332 模式（rowKey 前缀化 + matched_children 优先 / getAssembly fallback）
    - 子件 row 点击 → emit('select') → 父组件切换 selectedPartId（CLAUDE.md #11 row 空值守卫）
  2026-09-16：「待制定 / 已制定」分组改为 part.process_chain_id 驱动
  （null → 待制定 / 非 null → 已制定），替代原 step_count 懒加载派生。
  2026-09-29 改造：删除顶部「装配件」section 与装配件 lazy 展开（loadChildren）。后端 GET /parts
  已切到只查 t_part 表，入参不再含 row_type='ASSEMBLY'。所有行按 process_chain_id 进入待制定/已制定分组。
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

    <!-- 2026-09-29 删除：「装配件」section 与黄色 tag；后端 GET /parts 已不再返装配件 -->

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
import { usePartProcessDesign } from '../composables/usePartProcessDesign';
import { splitPartsByProcessDesign } from '../utils/partDesignGrouping';

defineProps<{
  selectedPartId: string | null;
}>();

const emit = defineEmits<(e: 'select', partId: string) => void>();

const { parts, loadingParts } = usePartProcessDesign();
const loading = loadingParts;

const searchKeyword = ref('');

/** 按 process_chain_id 拆成「待制定 / 已制定」两份。
 *  2026-09-12 新增：原 3 列表格（图号 / 名称 / 状态）改为双表分组展示；
 *  状态信息已通过「待制定 / 已制定」section 标题表达。
 *  2026-09-16 改造：分组依据从「本地懒加载缓存的 step_count > 0」改为
 *  part.process_chain_id（后端 /parts 出参新增字段；null → 待制定 / 非 null → 已制定）。
 *  旧逻辑的限制随之消除：未点击过的零件不会再被误判为「待制定」——
 *  是否制定过工序现在由后端链外键直接表达，与本地懒加载状态无关。
 *  2026-09-29 简化：删除「装配件不参与分组」分支（PartPickerList 已移除独立 section），
 *  所有行（纯 t_part）按 process_chain_id 直入待制定/已制定。
 *  拆分逻辑抽在 utils/partDesignGrouping.ts（纯函数，便于 node 环境 vitest 直测）。 */
const pendingParts = computed<PartListItem[]>(() => splitPartsByProcessDesign(parts.value).pending);
const designedParts = computed<PartListItem[]>(
  () => splitPartsByProcessDesign(parts.value).designed,
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

function onSelect(row: PartListItem): void {
  if (row && row.id) emit('select', row.id);
}

/** 2026-07-30：树表 row-key（避免顶层与子件 id 冲突）。
 *  复用 PartsTable.vue:291-295 模式。
 *  2026-09-29 简化：删除装配件懒加载后无需前缀化（无 id 冲突）。 */
function rowKey(row: PartListItem): string {
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
</style>
