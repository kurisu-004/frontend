<!-- 外协发送/接收页（2026-07-16 新增；合并原 OutsourceSendList + OutsourceReceiveList）
     2026-08-25 T12：拆为 send/receive 两个独立 tab 页面 + 2 个 composable + 2 个 dialog；
     本文件仅保留 tab 切换骨架 + 页级 lookup（customers/shelves/processes）。

3 个 tab：
  - 可发送（默认）：列出至少有一条 APPROVED 报价的「可发送」零件
  - 待接收：列出 status=OUTSOURCE 的零件，等回收

PR-H 2026-07-29：「已接收历史」tab 已移除 —— 功能由 per-company 对账页承担
（/outsource/companies/:id/sent-parts，基于 t_outsource_quote 统一事实表）。

URL ?tab=sendable|receiving 记忆上次选择；初次进入默认 可发送。
-->
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { listCustomers, type Customer } from '@/api/customer'
import { listShelves } from '@/api/shelves'
import type { Shelf as ShelfItem } from '@/types/shelf'
import { listProcesses } from '@/api/process'
import type { Process } from '@/types/process'
import OutsourceSendableTab from './OutsourceSendableTab.vue'
import OutsourceReceivingTab from './OutsourceReceivingTab.vue'

type TabName = 'sendable' | 'receiving'

const route = useRoute()
const router = useRouter()

// ============================================================
// Tab 状态（URL ?tab= 同步）
// PR-H 2026-07-29：「已接收历史」tab 已移除（功能由 per-company 对账页承担）。
// ============================================================
function readTabFromQuery(): TabName {
  const t = route.query.tab
  if (t === 'receiving') return t
  return 'sendable'
}
const activeTab = ref<TabName>(readTabFromQuery())

watch(() => route.query.tab, (q) => {
  if (q === 'sendable' || q === 'receiving') {
    activeTab.value = q
  }
})

function onTabChange(name: string | number): void {
  const n = name as TabName
  activeTab.value = n
  router.replace({ path: '/outsource/send-receive', query: { tab: n } })
}

// ============================================================
// 页级共享 lookup（customers 给两个 tab 的 filter dropdown 用；
// shelves + processes 给接收 tab 的 dialog 用）
// ============================================================
const customers = ref<Customer[]>([])
const shelves = ref<ShelfItem[]>([])
const processes = ref<Process[]>([])

async function loadLookups(): Promise<void> {
  try {
    const [cs, ss, ps] = await Promise.all([
      listCustomers(),
      listShelves({ is_active: true }),
      listProcesses({ limit: 200 }),
    ])
    customers.value = cs
    shelves.value = ss.items
    processes.value = ps.items
  } catch (e) {
    ElMessage.error((e as Error).message ?? '下拉数据加载失败')
  }
}

// ============================================================
// 跨 tab 引用：发送 tab 成功 → 触发接收 tab 刷新
// ============================================================
const sendableTabRef = ref<InstanceType<typeof OutsourceSendableTab> | null>(null)
const receivingTabRef = ref<InstanceType<typeof OutsourceReceivingTab> | null>(null)

// ============================================================
// 初始化：先拉 lookup + 拉默认 tab 数据；预拉另 tab 让数字显示在标题
// ============================================================
onMounted(async () => {
  await loadLookups()
  await sendableTabRef.value?.refresh()
  void receivingTabRef.value?.refresh()
})

// tab 切换时按需拉（避免切换瞬间列表空）
watch(activeTab, async (t) => {
  if (t === 'sendable') await sendableTabRef.value?.refresh()
  else if (t === 'receiving') await receivingTabRef.value?.refresh()
})

function onSendableTabSent(): void {
  void receivingTabRef.value?.refresh()
}
</script>

<template>
  <div class="page">
    <el-card shadow="never">
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <!-- ====================== Tab 1: 可发送 ====================== -->
        <el-tab-pane name="sendable" label="可发送">
          <OutsourceSendableTab
            ref="sendableTabRef"
            :customers="customers"
            :active="activeTab === 'sendable'"
            @sent="onSendableTabSent"
          />
        </el-tab-pane>

        <!-- ====================== Tab 2: 待接收 ====================== -->
        <el-tab-pane name="receiving" label="待接收">
          <OutsourceReceivingTab
            ref="receivingTabRef"
            :customers="customers"
            :shelves="shelves"
            :processes="processes"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<style lang="scss" scoped>
.page {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
:deep(.el-tabs__content) {
  overflow: visible;
}
:deep(.el-tab-pane) {
  padding: 12px 0 0 0;
}
</style>