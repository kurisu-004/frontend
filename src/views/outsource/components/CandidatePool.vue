<!-- 2026-10-09 新建：外协看板左栏「可发送候选池」。
     数据源是父级 tab body 透传的 `items[]`（`GET /outsource-queue/processes/{id}` 的
     `OutsourceQueueCandidate[]`），本组件**零请求**。

     2026-10-20 新增：序列号 / 图号 / 批次号 / 名称的**本地**关键词过滤（判定收在
     `utils/batchCardKeyword.ts`，端点零筛选参数故不发请求）。口径只影响显示：工具条的
     徽标 / 未上架计数 / 已选数与勾选集合全部保持全量。

     两条 Sortable 硬约定（照 `views/production/queue/components/PendingBatchesPanel.vue`
     的源侧形态）：
       1. **三参重载（带 list）**。源侧必须有库内建的 `onRemove` —— 它的第一句是
          `from.insertBefore(item, from.children[oldIndex])`，即无论投放成败都先把
          被拖节点物理放回源容器。改二参这层就消失，被拖节点会永久卡在落点列，而它不在
          vnode 树里、Vue 后续重渲染也清不掉（invalidate 补不回来）。传给库的 list 是
          `sortableCards` 本地副本（不是渲染源），存在的唯一理由就是让库挂上内建 handler。
       2. `put: false`（不接外部投放）+ `sort: false`（池内顺序由后端排定，无重排语义）。

     ⚠️ **容器内不许留任何模板注释**（dev 构建保留注释，注释节点也是容器的直接子节点，
     会让 `oldIndex` 与可拖项下标错位）。本组件所有说明都写在容器 div 之外的父级里。

     卡片上**不许**包 el-tooltip / el-dropdown 之类：BatchCard 的硬不变式是
     「可拖元素 == vnode 的全部 DOM footprint」（守卫
     `src/components/__tests__/BatchCardDndFootprint.spec.ts`），包裹即破坏。
     「尚未上架」的置灰说明因此放在容器外的工具条 tooltip 里，而不是每张卡上。

     扫码：全局条码枪（`useBarcodeScanner`）按 `part_serial_no` 在**当前 tab 已加载的
     items** 里匹配，命中即勾选。多 tab 都已激活过时会同时有多个本组件实例，所以每个
     回调先过 `activeProcessId` 闸门（板级 provide）。

     ⚠️ **2026-10-20：搜索框与扫码枪的交互**（组件头部新增了搜索框，这是本文件唯一的
     交互回退点）。`useBarcodeScanner` 对输入框 / 可编辑区的按键一律 early-return ⇒
     **焦点一旦落在搜索框上，扫码枪的按键不再进缓冲区、一次扫码都不会派发**（改动前本页
     没有文本框，扫库枪永远命中）。用户看到序列号被填进框里、却什么也没发生，典型误判成
     「扫到了但没生效」。因此搜索框挂 `@keyup.enter="onSearchEnter"`：手输序列号回车 =
     走一遍扫码的匹配与勾选，并**让输入框失焦**（失焦是恢复扫码派发的必要动作）。
     关键词的清空是**有条件的**（只认得中本池某一行时才清），判据见 onSearchEnter。 -->
