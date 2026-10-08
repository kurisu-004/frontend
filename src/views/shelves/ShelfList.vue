<template>
  <div class="shelf-page">
    <div class="page-header">
      <h2>货架管理</h2>
      <el-button type="primary" @click="showCreate = true">新增货架</el-button>
    </div>
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @resetOrder="drag.reset"
      />
    </div>
    <el-table
      ref="tableRef"
      v-loading="loading"
      :data="items"
      row-key="id"
      empty-text="暂无货架"
      stripe
      :default-sort="{ prop: 'display_order', order: 'ascending' }"
    >
      <template #empty>
        <el-empty description="暂无货架" />
      </template>
      <!--
        2026-08-27 T15：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
        用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
        fixed="right" 操作列保留为字面量 <el-table-column>。
      -->
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :sortable="d.sortable"
          :align="d.align"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :column-key="d.columnKey ?? d.key"
          :label-class-name="drag.dragLabelClass(d)"
        >
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
          <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
        </el-table-column>
      </template>
      <el-table-column label="操作" min-width="160" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link size="small" @click="editShelf(row as Shelf)">编辑</el-button>
          <el-popconfirm
            v-if="row.is_active"
            title="确认停用？"
            @confirm="doDeactivate(String(row.id))"
          >
            <template #reference
              ><el-button link size="small" type="danger">停用</el-button></template
            >
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="showCreate"
      :title="editingShelf ? '编辑货架' : '新增货架'"
      :width="shelfDlg.width"
      :top="shelfDlg.top"
      :fullscreen="shelfDlg.fullscreen"
      @closed="resetForm"
    >
      <el-form ref="shelfFormRef" :model="shelfForm" :rules="shelfRules" label-width="80px">
        <el-form-item label="代码" prop="code"
          ><el-input v-model="shelfForm.code" :disabled="!!editingShelf" placeholder="如 PROD-A1"
        /></el-form-item>
        <el-form-item label="名称" prop="name"
          ><el-input v-model="shelfForm.name" placeholder="如 生产区-A1 货架"
        /></el-form-item>
        <el-form-item label="区域" prop="zone">
          <el-select v-model="shelfForm.zone" style="width: 100%" @change="onZoneChange">
            <el-option label="生产区" value="PRODUCTION" /><el-option
              label="品检区"
              value="INSPECTION"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="位置" prop="location"
          ><el-input v-model="shelfForm.location" placeholder="可选的自由文本"
        /></el-form-item>
        <el-form-item label="物理顺序" prop="display_order">
          <el-input-number
            v-model="shelfForm.display_order"
            :min="0"
            :step="1"
            controls-position="right"
            placeholder="0=未设置"
          />
          <span class="field-hint">用于共享 HMI 卡片网格 picker 的物理顺序；0=未设置</span>
        </el-form-item>
        <!--
          2026-10-10 新增：容量（负载上限，件数）。目标货架改由后端按
          `current_load / capacity` 升序自动选择，这个值就是那个分母。留空 = 不限
          （`capacity: null`）—— 无上限架不参与百分比比较。
          用 `undefined` 而非 `null` 表示「留空」，提交时显式转成 `null` 发出去：
          `el-input-number` 清空得到的是 null，但区分不了「用户清空」与「初始就是空」
          两种情况，直接把 null 塞进 payload 反而让 updateShelf 的「三态」失去意义
          （不传 = 不改、传 null = 清空）。
        -->
        <el-form-item label="容量" prop="capacity">
          <el-input-number
            v-model="shelfForm.capacity"
            :min="1"
            :step="10"
            :precision="0"
            controls-position="right"
            placeholder="留空 = 不限"
          />
          <span class="field-hint"
            >负载上限（件数）；留空 = 不限。超载仍可继续投放，只影响选架排序</span
          >
        </el-form-item>
        <!--
          后端收紧 `POST /api/v2/prod/shelf-processes/{id}`：`items` 非空时会对
          非 PRODUCTION 区的货架返 20104（`items: []` 的清空路径已豁免）⇒ 品检架不该在
          这里配工序，界面上就不给入口。
          zone 的判据是 `effectiveZone` 而不是 `shelfForm.zone`，见该 computed 的注释。
        -->
        <el-form-item v-if="effectiveZone === 'PRODUCTION'" label="工序">
          <el-select
            v-model="selectedProcessIds"
            multiple
            filterable
            placeholder="选择该货架可执行的工序（可多选）"
            style="width: 100%"
          >
            <el-option
              v-for="p in allProcesses"
              :key="p.id"
              :label="`${p.code} — ${p.name}`"
              :value="p.id"
            >
              <span style="font-weight: 600">{{ p.code }}</span>
              <span style="margin-left: 4px">{{ p.name }}</span>
              <el-tag
                :type="p.category === 'INHOUSE' ? 'primary' : 'warning'"
                size="small"
                style="margin-left: 6px"
                >{{ PROCESS_CATEGORY_LABEL[p.category] }}</el-tag
              >
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveShelf">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, onMounted, h } from 'vue';
import { ElMessage, ElTag, ElForm, type FormInstance } from 'element-plus';
// 2026-10-02 review 第 1 轮 M-3：useQueryClient 只为保存成功后失效共享映射缓存
// （见 saveShelf 里的 invalidateShelfProcessMappingsQuery 调用点注释）。
import { useQueryClient } from '@tanstack/vue-query';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag';
import { useDialogSize } from '@/composables/useDialogSize';
import {
  listShelves,
  createShelf,
  updateShelf,
  deactivateShelf,
  getShelfProcesses,
  setShelfProcesses,
  toShelfProcessIds,
  toShelfProcessesPayload,
} from '@/api/shelves';
import { listProcesses } from '@/api/process';
import { invalidateShelfProcessMappingsQuery } from '@/composables/queries/useShelfProcessMappingsQuery';
import type { Shelf } from '@/types/shelf';
import type { Process } from '@/types/process';
import { PROCESS_CATEGORY_LABEL } from '@/types/process';

