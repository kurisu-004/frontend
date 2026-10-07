// src/views/outsource/outsourceQuoteColumnDefs.ts
//
// 2026-10-09 新建：外协报价一览页的 9 列 ColumnDef 工厂（8 数据列 + 1 客户列），
// 操作列仍是字面量 `<el-table-column>`（不放进 defs ⇒ 始终可见）。单域专用文件，与页面
// 主组件（OutsourceQuoteList.vue）同层放域根（判据见 `outsourceCompanyColumnDefs.ts`
// 文件头）。形态照 `src/views/parts/list/partsListColumnDefs.ts`：
// headerRender / cellRender 闭包持 raw 切片（ref 照写 .value）。
//
// 本轮两处实质变化：
//   1. 原先「状态」「客户」两列是手写 `el-popover`，本轮改共享
//      `ColumnFilterPopover`（与其它 8 列同款外壳与激活态视觉）。原先那两列因为是
//      literal `<el-table-column>` 被排除在列顺序拖动之外，本轮全部并进 defs ⇒ 它们
//      也能被拖动排位（`useColumnDrag` 从 orderedDefs 渲染全列）。
//   2. 「图号 / 名称 / 外协公司」三列新增表头筛选（后端 2026-10-09 把 `keyword` 拆成
//      `drawing_no` / `name` 两个直连 ILIKE 字段，并新增 `outsource_company_id` 维度）。
//
// ⚠️ `status` 列走 EP **原生** `:filters`：多选值以数组形态进 search，再由 api 层
// （`ARRAY_AS_CSV_KEYS` 含 `'statuses'`）序列成 CSV 单值发出 —— 后端 `serde_urlencoded`
// 的 `Part` 反序列化器不支持序列，重复 key / 括号键名都收不到值。

import { h } from 'vue';
import { ElInput, ElLink, ElOption, ElSelect, ElTag, ElTreeSelect } from 'element-plus';
import ColumnFilterPopover from '@/components/ColumnFilterPopover.vue';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import {
  OUTSOURCE_QUOTE_STATUS_LABEL,
  OUTSOURCE_QUOTE_STATUS_TAG,
  type OutsourceQuote,
  type OutsourceQuoteStatus,
} from '@/types/outsource';
import type { OutsourceQuoteSchema } from './composables/outsourceListSchema';
import type {
  OutsourceNativeMultiFilter,
  OutsourceTextFilter,
} from './composables/useOutsourceColumnFilters';

/** 图号点击 → 抽屉预览图纸（由视图注入，导航 / 弹窗不留在列定义里）。 */
export type PreviewDrawingFn = (row: OutsourceQuoteSchema) => void;

export interface BuildOutsourceQuoteColumnDefsDeps {
  drawingNoFilter: OutsourceTextFilter;
  nameFilter: OutsourceTextFilter;
  companyFilter: OutsourceTextFilter;
  customerFilter: OutsourceTextFilter;
  statusFilter: OutsourceNativeMultiFilter;
  /** 客户级联树（客户筛选 popover 的 data）。 */
  customerTree: { value: Array<{ id: string; name: string; children?: unknown[] }> };
  /** 外协公司 id/名候选（「外协公司」等值筛选列的 data；公司 id 走等值谓词不是 ILIKE）。 */
  companyOptions: { value: Array<{ id: string; name: string }> };
  onPreviewDrawing: PreviewDrawingFn;
}

