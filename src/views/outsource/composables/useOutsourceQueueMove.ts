// 外协看板「发送 / 回收」写操作 composable（`POST /api/v2/outsource-queue/move`）。
//
// 角色：
//   - 提供 2 个方向包装（sendToCompany / receiveToProduction），全部收口同一个
//     `moveMutation`，视图层（Sortable 落点 / 卡片右键菜单）只消费这两个函数、
//     不直接 import 本文件；
//   - 收发合一的理由：`t_part_batch` 的 `location` / `current_holder_id` / `version`
//     三列在三个方向上是同一组列，拆成三个端点只会把同一份事务边界写三遍；
//   - 每个包装的入参都带 `version`（OCC 锚，取自卡片 model，经卡片
//     `:data-batch-version` → DOM dataset 传递）：move 改的是批次位置 / 持有者，属
//     并发敏感写，**缺 version 时后端返 HTTP 422 纯文本**，不是业务信封；
//   - mutationFn 走 `outsourceMoveResultSchema.parse()` 守门；
//   - 写后集中失效「快照前缀 + 单工序看板前缀」两个域。
//
// 失效链为什么是「前缀全失效」：一次发送会同时改掉左列（候选批次离开）与右列（目标
// 公司多一张在途卡），一次回收会同时改掉右列（该批次离开）与左列（下一道工序上多一张
// 候选卡）—— 跨 tab、跨公司列都有。mutation 回调能拿到的只有卡片 model，拿不到受影响的
// processId，精确失效必然漏刷。
//
// 拖拽投放与本文件的三条硬约定（不要改，继承生产队列的踩坑结论）：
//   1. 两侧容器的 Sortable 形态**不同**，各自的原因不能互相套用：
//      - **投放落点**（公司列 `CompanyColumn.vue`）走**二参**（不传 list）：它的渲染源是
//        props 派生的数组，传 list 会让库挂上内建 `onRemove`（内建 handler 假定 list 就是
//        渲染源）⇒ DOM 放回随之消失，必须自己补 `onRemove: restoreNodeToSource`，否则
//        投放失败时幻影卡片留在落点列、失效也清不掉；
//      - **拖拽源**（候选池 `CandidatePool.vue`）走**三参 + 本地副本 list**：把一个不是渲染源
//        的副本 list 传给库，换回内建 `onRemove` 的 `from.insertBefore(...)`（无论成败先把
//        被拖节点放回源列）。
//   2. 空态用兄弟覆盖层（pointer-events: none），别把投放容器 v-if 摘掉 —— **空公司列
//      必须仍是合法投放目标**（后端 `companies[]` 特意返 `held_count = 0` 的空列）；
//   3. 卡片组件根必须是单元素（BatchCard 已满足），且容器内不许留模板注释（dev 构建
//      保留注释，注释节点也算容器的直接子节点）。
//   守卫：src/components/__tests__/BatchCardDndFootprint.spec.ts。
//
// 2026-10-09 三条发送契约的形态（与旧端点 `POST /batches/{id}/send-to-outsource` 的
// 逐字对照，守卫在 __tests__/useOutsourceQueueMove.spec.ts 的 M19 组）：
//   ① **请求体里没有任何工序键**。旧端点的 body 键叫 `process_id`（而行字段叫
//     `current_process_id`，沿行字段名必然 422）；新端点干脆不传工序 —— 批次当前所属的
//     外协工序由后端按 `t_part_batch` 真实位置自推。照旧字段名拼进 body 会被 serde 当
//     未知字段 / 错类型拒（HTTP 422 纯文本，错误文案对用户毫无意义）。
//   ② `quote_id` 与 `direct` **必传其一**（都不传或同时传 → 20104）。恒满足
//     「APPROVAL 传 quote_id + direct=null / DIRECT 传 direct=true + quote_id=null」；
//     回收方向两者都必须是 null。
//   ③ **没有 `quantity` 字段**（旧端点的 `quantity: null` 表示整批）。move 是整批语义，
//     部分收发要先拆批（`POST /batches/split`）。
//
// 2026-10-10：目标货架不再由前端指定 —— `to.shelf_id` 与 `kind='INSPECTION_SHELF'`
// 变体后端一并删除，「回收品检」方向下线。`receiveToInspection` 与第三个包装随之删除。

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { moveOutsourceBatch } from '@/api/outsource';
import type { OutsourceMoveRequestDto, OutsourceMoveResultDto } from '@/api/outsource.contract';
import { useAuthStore } from '@/stores/auth';
import type {
  OutsourceQueueCandidateData,
  OutsourceQueueHeldBatchData,
} from './outsourceQueueSchema';
import { outsourceMoveResultSchema } from './outsourceQueueSchema';
import { invalidateOutsourceQueueProcessAll } from './useOutsourceQueueProcessQuery';
import { invalidateOutsourceQueueSnapshotAll } from './useOutsourceQueueSnapshotQuery';