// 2026-10-02 review 第 1 轮 M-3：共享映射 query 的失效入口（写点唯一，见 saveShelf）。
const qc = useQueryClient();

// ============ 列可见性 + 列顺序拖动 ============
// 「操作」列不放进 defs → 始终可见。
// 2026-08-27 T15：补 prop / width / minWidth / align + 复杂单元格走 cellRender。
const columnDefs: ColumnDef[] = [
  { key: 'code', label: '代码', prop: 'code', minWidth: 110, align: 'center' },
  { key: 'name', label: '名称', prop: 'name', minWidth: 140, align: 'center' },
  {
    key: 'zone',
    label: '区域',
    minWidth: 90,
    align: 'center',
    cellRender: ({ row }) =>
      h(
        ElTag,
        { type: (row as Shelf).zone === 'PRODUCTION' ? 'primary' : 'warning', size: 'small' },
        () => ((row as Shelf).zone === 'PRODUCTION' ? '生产' : '品检'),
      ),
  },
  { key: 'location', label: '位置', prop: 'location', minWidth: 120, align: 'center' },
  // 2026-10-10 新增三列（在架件数 / 容量 / 负载率）。目标货架已改为后端按
  // `current_load / capacity` 升序自动选择，这三项是那个口径的输入与解释：
  // 管理员在列表里就能看到「哪个架快满了、哪个架没设上限」。
  //
  // 三列都走 cellRender 而非 `formatter`：`formatter` 不在本模板的 v-for 绑定清单里
  // （见上面的 el-table-column 逐属性绑定），放进 defs 只会静默不生效 —— 与同文件
  // zone / display_order / is_active 三列一致。
  {
    key: 'current_load',
    label: '在架',
    prop: 'current_load',
    minWidth: 90,
    align: 'center',
    sortable: true,
    cellRender: ({ row }) => h('span', null, `${(row as Shelf).current_load ?? 0} 件`),
  },
  {
    key: 'capacity',
    label: '容量',
    prop: 'capacity',
    minWidth: 90,
    align: 'center',
    cellRender: ({ row }) => h('span', null, capacityText((row as Shelf).capacity)),
  },
  {
    key: 'load_ratio',
    label: '负载率',
    minWidth: 100,
    align: 'center',
    cellRender: ({ row }) => {
      const { capacity, current_load: load } = row as Shelf;
      // 无容量 = 不限，没有百分比可言。**不显示 0%**（那会被读成「空架」，
      // 而实际上是无上限架，可能是全场最满的）。
      if (!hasCapacity(capacity)) return h('span', { class: 'muted' }, '—');
      const ratio = load / (capacity as number);
      return h(
        ElTag,
        { type: loadRatioTagType(ratio), size: 'small', effect: ratio >= 1 ? 'dark' : 'plain' },
        () => `${(ratio * 100).toFixed(1)}%`,
      );
    },
  },
  {
    key: 'display_order',
    label: '物理顺序',
    prop: 'display_order',
    minWidth: 100,
    align: 'center',
    sortable: true,
    cellRender: ({ row }) =>
      h(
        ElTag,
        {
          type: (row as Shelf).display_order > 0 ? 'info' : 'warning',
          size: 'small',
          effect: 'plain',
        },
        () => ((row as Shelf).display_order > 0 ? String((row as Shelf).display_order) : '未设置'),
      ),
  },
  // 2026-10-02 摘除「账号数」列：用户已拍板「舍弃这个字段，前端不再显示」，
  // 前端类型 / shelfSchema / 本列三处同步摘除（后端 ShelfOut 在同 PR 也已删该
  // 字段，那是另一次独立决策，不是本列的成因）。列 key 变更后 useColumnVisibility
  // 的 lenient 恢复策略会把 localStorage 里残留的 account_count 项忽略掉，无需清缓存。
  {
    key: 'is_active',
    label: '状态',
    minWidth: 80,
    align: 'center',
    cellRender: ({ row }) =>
      h(ElTag, { type: (row as Shelf).is_active ? 'success' : 'danger', size: 'small' }, () =>
        (row as Shelf).is_active ? '启用' : '停用',
      ),
  },
];
/**
 * 这个架有没有设容量上限。**判据与后端一致**：`null` 或 `<= 0` = 不限。
 * 集中一处是因为列表「容量」列、负载率列、编辑弹窗回显三处都判它，三处各写一遍
 * 迟早有一处漏掉 `<= 0`。
 */
