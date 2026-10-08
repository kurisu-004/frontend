<!--
  DeliveryDraftCard.vue

  2026-08-25 T11 从 DeliveryNoteScan.vue 抽出：单张草稿卡片（el-card）+ body el-table + footer 4 按钮。

  设计要点：
  - 纯受控展示：所有数据 / loading 态由 props 传入；所有 user action 通过 emit 回给 shell。
  - el-table 实例 ref 在本组件内部声明（避免 T9 教训「template ref on readonly prop 静默失败」）。
    通过 emit('setTableRef', el) 把实例回传给 shell → useDeliveryDraftBoard.setTableRef。
  - props.rows 是 shell 调 board.foldedRows(noteId) 拿到的 PartTreeRow[] 引用；
    board 内部按 noteId 缓存 computed，确保同一份数据的引用稳定（el-table 的 :data
    换引用会整表重算）。

  2026-10-09：行形态改为零件 / 装配件树（序列号 / 图号 / 名称 / 数量 / 系统交期 + 勾选列），
  「打印标签」直接导出勾选行，不再打开预览对话框。

  props:
    draft             — 当前草稿 header（列表行 DeliveryNoteItemData）
    rows              — buildPartTreeRows 后的零件 / 装配件行（el-table 数据源）
    deleting          — 删除草稿 loading 态
    submitting        — 提交草稿 loading 态
    canPrint          — 「打印送货单」/「打印标签」两按钮可用（角色 + ≥1 行项）
    canSubmit         — 「提交草稿」按钮可用（status === 'DRAFT'）
    rowClassName      — 行 className 函数（绿底渲染已打印行）

  emits:
    goto-detail         — 点 header 跳转详情
    remove              — 移除某行（按行展开成批次 id）
    print-note          — 打开打印送货单预览
    print-labels        — 导出当前勾选行的标签
    delete-draft        — 删除草稿
    submit-draft        — 提交草稿
    update:selectedRows — 勾选变化（勾选集合归 shell，各卡互不干扰）
    set-table-ref       — el-table 实例注册 / 反注册
-->
<script setup lang="ts">
import { h, ref } from 'vue';
import type { ComponentInstance } from 'vue';
import { RouterLink } from 'vue-router';
import { Delete, Printer, Tickets } from '@element-plus/icons-vue';
import { ElTable, ElTag } from 'element-plus'; // 2026-09-21 T-B4：收紧 emits / ref / 函数参 any → ComponentInstance<typeof ElTable> | null
import type { PartTreeRow } from '../utils/deliveryNotePartRows';
import type { DeliveryNoteItemData } from '../composables/deliveryNoteSchema';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';

defineProps<{
  draft: DeliveryNoteItemData;
  rows: PartTreeRow[];
  deleting: boolean;
  submitting: boolean;
  canPrint: boolean;
  canSubmit: boolean;
  rowClassName: (info: { row: PartTreeRow }) => string;
}>();

const emit = defineEmits<{
  gotoDetail: [];
  remove: [row: PartTreeRow];
  printNote: [];
  printLabels: [];
  deleteDraft: [];
  submitDraft: [];
  /** 勾选变化：整份上抛（保留在 shell 的 selectedRowsByNote 里）。 */
  'update:selectedRows': [rows: PartTreeRow[]];
  setTableRef: [el: ComponentInstance<typeof ElTable> | null];
}>();

// el-table 实例本地声明；emit 上传给 shell（board.setTableRef 内部 Map 管理）。
// T9 教训：template ref 不能写到 readonly prop 上（Vue 静默失败）。
// 2026-09-21 T-B4：收紧 any → ComponentInstance<typeof ElTable> | null，与 T-B3 的
// DeliveryNoteScan.onCardTableRef / 模板 @setTableRef 签名保持一致。
const tableEl = ref<ComponentInstance<typeof ElTable> | null>(null);

function handleTableRef(el: ComponentInstance<typeof ElTable> | null): void {
  tableEl.value = el;
  emit('setTableRef', el);
}

/** 勾选变化 → 上抛给 shell（EP 的 selection 是组件内部状态，不试图反向单控）。 */
function handleSelectionChange(rows: PartTreeRow[]): void {
  emit('update:selectedRows', rows);
}

// 2026-08-27 Task 8：列顺序拖动 + 可见性。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
/** cellRender 的 row 形参是 unknown（ColumnDef 契约如此），按行类型取回。 */
function asPartRow(raw: unknown): PartTreeRow {
  return raw as PartTreeRow;
}

const columnDefs: ColumnDef[] = [
  {
    key: 'serial_no',
    label: '序列号',
    prop: 'serial_no',
    minWidth: 100,
    cellRender: ({ row }) => {
      const r = asPartRow(row);
      return h('span', { class: { muted: !r.serial_no } }, r.serial_no || '—');
    },
  },
  {
    key: 'drawing_no',
    label: '图号',
    prop: 'drawing_no',
    minWidth: 140,
    showOverflowTooltip: true,
  },
  {
    key: 'name',
    label: '名称',
    prop: 'name',
    minWidth: 110,
    showOverflowTooltip: true,
    // 装配件父行渲染「装配件」标签 + 跳装配件详情；零件行是纯文本。
    // h() 传字符串 type 不做组件解析（会渲染成字面 <router-link> 自定义元素、
    // 函数 children 被当 slots 丢掉 → 空白），必须传导入的 RouterLink 组件。
    cellRender: ({ row }) => {
      const r = asPartRow(row);
      if (!r.is_asm_row) return h('span', null, r.name);
      return h('div', null, [
        h(ElTag, { type: 'warning', size: 'small', class: 'asm-tag' }, () => '装配件'),
        h(RouterLink, { to: `/assemblies/${r.assembly_id}`, class: 'assembly-link' }, () => r.name),
      ]);
    },
  },
  {
    key: 'quantity',
    label: '数量',
    prop: 'quantity',
    width: 90,
    align: 'right',
    // 单位随数走：装配件「套」（null 时没有单位，否则渲染成「— 套」，会被读成
    // 「凑不齐整套、打不了」）；零件「件」（件数必填，没有缺失态）。
    cellRender: ({ row }) => {
      const r = asPartRow(row);
      return h('div', { class: 'qty' }, [
        h('span', null, r.quantity ?? '—'),
        r.quantity !== null ? h('span', { class: 'muted' }, r.unit) : null,
      ]);
    },
  },
  {
    key: 'system_delivery_date',
    label: '系统交期',
    width: 110,
    align: 'center',
    cellRender: ({ row }) => h('span', null, asPartRow(row).system_delivery_date || '—'),
  },
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'delivery_draft_card' });
const drag = useColumnDrag(columnDefs, { listKey: 'delivery_draft_card' });

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
drag.applyDrag(tableEl);
</script>

