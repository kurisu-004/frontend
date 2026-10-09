// views/parts/detail/composables/usePartDetailActions.ts
//
// 零件详情页的全部写操作（7 个端点），一律 `useMutation`，形态照
// `views/com/delivery/composables/useDeliveryNoteActions.ts`：
//
//   | action           | 端点                                    | OCC 锚                              |
//   |------------------|-----------------------------------------|-------------------------------------|
//   | onSave           | POST /parts/{id}/update                  | part 级 `PartDetailData.version`   |
//   | onCancelOrder    | POST /parts/{id}/cancel                  | 无 body                            |
//   | onDeletePart     | POST /parts/{id}/soft-delete             | part 级 `PartDetailData.version`   |
//   | onPassInspection | POST /prod/batches/{batch_id}/to-ship    | 批次 `PartBatch.version`           |
//   | onFailInspection | POST /prod/batches/{batch_id}/to-process | 批次 `PartBatch.version`           |
//   | onSplitBatch     | POST /batches/split                     | 批次 `PartBatch.version`           |
//   | onCancelBatch    | POST /prod/batches/{batch_id}/cancel     | 批次 `PartBatch.version`           |
//
// 分层职责：
//   - 本文件只管「发起写 + 提示 + 失效」，**不 import vue-router**、不知道对话框；
//     每个 action 返回 `Promise<boolean>`，跳转 / 关框由 shell（`PartDetail.vue`）
//     决定。这是 CLAUDE.md「store / composable 不 import vue-router」在详情页的落法。
//   - 数据层通过 `PartDetailActionBindings` 显式解耦，**只拿本文件真正用到的三个面**
//     （工单 id / 工单本体 / 品检锚批次），不依赖整个 `usePartDetail` 返回值 —— 否则
//     数据层与动作层互相锁死，改一个字段就得看另一个文件。批次列表**不在**本层接口里：
//     批次级 OCC 锚由各 action 的入参（`PartBatch`）自带，其余地方用不到整份列表。
//
// **失效链（onSuccess 与 onError 都走）**：`qk.partDetailPrefix` +
// `qk.partEventsPrefix` + `qk.partBatchesPrefix` 三条前缀，逐条 `await`。
// 任意一个写端点都会同时改工单本体（status / version）、批次集合（status / version /
// 数量）与事件流水（每次流转追加一行），少刷一条就留下一半陈旧数据 —— 典型症状是
// 品检通过后工单标签没翻、历史卡没有 INSPECTED 事件、批次行还停在 INSPECTION。
// onError 同样走全套：40901 OCC 恰恰意味着**服务端那份已经被别人改过**、本端副本
// 过期，只在 onSuccess 失效的话用户会盯着一条作废的列表继续点。
//
// 为什么**不**在失效之后补一次 `fetchDetail()`：TanStack 会 await `onSuccess` 返回的
// promise，而 `invalidateQueries` 的 promise 在活跃 observer 的 refetch settle 之后
// 才 resolve ⇒ `mutateAsync` resolve 时 `part.version` 已经是新值（下一次保存的 OCC
// 锚正确）。再补一次 refetch 是纯重复往返。手工刷新按钮走 shell 侧的
// `fetchDetail` / `fetchBatches` 别名（见 `usePartDetail` 的返回）。
//
// ⚠️ 本文件**只覆盖这 7 个端点**。零件文件的上传 / 删除（CNC 程序、设定单、图纸、
// 3D 模型）分别住在 `src/composables/usePartFileUpload.ts`、
// `views/parts/detail/composables/usePartCncGroups.ts` 与 `PartFilesTabsCard.vue`，
// 它们各自失效 `qk.partFilesList`，不属本页的动作层。
//
// 不写 retry：信任 `main.ts` 的全局 `mutations.retry: 0`。

