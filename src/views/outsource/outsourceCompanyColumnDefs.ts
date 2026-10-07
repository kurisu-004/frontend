// src/views/outsource/outsourceCompanyColumnDefs.ts
//
// 2026-10-09 新建：外协公司一览页的 5 列 ColumnDef 工厂。单域专用文件，与页面主组件
// （OutsourceList.vue）同层放域根 —— `src/utils/` 只放跨域通用工具（判据是「零个域内
// 依赖 + 多域复用」，公司列的 cellRender 要 cast 到 `OutsourceCompanySchema` / 读表头
// 筛选状态机，两者都是域内依赖）。
// 形态照 `src/views/parts/list/partsListColumnDefs.ts`：headerRender / cellRender 闭包持
// raw composable 切片（ref 照写 .value），与消费侧 store.切片.字段 的解包访问落同一批
// ref，无双写分裂。
//
// 列集与后端 VO 的关系：`GET /outsource-companies` 的行是 `OutsourceCompanyOut`
// **7 字段**（无 `created_at` / `updated_at`）—— 本工厂只渲染 name / contact_name /
// contact_phone / address / is_active 五列，「#」与「操作」两列是字面量
// <el-table-column>（不放进 defs ⇒ 始终可见）。

import { h } from 'vue';
import { ElInput, ElTag } from 'element-plus';
import ColumnFilterPopover from '@/components/ColumnFilterPopover.vue';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { OutsourceCompanySchema } from './composables/outsourceListSchema';
import type { OutsourceTextFilter, OutsourceNativeBoolFilter } from './composables/useOutsourceColumnFilters';

export interface BuildOutsourceCompanyColumnDefsDeps {
  /** 公司名文本列状态机（表头 popover）。 */
  nameFilter: OutsourceTextFilter;
  /** 状态（启用 / 停用）原生多选列状态机。 */
  activeFilter: OutsourceNativeBoolFilter;
}

export function buildOutsourceCompanyColumnDefs(
  deps: BuildOutsourceCompanyColumnDefsDeps,
): ColumnDef[] {
  const { nameFilter, activeFilter } = deps;

  return [
    // 1. 公司名（表头 popover + 纯文本单元格）
    {
      key: 'name',
      label: '公司名',
      columnKey: 'name',
      prop: 'name',
      minWidth: 160,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '公司名',
            active: nameFilter.active.value,
            visible: nameFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              nameFilter.visible.value = v;
            },
            onShow: nameFilter.sync,
            onConfirm: nameFilter.confirm,
            onReset: nameFilter.reset,
          },
          {
            default: () =>
              h(ElInput, {
                modelValue: nameFilter.draft.value,
                'onUpdate:modelValue': (v: string) => {
                  nameFilter.draft.value = v;
                },
                placeholder: '公司名（ILIKE 子串）',
                clearable: true,
                size: 'small',
                onKeyupEnter: nameFilter.confirm,
              }),
          },
        ),
      cellRender: ({ row }) => h('span', null, (row as OutsourceCompanySchema).name),
    },

    // 2. 联系人
    {
      key: 'contact_name',
      label: '联系人',
      columnKey: 'contact_name',
      minWidth: 100,
      align: 'center',
      cellRender: ({ row }) =>
        h('span', null, (row as OutsourceCompanySchema).contact_name || '—'),
    },

    // 3. 联系电话
    {
      key: 'contact_phone',
      label: '联系电话',
      columnKey: 'contact_phone',
      minWidth: 120,
      align: 'center',
      cellRender: ({ row }) =>
        h('span', null, (row as OutsourceCompanySchema).contact_phone || '—'),
    },

    // 4. 地址
    {
      key: 'address',
      label: '地址',
      columnKey: 'address',
      prop: 'address',
      minWidth: 200,
      showOverflowTooltip: true,
      align: 'center',
      cellRender: ({ row }) => h('span', null, (row as OutsourceCompanySchema).address || '—'),
    },

    // 5. 状态（EP 原生 :filters；selectedCount 挂在表头 label 上）
    {
      key: 'is_active',
      label: '状态',
      columnKey: 'is_active',
      minWidth: 90,
      align: 'center',
      filters: activeFilter.options,
      // 用 getter 而不是 `.value` 快照：columnDefs 只在 setup 里建一次，快照会把
      // filteredValue 冻在首次渲染的值上 ⇒ 表头「外部重置」清不掉 EP 内部的勾选态。
      get filteredValue(): string[] {
        return activeFilter.filteredValue.value;
      },
      headerRender: () =>
        h('span', { class: 'status-header' }, [
          '状态',
          activeFilter.count.value > 0
            ? h('span', { class: 'status-count' }, `(${activeFilter.count.value})`)
            : null,
        ]),
      cellRender: ({ row }) => {
        const r = row as OutsourceCompanySchema;
        return h(
          ElTag,
          { type: r.is_active ? 'success' : 'info', size: 'small', effect: 'plain' },
          () => (r.is_active ? '启用' : '停用'),
        );
      },
    },
  ];
}