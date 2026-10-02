<!--
  InspectionPending.vue — 品检待办一览（INSPECTION 状态的批次）

  2026-10-03 重构（列表交互 + 迁 TanStack Query）：
  - 顶部 filter 卡瘦身：图号 / 名称 / 序列号 / 日期筛选**全部搬进表头 popover**
    （照零件一览的范式），顶部只留「刷新」+「自动刷新（5min）」+「共 N 条」。
  - 列表脱离 `<ListShell>`：改用 `<InspectionTable>`（自建 el-table + 表头筛选 +
    服务端排序 + 列可见性/拖动），状态全部来自 `useInspectionListStore`。
  - 后端 VO 收口为 13 字段（`InspectionQueueItem`）：表格只显示 7 个数据列
    （序列号 / 图号 / 名称 / 批次 / 数量 / 系统交期 / 客户）+ 操作列。
  - 扫码快路径改判据：列表命中与 BatchPickerDialog 命中的行**恒为 INSPECTION**
    （端点判据固定 `status='INSPECTION'`），所以直接弹二选一，不再走
    `routeScannedPart` 的状态分流 —— 新 VO 根本没有 status / location 字段，
    照旧分流会读到 undefined 从而走进「该零件不在本工序」的错误分支。

  保留能力（行为与 2026-09-30 版一致）：4 个弹窗（品检通过带数量 / 指定工序 /
  扫码命中二选一 / 扫码快捷品检）+ BatchPickerDialog + 扫码订阅 + 5min 自动刷新
  timer + 加急红底 + 部分通过拆批提示 + 40901 冲突提示。
