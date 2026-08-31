<template>
  <div class="user-page">
    <div class="page-header">
      <h2>账号管理</h2>
      <el-button type="primary" @click="showCreate = true">新增账号</el-button>
    </div>
    <!-- 2026-08-25：删除 ResponsiveList 包装（手机卡片视图随 T1 撤掉），改用纯 el-table。
         ColumnVisibilityPopover 按 T2 模板提到 .table-toolbar 顶层 div。
         2026-08-25 (T7)：el-pagination 收口到 <PagedTable>，fetcher 内部读 pageSize.value / page.value -->
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap" @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>
    <PagedTable ref="pagedRef" :fetcher="fetcher" :default-page-size="20">
      <template #default="{ items, loading }">
        <el-table
          ref="tableRef"
          :data="items"
          v-loading="loading"
          row-key="id"
          stripe
        >
          <template #empty>
            <el-empty description="暂无账号" />
          </template>
          <!--
            2026-08-27 T15：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
            用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
            fixed="right" 操作列保留为字面量 <el-table-column>。
          -->
          <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
            <el-table-column
              v-if="columnVisibility.isVisible(d.key)"
              :prop="d.prop ?? d.key"
              :label="d.label"
              :width="d.width"
              :min-width="d.minWidth"
              :sortable="d.sortable"
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
          <el-table-column label="操作" min-width="280" fixed="right" align="center">
            <template #default="{ row }">
              <el-button link size="small" @click="openRoles(row)">角色</el-button>
              <el-button link size="small" @click="editUser(row)">编辑</el-button>
              <el-popconfirm title="确认重置为默认密码 changeme？" width="240" @confirm="doReset(String(row.id))">
                <template #reference><el-button link size="small" type="warning">重置密码</el-button></template>
              </el-popconfirm>
              <el-popconfirm v-if="row.is_active" title="确认停用？" @confirm="doDeactivate(String(row.id))">
                <template #reference><el-button link size="small" type="danger">停用</el-button></template>
              </el-popconfirm>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </PagedTable>

    <!-- create / edit dialog -->
    <el-dialog
      v-model="showCreate"
      :title="editingUser ? '编辑账号' : '新增账号'"
      :width="userDlg.width"
      :top="userDlg.top"
      @closed="resetForm"
    >
      <el-form ref="userFormRef" :model="userForm" :rules="userRules" label-width="80px">
        <el-form-item label="用户名" prop="username"><el-input v-model="userForm.username" :disabled="!!editingUser" /></el-form-item>
        <el-form-item label="姓名" prop="full_name"><el-input v-model="userForm.full_name" /></el-form-item>
        <el-form-item label="密码" prop="password"><el-input v-model="userForm.password" type="password" show-password placeholder="留空不改" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" @click="saveUser" :loading="saving">保存</el-button>
      </template>
    </el-dialog>

    <!-- role dialog -->
    <el-dialog
      v-model="showRoles"
      title="角色管理"
      :width="rolesDlg.width"
      :top="rolesDlg.top"
    >
      <p style="margin-bottom:8px">当前角色（{{ roleUser?.username }}）：</p>
      <div v-for="r in roleList" :key="r.id" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <el-tag size="small">{{ r.role }}{{ r.shelf_code ? ` @${r.shelf_code}` : '' }}</el-tag>
        <el-button link size="small" type="danger" @click="removeRole(String(roleUser?.id ?? ''), String(r.id))">移除</el-button>
      </div>
      <el-divider />
      <el-form inline>
        <el-form-item label="加角色">
          <el-select v-model="addRoleForm.role" placeholder="选角色" style="width:160px" clearable>
            <el-option
              v-for="o in ROLE_OPTIONS"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="addRoleForm.role === 'SHELF_ACCOUNT'" label="货架（可多选）">
          <el-select
            v-model="addRoleForm.shelfIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="3"
            placeholder="选 1+ 个货架；留空 = 共享 HMI 通行"
            style="width:340px"
            clearable
          >
            <el-option
              v-for="s in shelfOptions"
              :key="s.id"
              :disabled="boundShelfIds.has(String(s.id))"
              :label="`${s.code} (${s.zone === 'PRODUCTION' ? '生产' : '品检'})`"
              :value="String(s.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item><el-button @click="doAddRole" :disabled="!addRoleForm.role">添加</el-button></el-form-item>
      </el-form>
      <p v-if="addRoleForm.role === 'SHELF_ACCOUNT' && addRoleForm.shelfIds.length === 0" class="scope-hint">
        <el-icon><InfoFilled /></el-icon>
        <span>货架留空 = 共享工控机（HMI）通行：该账号意图覆盖车间所有 PRODUCTION 架，不绑死单架。</span>
      </p>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, h } from 'vue'