<template>
  <div class="candidate-pool">
    <div class="pool-toolbar">
      <span class="pool-title">可发送候选</span>
      <el-tag size="small" type="info">{{ items.length }}</el-tag>
      <el-tooltip :content="NOT_SHELVED_HINT" placement="top">
        <span v-if="notShelvedCount > 0" class="pool-hint">
          {{ notShelvedCount }} 个尚未上架
        </span>
      </el-tooltip>
      <span class="pool-selected">已选 {{ selectedIds.size }} 件</span>
    </div>
    <!-- 2026-10-20 新增：序列号 / 图号 / 批次号 / 名称的本地过滤（判定收在
         utils/batchCardKeyword.ts，端点零筛选参数故不发请求）。工具条里已排满 30% 窄栏的
         全部四格（标题 / 徽标 / 未上架提示 / 已选数），搜索行独立成行且是 .pool-body 的
         兄弟节点 —— .pool-cards 内部绝不许混入任何非可拖子元素。口径只影响显示：工具条的
         三处计数与勾选集合全部走 items 的全量。
         @keyup.enter 是「手输序列号回车」这条路（扫码枪对输入框里的按键一律不派发，
         理由与副作用见 onSearchEnter）。 -->
    <div class="pool-search">
      <el-input
        ref="searchInputRef"
        v-model="keyword"
        size="small"
        clearable
        :prefix-icon="Search"
        placeholder="序列号 / 图号 / 批次号 / 名称"
        @keyup.enter="onSearchEnter"
      />
    </div>
    <div class="pool-body">
      <div ref="containerRef" class="pool-cards" :data-process-id="processId">
        <BatchCard
          v-for="card in cards"
          :key="card.batch_id"
          :batch="card"
          :class="{ 'is-locked': !card.__draggable }"
          :selectable="card.__draggable"
          :selected="selectedIds.has(card.batch_id)"
          :data-shelf-id="card.shelf_id ?? ''"
          :data-batch-version="card.version"
          @toggle-select="onCardToggleSelect(card)"
          @contextmenu.prevent="onCardContextMenu($event, card)"
        />
      </div>
      <div v-if="items.length === 0" class="pool-empty">
        <el-empty description="该工序暂无可发送候选" :image-size="60" />
      </div>
      <div v-else-if="cards.length === 0" class="pool-empty">
        <el-empty description="无匹配序列号 / 图号 / 批次号 / 名称" :image-size="60" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue';
import { ElMessage, type InputInstance } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import type { BatchCardModel } from '@/types/batchCard';
import { recordOutsourceSource, type DraggableStartEvent } from '@/utils/dndSourceTracker';
import { filterBatchCardsByKeyword } from '@/utils/batchCardKeyword';
import type { OutsourceQueueCandidateData } from '../composables/outsourceQueueSchema';
import { poolCandidateToCard } from '../composables/outsourceItemToCard';
import {
  ACTIVE_OUTSOURCE_PROCESS_ID,
  NOT_SHELVED_HINT,
  OPEN_OUTSOURCE_BATCH_MENU,
  SCAN_MISS_HINT,
  isCandidateDraggable,
  type OutsourceBatchCardContext,
  type OpenOutsourceBatchMenu,
} from '../outsourceBoardTypes';
import BatchCard from '@/components/BatchCard.vue';

const props = defineProps<{
  /** 该工序的可发送候选行（`items[]` 原样）。 */
  items: OutsourceQueueCandidateData[];
  /** 候选卡 DTO 上没有工序字段，由 tab body 从响应根 `process` 取了传进来。 */
  processName: string;
  /** 本 tab 的外协工序 id —— 拖拽源记录 + 容器 data-process-id。 */
  processId: string;
  /** 板级持有的已选集合（多选发送 / 扫码选中的唯一状态源）。 */
  selectedIds: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  /** 勾选集合变化（勾选框 / 扫码命中都走这里）。整体换新 Set：父级持有的是响应式
   *  Set，原地 mutate 会让 `selectedIds.size` 之类的读取漏触发。 */
  'update:selectedIds': [ids: Set<string>];
}>();

/** 候选 DTO → 卡片 model。`__draggable` 是**视图私有**标记（不进 BatchCardModel 类型，
 *  靠同名属性挂上去）：判据 `shelf_id` 非空，空串 = `PENDING` 未上架，后端 `from` 守卫
 *  必拒这类行 —— UI 据此同时关掉「可拖」与「可选」。 */
type PoolCard = BatchCardModel & { __draggable: boolean };

/** 2026-10-20 新增：搜索关键词。组件局部状态、刻意不上抛 —— 过滤只影响可见集，工具条的
 *  三处计数与勾选集合仍由板级按 items 全量持有。**切 tab 不重置**：el-tab-pane 是
 *  「懒挂载一次、之后不再卸载」，多 tab 都激活过时每个 CandidatePool 实例各留一个自己的
 *  keyword（同一 path 多实例的既有形态）。这是有意的局部状态取舍，别当漏掉的 reset
 *  补上（同 `useBarcodeScanner` 文件头的同一条事实）。 */
const keyword = ref<string>('');