/** 「无下一道工序」的哨兵值 —— 后端投影层已把 `NULL` 吃成 0 并序列化成字符串 `"0"`
 *  （**不是 null**）。判定「工序链推不出下一道工序」必须比 `'0'`，写成
 *  「缺失 / null」会在真实数据上失效。 */
const NO_NEXT_PROCESS = '0';

/** 「发送」入参。APPROVAL 与 DIRECT 两条报价路径的差别全部体现在 `companyId` 的来源
 *  上（APPROVAL 必须是报价锁定的公司，DIRECT 必须是下拉选项之一），模式本身由
 *  `candidate.send_mode` 决定 —— 不另设入参，避免调用方传一个与候选行矛盾的模式。 */
export interface SendToCompanyInput {
  /** 左列候选卡 DTO：`version` / `send_mode` / `quote_id` / `company_options` /
   *  `shelf_id` 五条发送锚都在它上面。 */
  candidate: OutsourceQueueCandidateData;
  /** 目标外协公司 id。APPROVAL 行须等于 `candidate.outsource_company_id`；DIRECT 行须
   *  命中 `candidate.company_options`。 */
  companyId: string;
  /** 可选，写入事件 note。 */
  note?: string | null;
}

/** 「回收到生产」入参。
 *
 *  `companyId` / `batch` **必须成对来自同一张公司列**：在途卡 DTO 上没有公司字段
 *  （公司 id 只挂在 `companies[]` 的列上），单独给 batch 会组不出 `from.company_id`。
 *
 *  2026-10-10：目标货架由后端按负载自动选（`to.shelf_id` 已删），入参不再有货架。 */
export interface ReceiveToProductionInput {
  /** 批次所在的外协公司（`from.company_id`）。 */
  companyId: string;
  /** 右列在途卡 DTO：`version` / `receive_next_process_id` / `chain_resolvable`。 */
  batch: OutsourceQueueHeldBatchData;
  /** 用户手选的下一道工序。仅当 `receive_next_process_id === '0'`（工序链推不出）时
   *  才需要；留空时由后端从工序链推导，推不出返 20706。 */
  nextProcessId?: string | null;
  note?: string | null;
}

export interface UseOutsourceQueueMoveReturn {
  /** 最近一次写操作错误信息（视图层 el-alert 展示）。成功时置 null。 */
  error: Ref<string | null>;
  /** 是否有收发权限 —— 与后端 `require_any_role([Manager, Clerk, Inspector])` 逐字
   *  对齐：少放一个角色 ⇒ 用户点了吃 40300；多放一个 ⇒ 用户点了才知道没权限。
   *  菜单 / 投放容器在 open 之前用它闸掉无权角色。 */
  canMove: ComputedRef<boolean>;
  /** 候选卡 → 外协公司（发送）。APPROVAL 走 `quote_id`，DIRECT 走 `direct = true`。 */
  sendToCompany: (input: SendToCompanyInput) => Promise<boolean>;
  /** 外协公司 → 生产货架（回收生产；目标货架由后端自动选）。 */
  receiveToProduction: (input: ReceiveToProductionInput) => Promise<boolean>;
}

