<script setup lang="ts">
// DeliveryNoteScan — 扫码建单页面（v2，按设计文档 D3 自动路由）
// 2026-08-21 v2 扫码建单：扫序列号 → 后端解析 L1 → find-or-create DRAFT → 返回落点。
// 一次扫码只调一次 POST /api/v2/delivery-notes/scan，不在前端做 note picker / customer picker。
//
// 复用：
//   - useBarcodeScanner 单例（自带输入框焦点抑制；本页面订阅 onScan(onMounted 挂 / onBeforeUnmount 解）
//   - .scan-row 样式抄 OutsourceSendReceive.vue 浅蓝条
//   - ElMessage.success/warning/error 统一 toast（项目不用 ElNotification）
//
// el-* 组件靠 unplugin-vue-components 自动注册；本文件只需显式 import 业务依赖。

import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Promotion } from '@element-plus/icons-vue'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import { scanDelivery } from '@/api/deliveryNote'
import { ApiError } from '@/api/http'
import type { ScanDeliveryOut, ScanNoteSummary } from '@/types/deliveryNote'

/**
 * 日志条目 union：先 push pending 行（乐观插入），接口返回后再 splice 替换为终态。
 * 终态分五类：added / already / rejected / unknown / error — 与状态颜色一一对应。
 */
type ScanLogEntry =
  | { id: string; status: 'pending'; code: string; at: number }
  | {
      id: string
      status: 'added' | 'already' | 'rejected' | 'unknown' | 'error'
      code: string
      serial_no: string | null
      name: string | null
      message: string
      note_no: string | null
      at: number
    }

const router = useRouter()
const scanInput = ref('')
const scanning = ref(false)
/** 1.5s 同码防抖：双击 Enter / 扫码枪连扫容错（设计文档 §5 防抖策略） */
const lastScanCode = ref('')
const lastScanAt = ref(0)
/** 当前跟随后端的 DRAFT 草稿；切换 L1 / scope 时后端会路由到新草稿，前端卡片同步刷新 */
const activeDraft = ref<ScanNoteSummary | null>(null)
/** 扫码日志（新→旧），最多 100 条 */
const log = ref<ScanLogEntry[]>([])
/** 输入框 ref（手动聚焦） */
const scanInputRef = ref<{ focus: () => void } | null>(null)

const { onScan } = useBarcodeScanner()
let unsubScan: (() => void) | null = null

/** 浏览器基线兜底（与 PartBatchNew.vue makeUid 同款）。 */
function nextId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ============ 提交入口 ============

/** 手动输入框回车 / 点按钮：拉出原值 → 清空 → 触发处理 */
async function onSubmit(): Promise<void> {
  const raw = scanInput.value
  scanInput.value = ''
  await handleScan(raw)
}

/**
 * 单次扫码处理全流程：
 *   1) trim + 长度校验（设计文档 §5 入参 1..=64）
 *   2) inflight / 1.5s 同码 防抖
 *   3) 乐观插入 pending 日志
 *   4) await scanDelivery → applySuccess / applyError
 *   5) finally 强制重新聚焦输入框
 */
