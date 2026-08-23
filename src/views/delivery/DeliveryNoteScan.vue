<script setup lang="ts">
// DeliveryNoteScan — 扫码建单页面（v2，按设计文档 D3 自动路由 + 分组规则面板）
// 2026-08-22 重构：扫码 + L1 客户下的「分组规则 CRUD」+ 水平排列的多草稿卡片视图。
//
// 三段式（自上而下）：
//   1. 分组规则面板：选 L1 + 该 L1 下的分组 CRUD + 未分组 L2 列表
//   2. 扫码输入条：保留 1.5s 同码防抖 + inflight guard
//   3. 草稿卡片列表：当前 L1 下所有 DRAFT，水平滚动，每张卡直接展示最近加入批次
//
// 扫码路由由后端 classify 决定，前端只渲染——保留 v2 设计文档 §3 D3「纯转发」原则。
//
// 复用：
//   - useBarcodeScanner 单例订阅（onMounted 挂 / onBeforeUnmount 解）
//   - listCustomers() 拉 L1/L2 全集过滤
//   - listNotes() 拉当前 L1 的 DRAFT 草稿
//   - ApiError 错误码分流（沿用原 applyError 的 21417/21418/21416/21405/21406/21419）

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Promotion } from '@element-plus/icons-vue'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import { listNotes, scanDelivery } from '@/api/deliveryNote'
import { listCustomers, type Customer } from '@/api/customer'
import {
  createDeliveryGroup,
  listDeliveryGroups,
  softDeleteDeliveryGroup,
  updateDeliveryGroup,
} from '@/api/deliveryGroup'
import { ApiError } from '@/api/http'
import type { ScanDeliveryOut, ScanNoteSummary } from '@/types/deliveryNote'
import type { DeliveryGroupListOut, DeliveryGroupOut } from '@/types/deliveryGroup'
import DeliveryGroupEditor from '@/views/delivery/components/DeliveryGroupEditor.vue'

const router = useRouter()

// ============ 扫码输入态 ============
const scanInput = ref('')
const scanning = ref(false)
/** 1.5s 同码防抖：双击 Enter / 扫码枪连扫容错（设计文档 §5 防抖策略） */
const lastScanCode = ref('')
const lastScanAt = ref(0)
/** 输入框 ref（手动聚焦） */
const scanInputRef = ref<{ focus: () => void } | null>(null)

// ============ L1 / 客户全集 ============
/** 当前选中的 L1 客户 id；切换时重拉 groups + drafts */
const l1CustomerId = ref('')
/** 全量客户列表（listCustomers() 返回平铺） */
const allCustomers = ref<Customer[]>([])
/** 一级客户全集（parent_id === null） */
const rootCustomers = computed<Customer[]>(() =>
  allCustomers.value.filter((c) => c.parent_id === null),
)
/** 当前 L1 下的 L2 客户全集（分组编辑器用） */
const allL2Customers = computed<Customer[]>(() => {
  if (!l1CustomerId.value) return []
  return allCustomers.value.filter((c) => c.parent_id === l1CustomerId.value)
})

// ============ 分组态 ============
const groups = ref<DeliveryGroupListOut>({ groups: [], ungrouped_customers: [] })
const groupsLoading = ref(false)
/** 编辑 dialog 状态：null=关闭；带 initial=编辑；initial=undefined=新建 */
const editorOpen = ref(false)
const editingGroup = ref<DeliveryGroupOut | null>(null)

// ============ 草稿态 ============
/** 当前 L1 下所有 DRAFT 草稿（key = note_id） */
const drafts = ref<Record<string, ScanNoteSummary>>({})
const draftsLoading = ref(false)
const draftsCount = computed(() => Object.keys(drafts.value).length)

const { onScan } = useBarcodeScanner()
let unsubScan: (() => void) | null = null

/** 浏览器基线兜底（与 PartBatchNew.vue makeUid 同款）。 */
function nextId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ============ 数据加载 ============

/** 拉全量客户（onMounted 调一次即可）。 */
async function loadAllCustomers(): Promise<void> {
  try {
    allCustomers.value = await listCustomers()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载客户列表失败')
  }
}

