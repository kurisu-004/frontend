<!--
  打印送货单对话框：`openXlsx/saveXlsx` 模板 round-trip 保住 merges / 列宽 / 打印设置，
  **单元格样式要另开 `readStyles` 才进模型**（见 utils/deliveryNoteWorkbook.ts 文件头）。

  送货单按收货单位分组（el-tabs）：一张送货单一个收货单位，按送货分组规则（或未分组的
  末级客户）分组，每组一个 tab / 一个 sheet，**每 sheet 装几行由模板版式决定**
  （零件版 10 行 / 检具版 25 行，见 `templateContract`）。

  「打印标签」不经本对话框（2026-10-09）：用户在表格里勾选零件 / 装配件行后直接导出，
  实现在 utils/deliveryNoteLabelExport（草稿卡片与详情页共用）。所以本组件只剩送货单
  一条链路，`mode` / 标签模式的模板区、司机下拉、勾选集合等全部随之下线。

  模板只有一个来源（2026-10-18，见 utils/deliveryNoteTemplate.ts 的 `TemplateSource`）：
  后端按**一级客户**绑定的那份。打开对话框时用 `note.customer_id`（**它就是一级客户 id**）
  调 `GET /print-templates/resolve`，命中即取字节（`GET /print-templates/{id}/content`）
  并探测版式；未绑定（业务码 21109）或自动选型失败时提示去「模板编辑」页
  （`/print-templates`）处理，**打印页没有任何上传入口**。

  ⚠️ **打印页不做逐格校验**（2026-10-18）：逐格校验（`assertTemplateMatches`）是「模板编辑」
  页上传闸的职责，那里是全仓唯一能在**入库前**把坏模板拦下来的时机。模板既然已经过了那道
  闸，打印侧再逐格验一遍带来的只有「管理员在 Excel 里改了一格小东西 ⇒ 整批单子打不出来」
  这种把管理员变成救火队员的失败形态。所以这里只做 `detectTemplateContract` 的**锚点探测**
  —— O(1) 读 4 格、判不出版式就是判不出，**不产生任何逐格差异清单**；判不出时给一句提示
  指向「模板编辑」页重新上传。

  表头排序 + 行拖拽 + 行拆分 + 列拖拽共存，行拖拽会清掉排序标记（自定义顺序优先）。

  交互契约：
  · 每个 tab 一张独立 el-table（子组件 `PrintGroupTable`）—— Sortable 绑的是 EP 内部
    渲染出的 `<tbody>`，多 tab 复用同一个实例会把 A 表的拖拽算到 B 表的下标上；
  · tab 顺序 = 分组键在 `line_items` 中**首次出现**的顺序；
  · tab name = groupKey（`g_<gid>` / `c_<l2id>` 语义字符串，非索引）；
  · 表头排序走 EP 内置比较 + 客户端 `sortPrintRows`，`prop` 是 snake_case 字段名本身；
  · 数量列**只读**，要改必须走行尾「拆分」（守恒校验在 PrintSplitEditor 里）；
  · 司机变更**在导出确认时随本次导出一并落库**（下拉切换是纯本地态）；没碰下拉就零 POST。
  · **司机不 gate 导出**（2026-10-16）：打印只是拿一张纸，页脚「送货人」没有司机名时
    留白即可，不该把用户挡在对话框里。指定司机的强制点是**一键送货** ——
    `POST /{id}/pickup` 入参只有 version、司机由服务端从单据上读（没司机返 21409），
    所以司机在那一步的确认对话框里选（`DeliveryDriverPickerDialog`），且那一步会先发
    `POST /{id}/driver` 拿新 version 再发 pickup。这里保留司机下拉纯粹是「顺手能改」：
    选了照旧随导出落库，不选就沿用单据上已有的司机。
  · **司机下拉只在零件版渲染**（2026-10-18）：检具版模板**没有「送货人」页脚格**（页脚只有
    表头右侧 I2 的送货日期），给了下拉也没有落点，选谁都不会印到纸上。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useDialogSize } from '@/composables/useDialogSize';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { useQueryClient } from '@tanstack/vue-query';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import { triggerBrowserDownload } from '@/utils/download';
