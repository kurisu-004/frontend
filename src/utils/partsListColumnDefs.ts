// 原 views/parts/list/composables/partsListColumnDefs.ts，2026-09-21 迁至 src/utils/
//
// 2026-09-15 从 PartsList.vue 抽出：18 列 ColumnDef 工厂（base 9 + price 2 仅 canEdit +
// tail 7）。cellRender / headerRender 闭包持 raw composable 切片（ref 照写 .value），
// 与消费侧 store.切片.字段 的解包访问落同一批 ref，无双写分裂。

import { h } from 'vue';
import {
  ElAutocomplete,
  ElCheckbox,
  ElDatePicker,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElSwitch,
  ElTag,
  ElTreeSelect,
} from 'element-plus';
import { RouterLink } from 'vue-router';
import { Search } from '@element-plus/icons-vue';
import ColumnFilterPopover from '@/components/ColumnFilterPopover.vue';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE } from '@/types/parts';
import type { PartListItem } from '@/types/parts';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { usePartsColumnFilters } from '@/views/parts/list/composables/usePartsColumnFilters';
import type { usePartInlineEdit } from '@/views/parts/list/composables/usePartInlineEdit';

export function buildPartsListColumnDefs(deps: {
  filters: ReturnType<typeof usePartsColumnFilters>;
  edit: ReturnType<typeof usePartInlineEdit>;
  canEdit: boolean;
}): ColumnDef[] {
  const { filters, edit, canEdit } = deps;

  const baseColumnDefs: ColumnDef[] = [
    // 1. 序列号（popover + 普通 cell；fixed='left' → 默认不可拖）
    {
      key: 'serial_no',
      label: '序列号',
      columnKey: 'serial_no',
      prop: 'serial_no',
      minWidth: 110,
      fixed: 'left',
      sortable: 'custom',
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '序列号',
            active: filters.serialNoFilter.active.value,
            visible: filters.serialNoFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.serialNoFilter.visible.value = v;
            },
            onShow: filters.serialNoFilter.sync,
            onConfirm: filters.serialNoFilter.confirm,
            onReset: filters.serialNoFilter.reset,
          },
          {
            default: () =>
              h(
                ElInput,
                {
                  modelValue: filters.serialNoFilter.draft.value,
                  'onUpdate:modelValue': (v: string) => {
                    filters.serialNoFilter.draft.value = v;
                  },
                  placeholder: '序列号（ILIKE 子串）',
                  clearable: true,
                  size: 'small',
                  class: filters.serialNoFlash.value ? 'scan-flash' : '',
                  onKeyupEnter: filters.serialNoFilter.confirm,
                },
                {
                  prefix: () => h(ElIcon, null, () => h(Search)),
                },
              ),
          },
        ),
      // 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        return h('span', { class: r.serial_no ? '' : 'muted' }, r.serial_no || '—');
      },
    },

    // 2. 订单号（popover + el-input 编辑）
    {
      key: 'order_no',
      label: '订单号',
      columnKey: 'order_no',
      prop: 'order_no',
      minWidth: 130,
      sortable: 'custom',
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '订单号',
            active: filters.orderNoFilter.active.value,
            width: 280,
            hint: '订单号子串搜索；勾选「仅空白」覆盖输入',
            visible: filters.orderNoFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.orderNoFilter.visible.value = v;
            },
            onShow: filters.orderNoFilter.sync,
            onConfirm: filters.orderNoFilter.confirm,
            onReset: filters.orderNoFilter.reset,
          },
          {
            default: () =>
              h('div', { class: 'filter-input-row' }, [
                h(
                  ElInput,
                  {
                    modelValue: filters.orderNoFilter.draft.value,
                    'onUpdate:modelValue': (v: string) => {
                      filters.orderNoFilter.draft.value = v;
                    },
                    placeholder: '订单号（ILIKE 子串）',
                    clearable: true,
                    size: 'small',
                    onKeyupEnter: filters.orderNoFilter.confirm,
                  },
                  {
                    prefix: () => h(ElIcon, null, () => h(Search)),
                  },
                ),
                h(
                  ElCheckbox,
                  {
                    modelValue: filters.orderNoFilter.isNullDraft.value === true,
                    'onUpdate:modelValue': (v: string | number | boolean) => {
                      filters.orderNoFilter.isNullDraft.value = v === true ? true : undefined;
                    },
                  },
                  () => '仅空白',
                ),
              ]),
          },
        ),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElInput, {
            modelValue: edit.editBuffer.order_no,
            'onUpdate:modelValue': (v: string) => {
              edit.editBuffer.order_no = v;
            },
            size: 'small',
          });
        }
        return h('span', null, r.order_no || '—');
      },
    },

    // 3. 图号（popover + el-input 编辑；fixed='left'）
    {
      key: 'drawing_no',
      label: '图号',
      columnKey: 'drawing_no',
      prop: 'drawing_no',
      minWidth: 130,
      fixed: 'left',
      sortable: 'custom',
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '图号',
            active: filters.drawingNoFilter.active.value,
            visible: filters.drawingNoFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.drawingNoFilter.visible.value = v;
            },
            onShow: filters.drawingNoFilter.sync,
            onConfirm: filters.drawingNoFilter.confirm,
            onReset: filters.drawingNoFilter.reset,
          },
          {
            default: () =>
              h(
                ElInput,
                {
                  modelValue: filters.drawingNoFilter.draft.value,
                  'onUpdate:modelValue': (v: string) => {
                    filters.drawingNoFilter.draft.value = v;
                  },
                  placeholder: '图号（ILIKE 子串）',
                  clearable: true,
                  size: 'small',
                  onKeyupEnter: filters.drawingNoFilter.confirm,
                },
                {
                  prefix: () => h(ElIcon, null, () => h(Search)),
                },
              ),
          },
        ),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElInput, {
            modelValue: edit.editBuffer.drawing_no,
            'onUpdate:modelValue': (v: string) => {
              edit.editBuffer.drawing_no = v;
            },
            size: 'small',
          });
        }
        return h('span', null, r.drawing_no);
      },
    },

    // 4. 名称（popover + el-input 编辑 / router-link / 装配件 tag）
    {
      key: 'name',
      label: '名称',
      columnKey: 'name',
      prop: 'name',
      minWidth: 200,
      sortable: 'custom',
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '名称',
            active: filters.nameFilter.active.value,
            visible: filters.nameFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.nameFilter.visible.value = v;
            },
            onShow: filters.nameFilter.sync,
            onConfirm: filters.nameFilter.confirm,
            onReset: filters.nameFilter.reset,
          },
          {
            default: () =>
              h(
                ElInput,
                {
                  modelValue: filters.nameFilter.draft.value,
                  'onUpdate:modelValue': (v: string) => {
                    filters.nameFilter.draft.value = v;
                  },
                  placeholder: '名称（ILIKE 子串）',
                  clearable: true,
                  size: 'small',
                  onKeyupEnter: filters.nameFilter.confirm,
                },
                {
                  prefix: () => h(ElIcon, null, () => h(Search)),
                },
              ),
          },
        ),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElInput, {
            modelValue: edit.editBuffer.name,
            'onUpdate:modelValue': (v: string) => {
              edit.editBuffer.name = v;
            },
            size: 'small',
          });
        }
        // 2026-08-27 fix（约束 #11）：EP 合成空行 { row: {} } 时 row.id 为 undefined；
        // router-link :to 会拼出 /parts/undefined → 触发 Vue Router warn。无 id 就不渲染链接。
        const isAssembly = r.row_type === 'ASSEMBLY';
        const linkPath = isAssembly ? `/assemblies/${r.id}` : `/parts/${r.id}`;
        const children: ReturnType<typeof h>[] = [];
        if (isAssembly) {
          children.push(
            h(
              ElTag,
              {
                type: 'warning',
                size: 'small',
                effect: 'plain',
                style: 'margin-right: 4px;',
              },
              () => '装配件',
            ),
          );
        }
        if (r.id) {
          children.push(
            h(
              RouterLink,
              {
                to: linkPath,
                class: 'name-link',
              },
              () => r.name,
            ),
          );
        } else {
          children.push(h('span', null, r.name));
        }
        // h() 不能返回数组 — 用 fragment 包一层
        return h('span', null, children);
      },
    },

    // 5. 客户（popover + el-tree-select）
    {
      key: 'customer',
      label: '客户',
      columnKey: 'customer',
      minWidth: 180,
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '客户',
            active: filters.customerFilter.active.value,
            width: 280,
            hint: '选一级客户自动级联其下二级客户',
            visible: filters.customerFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.customerFilter.visible.value = v;
            },
            onShow: filters.customerFilter.sync,
            onConfirm: filters.customerFilter.confirm,
            onReset: filters.customerFilter.reset,
          },
          {
            default: () =>
              h(ElTreeSelect, {
                modelValue: filters.customerFilter.draft.value,
                'onUpdate:modelValue': (v: string | number | null) => {
                  filters.customerFilter.draft.value = v != null ? String(v) : null;
                },
                data: filters.customerTree.value,
                nodeKey: 'id',
                props: { label: 'name', children: 'children' },
                checkStrictly: true,
                clearable: true,
                filterable: true,
                placeholder: '选择客户',
                teleported: false,
                style: 'width: 100%',
                onClear: () => {
                  filters.customerFilter.draft.value = null;
                },
              }),
          },
        ),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        // 2026-09-27 前后端字段对齐：后端不再返 customer_path，前端派生
        // 「一级 / 二级」展示路径 = l1_customer_name + customer_name。
        if (r.l1_customer_name) {
          return h('span', null, `${r.l1_customer_name} / ${r.customer_name ?? '—'}`);
        }
        if (r.customer_name) return h('span', { class: 'muted' }, r.customer_name);
        return h('span', { class: 'muted' }, '—');
      },
    },

    // 6. 申请人（el-autocomplete 编辑）
    {
      key: 'applicant',
      label: '申请人',
      columnKey: 'applicant',
      minWidth: 160,
      showOverflowTooltip: true,
      align: 'center',
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElAutocomplete, {
            modelValue: edit.editBuffer.applicant_name,
            'onUpdate:modelValue': (v: string | number) => {
              edit.editBuffer.applicant_name = String(v ?? '');
            },
            valueKey: 'name',
            fetchSuggestions: edit.applicantSuggest,
            triggerOnFocus: true,
            debounce: 0,
            loading: edit.applicantLoading.value,
            placeholder: '选择或输入申请人姓名',
            clearable: true,
            size: 'small',
            style: 'width: 100%',
          });
        }
        return h('span', null, r.applicant_name || '—');
      },
    },

    // 7. 状态（原生 :filters + 选中计数 badge；column-key=「status」）
    {
      key: 'status',
      label: '状态',
      columnKey: 'status',
      minWidth: 140,
      align: 'center',
      filters: filters.statusNativeOptions,
      filteredValue: filters.statusFilteredValue.value,
      headerRender: () =>
        h('span', { class: 'status-header' }, [
          '状态',
          filters.statusSelectedCount.value > 0
            ? h('span', { class: 'status-count' }, `(${filters.statusSelectedCount.value})`)
            : null,
        ]),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        // 2026-09-16 PR-2：has_been_repaired 随 t_part 瘦身下线，状态列不再渲染「返修」标。
        return h(
          'span',
          null,
          h(
            ElTag,
            {
              type: ORDER_STATUS_TAG_TYPE[r.status] ?? 'info',
              effect: 'plain',
              size: 'small',
            },
            () => ORDER_STATUS_LABEL[r.status] ?? r.status,
          ),
        );
      },
    },

    // 8. 数量（el-input-number 编辑）
    {
      key: 'quantity',
      label: '数量',
      columnKey: 'quantity',
      prop: 'quantity',
      minWidth: 110,
      sortable: 'custom',
      align: 'right',
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElInputNumber, {
            modelValue: edit.editBuffer.quantity,
            'onUpdate:modelValue': (v: number | undefined) => {
              edit.editBuffer.quantity = v ?? 1;
            },
            min: 1,
            precision: 0,
            controls: false,
            size: 'small',
            style: 'width: 90px',
          });
        }
        return h('span', null, r.quantity);
      },
    },

    // 9. 已送数量（装配件行恒为 '—'）
    {
      key: 'delivered_quantity',
      label: '已送数量',
      columnKey: 'delivered_quantity',
      prop: 'delivered_quantity',
      minWidth: 100,
      align: 'right',
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (r.row_type === 'ASSEMBLY') {
          return h('span', { class: 'muted' }, '—');
        }
        return h('span', null, r.delivered_quantity ?? 0);
      },
    },
  ];

  // 仅 canEdit 用户（MANAGER / CLERK）看到；INSPECTOR 整列隐藏 — 见 usePartInlineEdit
  // 与原 PartsTable `v-if="canEdit && columnVisibility.isVisible(...)"` 行为对齐。
  const priceColumnDefs: ColumnDef[] = [
    // 10. 单价（el-input-number 编辑；2026-09-27 改为 string 类型，后端返回
    //    rust_decimal::Decimal 序列化的 string，前端透传；编辑缓冲同步走 string，
    //    display 直接渲染 string，不走 Number()）。
    {
      key: 'unit_price',
      label: '单价',
      columnKey: 'unit_price',
      prop: 'unit_price',
      minWidth: 120,
      sortable: 'custom',
      align: 'right',
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (canEdit && edit.editingId.value === r.id) {
          return h(ElInput, {
            modelValue: edit.editBuffer.unit_price,
            'onUpdate:modelValue': (v: string) => {
              edit.editBuffer.unit_price = v ?? '';
            },
            placeholder: '单价',
            size: 'small',
            style: 'width: 100px',
          });
        }
        return h('span', null, r.unit_price);
      },
    },

    // 11. 总价（直接渲染后端 string；2026-09-27 与后端对齐后不再前端派生）
    {
      key: 'total_price',
      label: '总价',
      columnKey: 'total_price',
      prop: 'total_price',
      minWidth: 120,
      sortable: 'custom',
      align: 'right',
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        return h('span', null, r.total_price);
      },
    },
  ];

  const tailColumnDefs: ColumnDef[] = [
    // 12. 请购日期（popover + el-date-picker 编辑）
    {
      key: 'request_date',
      label: '请购日期',
      columnKey: 'request_date',
      prop: 'request_date',
      minWidth: 150,
      sortable: 'custom',
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '请购日期',
            active: filters.requestDateFilter.active.value,
            width: 280,
            visible: filters.requestDateFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.requestDateFilter.visible.value = v;
            },
            onConfirm: filters.requestDateFilter.confirm,
            onReset: filters.requestDateFilter.reset,
          },
          {
            default: () =>
              h(ElDatePicker, {
                modelValue: filters.requestDateFilter.range.value,
                'onUpdate:modelValue': (v: [string, string] | null) => {
                  filters.requestDateFilter.range.value = v;
                },
                type: 'daterange',
                valueFormat: 'YYYY-MM-DD',
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
        ),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElDatePicker, {
            modelValue: edit.editBuffer.request_date,
            'onUpdate:modelValue': (v: string) => {
              edit.editBuffer.request_date = v;
            },
            type: 'date',
            valueFormat: 'YYYY-MM-DD',
            size: 'small',
            style: 'width: 138px',
            clearable: false,
          });
        }
        return h('span', null, r.request_date);
      },
    },

    // 13. 计划交期（popover + el-date-picker 编辑）
    {
      key: 'planned_delivery_date',
      label: '计划交期',
      columnKey: 'planned_delivery_date',
      prop: 'planned_delivery_date',
      minWidth: 150,
      sortable: 'custom',
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '计划交期',
            active: filters.plannedDateFilter.active.value,
            width: 280,
            visible: filters.plannedDateFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.plannedDateFilter.visible.value = v;
            },
            onConfirm: filters.plannedDateFilter.confirm,
            onReset: filters.plannedDateFilter.reset,
          },
          {
            default: () =>
              h(ElDatePicker, {
                modelValue: filters.plannedDateFilter.range.value,
                'onUpdate:modelValue': (v: [string, string] | null) => {
                  filters.plannedDateFilter.range.value = v;
                },
                type: 'daterange',
                valueFormat: 'YYYY-MM-DD',
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
        ),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElDatePicker, {
            modelValue: edit.editBuffer.planned_delivery_date,
            'onUpdate:modelValue': (v: string) => {
              edit.editBuffer.planned_delivery_date = v;
            },
            type: 'date',
            valueFormat: 'YYYY-MM-DD',
            size: 'small',
            style: 'width: 138px',
            clearable: false,
          });
        }
        return h('span', null, r.planned_delivery_date);
      },
    },

    // 14. 系统交期（popover + 「仅空白」 + el-date-picker 编辑）
    {
      key: 'system_delivery_date',
      label: '系统交期',
      columnKey: 'system_delivery_date',
      prop: 'system_delivery_date',
      minWidth: 150,
      sortable: 'custom',
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '系统交期',
            active: filters.systemDateFilter.active.value,
            width: 300,
            hint: '区间 + 「仅空白」checkbox；勾选后区间失效',
            visible: filters.systemDateFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.systemDateFilter.visible.value = v;
            },
            onShow: filters.systemDateFilter.sync,
            onConfirm: filters.systemDateFilter.confirm,
            onReset: filters.systemDateFilter.reset,
          },
          {
            default: () =>
              h('div', { class: 'filter-input-row' }, [
                h(ElDatePicker, {
                  modelValue: filters.systemDateFilter.range.value,
                  'onUpdate:modelValue': (v: [string, string] | null) => {
                    filters.systemDateFilter.range.value = v;
                  },
                  type: 'daterange',
                  valueFormat: 'YYYY-MM-DD',
                  rangeSeparator: '~',
                  startPlaceholder: '起点',
                  endPlaceholder: '终点',
                  unlinkPanels: true,
                  clearable: true,
                  size: 'small',
                  teleported: false,
                  style: 'flex: 1',
                }),
                h(
                  ElCheckbox,
                  {
                    modelValue: filters.systemDateFilter.isNullDraft.value === true,
                    'onUpdate:modelValue': (v: string | number | boolean) => {
                      filters.systemDateFilter.isNullDraft.value = v === true ? true : undefined;
                    },
                  },
                  () => '仅空白',
                ),
              ]),
          },
        ),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElDatePicker, {
            modelValue: edit.editBuffer.system_delivery_date,
            'onUpdate:modelValue': (v: string | null) => {
              edit.editBuffer.system_delivery_date = v;
            },
            type: 'date',
            valueFormat: 'YYYY-MM-DD',
            size: 'small',
            style: 'width: 138px',
            clearable: true,
          });
        }
        return h('span', null, r.system_delivery_date || '—');
      },
    },

    // 15. 加急（el-switch 编辑 / el-tag / '—'）
    {
      key: 'is_urgent',
      label: '加急',
      columnKey: 'is_urgent',
      minWidth: 80,
      align: 'center',
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElSwitch, {
            modelValue: edit.editBuffer.is_urgent,
            'onUpdate:modelValue': (v: string | number | boolean) => {
              edit.editBuffer.is_urgent = v === true;
            },
            size: 'small',
          });
        }
        if (r.is_urgent) {
          return h(
            ElTag,
            {
              type: 'danger',
              effect: 'plain',
              size: 'small',
            },
            () => '加急',
          );
        }
        return h('span', { class: 'muted' }, '—');
      },
    },

    // 2026-09-27 前后端字段对齐：删除「下一道工序」整列 —— 后端 list 响应不再
    // 返 next_process_id / next_process_name，原生 :filters 也随之移除。
    // 列定义、headerRender / cellRender、`filters.nextProcessOptions.value` /
    // `filters.nextProcessFilteredValue.value` / `filters.nextProcessSelectedCount.value`
    // 全部下沉到 usePartsColumnFilters.ts 清理（nextProcessIds 在 search state
    // 中一并删除，list 端点 `next_process_ids` query 参数随之移除）。

    // 16. 所在位置（popover + el-tree-select 多选）
    {
      key: 'location',
      label: '所在位置',
      columnKey: 'location',
      minWidth: 150,
      showOverflowTooltip: true,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '所在位置',
            active: filters.locationFilter.active.value,
            width: 260,
            hint: '选大类命中该类全部；选叶子精确到货架/工人/外协公司',
            visible: filters.locationFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              filters.locationFilter.visible.value = v;
            },
            onShow: filters.locationFilter.onShow,
            onConfirm: filters.locationFilter.confirm,
            onReset: filters.locationFilter.reset,
          },
          {
            default: () =>
              h(ElTreeSelect, {
                modelValue: filters.locationFilter.draft.value,
                'onUpdate:modelValue': (v: unknown) => {
                  filters.locationFilter.draft.value = Array.isArray(v) ? v.map(String) : [];
                },
                data: filters.locationTree.value,
                nodeKey: 'id',
                props: { label: 'name', children: 'children' },
                multiple: true,
                showCheckbox: true,
                checkStrictly: true,
                checkOnClickNode: true,
                clearable: true,
                filterable: true,
                teleported: false,
                placeholder: '选择位置',
                style: 'width: 100%',
                onClear: () => {
                  filters.locationFilter.draft.value = [];
                },
              }),
          },
        ),
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        // 2026-09-16 PR-2：location 改为后端派生（min-progress 活跃批次），holder 名
        // 统一走新增 holder_name（货架 code / 工人姓名 / 外协公司名）；原 shelf_code /
        // worker_name / outsource_company_name 系 v1 遗留声明，v2 从未提供，已删除。
        if (r.location === 'PRODUCTION_SHELF' && r.holder_name) {
          return h('span', null, `货架 ${r.holder_name}`);
        }
        if (r.location === 'INSPECTION_SHELF' && r.holder_name) {
          return h('span', null, `品检 ${r.holder_name}`);
        }
        if (r.location === 'WORKER' && r.holder_name) {
          return h('span', null, r.holder_name);
        }
        if (r.location === 'OUTSOURCE_COMPANY' && r.holder_name) {
          return h('span', null, `外协 ${r.holder_name}`);
        }
        return h('span', { class: 'muted' }, '—');
      },
    },

    // 18. 备注（el-input 编辑）
    {
      key: 'note',
      label: '备注',
      columnKey: 'note',
      minWidth: 160,
      showOverflowTooltip: true,
      align: 'center',
      cellRender: ({ row }) => {
        const r = row as PartListItem;
        if (edit.editingId.value === r.id) {
          return h(ElInput, {
            modelValue: edit.editBuffer.note,
            'onUpdate:modelValue': (v: string) => {
              edit.editBuffer.note = v;
            },
            size: 'small',
          });
        }
        return h('span', null, r.note || '—');
      },
    },
  ];

  return [...baseColumnDefs, ...(canEdit ? priceColumnDefs : []), ...tailColumnDefs];
}