function hasCapacity(capacity: number | null | undefined): capacity is number {
  return typeof capacity === 'number' && capacity > 0;
}

/** 容量列文案：无上限显示「不限」（= 有意不限，是配置结论），不是 0。 */
function capacityText(capacity: number | null | undefined): string {
  return hasCapacity(capacity) ? String(capacity) : '不限';
}

/**
 * 负载率的颜色档位。**超载（≥ 100%）必须醒目**：超载不是错误（后端不拒），但它是
 * 「该给这个区扩货架 / 调 capacity」的信号，与「正常 80%」摆在同一个列表里若都
 * 用同一种中性色就等于没有信息。
 *
 * 阈值刻意只分两档（≥1 危险 / 否则普通），不引入 80% 警告档：档位越多越容易出现
 * 「某个架 79% 显示中性、80% 突然变黄」这种以阈值取整为转移点的跳变，而负载率本身
 * 是个连续量、看不出趋势跳变的意义。
 */
function loadRatioTagType(ratio: number): 'danger' | 'info' {
  return ratio >= 1 ? 'danger' : 'info';
}

const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'shelf_list' });
const drag = useColumnDrag(columnDefs, { listKey: 'shelf_list' });

const items = ref<Shelf[]>([]);
const loading = ref(false);
const shelfDlg = useDialogSize({ desktopWidth: 400 });
// 2026-08-27 T15：列拖动 onMounted 挂 useDraggable 到表头 <tr>（列换序；绑 thead 会变成拖整行，2026-08-27 修正）
const tableRef = ref();