import { ElMessage, ElMessageBox, ElTag } from 'element-plus'
import { listUsers, createUser, updateUser, deactivateUser, resetUserPassword, listUserRoles, addUserRole, removeUserRole } from '@/api/users'
import { listShelves } from '@/api/shelves'
import type { UserOut, UserRoleOut } from '@/types/user'
import type { Shelf } from '@/types/shelf'
import { InfoFilled } from '@element-plus/icons-vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import PagedTable from '@/components/PagedTable.vue'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { useDialogSize } from '@/composables/useDialogSize'
import { useListStatePersist } from '@/composables/useListFilterPersist'

const userDlg = useDialogSize({ desktopWidth: 420 })
const rolesDlg = useDialogSize({ desktopWidth: 560 })

// PagedTable 持有 page/pageSize/total/loading/items（2026-08-25 T7）
const pagedRef = ref()
// 2026-08-27 T15：列拖动 onMounted 挂 useDraggable 到表头 <tr>（列换序；绑 thead 会变成拖整行，2026-08-27 修正）
const tableRef = ref()
// fetcher 闭包从 PagedTable 暴露的 ref 读分页参数（而不是 view 自己再持一份 refs）
const fetcher = async (params: { page: number; pageSize: number }) => {
  return await listUsers({
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  })
}

// ============ 筛选状态持久化 ============
// 2026-08-25 T7：pageSize 持久化通过 view 本地 size ↔ PagedTable.pageSize 双向同步；
//   1) 启动时把 restore 出来的 size 推到 PagedTable.pageSize
//   2) 之后 watcher 把 PagedTable.pageSize 变回写到 view 本地 size（触发 persist 自动写盘）
// 2026-08-31：移除 pageSize 持久化。PagedTable 暴露的 pageSize 是 Ref<number>，
//   Vue 3.5 component proxy 自动 unwrap → 访问得到裸 number，写入/监听都需要走
//   原 ref（pagedRef.value.pageSize 不能当作 ref 用）。pageSize 重置到默认值
//   是可接受的 trade-off，与 PartListShell / DeliveryNoteList / OutsourceList 一致。

// ============ 列可见性 + 列顺序拖动 ============
// 「操作」列不放进 defs → 始终可见。
// 2026-08-27 T15：补 prop / width / minWidth / align + 复杂单元格走 cellRender。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  { key: 'username', label: '用户名', prop: 'username', minWidth: 120, align: 'center' },
  { key: 'full_name', label: '姓名', prop: 'full_name', minWidth: 100, align: 'center' },
  {
    key: 'roles', label: '角色', minWidth: 200, align: 'center',
    cellRender: ({ row }) => {
      const u = row as UserOut
      if (u.roles.length === 0) {
        return h('span', { class: 'no-roles' }, '无角色')
      }
      // 2026-08-27 T15：cellRender 必须返回单一 VNode,所以用 div 包裹多个 tag。
      // 原模板直接用 v-for 渲染多个根节点,这里改用 div.role-tags 容器复用 .role-tags flex 样式。
      return h('div', { class: 'role-tags' }, u.roles.map((r) => h(ElTag,
        { key: r.id, size: 'small', type: r.scope_type ? 'warning' : 'primary' },
        () => `${r.role}${r.shelf_code ? ` @${r.shelf_code}` : ''}`)))
    },
  },
  {
    key: 'is_active', label: '状态', minWidth: 80, align: 'center',
    cellRender: ({ row }) => h(ElTag,
      { type: (row as UserOut).is_active ? 'success' : 'danger', size: 'small' },
      () => (row as UserOut).is_active ? '启用' : '停用'),
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'user_list' })
const drag = useColumnDrag(columnDefs, { listKey: 'user_list' })

const showCreate = ref(false)
const saving = ref(false)
const editingUser = ref<UserOut | null>(null)
const userFormRef = ref()
const userForm = reactive({ username: '', password: '', full_name: '' })
const userRules = {
  username: [{ required: true, message: '必填' }],
  full_name: [{ required: true, message: '必填' }],
}

const showRoles = ref(false)
const roleUser = ref<UserOut | null>(null)
const roleList = ref<UserRoleOut[]>([])
const shelfOptions = ref<Shelf[]>([])
// 2026-07-13：5 个 role 全量暴露；shelfIds 多选。
// shelfIds 在前端保持字符串：雪花 ID 长度 > 2^53，Number() 会丢精度。
const ROLE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'MANAGER', label: '管理员' },
  { value: 'CLERK', label: '文员' },
  { value: 'SHELF_ACCOUNT', label: '货架一体机账号' },
  { value: 'INSPECTOR', label: '品检员' },
  { value: 'CNC_PROGRAMMER', label: 'CNC 编程员' },
]
const addRoleForm = reactive<{ role: string; shelfIds: string[] }>({ role: '', shelfIds: [] })

