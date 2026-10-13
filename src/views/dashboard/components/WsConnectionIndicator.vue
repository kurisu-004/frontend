<template>
  <el-tooltip :content="tooltipText" placement="bottom">
    <div :class="['ws-indicator', stateClass]">
      <span class="ws-dot" />
      <span class="ws-label">{{ label }}</span>
    </div>
  </el-tooltip>
</template>

<script setup lang="ts">
// 大屏 WS 连接状态指示器（2026-10-13 新增）。
//
// 为什么必须有它：dashboard 三个 query 都是 `gcTime: POSITIVE_INFINITY` + **无
// `refetchInterval`**（staleTime 只决定「下次取数放不放行」，不产生定时器），WS 又是
// 它们唯一的增量通道 —— 断连期间既没有轮询兜底、也没有补偿，直到下次 invalidate
// 之前大屏会**静默停更**。指示器把这件事显式讲给用户看。
//
// 四态而非三态：'closed' 落地时必须按 `expected` 分流。主动关闭（登出 / token 刷新
// 换连接）与真实断开在 ConnectionStatus 上是同一个值，但对 UI 含义恰好相反 ——
// 前者不该 alarming，后者必须变红。判据来自 WS 层「待关闭 socket 实例」的等值比较
// （见 api/dashboard.ts 的 expectedClosingWs），不是按 close code 猜。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onDashboardConnection } from '@/api/dashboard';
import type { DashboardConnectionState } from '@/types/dashboard';

/** 组件挂上前的默认值。onDashboardConnection 订阅即刻回放真实状态，正常路径下
 *  这个值只会存在一帧；它只是为了让初始渲染有确定输入。 */
const state = ref<DashboardConnectionState>({
  status: 'connecting',
  expected: false,
  retries: 0,
  lastError: null,
});

let offConnection: (() => void) | null = null;

const stateClass = computed(() => {
  if (state.value.status === 'open') return 'is-open';
  if (state.value.status === 'connecting') return 'is-connecting';
  return state.value.expected ? 'is-expected-closed' : 'is-disconnected';
});

const label = computed(() => {
  if (state.value.status === 'open') return '已连接';
  if (state.value.status === 'connecting') return '重连中…';
  // 主动关闭不是故障：token 刷新换连接时也会短暂经过 closed，标红会养成
  // 「无视红点」的习惯，真断线时也就没人看了。
  return state.value.expected ? '已连接' : '已断开';
});

/** 诊断信息留在 tooltip 里，header 保持干净。 */
const tooltipText = computed(() => {
  const s = state.value;
  const parts = [label.value];
  if (s.retries > 0) parts.push(`已重试 ${s.retries} 次`);
  if (s.lastError) parts.push(`close code ${s.lastError.code}`);
  if (s.lastError?.reason) parts.push(s.lastError.reason);
  return parts.join(' · ');
});

onMounted(() => {
  offConnection = onDashboardConnection((next) => {
    state.value = next;
  });
});

onBeforeUnmount(() => {
  offConnection?.();
  offConnection = null;
});
</script>

<style lang="scss" scoped>
// padding 与 UserDropdown 的 .user-info（4px 8px）对齐 —— 48px 高的 header 里，
// 两侧内边距一致才 optically 齐平。外层 MainLayout 的 .header-right 还给了 gap。
.ws-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 13px;
  color: var(--text-secondary);
  user-select: none;
  white-space: nowrap;
}

.ws-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #909399;
}

.is-open .ws-dot {
  background-color: #67c23a;
}

.is-expected-closed .ws-dot {
  background-color: #909399;
}

.is-disconnected .ws-dot {
  background-color: #f56c6c;
}

.is-disconnected .ws-label {
  color: #f56c6c;
}

// 重连中：呼吸动画（退避 1s→10s 封顶，会持续很久，静态点会被当成已连接）。
.is-connecting .ws-dot {
  background-color: #e6a23c;
  animation: ws-dot-breathe 1.2s ease-in-out infinite;
}

@keyframes ws-dot-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
</style>