export function useOutsourceQueueMove(): UseOutsourceQueueMoveReturn {
  // useQueryClient() 必须在 setup 第一行捕获，不能挪进回调惰性取。
  const qc = useQueryClient();
  // 消费侧禁止解构 auth store（store proxy 已自动解包 ref）。
  const auth = useAuthStore();
  const error = ref<string | null>(null);

  const canMove = computed<boolean>(
    () => auth.hasRole('MANAGER') || auth.hasRole('CLERK') || auth.hasRole('INSPECTOR'),
  );

  /** 写操作完成后集中失效「单工序看板 + 快照」两个域（全是前缀失效，理由见文件头）。
   *  返回 Promise 让 mutation 回调 await 完整失效链再弹 toast，避免两个域的 refetch
   *  重叠。⚠️ 在 mutation 的 onSuccess / onError 里调用时异常由 mutation 框架 catch；
   *  但三个包装函数的入参早退分支是**裸 await**，那条路上必须自己兜（见
   *  reconcileAfterEarlyReturn），否则 invalidateQueries 一抛就是未捕获 rejection。 */
  async function invalidateMoveDomains(): Promise<void> {
    await invalidateOutsourceQueueSnapshotAll(qc);
    await invalidateOutsourceQueueProcessAll(qc);
  }

  /** 入参早退路径的失效兜底。
   *  早退意味着「投放已经发生、写操作没发生」：卡片被拖到落点列却没有对应的 move。
   *  屏幕与服务器的偏差由**源侧**的 onRemove（restoreNodeToSource）抹平，那才是这条路径
   *  的必需项；这里失效一次是防御性对账。异常必须在此吞掉：早退的用户可见反馈已由
   *  ElMessage.warning 承担，invalidateQueries 抛错不该再冒一个 unhandledrejection。 */
  async function reconcileAfterEarlyReturn(): Promise<void> {
    try {
      await invalidateMoveDomains();
    } catch {
      // 失效失败无可展示动作；下一次写操作 / 刷新按钮会重拉。
    }
  }

  /** 成功 toast 文案按方向分（两向）。用 `to_kind` 判已经够用 —— 两向的 `to_kind`
   *  两两不同（OUTSOURCE_COMPANY / PRODUCTION_SHELF），
   *  从 SOURCE 那一侧判会与「发送 / 回收」的语气反着来。 */
  function moveSuccessText(res: OutsourceMoveResultDto): string {
    switch (res.to_kind) {
      case 'OUTSOURCE_COMPANY':
        return '已发送到外协公司';
      case 'PRODUCTION_SHELF':
        return '已从外协公司回收至生产';
    }
  }

  /** `POST /outsource-queue/move`：mutationFn 走 `outsourceMoveResultSchema.parse()`
   *  守门 —— `shipment_id` / `new_process_id` 在 rust 侧带 `skip_serializing_if`，方向
   *  不满足时整个键从 JSON 省略，schema 用 `.nullish()` 兜住；契约漂移立刻抛 ZodError
   *  由 onError 接管。
   *
   *  onError 也失效本域：失败路径这次失效是**防御性对账**、不是必需项（失败时服务器
   *  没有任何变化，重拉只会拿回同一份数据）；真正有实质价值的是「本端副本已过期」那类
   *  失败 —— 40901（OCC，他人并发改动）与位置不符类错误：本端看到的批次状态已经旧了，
   *  只能靠重拉纠正。⚠️ 卡片节点本身的归位不靠这次失效：源侧的 onRemove
   *  （restoreNodeToSource）已在 drop 事件里把它放回源列。 */
  const moveMutation = useMutation<OutsourceMoveResultDto, Error, OutsourceMoveRequestDto>({
    mutationKey: ['outsource-queue', 'move'],
    // 不写 retry（信任 main.ts 全局 mutations.retry: 0）。
    mutationFn: async (payload) =>
      outsourceMoveResultSchema.parse(await moveOutsourceBatch(payload)),
    onSuccess: async (res) => {
      await invalidateMoveDomains();
      error.value = null;
      ElMessage.success(moveSuccessText(res));
    },
    onError: async (e: Error) => {
      error.value = e.message ?? '外协收发失败';
      ElMessage.error(e.message ?? '外协收发失败');
      await invalidateMoveDomains();
    },
  });

  /** version 守卫（三个包装共用）。
   *
   *  `POST /outsource-queue/move` 的 `version` 是必填的 OCC 锚（后端 serde 无
   *  `#[serde(default)]` ⇒ 缺字段返 HTTP 422 **纯文本**，不是业务信封，错误文案对用户
   *  毫无意义），所以宁可不发请求也不能发一个注定被拒的 move。
   *
   *  判据是 `typeof !== 'number' || !Number.isFinite(...)` 两条而不是只看 typeof：
   *  调用侧从卡片 dataset 读 version（`Number.parseInt(dataset.x ?? '', 10)`），
   *  dataset 缺失时得到的是 **NaN** —— 它 `typeof` 是 `number`，只查 typeof 会让它
   *  穿过守卫。 */
  async function guardVersion(version: number | undefined): Promise<boolean> {
    if (typeof version === 'number' && Number.isFinite(version)) return true;
    ElMessage.warning('批次版本信息缺失，无法移动');
    await reconcileAfterEarlyReturn();
    return false;
  }

  /** 「发送」包装 —— 目标公司 id 为空早退（不发注定被 20104 拒的请求）。
   *
   *  两条早退都走一次失效对账，且包 try/catch 防止未捕获 rejection：
   *   1. version 缺失 / NaN（见 guardVersion）；
   *   2. 目标公司与该行的 `send_mode` 不自洽（APPROVAL 传了别的公司 / DIRECT 选了不在
   *      `company_options` 里的公司 / DIRECT 的 `company_options` 为空）。三个子情形都
   *      是「请求组装不出来」而不是「用户填错」—— 公司下拉的选项源就是 DTO 那两个字段。
   *
   *  ⚠️ 2026-10-10：「批次尚未上架」不再是发请求前的早退项 —— 后端 `from` 守卫只查
   *  `batch.location` 是否为 `PRODUCTION_SHELF`，这类行 location 是 null、必被拒，
   *  但那是服务端判定。UI 侧的「未上架不给发送到」仍然保留（见 `candidateIsPending`
   *  / `isCandidateDraggable`）—— 那条是给用户看的可执行性提示，不是请求组装约束。 */
  async function sendToCompany(input: SendToCompanyInput): Promise<boolean> {
    const { candidate, companyId } = input;
    if (!(await guardVersion(candidate.version))) return false;
    if (!companyId) {
      ElMessage.warning('请先选择外协公司');
      await reconcileAfterEarlyReturn();
      return false;
    }
    // 报价路径与免审批路径必须与候选行的 send_mode 严格对齐：APPROVAL 用报价锁定的
    // 公司（quote_id + direct=null），DIRECT 用下拉选出的公司（direct=true + quote_id=null）。
    const isApproval = candidate.send_mode === 'APPROVAL';
    if (isApproval && (!candidate.quote_id || companyId !== candidate.outsource_company_id)) {
      ElMessage.warning('报价与目标外协公司不匹配');
      await reconcileAfterEarlyReturn();
      return false;
    }
    if (!isApproval && !candidate.company_options.some((o) => o.id === companyId)) {
      ElMessage.warning('所选外协公司不在可发送范围内');
      await reconcileAfterEarlyReturn();
      return false;
    }
    try {
      await moveMutation.mutateAsync({
        batch_id: candidate.batch_id,
        version: candidate.version,
        from: { kind: 'PRODUCTION_SHELF' },
        to: { kind: 'OUTSOURCE_COMPANY', company_id: companyId },
        // 两条报价路径互斥：都不传或同时传 → 后端 20104
        quote_id: isApproval ? candidate.quote_id : null,
        direct: isApproval ? null : true,
        ...(input.note != null ? { note: input.note } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 「回收生产」包装 —— 只守 version 与下一道工序两项（目标货架 2026-10-10 起由后端
   *  按负载自动选，前端不再指定）。
   *
   *  下一道工序的取值顺序：**用户手选优先**，否则用 DTO 上的
   *  `receive_next_process_id`（后端投影已按工序链算好）；两者都没有时后端也会尝试从
   *  工序链推导，但链推不出（`"0"`）就返 20706 —— 与其发一个注定被拒的请求，不如提示
   *  用户补选工序。 */
  async function receiveToProduction(input: ReceiveToProductionInput): Promise<boolean> {
    const { companyId, batch } = input;
    if (!(await guardVersion(batch.version))) return false;
    const nextProcessId =
      input.nextProcessId ||
      (batch.receive_next_process_id !== NO_NEXT_PROCESS ? batch.receive_next_process_id : '');
    if (!nextProcessId) {
      ElMessage.warning('该批次没有下一道工序，请先选择接收工序');
      await reconcileAfterEarlyReturn();
      return false;
    }
    try {
      await moveMutation.mutateAsync({
        batch_id: batch.batch_id,
        version: batch.version,
        from: { kind: 'OUTSOURCE_COMPANY', company_id: companyId },
        to: { kind: 'PRODUCTION_SHELF', next_process_id: nextProcessId },
        // 回收方向不涉及报价
        quote_id: null,
        direct: null,
        ...(input.note != null ? { note: input.note } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  return {
    error,
    canMove,
    sendToCompany,
    receiveToProduction,
  };
}