// 当前账号已绑的 SHELF_ACCOUNT 货架 id 集合（多选下拉 disabled 防重复绑）
const boundShelfIds = computed<Set<string>>(() => new Set(
  roleList.value
    .filter((r) => r.role === 'SHELF_ACCOUNT' && r.scope_id)
    .map((r) => String(r.scope_id)),
))

async function fetchData() {
  // 2026-08-25 T7：fetchData 现在是 PagedTable 的薄包装；view 其它地方仍调用以触发刷新
  await pagedRef.value?.fetch()
}

function resetForm() { userForm.username = ''; userForm.password = ''; userForm.full_name = ''; editingUser.value = null }
function editUser(obj: any) { const u = obj as UserOut; editingUser.value = u; userForm.username = u.username; userForm.full_name = u.full_name; userForm.password = ''; showCreate.value = true }

async function saveUser() {
  const valid = await userFormRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    if (editingUser.value) {
      const p: any = { full_name: userForm.full_name }
      if (userForm.password) p.password = userForm.password
      await updateUser(String(editingUser.value.id), p)
    } else {
      await createUser({ username: userForm.username, password: userForm.password || 'changeme', full_name: userForm.full_name })
    }
    showCreate.value = false
    await fetchData()
    ElMessage.success('已保存')
  } catch (e: any) { ElMessage.error(e?.message || '保存失败') }
  finally { saving.value = false }
}

async function doDeactivate(id: string) { await deactivateUser(id); await fetchData(); ElMessage.success('已停用') }

async function doReset(id: string) {
  try {
    await resetUserPassword(id)
    ElMessage.success('已重置为默认密码 changeme')
  } catch (e: any) { ElMessage.error(e?.message || '重置失败') }
}

async function openRoles(obj: any) { const u = obj as UserOut;
  roleUser.value = u
  roleList.value = await listUserRoles(String(u.id))
  shelfOptions.value = (await listShelves({ is_active: true, limit: 200 })).items
  addRoleForm.role = ''; addRoleForm.shelfIds = []
  showRoles.value = true
}

async function doAddRole() {
  if (!roleUser.value || !addRoleForm.role) return
  const targetRole = addRoleForm.role  // 捕获，下面的异步调用之后用
  try {
    if (targetRole === 'SHELF_ACCOUNT') {
      // 多货架绑定：循环 N 次 addUserRole（DB 唯一约束天然去重 → 409 提示）
      // 空数组 → 走 scope_id=NULL 通配（共享 HMI 场景）
      if (addRoleForm.shelfIds.length === 0) {
        await addUserRole(String(roleUser.value.id), {
          role: 'SHELF_ACCOUNT', scope_type: 'shelf', scope_id: null,
        })
      } else {
        for (const sid of addRoleForm.shelfIds) {
          await addUserRole(String(roleUser.value.id), {
            role: 'SHELF_ACCOUNT', scope_type: 'shelf', scope_id: sid,
          })
        }
      }
    } else {
      // 非 SHELF_ACCOUNT role（MANAGER/CLERK/INSPECTOR/CNC_PROGRAMMER）：scope 必须 NULL
      await addUserRole(String(roleUser.value.id), {
        role: targetRole, scope_type: null, scope_id: null,
      })
    }
    roleList.value = await listUserRoles(String(roleUser.value.id))
    addRoleForm.shelfIds = []
    ElMessage.success('已添加')
    // 提示 SHELF_ACCOUNT：绑定变更要等 token 自动刷新（最多 12h）或重新登录
    if (targetRole === 'SHELF_ACCOUNT') {
      ElMessageBox.alert(
        '绑定变更已写入。关联 SHELF_ACCOUNT 账号需重新登录或等待 access token 自动刷新（最多 12h）后才能看到新货架范围。',
        '提示',
        { type: 'info' },
      ).catch(() => { /* 用户关掉提示，忽略 */ })
    }
  } catch (e: any) { ElMessage.error(e?.message || '添加失败') }
}

async function removeRole(uid: string, rid: string) { await removeUserRole(uid, rid); roleList.value = await listUserRoles(uid); ElMessage.success('已移除') }

onMounted(() => {
  void fetchData()
  // 2026-08-28 改造：传 el-table 实例 ref 即可，composable 内部解析表头 <tr> +
  // MutationObserver 自愈（表头首次出现 / EP 重建都能覆盖）。
  drag.applyDrag(tableRef)
})
</script>

<style lang="scss" scoped>
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; h2 { margin: 0; font-size: 18px; } }
// 2026-08-25：ColumnVisibilityPopover 收纳位（ResponsiveList 拆掉后从子组件抽出提到顶层）
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.no-roles { color: #c0c4cc; font-size: 13px; }
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
.role-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.scope-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  padding: 8px 12px;
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 6px;
  font-size: 13px;
  color: #b88230;
  line-height: 1.5;
}
</style>
