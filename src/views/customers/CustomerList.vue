<!--
  CustomerList.vue

  /customers — 客户管理 → 客户一览。

  展示形式：el-tree 客户树（**任意深度**，2026-10-17 起），每个节点 hover 出现
  「+/编辑/删除」按钮：
    - 任意节点：可「+」加子客户（改前只有一级节点能加子）
    - 任意节点：可编辑 / 删除（后端拒删有子节点的客户）

  数据：共享 query `useCustomersQuery()` 拉全量平铺数据（「不传 limit = 全量」是
  无限层级改造锁定的后端口径），再由 `buildCustomerTree` 拼成任意深度的树 ——
  本页不再持有拼树逻辑：硬编码两层的老实现在 3 层以上会把第 3 层往下的节点整片丢掉。

  2026-07-09 起一级客户新增 `serial_prefix`（A-Z 单字符）字段：
  - 弹窗 el-form 多一个 `el-form-item`，仅在一级客户（parent_id 为空）时启用 + 必填；
  - 树行 hover 槽内，根节点（parent_id === null）名前挂一个 `el-tag` 显示当前前缀字母。
    非根节点不显示 tag。
-->
<template>
  <div class="customer-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline class="customer-filter-form">
        <el-form-item label="客户名">
          <el-input
            v-model="search.keyword"
            placeholder="按客户名过滤"
            clearable
            style="width: 100%; max-width: 260px"
            @keyup.enter="applyFilter"
            @clear="applyFilter"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="applyFilter">
            <el-icon><Search /></el-icon><span>查询</span>
          </el-button>
          <el-button @click="onReset">
            <el-icon><RefreshLeft /></el-icon><span>重置</span>
          </el-button>
          <el-button type="success" @click="onNewRoot">
            <el-icon><Plus /></el-icon><span>新增一级客户</span>
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-loading="loading" shadow="never">
      <el-tree
        v-if="filteredTree.length > 0"
        :data="filteredTree"
        :props="{ label: 'name', children: 'children' }"
        node-key="id"
        :indent="TREE_INDENT"
        default-expand-all
        :expand-on-click-node="false"
      >
        <template #default="{ data }">
          <div class="tree-row">
            <!-- 一级客户：前缀 tag 挂在名字前面。判据是 parent_id === null，
                 与层级数无关，改成任意深度后依然成立，无需改。 -->
            <el-tag
              v-if="
                (data as CustomerTreeNode).parent_id === null &&
                (data as CustomerTreeNode).serial_prefix
              "
              size="small"
              effect="dark"
              type="primary"
              class="tree-row__prefix"
            >
              {{ (data as CustomerTreeNode).serial_prefix }}
            </el-tag>
            <el-tag
              v-else-if="(data as CustomerTreeNode).parent_id === null"
              size="small"
              effect="plain"
              type="info"
              class="tree-row__prefix"
            >
              未设置
            </el-tag>
            <span class="tree-row__name">{{ (data as CustomerTreeNode).name }}</span>
            <span class="tree-row__actions">
              <el-button
                link
                type="primary"
                size="small"
                @click="onAddChild(data as CustomerTreeNode)"
              >
                + 子客户
              </el-button>
              <el-button link type="primary" size="small" @click="onEdit(data as CustomerTreeNode)"
                >编辑</el-button
              >
              <el-button link type="danger" size="small" @click="onDelete(data as CustomerTreeNode)"
                >删除</el-button
              >
            </span>
          </div>
        </template>
      </el-tree>
      <el-empty v-else description="暂无客户" />
    </el-card>

    <!-- 新增 / 编辑 Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      :width="customerDlg.width"
      :top="customerDlg.top"
      :close-on-click-modal="false"
      @closed="onDialogClosed"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
        label-position="right"
      >
        <el-form-item label="客户名" prop="name">
          <el-input
            v-model="form.name"
            placeholder="例如：法拉电子 / 母排厂一组"
            maxlength="100"
            show-word-limit
          />
        </el-form-item>

        <!-- 父客户：2026-10-17 起**三个模式里只有 newRoot 不显示，其余全是只读**。
             - newRoot：整项隐藏（parent_id 隐式为 NULL，由后端建根）；
             - newChild：父 = 点「+」的那个节点，显示它的**完整祖先路径**（含 L1），
               否则点一个 L4 班组上的「+」时用户看不到它挂在哪条链上；
             - edit：**只读**。后端 update 见 payload 带 parent_id 即拒（「不支持修改
               parent_id」）—— 产品决定：客户层级不可移动，要移动请删除后在目标父节点
               下重建。所以这里不再有 el-select，也就没有「改父客户」这条路径。 -->
        <el-form-item v-if="mode !== 'newRoot'" label="父客户">
          <el-input :model-value="parentPathText" disabled />
          <p v-if="mode === 'edit'" class="form-hint">
            客户层级不可移动；如需调整请删除后在目标父节点下重建。
          </p>
        </el-form-item>

        <!-- 序列号前缀：
             - newChild 模式下整项隐藏（子客户继承父，无需设置）；
             - newRoot 必填；
             - edit 模式下**一级客户**可改、非一级禁用 —— 判据是
               `form.parentId`（改前 edit 可改父客户，这个值会被 el-select 改写；
               改后父客户只读，它恒等于被编辑客户自己的 parent_id，判断成立）。 -->
        <el-form-item v-if="mode !== 'newChild'" label="序列号前缀" prop="serialPrefix">
          <el-select
            v-model="form.serialPrefix"
            placeholder="一级客户必填 A-Z"
            clearable
            filterable
            :disabled="mode === 'edit' && form.parentId !== null"
            style="width: 100%"
          >
            <el-option v-for="p in serialPrefixOptions" :key="p" :label="p" :value="p" />
          </el-select>
          <p class="form-hint">
            一级客户的序列号前缀
            A-Z；新建后可在客户一览再次修改（仅影响后续创建的零件/装配体流水号）。
          </p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// 2026-09-26 改造：列表改走共享 query useCustomersQuery（fetchList / customers ref /
