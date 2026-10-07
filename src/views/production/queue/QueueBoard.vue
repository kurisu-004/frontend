<!-- 生产队列看板（路由 /production/worker-queue，menuCode worker_queue）。
     自 2026-10-08 起的结构：
       - 顶部 el-tabs（行上移，底边线视觉承接）
       - 首个固定 tab「待下发」(name = __pending__)：el-splitter 40/60 分栏
          （左 PendingBatchesPanel 待下发批次列表 / 右 PendingPoolsPanel 工序卡）
       - 后续每张 INHOUSE 工序一个 tab，body = <ProcessBoardTab :process-id="p.id" />，
         全部带 :lazy="true" ⇒ 切到该 tab 才 mount 才发 `GET /prod/queue/processes/{pid}`
     tab 标题 `(N)` 徽标数据源 = useQueueSnapshot（单请求跨货架聚合）。

     2026-10-09「批次右键菜单」通路的宿主（菜单换库 + 扩到三区）：
       - 菜单本体是 `@/composables/useBatchContextMenu.ts` 的 `showBatchContextMenu()`
         （`@imengyu/vue3-context-menu` **函数模式**，零组件实例、菜单挂 body 级单例
         容器）。本组件模板里**不再有任何菜单组件 / 模板 ref**；
       - provide 键 `openBatchContextMenu`：`(evt, batch, area) => void`，三个容器
         （待下发池 / 工序池 / 工人列）各自 inject 并把自己的**区域常量**传上来
         （消费侧一律带 noop 缺省）；
       - 菜单项由本组件按 **区域 × 角色 × 批次状态 × 目标集** 派生（纯函数
         `buildQueueBatchMenuItems`，见 composables/queueBatchMenuItems.ts 的矩阵表）：
         待下发池 = 拆批 + 发到工序；工序池 = 召回 + 拆批 + 派给工人；工人列 = 召回 +
         转交给工人；
       - 四条写路径全部复用现成 composable（`useQueueRecall` / 拆批对话框 /
         `useQueueDispatch.dispatchMutation` / `useQueueMove` 三个 move 包装），板级
         **不新增任何 mutation**，也就不新增失效编排；
       - 拆批成功后由本组件编排 production-queue 三域失效（对话框只发 `done`，见
         `onSplitDone`）；
       - 卡片侧**不包任何组件**：`@contextmenu.prevent` 经 BatchCard 的 fallthrough
         attrs 落在卡片根 div 上（包裹即破坏 Sortable 的「可拖元素 == vnode 的 DOM
         footprint」不变式，见文末与 BatchCardDndFootprint.spec.ts）。

     2026-10-04 「待下发」右栏纳入外协工序：
       - 右栏工序卡数据源由「只含 INHOUSE」放宽到「全部工序」，并在 props 上透传
         category，由 PendingPoolsPanel 客户端分两组渲染、中间一条分割线；
       - 顶部工序 tab 与深链校正 watch 仍只认自产工序；
       - procsQuery 显式 limit=200，避免工序总数超默认 limit 时外协工序被截断。

     2026-10-02 卡片统一：
       - 原先待下发池与工序池 / 工人列分用的两张旧卡片合并为全看板唯一的 BatchCard，
         工序池 / 工人列 / 待下发池三处共用，DTO 差异收在
         views/production/queue/utils/queueItemToCard.ts 适配层；
       - 全站拖拽统一 vue-draggable-plus（含「待下发 → 工序卡」这条下发链路，
         从原生 HTML5 DnD 改为 Sortable）；
       - 右侧工序卡与左侧批次卡同款 200×96 盒模型 + 工序色左边框 + flex 网格；
       - 左侧待下发池 / 工序 tab 的工序池改为「固定一屏 + 内部滚动」。

     2026-10-08 两处数据源变更（queue 域重构）：
       - tab 标题「待下发」的数字从 `pendingDispatch.batches.length`（**分页后的页
         长度**，limit=200）改读 `queueSnapshot.pending_count`（真实总数）——
         超过一页时旧口径会低报；
       - 右栏工序卡的徽标从 counts 改读 `queueSnapshot.processes[].pool_count`，
         工序色 / category 优先用快照里的（零新增请求）；⚠️ 快照只含 pool_count>0 的
         工序，所以仍要与 processes 列表 join 才能拿到零候选的工序（它们要照样出现
         在可下发目标里）。

     深链：`?tab=` 逻辑、`__pending__` 首 tab、inhouseProcs 过滤逻辑保持不变。 -->
