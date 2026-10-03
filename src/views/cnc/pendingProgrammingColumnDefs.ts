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
import { ElButton, ElTag, ElTooltip } from 'element-plus';
import { RouterLink } from 'vue-router';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { PendingProgrammingItemSchema } from '@/composables/queries/schemas';

/** 行类型 = 待编程列表项（prod 域 ProgrammingItem）。 */
export type PendingProgrammingRow = PendingProgrammingItemSchema;

// ============================================================================
// 批次锚点的**改名义务**登记（2026-10-03 改写：此前登记的是「后端还没定字段名」，
// 现已定死，登记内容随之从「等后端改名」变成「换名时同批改哪三处」）。
// 字段名已由后端定死：`GET /api/v2/prod/programming/pending` 的
// `ProgrammingItemOut` 于 2026-10-03 补 `batch_id` / `batch_version`（雪花 ID 走
// JSON string；`batch_id` = 该 part 的 PROGRAMMING 活跃批次中 `id` 最大者，
// 无则 null）。本页的下发按钮可用性、store 的 release mutation 锚点都建在这两个
// 字段上，而后端 VO 未加 `skip_serializing_if` ⇒ 两 key 恒返。
// ⚠️ 若后端日后换名（如 `batch_ids` 复数 / 嵌套结构），本文件的用户可见文案
// （下面两个常量）会**同时失真**，而 Zod strip 模式不会报错、只会静默丢字段 ⇒
// 症状是「按钮恒 disabled 且 tooltip 说『没有编程中的批次』」。必须同批改三处：
//   1. 本文件的 `canReleaseRow` + 两个文案常量；
//   2. `src/composables/queries/schemas.ts::pendingProgrammingItemSchema`
//      的 `batch_id` / `batch_version` 声明（该侧也登记了本文件，双向登记）；
//   3. 扫码台 PICK_UP 领取的同名锚点（`ScanPickParts` →
//      `POST /prod/batches/{batch_id}/pick-up`，`version` 取 `batch_version`）——
//      那条路径**不过任何 Zod schema**（裸 `api.get<PartItem[]>`），连 strip 保护
//      都没有，后端换名时症状是扫码台弹「批次锚点缺失」而非本页按钮 disabled。
//      它的锚点注释登记在 `src/api/parts/crud.ts` 的 `PartItem.batch_id` /
//      `batch_version` 上。
// （2026-10-03：用 `//` 块而非 JSDoc —— 这段登记是模块级约定，不宿主于任何单个
//  导出物；写成 `/** */` 会在 IDE 里成为悬空的孤立注释，挂在谁身上都是假宿主。）
// ============================================================================

/** 2026-10-03：**行无批次锚点 → 「下发」按钮 disabled 时的 tooltip 文案。
 *  行缺 `batch_id` 的真实含义是「该 part 没有 `status='PROGRAMMING'` 的活跃批次」
 *  （后端 ProgrammingItemOut::batch_id 的取值口径），而 release-from-programming
 *  硬要求源状态是 PROGRAMMING ⇒ 没有这个批次就下发不了。常量住本文件是因为
 *  store 也要用（见下面的 RELEASE_MISSING_BATCH_ANCHOR_HINT），放 store 里会与本模块
 *  构成循环 import。 */
export const RELEASE_NO_BATCH_HINT = '该行没有处于「编程中」的批次，无法下发';

/** 2026-10-03：**store 的 release mutation 缺批次锚点时的报错文案（ElMessage.error）。
 *  与上面那句 tooltip 分开是因为两者说的不是同一件事：tooltip 说的是「这个行没有
 *  PROGRAMMING 批次」（后端 batch_id = null，**符合契约**的常态），而这里是「点下
 *  提交时锚点仍不完整」（batch_id 或 batch_version 缺失）——后者在当前后端契约下
 *  不可达（两字段同生共死），属于防线层，不能拿前者的话术顶替，否则用户在按钮
 *  可点的行上看到「没有编程中批次」会被误导去查批次状态。 */
export const RELEASE_MISSING_BATCH_ANCHOR_HINT =
  '该行的批次锚点不完整（缺批次 id 或批次版本），无法下发';

/** 该行能否下发：必须带批次 id。
 *  只看 `batch_id` 即可：后端保证 `batch_version` 与它**同生共死**
 *  （ProgrammingItemOut::batch_version 与 batch_id 同批下发），所以按钮的可用性
 *  判定不需要、也不应该再叠 batch_version —— 叠了会让「按钮可点」与「后端锚点完整」
 *  两件事的判定规则分叉。mutation 内另有防线（缺任一字段都拒绝发请求）。 */
export function canReleaseRow(row: PendingProgrammingRow): boolean {
  return Boolean(row.batch_id);
}

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

export function buildPendingProgrammingColumnDefs(deps: PendingProgrammingColumnDeps): ColumnDef[] {
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
    // 行缺批次锚点 ⇒ 端点拿不到锚点，此时 disabled + tooltip 把原因摆在点击前
    // （否则用户要填完整表单才发现这条路走不通）。ElTooltip 不能直接以 disabled
    // 元素作触发器（EP 官方 FAQ：disabled 表单元素不派发鼠标事件），故包一层 span。
    const releaseButton = h(
      ElButton,
      {
        link: true,
        type: 'success',
        size: 'small',
        loading: isReleasing(r.id),
        disabled: !canReleaseRow(r),
        onClick: () => openReleaseDialog(r),
      },
      () => '下发',
    );
    const releaseNode = canReleaseRow(r)
      ? releaseButton
      : h(ElTooltip, { content: RELEASE_NO_BATCH_HINT, placement: 'top' }, () =>
          h('span', null, [releaseButton]),
        );
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
      showRelease ? releaseNode : null,
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