// loading ref 删除，源改自 query.data / query.isFetching 派生）。3 个写点
// （createCustomer / updateCustomer / softDeleteCustomer）包 useMutation +
// onSuccess 失效整个域（invalidateCustomersQuery(qc)）+ ElMessage。
// 写操作本地避错：mutation onError 已经弹错，onSave / onDelete catch 内不再处理。
// 全局 mutations.retry: 0 在 main.ts 已显式设置，仓内新增 mutation 不再写 retry。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { Plus, RefreshLeft, Search } from '@element-plus/icons-vue';
import { useDialogSize } from '@/composables/useDialogSize';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import {
  invalidateCustomersQuery,
  useCustomersQuery,
} from '@/composables/queries/useCustomersQuery';
import { createCustomer, softDeleteCustomer, updateCustomer, type Customer } from '@/api/customer';
// 2026-10-17：拼树改用 `buildCustomerTree`（任意深度 + 环 / 孤儿 / 重复 id 兜底），
// 模板与脚本里的节点类型一律用它的 `CustomerTreeNode`，不再维护一份只含两层的本地
// `interface TreeNode`。
import { buildCustomerTree, type CustomerTreeNode } from '@/api/customer.tree';

const qc = useQueryClient();

// ============ 共享 query ============
const { data: queryData, isFetching, error } = useCustomersQuery();
const customers = computed<Customer[]>(() => (queryData.value?.items ?? []) as Customer[]);
const loading = computed<boolean>(() => isFetching.value);
// 2026-09-26：useQuery 不在 setup 抛错，错误在 query.error 暴露；watch 一次触发
// ElMessage 与原 fetchList catch 路径等价。
watch(
  () => error.value,
  (err) => {
    if (err) ElMessage.error(err.message ?? '客户列表加载失败');
  },
);
const search = reactive({ keyword: '' });

// ============ 筛选状态持久化 ============
const { restore: restoreCustomerFilter } = useListStatePersist('customer_list', { search });

// 弹窗尺寸：桌面 480px，手机 92vw + 6vh
const customerDlg = useDialogSize({ desktopWidth: 480 });

