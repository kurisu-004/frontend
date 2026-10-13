<template>
  <Teleport to="body">
    <div class="scan-banner-stack" aria-live="polite">
      <transition-group name="scan-banner">
        <div
          v-for="item in items"
          :key="item.key"
          :class="['scan-banner', `is-${item.action.toLowerCase().replace('_', '-')}`]"
          @mouseenter="pauseTimer(item.key)"
          @mouseleave="resumeTimer(item.key)"
        >
          <span class="scan-banner-text">{{ item.text }}</span>
          <el-button link class="scan-banner-close" @click="dismiss(item.key)">
            <el-icon :size="14"><Close /></el-icon>
          </el-button>
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// 报工台业务事件条（2026-10-13 新增，消费 SCAN_BANNER 事件）。
//
// 数据来源只有一个：`onDashboardEvent` 里 `event_type === 'SCAN_BANNER'` 的帧。
// dashboard 域约 40 个事件里，**只有 SCAN_BANNER 的 payload 带展示字段**（6 键，
// 守门 schema 在 composables/bannerSchema.ts）；其余事件的 payload 全是 id / 计数，
// 本组件一律不消费 —— 这正是旧横幅每条事件都弹一条垃圾文案的原因。
//
// 为什么守门写在组件里而不是 api 层：SCAN_BANNER 走的是**推送通道**，既没有 queryFn
// 承载，也不是 api 层的函数调用，WS 层只负责把帧原样 fan-out。守门点是 `onEvent`
// 里的 `safeParse` —— 一条坏事件丢弃 + warn，绝不让异常冒泡把整条订阅链带走
// （dispatch() 里虽有一层 try/catch，但那样会静默吞掉整条事件，连日志都没有）。
import { onBeforeUnmount, ref } from 'vue';
import { Close } from '@element-plus/icons-vue';
import { onDashboardEvent } from '@/api/dashboard';
import type { DashboardEvent } from '@/types/dashboard';
import {
  scanBannerItemSchema,
  type ScanBannerItemData,
} from '@/views/dashboard/composables/bannerSchema';

/** 同时最多堆叠几条；多的从尾部挤掉。 */
const MAX_VISIBLE = 3;
/** 自动消失毫秒数。 */
const AUTO_DISMISS_MS = 4000;

/** 动作词。key 与 `scanBannerItemSchema` 的 action 枚举逐字对齐。 */
const ACTION_TEXT: Record<ScanBannerItemData['action'], string> = {
  PICKED_UP: '领取',
  RETURNED: '放回',
  INSPECTED: '送检',
};

interface BannerItem {
  key: number;
  /** 保留动作用于挑左侧竖条的语义色；文案已组装好，不再回头读 payload。 */
  action: ScanBannerItemData['action'];
  text: string;
}

const items = ref<BannerItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let seq = 0;

function scheduleDismiss(key: number): void {
  clearTimer(key);
  timers.set(
    key,
    setTimeout(() => dismiss(key), AUTO_DISMISS_MS),
  );
}

function clearTimer(key: number): void {
  const t = timers.get(key);
  if (t) {
    clearTimeout(t);
    timers.delete(key);
  }
}

function pauseTimer(key: number): void {
  clearTimer(key);
}

function resumeTimer(key: number): void {
  // 已消失的条目不复活定时器（用户可能在停留期间看着它被移走）。
  if (items.value.some((i) => i.key === key)) scheduleDismiss(key);
}

function dismiss(key: number): void {
  clearTimer(key);
  items.value = items.value.filter((i) => i.key !== key);
}

/** 系统交期取 `M-DD`。后端是 `Option<NaiveDate>` ⇒ 恒为 `YYYY-MM-DD` 或 `null`；
 *  这里按「只取第 6~10 位」而不是按格式解析，所以带时刻的漂移形态
 *  （`2026-10-27T00:00:00`）同样能正确降级。
 *  空值 / 空串一律返回 null，由调用方连括号一起省略。 */
function monthDay(date: string | null): string | null {
  if (!date || date.length < 10) return null;
  return date.slice(5, 10);
}

