<!--
  InspectionPending.vue — 品检待办一览（INSPECTION 状态的批次）

  2026-10-03 重构（列表交互 + 迁 TanStack Query）：
  - 顶部 filter 卡瘦身：图号 / 名称 / 序列号 / 日期筛选**全部搬进表头 popover**
    （照零件一览的范式），顶部只留「刷新」+「自动刷新（5min）」+「共 N 条」。
  - 列表脱离 `<ListShell>`：改用 `<InspectionTable>`（自建 el-table + 表头筛选 +
    服务端排序 + 列可见性/拖动），状态全部来自 `useInspectionListStore`。
  - 后端 VO 收口为 13 字段（`InspectionQueueItem`）：表格只显示 7 个数据列
    （序列号 / 图号 / 名称 / 批次 / 数量 / 系统交期 / 客户）+ 操作列。

  2026-10-05（扫码路径重做）：扫码不再走「当前页列表命中 → 二选一 → 批次选择弹窗 →
  part 级序列号兜底 → 快捷品检弹窗」五路分流，改成**一次**请求拿回
  「装配件 → 子零件 → 全部批次」三层树（`GET /api/v2/prod/inspection/scan/{serial_no}`），
  由 `<ScanTreeDialog>` 展示；「品检通过」/「指定工序」两个按钮在该树里就地 emit 回本页，
  复用本页**已有**的同款对话框（数量输入 / 部分通过提示 / 工序+货架+备注选择都在那边，
  本页因此不再需要任何「扫码专用」的流转弹窗）。
  旧路的取舍：列表命中只覆盖本页当前筛选 + 分页里的行，扫到别的页上的件要走 part 级
  序列号兜底并按 status / location 分流，跨页与多批次都要靠用户在二级弹窗里再选一次；
  新树一次给全，操作列按批次状态直接给出可执行动作。

  保留能力（与 2026-10-03 版一致）：品检通过 / 指定工序两个弹窗 + 扫码订阅 +
  5min 自动刷新（query hook 的 refetchInterval）+ 加急红底 + 部分通过拆批提示 +
  40901 冲突提示。
