// views/parts/list/composables/useSerialRelease.ts
//
// 2026-10-19 新增：一键释放「已完成 / 已取消工单仍占用的序列号」的工具栏入口后端。
//
// 需求由来：现场残留大量已完成工单仍占着序列号（装配件尤其多），号池被这些死号压住、
// 新建工单拿不到号。本域提供**全局一键**清理，入口挂在零件一览页工具栏。
//
// 三条设计取舍：
//
// 1. **无自有业务筛选状态**：这是全局一键，不吃列表筛选 / 分页 / 勾选 —— 后端是全表扫，
//    界面上也没有任何一个筛选控件能把「只看当前页」传进去。本 composable 只持有对话框态
//    与两条 mutation；刻意**不**接 `usePartsListStore` 的 query / filters / batch 任何
//    切片，否则会让人误以为释放范围与列表筛选有关。
//
// 2. **判据是角色不是权限点**：后端 `/serials/release-terminal` 是 handler 层
//    `require_role(Role::Manager)`，RBAC 面板里**没有** `serial.*` 这样的码。CLAUDE.md
//    「RBAC」一节：只有前端-only 的动作才自造权限点（照 `printTemplatePermissions.ts`），
//    这里前端有后端同款闸门，自造一个码就是「前端比后端宽 / 窄」的分叉 ⇒ 走 `hasRole`。
//    ADMIN 由 `hasRole` 通配（`stores/auth.ts`），不必额外判。
//
// 3. **两段式**：`dry_run: true` 先预览（零写入），把计数与明细摆进二次确认框；管理员点
//    「确认释放」才发 `dry_run: false`。两条形状完全对称、端点同一条。
//
// 两条 mutation 都**不写 `retry`**：全局 `mutations.retry: 0`（CLAUDE.md「TanStack Query」），
// 非幂等的释放动作也绝不重试。

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/vue-query';
import { releaseTerminalSerials } from '@/api/serial';
import { qk } from '@/composables/queries/keys';
import { useAuthStore } from '@/stores/auth';
import { releaseTerminalSerialsOutSchema } from './serialReleaseSchema';
import type { ReleaseTerminalSerialsData } from './serialReleaseSchema';

export interface UseSerialReleaseReturn {
  /** 入口可见性（角色 MANAGER，ADMIN 由 hasRole 通配）。 */
  canReleaseSerials: ComputedRef<boolean>;
  /** 预览对话框显隐（壳上 v-model 绑它；进 Pinia store 后由 store proxy 自动解包）。 */
  previewOpen: Ref<boolean>;
  /** 预览结果；null = 还没预览过 / 预览失败。 */
  preview: Ref<ReleaseTerminalSerialsData | null>;
  /** 预览在途（工具栏按钮 loading）。 */
  previewPending: ComputedRef<boolean>;
  /** 实跑在途（对话框确认按钮 loading）。 */
  applyPending: ComputedRef<boolean>;
  /** 打开对话框：先跑一次 dry_run 预览，成功才弹。 */
  onOpenPreview: () => Promise<void>;
  /** 对话框「确认释放」。 */
  onConfirmRelease: () => Promise<void>;
  /** 对话框「取消」。 */
  onCancelPreview: () => void;
}

/**
 * 失效本次释放波及的全部域。**逐条注释说明为什么含这个前缀** —— 加前缀与不加前缀都
 * 是决定，理由丢了就只能靠猜。
 *
 * ⚠️ 返回 Promise<void>（`.then(() => undefined)`）而不是 `invalidateQueries` 本身的
 * Promise：调用方要 await 的是「失效链的 refetch 已 settle」，`void` 一发即弃会失去这个
 * 语义（同 `useDeliveryNoteListStore.ts::invalidateDeliveryNotesQuery`）。
 */