// ===== 树形组装 =====
// 2026-10-17：删掉本页内联的「硬编码两层」拼树（`roots = parent_id === null` +
// 每个 root 的 children 只取一层），改调 `buildCustomerTree`。老实现下第 3 层往下的
// 节点既不在 roots 也不在任何 root 的 children 里 ⇒ 直接从树上消失。
// `useCustomersQuery` 不带任何分页参数（「不传 limit = 全量」），本页也没有任何分页
// 控件或 total/limit/offset 读取，所以节点变多不会引入隐含的分页假设。
const tree = computed<CustomerTreeNode[]>(() => buildCustomerTree(customers.value));

/** 每层缩进（px）。EP 的 `el-tree` `indent` 是**每层固定值**，没有「深层压缩」的
 *  档位，客户改成任意深度后 5~6 层会把名字挤到卡片右边；14px 仍一眼看得出层级，
 *  又比默认 18px 每层省 4px。配合 `.tree-row__name` 的 ellipsis 兜住长名字。 */
const TREE_INDENT = 14;

/** 递归按节点名过滤，规则三条：
 *  1. 命中 ⇒ 保留该节点**及其全部后代**（搜「手机部」时它下面的班组都该看见）；
 *  2. 自身没命中但有命中的后代 ⇒ 保留本节点（祖先链必须留着，否则命中节点在
 *     el-tree 里成了孤儿、层级位置全错）；
 *  3. 整支都没命中 ⇒ 剪掉。
 *  命中的分支直接 push 原节点（不复制），未命中的分支 push 浅拷贝 —— 不能就地改
 *  `node.children`，否则会把过滤结果写回 `tree` 本体。 */
function filterByKeyword(nodes: CustomerTreeNode[], kw: string): CustomerTreeNode[] {
  const kept: CustomerTreeNode[] = [];
  for (const node of nodes) {
    if (node.name.toLowerCase().includes(kw)) {
      kept.push(node);
      continue;
    }
    const children = filterByKeyword(node.children, kw);
    if (children.length > 0) kept.push({ ...node, children });
  }
  return kept;
}

const filteredTree = computed<CustomerTreeNode[]>(() => {
  const kw = search.keyword.trim().toLowerCase();
  if (!kw) return tree.value;
  return filterByKeyword(tree.value, kw);
});

/** 从**未过滤**的整棵树回溯出该节点的完整祖先链路径（L1 起，` / ` 连接）。
 *  走 tree 本体而不是 filteredTree：过滤结果虽然按规则 2 留着祖先链，但过滤是按
 *  「当前筛选条件」投影出来的，拿它算「父客户是谁」会把临时视图当成结构事实。
 *  找不到（理论上不会：节点都来自这棵树）时回落到 `name`，不至于显示空白。 */
function ancestorPathOf(id: string): string {
  const acc: string[] = [];
  const walk = (nodes: CustomerTreeNode[]): boolean => {
    for (const node of nodes) {
      acc.push(node.name);
      if (node.id === id) return true;
      if (walk(node.children)) return true;
      acc.pop();
    }
    return false;
  };
  if (walk(tree.value)) return acc.join(' / ');
  return customers.value.find((c) => c.id === id)?.name ?? '';
}

// A-Z 单字符序列号前缀候选项（运行时生成，硬编码 26 行太啰嗦）
const SERIAL_PREFIX_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const serialPrefixOptions = computed<string[]>(() => SERIAL_PREFIX_LETTERS.split(''));

function applyFilter(): void {
  // 过滤是 computed 自动响应的；这里留 hook 给未来扩展
}
function onReset(): void {
  search.keyword = '';
}

// ===== Dialog 表单 =====
type DialogMode = 'newRoot' | 'newChild' | 'edit';

interface FormState {
  name: string;
  parentId: string | null;
  serialPrefix: string | null;
}
const formRef = ref<FormInstance>();
const dialogVisible = ref(false);
const editing = ref<Customer | null>(null);
const mode = ref<DialogMode>('newRoot');
const form = reactive<FormState>({ name: '', parentId: null, serialPrefix: null });

