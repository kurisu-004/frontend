// src/views/users/usersColumnDefs.ts
//
// 2026-10-10 新建：账号管理页的 ColumnDef 工厂（5 数据列 + 1 操作列）。单域专用文件，
// 与页面主组件（UserList.vue）同层放域根 —— `src/utils/` 只放跨域通用工具（判据是
// 「零个域内依赖 + 多域复用」，本文件的 cellRender 要 cast 到域内的 `UserOutData`、
// headerRender 要读 store 的表头筛选状态机，两者都是域内依赖）。
// 形态照 `src/views/outsource/outsourceCompanyColumnDefs.ts`（同样是「表头 popover 文本
// 筛选 + EP 原生 :filters 两态布尔」这一套）。
//
// 两个表头筛选（后端**早就支持**、旧页面从未用过，本页接上）：
//   - 用户名 → `username_like`（ILIKE 子串），走 `ColumnFilterPopover`（draft → confirm）；
//   - 状态   → `is_active`（三态），走 EP 原生 `:filters`（两态候选，`filteredValue` 由
//     search 派生、`@filter-change` 翻译回 search）。
// 两段式（draft → confirm）的原因沿零件一览 / 外协厂一览：popover 里输入的是草稿，只有点
// 「确定」才写进 search 并触发一次查询；直 v-model 会每敲一个字符发一次请求。
//
// ⚠️ **操作列不可隐藏**：它在 defs 里（为了用注入的 actions 渲染行内按钮），但
// `UserTable.vue` 传给 `ColumnVisibilityPopover` 的 defs 列表**过滤掉了 actions** ——
// `useColumnVisibility.update()` 会剪掉不在新 map 里的键，而 `isVisible()` 对未知键返回
// true ⇒ 操作列永远可见（与旧版把它写成字面量 `<el-table-column>` 的效果一致）。
// `draggable: false` 另有一层：它 fixed='right'，不该被拖到数据列中间去。

import { h } from 'vue';
import { ElButton, ElInput, ElPopconfirm, ElTag } from 'element-plus';
import ColumnFilterPopover from '@/components/ColumnFilterPopover.vue';
import type { ComputedRef, Ref } from 'vue';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { UserOutData } from './usersSchema';

/** 用户名表头筛选状态机（文本列，draft → confirm 两段式）。
 *  **由 store 构造**（refs 在 store 里，见 `composables/useUsersListStore.ts`），
 *  本文件只读它。 */
export interface UsersTextFilter {
  visible: Ref<boolean>;
  draft: Ref<string>;
  active: ComputedRef<boolean>;
  sync: () => void;
  confirm: () => void;
  reset: () => void;
}

/** 状态（启用 / 停用）原生多选列的过滤器。
 *
 *  search 里存的是 `boolean | undefined`（三态：undefined = 不过滤），EP 的 `:filters`
 *  只吃字符串数组 ⇒ 候选的 value 用 `'true'` / `'false'` 承载，翻译层负责与 search 互转。
 *  两个值都不选 = 不筛（不是「什么都不匹配」），这样用户点掉全部勾选就回到未筛选态。 */
export interface UsersActiveFilter {
  options: { text: string; value: string }[];
  filteredValue: ComputedRef<string[]>;
  active: ComputedRef<boolean>;
  count: ComputedRef<number>;
}

/** 操作列的行内动作（**由 store 注入**）。
 *
 *  为什么注入而不是在 defs 里直接调 store：列定义在 store 的 setup 期只建一次，闭包若
 *  捕获当时的函数引用会冻在首次构建的那版上。持一个可变对象、cellRender 每次渲染现读
 *  `actions.xxx`，依赖登记到渲染该单元格的 render effect ⇒ 动作换实现后会重渲染。 */
export interface UsersColumnActions {
  /** 打开企微绑定对话框。 */
  openWxBind: (row: UserOutData) => void;
  /** 打开角色管理对话框。 */
  openRoles: (row: UserOutData) => void;
  /** 打开新增 / 编辑对话框（编辑态由 store 判行内 id）。 */
  edit: (row: UserOutData) => void;
  /** 重置密码为默认口令。 */
  resetPassword: (row: UserOutData) => void;
  /** 停用账号（只对 `is_active` 为 true 的行给按钮）。 */
  deactivate: (row: UserOutData) => void;
}

export interface BuildUsersColumnDefsDeps {
  /** 用户名文本列状态机。 */
  usernameFilter: UsersTextFilter;
  /** 状态列的 EP 原生过滤器。 */
  activeFilter: UsersActiveFilter;
  /** 操作列的行内动作。 */
  actions: UsersColumnActions;
}

/** 后端 `last_login_at` 是 **naive** timestamp（无时区后缀，Asia/Shanghai 墙钟）。
 *  不能走 `utils/date.ts::formatDateTime` —— 那个函数 `new Date()` 后按 UTC 输出，会把
 *  墙钟时间整体平移（东八区的时间戳会被读成 UTC 再减 8 小时）。这里只做字符串切片。 */
function formatNaiveDateTime(raw: string | null): string {
  if (!raw) return '-';
  // '2026-10-10T08:30:00' → '2026-10-10 08:30'
  const normalized = raw.replace('T', ' ');
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized;
}

