// src/views/outsource/outsourceSentPartColumnDefs.ts
//
// 2026-10-09 新建：外协对账页的 12 列 ColumnDef 工厂。单域专用文件，与页面主组件
// （OutsourceCompanySentParts.vue）同层放域根（判据见 `outsourceCompanyColumnDefs.ts`
// 文件头）。形态照 `src/views/parts/list/partsListColumnDefs.ts`：
// cellRender / headerRender 闭包持 raw 切片（ref 照写 .value）。
//
// 行内编辑（双击 → Enter 保存 / Esc 取消）的三个可编辑列（数量 / 单价 / 对账标记）
// 与合计行都读同一个 `editBuffer` —— 编辑缓冲的字段集与 `OutsourceSentPartItemSchema`
// 的 16 字段一致（`version` 是行编辑端点的 OCC 锚、`total_price` 由后端直出只在编辑态
// 被缓冲覆盖重算）。
//
// ⚠️ 「外协工序」列（`process_name`）原先零消费是**漏列不是 VO 冗余**：同一零件走过不同
// 外协工序时会开出多张 shipment 行，只看图号 / 名称无法分辨是哪道工序的账。

import { h } from 'vue';
import {
  ElDatePicker,
  ElInput,
  ElInputNumber,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTag,
  ElTreeSelect,
} from 'element-plus';
import ColumnFilterPopover from '@/components/ColumnFilterPopover.vue';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type {
  OutsourceDateRangeFilter,
  OutsourceNativeBoolFilter,
  OutsourceTextFilter,
} from './composables/useOutsourceColumnFilters';
import type { OutsourceSentPartItemSchema } from './composables/outsourceListSchema';

/** 行内编辑状态机（由页面持有，列定义只读）。 */
export interface OutsourceSentPartEditSlice {
  /** 正在编辑的行 `shipment_id`；null = 无编辑中行。 */
  editingId: { value: string | null };
  /** 提交中（禁用编辑控件）。 */
  saving: { value: boolean };
  /** 编辑缓冲：`unit_price` / `quantity` 可为 null（null = 该字段不更新）。 */
  buffer: {
    unit_price: number | null;
    quantity: number | null;
    is_billed: boolean;
  };
  /** 总价列的显示源（编辑态按缓冲重算，非编辑态读后端 `total_price`）。 */
  displayTotalPrice: (row: OutsourceSentPartItemSchema) => string;
}

/** 下拉候选（客户树 / 工序列表），由页面从共享 query 取出后注入。 */
export interface OutsourceSentPartOptions {
  /** 客户级联树（ElTreeSelect 的 data）。 */
  customerTree: { value: Array<{ id: string; name: string; children?: unknown[] }> };
  /** 全部 OUTSOURCE 工序的 `{id, code, name}`（外协工序筛选列 + 行内展示）。 */
  processes: { value: Array<{ id: string; code: string; name: string }> };
}

export interface BuildOutsourceSentPartColumnDefsDeps {
  drawingNoFilter: OutsourceTextFilter;
  nameFilter: OutsourceTextFilter;
  customerFilter: OutsourceTextFilter;
  processFilter: OutsourceTextFilter;
  sentDateFilter: OutsourceDateRangeFilter;
  receivedDateFilter: OutsourceDateRangeFilter;
  billedFilter: OutsourceNativeBoolFilter;
  edit: OutsourceSentPartEditSlice;
  options: OutsourceSentPartOptions;
}

function fmtDt(v: string | null | undefined): string {
  return v ? new Date(v).toLocaleString() : '—';
}

/** 状态列文案 / 徽标类型。`OutsourceSentPartSchema.status` 是两值枚举
 *  （`OUTSOURCING` / `RECEIVED`），第三个 DB CHECK 值 `CANCELLED` 无代码路径写入。 */
const STATUS_LABEL: Record<OutsourceSentPartItemSchema['status'], string> = {
  OUTSOURCING: '外协中',
  RECEIVED: '已回收',
};
const STATUS_TAG_TYPE: Record<OutsourceSentPartItemSchema['status'], 'warning' | 'primary'> = {
  OUTSOURCING: 'warning',
  RECEIVED: 'primary',
};