import { formatChineseDeliveryDate } from '@/utils/deliveryDate';
import { setNoteDriver } from '@/api/com/deliveryNote';
import { useDeliveryDriversQuery } from '../composables/useDeliveryDriversQuery';
import { useDeliveryGroupsQuery } from '../composables/useDeliveryGroupsQuery';
import { invalidateDeliveryNotesQuery } from '../composables/useDeliveryNoteListStore';
import {
  buildDeliveryNotePrintColumnDefs,
  PRINT_PREVIEW_LIST_KEY,
} from '../deliveryNotePrintColumnDefs';
import type { DeliveryNoteLineItemData } from '../composables/deliveryNoteSchema';
import PrintGroupTable from './PrintGroupTable.vue';
import {
  detectTemplateContract,
  fetchTemplateBytes,
  type TemplateSource,
} from '../utils/deliveryNoteTemplate';
import {
  buildL2GroupMap,
  groupIntoSheets,
  groupRows,
  safeSheetName,
  type PrintGroupRef,
  type PrintRow,
} from '../utils/deliveryNotePrintRows';
import { renderDeliveryNoteWorkbook, XLSX_MIME } from '../utils/deliveryNoteWorkbook';
import { DELIVERY_NOTE_TEMPLATE_CONTRACT } from '../utils/deliveryNoteTemplateContract';
import type { DeliveryNoteTemplateContract } from '../utils/deliveryNoteTemplateContract';
import { fetchPrintTemplateContent, resolvePrintTemplate } from '@/api/printTemplates';

const props = defineProps<{
  modelValue: boolean;
  note: {
    id: string;
    version: number;
    delivery_note_no: string;
    part_count: number;
    /** 单据归属的 L1 客户 id —— 送货分组查询的入参（打印时才知道有没有分组规则）。 */
    customer_id: string;
    driver_worker_name: string | null;
    line_items: readonly DeliveryNoteLineItemData[];
  };
}>();

const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>();

const dlg = useDialogSize({ desktopWidth: 1200 });
const qc = useQueryClient();

// ============================================================
// 模板（一级客户绑定的那份，自动选用 + 版式探测）
// ============================================================
// 打开对话框时用 `note.customer_id`（**它就是一级客户 id**，送货单按 L1 建单）调
// `GET /print-templates/resolve`：
//   - 命中 ⇒ 取字节（`GET /print-templates/{id}/content`）+ `detectTemplateContract` 探版式，
//     探到才置 `templateSource = {kind:'api', id}`；
//   - 未命中（业务码 21109）⇒ 「去「模板编辑」页为该客户配置」。
//
// ⚠️ **为什么不逐格校验**：逐格校验是「模板编辑」页上传闸的职责，那里能在**入库前**把坏模板
// 拦下来，是全仓唯一的把关点；打印侧拿到的每一份都过了那道闸。再验一遍挡不住任何新东西，
// 只会让「管理员改了一格小东西」变成要联系管理员才能打印（详见文件头）。
const templateSource = ref<TemplateSource | null>(null);
const templateName = ref('');
/** 探测到的版式契约（零件版 / 检具版）；`null` = 判不出来（可导出闸因此关着）。
 *  sheet 容量、页脚实参、司机下拉显隐三处都按它分支。 */
const templateContract = ref<DeliveryNoteTemplateContract | null>(null);
/** 自动选型失败时的那一句提示（成功 / 未绑定时都是空串 = 不显示）。
 *  ⚠️ **声明必须排在 `resolveBoundTemplate` 之前**：它被那条 watch 直接写，
 *  `const` 在 TDZ，谁把 `resolveBoundTemplate` 往上挪就是运行时 `ReferenceError`。 */
const autoHint = ref('');
/** 打开对话框时那次 resolve + 取字节 + 探版式的进行中。 */
const boundResolving = ref(false);
/** 该一级客户**没有**绑定模板（业务码 21109）。与「还在查」区分开：前者要提示用户去
 *  「模板编辑」页上传，后者不能提示（那会让首次打开的用户以为系统坏了）。 */
const boundMissing = ref(false);
/** resolve 的自增代次：常驻挂载下（`DeliveryNoteDetail.vue` 的 `v-if` 只判 `detail.note`）
 *  「开 → 关 → 再开」会让两次 resolve 并飞，#1 落地那一刻没有任何东西拦它。
 *  代次守卫让「只有最新一次 resolve 能写状态」成为事实，附带修掉第二个症状：#1 的
 *  `finally` 会把 `boundResolving` 提前置 false，#2 还在飞时 loading 就消失了。 */