<template>
  <div class="queue-board">
    <el-alert
      v-if="error"
      type="error"
      :title="error"
      :closable="false"
      show-icon
      class="error-alert"
    />

    <div v-if="loading" class="loading-state">
      <el-skeleton :rows="5" animated />
    </div>

    <template v-else>
      <el-tabs v-model="activeTab" class="pool-tabs">
        <el-tab-pane name="__pending__">
          <template #label>
            <span class="tab-label">
              <span class="tab-label__code">待下发</span>
              <span class="tab-label__count">({{ pendingCount }})</span>
            </span>
          </template>
          <!-- 待下发 Tab：左栏多选批次列表 + 右栏工序卡（PendingPoolCard 零请求，
               徽标由队列快照透传；右栏含外协工序，自产在上、外协在下，中间一条分割线）。 -->
          <el-splitter class="board-splitter">
            <el-splitter-panel size="40%" :min="320">
              <PendingBatchesPanel
                :batches="queueDispatch.batches.value"
                :total="queueDispatch.total.value"
                :is-loading="queueDispatch.isLoading.value"
                :selected-ids="queueDispatch.selectedIds"
                :set-selected-ids="queueDispatch.setSelectedIds"
                :auto-dispatch-mutation="queueDispatch.autoDispatchMutation"
                @hover-process="hoveredProcessId = $event"
              />
            </el-splitter-panel>
            <el-splitter-panel size="60%" :min="320">
              <PendingPoolsPanel
                :processes="panelProcesses"
                :selected-ids="queueDispatch.selectedIds"
                :dispatch-mutation="queueDispatch.dispatchMutation"
                :hovered-process-id="hoveredProcessId"
              />
            </el-splitter-panel>
          </el-splitter>
        </el-tab-pane>

        <el-tab-pane v-for="p in inhouseProcs" :key="p.id" :name="p.id" :lazy="true">
          <template #label>
            <span class="tab-label">
              <span class="tab-label__code">{{ p.code }}</span>
              <span class="tab-label__count">({{ poolCount(p.id) }})</span>
            </span>
          </template>
          <!-- 自产工序 Tab：ProcessBoardTab 是该 tab body 的唯一 query 持有者
               （useQueueBoard），:lazy="true" 保证切到该 tab 才发请求。shelfId 由本组件
               provide 注入给内嵌的 PoolDrawer 消费（WORKER→POOL 撤回目标货架）。 -->
          <ProcessBoardTab :process-id="p.id" />
        </el-tab-pane>
      </el-tabs>

      <div class="board-actions">
        <el-button :loading="loading" @click="onRefresh">刷新</el-button>
      </div>
    </template>

    <!-- 拆批对话框（共享组件，局部 import）。放在 <template v-else> 之外、根 div 的直接
         子级位置 ⇒ loading 骨架态下也已挂载。**失效编排在本组件**：对话框只发 `done`，
         由 onSplitDone 失效 production-queue 三域（外协看板那边要失效的是另外两个域，
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
import { useAuthStore } from '@/stores/auth';
import { useQueueMove } from './composables/useQueueMove';
import { useQueueDispatch, invalidateQueuePendingAll } from './composables/useQueueDispatch';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { qk } from '@/composables/queries/keys';
import { useQueueSnapshot, invalidateQueueSnapshot } from './composables/useQueueSnapshot';
import { invalidateQueueBoardAll } from './composables/useQueueBoard';
import type { QueueWorkerSchema } from './composables/productionQueueSchema';
import type { BatchCardModel } from '@/types/batchCard';
import type { BatchSplitSource } from '@/types/batchSplit';
import { showBatchContextMenu, type BatchMenuOpener } from '@/composables/useBatchContextMenu';
import { useQueueRecall } from './composables/useQueueRecall';
import {
  buildQueueBatchMenuItems,
  type QueueMenuProcess,
  type QueueMenuWorker,
} from './composables/queueBatchMenuItems';
import ProcessBoardTab from './components/ProcessBoardTab.vue';
import PendingBatchesPanel from './components/PendingBatchesPanel.vue';
import PendingPoolsPanel from './components/PendingPoolsPanel.vue';
import BatchSplitDialog from '@/components/BatchSplitDialog.vue';