/** 候选 DTO → 卡片 model → 本地关键词过滤（可见集）。工具条的徽标 / 未上架计数 / 已选数
 *  三处刻意读 props.items 而不是本 computed：口径只让「看得见的卡片」变少，不让
 *  「一共多少件」变少。 */
const cards = computed<PoolCard[]>(() =>
  filterBatchCardsByKeyword(
    props.items.map((it) => ({
      ...poolCandidateToCard(it, props.processName),
      __draggable: isCandidateDraggable(it),
    })),
    keyword.value,
  ),
);

/** 尚未上架的行数（工具条提示用）。 */
const notShelvedCount = computed(() => props.items.filter((it) => !isCandidateDraggable(it)).length);

/** 传给 useLazyDraggable 的本地副本，**不是渲染源**（模板 v-for 走 cards）。存在的
 *  唯一理由是让库给本实例挂上源端内建 handler（见文件头第 1 条）。 */
const sortableCards = ref<BatchCardModel[]>([]);
watch(
  cards,
  (next) => {
    sortableCards.value = [...next];
  },
  { immediate: true },
);

const containerRef = ref<HTMLElement | null>(null);
// 容器在 items 为空时**照常渲染**（空态是兄弟覆盖层），不挂任何 v-if：否则空候选池
// 连 Sortable 实例都没有，后续从别的 tab 拖进来会无处可落。
useLazyDraggable(containerRef, sortableCards, {
  // put / pull 是 Sortable 的 group 成员（Options 顶层不接受这两个键），故用对象形态。
  group: { name: 'outsource-send', put: false, pull: true },
  sort: false,
  animation: 150,
  ghostClass: 'sortable-ghost',
  // 尚未上架的行不参与拖拽：filter 命中即拒绝发起拖动（Sortable 的标准机制）。
  // 不改用 onStart 里早退 —— 那时节点已经被拖起来了，落点侧会短暂出现可投放假象。
  filter: '.is-locked',
  onStart: onDragStart,
});

/** 记录外协候选池拖拽源（公司列落点的白名单守卫与 move 入参都消费它）。
 *
 *  四条锚分别取自：容器 dataset 的 `processId`、卡片 dataset 的真实 `shelfId` 与 OCC
 *  `version`、候选行的 `outsource_company_id`（APPROVAL 报价锁定的公司；DIRECT 行为
 *  空串 —— 目标公司要在落点上才定）。 */
function onDragStart(evt: DraggableStartEvent): void {
  const batchId = evt.item.dataset.batchId;
  const shelfId = evt.item.dataset.shelfId;
  const version = Number.parseInt(evt.item.dataset.batchVersion ?? '', 10);
  const fromProcessId = evt.from.dataset.processId;
  if (!batchId || !fromProcessId) return;
  const candidate = props.items.find((it) => it.batch_id === batchId);
  recordOutsourceSource(batchId, {
    processId: fromProcessId,
    shelfId: shelfId ?? '',
    version: Number.isFinite(version) ? version : Number.NaN,
    companyId: candidate?.outsource_company_id ?? '',
  });
}

/** 板级右键 opener（菜单本体由板级调 `showBatchContextMenu`，挂在 body 上，与本
 * Sortable 容器零 DOM 关系）。inject 缺省 noop 兜底：板级契约缺失时右键无反应，不炸
 * 事件回调。 */
const openOutsourceBatchMenu = inject<OpenOutsourceBatchMenu>(OPEN_OUTSOURCE_BATCH_MENU, () => {});

/** 卡片根部的右键落点。只转交 (事件, 卡片, 区域, 候选行上下文)，动作与权限都在板级。
 * 区域标签 `'outsource-candidate'` 是本容器恒定的 —— 与 ctx.kind 表达的是同一件事，
 * 前者是「板级派菜单矩阵用哪个区域」，后者是「这行的 DTO 属于哪一侧」，两者恒一致。 */
function onCardContextMenu(evt: MouseEvent, card: PoolCard): void {
  const candidate = props.items.find((it) => it.batch_id === card.batch_id);
  if (!candidate) return;
  const ctx: OutsourceBatchCardContext = {
    kind: 'candidate',
    candidate,
    processName: props.processName,
  };
  openOutsourceBatchMenu(evt, card, 'outsource-candidate', ctx);
}

