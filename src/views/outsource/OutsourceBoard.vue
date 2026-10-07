<!-- 2026-10-09 新建：外协「发送 / 接收」看板（路由 /outsource/send-receive，路径不变、
     组件硬切）。取代原「可发送 / 待接收」双表格 tab：现在是**每个外协工序一个 tab**，
     tab body = el-splitter 30/70（左可发送候选池 / 右外协公司列），发件走拖拽、回收走
     卡片右键。

     ⚠️ **tab 集合必须与工序列表 join**（`tabProcesses`）：
       `useOutsourceQueueSnapshotQuery` 的 `processes[]` 只含 `sendable + in_flight > 0`
       的工序，它只是**徽标数据源**。直接拿它当 tab 列表的话，「某工序收发清零」的瞬间
       该 tab 会凭空消失，操作到一半页面结构跳走。故行全集来自共享工序列表
       （`useProcessesQuery({ category: 'OUTSOURCE', limit: 200 })`），快照只补
       `sendable_count` / `in_flight_count` / `color` 三个字段。

     深链 `?tab=<process_id>`：`router.replace` 写入（不污染 history），工序列表解析后
     校正非法值（深链到已删除的工序 / 自产工序时不会停在一个空 tab 上）。

     「刷新」= 失效快照 + 单工序看板**两个前缀**：手动刷新的语义是「我把当前屏幕当成
     不可信」，不该只刷一半。

     板级持有三个跨容器的东西（provide + inject，见 outsourceBoardTypes.ts）：
       - `sendToCompany`：`useOutsourceQueueMove` 的**唯一**实例。公司列的拖拽落点与
         回收对话框都经它发请求 —— 同一个 useMutation 挂两个 observer 会弹两份成功 toast。
       - `openOutsourceBatchMenu`：右键菜单 opener（菜单本体是本组件的
         `<BatchContextMenu>`，teleport 到 body）。
       - `activeOutsourceProcessId`：扫码选中的作用域闸门（切过的 tab 都还挂着，多个
         候选池实例会同时收到条码事件）。 -->
<template>
  <div class="outsource-board">
    <el-alert
      v-if="moveError"
      type="error"
      :title="moveError"
      :closable="false"
      show-icon
      class="error-alert"
    />
    <div class="board-tabs">
      <el-skeleton v-if="loading" :rows="4" animated class="loading-state" />
      <el-tabs v-else v-model="activeTab" class="proc-tabs">
        <el-tab-pane v-for="p in tabProcesses" :key="p.id" :name="p.id" :lazy="true">
          <template #label>
            <span class="tab-label">
              <span class="tab-label__code" :style="p.color ? { color: p.color } : undefined">{{
                p.code
              }}</span>
              <span class="tab-label__count">({{ sendableOf(p.id) }} / {{ inFlightOf(p.id) }})</span>
            </span>
          </template>
          <ProcessBoardTab :process-id="p.id" />
        </el-tab-pane>
      </el-tabs>
      <div class="board-actions">
        <el-button :loading="refreshing" @click="onRefresh">刷新</el-button>
      </div>
    </div>

    <!-- 批次右键操作菜单（板级单例）。放在 el-tabs **之外**、根 div 的直接子级位置 ⇒
         骨架态下菜单组件也已挂载，不必等数据到位。菜单本体 teleport 到 body，与本页
         所有 Sortable 容器零 DOM 关系。
         卡片侧不包任何组件：@contextmenu.prevent 经 BatchCard 的 fallthrough attrs
         落在卡片根 div 上（包裹即破坏 Sortable 的「可拖元素 == vnode 的 DOM
         footprint」不变式，见 CLAUDE.md「拖拽投放（Sortable）」）。 -->
    <BatchContextMenu ref="batchCtxMenu" :items="ctxMenuItems" @select="onCtxMenuSelect" />

    <OutsourceReceiveDialog
      v-model="receiveVisible"
      :mode="receiveMode"
      :company-name="receiveCtx?.companyName ?? ''"
      :batch="receiveCtx?.held ?? null"
      :submitting="receiving"
      @confirm="onReceiveConfirm"
    />

    <BatchSplitDialog v-model="splitVisible" :source="splitTarget" />
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useQueryClient } from '@tanstack/vue-query';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useAuthStore } from '@/stores/auth';
import BatchContextMenu from '@/components/BatchContextMenu.vue';
import type { BatchContextMenuItem } from '@/components/BatchContextMenu.vue';
import type { BatchCardModel } from '@/types/batchCard';
import ProcessBoardTab from './components/ProcessBoardTab.vue';
import OutsourceReceiveDialog from './components/OutsourceReceiveDialog.vue';
import BatchSplitDialog from './components/BatchSplitDialog.vue';
import { useOutsourceQueueSnapshotQuery } from './composables/useOutsourceQueueSnapshotQuery';
import { invalidateOutsourceQueueProcessAll } from './composables/useOutsourceQueueProcessQuery';
import { invalidateOutsourceQueueSnapshotAll } from './composables/useOutsourceQueueSnapshotQuery';
import { useOutsourceQueueMove } from './composables/useOutsourceQueueMove';
import {
  ACTIVE_OUTSOURCE_PROCESS_ID,
  OPEN_OUTSOURCE_BATCH_MENU,
  SEND_TO_COMPANY,
  type OutsourceBatchCardContext,
  type OutsourceHeldCardContext,
  type OutsourceReceiveMode,
  type OutsourceReceiveSubmit,
  type OutsourceSplitTarget,
} from './outsourceBoardTypes';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

