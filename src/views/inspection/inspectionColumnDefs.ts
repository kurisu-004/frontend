// src/views/inspection/inspectionColumnDefs.ts
//
// 待品检一览页的 8 列 ColumnDef 工厂（7 数据列 + 1 操作列）。单域专用文件，与页面主
// 组件（InspectionPending.vue）同层放域根 —— `src/utils/` 只放跨域通用工具。
// 形态照 `src/views/parts/list/partsListColumnDefs.ts`（零件一览 18 列那份）：
// cellRender / headerRender 闭包持 raw composable 切片（ref 照写 .value），与消费侧
// `store.切片.字段` 的解包访问落同一批 ref，无双写分裂。
//
// 列集与后端 VO 的关系（2026-10-03 VO 收口）：
//   待品检端点 `GET /prod/batches/inspection` 换成了**恰 13 字段**的精简 VO
//   （`InspectionQueueItem`），本工厂只消费覆盖这 7 个数据列 + 写端点锚点的字段。
//   旧版的「计划交期」「品检货架」两列随之删除（前者 VO 已无 `planned_delivery_date`，
//   后者 VO 已无 `holder_name`）—— 用户需求明确只要 7 列。
//
// ⚠️ 第 4 列的 key 由 `batch_label` 改为 `batch_no`（旧版是「key 与数据字段脱节」的
// 历史遗留：列 key 叫 batch_label，渲染的却是 `batch_no` 字段）。改成 batch_no 之后，
//   - `inspection_pending_columns` / `inspection_pending_columnOrder` 两个 localStorage
//     旧快照里存的是 `batch_label` 这个 key；
//   - `useColumnVisibility` / `useColumnDrag` 两侧都是 lenient 策略：未知 key 视为可见、
//     恢复时只覆盖 defs 里存在的 key ⇒ 旧快照失配的后果仅限「批次列回到默认可见 +
//     排到其余列之后」，不会白屏、不会误隐藏别的列。故两个 composable 侧不需改动。
//   - 另：排序白名单键是 `BATCH_NO`（`INSPECTION_SORT_PROP_MAP`），列 prop 必须
//     对上 `batch_no` 才能让表头点击排序落到正确的后端 sort_by。

import { h } from 'vue';
import { ElButton, ElDatePicker, ElInput, ElTreeSelect } from 'element-plus';
import { RouterLink } from 'vue-router';
import ColumnFilterPopover from '@/components/ColumnFilterPopover.vue';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { InspectionQueueItem } from '@/api/parts';
import type { useInspectionColumnFilters } from './composables/useInspectionColumnFilters';

export interface InspectionColumnActions {
  /** 品检通过（弹「品检通过」对话框，带数量）。 */
  onPass: (row: InspectionQueueItem) => void;
  /** 指定工序（弹「下一道工序 + 目标生产货架」对话框）。 */
  onOpenFail: (row: InspectionQueueItem) => void;
  /** 详情（跳 `/parts/{part_id}`）。 */
  onDetail: (row: InspectionQueueItem) => void;
}

export interface BuildInspectionColumnDefsDeps {
  filters: ReturnType<typeof useInspectionColumnFilters>;
  actions: InspectionColumnActions;
  /** 正在提交品检通过的行 batch_id（操作列按钮 loading 态）。
   *  **函数形态而非 plain value**：columnDefs 在 store setup 里只建一次，闭包捕获
   *  plain value 会把 loading 态冻在首次渲染的值上。cellRender 每次渲染读一次 getter，
   *  依赖登记到渲染该单元格的 render effect ⇒ 提交中/完成都会重新渲染。 */
  passingBatchId: () => string | null;
}