/** 勾选框翻转（BatchCard 的 toggleSelect 不带 payload，batch_id 由模板闭包绑进来）。
 *  尚未上架的行没有勾选角标（:selectable=false），这里的守卫是纵深防御。 */
function onCardToggleSelect(card: PoolCard): void {
  if (!card.__draggable) return;
  const next = new Set(props.selectedIds);
  if (next.has(card.batch_id)) next.delete(card.batch_id);
  else next.add(card.batch_id);
  emit('update:selectedIds', next);
}

/** 当前激活的外协工序 id —— 扫码作用域闸门。多个 tab 都激活过时本组件有多个实例，
 *  不闸门就会一次扫码把 N 个 tab 的勾选都改掉。 */
const activeProcessId = inject<ComputedRef<string>>(ACTIVE_OUTSOURCE_PROCESS_ID, computed(() => ''));

const { onScan } = useBarcodeScanner();
let unsubScan: (() => void) | null = null;

/** 扫码 → 在**当前 tab 已加载**的 items 里按 `part_serial_no` 匹配 → 加入勾选。
 *
 *  只匹配当前 tab 是有意的取舍：候选池是「批次 × 外协工序」粒度，同一个批次在别的 tab
 *  里是另一行，切 tab 匹配会让一次扫码产生跨 tab 的隐式状态。未命中文案必须点明这一点
 *  （SCAN_MISS_HINT），否则操作员会去查状态 / 报价。零请求：不再像旧表格页那样先
 *  `getPartBySerial` 反查零件再在当前页里找。 */
function handleScan(code: string): void {
  if (activeProcessId.value !== props.processId) return;
  applyCode(code, { notifyMiss: true });
}

/** 「匹配 + 守卫 + 勾选」的唯一实现，扫码枪与搜索框回车两条路径共用。
 *
 *  两条路径**只在「未命中要不要提示」上分叉**：
 *   - 扫码枪扫不到 = 手上那把枪对着一个不存在的序列号，提示才有用（notifyMiss: true）；
 *   - 手输半截图号再回车 = 用户自己在拼序列号，「扫不到」是骂人，静默即可（false）。
 *  「尚未上架」守卫两条路径都不豁免：勾上了却拖不动比直接提示更差。
 *
 *  返回值 = 「框里这句话是否确实指向本池的一行」。回车路径靠它决定要不要清空关键词
 *  （见 onSearchEnter），所以未命中的那一格必须答 false，不能顺手清掉用户的过滤词。 */
function applyCode(raw: string, options: { notifyMiss: boolean }): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const hit = props.items.find((it) => it.part_serial_no === trimmed);
  if (!hit) {
    if (options.notifyMiss) ElMessage.warning(SCAN_MISS_HINT);
    return false;
  }
  // 尚未上架的行没有勾选角标（拖拽侧另有 Sortable filter 兜底），扫码也一并拦住 ——
  // 勾上了却拖不动，是比直接提示更差的结果。
  if (!isCandidateDraggable(hit)) {
    ElMessage.warning(NOT_SHELVED_HINT);
    return true;
  }
  const next = new Set(props.selectedIds);
  next.add(hit.batch_id);
  emit('update:selectedIds', next);
  // 2026-10-20：命中的行被当前关键词过滤掉了 ⇒ 清空关键词。扫中了却看不见那张卡，
  // 操作员会以为扫码坏了、又按一次；清空后卡片回到可见集，「勾上了却看不见卡」的死角
  // 消失。判据走 cards（可见集）而不是 items（数据全量），动作排在成功提示之前 ——
  // 提示与界面必须同时自洽。
  if (!cards.value.some((card) => card.batch_id === hit.batch_id)) {
    keyword.value = '';
  }
  ElMessage.success(`已选中：${hit.part_name ?? ''}（批次 ${hit.batch_no}）`);
  return true;
}

/** 搜索框 ref —— 回车后要失焦（见 onSearchEnter）。ElInput 经 defineExpose 暴露
 *  focus / blur / select / clear，所以这里拿到的是组件实例而不是内部 input 元素。 */
const searchInputRef = ref<InputInstance | null>(null);