const resolveSeq = ref(0);

/** 判不出版式时的那一句（工具栏那一行与「导出」禁用原因共用）。
 *  ⚠️ **只给一句、不列逐格差异**：逐格差异是「模板编辑」页上传闸的产物，打印页拿到的是
 *  「这份模板不认识」这一个结论 —— 真要逐条列，得先有一份「已知版式」的假设，而那正是探测
 *  失败的原因。 */
const UNKNOWN_LAYOUT_HINT =
  '这份模板不匹配任何一套版式（零件版 / 检具版），请到「模板编辑」页重新上传';

/** 该一级客户未绑定模板的后端业务码（见 `api/printTemplates.ts::resolvePrintTemplate`）。 */
const TEMPLATE_NOT_BOUND_CODE = 21109;

/** 可导出所需的模板态：字节来源与探测到的版式都在（两者在 resolve 里同时置起）。 */
const templateOk = computed(() => templateSource.value !== null && templateContract.value !== null);

/** 工具栏上的版式标签（探测不出时为空串）。 */
const contractLabel = computed(() => {
  const c = templateContract.value;
  if (c === null) return '';
  return c.kind === 'gauge' ? '检具版' : '零件版';
});

/**
 * 打开对话框时按一级客户自动选用模板。
 *
 * ⚠️ **失败不弹 toast、只把原因摆进工具栏那一行**：这是一次后台自动选用，用户还没做任何
 * 事，弹一条红色错误只是噪音（`.auto-hint` 那行与图纸预览的 `.degrade-hint` 同一形态）。
 * ⚠️ **每次调用自增 `resolveSeq`，写任何状态前先比对代次**（见 `resolveSeq` 的说明）。
 */
async function resolveBoundTemplate(): Promise<void> {
  const customerId = props.note.customer_id;
  if (!props.modelValue || !customerId) return;
  const seq = (resolveSeq.value += 1);
  /** 迟到的旧代次不许写任何状态（含 `boundResolving`）。 */
  const stale = () => seq !== resolveSeq.value;
  boundResolving.value = true;
  try {
    const hit = await resolvePrintTemplate(customerId);
    // ⚠️ **出参是嵌套的**：`hit.template.*` 才是模板本体，`hit.customer_name` 是另一条
    // `t_customer` 查询给的一级客户名。后端没有 `content_url` 字段，取字节只有
    // `fetchPrintTemplateContent(id)` 这一条路。
    const bytes = await fetchPrintTemplateContent(hit.template.id);
    const { openXlsx } = await import('hucre');
    // 探测版式（O(1) 读 4 个锚点格）：判不出就是判不出，**不在这条链上逐格校验**。
    const contract = detectTemplateContract(await openXlsx(bytes));
    if (stale()) return;
    // 名字照写：判不出版式时用户仍要知道「出问题的是哪一份」。
    templateName.value = hit.template.original_filename;
    templateContract.value = contract;
    // 探不出版式就不留来源：导出按钮已经 disabled，留着只会让人以为「自动选用」这一步过了。
    templateSource.value = contract ? { kind: 'api', id: hit.template.id } : null;
    autoHint.value = contract ? '' : UNKNOWN_LAYOUT_HINT;
    boundMissing.value = false;
  } catch (e) {
    if (stale()) return;
    if ((e as { code?: number }).code === TEMPLATE_NOT_BOUND_CODE) {
      // 未绑定是**正常状态**（绝大多数客户还没配模板），不是失败：清空自动选用结果 + 置
      // 「未绑定」标志，让工具栏提示 + 「导出」禁用原因都说到点子上。
      templateSource.value = null;
      templateContract.value = null;
      templateName.value = '';
      boundMissing.value = true;
    } else {
      // 其它失败（网络 / 权限 / 库里那份字节解不开 / resolve 出参解析失败）：说清是「自动选用
      // 出了问题」而不是「没配模板」—— 用户去「模板编辑」页改配置是解决不了网络问题的。
      //
      // ⚠️ `console.warn` 是**必需**的一行：这里只有一句 12px 黄色小字，零 toast 零日志 ⇒
      // 「后端给 resolve 加了个字段 → printTemplateResolveSchema.parse 抛 → 全站客户的
      // 自动选用集体静默失效」这种故障在生产上完全不可发现。**这不是调试残留，别删。**
      console.warn('[print-template] 自动选用失败', e);
      templateSource.value = null;
      templateContract.value = null;
      templateName.value = '';
      boundMissing.value = false;
      autoHint.value = '自动选用该客户模板失败，请到「模板编辑」页重新上传';
    }
  } finally {
    if (!stale()) boundResolving.value = false;
  }
}