const auth = useAuthStore();
// shelfId **只服务** PoolDrawer 的 WORKER→POOL 撤回目标货架（工人列与工序池都不再
// 依赖它 —— 队列数据全部由后端按批次真实位置返回）。
//
// ⚠️ 该值取自 `auth.activeShelfId = boundShelves[0]`，而后端只给「SHELF_ACCOUNT +
// scope_type='shelf'」的角色行返 shelf_ids ⇒ 对 MANAGER / CLERK / INSPECTOR 恒为
// null ⇒ shelfId 恒 `''`。后果：「把批次撤回候选池」对这三类角色结构性不可用 ——
// PoolDrawer 落点校验会弹「请先选择目标货架」，用户无法完成撤回。
// 之所以不能像只读端点那样把货架参数删掉：后端对 `to.shelf_id` 是**真实使用**的
// —— 目标货架必须命中 t_shelf_process 映射，否则 20507 / HTTP 422，货架语义无法从
// 请求里省掉。正解是补一个显式「当前货架」选择器，或一个
// `/shelves/for-return?next_process_id=` picker（待做）。
const shelfId = computed(() => auth.activeShelfId ?? '');
const queueMove = useQueueMove();
const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

// 工序元数据走共享 useProcessesQuery（30s staleTime 去重缓存，仓内多处 caller 共享
// 缓存身份），不再裸调 listProcesses。显式 limit=200：右栏「待下发」工序卡要含外协
// 工序，而工序总数超 200 时仍会被静默截断（后端 clamp 上限 500）。仍是**一个**请求，
// 进页面请求数恒为 3 的不变式不变（processes + queue/snapshot + queue/pending）。
const procsQuery = useProcessesQuery({ limit: 200 });
const inhouseProcs = computed(
  () => procsQuery.data.value?.items.filter((p) => p.category === 'INHOUSE') ?? [],
);

/** 队列快照 —— tab 标题 (N) 徽标 + 右栏工序卡徽标的**唯一**数据源
 *  （`GET /prod/queue/snapshot`，单请求按 process_id GROUP BY 跨所有货架聚合）。 */
const queueSnapshot = useQueueSnapshot();

/** 某工序的候选批次数（tab 标题徽标）。加载中占位「…」，resolved 后真实数字。 */
function poolCount(pid: string): number | string {
  if (queueSnapshot.isLoading.value) return '…';
  return queueSnapshot.data.value?.processes.find((p) => p.process_id === pid)?.pool_count ?? 0;
}

/** 「待下发」tab 标题的真实待下发总数（**不受列表分页影响**）。 */
const pendingCount = computed<number | string>(() => {
  if (queueSnapshot.isLoading.value) return '…';
  return queueSnapshot.data.value?.pending_count ?? 0;
});

/** 「待下发」Tab 工序卡 props —— 工序元数据（来自共享工序列表）+ 候选数徽标 +
 *  工序色。**不拉 per-process 详情**：改前每张卡自管 per-process query，进页面即打
 * N 个请求（每张工序卡一个），与「切 tab 懒加载」的设计意图相反；现徽标直接复用
 * 上面已 eager 拉取的队列快照，零新增请求。
 *
 *  ⚠️ 必须与工序列表 join：快照的 processes[] **只含候选数 > 0 的工序**，而下发的
 *  目标是「全部工序」（含零候选的自产 / 外协工序），故列表是行全集、快照只补
 *  count / color / category 三个字段。 */
const panelProcesses = computed(() => {
  const snapshotById = new Map(
    (queueSnapshot.data.value?.processes ?? []).map((p) => [p.process_id, p]),
  );
  return (procsQuery.data.value?.items ?? []).map((p) => {
    const s = snapshotById.get(p.id);
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      // 工序色优先取快照（同一批数据、少一次 join 语义分叉）；快照没这条（零候选）
      // 时回落到工序列表自带的 color。
      color: s?.color ?? p.color ?? null,
      count: s ? s.pool_count : 0,
      category: s?.category ?? p.category,
    };
  });
});

const queueDispatch = useQueueDispatch();
const recall = useQueueRecall();
const { error, moveBatchToWorker, moveBatchToPool, moveBatchBetweenWorkers } = queueMove;

/** 拆批权限闸 —— 与后端 `POST /batches/split` 的 `require_any_role([Manager, Clerk])`
 *  逐字对齐（Inspector 能收发但**不能**拆批）。
 *
 *  当前与 `recall.canRecall` 恰好是同一组角色，但它们是**两个端点各自独立的 RBAC 声明**
 *  （`POST /prod/queue/recall` 与 `POST /batches/split`），将来任一端点放宽都会只动一处，
 *  故不复用同一个布尔。 */
const canSplit = computed<boolean>(() => auth.hasRole('MANAGER') || auth.hasRole('CLERK'));