/** 「父客户」只读字段的展示值：完整祖先路径（含 L1）；一级客户显示「无上级」。
 *  newChild 时 `form.parentId` = 点「+」的节点 id，edit 时 = 被编辑客户自己的
 *  `parent_id`（父客户不可改 ⇒ 它不再被任何交互改写）。 */
const parentPathText = computed<string>(() =>
  form.parentId ? ancestorPathOf(form.parentId) : '（无上级 · 一级客户）',
);

// 弹窗标题按 mode 分支
const dialogTitle = computed(() =>
  mode.value === 'newRoot' ? '新增一级客户' : mode.value === 'newChild' ? '新增子客户' : '编辑客户',
);

const rules: FormRules = {
  name: [{ required: true, message: '请输入客户名', trigger: 'blur' }],
  serialPrefix: [
    {
      validator: (_rule, value, callback) => {
        // 新增子客户：表单里没这字段，跳过
        if (mode.value === 'newChild') {
          callback();
          return;
        }
        // 编辑叶子客户：前缀 disabled，service 层忽略，跳过
        if (mode.value === 'edit' && form.parentId !== null) {
          callback();
          return;
        }
        // 新增一级客户 / 编辑一级客户：必填 A-Z
        if (!value) {
          callback(new Error('一级客户必须指定序列号前缀 A-Z'));
          return;
        }
        if (typeof value !== 'string' || value.length !== 1 || value < 'A' || value > 'Z') {
          callback(new Error('序列号前缀必须是 A-Z 单字符'));
          return;
        }
        callback();
      },
      trigger: 'change',
    },
  ],
};

// ============ 写 mutation ============
// 2026-09-26：3 个写操作统一 useMutation + onSuccess 走 invalidateCustomersQuery
// + ElMessage。mutationKey 保留三层 [domain, action] 与仓内其它 mutation 命名风格一致。
const saving = ref(false);
const createMutation = useMutation({
  mutationKey: ['customers', 'create'],
  mutationFn: (payload: Parameters<typeof createCustomer>[0]) => createCustomer(payload),
  onSuccess: async () => {
    await invalidateCustomersQuery(qc);
    ElMessage.success('客户已创建');
  },
  onError: (e: Error) => ElMessage.error(e.message ?? '保存失败'),
});
const updateMutation = useMutation({
  mutationKey: ['customers', 'update'],
  mutationFn: (vars: { id: string; payload: Parameters<typeof updateCustomer>[1] }) =>
    updateCustomer(vars.id, vars.payload),
  onSuccess: async () => {
    await invalidateCustomersQuery(qc);
    ElMessage.success('已保存');
  },
  onError: (e: Error) => ElMessage.error(e.message ?? '保存失败'),
});
const deleteMutation = useMutation({
  mutationKey: ['customers', 'delete'],
  mutationFn: (id: string) => softDeleteCustomer(id),
  onSuccess: async () => {
    await invalidateCustomersQuery(qc);
    ElMessage.success('客户已删除');
  },
  onError: (e: Error) => ElMessage.error(e.message ?? '删除失败'),
});

function onNewRoot(): void {
  mode.value = 'newRoot';
  editing.value = null;
  form.name = '';
  form.parentId = null;
  form.serialPrefix = null;
  dialogVisible.value = true;
}

/** 2026-10-17：任意层级节点都能加子客户（改前有一句 `if (parent.parent_id !== null)
 *  return` 把 L2 往上的入口全挡掉，两层时代成立、任意深度下必然挡错）。 */
function onAddChild(parent: CustomerTreeNode): void {
  mode.value = 'newChild';
  editing.value = null;
  form.name = '';
  form.parentId = parent.id;
  form.serialPrefix = null;
  dialogVisible.value = true;
}

function onEdit(node: CustomerTreeNode): void {
  const cust = customers.value.find((c) => c.id === node.id);
  if (!cust) return;
  mode.value = 'edit';
  editing.value = cust;
  form.name = cust.name;
  // 2026-10-17：父客户改只读后，`form.parentId` 在 edit 下不再被任何交互改写，
  // 它恒等于被编辑客户自己的 parent_id —— 序列号前缀「仅一级客户可改」的判据
  // 直接复用它，不再另开一个字段。
  form.parentId = cust.parent_id;
  // 一级客户：带出原 prefix；非一级客户：永远 null（前端不读，后端也忽略）
  form.serialPrefix = cust.parent_id === null ? cust.serial_prefix : null;
  dialogVisible.value = true;
}