export function buildOutsourceSentPartColumnDefs(
  deps: BuildOutsourceSentPartColumnDefsDeps,
): ColumnDef[] {
  const {
    drawingNoFilter,
    nameFilter,
    customerFilter,
    processFilter,
    sentDateFilter,
    receivedDateFilter,
    billedFilter,
    edit,
    options,
  } = deps;

  /** 文本筛选 popover 的表头（三个 ILIKE 子串列同款）。 */
  function textPopover(label: string, filter: OutsourceTextFilter) {
    return () =>
      h(
        ColumnFilterPopover,
        {
          label,
          active: filter.active.value,
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

  /** 日期区间 popover 的表头（两个 datetime 闭区间列同款）。 */
  function datePopover(label: string, filter: OutsourceDateRangeFilter) {
    return () =>
      h(
        ColumnFilterPopover,
        {
          label,
          active: filter.active.value,
          width: 320,
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
            h(ElDatePicker, {
              modelValue: filter.range.value,
              'onUpdate:modelValue': (v: [string, string] | null) => {
                filter.range.value = v;
              },
              type: 'datetimerange',
              valueFormat: 'YYYY-MM-DDTHH:mm:ss',
              rangeSeparator: '~',
              startPlaceholder: '起点',
              endPlaceholder: '终点',
              unlinkPanels: true,
              clearable: true,
              size: 'small',
              teleported: false,
              style: 'width: 100%',
            }),
        },
      );
  }

  return [
    // 1. 图号
    {
      key: 'part_drawing_no',
      label: '图号',
      columnKey: 'part_drawing_no',
      prop: 'part_drawing_no',
      minWidth: 120,
      align: 'center',
      headerRender: textPopover('图号', drawingNoFilter),
      cellRender: ({ row }) =>
        h('span', null, (row as OutsourceSentPartItemSchema).part_drawing_no || '—'),
    },

    // 2. 名称
    {
      key: 'part_name',
      label: '名称',
      columnKey: 'part_name',
      prop: 'part_name',
      minWidth: 160,
      showOverflowTooltip: true,
      align: 'center',
      headerRender: textPopover('名称', nameFilter),
      cellRender: ({ row }) =>
        h('span', null, (row as OutsourceSentPartItemSchema).part_name || '—'),
    },

    // 3. 客户（ElTreeSelect 单选）
    {
      key: 'customer_path',
      label: '客户',
      columnKey: 'customer_path',
      minWidth: 160,
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '客户',
            active: customerFilter.active.value,
            width: 280,
            hint: '只判零件直属客户等值（与报价一览的「客户子树」语义不同）',
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
                data: options.customerTree.value,
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
      cellRender: ({ row }) =>
        h('span', null, (row as OutsourceSentPartItemSchema).customer_path ?? '—'),
    },

    // 4. 外协工序（`process_name` + `process_id` 筛选）
    {
      key: 'process_name',
      label: '外协工序',
      columnKey: 'process_name',
      prop: 'process_name',
      minWidth: 140,
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '外协工序',
            active: processFilter.active.value,
            width: 280,
            hint: '按 shipment 的工序等值筛选',
            visible: processFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              processFilter.visible.value = v;
            },
            onShow: processFilter.sync,
            onConfirm: processFilter.confirm,
            onReset: processFilter.reset,
          },
          {
            default: () =>
              h(ElSelectLike, {
                modelValue: processFilter.draft.value,
                options: options.processes.value.map((p) => ({
                  value: p.id,
                  label: `${p.code} — ${p.name}`,
                })),
                onPick: (v: string) => {
                  processFilter.draft.value = v;
                },
                onClear: () => {
                  processFilter.draft.value = '';
                },
              }),
          },
        ),
      cellRender: ({ row }) => {
        const r = row as OutsourceSentPartItemSchema;
        const p = options.processes.value.find((x) => x.id === r.process_id);
        // 回包带 process_name 时直接用；工序已被软删 / 不在共享列表里时按 code — name 兜底，
        // 再兜底到裸 id（宁可显示 id 也不要显示「—」：筛选条件正按这个 id 生效）。
        return h('span', null, r.process_name ?? (p ? `${p.code} — ${p.name}` : r.process_id));
      },
    },

    // 5. 批次号
    {
      key: 'batch_no',
      label: '批次号',
      columnKey: 'batch_no',
      minWidth: 90,
      align: 'center',
      cellRender: ({ row }) =>
        h('span', null, (row as OutsourceSentPartItemSchema).batch_no ?? '—'),
    },

    // 6. 数量（行内编辑）
    {
      key: 'quantity',
      label: '数量',
      columnKey: 'quantity',
      prop: 'quantity',
      minWidth: 90,
      align: 'right',
      cellRender: ({ row }) => {
        const r = row as OutsourceSentPartItemSchema;
        if (edit.editingId.value === r.shipment_id) {
          return h(ElInputNumber, {
            modelValue: edit.buffer.quantity,
            min: 1,
            max: 999999,
            controls: false,
            size: 'small',
            disabled: edit.saving.value,
            style: 'width: 80px',
            'onUpdate:modelValue': (v: number | null | undefined) => {
              edit.buffer.quantity = v ?? null;
            },
          });
        }
        return h('span', null, r.quantity);
      },
    },

    // 7. 单价（行内编辑；sortable='custom' → 后端 sort_by=PRICE）
    {
      key: 'unit_price',
      label: '单价(元)',
      columnKey: 'unit_price',
      prop: 'unit_price',
      minWidth: 110,
      align: 'right',
      sortable: 'custom',
      cellRender: ({ row }) => {
        const r = row as OutsourceSentPartItemSchema;
        if (edit.editingId.value === r.shipment_id) {
          return h(ElInputNumber, {
            modelValue: edit.buffer.unit_price,
            min: 0,
            precision: 2,
            step: 0.01,
            controls: false,
            size: 'small',
            disabled: edit.saving.value,
            placeholder: '待填',
            style: 'width: 100px',
            'onUpdate:modelValue': (v: number | null | undefined) => {
              edit.buffer.unit_price = v ?? null;
            },
          });
        }
        return h('span', null, r.unit_price);
      },
    },

    // 8. 总价（后端 `total_price` 是单一真源，仅编辑态被缓冲覆盖重算）
    {
      key: 'total_price',
      label: '总价',
      columnKey: 'total_price',
      prop: 'total_price',
      minWidth: 110,
      align: 'right',
      cellRender: ({ row }) =>
        h('span', null, edit.displayTotalPrice(row as OutsourceSentPartItemSchema)),
    },

    // 9. 发送时间（sortable='custom' → sort_by=SENT_AT）
    {
      key: 'sent_at',
      label: '发送时间',
      columnKey: 'sent_at',
      prop: 'sent_at',
      minWidth: 160,
      align: 'center',
      sortable: 'custom',
      headerRender: datePopover('发送时间', sentDateFilter),
      cellRender: ({ row }) => h('span', null, fmtDt((row as OutsourceSentPartItemSchema).sent_at)),
    },

    // 10. 回收时间（sortable='custom' → sort_by=RECEIVED_AT）
    {
      key: 'received_at',
      label: '回收时间',
      columnKey: 'received_at',
      prop: 'received_at',
      minWidth: 160,
      align: 'center',
      sortable: 'custom',
      headerRender: datePopover('回收时间', receivedDateFilter),
      cellRender: ({ row }) => {
        const r = row as OutsourceSentPartItemSchema;
        if (r.received_at) return h('span', null, fmtDt(r.received_at));
        return h('span', { style: 'color: var(--el-color-warning);' }, '未回收');
      },
    },

    // 11. 状态
    {
      key: 'status',
      label: '状态',
      columnKey: 'status',
      minWidth: 90,
      align: 'center',
      cellRender: ({ row }) => {
        const r = row as OutsourceSentPartItemSchema;
        return h(
          ElTag,
          { type: STATUS_TAG_TYPE[r.status], size: 'small', effect: 'plain' },
          () => STATUS_LABEL[r.status],
        );
      },
    },

    // 12. 对账（行内编辑 + EP 原生 :filters）
    {
      key: 'is_billed',
      label: '对账',
      columnKey: 'is_billed',
      minWidth: 90,
      align: 'center',
      filters: billedFilter.options,
      // 同 outsourceCompanyColumnDefs.ts：getter 而非 `.value` 快照，否则 filteredValue
      // 被冻在首次渲染的值上，工具栏「重置筛选」清不掉 EP 内部的勾选态。
      get filteredValue(): string[] {
        return billedFilter.filteredValue.value;
      },
      cellRender: ({ row }) => {
        const r = row as OutsourceSentPartItemSchema;
        if (edit.editingId.value === r.shipment_id) {
          return h(ElSwitch, {
            modelValue: edit.buffer.is_billed,
            size: 'small',
            disabled: edit.saving.value,
            // ElSwitch 的 update:modelValue 类型是 string|number|boolean（EP 统一事件签名），
            // 这里只接 boolean → 用 unknown 二次 cast 满足 TS2769。
            'onUpdate:modelValue': (v: unknown) => {
              edit.buffer.is_billed = v === true;
            },
          });
        }
        return h(
          ElTag,
          { type: r.is_billed ? 'success' : 'info', size: 'small', effect: 'plain' },
          () => (r.is_billed ? '已对' : '未对'),
        );
      },
    },
  ];
}

// ====================================================================
// popover 内的工序单选下拉
//
// 用 EP 的 `ElSelect` 而不是自己写原生 <select>：工序名可能很长，ElSelect 带 filterable
// 的可搜索下拉是这里唯一可用的形态（勾选框的候选全集也是同一份列表，见页面的
// `outsourceProcesses`）。这里用一个小工厂把「options + onPick + onClear」封成
// `h()` 一行可写的形状，避免 headerRender 里堆 20 行 prop。
// ====================================================================

function ElSelectLike(props: {
  modelValue: string;
  options: Array<{ value: string; label: string }>;
  onPick: (v: string) => void;
  onClear: () => void;
}) {
  return h(
    ElSelect,
    {
      modelValue: props.modelValue,
      filterable: true,
      clearable: true,
      placeholder: '选择外协工序',
      size: 'small',
      teleported: false,
      style: 'width: 100%',
      'onUpdate:modelValue': (v: unknown) => {
        if (v == null || v === '') props.onClear();
        else props.onPick(String(v));
      },
    },
    () =>
      props.options.map((o) =>
        h(ElOption, { key: o.value, label: o.label, value: o.value }),
      ),
  );
}