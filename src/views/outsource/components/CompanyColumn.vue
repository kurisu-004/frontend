<!-- 2026-10-09 新建：外协看板右栏「外协公司列」（Sortable 的投放目标）。
     数据由父级 tab body 透传（`companies[]` 及其内联 `held_batches`），本组件**零请求**
     —— 后端把在途批次内联在列上，打开一个 tab 恒为 1 个请求，N+1 从结构上不存在。

     Sortable 走**二参重载**（不传 list）：本容器是纯投放目标，库的内建 onAdd/onRemove
     假定「传进来的 list 就是渲染源」，而本列的渲染源是 props 派生的 heldBatches。代价是
     内建 onRemove 的 **DOM 放回**随之消失，必须由 options.onRemove
     （`restoreNodeToSource`）补回 —— 否则投放失败（OCC 冲突 / 报价与公司不匹配等）时
     节点永久留在本列，invalidateQueries 补不回来（失败时两侧 query 数据都没变，Vue 的
     keyed diff 对外来节点连 patchElement 都做不到）。

     ⚠️ 容器内**不许留模板注释**（dev 构建保留注释，注释节点也是容器的直接子节点，会让
     `oldIndex` 与可拖项下标错位）。空态用兄弟覆盖层，空公司列必须一直是合法投放目标
     （后端 `companies[]` 特意返 `held_count = 0` 的空列）。

     ⚠️ **本组件必须自己定义 `:deep(.sortable-ghost)`**：`src/styles/` 下没有全局
     该类名，各处都在自己的 scoped style 里定义。漏掉的表现是从候选池拖进来时半透明
     占位完全没有反馈（`ghostClass` 设了但没人给它样式）。生产队列域的 WorkerColumn /
     PoolDrawer 正缺这条，别把那处 bug 复制过来。

     三条拖拽守卫**全部在第一个 await 之前跑完**（见 onDragAdd 的注释）。 -->
<template>
  <el-card class="company-column" shadow="never">
    <template #header>
      <div class="col-header">
        <span class="company-name">{{ company.name }}</span>
        <el-tag size="small" type="info">{{ heldBatches.length }}</el-tag>
      </div>
    </template>
    <div class="col-content">
      <div ref="containerRef" class="col-body" :data-company-id="company.company_id">
        <BatchCard
          v-for="batch in heldBatches"
          :key="batch.batch_id"
          :batch="batch"
          :data-batch-version="batch.version"
          @contextmenu.prevent="onCardContextMenu($event, batch)"
        />
      </div>
      <div v-if="heldBatches.length === 0" class="col-empty">
        <el-empty description="拖批次到此发送" :image-size="60" />
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import type { BatchCardModel } from '@/types/batchCard';
import {
  consumeOutsourceSource,
  restoreNodeToSource,
  type DraggableStartEvent,
} from '@/utils/dndSourceTracker';
import type {
  OutsourceQueueCandidateData,
  OutsourceQueueCompanyData,
} from '../composables/outsourceQueueSchema';
import { heldBatchToCard } from '../composables/outsourceItemToCard';
import type { SendToCompanyInput } from '../composables/useOutsourceQueueMove';
import {
  NOT_SHELVED_HINT,
  OPEN_OUTSOURCE_BATCH_MENU,
  SEND_TO_COMPANY,
  type OpenOutsourceBatchMenu,
  type OutsourceBatchCardContext,
} from '../outsourceBoardTypes';
import BatchCard from '@/components/BatchCard.vue';

const props = defineProps<{
  /** 单列（后端 VO 原样透传：company_id / name / held_count / held_batches）。 */
  company: OutsourceQueueCompanyData;
  /** 本 tab 左列的候选行 —— 拖拽白名单守卫（send_mode / company_options / can_send）
   *  的唯一数据源。放在途卡上：回收动作与发送守卫无关，公司列不该知道左列长什么样。 */
  candidates: OutsourceQueueCandidateData[];
  /** 板级持有的已选集合（多选拖拽的发送范围）。 */
  selectedIds: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  /** 多选发送后上抛剩余（发送失败）的那批勾选，让它们留在原地可重试。 */
  'update:selectedIds': [ids: Set<string>];
}>();

