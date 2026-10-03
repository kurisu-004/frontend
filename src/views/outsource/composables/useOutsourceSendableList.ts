// composables/useOutsourceSendableList.ts
//
// 可发送 tab 的业务状态 + 业务函数（2026-08-25 T12 从 OutsourceSendReceive.vue 抽出）。
//
// 持有：
//   - sendableFilter：filter bar 持久化（pageSize 不再持久化，详见 2026-08-31 注释）
//   - sendablePagedRef：<PagedTable> 模板 ref（用于 fetch / reset）
//   - sendQueue / batchSending / scanInput：扫码批量发送队列（PR-I 2026-07-20）
//   - sendDialogVisible / sendTarget / sendSelectedCompanyId / sendQuantity /
//     sendSubmitting：发送 dialog 状态（行级 + 扫码级共用）
//
// 不持有：
//   - customers（页级共享 lookup，由 shell 持有并下传）
//   - activeTab（页级 shell 持有）
//   - 接收 tab 相关状态
//
// 子组件约定：
//   - OutsourceSendableTab 通过 props 读 sendableFilter / sendQueue / sendDialogXxx，
//     通过 emit('sent') 把发送成功事件上抛给页级 shell，
//     shell 收到后调 receivingTabRef.refresh() 联动刷新「待接收」tab。
//
// 跨 composable 通信：
//   - opts.onSent()：发送成功（单件 + 批量均会触发）→ shell 拿这个钩子去刷 receiving tab。
//     这里不直接持有 receiving tab 的 refresh 引用，是为了保持 composable 单例纯净。
//
// 2026-09-16 PR-3：sendToOutsource 后端新增前置校验 —— part.process_chain_id 非空，
// 否则 20706 BIZ_PROCESS_CHAIN_REQUIRED。onConfirmSend（单件）+ onConfirmBatchSend（批量）
// 都接 handleProcessChainRequired 兜底：命中 → 弹「前往制定」确认框 → 跳
// /production/process-design?part_id=XXX；批量命中即 break 不再继续。

import { ElMessage } from 'element-plus';
import { reactive, ref, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  getPartBySerial,
  sendToOutsource as sendPartToOutsource,
  type PartItem,
  type SendToOutsourcePayload,
} from '@/api/parts';
import { listOutsourceSendable } from '@/api/outsource';
import { useConfirm } from '@/composables/useConfirm';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import { handleProcessChainRequired } from '@/composables/useProcessChainRequiredHandler';
import type { OutsourceSendableItem } from '@/types/outsource';

/** 与 OutsourceSendReceive.vue 同步：合并后的可发送项类型别名 */
export type SendableItem = OutsourceSendableItem;

export interface SendQueueItem {
  part: { id: string; serial_no: string; drawing_no: string; name: string };
  outsource_company_id: string;
  outsource_company_name: string;
  process_id: string;
  process_name: string;
  /** 直接发送时为 null；APPROVAL 时为单件报价 */
  price: number | null;
  /** OCC：发送时必传（批次 TPartBatch.version） */
  version: number;
  /** 2026-07-29 PR-fix-0.2.0 批次化：可发送批次 id（雪花 ID 字符串） */
  batch_id: string;
  /** 2026-07-30：发送数量（默认批次全量） */
  quantity: number;
  /** 2026-10-03：APPROVAL 行回指的报价 id；DIRECT 行为 null。
   *  批量发送与单件发送共用同一 payload 组装，缺它则 APPROVAL 路径组不出
   *  `quote_id` ⇒ 每条都返 400。 */
  quote_id: string | null;
  /** 2026-10-03：DIRECT 标记（发送时传 `direct: true`；APPROVAL 行恒 false） */
  direct: boolean;
  // 入队后做标记，给 UI 看
  _failed?: boolean;
  _failMsg?: string;
}

export interface UseOutsourceSendableListOptions {
  /** 发送成功后回调（shell 用来触发 receiving tab 刷新） */
  onSent?: () => void;
}