-->
<template>
  <div class="inspection-pending">
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <el-button @click="onRefresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
        <el-checkbox v-model="store.ui.autoRefresh">自动刷新（5min）</el-checkbox>
        <span v-if="store.query.total > 0" class="total-hint">共 {{ store.query.total }} 条</span>
      </div>
    </el-card>

    <InspectionTable ref="tableRef" />

    <div class="pagination">
      <el-pagination
        v-model:current-page="store.query.page"
        v-model:page-size="store.query.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="store.query.total"
        layout="total, sizes, prev, pager, next, jumper"
        :pager-count="7"
        background
        size="small"
      />
    </div>

    <!-- 品检通过对话框（带数量；部分通过时后端先拆批再过）
         2026-10-06 补 `append-to-body`：本弹窗由 ScanTreeDialog 的「品检通过」按钮
         打开，而 ScanTreeDialog 已 `append-to-body`（teleport 到 body）。本弹窗若留在
         原位就落在 `layouts/MainLayout.vue:275` 的 `.main-content { position: relative;
         z-index: 1 }` 那个 **stacking context** 里 —— 它的 z-index 被该上下文封顶，
         而 ScanTreeDialog 作为 body 下的后继兄弟在**根** stacking context 里参与排序，
         于是「后开的弹窗反而被先开的压住」，数量弹窗点不动。
         同 `views/com/delivery/components/BatchInspectionConfirmDialog.vue` 的嵌套弹窗范式。 -->
    <el-dialog
      v-model="passDialogVisible"
      title="品检通过"
      :width="passDlg.width"
      :top="passDlg.top"
      :close-on-click-modal="false"
      append-to-body
      @closed="onPassDialogClosed"
    >
      <div v-if="passTarget" class="fail-summary">
        <div><strong>流水号：</strong>{{ passTarget.serial_no || '—' }}</div>
        <div><strong>批次：</strong>{{ passTarget.batch_no }}</div>
        <div><strong>名称：</strong>{{ passTarget.name }}</div>
      </div>
      <el-form label-width="96px" style="margin-top: 12px">
        <el-form-item label="通过数量" required>
          <el-input-number
            v-model="passQty"
            :min="1"
            :max="passTarget?.quantity"
            :precision="0"
            style="width: 160px"
          />
          <span v-if="passTarget" class="muted" style="margin-left: 8px">
            / {{ passTarget.quantity }}
          </span>
        </el-form-item>
        <el-alert
          v-if="passTarget && passQty && passQty < passTarget.quantity"
          type="info"
          :closable="false"
          :title="`部分通过：剩余 ${passTarget.quantity - passQty} 件将留在品检状态`"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="passDialogVisible = false">取消</el-button>
        <el-button
          type="success"
          :loading="store.mutations.passingBatchId === passTarget?.batch_id"
          :disabled="!passQty"
          @click="onPassConfirm"
          >确认通过</el-button
        >
      </template>
    </el-dialog>

    <!-- 指定工序对话框：先选下一道工序，再选目标生产货架（按 shelf↔process 映射过滤）
         2026-10-06 补 `append-to-body`，理由同上方「品检通过」弹窗的注释
         （由 ScanTreeDialog 打开，且须压过它）。 -->
    <el-dialog
      v-model="failDialogVisible"
      title="指定工序 — 选择下一道工序 + 目标生产货架"
      :width="failDlg.width"
      :top="failDlg.top"
      :close-on-click-modal="false"
      append-to-body
      @closed="onFailDialogClosed"
    >
      <div v-if="failTarget" class="fail-summary">
        <div><strong>流水号：</strong>{{ failTarget.serial_no || '—' }}</div>
        <div><strong>批次：</strong>{{ failTarget.batch_no }}</div>
        <div><strong>图号：</strong>{{ failTarget.drawing_no }}</div>
        <div><strong>名称：</strong>{{ failTarget.name }}</div>
      </div>

      <el-form label-width="96px" style="margin-top: 12px">
        <el-form-item label="数量" required>
          <el-input-number
            v-model="failQty"
            :min="1"
            :max="failTarget?.quantity"
            :precision="0"
            style="width: 160px"
          />
          <span v-if="failTarget" class="muted" style="margin-left: 8px">
            / {{ failTarget.quantity }}
          </span>
        </el-form-item>

        <el-form-item label="下一道工序" required>
          <el-select
            v-model="failProcessId"
            placeholder="请先选择下一道工序"
            filterable
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="p in filteredProcesses"
              :key="p.id"
              :value="String(p.id)"
              :label="`${p.code} — ${p.name}`"
            >
              {{ p.code }} — {{ p.name }}
              <el-tag
                v-if="p.category === 'OUTSOURCE'"
                type="warning"
                size="small"
                effect="plain"
                class="opt-tag"
              >
                外协
              </el-tag>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="目标生产货架" required>
          <el-select
            v-model="failShelfId"
            placeholder="先选工序；货架候选按映射过滤"
            filterable
            clearable
            style="width: 100%"
            :disabled="!failProcessId"
          >
            <el-option
              v-for="s in filteredProductionShelves"
              :key="s.id"
              :value="String(s.id)"
              :label="`${s.code} — ${s.name}`"
              :disabled="!s.is_active"
            >
              {{ s.code }} — {{ s.name }}
              <span v-if="!s.is_active" class="muted">（已停用）</span>
            </el-option>
            <template #empty>
              <span class="muted">
                {{
                  failProcessId
                    ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                    : '请先选择下一道工序'
                }}
              </span>
            </template>
          </el-select>
        </el-form-item>

        <el-form-item label="品检备注">
          <el-input
            v-model="failNote"
            type="textarea"
            :rows="3"
            :maxlength="500"
            show-word-limit
            placeholder="不合格原因 / 返修要点（写入事件历史，工人领取时可见）"
          />
        </el-form-item>

        <el-alert
          type="info"
          :closable="false"
          title="指定工序后零件回到「在生产货架上」状态，下一道工序与备注已写入事件历史；工人领取时可在卡片上看到备注。"
          show-icon
        />
      </el-form>

      <template #footer>
        <el-button @click="failDialogVisible = false">取消</el-button>
        <el-button
          type="warning"
          :loading="failSubmitting"
          :disabled="!failProcessId || !failShelfId"
          @click="onFailConfirm"
          >确认指定工序</el-button
        >
      </template>
    </el-dialog>

    <!-- 扫码命中的「装配件 → 子零件 → 批次」树（2026-10-05）。品检架候选由本页从
         store.options 传入（子组件不读 store.options）；「品检通过」「指定工序」在树里
         抛行给本页，弹上面那两个既有对话框，不在本组件里重造。 -->
    <ScanTreeDialog
      v-model="scanTreeOpen"
      :inspection-shelves="store.options.inspectionShelves"
      @pass="onScanTreePass"
      @assign-process="onScanTreeAssignProcess"
    />
  </div>