/** 在途卡 → 卡片 model（与左列共用同一张 BatchCard，DTO 差异收在适配层）。 */
const heldBatches = computed<BatchCardModel[]>(() =>
  props.company.held_batches.map((b) => heldBatchToCard(b, props.company.name)),
);

const containerRef = ref<HTMLElement | null>(null);
// 二参重载 + onRemove 补 DOM 放回 + sort:false 关列内重排，理由见文件头。
useLazyDraggable(containerRef, {
  group: { name: 'outsource-send', pull: false, put: true },
  sort: false,
  animation: 150,
  ghostClass: 'sortable-ghost',
  onAdd: onDragAdd,
  onRemove: restoreNodeToSource,
});

/** 发送包装（板级 provide，实现在 `useOutsourceQueueMove.sendToCompany`）。inject 缺省
 *  `async () => false` 兜底：拿不到 provider 时 onDragAdd 的发送段退化为不发请求，
 *  而不是抛错炸掉整个 drop 回调。 */
const sendToCompany = inject<(input: SendToCompanyInput) => Promise<boolean>>(
  SEND_TO_COMPANY,
  async () => false,
);

const openOutsourceBatchMenu = inject<OpenOutsourceBatchMenu>(OPEN_OUTSOURCE_BATCH_MENU, () => {});

/** 卡片根部的右键落点。只转交上下文（在途 DTO + 所在公司 id/name），动作在板级。
 * company_id 必须在这一步带上：在途卡 DTO 上**没有**公司字段，公司只挂在列上，
 * 而回收请求的 `from.company_id` 正是它。区域标签 `'outsource-company'` 是本列恒定的
 * —— 与 ctx.kind 表达的是同一件事，前者给板级派菜单矩阵、后者给板级取 DTO。 */
function onCardContextMenu(evt: MouseEvent, batch: BatchCardModel): void {
  const held = props.company.held_batches.find((b) => b.batch_id === batch.batch_id);
  if (!held) return;
  const ctx: OutsourceBatchCardContext = {
    kind: 'held',
    held,
    companyId: props.company.company_id,
    companyName: props.company.name,
  };
  openOutsourceBatchMenu(evt, batch, 'outsource-company', ctx);
}

/** 落点校验结果：一个候选行 + 一句给用户的拒绝理由。 */
interface Rejection {
  batch_id: string;
  reason: string;
}

/**
 * 来源白名单：这次拖拽的落点公司对该候选行是否合法。
 *
 * 两条报价路径的目标公司来源完全不同，不能互相借用：
 *   - APPROVAL：目标是**报价锁定**的那家公司（拖拽开始时记进源条目的 companyId），
 *     落到别的公司列必被后端拒（20104 / 报价与公司不匹配）；
 *   - DIRECT：目标由用户在这条落点上定，所以落点必须命中候选行的 `company_options`
 *     （该数组就是 DIRECT 的公司下拉源；为空时 `can_send` 已是 false）。
 */
function isAllowedTarget(candidate: OutsourceQueueCandidateData, srcCompanyId: string): boolean {
  if (candidate.send_mode === 'APPROVAL') return props.company.company_id === srcCompanyId;
  return candidate.company_options.some((o) => o.id === props.company.company_id);
}

/**
 * 落点分发。三步守卫**全部同步跑完**（第一个 await 之前），之后才发请求。
 *
 * 为什么守卫必须前置：Sortable 已经把节点搬进本列了，请求失败时只有源侧的 onRemove
 * （restoreNodeToSource）能把它放回去 —— 而守卫早退同样会触发那条 onRemove（同一次
 * 投放的 remove 事件），所以早退与失败的收尾是同一条路径，不需要额外回滚代码。把守卫
 * 写成 await 之后的判断则会出现「先发一次注定被拒的请求」的额外往返与错误 toast。
 */