/** 组装 `POST /prod/batches/{batch_id}/send-to-outsource` 的 body。
 *
 *  2026-10-03 契约对齐，三处要点：
 *  1. 工序键是 **`process_id`**，不是 `current_process_id`（后端 DTO 就是 `process_id`，
 *     沿用行字段名必然 422）。列表行上的字段是 `current_process_id`（批次当前所属的
 *     外协工序），只是 body 键叫 `process_id`。
 *  2. 发送模式由 `quote_id` / `direct` **必传其一**表达，两者都不传后端返 400：
 *     APPROVAL → `quote_id` 有值 + `direct: null`；DIRECT → `direct: true` + `quote_id: null`。
 *  3. `quantity` 两条发送路径的口径**不同但语义等价**，都不是「部分发送」的错写法：
 *     单件路径把「等于 batch_quantity」归一成 `null`；扫码批量路径原样传队列里的
 *     `quantity`（入队时取自 `batch_quantity`，恒等于整批量）。后端
 *     `resolve_partial_quantity` 把 `q == batch_quantity` 与 `q == null` 同归整批，
 *     所以两条路径都发整批。真正的部分发送只在用户把发送数量调到小于
 *     `batch_quantity` 时才发生（单件路径经 `sendQuantity`，批量路径经队列项）。
 *
 *  单件发送与扫码批量发送共用本函数 —— 两条路径曾各写一份 payload，是这次
 *  「改了一处漏另一处」的高风险面。 */
function buildSendPayload(args: {
  outsource_company_id: string;
  /** 源行的 `current_process_id`（外协工序 id） */
  process_id: string;
  version: number;
  /** 源行的 `quote_id`（DIRECT 行为 null） */
  quote_id: string | null;
  direct: boolean;
  quantity: number | null;
}): SendToOutsourcePayload {
  return {
    outsource_company_id: args.outsource_company_id,
    process_id: args.process_id,
    version: args.version,
    quote_id: args.direct ? null : args.quote_id,
    direct: args.direct ? true : null,
    quantity: args.quantity,
  };
}

/** `<PagedTable>` 模板 ref 暴露出来的成员（本 composable 实际用到的部分）。
 *
 *  提取成具名类型的两个原因：
 *  1. `ref()` 无初值会推断成 `Ref<any>`，于是 `sendablePagedRef.value?.items.value`
 *     这类把已解包成员当 ref 再读一层的错误**不报 TS 错**（`any` 上任何属性访问都合法），
 *     运行时恒得 undefined。显式标注后同类回归直接变成编译错误。
 *  2. 成员一律声明为**必填**：`PagedTable.vue` 的 `defineExpose` 无条件解构出这些成员，
 *     ref 的 `value` 一旦就位它们必然齐全。写可选（`?`）会逼调用点写 `?.()`，把「成员
 *     缺失」这个本该响的 TypeError 吞成静默 no-op。必填声明换来的是**赋值点检查** ——
 *     往这个 ref 塞一个缺成员的对象（测试桩、换组件）直接编译报错。
 *
 *  ⚠️ 本接口是**手写**的运行时形状声明，与 `PagedTable` 的 `defineExpose` 之间没有编译期
 *  关联：模板用的是字符串 ref（`ref="sendablePagedRef"`），Vue 按名字在运行时回填。
 *  所以「PagedTable 改了成员名」不会被这里拦下，那属于组件侧的独立契约问题。 */
export interface SendablePagedTableExpose {
  total?: number;
  /** 组件 public instance 上是**已解包**的数组（不是 Ref，见 handleScannedSerialForSend） */
  items: SendableItem[];
  fetch: () => Promise<void>;
  reset: () => Promise<void>;
}

/** 2026-09-21 显式返回类型。 */
export interface UseOutsourceSendableListReturn {
  sendableError: Ref<string | null>;
  sendableFilter: { keyword: string; customer_id: string };
  sendablePagedRef: Ref<SendablePagedTableExpose | undefined>;
  sendQueue: Ref<SendQueueItem[]>;
  batchSending: Ref<boolean>;
  scanInput: Ref<string>;
  sendDialogVisible: Ref<boolean>;
  sendTarget: Ref<SendableItem | null>;
  sendSelectedCompanyId: Ref<string>;
  sendQuantity: Ref<number>;
  sendSubmitting: Ref<boolean>;
  restore: () => Record<string, unknown> | null;
  snapshot: () => void;
  clearPersisted: () => void;
  sendableFetcher: (params: {
    page: number;
    pageSize: number;
  }) => Promise<{ items: SendableItem[]; total: number }>;
  refreshSendable: () => Promise<void>;
  onSendableSearch: () => void;
  onSendableReset: () => void;
  sendableRowClassName: (ctx: { row: SendableItem }) => string;
  canSend: (item: SendableItem) => boolean;
  openSend: (item: SendableItem) => void;
  onConfirmSend: () => Promise<void>;
  handleScannedSerialForSend: (code: string) => Promise<void>;
  onScanInputEnter: () => void;
  onScanInputClear: () => void;
  removeFromSendQueue: (idx: number) => void;
  clearSendQueue: () => void;
  onConfirmBatchSend: () => Promise<void>;
}