</template>

<script setup lang="ts">
// views/inspection/InspectionPending.vue
//
// 2026-10-03 重构壳：列表状态 / 列定义 / 筛选 / 写操作全部下沉到
// `useInspectionListStore`（Pinia setup store，4 不变量见该文件头）。本壳只保留：
//   - 顶部 filter 卡（刷新 / 自动刷新 / 共 N 条）；
//   - InspectionTable（承载全部表格 DOM 逻辑）；
//   - 分页（page / pageSize 在 store，切页改 queryKey 自动 refetch）；
//   - 品检通过 / 指定工序两个弹窗 + 扫码树弹窗；
//   - 生命周期编排：restoreState（开 enabled 闸门）、排序箭头恢复、扫码订阅、
//     store.$dispose()（轮询定时器由 query hook 的 refetchInterval 自管，本壳无 timer）。
//
// 导航（详情 / 零件链接）留在壳内 —— store 不 import vue-router（不变量 #4）。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { useConfirm } from '@/composables/useConfirm';
import { useDialogSize } from '@/composables/useDialogSize';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import type { InspectionQueueItem, ScanBatchOut } from '@/api/inspection';
import { INSPECTION_SORT_KEY_TO_PROP } from '@/types/inspection';
import InspectionTable from './components/InspectionTable.vue';
import ScanTreeDialog from './components/ScanTreeDialog.vue';
import { useInspectionListStore } from './composables/useInspectionListStore';

/** 两个既有弹窗（品检通过 / 指定工序）要读的行字段集合。
 *  `InspectionQueueItem`（待品检列表 VO，13 字段）天然满足它 —— 多字段结构兼容，
 *  列表的操作列照旧直接传；扫码树弹窗抛的是 `ScanBatchOut`，它在父组件里与**父级零件
 *  节点**的序列号 / 图号 / 名称组装成同一形态（这三个字段只存在于零件节点上，
 *  批次节点没有）。 */
interface InspectionBatchRow {
  batch_id: string;
  batch_no: number;
  quantity: number;
  /** `t_part_batch.version` —— 两个写端点的 OCC 锚。 */
  version: number;
  serial_no: string | null;
  drawing_no: string;
  name: string;
}

// 不变量 #1：壳 setup 顶部首调 store。
const store = useInspectionListStore();
const router = useRouter();

const tableRef = ref<InstanceType<typeof InspectionTable> | null>(null);

// ============ 操作列动作注入（弹窗 / 导航都在壳内）============
function onPass(row: InspectionQueueItem): void {
  openPassDialog(row);
}
function onOpenFail(row: InspectionQueueItem): void {
  openFailDialog(row);
}
function onDetail(row: InspectionQueueItem): void {
  void router.push(`/parts/${row.part_id}`);
}
store.registerActions({ onPass, onOpenFail, onDetail });