<template>
  <el-card shadow="hover" class="draft-card">
    <template #header>
      <div class="draft-card-head" @click="emit('gotoDetail')">
        <span class="draft-no draft-no-link">{{ draft.delivery_note_no }}</span>
        <!-- scope_label 随「同 L1 同时只允许一张 DRAFT」一起下线：后端不发，
             前端原来还在编常量「按一级客户」。 -->
        <el-tag size="small" type="info" effect="plain">草稿</el-tag>
      </div>
    </template>
    <div class="draft-card-body">
      <div class="draft-customer">{{ draft.customer_path || '—' }}</div>
      <!-- 2026-08-27 Task 8：列设置工具条 -->
      <div class="table-toolbar">
        <ColumnVisibilityPopover
          :defs="columnDefs"
          :model-value="columnVisibility.currentMap"
          @update:model-value="columnVisibility.update"
          @reset="columnVisibility.showAll"
          @resetOrder="drag.reset"
        />
      </div>
      <!--
        2026-10-09：`treeProps.checkStrictly: true` 是硬要求，不能删。
        EP 的该选项默认 false ⇒ 勾选在父子间级联：勾「装配件父行」（想出 1 张「N 套」
        标签）会把全部子件行一起勾上，同一批货出两轮标签；反向勾满全部子件也会把父行勾上。
        「一行 = 一张标签」只有不联动才成立。
      -->
      <el-table
        :ref="(el) => handleTableRef(el as ComponentInstance<typeof ElTable> | null)"
        :data="rows"
        :row-key="(row: PartTreeRow) => row.id"
        :row-class-name="rowClassName"
        :tree-props="{ children: 'children', checkStrictly: true }"
        default-expand-all
        height="240"
        size="small"
        empty-text="暂无加入零件 — 扫码加入"
        @selection-change="handleSelectionChange"
      >
        <!-- 勾选列不进 defs：列顺序拖动会把列拖到别处，勾选列必须恒在序列号之前。 -->
        <el-table-column type="selection" width="42" reserve-selection />
        <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
          <el-table-column
            v-if="columnVisibility.isVisible(d.key)"
            :prop="d.prop ?? d.key"
            :label="d.label"
            :width="d.width"
            :min-width="d.minWidth"
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
        <!-- 操作列（每行一个移除按钮）不进 defs -->
        <el-table-column label="" width="56" align="center">
          <template #default="{ row }">
            <el-button
              link
              size="small"
              type="danger"
              @click="emit('remove', row as PartTreeRow)"
            >
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <!-- 4 按钮等宽：删除草稿 / 打印送货单 / 打印标签 / 提交草稿 -->
      <div class="draft-card-footer">
        <el-button
          type="danger"
          plain
          class="footer-btn"
          :loading="deleting"
          @click="emit('deleteDraft')"
        >
          <el-icon><Delete /></el-icon>
          删除草稿
        </el-button>
        <el-button
          type="success"
          plain
          class="footer-btn"
          :disabled="!canPrint"
          @click="emit('printNote')"
        >
          <el-icon><Printer /></el-icon>
          打印送货单
        </el-button>
        <el-button
          type="success"
          plain
          class="footer-btn"
          :disabled="!canPrint"
          @click="emit('printLabels')"
        >
          <el-icon><Tickets /></el-icon>
          打印标签
        </el-button>
        <el-button
          type="primary"
          class="footer-btn"
          :disabled="!canSubmit"
          :loading="submitting"
          @click="emit('submitDraft')"
        >
          提交草稿
        </el-button>
      </div>
    </template>
  </el-card>
</template>

<style lang="scss" scoped>
.draft-card {
  flex: 0 0 calc(50% - 6px);
  box-sizing: border-box;
  min-width: 0;
}

.draft-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
}
.draft-no {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 700;
  font-size: 15px;
  color: var(--text-primary, #303133);
}
.draft-no-link {
  text-decoration: underline;
  text-decoration-color: transparent;
  transition: text-decoration-color 120ms ease;
}
.draft-card-head:hover .draft-no-link {
  text-decoration-color: var(--el-color-primary);
}
.draft-customer {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}
.draft-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 2026-08-27 Task 8：列设置工具条 */
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 4px;
}

/* footer：4 按钮等宽 */
.draft-card-footer {
  display: flex;
  gap: 8px;
}
.footer-btn {
  flex: 1;
}
:deep(.footer-btn .el-button__inner) {
  justify-content: center;
}

.muted {
  color: var(--el-text-color-secondary);
}
.qty {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  justify-content: flex-end;
}
.asm-tag {
  margin-right: 6px;
}
.assembly-link {
  color: var(--primary-color);
  text-decoration: none;
}
.assembly-link:hover {
  text-decoration: underline;
}
</style>