export function useOutsourceSendableList(
  options: UseOutsourceSendableListOptions = {},
): UseOutsourceSendableListReturn {
  // 2026-09-17 PR-3 修复：useRouter() 必须在 setup 顶部一次性拿闭包复用，禁止在 async 事件回调里调
  // —— vue-router 4.6.4 + vue 3.5.38 下 inject() 在 lifecycle hook 之外返回 undefined。
  const router = useRouter();

  const { dangerous: confirmDangerous } = useConfirm();

  // ============ 列表 filter（持久化） ============
  // 2026-08-31 双实例修复：pageSize 不再持久化（与 ListShell 一致），
  // 每次进入视图从 <PagedTable :default-page-size="20"> 起算。
  const sendableError = ref<string | null>(null);
  const sendableFilter = reactive({ keyword: '', customer_id: '' });
  const sendablePagedRef = ref<SendablePagedTableExpose>();

  // 可发送 tab 持久化（2026-07-30 commit 4B）；2026-08-25 T7：page 不再持久化
  const persist = useListStatePersist('outsource_send_receive_sendable', { sendableFilter });

  async function sendableFetcher(params: { page: number; pageSize: number }) {
    sendableError.value = null;
    try {
      const r = await listOutsourceSendable({
        keyword: sendableFilter.keyword || undefined,
        customer_id: sendableFilter.customer_id || undefined,
        limit: params.pageSize,
        offset: (params.page - 1) * params.pageSize,
      });
      return { items: r.items, total: r.total };
    } catch (e) {
      sendableError.value = (e as Error).message ?? '加载可发送列表失败';
      ElMessage.error(sendableError.value);
      return { items: [], total: 0 };
    }
  }

  // ref 的 `value` 在 <PagedTable> 挂载前是 undefined（故对 value 用可选链），
  // 成员本身必填（见 SendablePagedTableExpose）—— 成员缺失要响，不要静默 no-op。
  async function refreshSendable(): Promise<void> {
    await sendablePagedRef.value?.fetch();
  }

  function onSendableSearch(): void {
    void sendablePagedRef.value?.reset();
  }
  function onSendableReset(): void {
    sendableFilter.keyword = '';
    sendableFilter.customer_id = '';
    void sendablePagedRef.value?.reset();
  }

  // ============ 加急行红底 ============
  function sendableRowClassName({ row }: { row: SendableItem }): string {
    return row.is_urgent ? 'row-urgent' : '';
  }

  // ============ 发送 dialog 状态 ============
  const sendDialogVisible = ref(false);
  const sendTarget = ref<SendableItem | null>(null);
  const sendSelectedCompanyId = ref<string>('');
  const sendQuantity = ref<number>(0);
  const sendSubmitting = ref(false);

  function canSend(item: SendableItem): boolean {
    if (item.status_label !== 'sendable') return false;
    if (item.send_mode === 'DIRECT') {
      return item.company_options.length >= 1;
    }
    // APPROVAL: outsource_company_id 由后端确定
    return true;
  }

  function openSend(item: SendableItem): void {
    if (!canSend(item)) {
      ElMessage.warning('该零件当前状态不满足发送条件');
      return;
    }
    sendTarget.value = item;
    sendQuantity.value = item.batch_quantity;
    // 直接发送：默认选第一家公司（不能为空数组；前端必有 ≥1）
    if (item.send_mode === 'DIRECT') {
      sendSelectedCompanyId.value = item.company_options[0]?.id ?? '';
    } else {
      sendSelectedCompanyId.value = '';
    }
    sendDialogVisible.value = true;
  }

  async function onConfirmSend(): Promise<void> {
    if (!sendTarget.value) return;
    const target = sendTarget.value;
    if (target.send_mode === 'DIRECT' && !sendSelectedCompanyId.value) {
      ElMessage.warning('请选择外协公司');
      return;
    }
    if (sendQuantity.value < 1 || sendQuantity.value > target.batch_quantity) {
      ElMessage.warning(`数量必须在 1 ~ ${target.batch_quantity} 之间`);
      return;
    }
    const companyId: string =
      target.send_mode === 'DIRECT'
        ? sendSelectedCompanyId.value
        : (target.outsource_company_id ?? '');
    const companyName: string =
      target.send_mode === 'DIRECT'
        ? (target.company_options.find((c) => c.id === sendSelectedCompanyId.value)?.name ?? '')
        : (target.outsource_company_name ?? '');
    if (
      !(await confirmDangerous(
        '发送外协',
        `确认把「${target.part_drawing_no}」（批次 ${target.batch_no}，${sendQuantity.value} / ${target.batch_quantity} 件）发送到「${companyName}」？`,
        { type: 'warning', confirmText: '确认发送', cancelText: '取消' },
      ))
    )
      return;
    sendSubmitting.value = true;
    try {
      const payload: SendToOutsourcePayload = buildSendPayload({
        outsource_company_id: companyId,
        process_id: target.current_process_id,
        version: target.version,
        quote_id: target.quote_id,
        direct: target.send_mode === 'DIRECT',
        quantity: sendQuantity.value === target.batch_quantity ? null : sendQuantity.value,
      });
      // 2026-10-02：发送端点迁 prod 域并以批次为锚，batch_id 已是路径参数。
      await sendPartToOutsource(target.batch_id, payload);
      ElMessage.success('已发送至外协');
      sendDialogVisible.value = false;
      await refreshSendable();
      // 发送成功后该零件应出现在「待接收」tab，主动 refresh 一次
      options.onSent?.();
    } catch (e) {
      // 2026-09-16 PR-3：20706 BIZ_PROCESS_CHAIN_REQUIRED 兜底 —— 弹「前往制定」框；
      // 命中后不走普通 ElMessage.error 兜底。
      const handled = await handleProcessChainRequired(e, target.part_id, router);
      if (!handled) {
        ElMessage.error((e as Error).message ?? '发送失败');
      }
    } finally {
      sendSubmitting.value = false;
    }
  }

  // ============ 扫码批量发送队列（PR-I 2026-07-20） ============
  const sendQueue = ref<SendQueueItem[]>([]);
  const batchSending = ref(false);
  const scanInput = ref('');

  async function handleScannedSerialForSend(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) return;
    let part: PartItem;
    try {
      part = await getPartBySerial(trimmed);
    } catch (e) {
      ElMessage.error(`序列号 ${trimmed} 未找到：${(e as Error).message}`);
      return;
    }
    // 已在队列里？
    if (sendQueue.value.find((q) => q.part.id === part.id)) {
      ElMessage.warning(`${part.serial_no ?? trimmed} 已在发送队列中`);
      return;
    }
    // 必须在当前可发送列表里（status_label === 'sendable'）
    // 2026-08-25 T7：sendableItems 已迁到 PagedTable；通过暴露的 items 读取当前页。
    // ⚠️ 读 `.items` 而**不是** `.items.value`：模板 ref 拿到的是组件 public
    // instance，Vue 的 proxyRefs 已把 `defineExpose` 出来的 ref 解包成数组，多读一层
    // `.value` 恒得 undefined ⇒ sendableList 恒为 [] ⇒ 扫码入队这条路永远走不到
    // 「已加入发送队列」（只弹「当前不在可发送列表」）。`SendablePagedTableExpose.items`
    // 声明的是数组而非 Ref，正是为了让这行写成 `.items.value` 时直接编译不过。
    const sendableList = sendablePagedRef.value?.items ?? [];
    const match = sendableList.find(
      (it) => it.part_id === part.id && it.status_label === 'sendable',
    );
    if (!match) {
      ElMessage.warning(
        `${part.serial_no ?? trimmed} 当前不在可发送列表（可能状态不满足或没有 APPROVED 报价）`,
      );
      return;
    }
    // 直接发送 + 多公司 → 强制用户先选公司（不让扫码盲目入队）
    if (match.send_mode === 'DIRECT' && match.company_options.length > 1) {
      sendTarget.value = match;
      sendSelectedCompanyId.value = match.company_options[0]?.id ?? '';
      sendDialogVisible.value = true;
      ElMessage.info('该外协工序映射了多家公司，请先在弹窗中选择后再扫码入队');
      return;
    }
    // 直接发送 + 单公司 或 APPROVAL → 直接入队
    const companyId: string =
      match.send_mode === 'DIRECT'
        ? (match.company_options[0]?.id ?? '')
        : (match.outsource_company_id ?? '');
    const companyName: string =
      match.send_mode === 'DIRECT'
        ? (match.company_options[0]?.name ?? '')
        : (match.outsource_company_name ?? '');
    sendQueue.value.push({
      part: {
        id: part.id,
        serial_no: part.serial_no ?? '',
        drawing_no: part.drawing_no,
        name: part.name,
      },
      outsource_company_id: companyId,
      outsource_company_name: companyName,
      process_id: match.current_process_id ?? '',
      process_name: match.current_process_name ?? '',
      price: match.send_mode === 'DIRECT' ? null : Number(match.price),
      version: match.version,
      // 2026-07-29 PR-fix-0.2.0 批次化：携带 batch_id 供发送时回传
      batch_id: match.batch_id,
      // 2026-07-30：默认批次全量
      quantity: match.batch_quantity,
      // 2026-10-03：随队列携带模式判据，批量发送时才能组出 quote_id / direct。
      quote_id: match.quote_id,
      direct: match.send_mode === 'DIRECT',
    });
    ElMessage.success(`已加入发送队列：${part.serial_no ?? trimmed}`);
  }

  function onScanInputEnter(): void {
    const code = scanInput.value;
    scanInput.value = '';
    void handleScannedSerialForSend(code);
  }

  function onScanInputClear(): void {
    scanInput.value = '';
  }

  function removeFromSendQueue(idx: number): void {
    sendQueue.value.splice(idx, 1);
  }

  function clearSendQueue(): void {
    sendQueue.value = [];
  }

  async function onConfirmBatchSend(): Promise<void> {
    if (sendQueue.value.length === 0) return;
    if (
      !(await confirmDangerous(
        '批量发送',
        `确认批量发送 ${sendQueue.value.length} 件零件到外协？`,
        { type: 'warning', confirmText: '确认发送', cancelText: '取消' },
      ))
    )
      return; // 用户取消
    batchSending.value = true;
    const errors: { serial: string; msg: string; idx: number }[] = [];
    let okCount = 0;
    // 2026-09-16 PR-3：批量路径接 20706 兜底；命中后批量循环 break（用户先去补单工艺链）。
    let processChainRequiredHit = false;
    // 串行 for 循环：避免并发踩状态机；失败项保留在队列可重试
    for (let i = 0; i < sendQueue.value.length; i++) {
      const item = sendQueue.value[i];
      if (processChainRequiredHit) break;
      try {
        const payload: SendToOutsourcePayload = buildSendPayload({
          outsource_company_id: item.outsource_company_id,
          process_id: item.process_id,
          version: item.version,
          quote_id: item.quote_id,
          direct: item.direct,
          quantity: item.quantity,
        });
        // 2026-10-02：发送端点迁 prod 域并以批次为锚，batch_id 已是路径参数。
        await sendPartToOutsource(item.batch_id, payload);
        okCount++;
        // 成功后从队列移除
        sendQueue.value.splice(i, 1);
        i--; // 抵消 splice 导致的位移
      } catch (e) {
        // 20706 兜底：弹确认框 → 跳工艺制定页；命中即中断后续发送
        const handled = await handleProcessChainRequired(e, item.part.id, router);
        if (handled) {
          processChainRequiredHit = true;
          const msg = (e as Error).message ?? '请先制定工序链';
          errors.push({
            serial: item.part.serial_no || item.part.drawing_no,
            msg,
            idx: i,
          });
          sendQueue.value[i]._failed = true;
          sendQueue.value[i]._failMsg = msg;
          break;
        }
        const msg = (e as Error).message ?? '未知错误';
        errors.push({
          serial: item.part.serial_no || item.part.drawing_no,
          msg,
          idx: i,
        });
        sendQueue.value[i]._failed = true;
        sendQueue.value[i]._failMsg = msg;
      }
    }
    batchSending.value = false;
    if (okCount > 0) {
      ElMessage.success(`成功发送 ${okCount} 件`);
      await refreshSendable();
      options.onSent?.();
    }
    if (errors.length > 0) {
      ElMessage.error(
        `失败 ${errors.length} 件：${errors.map((e) => `${e.serial} (${e.msg})`).join('; ')}`,
      );
    }
  }

  return {
    // state
    sendableError,
    sendableFilter,
    sendablePagedRef,
    sendQueue,
    batchSending,
    scanInput,
    sendDialogVisible,
    sendTarget,
    sendSelectedCompanyId,
    sendQuantity,
    sendSubmitting,
    // 持久化恢复（shell 在 onMounted 里调一次，把 snapshot 写回 sendableFilter）
    restore: persist.restore,
    snapshot: persist.snapshot,
    clearPersisted: persist.clear,
    // handlers
    sendableFetcher,
    refreshSendable,
    onSendableSearch,
    onSendableReset,
    sendableRowClassName,
    canSend,
    openSend,
    onConfirmSend,
    handleScannedSerialForSend,
    onScanInputEnter,
    onScanInputClear,
    removeFromSendQueue,
    clearSendQueue,
    onConfirmBatchSend,
  };
}

// 类型 re-export 方便模板里直接 `import type { SendableItem } from '../composables/useOutsourceSendableList'`
export type { OutsourceSendableItem };