-->
<template>
  <div class="inspection-pending">
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <el-button @click="onRefresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
        <el-checkbox v-model="store.ui.autoRefresh" @change="onAutoRefreshToggle">
          自动刷新（5min）
        </el-checkbox>
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

    <!-- 品检通过对话框（带数量；部分通过时后端先拆批再过） -->
    <el-dialog
      v-model="passDialogVisible"
      title="品检通过"
      :width="passDlg.width"
      :top="passDlg.top"
      :close-on-click-modal="false"
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

    <!-- 指定工序对话框：先选下一道工序，再选目标生产货架（按 shelf↔process 映射过滤） -->
    <el-dialog
      v-model="failDialogVisible"
      title="指定工序 — 选择下一道工序 + 目标生产货架"
      :width="failDlg.width"
      :top="failDlg.top"
      :close-on-click-modal="false"
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

    <!-- 扫码命中 INSPECTION 行的二选一对话框（点按钮复用上面两个 dialog） -->
    <el-dialog
      v-model="scanChooserOpen"
      title="扫码命中 - 选择动作"
      width="420"
      :close-on-click-modal="false"
      append-to-body
    >
      <div v-if="scanChooserRow" class="fail-summary">
        <div><strong>流水号：</strong>{{ scanChooserRow.serial_no || '—' }}</div>
        <div><strong>批次：</strong>{{ scanChooserRow.batch_no }}</div>
        <div><strong>图号：</strong>{{ scanChooserRow.drawing_no }}</div>
        <div><strong>名称：</strong>{{ scanChooserRow.name }}</div>
        <div><strong>数量：</strong>{{ scanChooserRow.quantity }}</div>
      </div>
      <template #footer>
        <el-button @click="scanChooserOpen = false">取消</el-button>
        <el-button type="warning" @click="onScanChooserFail">指定下一工序</el-button>
        <el-button type="success" @click="onScanChooserPass">品检通过</el-button>
      </template>
    </el-dialog>

    <!-- 扫码快捷品检弹窗（PENDING / PROGRAMMING / IN_PROCESS+ON_SHELF → INSPECTION → PASS/FAIL）。
         该路径只由 getPartBySerial fallback 触发（列表命中恒为 INSPECTION），
         故 scanInspectRow 是 PartItem（唯一带 status / location 的形态）。 -->
    <el-dialog
      v-model="scanInspectDialogVisible"
      title="扫码快捷品检 — 选择通过 / 打回"
      :width="scanInspectDlg.width"
      :top="scanInspectDlg.top"
      :close-on-click-modal="false"
      append-to-body
      @closed="onScanInspectDialogClosed"
    >
      <div v-if="scanInspectRow" class="fail-summary">
        <div><strong>流水号：</strong>{{ scanInspectRow.serial_no || '—' }}</div>
        <div><strong>批次：</strong>{{ scanInspectRow.batch_no ?? '—' }}</div>
        <div><strong>图号：</strong>{{ scanInspectRow.drawing_no }}</div>
        <div><strong>名称：</strong>{{ scanInspectRow.name }}</div>
        <div>
          <strong>当前状态：</strong>
          <el-tag size="small" :type="scanInspectRow.status === 'PENDING' ? 'info' : 'primary'">
            {{
              scanInspectRow.status === 'PENDING'
                ? '待下发'
                : scanInspectRow.status === 'PROGRAMMING'
                  ? '编程中'
                  : '生产中'
            }}
          </el-tag>
        </div>
      </div>

      <el-form label-width="96px" style="margin-top: 12px">
        <el-form-item label="品检架" required>
          <el-select
            v-model="scanInspectShelfId"
            placeholder="请选择目标品检架"
            filterable
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="s in store.options.inspectionShelves"
              :key="s.id"
              :value="String(s.id)"
              :label="`${s.code} — ${s.name}`"
            >
              {{ s.code }} — {{ s.name }}
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="数量">
          <el-input-number
            v-model="scanInspectQty"
            :min="1"
            :max="scanInspectRow?.quantity"
            :precision="0"
            style="width: 160px"
          />
          <span v-if="scanInspectRow" class="muted" style="margin-left: 8px">
            / {{ scanInspectRow.quantity }}
          </span>
        </el-form-item>

        <el-form-item label="品检动作" required>
          <el-radio-group v-model="scanInspectDecision" aria-label="品检动作">
            <el-radio value="PASS">品检通过（PASS）</el-radio>
            <el-radio value="FAIL">打回生产架（FAIL）</el-radio>
          </el-radio-group>
        </el-form-item>

        <template v-if="scanInspectDecision === 'FAIL'">
          <el-form-item label="下一道工序" required>
            <el-select
              v-model="scanInspectProcessId"
              placeholder="请先选择下一道工序"
              filterable
              clearable
              style="width: 100%"
            >
              <el-option
                v-for="p in scanInspectFilteredProcesses"
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

          <el-form-item label="目标生产架" required>
            <el-select
              v-model="scanInspectShelfIdFail"
              placeholder="先选工序；货架候选按映射过滤"
              filterable
              clearable
              style="width: 100%"
              :disabled="!scanInspectProcessId"
            >
              <el-option
                v-for="s in scanInspectFilteredProductionShelves"
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
                    scanInspectProcessId
                      ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                      : '请先选择下一道工序'
                  }}
                </span>
              </template>
            </el-select>
          </el-form-item>

          <el-form-item label="品检备注">
            <el-input
              v-model="scanInspectNote"
              type="textarea"
              :rows="3"
              :maxlength="500"
              show-word-limit
              placeholder="不合格原因 / 返修要点（写入事件历史，工人领取时可见）"
            />
          </el-form-item>
        </template>

        <el-alert
          type="info"
          :closable="false"
          title="快捷品检将一次性把零件搬到品检架，再按上面选择的动作（PASS → READY_TO_SHIP / FAIL → 回到生产架并指定下一道工序）完成流转。"
          show-icon
        />
      </el-form>

      <template #footer>
        <el-button @click="scanInspectDialogVisible = false">取消</el-button>
        <el-button
          :type="scanInspectDecision === 'PASS' ? 'success' : 'warning'"
          :loading="scanInspectSubmitting"
          :disabled="
            !scanInspectShelfId ||
            (scanInspectDecision === 'FAIL' && (!scanInspectShelfIdFail || !scanInspectProcessId))
          "
          @click="onScanInspectConfirm"
          >确认品检</el-button
        >
      </template>
    </el-dialog>

    <!-- 扫码命中同一 serial 多批次时复用报工台 BatchPickerDialog。
         2026-10-03：这是一对**往返** cast —— props 入口 `InspectionQueueItem[]`
         → `PartItem[]`、pick 出口 `PartItem` → `InspectionQueueItem`，因为
         BatchPickerDialog 的 props / emits 类型都写死了 PartItem。cast 存在是因为
         该组件是跨域共享组件、不该为接一个窄 VO 而改签名。
         holderText 在本页恒返回空串（13 字段 VO 无任何 holder 键）⇒ 卡片不再显示
         「未知位置」那一行，见 BatchPickerDialog.holderText 的注释。 -->
    <BatchPickerDialog
      v-model="showBatchPicker"
      :code="batchPickerCode"
      :rows="batchPickerRows as unknown as PartItem[]"
      @pick="onBatchPicked"
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
//   - 4 个业务弹窗 + BatchPickerDialog；
//   - 生命周期编排：restoreState（开 enabled 闸门）、排序箭头恢复、扫码订阅、timer、
//     store.$dispose()。
//
// 导航（详情 / 零件链接）留在壳内 —— store 不 import vue-router（不变量 #4）。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import { useConfirm } from '@/composables/useConfirm';
import { useDialogSize } from '@/composables/useDialogSize';
import { useBarcodeScanner } from '@/composables/useBarcodeScanner';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import { findPartBySerialAndPrompt } from '@/utils/scanHelpers';
import { getPartBySerial, type InspectionQueueItem, type PartItem } from '@/api/parts';
import { INSPECTION_SORT_KEY_TO_PROP } from '@/types/inspection';
import BatchPickerDialog from '@/views/scan/components/BatchPickerDialog.vue';
import InspectionTable from './components/InspectionTable.vue';
import { useInspectionListStore } from './composables/useInspectionListStore';
import { resolveScanRouteStatus } from './composables/resolveScanRouteStatus';

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
async function onRefresh(): Promise<void> {
  await store.query.fetchList();
}