// ============ 手动刷新 / 自动刷新 ============
// 自动刷新勾选直接 v-model 到 store.ui.autoRefresh，轮询由 store 的 query hook
// （useInspectionQueueQuery 的 refetchInterval，5min）承担 —— 本壳不再持有 timer，
// 也不需要 onMounted 起停 / onBeforeUnmount 清理。
async function onRefresh(): Promise<void> {
  await store.query.fetchList();
}

// pageSize 变化时 page 复位（照 PartsList.vue 语义，避免停在一个已不存在的页）。
// watch 源必须是 getter：store.query.pageSize 经 Pinia 解包后是 number，直接 watch
// 一个 number 追不到响应式。
watch(
  () => store.query.pageSize,
  (newSize, oldSize) => {
    if (oldSize !== undefined && newSize !== oldSize && store.query.page > 1) {
      store.query.page = 1;
    }
  },
);

// ============ 品检通过（带数量，部分通过先拆再过）============
const passDlg = useDialogSize({ desktopWidth: 420 });
const passDialogVisible = ref(false);
const passTarget = ref<InspectionBatchRow | null>(null);
const passQty = ref<number | undefined>(undefined);

function openPassDialog(row: InspectionBatchRow): void {
  passTarget.value = row;
  passQty.value = row.quantity;
  passDialogVisible.value = true;
}

function onPassDialogClosed(): void {
  passTarget.value = null;
  passQty.value = undefined;
}

async function onPassConfirm(): Promise<void> {
  const row = passTarget.value;
  if (!row || !passQty.value) return;
  // 行内按钮 loading 锚：只让被提交的这一行转圈（旧版往 row 上挂 `_passing`）。
  store.mutations.passingBatchId = row.batch_id;
  try {
    // 品检通过 = `POST /prod/batches/{batch_id}/to-ship`（INSPECTION → READY_TO_SHIP，
    // 事件 INSPECTED）；OCC 锚 t_part_batch.version。
    await store.mutations.toShipMutation.mutateAsync({
      batchId: row.batch_id,
      version: row.version,
      quantity: passQty.value,
      label: row.serial_no || row.drawing_no,
    });
    passDialogVisible.value = false;
  } finally {
    store.mutations.passingBatchId = null;
  }
}

// ============ 指定工序 ============
// 2026-07-21 改：先选下一道工序，再选目标生产货架（按 shelf↔process 映射过滤）。
// 同时支持可选「品检备注」，写入 t_part_event.note，事件历史与工人领取卡片均可见。
const failDlg = useDialogSize({ desktopWidth: 520 });
const failDialogVisible = ref(false);
const failTarget = ref<InspectionBatchRow | null>(null);
const failProcessId = ref<string>('');
const failShelfId = ref<string>('');
const failNote = ref<string>('');
const failQty = ref<number | undefined>(undefined);
const failSubmitting = ref(false);

const { dangerous: confirmDangerous } = useConfirm();

// 指定工序默认走 INHOUSE 工序（外协工序走 send_to_outsource 路径）；
// 不强制过滤 category，避免业务上「品检后直接外协返修」分支被锁死。
// 2026-10-03：数据源从视图里的裸调 listShelves / listProcesses 换成 store.options
// （共享 query），映射由 useShelfProcessFilter 内部自动跟随就绪开闸拉取。
//
// ⚠️ 为什么要包一层 computed：Pinia store 是 reactive()，读嵌套 ref 时**自动解包**
//   （`store.options.productionShelves` 拿到的是数组本身而不是 Ref）。而
//   useShelfProcessFilter 需要 Ref —— 它内部 watch 依赖「源变更」来重算过滤。
//   局部 computed 把响应式接回去（读 store 时会登记对内层 query data 的依赖）。
const productionShelvesRef = computed(() => store.options.productionShelves);
const processesRef = computed(() => store.options.processes);