// ============================================================
// 司机
// ============================================================
const driverQuery = useDeliveryDriversQuery(computed(() => props.modelValue));
/** 仅本地选中态。切换下拉**不发请求**（2026-10-08：改动随「导出」确认一并落库，见
 *  persistSelectedDriver）—— 关对话框即放弃，与「改完就生效」的直觉相反是刻意的：
 * 打印对话框是一次性动作，点「取消」不该在服务端留下一条 version 变更。
 *
 *  2026-10-16：下拉**不再参与导出闸门**（见文件头），它只是「顺手改个司机」的便利口。 */
const driverId = ref<string>('');
/** 司机落库中（只在 persistSelectedDriver 的 await 期间为 true）。 */
const driverSaving = ref(false);

const hasDriver = computed(() => Boolean(props.note.driver_worker_name));
const selectedDriverName = computed(
  () => driverQuery.drivers.value.find((d) => d.id === driverId.value)?.name ?? null,
);
/** 司机下拉只在**零件版**渲染（检具版模板的页脚没有「送货人」格，详见文件头）。
 *  探测还没落定时也不渲染 —— 那段里导出是禁用的，让它先闪一下再消失只会让人以为界面坏了。 */
const showDriverPicker = computed(() => templateContract.value?.kind === 'part');

/**
 * 导出前把所选司机落库；成功返回 true。
 *
 * 落库判据只有一条：**用户在下拉里选过**（`driverId` 非空）。没碰过下拉 ⇒ 用单据上已有的
 * 司机名导出，`driverId` 保持 `''` ⇒ 不 POST（单据上也没有司机名时也不 POST —— 打印
 * 不再要求司机，页脚留白即可；指定司机是一键送货那一步的事，见文件头）。
 *
 * ⚠️ **不能拿司机名当判据**：司机名允许重名（后端列表同名时按 id 定序 ⇒ 同名是预期数据现状）。
 * 按名短路会让「选了同名不同 id 的司机」静默跳过落库 ⇒ 单据仍绑着旧 id，`POST /{id}/pickup`
 * 会用错人，用户的显式选择也进不了审计。省一次写不值得换一个语义洞。
 * 副作用：每次导出只要选了司机就 POST 一次（幂等、推进 version）—— 用户「明确选了司机」
 * 本身就值得留一条审计记录。
 *
 * `POST /com/delivery/note/{id}/driver` 会推进 version ⇒ 成功后失效本域，
 * 让详情 / 草稿看板看到新 version 与新司机名。
 */
async function persistSelectedDriver(): Promise<boolean> {
  const id = driverId.value;
  if (!id) return true;
  driverSaving.value = true;
  try {
    await setNoteDriver(props.note.id, { version: props.note.version, driver_worker_id: id });
    await invalidateDeliveryNotesQuery(qc);
    return true;
  } catch (e) {
    ElMessage.error((e as Error).message ?? '指定司机失败，已取消导出');
    // 落库失败最常见的是 409（手上 version 已被别人推进）。失效本域，下一轮 refetch
    // 就能拿到新 version，对话框里直接重试即成 —— 否则用户只能关页面重新进来。
    //
    // 2026-10-08 修正措辞：这一处失效的作用对象是**对话框所在的页面**，且扫码页上它
    // 真的会命中活跃 observer —— 第一宿主页 `DeliveryNoteScan.vue` 无条件实例化
    // `useDeliveryDraftBoard()`，其 `['delivery-notes','list',params]` observer 在选中
    // L1 时就是活的（要看到草稿卡、进而点开本对话框，L1 必然已选），而
    // `invalidateDeliveryNotesQuery` 失效的是整个 `['delivery-notes']` 前缀
    // ⇒ 草稿看板会回流。对话框自身不持有 `delivery-notes/*` 的 query。
    await invalidateDeliveryNotesQuery(qc);
    return false;
  } finally {
    driverSaving.value = false;
  }
}