export function invalidateSerialReleaseDomain(qc: QueryClient): Promise<void> {
  // 装配件 / 零件一览：`qk.partsPrefix` 之下挂着 unionList（`GET /com/union-list`），
  // 它是零件一览整页的数据源，也是本次释放后序列号列变化最直接的地方。
  const parts = qc.invalidateQueries({ queryKey: qk.partsPrefix }).then(() => undefined);
  // 装配件详情（`qk.assemblyPrefix`）：详情页展示 serial_no，释放后必须重取。
  const assembly = qc.invalidateQueries({ queryKey: qk.assemblyPrefix }).then(() => undefined);
  // 零件详情页（`qk.partDetailPrefix`）：同样展示 serial_no。
  const partDetail = qc.invalidateQueries({ queryKey: qk.partDetailPrefix }).then(() => undefined);
  // 统计域（`qk.statisticsPrefix`）：工人详情里的行 VO 带 `serial_no`，其可空语义正是
  // 「流水号已被释放」（见 `views/statistics/composables/statisticsSchema.ts` 里
  // `workerPartItemSchema.serial_no` 的注释），本次释放会把它变成空串/null。
  const statistics = qc.invalidateQueries({ queryKey: qk.statisticsPrefix }).then(() => undefined);
  // dashboard（`qk.dashboardPrefix`）：三 query 的 gcTime 是 POSITIVE_INFINITY 且无
  // refetchInterval，常驻大屏（另一个标签页）收不到本 mutation 的回调 —— 只有这条失效
  // 是共屏兜底（理由同 `usePartDispatch.ts` 里 dashboard 那条；跨屏的真通道是 WS 的
  // `TERMINAL_SERIALS_RELEASED`，见 `useDashboardInvalidation` 白名单）。
  const dashboard = qc.invalidateQueries({ queryKey: qk.dashboardPrefix }).then(() => undefined);
  // ⚠️ **刻意不加 `qk.productionQueueSnapshotPrefix`**：队列候选池的判据是 `status`，本次
  // 只改 `serial_no`、不改 `status`，队列看板不会因为释放序列号而改变成员资格；而且队列
  // 看板永远不与零件一览页挂在同一个 tab，`invalidateQueries` 只作用于本标签页的
  // QueryClient ⇒ 加进来是死代码。
  return Promise.all([parts, assembly, partDetail, statistics, dashboard]).then(() => undefined);
}