async function handleScan(rawCode: string): Promise<void> {
  const code = rawCode.trim()

  // 1) 客户端格式校验
  if (code.length < 1 || code.length > 64) {
    const entry: ScanLogEntry = {
      id: nextId(),
      status: 'rejected',
      code,
      serial_no: null,
      name: null,
      message: '条码格式不正确',
      note_no: null,
      at: Date.now(),
    }
    log.value.unshift(entry)
    trimLog()
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

  // 3) 乐观插入 pending 行
  const pendingId = nextId()
  const pending: ScanLogEntry = { id: pendingId, status: 'pending', code, at: Date.now() }
  log.value.unshift(pending)
  trimLog()

  scanning.value = true
  try {
    const out = await scanDelivery(code)
    applySuccess(pendingId, out)
  } catch (e) {
    applyError(pendingId, code, e)
  } finally {
    scanning.value = false
    await nextTick()
    scanInputRef.value?.focus()
  }
}

// ============ 终态分支 ============

/** 成功：splice pending → 替换 added / already；刷新顶部草稿卡；toast 成功/重复 */
function applySuccess(pendingId: string, out: ScanDeliveryOut): void {
  const entry: ScanLogEntry = {
    id: pendingId,
    status: out.outcome === 'ADDED' ? 'added' : 'already',
    code: out.resolved.serial_no,
    serial_no: out.resolved.serial_no,
    name: out.resolved.name,
    message: out.message,
    note_no: out.note.delivery_note_no,
    at: Date.now(),
  }
  const idx = log.value.findIndex((l) => l.id === pendingId)
  if (idx >= 0) log.value.splice(idx, 1, entry)
  else log.value.unshift(entry)
  trimLog()

  // 切 L1 / scope 时后端会路由到新草稿；前端卡片跟随
  activeDraft.value = out.note
  if (out.outcome === 'ADDED') {
    ElMessage.success(`已加入 ${out.resolved.serial_no} → ${out.note.delivery_note_no}`)
  } else {
    ElMessage.warning(`${out.resolved.serial_no} 已在 ${out.note.delivery_note_no} 上`)
  }
}

/**
 * 失败：按 ApiError.code 分流（设计文档 §7 错误码）
 *   21417 → unknown  (404 条码未命中)
 *   21418 / 21416 / 21405 / 21406 → rejected
 *   其他 → error（网络错 / 5xx 等）
 * 错误也写入日志——回溯时能看到所有尝试，不掩盖失败。
 */
function applyError(pendingId: string, code: string, e: unknown): void {
  let status: 'unknown' | 'rejected' | 'error' = 'error'
  let message = (e as Error)?.message ?? '扫码失败'
  if (e instanceof ApiError) {
    switch (e.code) {
      case 21417:
        status = 'unknown'
        break
      case 21418: // 装配件整套未齐（含 per-child 明细）
      case 21416: // 范围不匹配
      case 21405: // parts status 不允许
      case 21406: // 已在其他 active 单
        status = 'rejected'
        break
      default:
        status = 'error'
    }
    message = e.message || message
  }
  const entry: ScanLogEntry = {
    id: pendingId,
    status,
    code,
    serial_no: null,
    name: null,
    message,
    note_no: null,
    at: Date.now(),
  }
  const idx = log.value.findIndex((l) => l.id === pendingId)
  if (idx >= 0) log.value.splice(idx, 1, entry)
  else log.value.unshift(entry)
  trimLog()
  ElMessage.error(message)
}

// ============ 辅助 ============

/** 日志上限 100 条：超出按时间窗新→旧保留前 100 */
function trimLog(): void {
  if (log.value.length > 100) log.value = log.value.slice(0, 100)
}

/** 取 status 字段单独入参：el-table 的 row 默认是 DefaultRow 联合宽松类型，不直接传整个 row */
type ScanLogStatus = ScanLogEntry['status']

function statusLabel(status: ScanLogStatus): string {
  switch (status) {
    case 'pending':  return '处理中'
    case 'added':    return '已加入'
    case 'already':  return '已存在'
    case 'unknown':  return '条码未知'
    case 'rejected': return '被拒绝'
    case 'error':    return '错误'
  }
}

function statusTagType(status: ScanLogStatus): 'success' | 'info' | 'warning' | 'danger' {
  switch (status) {
    case 'added':    return 'success'
    case 'already':  return 'info'
    case 'pending':  return 'warning'
    case 'unknown':
    case 'rejected':
    case 'error':    return 'danger'
  }
}

function formatTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function openDetail(): void {
  if (!activeDraft.value) return
  void router.push(`/delivery-notes/${activeDraft.value.id}`)
}

function onScanInputClear(): void {
  scanInput.value = ''
}

// ============ 生命周期 ============

onMounted(() => {
  // 扫码枪订阅：每页独立挂载；卸载时退订避免劫持到其他页
  unsubScan = onScan((code) => { void handleScan(code) })
  // 进入页后自动聚焦输入框，等 DOM 完成 nextTick 再 focus
  void nextTick().then(() => scanInputRef.value?.focus())
})

onBeforeUnmount(() => {
  unsubScan?.()
  unsubScan = null
})
</script>

<template>
  <div class="page">
    <!-- ========== 顶部：当前草稿 ========== -->
    <el-card shadow="never">
      <template #header>
        <span class="dn-scan-card-title">当前草稿</span>
      </template>
      <el-empty
        v-if="!activeDraft"
        description="请扫码开始建单"
        :image-size="80"
      />
      <div v-else class="dn-scan-active">
        <div class="row">
          <span class="lbl">单号</span>
          <span class="val">{{ activeDraft.delivery_note_no }}</span>
          <el-tag size="small" type="info" effect="plain">
            {{ activeDraft.scope_label }}
          </el-tag>
        </div>
        <div class="row">
          <span class="lbl">客户</span>
          <span class="val">{{ activeDraft.customer_path || '—' }}</span>
        </div>
        <div class="row">
          <span class="lbl">零件数</span>
          <span class="val">{{ activeDraft.part_count }}</span>
        </div>
        <div class="actions">
          <el-button link type="primary" @click="openDetail">查看单据详情</el-button>
        </div>
      </div>
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

    <!-- ========== 底部：扫码日志 ========== -->
    <el-card shadow="never">
      <template #header>
        <div class="dn-scan-log-header">
          <span class="dn-scan-card-title">扫码日志</span>
          <el-button
            v-if="log.length"
            link
            size="small"
            @click="log = []"
          >
            清空日志
          </el-button>
        </div>
      </template>
      <el-table
        :data="log"
        stripe
        size="small"
        max-height="480"
        empty-text="还没有扫码记录 — 扫码或手动输入序列号开始"
      >
        <el-table-column label="时间" width="170" align="center">
          <template #default="{ row }">{{ formatTime(row.at) }}</template>
        </el-table-column>
        <el-table-column prop="code" label="条码" width="160" align="center" />
        <el-table-column label="名称" min-width="140" align="center">
          <template #default="{ row }">
            <span :class="{ muted: !row.name }">{{ row.name ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="90" align="center">
          <template #default="{ row }">
            <el-tag
              :type="statusTagType((row as ScanLogEntry).status)"
              effect="plain"
              size="small"
            >
              {{ statusLabel((row as ScanLogEntry).status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="落点单" width="160" align="center">
          <template #default="{ row }">
            <span :class="{ muted: !row.note_no }">{{ row.note_no ?? '—' }}</span>
          </template>
        </el-table-column>
        <!-- 关键：21418 失败消息含 per-child 多行明细，必须保留换行（ElMessage 不渲染 \n 是已知坑） -->
        <el-table-column label="消息" min-width="240">
          <template #default="{ row }">
            <div style="white-space: pre-line">{{ row.message ?? '' }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
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

/* 顶部「当前草稿」非空态：lbl/val 对齐网格（与列表页详情卡视觉一致） */
.dn-scan-active {
  display: grid;
  gap: 6px;
}
.dn-scan-active .row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dn-scan-active .lbl {
  color: var(--text-secondary, #909399);
  min-width: 60px;
}
.dn-scan-active .val {
  color: var(--text-primary, #303133);
}
.dn-scan-active .actions {
  margin-top: 4px;
}

/* 预留：与脚本里 ElMessage.error 双轨提示的视觉样式 */
.dn-scan-error {
  color: var(--el-color-danger);
  font-size: 13px;
}

/* 日志卡 header：标题左 + 清空按钮右 */
.dn-scan-log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 扫码输入条：与 OutsourceSendReceive.vue 浅蓝条风格一致 #eaf2fb / #d9ecff */
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

/* 日志中占位符 — em 虚化处理 */
.muted {
  color: var(--el-text-color-secondary);
}
</style>