async function onDragAdd(evt: DraggableStartEvent): Promise<void> {
  const draggedId = evt.item.dataset.batchId;
  if (!draggedId) return;
  // 只有外协候选池来源才受理（`put: true` 的布尔形态不做 group 名比对，任何 Sortable
  // 来源都会被 onAdd 叫醒）。
  const src = consumeOutsourceSource(draggedId);
  if (!src) return;

  // 多选发送：拖的是已勾选的卡且勾选集 > 1 ⇒ 发整组；否则只发被拖的那张。
  const targets =
    props.selectedIds.has(draggedId) && props.selectedIds.size > 1
      ? Array.from(props.selectedIds)
      : [draggedId];

  const accepted: OutsourceQueueCandidateData[] = [];
  const rejected: Rejection[] = [];
  for (const id of targets) {
    const candidate = props.candidates.find((c) => c.batch_id === id);
    if (!candidate) {
      rejected.push({ batch_id: id, reason: '已不在当前工序的可发送候选中' });
      continue;
    }
    // ② 后端派生的可发送判据（APPROVAL，或 DIRECT 且 company_options 非空）。
    // 前端口径统一读它，不自己再算一遍。
    if (!candidate.can_send) {
      rejected.push({ batch_id: id, reason: '该批次当前不可发送（无可用报价或外协公司）' });
      continue;
    }
    // ① 来源白名单（APPROVAL 报价锁定 / DIRECT company_options）。
    if (!isAllowedTarget(candidate, src.companyId)) {
      rejected.push({
        batch_id: id,
        reason:
          candidate.send_mode === 'APPROVAL'
            ? '该批次已由报价锁定外协公司，不能改投其它公司'
            : '所选外协公司不在该批次的可发送范围内',
      });
      continue;
    }
    // ③ OCC 锚与货架位置：缺失（'0' / '' / NaN）时 move 必被后端拒（缺 version 返
    // HTTP 422 纯文本；批次未上架时 location IS NULL，`from.kind=PRODUCTION_SHELF`
    // 守卫拒收）—— 不发注定失败的请求。
    if (!Number.isFinite(candidate.version) || candidate.version === 0) {
      rejected.push({ batch_id: id, reason: '批次版本信息缺失，无法移动' });
      continue;
    }
    // 与候选池置灰提示共用同一个常量：两条路径判据同源，文案也必须同源。
    if (candidate.shelf_id === '') {
      rejected.push({ batch_id: id, reason: NOT_SHELVED_HINT });
      continue;
    }
    accepted.push(candidate);
  }

  // 守卫结论先汇总：全被拒时只弹一条，不逐条刷 toast。
  if (accepted.length === 0) {
    ElMessage.warning(rejected[0]?.reason ?? '该批次无法发送到本公司');
    return;
  }

  // 串行发送：每次落位都是「一次写操作 + 一次失效」，并发会让两个 move 抢同一个批次
  // 的 OCC（后到者必吃 40901）。失败项留在原地（勾选保留）可重试。
  const failedIds = new Set(rejected.map((r) => r.batch_id));
  let okCount = 0;
  for (const candidate of accepted) {
    const ok = await sendToCompany({ candidate, companyId: props.company.company_id });
    if (ok) {
      okCount++;
      failedIds.delete(candidate.batch_id);
    } else {
      failedIds.add(candidate.batch_id);
    }
  }

  if (targets.length > 1) {
    emit('update:selectedIds', failedIds);
    const failCount = targets.length - okCount;
    if (failCount > 0) {
      ElMessage.error(
        `发送失败 ${failCount} 个（成功 ${okCount} 个），失败项已留在原处可重试${
          rejected.length > 0 ? `：${rejected.map((r) => r.reason).join('；')}` : ''
        }`,
      );
    }
  }
}
</script>

<style scoped>
/* 432px 来自下方两列网格的算式 —— 200px 卡 × 2 + 8px gap + .el-card__body padding
   10px × 2 + el-card 边框 1px × 2 = 430px，取 432 留 2px 余量。卡片 200px 是全看板
   硬约定（候选池同一张卡），换行只能靠加宽列。 */
.company-column {
  width: 432px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}
.company-column :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  padding: 10px;
}
.col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.company-name {
  font-weight: 600;
  font-size: 14px;
}
/* 高度链终点：承接 .el-card__body 的 flex:1 + min-height:0，并作为空态覆盖层的定位
   上下文。 */
.col-content {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.col-body {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-content: flex-start;
  flex: 1;
  min-height: 100px;
  overflow-y: auto;
}
.col-body :deep(.batch-card) {
  flex: 0 0 200px;
}
/* 空态是容器的**兄弟覆盖层**（空公司列是主场景的投放目标，容器必须一直在）。 */
.col-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
/* ghost 半透明占位：本组件的 ghostClass 就在这里被消费，漏掉就没有拖拽反馈。 */
:deep(.sortable-ghost) {
  opacity: 0.4;
}
</style>