function composeText(item: ScanBannerItemData): string {
  // 序列号兜底图纸号：终态工单的 serial_no 是 NULL，而事件是在动作发生的**那一刻**
  // 推的 —— 那时工单多半还没进终态，但也不能假设一定有值。
  const subject = item.serial_no ?? item.drawing_no;
  const delivery = monthDay(item.system_delivery_date);
  const suffix = delivery ? ` (${delivery})` : '';
  return `${item.worker_name}${ACTION_TEXT[item.action]} ${subject} x ${item.quantity}${suffix}`;
}

function push(item: ScanBannerItemData): void {
  const key = ++seq;
  const next = [{ key, action: item.action, text: composeText(item) }, ...items.value].slice(
    0,
    MAX_VISIBLE,
  );
  // 溢出被挤掉的那一条：连它的定时器一起清。不清的话它仍会在 4s 内到点触发一次
  // dismiss()（filter 无匹配，空操作），每条溢出泄漏一个定时器。
  for (const dropped of items.value) {
    if (!next.some((i) => i.key === dropped.key)) clearTimer(dropped.key);
  }
  items.value = next;
  scheduleDismiss(key);
}

function onEvent(ev: DashboardEvent): void {
  if (ev.event_type !== 'SCAN_BANNER') return;
  const parsed = scanBannerItemSchema.safeParse(ev.data);
  if (!parsed.success) {
    console.warn('[ScanBanner] 丢弃不合契约的 SCAN_BANNER 事件', parsed.error.issues);
    return;
  }
  push(parsed.data);
}

// 订阅在 setup 里建立（**不挂 onMounted**）：与同域既有范式 `useDashboardInvalidation`
// 一致，且挂载期订阅会留一个 tick 的漏收窗口。退订仍在 onBeforeUnmount
// （组件根是 Teleport，卸载时订阅与定时器必须一起清）。
const offEvent = onDashboardEvent(onEvent);

onBeforeUnmount(() => {
  offEvent();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
});
</script>

<style lang="scss" scoped>
// 右下角浮层。**bottom: 72px 不是随手取的数**：列表页的分页器（components/PagedTable.vue
// 的 .pagination）是右对齐的，恰好落在页面右下角；贴底（24px）会盖住「下一页」按钮
// 4 秒。72px 留出分页条高度 + 呼吸空间。
.scan-banner-stack {
  position: fixed;
  right: 24px;
  bottom: 72px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: 400px;
}

.scan-banner {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--white);
  border: 1px solid var(--border-color);
  border-left: 4px solid var(--primary-color);
  border-radius: 6px;
  box-shadow: var(--shadow-md);
  min-width: 300px;
}

.scan-banner-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
}

// 语义色走类绑定（`:class="\`is-${item.action.toLowerCase().replace('_','-')}\`"`），
// **不走模板 inline :style** —— inline 优先于任何非 !important 规则，会盖掉后面任何
// 按状态改 border-color 的规则（同仓 BatchCard / PartRowCard 踩过这个坑）。
// 下划线折成连字符：`toLowerCase()` 直出会得到 `is-picked_up`，与全仓其它语义色类
// （`is-urgent` / `is-open` / `is-disconnected`）的 kebab-case 口径不一致。
.is-picked-up {
  border-left-color: var(--primary-color);
}
.is-returned {
  border-left-color: #67c23a;
}
.is-inspected {
  border-left-color: #409eff;
}

.scan-banner-close {
  flex-shrink: 0;
  padding: 2px;
  color: var(--text-secondary);

  &:hover {
    color: var(--text-primary);
  }
}

// 入场方向与浮层位置对齐：贴右下角的层从**下**方滑入（translateY）。
.scan-banner-enter-active,
.scan-banner-leave-active {
  transition: all 0.25s ease;
}
.scan-banner-enter-from,
.scan-banner-leave-to {
  opacity: 0;
  transform: translateY(20px);
}
.scan-banner-move {
  transition: transform 0.25s ease;
}
</style>