const { filteredShelves: filteredProductionShelves, filteredProcesses } = useShelfProcessFilter(
  productionShelvesRef,
  processesRef,
  computed({
    get: () => failShelfId.value || null,
    set: (v) => {
      failShelfId.value = v ?? '';
    },
  }),
  computed({
    get: () => failProcessId.value || null,
    set: (v) => {
      failProcessId.value = v ?? '';
    },
  }),
);

function openFailDialog(row: InspectionBatchRow): void {
  failTarget.value = row;
  failProcessId.value = '';
  failShelfId.value = '';
  failNote.value = '';
  failQty.value = row.quantity;
  failDialogVisible.value = true;
  // 货架 / 工序候选由共享 query（store.options）自动就绪，映射未到位前 filteredXxx
  // 走兜底全量 —— 不再需要旧版那段「为空则 load()」的并发预热。
}

function onFailDialogClosed(): void {
  failTarget.value = null;
  failProcessId.value = '';
  failShelfId.value = '';
  failNote.value = '';
  failQty.value = undefined;
}

async function onFailConfirm(): Promise<void> {
  if (!failTarget.value || !failProcessId.value || !failShelfId.value) return;
  const row = failTarget.value;
  // code 进提示文案、name 进扫码树写后本地回写（「当前位置」「工序」两列）—— 写端点
  // 的响应只回 part 投影，批次行的展示字段前端自己最清楚。
  const targetShelf = store.options.productionShelves.find(
    (s) => String(s.id) === failShelfId.value,
  );
  const targetProcess = store.options.processes.find((p) => String(p.id) === failProcessId.value);
  const shelfCode = targetShelf?.code ?? '';
  const processCode = targetProcess?.code ?? '';
  if (
    !(await confirmDangerous(
      '指定工序',
      `确认指定工序「${row.name}」（${row.serial_no || row.drawing_no}）到生产货架 ${shelfCode}，下一道工序 ${processCode}？`,
      { type: 'warning', confirmText: '确认指定工序', cancelText: '取消' },
    ))
  )
    return; // 用户取消
  failSubmitting.value = true;
  try {
    // 品检打回（指定工序）= `POST /prod/batches/{batch_id}/to-process`
    // （INSPECTION → IN_PROCESS，事件 INSPECTION_FAILED）。返修中批次（is_repairing）
    // 后端返 20118 返修守卫，mutation 的 onError 走通用提示弹后端原文。
    await store.mutations.toProcessMutation.mutateAsync({
      batchId: row.batch_id,
      shelfId: failShelfId.value,
      nextProcessId: failProcessId.value,
      version: row.version,
      note: failNote.value.trim() || null,
      quantity: failQty.value ?? null,
      label: row.serial_no || row.drawing_no,
      processCode,
      shelfCode,
      processName: targetProcess?.name ?? '',
      shelfName: targetShelf?.name ?? '',
    });
    failDialogVisible.value = false;
  } finally {
    failSubmitting.value = false;
  }
}

// ============ 扫码 → 树形弹窗（2026-10-05）============
// 一次请求换回「装配件 → 子零件 → 全部批次」三层树；本页只负责取数与开弹窗，
// 树内每一行的操作列在 ScanTreeDialog 内就地渲染。
const scanTreeOpen = ref(false);

/** 批次行 + 父级零件节点 → 两个既有弹窗要的行结构。
 *  序列号 / 图号 / 名称只在**零件节点**上（批次节点没有这三个字段），所以必须回树上
 *  找它的父级；`version` 取批次的（t_part_batch.version，写端点的 OCC 锚），
 *  **不是**零件节点的 version（t_part.version 是另一个计数器，混用必 409）。 */
function toBatchRow(batch: ScanBatchOut): InspectionBatchRow | null {
  const part = store.mutations.scanTree?.children.find((p) =>
    p.children.some((b) => b.id === batch.id),
  );
  if (!part) return null;
  return {
    batch_id: batch.id,
    batch_no: batch.batch_no,
    quantity: batch.quantity,
    version: batch.version,
    serial_no: part.serial_no,
    drawing_no: part.drawing_no,
    name: part.name,
  };
}