export function buildInspectionColumnDefs(deps: BuildInspectionColumnDefsDeps): ColumnDef[] {
  const { filters, actions, passingBatchId } = deps;

  return [
    // 1. 序列号（表头筛选 + null 占位；fixed='left' ⇒ 不可拖）
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
              h(ElInput, {
                modelValue: filters.serialNoFilter.draft.value,
                'onUpdate:modelValue': (v: string) => {
                  filters.serialNoFilter.draft.value = v;
                },
                placeholder: '序列号（ILIKE 子串）',
                clearable: true,
                size: 'small',
                onKeyupEnter: filters.serialNoFilter.confirm,
              }),
          },
        ),
      // 2026-10-03：VO 的 serial_no 是 nullable（无序列号的工单）→ 空值渲染灰 '—'。
      cellRender: ({ row }) => {
        const r = row as InspectionQueueItem;
        return h('span', { class: r.serial_no ? '' : 'muted' }, r.serial_no || '—');
      },
    },

    // 2. 图号（表头筛选；prop 直出，fixed='left' ⇒ 不可拖）
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
              h(ElInput, {
                modelValue: filters.drawingNoFilter.draft.value,
                'onUpdate:modelValue': (v: string) => {
                  filters.drawingNoFilter.draft.value = v;
                },
                placeholder: '图号（ILIKE 子串）',
                clearable: true,
                size: 'small',
                onKeyupEnter: filters.drawingNoFilter.confirm,
              }),
          },
        ),
    },

    // 3. 名称（表头筛选 + RouterLink 进零件详情）
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
              h(ElInput, {
                modelValue: filters.nameFilter.draft.value,
                'onUpdate:modelValue': (v: string) => {
                  filters.nameFilter.draft.value = v;
                },
                placeholder: '名称（ILIKE 子串）',
                clearable: true,
                size: 'small',
                onKeyupEnter: filters.nameFilter.confirm,
              }),
          },
        ),
      // ⚠️ 跳 `/parts/{part_id}`：待品检 VO **没有 `id`**（那是 t_part.id 的另一个名字），
      // 锚点是 part_id。旧版误拼 `/parts/undefined` 的根因就在这里。
      cellRender: ({ row }) => {
        const r = row as InspectionQueueItem;
        return h(RouterLink, { to: `/parts/${r.part_id}`, class: 'name-link' }, () => r.name);
      },
    },

    // 4. 批次（等宽 chip；key 见文件头「batch_label → batch_no」注）
    {
      key: 'batch_no',
      label: '批次',
      columnKey: 'batch_no',
      prop: 'batch_no',
      minWidth: 100,
      sortable: 'custom',
      align: 'center',
      cellRender: ({ row }) => {
        const r = row as InspectionQueueItem;
        // batch_no 非 nullable（i32），Vue 渲染时自动 toString。
        return h('span', { class: 'batch-label' }, String(r.batch_no));
      },
    },

    // 5. 数量（label 由旧版「批次量」改为「数量」，与用户需求原文一致）
    {
      key: 'quantity',
      label: '数量',
      columnKey: 'quantity',
      prop: 'quantity',
      minWidth: 80,
      sortable: 'custom',
      align: 'right',
    },

    // 6. 系统交期（表头筛选 + nullable 占位）
    {
      key: 'system_delivery_date',
      label: '系统交期',
      columnKey: 'system_delivery_date',
      prop: 'system_delivery_date',
      minWidth: 120,
      sortable: 'custom',
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '系统交期',
            active: filters.systemDateFilter.active.value,
            width: 300,
            hint: '系统交期区间（含端点）',
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
                style: 'width: 100%',
              }),
          },
        ),
      // 2026-10-03：旧 VO 没有 system_delivery_date，这列恒显 '—'；新 VO 带该键
      // （DB NULL → JSON null），空值同样渲染灰 '—'。
      cellRender: ({ row }) => {
        const r = row as InspectionQueueItem;
        return h(
          'span',
          { class: r.system_delivery_date ? '' : 'muted' },
          r.system_delivery_date ?? '—',
        );
      },
    },

    // 7. 客户（表头筛选 + 「L1 / L2」派生展示）
    //    prop 刻意是 `customer`（不是数据字段 customer_name）—— 排序请求发的仍是
    //    `sort_by=CUSTOMER_NAME`（后端按 c.name 排），映射见 INSPECTION_SORT_PROP_MAP。
    {
      key: 'customer',
      label: '客户',
      columnKey: 'customer',
      prop: 'customer',
      minWidth: 180,
      sortable: 'custom',
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
                  // 雪花 ID 保持字符串：ElTreeSelect 回调可能给 number，String() 兜住，
                  // 但绝不 Number() 反向转换（19 位 ID 丢精度）。
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
        const r = row as InspectionQueueItem;
        const l1 = r.l1_customer_name;
        const name = r.customer_name;
        if (l1 && name) return h('span', `${l1} / ${name}`);
        if (name) return h('span', name);
        if (l1) return h('span', l1);
        return h('span', { class: 'muted' }, '—');
      },
    },

    // 8. 操作（品检通过 / 指定工序 / 详情；fixed='right' + draggable: false 防误拖）
    {
      key: 'actions',
      label: '操作',
      columnKey: 'actions',
      minWidth: 220,
      fixed: 'right',
      align: 'center',
      draggable: false,
      cellRender: ({ row }) => {
        const r = row as InspectionQueueItem;
        // 行内 loading 判据是「正在提交的 batch_id === 本行 batch_id」：只让被提交的那
        // 一行转圈，其余行照常可点（旧版往 row 对象上挂 `_passing`，Pinia 响应式下
        // 往 data 行挂字段会让整表重渲染，改为 ref 判据更干净）。
        const isPassing = passingBatchId() === r.batch_id;
        return h('div', { class: 'row-actions' }, [
          h(
            ElButton,
            {
              link: true,
              type: 'success',
              size: 'small',
              loading: isPassing,
              onClick: () => actions.onPass(r),
            },
            () => '品检通过',
          ),
          h(
            ElButton,
            { link: true, type: 'warning', size: 'small', onClick: () => actions.onOpenFail(r) },
            () => '指定工序',
          ),
          h(
            ElButton,
            { link: true, type: 'primary', size: 'small', onClick: () => actions.onDetail(r) },
            () => '详情',
          ),
        ]);
      },
    },
  ];
}