// ============================================================
// 装配件合并模式
// ============================================================
const hasAssemblies = computed(() => props.note.line_items.some((li) => li.assembly_id));
/** 默认「合并一套」：装配件子件逐行打会让收货人收到一堆看不懂的子件。 */
const mergeMode = ref<'merge' | 'separate'>('merge');

// ============================================================
// 分组（el-tabs）
// ============================================================
// 分组规则来自 `GET /com/delivery/group?customer_id=<L1>`：分组内的 L2 按组名归堆，
// 未分组的 L2 **各自一 sheet**（按 L2 拆单是收货习惯，合成一张收货人找不到自己那批）。
const groupsQuery = useDeliveryGroupsQuery(
  computed(() => (props.modelValue ? props.note.customer_id : '')),
);

const groupsByKey = computed(() =>
  groupRows(props.note.line_items, buildL2GroupMap(groupsQuery.data.value), mergeMode.value),
);

const tabs = computed<PrintGroupRef[]>(() => [...groupsByKey.value.values()].map((v) => v.ref));
const activeTab = ref<string>('');

/** 每 tab 的行数组 / 排序态（key = groupKey）。子组件只发事件，写回集中在这里。 */
const rowsByKey = ref<Record<string, PrintRow[]>>({});
const sortModeByKey = ref<Record<string, 'column' | 'custom'>>({});

/** 重建各 tab 的行（拷贝，拖拽与排序只动副本，父组件的 map 不被就地改）。 */
function rebuildRows(): void {
  const rows: Record<string, PrintRow[]> = {};
  const sorts: Record<string, 'column' | 'custom'> = {};
  for (const [key, { rows: r }] of groupsByKey.value) {
    rows[key] = r.map((x) => ({ ...x }));
    sorts[key] = 'column';
  }
  rowsByKey.value = rows;
  sortModeByKey.value = sorts;
  if (!rowsByKey.value[activeTab.value]) activeTab.value = tabs.value[0]?.groupKey ?? '';
}

// 打开 / mergeMode / 分组数据变化 → 重建各 tab 的行。
watch(
  () => [props.modelValue, mergeMode.value, groupsQuery.data.value] as const,
  ([open]) => {
    if (!open) {
      // 关对话框即放弃本地态：详情页的 v-if 只判 detail.note，组件不卸载
      // （destroy-on-close 只销毁插槽）⇒ 不复位的话「选司机 → 取消 → 重开」下拉还显示
      // 那个**从未落库**的司机。「本单已指定：X」提示继续承担回显职责（VO 只有名字，
      // 无法预选下拉项）。
      driverId.value = '';
      return;
    }
    rebuildRows();
  },
  { immediate: true },
);

// 打开沿 → 重置模板态并按一级客户自动选用。
//
// ⚠️ **独立一条 watch，不塞进上面那条**：上面那条还跟着 mergeMode / 分组数据变化触发，把
// 自动选型挂进去会让「改一次合并模式」重打一次 `resolve` + `content`（两次往返）。
//
// ⚠️ **`note.customer_id` 在一次挂载内不会变**（详情页切单据才会），而切单据必然经过关闭
// 再打开 —— 这条是 resolve 只在打开沿跑一次的前提。**它是假设不是保证**，所以下面另有
// `resolveSeq` 代次守卫兜住「开了又关又开」时两次 resolve 并飞的场景。
//
// ⚠️ **换单必须清模板态**：详情页可以在对话框**关着**的时候换单（`v-if="detail.note"` 前后
// 都为真、组件不卸载、`modelValue` 不变 ⇒ 只看 modelValue 的 watch 一个字都不会触发），那样
// A 单的模板会跟着飘到 B 单上。**这一段不挂在 `if (!open) return` 之后** —— 关着的时候也必须
// 清，否则「关着换单 → 再打开」时 `prev` 已经是新单号、`noteChanged` 判 false，模板照样飘。
watch(
  [() => props.modelValue, () => props.note.id],
  (next, prev) => {
    const open = next[0];
    const noteChanged = prev !== undefined && prev[1] !== next[1];
    if (noteChanged) clearTemplateState();
    if (!open) return;
    // 重开一律重新 resolve：模板只来自后端绑定，每次打开都按当下的绑定取一次（换绑 /
    // 删除都在下一次打开时生效）。
    clearTemplateState();
    autoHint.value = '';
    boundMissing.value = false;
    void resolveBoundTemplate();
  },
  { immediate: true },
);