export function buildOutsourceQuoteColumnDefs(
  deps: BuildOutsourceQuoteColumnDefsDeps,
): ColumnDef[] {
  const { drawingNoFilter, nameFilter, companyFilter, customerFilter, statusFilter } = deps;

  /** 文本筛选 popover 的表头（图号 / 名称 / 外协公司三列同款）。 */
  function textPopover(label: string, filter: OutsourceTextFilter, hint?: string) {
    return () =>
      h(
        ColumnFilterPopover,
        {
          label,
          active: filter.active.value,
          width: hint ? 300 : 280,
          hint,
          visible: filter.visible.value,
          'onUpdate:visible': (v: boolean) => {
            filter.visible.value = v;
          },
          onShow: filter.sync,
          onConfirm: filter.confirm,
          onReset: filter.reset,
        },
        {
          default: () =>
            h(ElInput, {
              modelValue: filter.draft.value,
              'onUpdate:modelValue': (v: string) => {
                filter.draft.value = v;
              },
              placeholder: `${label}（ILIKE 子串）`,
              clearable: true,
              size: 'small',
              onKeyupEnter: filter.confirm,
            }),
        },
      );
  }

  function statusLabel(s: string): string {
    return OUTSOURCE_QUOTE_STATUS_LABEL[s as OutsourceQuoteStatus] ?? s;
  }
  // legacy 值（USED 等）在 OUTSOURCE_QUOTE_STATUS_TAG 里映射成 '' —— EP 的 ElTag 不接受
  // 空 type（会落到默认样式而不是「无类型」），统一回退 'info'。
  function statusTagType(s: string): 'info' | 'success' | 'warning' | 'danger' {
    return OUTSOURCE_QUOTE_STATUS_TAG[s as OutsourceQuoteStatus] || 'info';
  }

  return [
    // 1. 序列号
    {
      key: 'part_serial_no',
      label: '序列号',
      columnKey: 'part_serial_no',
      prop: 'part_serial_no',
      minWidth: 100,
      sortable: 'custom',
      showOverflowTooltip: true,
      align: 'center',
      cellRender: ({ row }) =>
        h('span', null, (row as OutsourceQuoteSchema).part_serial_no || '—'),
    },

    // 2. 图号（表头筛选 + 点击预览图纸）
    {
      key: 'part_drawing_no',
      label: '图号',
      columnKey: 'part_drawing_no',
      prop: 'part_drawing_no',
      minWidth: 120,
      sortable: 'custom',
      showOverflowTooltip: true,
      align: 'center',
      headerRender: textPopover('图号', drawingNoFilter),
      cellRender: ({ row }) => {
        const r = row as OutsourceQuoteSchema;
        if (!r.part_drawing_no) return h('span', { class: 'muted' }, '—');
        return h(
          ElLink,
          {
            type: 'primary',
            underline: false,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              deps.onPreviewDrawing(r);
            },
          },
          () => r.part_drawing_no,
        );
      },
    },

    // 3. 名称（表头筛选）
    {
      key: 'part_name',
      label: '名称',
      columnKey: 'part_name',
      prop: 'part_name',
      minWidth: 180,
      sortable: 'custom',
      showOverflowTooltip: true,
      align: 'center',
      headerRender: textPopover('名称', nameFilter),
      cellRender: ({ row }) => h('span', null, (row as OutsourceQuoteSchema).part_name || '—'),
    },

    // 4. 外协公司（表头筛选 → `outsource_company_id` **等值**，不是 ILIKE）
    //    后端 `OutsourceQuoteListQuery.outsource_company_id` 是等值谓词、不是子串匹配，
    //    所以这一列的 popover 是 id 单选下拉（候选来自公司列表 query），与图号 / 名称
    //    两个 ILIKE 文本 popover 不同形态。状态机仍是 makeTextFilter 那套（draft →
    //    confirm），只是弹层内容换成下拉。
    {
      key: 'outsource_company_name',
      label: '外协公司',
      columnKey: 'outsource_company_name',
      prop: 'outsource_company_name',
      minWidth: 160,
      sortable: 'custom',
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '外协公司',
            active: companyFilter.active.value,
            width: 280,
            hint: '按公司等值筛选（候选来自外协公司一览）',
            visible: companyFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              companyFilter.visible.value = v;
            },
            onShow: companyFilter.sync,
            onConfirm: companyFilter.confirm,
            onReset: companyFilter.reset,
          },
          {
            default: () =>
              h(
                ElSelect,
                {
                  modelValue: companyFilter.draft.value,
                  filterable: true,
                  clearable: true,
                  placeholder: '选择外协公司',
                  size: 'small',
                  teleported: false,
                  style: 'width: 100%',
                  'onUpdate:modelValue': (v: unknown) => {
                    companyFilter.draft.value = v == null ? '' : String(v);
                  },
                },
                () =>
                  deps.companyOptions.value.map((c) =>
                    h(ElOption, { key: c.id, label: c.name, value: c.id }),
                  ),
              ),
          },
        ),
      cellRender: ({ row }) =>
        h('span', null, (row as OutsourceQuoteSchema).outsource_company_name || '—'),
    },

    // 5. 工序
    {
      key: 'process_code',
      label: '工序',
      columnKey: 'process_code',
      prop: 'process_code',
      minWidth: 100,
      sortable: 'custom',
      align: 'center',
      cellRender: ({ row }) => {
        const r = row as OutsourceQuoteSchema;
        if (!r.process_code && !r.process_name) return h('span', { class: 'muted' }, '—');
        return h('span', null, `${r.process_code ?? ''} ${r.process_name ?? ''}`.trim());
      },
    },

    // 6. 外协报价（sortable='custom' → sort_by=PRICE）
    {
      key: 'price',
      label: '外协报价(元)',
      columnKey: 'price',
      prop: 'price',
      minWidth: 110,
      align: 'right',
      sortable: 'custom',
      cellRender: ({ row }) => h('span', null, (row as OutsourceQuoteSchema).price),
    },

    // 7. 订单单价
    {
      key: 'part_unit_price',
      label: '订单单价(元)',
      columnKey: 'part_unit_price',
      prop: 'part_unit_price',
      minWidth: 110,
      align: 'right',
      sortable: 'custom',
      cellRender: ({ row }) => {
        const r = row as OutsourceQuoteSchema;
        return h('span', { class: { muted: !r.part_unit_price } }, r.part_unit_price ?? '—');
      },
    },

    // 8. 状态（EP 原生 :filters；多选 statuses 按 CSV 白名单发出）
    {
      key: 'status',
      label: '状态',
      columnKey: 'status',
      minWidth: 140,
      align: 'center',
      filters: statusFilter.options,
      // 同 outsourceCompanyColumnDefs.ts：getter 而非 `.value` 快照，否则 filteredValue
      // 被冻在首次渲染的值上，工具栏「重置筛选」清不掉 EP 内部的勾选态。
      get filteredValue(): string[] {
        return statusFilter.filteredValue.value;
      },
      headerRender: () =>
        h('span', { class: 'status-header' }, [
          '状态',
          statusFilter.count.value > 0
            ? h('span', { class: 'status-count' }, `(${statusFilter.count.value})`)
            : null,
        ]),
      cellRender: ({ row }) => {
        const r = row as OutsourceQuoteSchema;
        return h(
          ElTag,
          { type: statusTagType(r.status), effect: 'plain', size: 'small' },
          () => statusLabel(r.status),
        );
      },
    },

    // 9. 客户（ElTreeSelect 单选）
    {
      key: 'customer_path',
      label: '客户',
      columnKey: 'customer_path',
      minWidth: 180,
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '客户',
            active: customerFilter.active.value,
            width: 280,
            hint: '选一级客户自动级联其下二级客户（后端按客户子树展开）',
            visible: customerFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              customerFilter.visible.value = v;
            },
            onShow: customerFilter.sync,
            onConfirm: customerFilter.confirm,
            onReset: customerFilter.reset,
          },
          {
            default: () =>
              h(ElTreeSelect, {
                modelValue: customerFilter.draft.value,
                'onUpdate:modelValue': (v: unknown) => {
                  customerFilter.draft.value = v == null ? '' : String(v);
                },
                data: deps.customerTree.value,
                nodeKey: 'id',
                props: { label: 'name', children: 'children' },
                checkStrictly: true,
                clearable: true,
                filterable: true,
                placeholder: '选择客户',
                teleported: false,
                style: 'width: 100%',
                onClear: () => {
                  customerFilter.draft.value = '';
                },
              }),
          },
        ),
      cellRender: ({ row }) => {
        const r = row as OutsourceQuoteSchema;
        return r.customer_path
          ? h('span', null, r.customer_path)
          : h('span', { class: 'muted' }, '—');
      },
    },
  ];
}

/** 行内「报价一览」行的类型别名（store 的 items 元素类型）。 */
export type OutsourceQuoteRow = OutsourceQuote;