/** 搜索框里手输序列号后回车 = 把框内内容当一次扫码提交。
 *
 *  **为什么必须有这条路**：全局条码枪对输入框 / 可编辑区的按键一律 early-return
 *  （`useBarcodeScanner` 的 isInTextField），焦点落在搜索框上时**一次扫码都不会派发**，
 *  而用户看到的只是序列号被填进了框里 —— 典型的「扫到了但没生效」静默误判。
 *
 *  顺序：取框内内容 → 失焦 → 跑一遍匹配与勾选 → **按结果**决定要不要清空关键词。
 *   - 失焦是**恢复扫码能力的必要动作**：焦点不离开输入框，扫码持续静默失效（只清空
 *     不失焦不够）。
 *   - 清空只对「这句话确实指向本池里的一行」成立（applyCode 的返回值）。⚠️ 判据必须
 *     排在清空**之后**：搜索框承诺的是「序列号 / 图号 / 批次号 / 名称」，而 applyCode
 *     认的是 `part_serial_no` 等值 —— 用户「按名称过滤出两张卡、顺手回车」是再合理不过
 *     的一条路，命中不了序列号时若先把关键词清掉，就等于零反馈地抹掉他刚做的过滤
 *     （卡片弹回全量且没有任何提示）。未命中时关键词原样留着，回车也不提示。
 *   - **刻意不过 activeProcessId 闸门**：那个闸门存在是因为扫码是全局的、N 个 tab 实例会
 *     同时收到；回车是键在**本实例自己的输入框**上派发的，未激活的 tab pane 拿不到焦点、
 *     不可能收到它，所以这里天然只有一个实例会响应，加闸门只会让「万一」那条路静默无反应。
 *   - 未命中静默（notifyMiss: false）：理由见 applyCode 的注释。 */
function onSearchEnter(): void {
  const raw = keyword.value;
  searchInputRef.value?.blur();
  if (applyCode(raw, { notifyMiss: false })) keyword.value = '';
}

onMounted(() => {
  unsubScan = onScan(handleScan);
});
onBeforeUnmount(() => {
  if (unsubScan) {
    unsubScan();
    unsubScan = null;
  }
});
</script>

<style scoped>
.candidate-pool {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow: hidden;
}
.pool-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  flex-shrink: 0;
}
.pool-title {
  font-weight: 600;
  font-size: 14px;
}
.pool-hint {
  font-size: 12px;
  color: var(--el-color-warning);
  border-bottom: 1px dashed currentColor;
  cursor: default;
}
.pool-selected {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
/* 2026-10-20 新增：搜索行独立一行，且是 .pool-body 的兄弟节点。工具条里已经排满
   30% 窄栏，挤进去会把「已选 N 件」挤出可视区。 */
.pool-search {
  margin-bottom: 8px;
  flex-shrink: 0;
}
/* 与公司列 / 生产队列池同一条网格基线（200px 卡 + 8px gap + align-content:flex-start）。
   flex:1 + min-height:0 打通「固定一屏、内部滚动」的高度链。 */
.pool-body {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.pool-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0;
  align-content: flex-start;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
/* BatchCard 自身固定 200px 宽，此处只锁死不伸缩。 */
.pool-cards :deep(.batch-card) {
  flex: 0 0 200px;
}
/* 尚未上架的行：降不透明度 + 禁手型光标（拖拽侧另有 Sortable 的 filter 兜底）。 */
.pool-cards :deep(.batch-card.is-locked) {
  opacity: 0.55;
  cursor: not-allowed;
}
/* 拖拽 ghost 的半透明占位。src/styles 下没有全局 .sortable-ghost 规则，仓内各处都在
   自己的 scoped style 里 :deep 定义，漏掉就等于拖起来毫无视觉反馈。 */
:deep(.sortable-ghost) {
  opacity: 0.4;
}
/* 空态（无候选 / 无匹配两条分支共用）是容器的**兄弟覆盖层**：容器内混入非可拖子元素会让
   Sortable 的可拖项下标与 DOM 下标错位；容器不渲染又会让空池失去 Sortable 实例。
   pointer-events:none 保证插画不吃落点判定。 */
.pool-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
</style>