import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/vue-query';
import { toValue, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue';
import {
  cancelPart,
  cancelPartBatch,
  softDeletePart,
  toProcess,
  toShip,
  updatePart,
  type PartBatch,
  type PartUpdatePayload,
} from '@/api/parts';
import { splitBatch } from '@/api/batch';
import type { BatchSplitDto } from '@/api/batch.contract';
import type { ApiError } from '@/api/http';
import { qk } from '@/composables/queries/keys';
import { useConfirm } from '@/composables/useConfirm';
import type { PartDetailData } from './partDetailSchema';

/** OCC 40901（VERSION_CONFLICT）：服务端副本已被他人改动，本端锚点作废。 */
const OCC_CONFLICT = 40901;

/**
 * 数据层暴露给 actions 的最小接口（避免 actions 依赖整个 `usePartDetail` 返回值）。
 *
 * `part` / `batches` 只读不写：动作层是这批数据的**消费者**，改数据的活归 query 层。
 */
export interface PartDetailActionBindings {
  /** 当前零件 id（reactive：同路由只改 param 时 vue-router 会复用组件实例）。 */
  partId: MaybeRefOrGetter<string | null | undefined>;
  /** 工单本体（part 级 OCC 锚 `version` 取自它）。
   *
   *  只读不写：动作层是这批数据的**消费者**，改数据的活归 query 层。 */
  part: Ref<PartDetailData | null>;
  /**
   * **品检锚批次**，两个品检动作（通过 / 打回）共用它。
   *
   * 由 shell 传进来（不是本层自己派生），因为口径要把「用户在批次表里选中了哪一行」
   * 算进去 —— `selectedBatchId` 是 shell 的局部态。派生函数是纯函数
   * `./inspectionBatch.ts::resolveInspectionBatch`，shell 调一次即可同时喂按钮显隐 /
   * 弹窗回显 / 本 bindings 三处，三者必然同批。
   *
   * 2026-10-10 review 第 1 轮订正：口径从「只按 `find(status==='INSPECTION')` 取列表序
   * 第一条」改为「选中的批次是 INSPECTION 就用它，否则回落 `find(INSPECTION)`」。前者
   * 修好了「两个按钮锚不同批」，却把「尊重用户选择」修没了 —— 用户在批次表选中 B2、
   * 点「指定工序」却打在 B1 上，与改之前同样看不出来（界面上只显示锚批次，而那时显示的
   * 也不是他选的那条）。后端 `fix(batch): find_current_inspection_batch_id 遇多
   * INSPECTION 批次改返 id 不返 500` 说明多 INSPECTION 批次是真实场景。
   *
   * 判据读**批次**而不是 `part.status`：`t_part.status` 是 min-progress 派生列，同工单
   * 只要还有任一批次进度更靠前，整单就派生成那个更早的状态 ⇒ 多批次工单上会出现
   * 「批次是 INSPECTION、`t_part.status` 却是 IN_PROCESS」而整排按钮消失、该批次永远
   * 动不了。后端 `prod/batch/service/transition_core.rs::to_ship_core` 有同款警告。
   */
  inspectionBatch: ComputedRef<PartBatch | null>;
}

/**
 * 失效详情页三条读键（写操作完成后调；返回 `Promise<void>` 让调用方可 await）。
 *
 * 三条并行发起（`Promise.all`）而非逐条 await：三者互不依赖，且都是本端点**必然**
 * 变了的那几份数据（工单本体 / 批次集合 / 事件流水）——串行等于把一次写后刷新的
 * 延迟从 1 个 RTT 叠成 3 个，拆批弹窗的 `resolve(true)`（shell 等 mutateAsync 才关框）
 * 会被整串拖慢。`invalidateQueries` 自己会去重 / 合并在飞的请求，并行不会打重复往返。
 *
 * 失效失败**不**把一次成功的写报成失败：失效是「让别的视图尽快看到」的优化，
 * 不是成败判据。三条共用一个 try/catch ⇒ 任一条 reject 都不外泄。
 */
async function invalidatePartDetailCaches(qc: QueryClient): Promise<void> {
  try {
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.partDetailPrefix }),
      qc.invalidateQueries({ queryKey: qk.partEventsPrefix }),
      qc.invalidateQueries({ queryKey: qk.partBatchesPrefix }),
    ]);
  } catch {
    /* 失效只是「让别的视图尽快看到」，失败不该把一次成功的写报成失败。 */
  }
}