// 工序元数据走共享 useProcessesQuery（30s staleTime 全域去重）。显式 limit=200：工序总数
// 超 200 时外协工序会被静默截断（后端 clamp 上限 500）。
const procsQuery = useProcessesQuery({ category: 'OUTSOURCE', limit: 200 });
const snapshotQuery = useOutsourceQueueSnapshotQuery();

// 写操作 composable 在板级实例化一次（见文件头「板级持有三个跨容器的东西」）。
const { error: moveError, canMove, sendToCompany, receiveToProduction, receiveToInspection } =
  useOutsourceQueueMove();

const loading = computed(() => procsQuery.isLoading.value || snapshotQuery.isLoading.value);

/** tab 行全集 = 全部 OUTSOURCE 工序；快照只补徽标两数与工序色。 */
const tabProcesses = computed(() => {
  const byId = new Map((snapshotQuery.data.value?.processes ?? []).map((p) => [p.process_id, p]));
  return (procsQuery.data.value?.items ?? []).map((p) => {
    const s = byId.get(p.id);
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      // 工序色优先取快照（同一批数据、少一次语义分叉）；快照没这条（该工序零在途）时
      // 回落到工序列表自带的 color。
      color: s?.color ?? p.color ?? null,
      sendable: s?.sendable_count ?? 0,
      inFlight: s?.in_flight_count ?? 0,
    };
  });
});

/** tab 标题的「可发 N / 在途 M」双徽标。快照加载中显「…」，与真实的 0 区分开
 *  （loading 骨架只覆盖首屏，之后的 refetch 用占位而不是 0 —— 0 会让人以为真的收发
 *  清零）。 */
function sendableOf(pid: string): number | string {
  if (snapshotQuery.isLoading.value) return '…';
  return tabProcesses.value.find((p) => p.id === pid)?.sendable ?? 0;
}
function inFlightOf(pid: string): number | string {
  if (snapshotQuery.isLoading.value) return '…';
  return tabProcesses.value.find((p) => p.id === pid)?.inFlight ?? 0;
}

// ============================================================
// Tab 深链：?tab=<process_id>
// ============================================================
const TAB_QUERY_KEY = 'tab';

function readInitialTab(): string {
  const q = route.query[TAB_QUERY_KEY];
  if (typeof q === 'string' && q.length > 0) return q;
  return tabProcesses.value[0]?.id ?? '';
}

const activeTab = ref<string>(readInitialTab());
// replace 不污染 history（后退键不该逐个 tab 回退）。
watch(activeTab, (next) => {
  void router.replace({ query: { ...route.query, [TAB_QUERY_KEY]: next } });
});

/** 深链指向非法工序（已删除 / 自产工序）时校正到第一个 OUTSOURCE 工序。
 *  `{ immediate: true }`：从别的页面带 `?tab=` 进来时工序列表往往还没解析完，此刻
 *  list 为空、不校正，等解析完再由同一 watch 处理。 */
watch(
  () => procsQuery.data.value,
  () => {
    if (!activeTab.value) {
      activeTab.value = tabProcesses.value[0]?.id ?? '';
      return;
    }
    if (!tabProcesses.value.some((p) => p.id === activeTab.value)) {
      activeTab.value = tabProcesses.value[0]?.id ?? '';
    }
  },
  { immediate: true },
);

// ============================================================
// provide：投放容器 / 右键菜单 / 扫码作用域
// ============================================================
provide(SEND_TO_COMPANY, sendToCompany);
// 扫码作用域闸门给的是 computed（不是 activeTab 本体）：候选池实例读它时不必知道
// 板级的 ref 形态，且类型与 inject 侧的 ComputedRef<string> 对齐。
provide<ComputedRef<string>>(ACTIVE_OUTSOURCE_PROCESS_ID, computed(() => activeTab.value));

const batchCtxMenu = ref<InstanceType<typeof BatchContextMenu> | null>(null);
/** 菜单打开时那张卡的上下文（`BatchContextMenu` 的 select 只给 (key, batch)，
 *  容器信息必须由 opener 侧记住）。 */
const menuCtx = ref<OutsourceBatchCardContext | null>(null);

/** 菜单项按**容器 + 角色**逐项过滤，不是「一次性闸」：
 *   - 回收生产 / 回收品检：后端 move 的 `require_any_role([Manager, Clerk, Inspector])`
 *     —— 三类角色都能收发，缺一个用户点了吃 40300；
 *   - 拆分批次：角色 MANAGER + CLERK（Inspector 能收发但**不能拆批**），多放一个角色
 *     会让用户点了才知道没权限。
 *  key 与后端动作名对齐，便于对账；分发方是下面的 onCtxMenuSelect。 */