/** 清掉三个模板态（来源 / 文件名 / 版式）。换单与重开共用，抽出来只为两处口径一致。 */
function clearTemplateState(): void {
  templateSource.value = null;
  templateName.value = '';
  templateContract.value = null;
}

function rowsOf(groupKey: string): PrintRow[] {
  return rowsByKey.value[groupKey] ?? [];
}

function setRows(groupKey: string, next: PrintRow[]): void {
  rowsByKey.value = { ...rowsByKey.value, [groupKey]: next };
}

function setSortMode(groupKey: string, mode: 'column' | 'custom'): void {
  sortModeByKey.value = { ...sortModeByKey.value, [groupKey]: mode };
}

function tabNameOf(groupKey: string): string {
  return tabs.value.find((t) => t.groupKey === groupKey)?.groupName ?? groupKey;
}

const totalRows = computed(() =>
  Object.values(rowsByKey.value).reduce((sum, rows) => sum + rows.length, 0),
);

/** 每 sheet 容量（零件版 10 行 / 检具版 25 行）。
 *
 *  探测还没落定（`templateContract` 仍是 null）时退回零件版：那一段里导出是禁用的，
 *  这个数只出现在 tab 下方的提示里；等 resolve 落定它会跟着版式一起改。 */
const sheetCapacity = computed(
  () => templateContract.value?.dataRowCount ?? DELIVERY_NOTE_TEMPLATE_CONTRACT.dataRowCount,
);

/** sheet 分配（容量 / 跨组不混 / sheet 名清洗都在纯函数里，这里只做组装）。 */
const sheets = computed(() =>
  groupIntoSheets(
    new Map(
      Object.entries(rowsByKey.value).map(([k, rows]) => [
        k,
        { ref: { groupKey: k, groupName: tabNameOf(k) }, rows },
      ]),
    ),
    sheetCapacity.value,
  ),
);

// ============================================================
// 列可见性（快照 key = print_preview_dialog，既有值不许改）
// ============================================================
// 列可见性是**对话框级**偏好（N 张表共用一份快照，key 沿用既有 `print_preview_dialog`）；
// 列**顺序**是**每张表**一份（快照 key = `print_preview_dialog__<groupKey>`，见
// deliveryNotePrintColumnDefs::printColumnOrderListKey）—— 一个序列表达不了 N 张表的
// 列顺序，用户拖 A 表的列不该牵动 B 表。老版本那条单序列
// `print_preview_dialog_columnOrder` 随之作废，不可迁移。
const columnDefs = buildDeliveryNotePrintColumnDefs();
const columnVisibility = useColumnVisibility(columnDefs, { listKey: PRINT_PREVIEW_LIST_KEY });
/** 「重置列顺序」信号量：popover 只有一颗按钮，作用在全部 N 张表上。 */
const resetOrderToken = ref(0);

// ============================================================
// 导出
// ============================================================
const exporting = ref(false);

/** 页脚「送货人」要写的名字；单据上没有司机名时为空串（页脚留白，不阻断导出）。 */
const driverNameOfExport = computed(
  () => selectedDriverName.value ?? props.note.driver_worker_name ?? '',
);

const exportDisabled = computed(() => {
  if (exporting.value) return true;
  return !templateOk.value || totalRows.value === 0;
});

/** 「导出」disabled 的原因（tooltip 显示；空串 = 可导出）。
 *  ⚠️ **司机不在阻断原因里**：导出 gate 只剩模板与行项两项。 */