/** 40901 分流：他人已改 → warning（提示用户重试，失效链已把最新值拉回来）；
 *  其余 → 原文错误。两个出口都由调用方的 onError 补全套失效。 */
function reportWriteError(e: unknown, fallbackPrefix: string): void {
  const err = e as ApiError;
  if (err?.code === OCC_CONFLICT) {
    ElMessage.warning('该记录已被他人修改，已为你刷新，请重试');
    return;
  }
  ElMessage.error(`${fallbackPrefix}${err?.message ?? '操作失败'}`);
}

export function usePartDetailActions(bindings: PartDetailActionBindings) {
  const qc = useQueryClient();
  const { dangerous: confirmDangerous } = useConfirm();

  // mutationKey 一律写字面量：工厂项服务的是 queryKey 的缓存身份，mutation 不进任何
  // query 缓存，登记进 qk 只会留下零消费者的死键（同 `useInspectionListStore` 的
  // scanTree mutation 注释）。命名沿 parts 域既有的 `[parts, <场景>, <动作>]` 三段形。

  // ============ 行内编辑：保存 ============
  const saveMutation = useMutation({
    mutationKey: ['parts', 'detail', 'update'],
    mutationFn: (payload: PartUpdatePayload) => updatePart(toValue(bindings.partId) ?? '', payload),
    onSuccess: async () => {
      ElMessage.success('保存成功');
      await invalidatePartDetailCaches(qc);
    },
    onError: async (e: Error & { code?: number }) => {
      reportWriteError(e, '保存失败：');
      await invalidatePartDetailCaches(qc);
    },
  });

  // ============ 取消订单（后端级联取消全部活跃批次 → part 翻 CANCELLED）============
  // 出参是 part 级窄投影 PartOutDto（后端不返工单全字段）⇒ 一律靠失效链重拉，
  // 不做本地回写。
  const cancelOrderMutation = useMutation({
    mutationKey: ['parts', 'detail', 'cancel'],
    mutationFn: () => cancelPart(toValue(bindings.partId) ?? ''),
    onSuccess: async () => {
      ElMessage.success('已取消');
      await invalidatePartDetailCaches(qc);
    },
    onError: async (e: Error & { code?: number }) => {
      reportWriteError(e, '取消订单失败：');
      await invalidatePartDetailCaches(qc);
    },
  });

  // ============ 软删零件 ============
  // 后端 `PartSoftDeleteRequest.version` 必填（无 serde(default)），不发 body → 422。
  //
  // ⚠️ **成功分支刻意不失效本页三条读键，改失效 `qk.partsPrefix`（列表域）**：
  // 软删之后 `GET /parts/{id}` 的 SQL 带 `AND deleted_at IS NULL`（后端
  // `part/repo/sql/part_sql.rs::get_part_detail`）⇒ 目标资源已经**不存在**，按 part
  // 维度失效会让详情 / 事件 / 批次三条读端点各打一次注定 404 的请求，并让详情 query
  // 的 error 桥接弹一句「零件不存在」—— 那是一次**成功**的删除带来的假错误。
  // 该失效真正要解决的是「零件一览里还留着刚删掉的那一行」，那是 `partsPrefix` 的
  // 读域（列表 SQL 同样过滤软删行，重拉只会得到正确结果）。onError 仍走全套失效：
  // 失败时零件还在，本端三条读键该刷还是要刷。
  const softDeleteMutation = useMutation({
    mutationKey: ['parts', 'detail', 'soft-delete'],
    mutationFn: (version: number) => softDeletePart(toValue(bindings.partId) ?? '', version),
    onSuccess: async () => {
      ElMessage.success('已删除');
      await qc
        .invalidateQueries({ queryKey: qk.partsPrefix })
        .then(() => undefined)
        .catch(() => undefined);
    },
    onError: async (e: Error & { code?: number }) => {
      reportWriteError(e, '删除失败：');
      await invalidatePartDetailCaches(qc);
    },
  });

  // ============ 品检通过（INSPECTION → READY_TO_SHIP）============
  // ⚠️ 不可撤销，保留二次确认（原本在 usePartDetail 内，行为不变），确认文案补出批次
  // 标识 —— 锚批次由 `inspectionBatch` 派生，与「指定工序」是同一条。
  const toShipMutation = useMutation({
    mutationKey: ['parts', 'detail', 'inspection-to-ship'],
    mutationFn: (batch: PartBatch) => toShip(batch.id, { version: batch.version, quantity: null }),
    onSuccess: async () => {
      ElMessage.success('品检通过');
      await invalidatePartDetailCaches(qc);
    },
    onError: async (e: Error & { code?: number }) => {
      reportWriteError(e, '品检通过失败：');
      await invalidatePartDetailCaches(qc);
    },
  });

  // ============ 品检打回 / 指定下一道工序（INSPECTION → IN_PROCESS）============
  // payload 不再收 batchId：锚批次由 bindings 派生（见 PartDetailActionBindings
  // .inspectionBatch），不再由 shell 传 `selectedBatchId` —— 那正是两个品检按钮锚口径
  // 不一致的根因。
  const toProcessMutation = useMutation({
    mutationKey: ['parts', 'detail', 'inspection-to-process'],
    mutationFn: (vars: { batch: PartBatch; processId: string; note: string | null }) =>
      toProcess(vars.batch.id, {
        next_process_id: vars.processId,
        version: vars.batch.version,
        note: vars.note,
      }),
    onSuccess: async () => {
      ElMessage.success('已指定下一道工序');
      await invalidatePartDetailCaches(qc);
    },
    onError: async (e: Error & { code?: number }) => {
      reportWriteError(e, '指定工序失败：');
      await invalidatePartDetailCaches(qc);
    },
  });

  // ============ 拆批（POST /batches/split，batch_id 走 body 且是 **字符串**）============
  // version / quantity 是**裸 number**，与 batch_id 的字符串口径正好相反（后端逐字段
  // 挂了各自的反序列化器），照 `api/batch.contract.ts` 的注释发，不要互相套用；发错
  // 一档都是 HTTP 422 纯文本、响应里没有 code。
  // 出参是拆分结果对象（实际拆走量 + 新批次 id + 源批次新 version），调用方只判成败。
  const splitMutation = useMutation({
    mutationKey: ['parts', 'detail', 'batch-split'],
    mutationFn: (vars: { batch: PartBatch; quantity: number }) =>
      splitBatch({
        batch_id: vars.batch.id,
        quantity: vars.quantity,
        version: vars.batch.version,
      }),
    onSuccess: async () => {
      ElMessage.success('拆分成功');
      await invalidatePartDetailCaches(qc);
    },
    onError: async (e: Error & { code?: number }) => {
      reportWriteError(e, '拆分失败：');
      await invalidatePartDetailCaches(qc);
    },
  });

  // ============ 取消批次 ============
  // ⚠️ 别与 part 域的 `POST /parts/{id}/cancel` 混：那条是「取消该 part 的**全部**
  // 活跃批次」，本条是批次级取消。出参是 part 级窄投影 PartOutDto（单个对象，不是
  // 批次数组），行数据靠失效链重拉。
  const cancelBatchMutation = useMutation({
    mutationKey: ['parts', 'detail', 'batch-cancel'],
    mutationFn: (batch: PartBatch) => cancelPartBatch(batch.id, batch.version),
    onSuccess: async () => {
      ElMessage.success('批次已取消');
      await invalidatePartDetailCaches(qc);
    },
    onError: async (e: Error & { code?: number }) => {
      reportWriteError(e, '取消批次失败：');
      await invalidatePartDetailCaches(qc);
    },
  });

  // ============ action 门面（一律 Promise<boolean>）============
  //
  // `mutateAsync` 失败时 reject；错误提示（含 40901 分流）已由各 mutation 的 `onError`
  // 统一发出，门面这层只把它翻译成 `false` 供 shell 决定后续（关框 / 跳转），不重复弹提示。

  /** 行内编辑保存。成功后是否退出编辑态由 shell 决定，本函数只报成败。
   *
   *  入参**不含** `version`：OCC 锚由本层从 `part.version` 统一补，避免调用侧与数据层
   *  各取一次锚而两者不一致。 */
  async function onSave(payload: Omit<PartUpdatePayload, 'version'>): Promise<boolean> {
    const part = bindings.part.value;
    if (!part) {
      ElMessage.error('零件信息未加载完成');
      return false;
    }
    // OCC 锚取 **part 级** `version`（`t_part.version`），不是批次版本。
    return runMutation(() => saveMutation.mutateAsync({ ...payload, version: part.version }));
  }

  async function onCancelOrder(): Promise<boolean> {
    return runMutation(() => cancelOrderMutation.mutateAsync());
  }

  async function onDeletePart(): Promise<boolean> {
    const part = bindings.part.value;
    if (!part) {
      ElMessage.error('零件信息未加载完成');
      return false;
    }
    return runMutation(() => softDeleteMutation.mutateAsync(part.version));
  }

  /** 品检通过。锚批次缺失时直接失败（不该发生：按钮可见性已按它门控）。 */
  async function onPassInspection(): Promise<boolean> {
    const batch = bindings.inspectionBatch.value;
    if (!batch) {
      ElMessage.error('未找到待过检批次');
      return false;
    }
    const ok = await confirmDangerous(
      '品检通过',
      `确认将批次 ${batch.batch_label}（${batch.quantity} 件）标记为品检通过？此操作不可撤销。`,
      { type: 'success', confirmText: '确认通过', cancelText: '取消' },
    );
    if (!ok) return false;
    return runMutation(() => toShipMutation.mutateAsync(batch));
  }

  /** 品检打回（指定下一道工序）。锚批次与「品检通过」同一个 —— 见 bindings 注释。
   *
   *  状态守卫保留：判据从「shell 传来的 batchId 对应的批次」改成「派生的
   *  `inspectionBatch` 本身」—— 没有 `status === 'INSPECTION'` 的批次就拒绝，且提示里
   * 说明品检流转以批次状态为准、请去批次列表确认。 */
  async function onFailInspection(payload: {
    processId: string;
    note: string | null;
  }): Promise<boolean> {
    const batch = bindings.inspectionBatch.value;
    if (!batch) {
      ElMessage.warning('当前没有处于品检中的批次；品检流转以批次状态为准，请先在批次列表确认');
      return false;
    }
    return runMutation(() =>
      toProcessMutation.mutateAsync({
        batch,
        processId: payload.processId,
        note: payload.note,
      }),
    );
  }

  /** 拆批。返回拆分结果（实际拆走量 + 新批次 id + 源批次新 version）供调用方判成败；
   *  行数据靠失效链重拉。失败返回 null（提示已由 onError 发出）。 */
  async function onSplitBatch(batch: PartBatch, quantity: number): Promise<BatchSplitDto | null> {
    return splitMutation.mutateAsync({ batch, quantity }).catch(() => null);
  }

  async function onCancelBatch(batch: PartBatch): Promise<boolean> {
    return runMutation(() => cancelBatchMutation.mutateAsync(batch));
  }

  return {
    onSave,
    onCancelOrder,
    onDeletePart,
    onPassInspection,
    onFailInspection,
    onSplitBatch,
    onCancelBatch,
    /** 行内保存的 pending 态（PartInfoCard 的 save 按钮 `:loading`）。
     *
     *  ⚠️ **只导出这一个 pending 态**：其余 6 个写操作的 pending 由 shell 自己维护
     * （`passSubmitting` / `confirmSubmitting` / `failInspSubmitting` 三个局部 ref）——
     * 那些 loading 圈的是**对话框内的确认按钮**，必须在 shell 里跟对话框的开关同生共死
     * （关框即复位）。导出第二个合成 pending 只会让读代码的人以为两个来源会打架。 */
    saving: saveMutation.isPending,
  };
}

/** 跑一次 mutation 并把 reject 翻译成 `false`（错误提示已由 mutation 的 `onError` 发出）。 */
async function runMutation(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    return false;
  }
}
