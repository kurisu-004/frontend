<!-- 2026-10-09 新建：外协「发送 / 接收」看板（路由 /outsource/send-receive，路径不变、
     组件硬切）。取代原「可发送 / 待接收」双表格 tab：现在是**每个外协工序一个 tab**，
     tab body = el-splitter 30/70（左可发送候选池 / 右外协公司列），发件走拖拽、回收与
     收发 / 拆分走卡片右键。

     ⚠️ **tab 集合必须与工序列表 join**（`tabProcesses`）：
       `useOutsourceQueueSnapshotQuery` 的 `processes[]` 只含 `sendable + in_flight > 0`
       的工序，它只是**徽标数据源**。直接拿它当 tab 列表的话，「某工序收发清零」的瞬间
       该 tab 会凭空消失，操作到一半页面结构跳走。故行全集来自共享工序列表
       （`useProcessesQuery({ category: 'OUTSOURCE', limit: 200 })`），快照只补
       `sendable_count` / `in_flight_count` / `color` 三个字段；快照里
       **`category` 非 OUTSOURCE** 的工序（批次在外协公司、`current_process_id` 指向
       INHOUSE 工序）另行补行，否则这批在途批次在看板上彻底不可见。

     深链 `?tab=<process_id>`：`router.replace` 写入（不污染 history），工序列表解析后
     校正非法值（深链到已删除的工序 / 自产工序时不会停在一个空 tab 上）。

     「刷新」= 失效快照 + 单工序看板**两个前缀**：手动刷新的语义是「我把当前屏幕当成
     不可信」，不该只刷一半。