// activeTab 默认 = __pending__（首屏即待下发 tab，符合任务规约「待下发 Tab 在最前」）；
// URL ?tab=XXX 可覆盖（深链到具体工序），覆盖优先级 > 默认。放在右键菜单那一段之前：
// 「派给工人 / 转交给工人」的目标集要按当前 tab 去 board 缓存里取。
const TAB_QUERY_KEY = 'tab';
const PENDING_TAB = '__pending__';
function readInitialTab(): string {
  const q = route.query[TAB_QUERY_KEY];
  if (typeof q === 'string' && q.length > 0) return q;
  return PENDING_TAB;
}
const activeTab = ref<string>(readInitialTab());
// activeTab 变更 → 同步写到 URL（replace 不污染 history）。
watch(activeTab, (next) => {
  void router.replace({ query: { ...route.query, [TAB_QUERY_KEY]: next } });
});

// ============================================================
// 右键菜单（区域 × 角色 × 批次状态 × 目标集 的派生在纯函数里，见 queueBatchMenuItems.ts）
// ============================================================

/** 「发送到工序」的目标集 —— 共享 `useProcessesQuery` 的**全量**工序（INHOUSE +
 *  OUTSOURCE 都要）。与右栏「待下发」工序卡共用同一个 observer：同一个
 *  queryKey ⇒ 零新增请求，「进页面请求数恒为 3」的不变式不变。 */
function dispatchTargets(): QueueMenuProcess[] {
  return (procsQuery.data.value?.items ?? []).map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
  }));
}

/** 当前 tab 的工人列原始数据（右键那一刻现读，理由同 currentWorkers）。
 *
 *  `getQueryData` 不是响应式的，所以**不能**包 computed；它在右键回调里被调，每次都是
 *  最新值 —— 而卡片能被右键就意味着该 tab 的看板早已解析完。 */
function currentBoardWorkers(): QueueWorkerSchema[] {
  const pid = activeTab.value;
  if (pid === PENDING_TAB) return [];
  return qc.getQueryData<{ workers: QueueWorkerSchema[] }>(qk.productionQueueBoard(pid))?.workers ?? [];
}

/** 「派给工人 / 转交给工人」的目标集 —— 当前 tab 的工人列。
 *
 *  数据源是 ProcessBoardTab 里那条 `useQueueBoard` 的**同一个 queryKey**
 *  （`qk.productionQueueBoard(processId)`）：切到某个工序 tab 时该 tab body 自己发请求
 *  并填充缓存，板级只是 `getQueryData` 读同一份缓存 ⇒ **零新增请求、零状态副本**。
 *  不另开一条 query，也不用「provide 一个可写 ref 让各 tab 往里写」——后者要处理
 *  「多个 tab 同时活着、谁最后写、卸载要不要清」的问题，而这里读的是同一个缓存键。 */
function currentWorkers(): QueueMenuWorker[] {
  return currentBoardWorkers().map((w) => ({ worker_id: w.worker_id, name: w.name }));
}

/** 卡片所在列的 worker id —— 与目标集**同一个数据源**：持有该批次的那一列就是
 *  「自己」。在途卡片在一张看板里只出现在一列，按 batch_id 反查即可。
 *
 *  不从 DOM dataset 读（WorkerColumn 模板里那张 `data-worker-id` 是给拖拽 `onDragStart`
 *  用的）：右键回调拿不到 `evt.item`，而 board 缓存里已经有全部信息，多一条 DOM 查询
 *  通道只是多一条能取错值的路。
 *
 *  ⚠️ 常态下返回 null 意味着「这张卡不在当前 tab 的任何一列里」，只在**切 tab 的过渡
 *  窗口**可达：el-tab-pane 用 `v-show` 常驻（不销毁旧 pane），旧 pane 的卡仍可右键，
 *  而 `activeTab` 已指向新 tab、其看板缓存里还没有这张卡。此时 `moveBatchBetweenWorkers`
 *  收不到可用的 `from`（它只守 `version`、对 `fromWorkerId` 零校验），所以菜单派生层
 *  据此**不给**「转交给工人」这一项（见 queueBatchMenuItems 的 `selfWorkerId`）。 */
function selfWorkerIdOf(batch: BatchCardModel): string | null {
  return (
    currentBoardWorkers().find((w) => w.held_batches.some((b) => b.batch_id === batch.batch_id))
      ?.worker_id ?? null
  );
}

const splitVisible = ref(false);
const splitTarget = ref<BatchSplitSource | null>(null);

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