let autoRefreshTimer: number | null = null;
function onAutoRefreshToggle(val: string | number | boolean): void {
  if (autoRefreshTimer !== null) {
    window.clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (val) {
    autoRefreshTimer = window.setInterval(() => {
      void store.query.fetchList();
    }, 300_000);
  }
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
const passTarget = ref<InspectionQueueItem | null>(null);
const passQty = ref<number | undefined>(undefined);

function openPassDialog(row: InspectionQueueItem): void {
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
const failTarget = ref<InspectionQueueItem | null>(null);
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

function openFailDialog(row: InspectionQueueItem): void {
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
  const shelfCode =
    store.options.productionShelves.find((s) => String(s.id) === failShelfId.value)?.code ?? '';
  const processCode =
    store.options.processes.find((p) => String(p.id) === failProcessId.value)?.code ?? '';
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
    });
    failDialogVisible.value = false;
  } finally {
    failSubmitting.value = false;
  }
}

// ============ 扫码快捷品检 ============
// 命中 PENDING / PROGRAMMING / IN_PROCESS+PRODUCTION_SHELF 时弹本对话框，
// 一步完成：搬到品检架 + 通过品检 / 指定下一工序。
// 该路径只由 getPartBySerial fallback 触发（列表命中恒为 INSPECTION，走二选一弹窗），
// 所以 scanInspectRow 是 PartItem —— 全仓唯一带 status / location 的形态。
const scanInspectDlg = useDialogSize({ desktopWidth: 520 });
const scanInspectDialogVisible = ref(false);
const scanInspectRow = ref<PartItem | null>(null);
const scanInspectShelfId = ref<string>(''); // 目标品检架
const scanInspectProcessId = ref<string>(''); // 下一道工序（仅 FAIL）
const scanInspectShelfIdFail = ref<string>(''); // 目标生产架（仅 FAIL）
const scanInspectNote = ref<string>('');
const scanInspectQty = ref<number | undefined>(undefined);
const scanInspectDecision = ref<'PASS' | 'FAIL'>('PASS');
const scanInspectSubmitting = ref(false);

// 复用 fail 弹窗的 shelf/process 双向过滤（同一份 store.options 数据源）。
const {
  filteredShelves: scanInspectFilteredProductionShelves,
  filteredProcesses: scanInspectFilteredProcesses,
} = useShelfProcessFilter(
  productionShelvesRef,
  processesRef,
  computed({
    get: () => scanInspectShelfIdFail.value || null,
    set: (v) => {
      scanInspectShelfIdFail.value = v ?? '';
    },
  }),
  computed({
    get: () => scanInspectProcessId.value || null,
    set: (v) => {
      scanInspectProcessId.value = v ?? '';
    },
  }),
);