板级持有三个跨容器的东西（provide + inject，见 outsourceBoardTypes.ts）：
        - `sendToCompany`：`useOutsourceQueueMove` 的**唯一**实例。公司列的拖拽落点与
          候选池右键菜单的「发送到外协公司」都经它发请求 —— 同一个 useMutation 挂两个
          observer 会弹两份成功 toast。
        - `openOutsourceBatchMenu`：右键 opener（菜单本体是
          `@/composables/useBatchContextMenu.ts` 的 `showBatchContextMenu()`，挂在 body 级
          单例容器上）。
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

    <OutsourceReceiveDialog
      v-model="receiveVisible"
      :mode="receiveMode"
      :company-name="receiveCtx?.companyName ?? ''"
      :batch="receiveCtx?.held ?? null"
      :submitting="receiving"
      @confirm="onReceiveConfirm"
    />

    <!-- 拆批对话框（共享组件，局部 import，与 BatchCard 同款）。放在 el-tabs **之外**、
         根 div 的直接子级位置 ⇒ 骨架态下也已挂载。**失效编排在板级**：对话框只发
         `done`，由 onSplitDone 失效外协看板两域（生产队列那边要失效的是另外三个域，
         对话框 import 任一方的失效函数都会锁死单域消费方）。 -->
    <BatchSplitDialog v-model="splitVisible" :source="splitTarget" @done="onSplitDone" />
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useQueryClient } from '@tanstack/vue-query';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { qk } from '@/composables/queries/keys';
import { useAuthStore } from '@/stores/auth';
import { showBatchContextMenu } from '@/composables/useBatchContextMenu';
import type { BatchCardModel } from '@/types/batchCard';
import type { BatchSplitSource } from '@/types/batchSplit';
import ProcessBoardTab from './components/ProcessBoardTab.vue';
import OutsourceReceiveDialog from './components/OutsourceReceiveDialog.vue';
import BatchSplitDialog from '@/components/BatchSplitDialog.vue';
import { useQueueRecall } from '@/views/production/queue/composables/useQueueRecall';
import { useOutsourceQueueSnapshotQuery } from './composables/useOutsourceQueueSnapshotQuery';
import { invalidateOutsourceQueueProcessAll } from './composables/useOutsourceQueueProcessQuery';
import { invalidateOutsourceQueueSnapshotAll } from './composables/useOutsourceQueueSnapshotQuery';
import { useOutsourceQueueMove } from './composables/useOutsourceQueueMove';
import {
  buildOutsourceBatchMenuItems,
  type OutsourceMenuCompany,
} from './composables/outsourceBatchMenuItems';
import type { OutsourceQueueCompanyData } from './composables/outsourceQueueSchema';
import {
  ACTIVE_OUTSOURCE_PROCESS_ID,
  OPEN_OUTSOURCE_BATCH_MENU,
  SEND_TO_COMPANY,
  isCandidateDraggable,
  type OpenOutsourceBatchMenu,
  type OutsourceHeldCardContext,
  type OutsourceReceiveMode,
  type OutsourceReceiveSubmit,
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
// 候选池右键「召回到待下发」复用生产队列域的召回 composable（跨域端点，本页不另写一份）。
const recall = useQueueRecall();

const loading = computed(() => procsQuery.isLoading.value || snapshotQuery.isLoading.value);

/** tab 行全集 = 全部 OUTSOURCE 工序 ∪ 快照里 `category` 非 OUTSOURCE 的那些工序。
 *
 *  第二个来源不是冗余：批次停在外协公司、`current_process_id` 却指向 INHOUSE 工序时
 *  （工序被改类别后的历史数据），后端在途计数按 DB 真值把它下发成
 *  `category = 'INHOUSE'` 的一行，而它不在 OUTSOURCE 工序列表里 ⇒ 只走列表会把这批
 *  在途批次整个漏掉，操作员既看不到也无从收货。
 *
 *  闸门用 `s.category !== 'OUTSOURCE'` 而不是「不在列表里就补」：快照里绝大多数行都是
 *  OUTSOURCE 工序（它们只因「零收发」才没出现在列表侧的情况不存在 —— 快照只收录
 *  `sendable + in_flight > 0` 的行），不按 category 闸会把「工序列表加载中/为空」
 *  这一瞬的快照整批补成 tab。 */
const tabProcesses = computed(() => {
  const snapshots = snapshotQuery.data.value?.processes ?? [];
  const byId = new Map(snapshots.map((p) => [p.process_id, p]));
  const rows = (procsQuery.data.value?.items ?? []).map((p) => {
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
  const known = new Set(rows.map((r) => r.id));
  for (const s of snapshots) {
    if (s.category === 'OUTSOURCE' || known.has(s.process_id)) continue;
    known.add(s.process_id);
    rows.push({
      id: s.process_id,
      code: s.process_code,
      name: s.process_name,
      color: s.color,
      sendable: s.sendable_count,
      inFlight: s.in_flight_count,
    });
  }
  return rows;
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

// ============================================================
// 右键菜单（区域 × 角色 × 批次状态 × 报价路径 的派生在纯函数里，见 outsourceBatchMenuItems.ts）
// ============================================================

/** 拆批权限闸 —— 与后端 `POST /batches/split` 的 `require_any_role([Manager, Clerk])`
 *  逐字对齐（Inspector 能收发但**不能**拆批）。与 `recall.canRecall` 当前同组角色，但
 *  那是两个端点各自独立的 RBAC 声明，不复用同一个布尔。 */
const canSplit = computed<boolean>(() => auth.hasRole('MANAGER') || auth.hasRole('CLERK'));

/** 「发送到外协公司」的目标集上游 —— 当前 tab 的公司列。
 *
 *  读的是 ProcessBoardTab 里那条 `useOutsourceQueueProcessQuery` 的**同一个 queryKey**
 *  （`qk.outsourceQueueProcess(processId)`）：tab body 自己发请求并填充缓存，板级只是
 *  `getQueryData` 读同一份缓存 ⇒ 零新增请求、零状态副本（公司列表随 tab 变，板级不另
 *  开 query 也不用可写 ref 让各 tab 往里写 —— 后者要处理「多 tab 同时活着、谁最后写、
 *  卸载要不要清」）。
 *
 *  读取发生在右键那一刻而非 computed：卡片能被右键就意味着该 tab 的详情早已解析完。 */
function currentTabCompanies(): OutsourceMenuCompany[] {
  const pid = activeTab.value;
  if (!pid) return [];
  const cached = qc.getQueryData<{ companies: OutsourceQueueCompanyData[] }>(
    qk.outsourceQueueProcess(pid),
  );
  return (cached?.companies ?? []).map((c) => ({ company_id: c.company_id, name: c.name }));
}

/** 打开拆批对话框。
 *
 *  version 是后端必填的 OCC 锚（缺它返 HTTP 422 纯文本），卡片 model 上它是**可选**
 *  字段，故守卫用 `typeof + isFinite` 两条而不是只看 isFinite（`undefined` 同样过不了
 *  isFinite，但显式 typeof 让类型收窄与运行时判据对齐）。 */
function openSplitDialog(batch: BatchCardModel): void {
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
}

const splitVisible = ref(false);
const splitTarget = ref<BatchSplitSource | null>(null);

/** 卡片右键 → 派生菜单项 → 开菜单。消费方两个投放容器（候选池 / 公司列）inject 这一个
 *  opener，第三参给出区域、第四参给出那一侧的行 DTO。
 *
 *  派生结果是**空数组**（当前角色对这张卡一个动作都没有）时不弹菜单、改为一句 warning：
 *  卡片侧的 `@contextmenu.prevent` 已经把系统右键菜单吞掉了，静默早退等于「右键卡片彻底
 *  没反应」，弹一个空白菜单框同样没法解释。
 *
 *  「召回到待下发」复用生产队列域的 `useQueueRecall`（`POST /prod/queue/recall` 是跨域
 *  端点、批次回到 `PENDING` 后生产队列的待下发列表确实要变），其失效链按**前缀**全刷，
 *  在本页同样成立。不为外协看板另写一份 recall composable。 */
provide<OpenOutsourceBatchMenu>(OPEN_OUTSOURCE_BATCH_MENU, (evt, batch, area, ctx) => {
  const held = ctx.kind === 'held' ? ctx : null;
  const items = buildOutsourceBatchMenuItems({
    area,
    batch,
    canMove: canMove.value,
    canSplit: canSplit.value,
    canRecall: recall.canRecall.value,
    candidate: ctx.kind === 'candidate' ? ctx.candidate : undefined,
    companies: currentTabCompanies(),
    // 「已经是 PENDING 未上架」的行本来就在待下发区，召回自己没有意义。
    candidateIsPending: ctx.kind === 'candidate' && !isCandidateDraggable(ctx.candidate),
    onSend: (companyId) => {
      if (ctx.kind !== 'candidate') return;
      void sendToCompany({ candidate: ctx.candidate, companyId });
    },
    onRecall: () => void recall.recallBatch(batch),
    onSplit: () => openSplitDialog(batch),
    onReceiveProduction: () => {
      receiveCtx.value = held;
      receiveMode.value = 'production';
      receiveVisible.value = true;
    },
    onReceiveInspection: () => {
      receiveCtx.value = held;
      receiveMode.value = 'inspection';
      receiveVisible.value = true;
    },
  });
  if (items.length === 0) {
    ElMessage.warning('当前角色对该批次没有可执行的操作');
    return;
  }
  void showBatchContextMenu(evt, items);
});

/** 拆批成功后的失效编排 —— **本组件持有**（对话框只发 `done`，见 BatchSplitDialog 文件头）。
 *  拆批后源批次留在原处（量变小）+ 新批次继承状态 / 位置 ⇒ 外协看板两域都要刷：
 *  单工序看板（左列候选 / 右列在途都可能变）与快照（tab 徽标）。 */
async function onSplitDone(): Promise<void> {
  await invalidateOutsourceQueueProcessAll(qc);
  await invalidateOutsourceQueueSnapshotAll(qc);
}

// ============================================================
// 回收对话框（右键触发，非拖拽）
// ============================================================
const receiveVisible = ref(false);
const receiveMode = ref<OutsourceReceiveMode>('production');
const receiveCtx = ref<OutsourceHeldCardContext | null>(null);
const receiving = ref(false);

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