/** 拉当前 L1 下的分组 + 未分组 L2。 */
async function reloadGroups(l1Id: string): Promise<void> {
  if (!l1Id) {
    groups.value = { groups: [], ungrouped_customers: [] }
    return
  }
  groupsLoading.value = true
  try {
    groups.value = await listDeliveryGroups(l1Id)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载分组规则失败')
  } finally {
    groupsLoading.value = false
  }
}

/** 拉当前 L1 下所有 DRAFT 草稿，按 id 索引。 */
async function reloadDrafts(l1Id: string): Promise<void> {
  if (!l1Id) {
    drafts.value = {}
    return
  }
  draftsLoading.value = true
  try {
    // 后端 DeliveryNoteOut 已是 ScanNoteSummary 字段超集（除 scope / scope_label /
    // recent_items 外）。本次重构只展示 recent_items / scope_label，因此 listNotes
    // 返回的 DeliveryNoteOut 直接 cast 给 ScanNoteSummary 用（缺字段填空即可）。
    const resp = await listNotes({
      statuses: ['DRAFT'],
      customer_id: l1Id,
      limit: 200,
    })
    const next: Record<string, ScanNoteSummary> = {}
    for (const n of resp.items) {
      next[n.id] = {
        ...n,
        scope: 'L1_WIDE',
        scope_label: '按一级客户',
        recent_items: [],
      } as ScanNoteSummary
    }
    drafts.value = next
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载草稿列表失败')
  } finally {
    draftsLoading.value = false
  }
}

// ============ 扫码主流程 ============

/** 手动输入框回车 / 点按钮：拉出原值 → 清空 → 触发处理 */
async function onSubmit(): Promise<void> {
  const raw = scanInput.value
  scanInput.value = ''
  await handleScan(raw)
}

/**
 * 单次扫码处理全流程：
 *   1) trim + 长度校验
 *   2) inflight / 1.5s 同码 防抖
 *   3) await scanDelivery → applySuccess / applyError
 *   4) finally 强制重新聚焦输入框
 */
async function handleScan(rawCode: string): Promise<void> {
  const code = rawCode.trim()

  // 1) 客户端格式校验
  if (code.length < 1 || code.length > 64) {
    ElMessage.warning('条码格式不正确')
    return
  }

  // 2) inflight / 双击 Enter 守卫
  if (scanning.value) {
    ElMessage.warning('上一次扫码尚未完成，请稍候')
    return
  }
  const now = Date.now()
  if (lastScanCode.value === code && now - lastScanAt.value < 1500) {
    return // 同码 1.5s 内重复：吞掉
  }
  lastScanCode.value = code
  lastScanAt.value = now

  scanning.value = true
  try {
    const out = await scanDelivery(code)
    applySuccess(out)
  } catch (e) {
    applyError(code, e)
  } finally {
    scanning.value = false
    await nextTick()
    scanInputRef.value?.focus()
  }
}

/** 成功：把 out.note 写入 drafts Map（按 id 替换为后端最新）；toast 成功/重复 */
function applySuccess(out: ScanDeliveryOut): void {
  // 用响应式赋值触发模板刷新（直接 drafts.value[id] = out.note 也行，但用 spread
  // 显式重写整个对象更稳）。
  drafts.value = {
    ...drafts.value,
    [out.note.id]: out.note,
  }
  if (out.outcome === 'ADDED') {
    ElMessage.success(`已加入 ${out.resolved.serial_no} → ${out.note.delivery_note_no}`)
  } else {
    ElMessage.warning(`${out.resolved.serial_no} 已在 ${out.note.delivery_note_no} 上`)
  }
}

/**
 * 失败：按 ApiError.code 分流（设计文档 §7 错误码）
 *   21417 → 条码未命中
 *   21418 → 装配件整套未齐（含 per-child 明细）
 *   21416 → 范围不匹配
 *   21405 / 21406 → 单条扫码失败
 *   21419 → 其他扫码拒绝
 *   其他 → 网络错 / 5xx 等
 * 错误仅 toast，不动 drafts（事务回滚不会产生草稿）。
 */
function applyError(code: string, e: unknown): void {
  let message = (e as Error)?.message ?? '扫码失败'
  if (e instanceof ApiError) {
    message = e.message || message
  }
  ElMessage.error(message)
}

// ============ 分组面板：CRUD ============