export function useSerialRelease(): UseSerialReleaseReturn {
  const qc = useQueryClient();
  // 消费侧禁止解构 store（沿 CLAUDE.md「auth / 会话」一节）。
  const auth = useAuthStore();

  // 入口判据：角色 MANAGER（见文件头第 2 条取舍）。
  const canReleaseSerials = computed(() => auth.hasRole('MANAGER'));

  const previewOpen = ref(false);
  const preview = ref<ReleaseTerminalSerialsData | null>(null);

  /**
   * `preview` 的**唯一清位点**：`previewOpen` 一旦变 false 就把明细一起丢掉。
   *
   * ⚠️ 为什么收在这里而不是让每条关闭路径各清一次：对话框有三条关闭路径（右上角 ×、
   * 「取消」、实跑成功后的自动关闭），只有前两条经过 `onCancelPreview`；× 只 emit
   * `update:modelValue`、不发业务事件，清位一旦漏在调用方 wiring 上，`preview` 就会留下一份
   * 「上一次的、已消费过的、对应一次不可逆操作」的明细快照 —— 将来任何人加一条「失败后保留
   * 上次预览重开」的路径，就会把**已经消费掉的明细**重新摆给管理员看。watch 收口后，
   * 新增任何关闭路径都自动带上清理，不必记得补第二处。
   *
   * 刻意不 `immediate`：初值就是 false，不需要首帧就清一次。
   */
  watch(previewOpen, (open) => {
    if (!open) preview.value = null;
  });

  /** 预览（dry_run）。只有拿到经守门的响应才开对话框 —— 预览失败时对话框内容没意义，
   *  让管理员在一个空框上点「确认释放」比不弹更危险。
   *
   *  两条 mutation 都不写泛型参数也不写 `retry`：mutationFn 无入参（TVariables 由推断
   *  得出，显式写 `void` 会被 `@typescript-eslint/no-invalid-void-type` 拒），而全局
   *  `mutations.retry: 0`（CLAUDE.md「TanStack Query」），非幂等的释放动作也绝不重试。 */
  const previewMutation = useMutation({
    mutationKey: ['serials', 'release-terminal', 'preview'],
    mutationFn: async () =>
      releaseTerminalSerialsOutSchema.parse(await releaseTerminalSerials({ dry_run: true })),
    onSuccess: (data) => {
      preview.value = data;
      previewOpen.value = true;
    },
    // 预览是纯读，失败不触发任何失效（本域什么都没写）。
    onError: (e: Error) => ElMessage.error(e.message ?? '读取待释放序列号失败'),
  });

  /** 实跑（dry_run: false）。不可撤销，成败都要让本端副本与后端对齐。
   *
   *  ⚠️ **回显断言**（2026-10-19 补）：后端 `ReleaseTerminalRequest.dry_run` 是
   *  `#[serde(default)]`，**空 body 等价于 `dry_run: false` 即真跑**（后端 dto.rs 的注释
   *  把这条登记为已知风险）。它同时承诺「与入参原样回显，供前端确认这次到底是预览还是实跑」
   *  —— 前端既然在 schema 里要了这个键，就得真的比一次：回显若是 `true`，说明这次拿到的
   *  是一份**预览口径**的响应，此时若照常弹「已释放 N 个」，管理员会以为号已经回池而实际
   * 并没有（且下一步新建工单照样拿不到号）。不符即抛，走既有的 `onError`（失效 + 报错），
   * 绝不报成功。 */
  const applyMutation = useMutation({
    mutationKey: ['serials', 'release-terminal', 'apply'],
    mutationFn: async () => {
      const data = releaseTerminalSerialsOutSchema.parse(
        await releaseTerminalSerials({ dry_run: false }),
      );
      if (data.dry_run !== false) {
        throw new Error('释放结果异常：后端回显 dry_run=true（请求的是实跑），请刷新后核对序列号');
      }
      return data;
    },
    onSuccess: async (data) => {
      ElMessage.success(
        `已释放 ${data.assembly_count} 个装配件 / ${data.part_count} 个零件的序列号`,
      );
      // 只翻显隐：明细的清位统一由 previewOpen 的 watch 承担（见上方注释），不再各清一次
      previewOpen.value = false;
      await invalidateSerialReleaseDomain(qc);
    },
    // ⚠️ **失败也失效**：后端是单事务整体成败，但响应可能在 commit 之后丢失（网关超时 /
    // 连接被重置），此时本端列表里的序列号已经过期；不刷就继续按「占着号」误导管理员。
    // 与 `useDeliveryNoteListStore` 的 delivery mutation 同款理由。
    onError: async (e: Error) => {
      await invalidateSerialReleaseDomain(qc);
      ElMessage.error(e.message ?? '释放序列号失败');
    },
  });

  const previewPending = computed(() => previewMutation.isPending.value);
  const applyPending = computed(() => applyMutation.isPending.value);

  async function onOpenPreview(): Promise<void> {
    await previewMutation.mutateAsync().catch(() => undefined);
  }

  async function onConfirmRelease(): Promise<void> {
    // ⚠️ **函数里也设一道闸**（对话框 `:disabled` 不是唯一闸门）：`onConfirmRelease` 是挂在
    // store 切片上的**公开方法**，任何调用方（新增入口、将来的「保留上次预览」重开路径、
    // 直接在控制台调）都能绕过按钮的 disabled。本仓对不可逆 / 破坏性动作的 house style 是
    // 「在包装入口也设一道闸」，不是只靠 UI（`useQueueMove` 的 `queue.allocate` 早退 +
    // warning + 零请求、`usePrintTemplatesStore::uploadChecked` 判不出版式直接拒收、
    // `usePartBatchPdf` 提交前逐行校验客户）。判据两条与按钮的 `:disabled` **逐字同源**
    // （同一份 preview），别让它们各写一套。
    // 早退**不发任何请求、也不做失效对账**（与 `useQueueMove` 的早退相反）：那条路发过请求
    // 才失败、本端列表可能已经不一致；这里一个请求都没发，后端数据原封不动，失效纯属白刷。
    if (!preview.value || preview.value.released_total === 0) {
      ElMessage.warning('没有可释放的序列号，未执行');
      return;
    }
    await applyMutation.mutateAsync().catch(() => undefined);
  }

  function onCancelPreview(): void {
    // `preview` 的清位由 previewOpen 的 watch 统一承担（见上方注释），这里只翻显隐 ——
    // 显隐一落 false 那条 watch 也会把明细丢掉，两处各清一次反而多一个可能漂移的点。
    previewOpen.value = false;
  }

  return {
    canReleaseSerials,
    previewOpen,
    preview,
    previewPending,
    applyPending,
    onOpenPreview,
    onConfirmRelease,
    onCancelPreview,
  };
}