const showCreate = ref(false);
const saving = ref(false);
const allProcesses = ref<Process[]>([]);
const selectedProcessIds = ref<string[]>([]);
const editingShelf = ref<Shelf | null>(null);
// 2026-10-02 review I-1 新增：本次编辑弹窗内「已映射工序」是否加载失败。
// 这是 BUG-2（静默清空整组映射）的**最后一道闸**：@closed → resetForm 已把
// selectedProcessIds 清成 []，所以「catch 里不覆盖 = 保持原状」在「加载失败后
// 不关弹窗直接点保存」这条路径上等于「留空」⇒ setShelfProcesses(id, {items: []})
// ⇒ 整组替换为空。warning 文案只是建议，拦不住保存动作，所以必须用状态位硬拦。
const processLoadFailed = ref(false);
// 2026-09-21 对齐 TS 严格：模板 ref 收紧为 EP FormInstance；null 初值避免 dialog 关闭态访问 .validate
const shelfFormRef = ref<FormInstance | null>(null);
const shelfForm = reactive({
  code: '',
  name: '',
  zone: 'PRODUCTION' as string,
  location: '',
  display_order: 0,
  /** 2026-10-10：负载上限（件数）。`undefined` = 留空 = 不限（见表单项注释）。 */
  capacity: undefined as number | undefined,
});
const shelfRules = {
  code: [{ required: true, message: '必填' }],
  name: [{ required: true, message: '必填' }],
  zone: [{ required: true, message: '必选' }],
};

/**
 * 映射编辑区（工序多选）与提交清空逻辑的 zone 判据。
 *
 * 2026-10-04：后端把 `POST /prod/shelf-processes/{id}` 收紧成「`items` 非空时，非
 * PRODUCTION 区的货架返 20104」（`items: []` 清空路径豁免）。前端这里必须跟着收，否则
 * 品检架的新增 / 编辑都收 20104 —— 而 `saveShelf` 里 `updateShelf` / `createShelf` 都**先于**
 * 这一步执行，于是变成**半截保存**：字段改了、映射没改，界面还弹「已保存」。
 *
 * 为什么编辑态不能用 `shelfForm.zone`：
 *   - `updateShelf` 的 payload 只有 `{name, location, display_order}`，**不含 zone** ⇒
 *     编辑态在表单里改「区域」对 DB 完全无效；
 *   - 区域下拉在编辑态**没有** `:disabled`（只有「代码」输入框有）⇒ 用户改得动。
 * 两个方向都会错：品检架被切到 PRODUCTION ⇒ 用表单值判会说「可以写」⇒ 调接口 ⇒ 后端读 DB
 * 仍是 INSPECTION ⇒ 20104（又半截保存）；生产架被切成品检 ⇒ 判说说「跳过」⇒ 静默留下陈旧
 * 映射，界面零提示。
 *
 * 所以编辑态一律以 `editingShelf.zone`（= `GET /shelves` 返回的 DB 值，表格行不过滤 zone）
 * 为准。它只被 `editShelf`（赋表格行）与 `resetForm`（置 null）写，任何表单交互都不写它。
 * 新增态 `editingShelf` 为 null，`shelfForm.zone` 正是随 `createShelf` 写进 DB 的值，
 * 不可能分叉。
 */
const effectiveZone = computed(() => editingShelf.value?.zone ?? shelfForm.zone);

/**
 * 用户真的改了「区域」时清掉已选工序。
 *
 * 2026-10-04：切到非生产区后工序多选会被 `v-if` 隐藏，但 `v-model` 绑的
 * `selectedProcessIds` 里**残留值仍在**，「隐藏多选」不等于「清空选择」—— 残留会被
 * `saveShelf` 原样提交。必须同步清。
 *
 * 用 `@change` 而不是 `watch(() => effectiveZone.value)`：`editShelf` 会异步
 * `getShelfProcesses` 填充 `selectedProcessIds`，而 `effectiveZone` 在 `editingShelf` 被赋值
 * 那一刻就变了 ⇒ watch 会与打开弹窗时的填充流程竞态（可能把刚填进去的映射清掉）。
 * `@change` 只在用户实际改 zone 时触发，不与填充流程相撞。
 */
function onZoneChange(): void {
  selectedProcessIds.value = [];
}