function onScanTreePass(batch: ScanBatchOut): void {
  const row = toBatchRow(batch);
  // 正常路径不可达（批次行就是从当前树上来的），但真发生（树被并发扫码换掉）时用户
  // 点按钮毫无反馈最让人困惑，补一句提示。
  if (!row) {
    ElMessage.warning('该批次已不在当前扫码树里，请关闭弹窗后重新扫码');
    return;
  }
  openPassDialog(row);
}

function onScanTreeAssignProcess(batch: ScanBatchOut): void {
  const row = toBatchRow(batch);
  if (!row) {
    ElMessage.warning('该批次已不在当前扫码树里，请关闭弹窗后重新扫码');
    return;
  }
  openFailDialog(row);
}

async function onInspectionScan(rawCode: string): Promise<void> {
  const code = rawCode.trim();
  if (!code) return;
  // 已有 dialog 在显示时不抢流程（品检通过 / 指定工序 / 树形弹窗三者任一开着都跳过；
  // 行内送检面板在树弹窗内，跟着树弹窗一起被这条守卫挡住）—— 否则会在用户正填数量的
  // 半路上换掉整棵树的上下文。守卫必须在 await 之前判。
  if (passDialogVisible.value || failDialogVisible.value || scanTreeOpen.value) {
    return;
  }
  // 清上一棵树与乐观开窗放在同一段同步代码里：请求在飞时用户按 ESC 关窗的话，closed 先
  // 触发（那时树上还是上一次的内容，清了个寂寞），响应随后把新树写进去而弹窗是关的 ⇒
  // 下次扫码开窗先闪出上一次的树（正是 clearScanTree 注释里说要避免的现象）。
  store.mutations.clearScanTree();
  // 乐观开窗：先开窗再发请求，弹窗内的 v-loading 才是活的（等请求回来才开窗的话，
  // 渲染时请求早已 settle，loading 永远是死绑定，请求期间零反馈）。失败关窗。
  scanTreeOpen.value = true;
  try {
    await store.mutations.scanMutation.mutateAsync(code);
  } catch {
    // 查不到 / 其它错误的提示已在 store 的 scanMutation.onError 弹过，这里只收窗。
    scanTreeOpen.value = false;
  }
}

const { onScan } = useBarcodeScanner();
const unsubInspectionScan = onScan((code) => {
  void onInspectionScan(code);
});

// ============ 生命周期编排 ============
onMounted(async () => {
  // 1) 恢复持久化筛选 / 排序 / 分页大小，末尾开 enabled 闸门 → useQuery 自动首屏 fetch。
  store.query.restoreState();
  // 2) 恢复排序箭头：el-table 的 default-sort 是 one-time（数据到达后重建表头会丢），
  //    与 PartsList.vue 同款：nextTick 后显式 sort() 一次。
  await nextTick();
  const sortProp = INSPECTION_SORT_KEY_TO_PROP[store.query.sortBy] ?? 'system_delivery_date';
  const sortOrder = store.query.sortDir === 'ASC' ? 'ascending' : 'descending';
  tableRef.value?.tableRef?.sort(sortProp, sortOrder);
});

onBeforeUnmount(() => {
  unsubInspectionScan();
  // 不变量 #2：Pinia 单例，离开页面销毁，下次进入重建 fresh 状态。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.inspection-pending {
  padding: 0;
}

.filter-card {
  margin-bottom: 12px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.total-hint {
  color: var(--text-secondary);
  font-size: 13px;
}

.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.muted {
  color: var(--text-secondary);
}

.fail-summary {
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 4px;
  padding: 10px 14px;
  line-height: 1.8;
  font-size: 13px;
}

.opt-tag {
  margin-left: 6px;
}
</style>