const exportHint = computed(() => {
  // ⚠️ **「正在自动选用」要排在最前**：resolve 在途期间状态是 `templateSource=null` /
  // `templateContract=null` / `boundMissing=false`，下面三条分支都不命中 ⇒ tooltip 会落到
  // 最后一行「判不出版式」。而真实状态是「正在自动选用…」—— 这段窗口 = 2 次往返 + 一次
  // 完整 xlsx 解析（几百 ms ~ 数秒），是**每次打开都必然经过**的常态，不是边缘情况。
  if (boundResolving.value) return '正在自动选用该客户的绑定模板…';
  if (!templateOk.value) {
    // ⚠️ 21109（该一级客户没绑模板）要说清「去哪儿解决」：打印页没有上传入口，唯一去处是
    // 「模板编辑」页给这个客户配一份常驻模板。
    if (boundMissing.value) return '该一级客户未绑定打印模板，请到「模板编辑」页为该客户配置';
    // 另两句失败原因（取字节 / 探测抛错、判不出版式）与工具栏那一行同源，避免两处措辞漂移。
    return autoHint.value || UNKNOWN_LAYOUT_HINT;
  }
  if (totalRows.value === 0) return '没有可打印的行项';
  return '';
});

function todayParts(): { year: string; month: string; date: string } {
  const d = new Date();
  return {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1),
    date: String(d.getDate()),
  };
}

/**
 * 按探测到的版式构造页脚实参。
 *
 * ⚠️ 两套版式的页脚**不是同一组占位符**（判别联合，见 deliveryNoteWorkbook.ts 的
 * `FooterFor`）：零件版是页脚区的送货人 + 年月日三段，检具版只有表头右侧 I2 的一个送货日期
 * （整段 `YYYY年M月D日`，不是拆开的三段）。配套关系由泛型在编译期兜住，这里只负责挑实参。
 */
function footerOf(contract: DeliveryNoteTemplateContract) {
  return contract.kind === 'gauge'
    ? { kind: 'gauge' as const, deliveryDate: formatChineseDeliveryDate(new Date()) }
    : { kind: 'part' as const, driverName: driverNameOfExport.value, ...todayParts() };
}