function openScanInspectDialog(row: PartItem): void {
  scanInspectRow.value = row;
  scanInspectShelfId.value = '';
  scanInspectShelfIdFail.value = '';
  scanInspectProcessId.value = '';
  scanInspectNote.value = '';
  scanInspectQty.value = row.quantity;
  scanInspectDecision.value = 'PASS';
  scanInspectDialogVisible.value = true;
}

function onScanInspectDialogClosed(): void {
  scanInspectRow.value = null;
  scanInspectShelfId.value = '';
  scanInspectShelfIdFail.value = '';
  scanInspectProcessId.value = '';
  scanInspectNote.value = '';
  scanInspectQty.value = undefined;
  scanInspectDecision.value = 'PASS';
}

async function onScanInspectConfirm(): Promise<void> {
  const row = scanInspectRow.value;
  if (!row) return;
  if (!scanInspectShelfId.value) {
    ElMessage.warning('请选择品检架');
    return;
  }
  if (
    scanInspectDecision.value === 'FAIL' &&
    (!scanInspectShelfIdFail.value || !scanInspectProcessId.value)
  ) {
    ElMessage.warning('打回生产架时，目标货架与下一道工序必填');
    return;
  }
  // scan-inspect / to-process / to-ship 都是**批次锚定**端点（路径参数 batch_id +
  // OCC 锚 t_part_batch.version），而 getPartBySerial 是 part 级端点：它只在
  // 「批次级列表」响应里带 batch_id，part 详情形态里该键是 null/undefined。
  // 缺 batch_id 时明确拦下（旧版会拿 undefined 拼出 `/prod/batches/undefined/...`
  // 的必失败请求），version 也不是批次版本、不能当 OCC 锚用。
  if (!row.batch_id) {
    ElMessage.warning('该零件未在批次中，无法快捷品检；请在品检一览里选中对应批次');
    return;
  }
  scanInspectSubmitting.value = true;
  try {
    await store.mutations.scanInspectMutation.mutateAsync({
      batchId: row.batch_id,
      targetInspectionShelfId: scanInspectShelfId.value,
      pass: scanInspectDecision.value === 'PASS',
      // ⚠️ PartItem.version 是 t_part.version，不是 t_part_batch.version —— 批次锚
      // 端点要的是后者。part 级端点拿不到批次版本，故这里按 part 版本发（与 2026-09-30
      // 版的既有行为一致）；后端返 40901 时由 scanInspectMutation.onError 转成
      // 「该批次已被他人修改，请刷新后重试」（同 toShip / toProcess 的分支）。
      version: row.version,
      shelfId: scanInspectShelfIdFail.value || null,
      nextProcessId: scanInspectProcessId.value || null,
      note: scanInspectNote.value.trim() || null,
      quantity: scanInspectQty.value ?? null,
      label: row.serial_no || row.drawing_no,
    });
    scanInspectDialogVisible.value = false;
  } finally {
    scanInspectSubmitting.value = false;
  }
}

// ============ 扫码：序列号 → 二选一弹窗 / BatchPickerDialog ============
//
// 2026-10-03 快路径改造（VO 收口的关键联动）：列表命中与 BatchPickerDialog 命中的行
// 来自 `GET /prod/batches/inspection`，该端点判据恒为 `status='INSPECTION'`，所以
// 命中的行**必定**是品检中的批次 → 直接弹二选一。旧版按 `part.status` 三路分流，
// 新 VO 没有 status 键（读到 undefined 会掉进「该零件不在本工序」的错误分支）——
// 不改就是功能回归。
//
//   - 1 条命中 → 二选一对话框；
//   - 多条命中（同 serial 不同 batch）→ BatchPickerDialog 选批次再二选一；
//   - 0 命中 → getPartBySerial 按 serial_no 查任意状态零件，再按 status / location
//     分流（PENDING / PROGRAMMING / IN_PROCESS+PRODUCTION_SHELF → 快捷品检弹窗；
//     其余 → 位置提示）。这条路径的 row 是 PartItem，有真实 status / location。
// 已有 dialog 在显示时不抢流程。
const scanChooserOpen = ref(false);
const scanChooserRow = ref<InspectionQueueItem | null>(null);
const showBatchPicker = ref(false);
const batchPickerCode = ref('');
const batchPickerRows = ref<InspectionQueueItem[]>([]);