async function fetchData() {
  loading.value = true;
  try {
    items.value = (await listShelves({ limit: 200 })).items;
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  shelfForm.code = '';
  shelfForm.name = '';
  shelfForm.zone = 'PRODUCTION';
  shelfForm.location = '';
  shelfForm.display_order = 0;
  // 2026-10-10：漏复位会让「编辑一个有容量的架 → 关闭 → 新增」时把上一个架的
  // capacity 带进新架。
  shelfForm.capacity = undefined;
  selectedProcessIds.value = [];
  editingShelf.value = null;
  // 2026-10-02 review I-1：必须随 resetForm 一起复位。否则「编辑某架加载失败 →
  // 关闭 → 点新增货架 → 保存」会被上一个编辑会话的失败态误伤（新增路径根本没
  // 加载过映射，不该被拦）。
  processLoadFailed.value = false;
}
async function editShelf(s: Shelf) {
  // 2026-09-21 收紧：原 `s: any` + `as Shelf` 双层断言合并为单一参数类型
  editingShelf.value = s;
  shelfForm.code = s.code;
  shelfForm.name = s.name;
  shelfForm.zone = s.zone;
  shelfForm.location = s.location ?? '';
  shelfForm.display_order = s.display_order ?? 0;
  // 2026-10-10：`null` / `<= 0` 都要落成「留空」（不限），否则编辑一个无上限架时
  // 输入框里会出现一个 0 —— 用户看不懂 0 是什么意思，提交回去还会被后端当有效容量。
  shelfForm.capacity = hasCapacity(s.capacity) ? s.capacity : undefined;
  showCreate.value = true;
  // 每次进编辑都重新判定本次映射是否可信（不复用上一次的成功态）。
  processLoadFailed.value = false;
  try {
    const sp = await getShelfProcesses(String(s.id));
    // 2026-10-02 修 BUG-2：后端返 `{items: [...]}`，旧代码读 `sp.processes`
    // 恒 undefined → `.map` 抛 TypeError → 被下面的裸 catch 吞掉 → 每次打开编辑
    // 弹窗已选工序必被清空，用户不察觉点保存就静默清空整组映射。
    // 形态还原（items + sort_order 升序）收口到 api/shelves::toShelfProcessIds，
    // 由 src/api/shelfProcesses.spec.ts 钉死，避免读形态再漂。
    selectedProcessIds.value = toShelfProcessIds(sp);
  } catch (e: unknown) {
    // 2026-10-02 不再吞异常：加载失败时**保持原状**（不覆盖 selectedProcessIds），
    // 而不是清空。清空 = 用户没察觉就点保存 = 静默清空整组映射，比报错危险得多；
    // 保持原状最坏也只是「这次没刷出来」，且用户能从提示知道需要重试。
    // 2026-10-02 review I-1 补：置 processLoadFailed，让 saveShelf 能硬拦这次保存
    // ——「不覆盖」本身并不够，见该 ref 的注释。
    console.error('getShelfProcesses failed', e);
    processLoadFailed.value = true;
    ElMessage.warning('工序映射加载失败，本次已禁止保存；请关闭弹窗后重新进入再试');
  }
}

async function saveShelf() {
  // 2026-10-02 review I-1：映射加载失败时**整个保存动作**硬拦下（不是「只保存
  // 基本字段、跳过 setShelfProcesses」）—— 半截保存会造出「名字改了、映射没改」
  // 的新状态，且用户在成功提示里无从分辨自己改的哪部分生效了。宁可让用户
  // 关闭重进一次，也不让它在失败态上继续写入。
  if (processLoadFailed.value) {
    ElMessage.error('工序映射加载失败，未做任何保存：请关闭弹窗后重新进入再试');
    return;
  }
  const valid = await shelfFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  saving.value = true;
  try {
    let shelfId: string;
    // 2026-10-10：留空一律发 `null`（= 不限）而不是省略字段。编辑路径上省略会命中
    // `updateShelf` 的「不传 = 不改」，用户明明清空了容量却什么都没改 —— 而 capacity
    // 是选架口径的分母，留一个陈旧上限比留空更糟。
    const capacity = shelfForm.capacity ?? null;
    if (editingShelf.value) {
      await updateShelf(String(editingShelf.value.id), {
        name: shelfForm.name,
        location: shelfForm.location || undefined,
        display_order: shelfForm.display_order,
        capacity,
      });
      shelfId = String(editingShelf.value.id);
    } else {
      const created = await createShelf({
        code: shelfForm.code,
        name: shelfForm.name,
        zone: shelfForm.zone,
        location: shelfForm.location || undefined,
        display_order: shelfForm.display_order,
        capacity,
      });
      shelfId = String(created.id);
    }
    // 2026-10-02 修 BUG-1（用户报的 422）：后端 SetShelfProcessesRequest 的
    // `items` 必填且无 serde default，旧的 `{process_ids: [...]}` 直接 40001 →
    // HTTP 422（该功能自 v1 迁 v2 以来从未成功过一次）。
    // payload 构造收口到 api/shelves::toShelfProcessesPayload（sort_order = 数组
    // 下标，沿 v1「提交顺序即 sort_order」语义），并由 src/api/shelfProcesses.spec.ts
    // 逐字钉死形态，避免调用方再编出 v1 形态。
    //
    // 2026-10-04：非 PRODUCTION 区提交 `{items: []}`（= 显式清空），**不是跳过这一次
    // 调用**。两条理由：
    //   - 跳过 ⇒ 品检架上原有的陈旧映射留在库里，界面零提示（静默不一致）；
    //   - 跳过 ⇒ **新增路径会留下孤儿货架**：货架已由上面的 `createShelf` 落库，映射一步
    //     却没写，用户以为配好了；再点保存会带同一个 `code` 重新 createShelf，撞部分唯一
    //     `uk_t_shelf_code`（`WHERE deleted_at IS NULL`）⇒ 20502 DUPLICATE_CODE 彻底卡死，
    //     而编辑弹窗里没有停用入口（停用按钮在表格行、且 `v-if="row.is_active"`）。
    // `{items: []}` 则清空动作真的发生，且后端对 `items` 为空已豁免、不报 20104。
    const processIdsToSave = effectiveZone.value === 'PRODUCTION' ? selectedProcessIds.value : [];
    await setShelfProcesses(shelfId, toShelfProcessesPayload(processIdsToSave));
    // 2026-10-02 review 第 1 轮 M-3：保存成功后失效共享映射缓存。本数据的写点全仓
    // 只有这一个、读点只剩 1 处（零件详情的外协回收弹窗，2026-10-10 删掉其余 9 处），
    // 不适用 CLAUDE.md「跨页面写
    // 操作不做穷举失效」策略（那条针对写点散落多域、补齐等于穷举的情形），补失效
    // 成本近乎零：把「改完映射重开对话框才可见」升级成「下一次读即见」。
    await invalidateShelfProcessMappingsQuery(qc);
    showCreate.value = false;
    await fetchData();
    ElMessage.success('已保存');
  } catch (e: unknown) {
    // 2026-09-21 收紧：catch 由 any 改为 unknown，按 TS 严格模式要求做 Error 判别
    const msg = e instanceof Error ? e.message : String(e);
    ElMessage.error(msg || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function doDeactivate(id: string) {
  await deactivateShelf(id);
  await fetchData();
  ElMessage.success('已停用');
}

onMounted(async () => {
  await fetchData();
  try {
    const res = await listProcesses({ limit: 200 });
    allProcesses.value = res.items;
  } catch {
    /* ignore */
  }
  // 2026-08-28 改造：传 el-table 实例 ref 即可，composable 内部解析表头 <tr> +
  // MutationObserver 自愈（表头首次出现 / EP 重建都能覆盖）。
  drag.applyDrag(tableRef);
});
</script>

<style lang="scss" scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  h2 {
    margin: 0;
    font-size: 18px;
  }
}
.field-hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
/* 负载率列「capacity 无效 → —」的占位色，与同列 ElTag 的普通档可读性对齐 */
.muted {
  color: #909399;
}
</style>