function openNewGroup(): void {
  editingGroup.value = null
  editorOpen.value = true
}

function openEditGroup(g: DeliveryGroupOut): void {
  editingGroup.value = g
  editorOpen.value = true
}

async function onGroupEditorSubmit(payload: {
  name: string
  member_customer_ids: string[]
}): Promise<void> {
  if (!l1CustomerId.value) return
  const initial = editingGroup.value
  try {
    if (initial) {
      await updateDeliveryGroup(initial.id, {
        version: initial.version,
        name: payload.name,
        member_customer_ids: payload.member_customer_ids,
      })
      ElMessage.success('分组已更新')
    } else {
      await createDeliveryGroup({
        customer_id: l1CustomerId.value,
        name: payload.name,
        member_customer_ids: payload.member_customer_ids,
      })
      ElMessage.success('分组已创建')
    }
    editorOpen.value = false
    editingGroup.value = null
    await reloadGroups(l1CustomerId.value)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存分组失败')
  }
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
  try {
    await softDeleteDeliveryGroup(g.id, { version: g.version })
    ElMessage.success('分组已删除')
    await reloadGroups(l1CustomerId.value)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除分组失败')
  }
}

// ============ 卡片跳转 ============

function gotoDetail(draft: ScanNoteSummary): void {
  void router.push(`/delivery-notes/${draft.id}`)
}

function gotoAllDrafts(): void {
  if (!l1CustomerId.value) return
  void router.push({
    path: '/delivery-notes',
    query: { statuses: 'DRAFT', customer_id: l1CustomerId.value },
  })
}

function onScanInputClear(): void {
  scanInput.value = ''
}

// ============ 生命周期 ============

onMounted(async () => {
  // 扫码枪订阅：每页独立挂载；卸载时退订避免劫持到其他页
  unsubScan = onScan((code) => { void handleScan(code) })
  // 进入页后自动聚焦输入框，等 DOM 完成 nextTick 再 focus
  void nextTick().then(() => scanInputRef.value?.focus())
  // 拉客户全集；如有 L1 初始值再立刻拉 groups + drafts（本次不做 URL 持久化）
  await loadAllCustomers()
})

/** L1 切换 → 重拉分组 + 草稿 + 关掉打开中的 editor。 */
watch(l1CustomerId, async (id) => {
  editorOpen.value = false
  editingGroup.value = null
  await Promise.all([reloadGroups(id), reloadDrafts(id)])
})

onBeforeUnmount(() => {
  unsubScan?.()
  unsubScan = null
})
</script>