/** 当前页按 serial_no / drawing_no 精确命中。
 *  不用 `findAllByCode`：它的签名是 `PartItem[]`（报工台 / 返修页的行类型），
 *  与 13 字段的 InspectionQueueItem 无结构交集，沿用要 `as unknown as PartItem[]`
 *  往返双 cast。语义与 findAllByCode 逐字一致。 */
function findQueueRowsByCode(rows: InspectionQueueItem[], code: string): InspectionQueueItem[] {
  return rows.filter(
    (r) => (r.serial_no !== null && r.serial_no === code) || r.drawing_no === code,
  );
}

async function onInspectionScan(rawCode: string): Promise<void> {
  const code = rawCode.trim();
  if (!code) return;
  if (
    passDialogVisible.value ||
    failDialogVisible.value ||
    scanChooserOpen.value ||
    scanInspectDialogVisible.value ||
    // 批次选择弹窗也要守：它开着时再扫一次码会直接改写 batchPickerRows / batchPickerCode，
    // 用户在旧候选集上做的选择会张冠李戴（2026-10-03 补齐，此前漏守）。
    showBatchPicker.value
  ) {
    return;
  }
  const matches = findQueueRowsByCode(store.query.items, code);
  if (matches.length === 0) {
    try {
      const part = await getPartBySerial(code);
      routeScannedPart(part);
    } catch {
      // 404 / 网络错误 → 走 helper 显示「未找到」warning + 位置提示
      await findPartBySerialAndPrompt(code);
    }
    return;
  }
  if (matches.length > 1) {
    batchPickerCode.value = code;
    batchPickerRows.value = matches;
    showBatchPicker.value = true;
    return;
  }
  // 单条命中：列表端点恒 INSPECTION → 直接二选一。
  scanChooserRow.value = matches[0];
  scanChooserOpen.value = true;
}

/** getPartBySerial fallback 专用分流。判据已抽成纯函数
 *  `resolveScanRouteStatus`（`composables/resolveScanRouteStatus.ts`，穷举单测在
 *  `composables/__tests__/resolveScanRouteStatus.spec.ts`）—— 本页 4 个弹窗 + 扫码
 *  订阅 + timer 挂载成本过高，判据本身是本次唯一改了用户可见行为的地方，值得单独测。 */
function routeScannedPart(part: PartItem): void {
  const route = resolveScanRouteStatus(part.status, part.location);
  if (route === 'inspection-out-of-range') {
    ElMessage.warning('该零件在品检中，但不在当前筛选 / 分页范围内；请调整筛选或翻页后操作');
    return;
  }
  if (route === 'scan-inspect') {
    openScanInspectDialog(part);
    return;
  }
  void findPartBySerialAndPrompt(part.serial_no ?? part.drawing_no ?? '');
}

function onScanChooserPass(): void {
  const row = scanChooserRow.value;
  scanChooserOpen.value = false;
  scanChooserRow.value = null;
  if (row) openPassDialog(row);
}

function onScanChooserFail(): void {
  const row = scanChooserRow.value;
  scanChooserOpen.value = false;
  scanChooserRow.value = null;
  if (row) openFailDialog(row);
}

function onBatchPicked(row: PartItem): void {
  // BatchPickerDialog 的 pick emit 声明成 PartItem，实际传进来的是本页的
  // InspectionQueueItem（与模板里那对往返 cast 的出口那一侧同源）。
  showBatchPicker.value = false;
  scanChooserRow.value = row as unknown as InspectionQueueItem;
  scanChooserOpen.value = true;
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
  // 3) 自动刷新开关（布尔在 store，timer 实例在本壳）。
  if (store.ui.autoRefresh) onAutoRefreshToggle(true);
});

onBeforeUnmount(() => {
  unsubInspectionScan();
  if (autoRefreshTimer !== null) {
    window.clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
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
