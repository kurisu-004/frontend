<!--
  DeliveryGroupPanel.vue

  2026-08-25 T11 从 DeliveryNoteScan.vue 抽出：分组规则面板（el-card）+ 增/改/删按钮 + 编辑器 dialog。

  设计要点：
  - L1 客户选择已上移到 DeliveryScanBar；本组件只关心当前 L1 下的分组列表。
  - 编辑器（DeliveryGroupEditor）由本组件内部维护显隐与 editingGroup ref：
    增 / 改 / 取消 都不需要外部参与，只有「提交」需要回传—— emit create / update。
  - 删除按钮直接在 panel 触发 ElMessageBox.confirm + emit delete；shell 收到后调 API。

  props:
    groups           — DeliveryGroupListOut（groups + ungrouped_customers）
    loading          — 加载态（v-loading）
    canCreate        — L1 已选（用以启用「新增分组」按钮）
    l1Id             — 当前 L1 id（编辑器需要，提交时透传）
    allL2Customers   — 当前 L1 下的 L2 全集（编辑器成员多选用）

  emits:
    create(payload)   — 新建分组提交；payload = { name, member_customer_ids }
    update(payload)   — 编辑分组提交；payload = { group, name, member_customer_ids }
    delete(group)     — 删除分组
-->
<script setup lang="ts">
import { ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { Customer } from '@/api/customer'
import type {
  DeliveryGroupListOut,
  DeliveryGroupOut,
} from '@/types/deliveryGroup'
import DeliveryGroupEditor from './DeliveryGroupEditor.vue'

defineProps<{
  groups: DeliveryGroupListOut
  loading: boolean
  canCreate: boolean
  l1Id: string
  allL2Customers: Customer[]
}>()

const emit = defineEmits<{
  (e: 'create', payload: { name: string; member_customer_ids: string[] }): void
  (e: 'update', payload: {
    group: DeliveryGroupOut
    name: string
    member_customer_ids: string[]
  }): void
  (e: 'delete', group: DeliveryGroupOut): void
}>()

// ============ 编辑器 dialog 状态（panel 局部拥有）============
const editorOpen = ref(false)
const editingGroup = ref<DeliveryGroupOut | null>(null)

function openNewGroup(): void {
  editingGroup.value = null
  editorOpen.value = true
}

function openEditGroup(g: DeliveryGroupOut): void {
  editingGroup.value = g
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  editingGroup.value = null
}

function onEditorSubmit(payload: { name: string; member_customer_ids: string[] }): void {
  if (editingGroup.value) {
    emit('update', { group: editingGroup.value, ...payload })
  } else {
    emit('create', payload)
  }
  closeEditor()
}

function onEditorCancel(): void {
  closeEditor()
}

async function onDeleteGroup(g: DeliveryGroupOut): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除分组「${g.name}」？该分组下的 DRAFT 草稿将不再路由。`,
      '删除分组',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  emit('delete', g)
}
</script>

<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="card-header-row">
        <span class="dn-scan-card-title">分组规则</span>
        <el-button
          type="primary"
          link
          :disabled="!canCreate"
          @click="openNewGroup"
        >
          + 新增分组
        </el-button>
      </div>
    </template>

    <template v-if="canCreate">
      <el-empty
        v-if="groups.groups.length === 0 && groups.ungrouped_customers.length === 0"
        description="该一级客户下还没有 L2 客户"
        :image-size="80"
      />
      <template v-else>
        <div class="groups-grid">
          <div
            v-for="g in groups.groups"
            :key="g.id"
            class="group-row"
          >
            <div class="group-row-main">
              <span class="group-name">{{ g.name }}</span>
              <div class="group-members">
                <el-tag
                  v-for="m in g.members"
                  :key="m.customer_id"
                  size="small"
                  effect="plain"
                  type="info"
                >
                  {{ m.customer_name }}
                </el-tag>
                <span v-if="g.members.length === 0" class="muted">（无成员）</span>
              </div>
            </div>
            <div class="group-row-actions">
              <el-button link size="small" type="primary" @click="openEditGroup(g)">
                编辑
              </el-button>
              <el-button link size="small" type="danger" @click="onDeleteGroup(g)">
                删除
              </el-button>
            </div>
          </div>

          <div
            v-if="groups.ungrouped_customers.length > 0"
            class="group-row ungrouped-row"
          >
            <div class="group-row-main">
              <span class="group-name muted">未分组 L2</span>
              <div class="group-members">
                <el-tag
                  v-for="u in groups.ungrouped_customers"
                  :key="u.id"
                  size="small"
                  effect="plain"
                >
                  {{ u.name }}
                </el-tag>
              </div>
            </div>
            <div class="group-row-actions">
              <span class="muted small">{{ groups.ungrouped_customers.length }} 个</span>
            </div>
          </div>
        </div>
      </template>
    </template>
    <el-empty
      v-else
      description="先选一级客户，加载分组规则"
      :image-size="80"
    />

    <!-- 编辑器 dialog（panel 局部拥有）-->
    <DeliveryGroupEditor
      v-if="editorOpen"
      :l1-id="l1Id"
      :initial="editingGroup"
      :all-l2-customers="allL2Customers"
      @submit="onEditorSubmit"
      @cancel="onEditorCancel"
    />
  </el-card>
</template>

<style lang="scss" scoped>
.dn-scan-card-title {
  font-weight: 600;
  color: var(--text-primary, #303133);
}

.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 分组卡片：每行最多 4 个，窄屏自动 2 列 */
.groups-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.group-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--primary-bg, #eaf2fb);
  border: 1px solid #d9ecff;
  border-radius: 6px;
  flex: 0 0 calc(25% - 9px);
  box-sizing: border-box;
}
.group-row-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.group-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  align-items: center;
}
.group-name {
  font-weight: 600;
  color: var(--text-primary, #303133);
}
.group-members {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ungrouped-row {
  background: var(--el-fill-color-light);
  border-style: dashed;
}
.ungrouped-row .small {
  font-size: 12px;
}

@media (max-width: 1200px) {
  .group-row {
    flex: 0 0 calc(50% - 6px);
  }
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>