async function onExport(): Promise<void> {
  if (exportDisabled.value) return;
  const contract = templateContract.value;
  const src = templateSource.value;
  if (!contract || !src) return;
  exporting.value = true;
  try {
    // 司机先落库（**仅在用户选过司机时**才发请求，见 persistSelectedDriver）：选了下拉
    // 就是「这次确认了送货人」。落库失败（409 / 21409 / 网络）时中止，不产出文件 ——
    // 否则会下载出一张页脚写着 A 司机、单据上却是 B 司机的送货单。
    if (!(await persistSelectedDriver())) return;
    const bytes = await fetchTemplateBytes(src);
    const out = await renderDeliveryNoteWorkbook(bytes, sheets.value, footerOf(contract), contract);
    triggerBrowserDownload(
      // `out` 是 hucre 的 Uint8Array（TS 5.7+ 泛型到 ArrayBufferLike，而
      // BlobPart 要 ArrayBuffer 变体）—— 复制进一个新的 ArrayBuffer 再包，零拷贝
      // 假设都不成立但体积只有几十 KB，且比 `as BlobPart` 强转诚实。
      new Blob([out.slice().buffer as ArrayBuffer], { type: XLSX_MIME }),
      `${props.note.delivery_note_no}.xlsx`,
    );
    ElMessage.success(`已导出 ${sheets.value.length} 个 sheet`);
    emit('update:modelValue', false);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '导出失败');
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="打印送货单"
    :width="dlg.width"
    :top="dlg.top"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="print-toolbar">
      <!-- 模板：只展示后端按一级客户绑定的那份，**没有上传入口**。版式标签（零件版 /
           检具版）是锚点探测的结果，导出时按它取 sheet 容量与页脚（见 `templateContract`）。 -->
      <span class="toolbar-item">
        模板
        <span v-if="templateName" class="file-name">{{ templateName }}</span>
        <el-tag v-if="templateOk" type="primary" size="small" effect="plain">
          该客户绑定模板
        </el-tag>
        <el-tag v-if="templateOk" type="success" size="small" effect="plain">
          {{ contractLabel }}
        </el-tag>
      </span>

      <!-- 自动选用出问题的那一句（成功 / 未绑定时都是空串 ⇒ 不渲染）。静默兜底会让
           「管理员明明配了模板却打不出来」无人察觉（照图纸预览 `.degrade-hint` 的同一
           形态：降级必须是有告知的）。 -->
      <span v-if="autoHint" class="auto-hint">{{ autoHint }}</span>

      <!-- 列可见性是**对话框级**偏好（N 张表共用一份 print_preview_dialog 快照，
           见下方列可见性段注释）。 -->
      <span class="toolbar-item">
        <ColumnVisibilityPopover
          :defs="columnDefs"
          :model-value="columnVisibility.currentMap"
          @update:model-value="columnVisibility.update"
          @reset="columnVisibility.showAll"
          @reset-order="resetOrderToken += 1"
        />
      </span>

      <!-- 司机下拉：送货单模板页脚的「送货人」字段，**只在零件版渲染**（检具版模板没有
           「送货人」页脚格，给了下拉也没有落点）。**非必填**（导出不按它 gate），选了照旧随
           导出落库，不选则用单据上已有的司机；「一键送货」那一步才强制指定（见
           DeliveryDriverPickerDialog）。 -->
      <span v-if="showDriverPicker" class="toolbar-item">
        司机
        <el-select
          v-model="driverId"
          placeholder="选择司机（可不选）"
          filterable
          style="width: 180px"
          :loading="driverSaving"
          :disabled="exporting || driverSaving"
        >
          <el-option
            v-for="d in driverQuery.drivers.value"
            :key="d.id"
            :value="d.id"
            :label="d.name"
          />
        </el-select>
        <span v-if="hasDriver && !driverId" class="muted">
          本单已指定：{{ note.driver_worker_name }}
        </span>
      </span>

      <!-- 2026-08-04：仅当单上含装配件子件时显示（el-radio-button 更醒目） -->
      <el-radio-group v-if="hasAssemblies" v-model="mergeMode" size="small" class="merge-toggle">
        <el-radio-button value="merge">合并一套</el-radio-button>
        <el-radio-button value="separate">分开打子件</el-radio-button>
      </el-radio-group>
    </div>

    <el-tabs v-model="activeTab" class="print-tabs">
      <el-tab-pane v-for="t in tabs" :key="t.groupKey" :name="t.groupKey">
        <template #label>
          <span class="tab-label">
            <span class="tab-label__code">{{ t.groupName }}</span>
            <span class="tab-label__count">({{ rowsOf(t.groupKey).length }})</span>
          </span>
        </template>
        <PrintGroupTable
          :rows="rowsOf(t.groupKey)"
          :sort-mode="sortModeByKey[t.groupKey] ?? 'column'"
          :column-defs="columnDefs"
          :column-visibility="columnVisibility"
          :group-key="t.groupKey"
          :reset-order-token="resetOrderToken"
          @update:rows="(next: PrintRow[]) => setRows(t.groupKey, next)"
          @update:sort-mode="(m: 'column' | 'custom') => setSortMode(t.groupKey, m)"
        />
        <div class="group-hint">
          本组 {{ rowsOf(t.groupKey).length }} 条 → Sheet「{{ safeSheetName(tabNameOf(t.groupKey)) }}」（容量
          {{ sheetCapacity }}/张）
          <span v-if="sortModeByKey[t.groupKey] === 'custom'" class="muted">（已手动调序）</span>
        </div>
      </el-tab-pane>
    </el-tabs>


    <template #footer>
      <span class="footer-hint">共 {{ totalRows }} 条 · {{ sheets.length }} 个 sheet</span>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <!-- data-role 供组件级用例定位「导出」按钮（按钮数随分组数变化，按位置取是脆的） -->
      <el-tooltip :disabled="!exportHint" :content="exportHint" placement="top">
        <span class="btn-wrap">
          <el-button
            type="primary"
            data-role="export"
            :loading="exporting"
            :disabled="exportDisabled"
            @click="onExport"
          >
            导出 xlsx
          </el-button>
        </span>
      </el-tooltip>
    </template>
  </el-dialog>
</template>

<style scoped>
.print-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.toolbar-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.file-name {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.auto-hint {
  font-size: 12px;
  color: var(--el-color-warning-dark-2, #b88230);
}
.merge-toggle {
  margin-left: auto;
}
.group-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.footer-hint {
  float: left;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 32px;
}
.tab-label {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.tab-label__code {
  font-weight: 600;
}
.muted {
  color: var(--el-text-color-secondary);
}
/* el-tooltip 的触发子元素必须能接收事件的单元素；按钮 disabled 后不派发事件，
   套一层 span 承接 hover（否则禁用态拿不到 tooltip）。 */
.btn-wrap {
  display: inline-block;
}
</style>