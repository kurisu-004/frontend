// src/views/cnc/pendingProgrammingColumnDefs.ts
//
// 2026-10-01 新增：从 PendingProgrammingList.vue 抽出「待编程一览」8 列 ColumnDef
// 工厂（照 src/utils/partsListColumnDefs.ts 的 factory 形态：deps 注入、返回
// ColumnDef[]），避免页面 store 文件膨胀。
//
// 为什么单独成文件：列定义含 5 个 cellRender 闭包（序列号 / 名称 / CNC 程序 /
// 客户 / 操作），而页面 store（usePendingProgrammingStore）已经同时持有
// useQuery + useMutation + 列可见性 + 列拖动 + 下发对话框 5 块职责。
//
// 行类型：2026-10-01 起是 prod 域 `GET /api/v2/prod/programming/pending` 的
// ProgrammingItem（schema z.infer 派生），**不再**是 part 域 PartListItem。
// 两者的关键差异：客户字段名不同 —— 本 schema 是 parent_customer_name(L1) /
// customer_name(L2)，part 域是 l1_customer_name / customer_name。渲染客户列
// 必须读 parent_customer_name，拿 PartListItem 的 cast 复用旧代码会渲染出「—」。

import { h, type VNode } from 'vue';
import { ElButton, ElTag } from 'element-plus';
import { RouterLink } from 'vue-router';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { PendingProgrammingItemSchema } from '@/composables/queries/schemas';

/** 行类型 = 待编程列表项（prod 域 ProgrammingItem）。 */
export type PendingProgrammingRow = PendingProgrammingItemSchema;

/** 工厂入参：全部由 store 内部函数注入（deps 形态 —— 闭包不直接持有 store，
 *  便于单测与复用；沿 partsListColumnDefs 的 deps 约定）。 */
export interface PendingProgrammingColumnDeps {
  /** 打开「下发到 CNC 货架」对话框（操作列「下发」按钮） */
  openReleaseDialog: (row: PendingProgrammingRow) => void;
  /** 跳零件详情页 /parts/{id}（操作列「详情」按钮） */
  navigateToPart: (id: string) => void;
  /** 该行是否正在下发中（操作列「下发」按钮 loading；
   *  2026-10-01 起用 mutation 的 releaseSubmitting + releaseTarget 派生，
   *  不再往 row 对象上挂 `_releasing` 私有字段） */
  isReleasing: (id: string) => boolean;
}

export function buildPendingProgrammingColumnDefs(
  deps: PendingProgrammingColumnDeps,
): ColumnDef[] {
  const { openReleaseDialog, navigateToPart, isReleasing } = deps;

  // ---------- 自定义单元格渲染 ----------
  // ColumnDef 接口里 row 是 unknown；cast 到 PendingProgrammingRow 以访问业务字段。

  function renderSerialNo({ row }: { row: unknown }): VNode {
    const r = row as PendingProgrammingRow;
    return h('span', { class: { muted: !r.serial_no } }, r.serial_no || '—');
  }

  function renderName({ row }: { row: unknown }): VNode {
    const r = row as PendingProgrammingRow;
    return h(RouterLink, { to: `/parts/${r.id}`, class: 'name-link' }, () => r.name);
  }

  // 2026-10-01 端点迁移：客户列改读 parent_customer_name(L1) + customer_name(L2)
  // （旧 part 域 PartListItem 是 l1_customer_name，字段名不同，不能沿用）。
  function renderCustomer({ row }: { row: unknown }): VNode {
    const r = row as PendingProgrammingRow;
    if (r.parent_customer_name) {
      return h('span', `${r.parent_customer_name} / ${r.customer_name ?? '—'}`);
    }
    if (r.customer_name) return h('span', { class: 'muted' }, r.customer_name);
    return h('span', { class: 'muted' }, '—');
  }

  // CNC 程序状态列（已编程绿色 / 未编程灰色）。has_cnc_program 由后端按
  // t_part_file EXISTS 派生；本页两个 Tab 用它做 has_cnc_program 三态筛选。
  function renderCncProgram({ row }: { row: unknown }): VNode {
    const r = row as PendingProgrammingRow;
    return h(
      ElTag,
      { type: r.has_cnc_program ? 'success' : 'info', size: 'small', effect: 'plain' },
      () => (r.has_cnc_program ? '已编程' : '未编程'),
    );
  }

  // 「下发」按钮仅对历史 PROGRAMMING 状态零件展示：PROGRAMMING 状态自 2026-09-29
  // 起标记为废弃（无新进入路径），但 release-from-programming 端点保留供历史数据
  // 消化；新流程下 chain 有 CNC 但 status ≠ PROGRAMMING 的零件无对应 API
  // （已编程后由工人在「生产队列」直接领取走下发路径）。
  function renderActions({ row }: { row: unknown }): VNode {
    const r = row as PendingProgrammingRow;
    const showRelease = r.status === 'PROGRAMMING';
    return h('div', null, [
      h(
        ElButton,
        {
          link: true,
          type: 'primary',
          size: 'small',
          onClick: () => navigateToPart(r.id),
        },
        () => '详情',
      ),
      showRelease
        ? h(
            ElButton,
            {
              link: true,
              type: 'success',
              size: 'small',
              loading: isReleasing(r.id),
              onClick: () => openReleaseDialog(r),
            },
            () => '下发',
          )
        : null,
    ]);
  }

  // ---------- 列定义 ----------
  // 字段顺序 = 初始渲染顺序（沿用 2026-09-29 版本，**顺序与 key 一行未改** ——
  // 列可见性 / 列顺序的 localStorage 快照 key 是 `pending_programming`，
  // 改 key 会让老用户已配好的列全部失效）。fixed / draggable=false 列不参与拖动。
  return [
    {
      key: 'serial_no',
      label: '序列号',
      columnKey: 'serial_no',
      prop: 'serial_no',
      minWidth: 110,
      fixed: 'left',
      showOverflowTooltip: true,
      align: 'center',
      cellRender: renderSerialNo,
    },
    {
      key: 'drawing_no',
      label: '图号',
      columnKey: 'drawing_no',
      prop: 'drawing_no',
      minWidth: 130,
      fixed: 'left',
      showOverflowTooltip: true,
      align: 'center',
    },
    {
      key: 'name',
      label: '名称',
      columnKey: 'name',
      prop: 'name',
      minWidth: 200,
      showOverflowTooltip: true,
      align: 'center',
      cellRender: renderName,
    },
    {
      key: 'quantity',
      label: '数量',
      columnKey: 'quantity',
      prop: 'quantity',
      minWidth: 80,
      align: 'right',
    },
    {
      key: 'planned_delivery_date',
      label: '计划交期',
      columnKey: 'planned_delivery_date',
      prop: 'planned_delivery_date',
      minWidth: 120,
      align: 'center',
    },
    {
      key: 'has_cnc_program',
      label: 'CNC 程序',
      columnKey: 'has_cnc_program',
      minWidth: 110,
      align: 'center',
      cellRender: renderCncProgram,
    },
    {
      key: 'customer',
      label: '客户',
      columnKey: 'customer',
      minWidth: 180,
      showOverflowTooltip: true,
      align: 'center',
      cellRender: renderCustomer,
    },
    {
      key: 'actions',
      label: '操作',
      columnKey: 'actions',
      minWidth: 160,
      fixed: 'right',
      align: 'center',
      draggable: false,
      cellRender: renderActions,
    },
  ];
}