export function buildUsersColumnDefs(deps: BuildUsersColumnDefsDeps): ColumnDef[] {
  const { usernameFilter, activeFilter, actions } = deps;

  return [
    // 1. 用户名（表头 popover 文本筛选 + 纯文本单元格）
    {
      key: 'username',
      label: '用户名',
      columnKey: 'username',
      prop: 'username',
      minWidth: 140,
      align: 'center',
      headerRender: () =>
        h(
          ColumnFilterPopover,
          {
            label: '用户名',
            active: usernameFilter.active.value,
            visible: usernameFilter.visible.value,
            'onUpdate:visible': (v: boolean) => {
              usernameFilter.visible.value = v;
            },
            onShow: usernameFilter.sync,
            onConfirm: usernameFilter.confirm,
            onReset: usernameFilter.reset,
          },
          {
            default: () =>
              h(ElInput, {
                modelValue: usernameFilter.draft.value,
                'onUpdate:modelValue': (v: string) => {
                  usernameFilter.draft.value = v;
                },
                placeholder: '用户名（ILIKE 子串）',
                clearable: true,
                size: 'small',
                onKeyupEnter: usernameFilter.confirm,
              }),
          },
        ),
      cellRender: ({ row }) => h('span', null, (row as UserOutData).username),
    },

    // 2. 姓名
    {
      key: 'full_name',
      label: '姓名',
      columnKey: 'full_name',
      prop: 'full_name',
      minWidth: 110,
      align: 'center',
      cellRender: ({ row }) => h('span', null, (row as UserOutData).full_name || '—'),
    },

    // 3. 角色（一格多个 tag；带 scope 的 = 货架一体机账号，标 warning 色 + 货架编码）
    {
      key: 'roles',
      label: '角色',
      columnKey: 'roles',
      minWidth: 220,
      align: 'center',
      cellRender: ({ row }) => {
        const u = row as UserOutData;
        if (u.roles.length === 0) {
          return h('span', { class: 'muted' }, '无角色');
        }
        // cellRender 必须返回单一 VNode ⇒ 用 div 容器包住多个 tag（沿旧版写法）。
        return h(
          'div',
          { class: 'role-tags' },
          u.roles.map((r) =>
            h(
              ElTag,
              { key: r.id, size: 'small', type: r.scope_type ? 'warning' : 'primary' },
              () => `${r.role}${r.shelf_code ? ` @${r.shelf_code}` : ''}`,
            ),
          ),
        );
      },
    },

    // 4. 状态（EP 原生 :filters；已选条数挂在表头 label 上）
    {
      key: 'is_active',
      label: '状态',
      columnKey: 'is_active',
      minWidth: 100,
      align: 'center',
      filters: activeFilter.options,
      // 用 getter 而不是 `.value` 快照：columnDefs 只在 setup 里建一次，快照会把
      // filteredValue 冻在首次渲染的值上 ⇒ 工具栏「重置筛选」清不掉 EP 内部的勾选态。
      get filteredValue(): string[] {
        return activeFilter.filteredValue.value;
      },
      filterMultiple: true,
      headerRender: () =>
        h('span', { class: 'status-header' }, [
          '状态',
          activeFilter.count.value > 0
            ? h('span', { class: 'status-count' }, `(${activeFilter.count.value})`)
            : null,
        ]),
      cellRender: ({ row }) => {
        const u = row as UserOutData;
        return h(ElTag, { type: u.is_active ? 'success' : 'danger', size: 'small' }, () =>
          u.is_active ? '启用' : '停用',
        );
      },
    },

    // 5. 最后登录（naive timestamp 切片格式化，从未登录显示 '-'）
    {
      key: 'last_login_at',
      label: '最后登录',
      columnKey: 'last_login_at',
      prop: 'last_login_at',
      minWidth: 150,
      align: 'center',
      cellRender: ({ row }) => {
        const u = row as UserOutData;
        const text = formatNaiveDateTime(u.last_login_at);
        return h('span', { class: u.last_login_at ? '' : 'muted' }, text);
      },
    },

    // 6. 操作（企微 / 角色 / 编辑 / 重置密码 / 停用；fixed='right' + draggable: false）
    {
      key: 'actions',
      label: '操作',
      columnKey: 'actions',
      minWidth: 300,
      fixed: 'right',
      align: 'center',
      draggable: false,
      cellRender: ({ row }) => {
        const u = row as UserOutData;
        return h('div', { class: 'row-actions' }, [
          h(
            ElButton,
            { link: true, type: 'primary', size: 'small', onClick: () => actions.openWxBind(u) },
            () => '企微',
          ),
          h(
            ElButton,
            { link: true, type: 'success', size: 'small', onClick: () => actions.openRoles(u) },
            () => '角色',
          ),
          h(
            ElButton,
            { link: true, type: 'primary', size: 'small', onClick: () => actions.edit(u) },
            () => '编辑',
          ),
          h(
            ElPopconfirm,
            {
              title: '确认重置为默认密码 changeme？',
              width: 240,
              onConfirm: () => actions.resetPassword(u),
            },
            {
              reference: () =>
                h(ElButton, { link: true, type: 'warning', size: 'small' }, () => '重置密码'),
            },
          ),
          // 停用只对启用中的账号给（沿旧版行为）：已停用的行没有「再停一次」可点。
          u.is_active
            ? h(
                ElPopconfirm,
                { title: '确认停用？', onConfirm: () => actions.deactivate(u) },
                {
                  reference: () =>
                    h(ElButton, { link: true, type: 'danger', size: 'small' }, () => '停用'),
                },
              )
            : null,
        ]);
      },
    },
  ];
}
