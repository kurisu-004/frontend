<!--
  HeldPartsBadge.vue

  扫码台「已持有 N 件」徽章卡 + 右侧抽屉（2026-07-17 改造）。

  行为：
  - 顶栏触发按钮：「已持有 N 件」(N = 已加载条数；N=0 时灰色；N>=1 时主色 + 计数 badge)。
    2026-10-04：列表端点返回分页信封，N 取 `.items.length`（已加载），抽屉里另标
    「共 M 件」= 信封 total；两者不等即表示受后端 limit 截断（不再谎称是全部）。
  - 点击打开 el-drawer（右侧 rtl，size=400px），列出当前 worker 持有件
  - 监听 useScanBus 的 heldVersion：领取/放回/送检后自动刷新
  - autoOpenOnChange=true 时：持有件变化后自动打开 drawer，让工人确认领取结果

  入参：
  - workerId: 雪花 ID 字符串（来自 useScanSession.worker.value.id）
  - maxListHeight: drawer 内列表最大高度（默认 calc(100vh - 200px)）
  - autoOpenOnChange: 持有件变化后是否自动打开 drawer（默认 false）
-->

<template>
  <el-button
    :type="count > 0 ? 'warning' : 'info'"
    :plain="count === 0"
    :disabled="!workerId"
    @click="drawerVisible = true"
  >
    <el-icon><Box /></el-icon>
    <span>已持有</span>
    <el-badge v-if="count > 0" :value="count" :max="99" class="count-badge" type="danger" />
    <span v-else class="muted-inline">0 件</span>
  </el-button>

  <el-drawer
    v-model="drawerVisible"
    direction="rtl"
    size="400px"
    title="我的持有零件"
    :with-header="true"
    :append-to-body="true"
    :destroy-on-close="false"
    @open="onOpen"
  >
    <div class="held-card">
      <div class="held-header">
        <span class="held-subtitle">
          <el-icon><User /></el-icon>
          <span>{{ workerId ? '当前工人' : '未识别' }}</span>
          <span class="held-count-inline"
            >已加载 {{ count }} 件<template v-if="total > count"
              >（共 {{ total }} 件）</template
            ></span
          >
        </span>
        <el-button size="small" link :loading="loading" @click="fetchHeld">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </div>

      <div v-if="loading && parts.length === 0" class="held-loading">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>加载中…</span>
      </div>

      <div v-else-if="errorMsg" class="held-error">
        <el-icon color="#f56c6c"><WarningFilled /></el-icon>
        <span>{{ errorMsg }}</span>
      </div>

      <div v-else-if="parts.length === 0" class="held-empty">
        <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
        <p>暂未持有零件</p>
        <p class="held-empty-hint">领取后会出现在这里</p>
      </div>

      <div v-else class="held-list" :style="{ maxHeight: maxListHeight }">
        <div v-for="p in parts" :key="p.id" :class="['held-row', { 'is-urgent': p.is_urgent }]">
          <div class="held-row-main">
            <span class="held-serial">{{ p.serial_no || '—' }}</span>
            <span class="held-drawing">{{ p.drawing_no }}</span>
          </div>
          <div class="held-row-name">{{ p.name }}</div>
          <!-- 2026-10-04：本行 VO 是后端 PartListItem，没有 next_process_name /
               shelf_code 键（后端列表刻意不返 next_process_id，也没有货架码派生），
               「下一工序 / 货架」两个 tag 恒不显示、「未选工序」恒显示，是假话 ⇒ 删除。
               加急是本行唯一还有意义的副信息，没有它时整块不渲染。 -->
          <div v-if="p.is_urgent" class="held-row-sub">
            <span class="urgent-tag">加急</span>
          </div>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
/**
 * 用法：
 * - 仅手动按钮打开：
 *   <HeldPartsBadge :worker-id="String(worker.id)" />
 * - 领取/放回后自动弹出让工人确认：
 *   <HeldPartsBadge :worker-id="String(worker.id)" :auto-open-on-change="true" />
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Box, Loading, Refresh, User, WarningFilled } from '@element-plus/icons-vue';
import { listPartsHeldByWorker } from '@/api/parts';
import type { ScanPartRowSchema } from '@/composables/queries/schemas';
import { useScanBus } from '@/views/scan/composables/useScanBus';
import { scanListErrorText } from '@/views/scan/composables/scanListErrorMessage';

const props = withDefaults(
  defineProps<{
    workerId: string;
    maxListHeight?: string;
    /** 持有件变化后是否自动打开 drawer（让工人确认领取/放回结果） */
    autoOpenOnChange?: boolean;
  }>(),
  {
    maxListHeight: 'calc(100vh - 200px)',
    autoOpenOnChange: false,
  },
);

const { onHeldChanged } = useScanBus();

const drawerVisible = ref(false);
const parts = ref<ScanPartRowSchema[]>([]);
// 后端信封里的总条数；count 是「已加载」的条数，两者不等说明列表被 limit 截断
const total = ref(0);
const loading = ref(false);
const errorMsg = ref<string | null>(null);
let offBus: (() => void) | null = null;

const count = computed(() => parts.value.length);

async function fetchHeld(): Promise<void> {
  if (!props.workerId) return;
  loading.value = true;
  errorMsg.value = null;
  try {
    // 2026-10-04：端点返回分页信封，取 `.items`；显式传 limit=200（后端 clamp
    // 上限）取全 —— 不传时后端默认只返 50 条，徽章计数会静默少报。
    const res = await listPartsHeldByWorker(props.workerId, { limit: 200 });
    parts.value = res.items;
    total.value = res.total;
  } catch (e) {
    errorMsg.value = scanListErrorText(e, '加载失败');
    parts.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function onOpen(): void {
  // 每次打开都重新拉一次（最新数据）
  void fetchHeld();
}

onMounted(() => {
  // 初次拉一次（即便不打开 drawer 也有数据驱动徽章计数）
  void fetchHeld();
  // 监听持有件变化（PICK_UP / RETURN / INSPECT 提交后）
  offBus = onHeldChanged(async () => {
    await fetchHeld();
    // 自动打开 drawer：让工人看到刚领取/放回后的最新持有列表
    if (props.autoOpenOnChange) {
      drawerVisible.value = true;
    }
  });
});

onUnmounted(() => {
  if (offBus) {
    offBus();
    offBus = null;
  }
});

// workerId 变更时重新拉
watch(
  () => props.workerId,
  () => {
    void fetchHeld();
  },
);
</script>

<style scoped>
.held-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 4px;
}
.held-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.held-subtitle {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #606266;
  font-size: 13px;
}
.held-count-inline {
  margin-left: 6px;
  padding: 2px 8px;
  background: #ecf5ff;
  color: #409eff;
  border-radius: 10px;
  font-weight: 600;
}
.held-loading,
.held-error,
.held-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 32px 8px;
  color: #909399;
  font-size: 13px;
  text-align: center;
}
.held-error {
  color: #f56c6c;
}
.held-empty-hint {
  font-size: 12px;
  color: #c0c4cc;
  margin: 0;
}
.held-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding-right: 4px;
}
.held-row {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 10px 12px;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.held-row.is-urgent {
  background: #fdf6ec;
  border-color: #f9d77e;
}
.held-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.held-serial {
  font-weight: 600;
  color: #303133;
  min-width: 72px;
}
.held-drawing {
  color: #606266;
}
.held-row-name {
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.held-row-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
.urgent-tag {
  color: #e6a23c;
  font-weight: 600;
  font-size: 12px;
}
.muted-inline {
  color: #909399;
  margin-left: 2px;
}
.count-badge {
  margin-left: 4px;
}
</style>