/** 卡片右键 → 板级 opener（消费方三个容器：待下发池 / 工序池 / 工人列）。容器与板级之间
 *  隔着 ProcessBoardTab 一层，故走 provide/inject 而非 prop 穿透；inject 侧一律带 noop
 *  缺省。
 *
 *  菜单项派生出来是**空数组**时不弹菜单、改为一句 warning：卡片侧的
 *  `@contextmenu.prevent` 已经把系统右键菜单吞掉了，静默早退等于「右键卡片彻底没反应」，
 *  而弹一个空白菜单框同样没法解释。文案按**空的原因**分级 —— 全权角色也会遇到「有权但
 *  这一格批次没得可做」（余量 ≤ 1 不可拆、目标集为空、切 tab 窗口反查不到自己所在列），
 *  对他说「当前角色没有可执行的操作」是把批次状态问题误报成权限问题。各写操作内部另有
 *  第二道闸（`useQueueRecall.recallBatch` / move 包装的守卫），菜单打开与最终提交两处都
 *  不漏。 */
provide<BatchMenuOpener>('openBatchContextMenu', (evt, batch, area) => {
  // 共享 `BatchArea` 是五个区域的并集，本页只有三个（消费方就是这三个容器）。不可达
  // 分支早退而不是硬 cast —— cast 会把「传错区域」变成静默派出一份对不上的菜单矩阵。
  if (area !== 'pending' && area !== 'pool' && area !== 'worker') return;
  // 求值**一次**存进闭包：菜单项是此刻派生的，但点击发生在之后。若在 onTransfer 里
  // 再反查一次，跨越的 tab 切换会让「派生时的自己」与「点击时的自己」不一致。
  const selfWorkerId = selfWorkerIdOf(batch);
  const items = buildQueueBatchMenuItems({
    area,
    batch,
    canRecall: recall.canRecall.value,
    canSplit: canSplit.value,
    processes: dispatchTargets(),
    workers: currentWorkers(),
    selfWorkerId: area === 'worker' ? (selfWorkerId ?? undefined) : undefined,
    onRecall: () => void recall.recallBatch(batch),
    onSplit: () => openSplitDialog(batch),
    onDispatch: (targetProcessId) => {
      queueDispatch.dispatchMutation.mutate({ batchIds: [batch.batch_id], targetProcessId });
    },
    onMoveToWorker: (workerId) => {
      // version 守卫在 moveBatchToWorker 内（缺 version / 货架必被后端拒，两条早退都带
      // 提示）；shelf_id 取**卡片自带的真实货架** —— 候选池跨所有货架，与当前激活货架
      // 可能不一致，填错后端返 20122。
      void moveBatchToWorker(
        batch.batch_id,
        batch.version ?? Number.NaN,
        workerId,
        batch.shelf_id ?? '',
      );
    },
    onTransfer: (workerId) => {
      // `from` 用闭包里那次求值的结果（见上面「求值一次」）。派生层已保证
      // area='worker' 时 selfWorkerId 非空 —— 取不到就不给这一项，所以这里的 `?? ''`
      // 是不可达兜底，不是正常路径。
      void moveBatchBetweenWorkers(
        batch.batch_id,
        batch.version ?? Number.NaN,
        selfWorkerId ?? '',
        workerId,
      );
    },
  });
  if (items.length === 0) {
    // 本页的两个权限闸就是 canRecall / canSplit（派活 / 转交 / 下发不另设角色闸），
    // 两个都 false 才能断定「空」是权限造成的。
    const byPermission = !recall.canRecall.value && !canSplit.value;
    ElMessage.warning(
      byPermission ? '当前角色对该批次没有可执行的操作' : '该批次当前没有可执行的操作',
    );
    return;
  }
  void showBatchContextMenu(evt, items);
});

/** 拆批成功后的失效编排 —— **本组件持有**（对话框只发 `done`，见 BatchSplitDialog 文件头）。
 *  拆批后源批次留在原处（量变小）+ 新批次继承状态 / 位置 ⇒ 本域三域都要刷：
 *  待下发列表（新批多一件、源批件数变）、工序看板（若拆的是池 / 工人列里的批次）、
 *  快照（tab 徽标 + 右栏工序卡徽标）。另加 parts（`qk.partsPrefix`）：拆批**新增**了
 *  批次成员关系，常驻的零件列表 / 详情页会显示过期成员 —— 与 useQueueDispatch /
 *  useQueueRecall 同域两条兄弟写路径同款理由（外协侧不刷是与本域一致的）。 */