const ctxMenuItems = computed<BatchContextMenuItem[]>(() => {
  if (menuCtx.value === null) return [];
  const canSplit = auth.hasRole('MANAGER') || auth.hasRole('CLERK');
  if (menuCtx.value.kind === 'candidate') {
    return canSplit ? [{ key: 'split', label: '拆分批次' }] : [];
  }
  const items: BatchContextMenuItem[] = [];
  if (canMove.value) {
    items.push({ key: 'receive-production', label: '回收生产' });
    items.push({ key: 'receive-inspection', label: '回收品检' });
  }
  if (canSplit) items.push({ key: 'split', label: '拆分批次' });
  return items;
});

function onCardContextMenu(evt: MouseEvent, batch: BatchCardModel, ctx: OutsourceBatchCardContext) {
  menuCtx.value = ctx;
  batchCtxMenu.value?.open(evt, batch);
}
provide(OPEN_OUTSOURCE_BATCH_MENU, onCardContextMenu);

// ============================================================
// 回收对话框（右键触发，非拖拽）
// ============================================================
const receiveVisible = ref(false);
const receiveMode = ref<OutsourceReceiveMode>('production');
const receiveCtx = ref<OutsourceHeldCardContext | null>(null);
const receiving = ref(false);

const splitVisible = ref(false);
const splitTarget = ref<OutsourceSplitTarget | null>(null);

function onCtxMenuSelect(key: string, batch: BatchCardModel): void {
  const ctx = menuCtx.value;
  menuCtx.value = null;
  if (!ctx) return;
  if (key === 'split') {
    // 拆批的 version 是后端必填的 OCC 锚（缺它返 HTTP 422 纯文本）。卡片 model 上它是
    // 可选字段，守卫用 typeof + isFinite 两条而不是只看 isFinite（`undefined` 同样
    // 过不了 isFinite，但显式 typeof 让类型收窄与运行时判据对齐）。
    if (typeof batch.version !== 'number' || !Number.isFinite(batch.version)) {
      ElMessage.warning('批次版本信息缺失，无法拆分');
      return;
    }
    splitTarget.value = {
      batch_id: batch.batch_id,
      version: batch.version,
      quantity: batch.quantity,
      batch_no: batch.batch_no,
      part_name: batch.part_name,
    };
    splitVisible.value = true;
    return;
  }
  if (ctx.kind !== 'held') return;
  receiveCtx.value = ctx;
  receiveMode.value = key === 'receive-production' ? 'production' : 'inspection';
  receiveVisible.value = true;
}

async function onReceiveConfirm(payload: OutsourceReceiveSubmit): Promise<void> {
  const ctx = receiveCtx.value;
  if (!ctx) return;
  receiving.value = true;
  const ok =
    receiveMode.value === 'production'
      ? await receiveToProduction({
          companyId: ctx.companyId,
          batch: ctx.held,
          toShelfId: payload.toShelfId,
          nextProcessId: payload.nextProcessId ?? null,
        })
      : await receiveToInspection({
          companyId: ctx.companyId,
          batch: ctx.held,
          toShelfId: payload.toShelfId,
        });
  receiving.value = false;
  // 成功才关：失败保持打开、保留已选货架/工序，用户改一下就能重试。
  if (ok) receiveVisible.value = false;
}

// ============================================================
// 刷新
// ============================================================
const refreshing = ref(false);

/** 失效快照 + 单工序看板两个前缀（全失效，不做精确筛选：手动刷新是「我把当前屏幕当成
 *  不可信」的语义）。 */
async function onRefresh(): Promise<void> {
  refreshing.value = true;
  try {
    await invalidateOutsourceQueueSnapshotAll(qc);
    await invalidateOutsourceQueueProcessAll(qc);
    ElMessage.success('已刷新');
  } finally {
    refreshing.value = false;
  }
}
</script>

<style scoped>
.outsource-board {
  padding: 0 16px 16px;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.error-alert {
  margin-bottom: 16px;
}
/* Tab 行上移 + 去掉 EP 默认下划线，让 tab 行视觉承接顶部边线。与生产队列域 QueueBoard
   同款。 */
.board-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.proc-tabs {
  margin: 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex: 1;
  min-height: 0;
}
/* .el-tabs__content 自带 padding:15px，min-height:0 让内部 el-tab-pane 可以收缩，
   否则 height:100% 会在内容盒上加 padding 溢出。 */
.proc-tabs :deep(.el-tabs__content) {
  min-height: 0;
}
.proc-tabs :deep(.el-tab-pane) {
  height: 100%;
}
.proc-tabs :deep(.el-tabs__nav-wrap)::after {
  background: transparent;
}
.proc-tabs :deep(.el-tabs__header) {
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.loading-state {
  padding: 40px;
}
.board-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
.tab-label {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.tab-label__code {
  font-weight: 600;
}
.tab-label__count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
</style>