async function onSave(): Promise<void> {
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      // 2026-10-17：**payload 不带 parent_id** —— 后端 update 见 `parent_id` 非缺省
      // 就拒（「不支持修改 parent_id」），而改前本页无条件带 `parent_id: form.parentId
      // || null` ⇒ 编辑任何非根客户必然失败（存量 bug，本条用例就是它的回归守卫）。
      // update 时未传 prefix 即视为不改；只有显式非空才放进 payload。
      const updatePayload: Parameters<typeof updateCustomer>[1] = {
        name: form.name.trim(),
      };
      if (form.serialPrefix) {
        updatePayload.serial_prefix = form.serialPrefix;
      }
      await updateMutation.mutateAsync({ id: editing.value.id, payload: updatePayload });
    } else {
      await createMutation.mutateAsync({
        name: form.name.trim(),
        // newRoot：null = 让后端建根；newChild：挂触发按钮那个节点（任意深度）。
        parent_id: form.parentId || null,
        // 一级客户：传当前 prefix（可能 null = 让后端报必填校验）；
        // 非一级客户：service 层会忽略，payload 仍带 null 保持类型一致。
        serial_prefix: form.serialPrefix || null,
      });
    }
    dialogVisible.value = false;
  } catch {
    // mutation onError 已 ElMessage 提示
  } finally {
    saving.value = false;
  }
}

function onDialogClosed(): void {
  editing.value = null;
  mode.value = 'newRoot';
  form.name = '';
  form.parentId = null;
  form.serialPrefix = null;
}

/** 后代节点数（任意深度递归）。后端软删有子节点的客户会被拒
 *  （20124 BIZ_CUSTOMER_HAS_CHILDREN，mutation 的 onError 会弹），所以确认框
 *  文案必须说真话 —— 改前那句「删除将一起拒绝」在后端加检查之前是假的，
 *  而且只数 `children.length`（一级节点的直接子节点数），非一级节点恒 0。 */
function countDescendants(node: CustomerTreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

async function onDelete(node: CustomerTreeNode): Promise<void> {
  const descendants = countDescendants(node);
  const warn =
    descendants > 0 ? `（客户「${node.name}」下仍有 ${descendants} 个子节点，删除将被拒绝）` : '';
  try {
    await ElMessageBox.confirm(`确认软删除客户「${node.name}」？${warn}`, '删除客户', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await deleteMutation.mutateAsync(node.id);
  } catch {
    // mutation onError 已 ElMessage 提示
  }
}

onMounted(() => {
  // 先尝试恢复 localStorage 中的搜索条件
  const persisted = restoreCustomerFilter();
  if (persisted) {
    Object.assign(search, persisted.search);
  }
  // useCustomersQuery 在 setup 顶层即自动 fetch；onMounted 不再触发 fetchList
});
</script>

<style lang="scss" scoped>
.customer-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.filter-card :deep(.el-card__body) {
  padding: 16px 20px;
}
.form-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}
:deep(.tree-row) {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 2px 4px;
  gap: 8px;
}
:deep(.tree-row__prefix) {
  flex-shrink: 0;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
:deep(.tree-row__name) {
  flex: 1;
  /* 2026-10-17：客户树改成任意深度后，缩进会吃掉横向空间（每层 TREE_INDENT）。
     `min-width: 0` 是 flex 子项省略号的前提（否则按内容宽度撑开、把操作按钮挤出
     卡片）；操作按钮另加 flex-shrink: 0，保证名字长时按钮不被挤没。 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.tree-row__actions) {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease-in-out;
}
:deep(.el-tree-node__content:hover .tree-row__actions) {
  opacity: 1;
}

/* 筛选表单在窄屏宽度自适应：form-item 内按钮过多时可换行 */
.customer-filter-form :deep(.el-form-item__content) {
  flex-wrap: wrap;
  gap: 6px;
}
</style>