async function onSplitDone(): Promise<void> {
  await invalidateQueuePendingAll(qc);
  await invalidateQueueBoardAll(qc);
  await invalidateQueueSnapshot(qc);
  await qc.invalidateQueries({ queryKey: qk.partsPrefix }).then(() => undefined);
}

/** 拖拽悬停的工序 id（null = 未悬停在任何工序卡上）—— 工序卡 `.is-dropping` 高亮的
 *  唯一状态源。Sortable 的 onMove 只派发给**源**（待下发批次列表），投放目标侧收不到
 *  ⇒ 状态落在两个面板的共同父级，由源面板 emit 上报、逐级透传到 PendingPoolCard 的
 *  dropping prop。放在本组件而不是 useQueueDispatch：它是纯视觉反馈，不属于「下发」域。 */
const hoveredProcessId = ref<string | null>(null);

// loading 由 procsQuery.isLoading || queueSnapshot.isLoading 控制初始 skeleton，
// 不阻塞 tab 切换。
const loading = computed(() => procsQuery.isLoading.value || queueSnapshot.isLoading.value);

provide<typeof moveBatchToWorker>('moveBatchToWorker', moveBatchToWorker);
provide<typeof moveBatchToPool>('moveBatchToPool', moveBatchToPool);
// WorkerColumn 落点消费（把 A 手中的批次拖到 B 手中 = WORKER→WORKER）。
provide<typeof moveBatchBetweenWorkers>('moveBatchBetweenWorkers', moveBatchBetweenWorkers);
provide<ComputedRef<string>>('shelfId', shelfId);

// 深链 ?tab=<某工序> 时 inhouseProcs 尚未从 procsQuery 解析完、无法校验 tab 合法性 ——
// 解析后校正到第一个 INHOUSE 工序。
watch(
  () => procsQuery.data.value,
  () => {
    if (
      activeTab.value !== PENDING_TAB &&
      !inhouseProcs.value.some((p) => p.id === activeTab.value) &&
      inhouseProcs.value[0]
    ) {
      activeTab.value = inhouseProcs.value[0].id;
    }
  },
  { immediate: true },
);

/** 刷新 = 失效本域三个 query（快照 / 工序看板 / 待下发列表）。全前缀失效，不做
 *  精确筛选：手动刷新是「我把当前屏幕当成不可信」的语义，不该只刷一半。 */
async function onRefresh() {
  await invalidateQueueSnapshot(qc);
  await invalidateQueueBoardAll(qc);
  await invalidateQueuePendingAll(qc);
  ElMessage.success('已刷新');
}
</script>

<style scoped>
.queue-board {
  padding: 0 16px 16px;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.error-alert {
  margin-bottom: 16px;
}
/* Tab 行上移（margin 0）+ 去掉 EP 默认下划线，让 tab 行视觉承接顶部边线 */
.pool-tabs {
  margin: 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  /* 需求「待下发池与工序池显示高度固定为一个屏幕」的高度链起点。
     EP 2.14.6 的 .el-tabs 是 display:flex / .el-tabs--top 是 column / .el-tabs__content
     是 flex-grow:1 + overflow:hidden —— 只要本页把 .pool-tabs 撑开，下游 el-splitter
     （height:100%）与 splitter-panel（无 CSS 规则，靠 align-items:stretch 拿确定高度）
     就能逐级传递。 */
  flex: 1;
  min-height: 0;
}
/* .el-tabs__content 自带 padding:15px，min-height:0 让内部 el-tab-pane 可以收缩，
   否则 height:100% 会在内容盒上加 padding 溢出。 */
.pool-tabs :deep(.el-tabs__content) {
  min-height: 0;
}
.pool-tabs :deep(.el-tab-pane) {
  height: 100%;
}
.pool-tabs :deep(.el-tabs__nav-wrap)::after {
  background: transparent;
}
/* EP 内部结构升级时的兜底，避免 nav-wrap::after 失效时丢失分割线 */
.pool-tabs :deep(.el-tabs__header) {
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.board-splitter {
  /* 父级 .el-tab-pane 是块容器（EP 2.14.6 的 el-tabs.css 里没有 .el-tab-pane 规则），
     故下面这两行 flex/min-height 实际不生效；撑满高度的是 EP 自带的
     `.el-splitter { height: 100% }`。留着只是历史惯性，不要以为高度靠它们。 */
  flex: 1;
  min-height: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  margin-top: 12px;
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