<template>
  <div class="page">
    <!-- ========== 顶部：分组规则面板 ========== -->
    <el-card shadow="never" v-loading="groupsLoading">
      <template #header>
        <div class="card-header-row">
          <span class="dn-scan-card-title">分组规则</span>
          <el-button
            type="primary"
            link
            :disabled="!l1CustomerId"
            @click="openNewGroup"
          >
            + 新增分组
          </el-button>
        </div>
      </template>

      <div class="filter-row">
        <span class="filter-label">一级客户</span>
        <el-select
          v-model="l1CustomerId"
          placeholder="先选一级客户"
          filterable
          clearable
          style="width: 280px"
        >
          <el-option
            v-for="c in rootCustomers"
            :key="c.id"
            :label="c.name"
            :value="c.id"
          />
        </el-select>
      </div>

      <template v-if="l1CustomerId">
        <el-empty
          v-if="groups.groups.length === 0 && groups.ungrouped_customers.length === 0"
          description="该一级客户下还没有 L2 客户"
          :image-size="80"
        />
        <template v-else>
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

          <div v-if="groups.ungrouped_customers.length > 0" class="ungrouped-row">
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
        </template>
      </template>
      <el-empty
        v-else
        description="先选一级客户，加载分组规则"
        :image-size="80"
      />
    </el-card>

    <!-- ========== 中间：扫码输入 ========== -->
    <el-card shadow="never">
      <template #header>
        <span class="dn-scan-card-title">扫码</span>
      </template>
      <div class="scan-row">
        <el-input
          ref="scanInputRef"
          v-model="scanInput"
          placeholder="扫码或输入序列号（Enter 提交）"
          clearable
          style="width: 360px"
          @keyup.enter="onSubmit"
          @clear="onScanInputClear"
        >
          <template #prefix>
            <el-icon><Promotion /></el-icon>
          </template>
        </el-input>
        <el-button type="primary" :loading="scanning" @click="onSubmit">
          提交扫码
        </el-button>
      </div>
    </el-card>

    <!-- ========== 底部：草稿卡片列表 ========== -->
    <div class="drafts-section" v-loading="draftsLoading">
      <div class="drafts-header">
        <span class="dn-scan-card-title">当前草稿（{{ draftsCount }}）</span>
        <el-button
          v-if="draftsCount > 0"
          link
          type="primary"
          @click="gotoAllDrafts"
        >
          查看全部 →
        </el-button>
      </div>

      <el-empty
        v-if="draftsCount === 0"
        description="暂无草稿 — 扫码开始建单"
        :image-size="80"
      />
      <div v-else class="drafts-track">
        <el-card
          v-for="d in drafts"
          :key="d.id"
          shadow="hover"
          class="draft-card"
        >
          <template #header>
            <div class="draft-card-head">
              <span class="draft-no">{{ d.delivery_note_no }}</span>
              <el-tag size="small" type="info" effect="plain">
                {{ d.scope_label }}
              </el-tag>
            </div>
          </template>
          <div class="draft-card-body">
            <div class="draft-customer">{{ d.customer_path || '—' }}</div>
            <div
              v-for="r in d.recent_items"
              :key="r.batch_id"
              class="recent-row scan-row-line"
            >
              <el-tooltip
                placement="top"
                :content="`${r.serial_no ?? '—'} · ${r.drawing_no} · ${r.name}${r.order_no ? ' · ' + r.order_no : ''}`"
              >
                <span class="recent-text">
                  <span class="recent-serial">{{ r.serial_no ?? '—' }}</span>
                  <span class="recent-name muted">{{ r.name }}</span>
                  <span v-if="r.order_no" class="recent-order muted">{{ r.order_no }}</span>
                </span>
              </el-tooltip>
            </div>
            <div v-if="d.recent_items.length === 0" class="muted recent-empty">
              暂无加入批次
            </div>
          </div>
          <template #footer>
            <el-button link type="primary" @click="gotoDetail(d)">
              {{ d.part_count }} 行 → 查看单据详情
            </el-button>
          </template>
        </el-card>
      </div>
    </div>

    <!-- ========== 分组编辑器 dialog ========== -->
    <DeliveryGroupEditor
      v-if="editorOpen"
      :l1-id="l1CustomerId"
      :initial="editingGroup"
      :all-l2-customers="allL2Customers"
      @submit="onGroupEditorSubmit"
      @cancel="editorOpen = false"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dn-scan-card-title {
  font-weight: 600;
  color: var(--text-primary, #303133);
}

/* ============ 分组规则面板 ============ */
.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.filter-label {
  color: var(--el-text-color-regular);
  min-width: 64px;
}

.group-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--primary-bg, #eaf2fb);
  border: 1px solid #d9ecff;
  border-radius: 6px;
  margin-bottom: 8px;
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
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

/* ============ 扫码输入条（沿用项目浅蓝条风格） ============ */
.scan-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 14px;
  background: var(--primary-bg, #eaf2fb);
  border: 1px solid #d9ecff;
  border-radius: 6px;
}

/* ============ 草稿卡片列表 ============ */
.drafts-section {
  background: #fff;
  border-radius: 4px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
}
.drafts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.drafts-track {
  display: flex;
  flex-direction: row;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
}
.draft-card {
  min-width: 280px;
  flex: 0 0 280px;
}
.draft-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.draft-no {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 700;
  font-size: 15px;
  color: var(--text-primary, #303133);
}
.draft-customer {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}
.draft-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.recent-row {
  padding: 6px 10px;
  background: var(--primary-bg, #eaf2fb);
  border: 1px solid #d9ecff;
  border-radius: 4px;
}
.scan-row-line {
  /* 浅蓝条风格，与 .scan-row 同色系 */
  display: block;
}
.recent-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.4;
}
.recent-serial {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 600;
  color: var(--text-primary, #303133);
}
.recent-name,
.recent-order {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent-empty {
  font-size: 12px;
  padding: 4px 0;
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>