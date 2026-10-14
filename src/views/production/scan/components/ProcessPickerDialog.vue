<!--
  ProcessPickerDialog.vue

  HMI 工序选择弹窗（2026-07-17）。
  - el-tabs (自产 / 外协) 切工序大类
  - 每个 tab body 是 HmiPickerCard kind='process' 网格
  - 预填 currentProcessId（来自工件 next_process）并自动选对应 category tab
  - 「下一步」文案按 kind 区分（RETURN → 选货架 / INSPECT → 选送检架）

  props:
    modelValue: boolean                 弹窗可见
    kind?: 'return' | 'inspection' | 'takeover' | 'outsource'
                                          picker 用途（只影响 title / 作用说明 / 下一步按钮文案；
                                          2026-10-15 新增 takeover（扫码接管）与 outsource
                                          （外协确认收回）两个 kind，供 LocateDialog 的
                                          手填下一道工序弹窗复用；作用说明那行也只在这两个
                                          kind 下渲染）
    currentProcessId?: string | null    工件 next_process_id，预填为推荐
    excludeProcessIds?: string[]        不可选的工序 id（显示为禁用卡片 + hint）
    allowedProcessIds?: string[] | null 限定可展示的工序 id 集合（2026-10-16 新增，缺省
                                          null = 不限定）
    hint?: string                       常驻横幅提示（缺省不渲染）
    showClose?: boolean                 是否显示右上角 ×（缺省 true；传 false 把关闭权收在
                                          footer 两键上，供「本框是某条路径唯一提交入口」
                                          的调用方使用，见 prop 的详细注释）
  emits:
    update:modelValue(v: boolean)
    confirm(processId: string)
    cancel()
-->
<template>
  <el-dialog
    :model-value="modelValue"
    :title="titleText"
    width="min(95vw, 1100px)"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="showClose"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <!-- 2026-10-04 新增 hint：调用方要在弹窗里传达的**常驻**信息（放回页链尾
         「加工完成后请送检」）。不用 ElMessage.toast 传 —— Element Plus 的弹层
         z-index 由 PopupManager 递增分配，后开的 el-dialog 遮罩必然盖住先发的 toast，
         工人在全屏遮罩前看不到那句 3 秒后自动消失的提示。横幅放在 loading / error /
         tabs 三种状态之上，任何状态下都可见。 -->
    <el-alert
      v-if="hint"
      class="picker-hint"
      type="warning"
      :closable="false"
      show-icon
      :title="hint"
    />
    <div v-if="loading" class="loading-state">
      <el-icon :size="36" class="is-loading"><Loading /></el-icon>
      <p>正在加载工序列表...</p>
    </div>
    <div v-else-if="errorMessage" class="error-state">
      <el-icon :size="36" color="#f56c6c"><CircleCloseFilled /></el-icon>
      <p class="error-text">{{ errorMessage }}</p>
    </div>
    <div v-else>
      <!-- 按 kind 给一句「选完会发生什么」。⚠️ **只渲染在 takeover / outsource 两个 kind
           下**：放回页（return）与送检页（inspection）走的是既有观感，加一行说明文字
           是对两个不在本组件职责内的页面的可见 UI 变更。两个新 kind 的确认动作不选货架，
           工人需要一个能确认语义的地方，故它们才有这句。 -->
      <p v-if="showPurpose" class="picker-purpose">{{ kindText.purpose }}</p>
      <el-tabs v-model="activeTab" class="process-tabs">
        <el-tab-pane v-for="cat in tabs" :key="cat.key" :label="cat.label" :name="cat.key">
          <div v-if="cat.processes.length === 0" class="tab-empty">
            <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
            <p>{{ tabEmptyText(cat.label) }}</p>
          </div>
          <div v-else class="card-grid">
            <HmiPickerCard
              v-for="p in cat.processes"
              :key="p.id"
              kind="process"
              :code="p.code"
              :name="p.name"
              :category="p.category"
              :is-selected="p.id === selectedId"
              :disabled="excludeProcessIds.includes(p.id)"
              :hint="excludeProcessIds.includes(p.id) ? '当前工序不可选' : undefined"
              @select="onSelect(p.id)"
            />
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <template #footer>
      <el-button size="large" @click="onCancel">取消</el-button>
      <el-button
        type="primary"
        size="large"
        :disabled="!selectedId"
        class="confirm-btn"
        @click="onConfirm"
      >
        <el-icon><Select /></el-icon>
        <span>{{ nextButtonText }}</span>
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 工序大按钮 picker（2026-07-17，HMI 重设计）。
 *
 * 数据源：共享基础数据层 `useProcessesQuery({ limit: 200 })`（2026-10-20 接入，此前是本组件
 * 内裸调 `listProcesses`）—— 工序字典是跨域基础数据，生产队列看板 `QueueBoard.vue` 读的是
 * 同一条 queryKey（`qk.processesOptions({ limit: 200 })`），同屏两处打开只发一次往返。
 * `staleTime: 30_000` / `gcTime: 5 * 60 * 1000`（共享层统一口径），弹窗关着的 5 分钟内
 * 再开直接命中缓存、零等待 —— 放回页「换一道工序」是工人高频路径，车间网络下每次开弹窗
 * 白等一个 200 行字典往返是不可接受的。
 * enabled 闸门取 `() => props.modelValue`：弹窗不可见时零请求。
 *
 * 可展示范围由 `allowedProcessIds` 决定 —— 传了只渲染该集合（扫码接管 / 外协收回两条自助恢复路径按
 * 工人工种收窄），不传则渲染全量（放回页 `ScanReturnParts.vue`，`kind="return"`，观感逐字
 * 不变）。
 *
 * 收窄的产品理由：接管与收回的目标工序必须落在**当前工人的工种映射内**（写端点会拿这条
 * 闸门拒不在集合内的工序），而这两条路径上工序已经能由工种唯一确定 —— 让工人从全量工序
 * 里挑一个再被写端点拒，是把一条本该由后端判好的事做成了工人的负担。放回页不在收窄范围
 * 内：那里的下一道工序是「活做完了下一站是谁」，工序链上有什么就选什么，与工种授权无关。
 *
 * 工件 next_process_id 推荐态通过 currentProcessId prop 传入，预填选中并切到对应 category tab。
 *
 * 与同目录其它 picker 一样基于 HmiPickerCard 视觉规范（kind=process），
 * 视觉一致性靠共享组件保证。
 */
import { computed, ref, watch } from 'vue';
import { Box, CircleCloseFilled, Loading, Select } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import HmiPickerCard from './HmiPickerCard.vue';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import type { ProcessSchema } from '@/composables/queries/schemas';
import type { Process } from '@/types/process';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /**
     * picker 用途。**只影响文案**（title / 作用说明 /「下一步」按钮），**不改任何行为**：
     *  - `return`     —— 放回页选下一道工序；
     *  - `inspection` —— 选送检对应工序。⚠️ **当前无调用方**（送检页 `ScanInspectParts.vue`
     *    根本没 import 本组件，这条是留着给「将来送检页也要选工序」的取值位；写注释时别把它
     *    算成既有调用方，见 review 第 1 轮的登记）；
     *  - `takeover`   —— 2026-10-15 新增：扫码接管（`POST /prod/scan/take-over`）手填下一道；
     *  - `outsource`  —— 2026-10-15 新增：外协确认收回（`POST /prod/scan/outsource-receive`）
     *    手填下一道。
     *  后两个是 `LocateDialog`（扫码找件诊断弹窗）的复用方：它们的写端点在
     *  `chain_state !== 'NEXT'` 时都要求前端**给出** `next_process_id`（⚠️ 「给出」不等于
     *  「工人手选」：工种候选恰好一条时 `LocateDialog` 直接把那一条带上，根本不弹本框）。
     *  这两个 kind 也只接收 `allowedProcessIds` 收窄后的候选集（放回页 `ScanReturnParts.vue`
     *  不传该 prop，观感逐字不变）。
     */
    kind?: 'return' | 'inspection' | 'takeover' | 'outsource';
    /** 工件 next_process_id：预填选中并标推荐（橙色边框） */
    currentProcessId?: string | null;
    /** 不可选的工序 id 列表（被排除的卡片显示为禁用 + hint） */
    excludeProcessIds?: string[];
    /**
     * 2026-10-16 新增：限定可展示的工序 id 集合。传了 ⇒ `load()` 只保留该集合内的工序；
     * **不传（默认 `null`）⇒ 渲染全部工序**（放回页 `ScanReturnParts.vue`，`kind="return"`，
     * 不传这个 prop、观感逐字不变）。
     *
     * 集合来自后端按工种算好的候选（locate 出参的 `worker_processes`），前端只做过滤，
     * 不自己再判「这个工种能不能做这道工序」—— 写端点用的是同一份判据，两处各判一次
     * 迟早漂移。
     *
     * ⚠️ `null` 与 `[]` 语义不同：`null` = 不限定，`[]` = 一个都不展示（空态文案会明确说
     * 「你的工种在这个分类下没有工序」）。把两者混为一谈会让工种未映射工序的情形退回
     * 全量展示。
     */
    allowedProcessIds?: string[] | null;
    /** 常驻横幅提示（el-alert）；缺省 / 空串不渲染。所有 kind 都可用，与用途无关。 */
    hint?: string;
    /**
     * 是否显示右上角 × 按钮（默认 true = 保持既有观感）。
     *
     * 2026-10-15 新增，**只为把关闭权交给「本框是某条路径唯一出口」的调用方**：× 只 emit
     * `update:modelValue(false)`、**不发 `cancel`**，调用方在 `cancel` 里做的收尾（清待填
     * 状态）一律不会发生。`LocateDialog` 的接管 / 外协收回手填流就属于这种调用方 ——
     * 那条链上本框是提交那个写端点的唯一入口，故它传 `:show-close="false"`，关闭权收在
     * footer 的「取消」/「下一步」两键上。
     */
    showClose?: boolean;
  }>(),
  {
    kind: 'return',
    currentProcessId: null,
    excludeProcessIds: () => [],
    allowedProcessIds: null,
    hint: '',
    showClose: true,
  },
);

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 确认后把整条 Process 传给父组件；父组件按 process.id 提交 + 用 name/code 展示 */
  confirm: [process: Process];
  cancel: [];
}>();

const selectedId = ref<string | null>(null);
const activeTab = ref<'INHOUSE' | 'OUTSOURCE'>('INHOUSE');

/**
 * 2026-10-20：工序字典改走共享基础数据层 `useProcessesQuery`（此前是本组件内裸调
 * `listProcesses`，弹窗每开一次打一次 200 行字典请求、零缓存零去重）。
 *
 * - `limit: 200` 与生产队列看板 `QueueBoard.vue` 逐字相同 ⇒ 同一条 queryKey
 *   （`qk.processesOptions({ limit: 200 })`）⇒ 同屏两处只发一次往返。
 * - `enabled: () => props.modelValue` ⇒ 弹窗不可见时零请求（弹窗关着时这条工序字典对
 *   本组件没有用途）。闸门只挡发起请求、不挡读缓存：缓存新鲜时打开直接命中，零等待。
 * - `staleTime: 30_000` / `gcTime: 5 * 60 * 1000` 由共享 hook 统一，本组件不覆写。
 */
const processesQuery = useProcessesQuery({ limit: 200 }, { enabled: () => props.modelValue });

/**
 * 列表三态由 query 直接派生。`isPending`（无数据）而非 `isFetching`（含后台 refetch）：
 * 后台 refetch 时不该把已经在屏的卡片整片换成 loading 骨架，工人会以为弹窗坏了。
 */
const loading = computed<boolean>(() => processesQuery.isPending.value);
const errorMessage = computed<string | null>(() => {
  const err = processesQuery.error.value;
  if (!err) return null;
  const msg = err instanceof Error ? err.message : String(err);
  return msg || '加载失败';
});

// 错误提示走 toast（error-state 那块横幅另有模板渲染）。用 watch 而不是模板副作用：
// 同一次失败只弹一次，且错误态本身由上面的 errorMessage 驱动，二者不会各说各话。
watch(errorMessage, (msg) => {
  if (!msg) return;
  ElMessage.error(msg);
  // 加载失败时清空预填：只弹了个错误、确认键却还能点，工人就会提交一个本轮没校验过的工序 id。
  selectedId.value = null;
});

/** 四个 kind 的文案映射（**纯文案**，不改变组件的任何行为分支）。
 *
 *  取舍：原先只有 `inspection` 与「其余」两条分支，`takeover` / `outsource` 会各自落到
 *  「其余」那条、放回页的标题与「选货架」按钮文案出现在接管流程里 —— 工人读到的是一句
 *  与本次动作无关的话。逐 kind 列出来后**新增 kind 忘了补文案表是编译期错误**
 *  （`Record<NonNullable<typeof props.kind>, …>` 的键集合由 props 声明推出，不是靠运行时
 *  兜底的 `''`）。 */
const KIND_TEXT: Record<
  NonNullable<typeof props.kind>,
  { title: string; purpose: string; next: string }
> = {
  return: {
    title: '选择下一道工序',
    purpose: '确认后工件按负载放到合适的货架。',
    next: '下一步 · 选货架',
  },
  inspection: {
    title: '选择送检对应工序',
    purpose: '确认后工件送进品检区。',
    next: '下一步 · 选送检架',
  },
  takeover: {
    title: '选择接管后的下一道工序',
    purpose: '这批的工序链推不出下一道，请手工指定；接管后这批会落到你选的工序上。',
    next: '接管到这道工序',
  },
  outsource: {
    title: '选择收回后的下一道工序',
    purpose: '这批的工序链推不出下一道，请手工指定；收回后这批会落到你选的工序上。',
    next: '收回到这道工序',
  },
};

const kindText = computed(() => KIND_TEXT[props.kind]);

/** 「作用说明」那行是否渲染：只在两个自助恢复 kind 下渲染（见模板内注释）。 */
const showPurpose = computed(() => props.kind === 'takeover' || props.kind === 'outsource');

const titleText = computed<string>(() => kindText.value.title);

const nextButtonText = computed<string>(() => kindText.value.next);

interface TabEntry {
  key: 'INHOUSE' | 'OUTSOURCE';
  label: string;
  processes: Process[];
}

const tabs = computed<TabEntry[]>(() => [
  {
    key: 'INHOUSE' as const,
    label: '自产',
    processes: processes.value.filter((p) => p.category === 'INHOUSE'),
  },
  {
    key: 'OUTSOURCE' as const,
    label: '外协',
    processes: processes.value.filter((p) => p.category === 'OUTSOURCE'),
  },
]);

/**
 * 守门 schema 的 `description` / `color` 是**可选键**（后端 `skip_serializing_if`，None 时
 * 整个键从 JSON 里消失），而 `types/process.ts::Process` 把两者声明成「必填、值可 undefined」
 * —— 运行时取值逐字相同，只差「键可能压根不存在」。这里显式补齐成 `null` 过一道，而不是去
 * 改 `Process` 的声明：那是全仓零件 / 工序域共用的 wire 镜像，动它会波及十几个消费方。
 */
function toProcesses(items: ProcessSchema[]): Process[] {
  return items.map((p) => ({ ...p, description: p.description ?? null, color: p.color ?? null }));
}

/** 一次取值 = 工序全集 + 收窄集合，两者打包成**同一个**快照对象。
 *
 *  ⚠️ 卡片集与空态文案必须来自同一次取值：若「候选集」与「是否收窄」分别响应式，分两次读
 *  prop / data 就会出现自相矛盾态 —— 弹窗开着、候选集从 `[a,b]` 换成 `[]` 时卡片还停在
 *  `[a,b]`、空态文案却已翻成「你的工种暂无可选工序」：同一屏两句话互相打脸，而两句话
 *  都「有依据」。
 *
 *  快照在三个时刻各取一次：弹窗开关 / `currentProcessId` 变化（调用方换推荐项）/ query
 *  数据变化（首次拿到或后台 refetch 换新数据）。`allowedProcessIds` **刻意不进 watch 依赖**：
 *  父组件每次渲染给新数组引用会让本回调空跑，而本组件的候选集在一次打开期间本就不该变
 *  （换集的那条路径会连带换掉整行数据与动作结论，用户必须重新走一遍点击）。 */
const snapshot = ref<{ items: Process[]; allowed: string[] | null } | null>(null);

/** 收窄后的工序全集（收窄在**拿到全量之后本地过滤**，不下推到请求：
 *  那条 list 端点没有按 id 过滤的入参，候选集合也只有几百条，本地过滤比多造一条端点便宜）。 */
const processes = computed<Process[]>(() => {
  const s = snapshot.value;
  if (!s) return [];
  const allowed = s.allowed;
  // `[]`（空数组）同样是「不展示任何工序」，与 `null`（不限定）的区别只体现在空态文案上。
  return allowed == null ? s.items : s.items.filter((p) => allowed.includes(p.id));
});

/** 是否处于「按工种收窄」形态（`allowedProcessIds` 传了数组，含空数组）。见 `snapshot`。 */
const restricted = computed<boolean>(() => snapshot.value?.allowed != null);

/**
 * tab 空态文案：收窄形态下「这个分类下你的工种一道工序都没有」与「这个分类本来就没有
 * 工序」是两件事，混成同一句会让人以为整个工种没配工序。
 */
function tabEmptyText(label: string): string {
  return restricted.value ? `「${label}」下你的工种暂无可选工序` : `「${label}」暂无工序`;
}

// 依赖三取：开关 + 预填推荐 + query 数据。数据项让「缓存已热 ⇒ 打开即渲染」成立（同步命中
// 缓存时 data 在 setup 期间就有值，本回调 immediate 跑一趟把快照取好）。
watch(
  [() => props.modelValue, () => props.currentProcessId, () => processesQuery.data.value],
  ([visible, currentId, data]) => {
    if (!visible || !data) return;
    // 收窄集合取成局部常量再与 items 一起塞进快照：见 snapshot 的注释。
    snapshot.value = { items: toProcesses(data.items), allowed: props.allowedProcessIds };
    // 先把 selectedId + activeTab 用 currentId 预填
    selectedId.value = currentId ?? null;
    if (currentId) {
      const matched = processes.value.find((p) => p.id === currentId);
      if (matched) {
        activeTab.value = matched.category === 'OUTSOURCE' ? 'OUTSOURCE' : 'INHOUSE';
      }
    } else {
      // 无 currentProcessId：默认自产 tab
      activeTab.value = 'INHOUSE';
    }
    // 预填项不在本次候选集内（已被软删、或不落在收窄集合内）：清空让用户重选
    if (selectedId.value && !processes.value.some((p) => p.id === selectedId.value)) {
      selectedId.value = null;
    }
    // 被排除的工序不能预填：清空（确认按钮会因 selectedId null 而禁用，强制用户改选）
    if (selectedId.value && props.excludeProcessIds.includes(selectedId.value)) {
      selectedId.value = null;
    }
  },
  { immediate: true },
);

function onSelect(id: string): void {
  selectedId.value = id;
}

function onConfirm(): void {
  if (!selectedId.value) {
    ElMessage.warning('请先选择工序');
    return;
  }
  const selected = processes.value.find((p) => p.id === selectedId.value);
  if (!selected) {
    // 不该发生：selectedId 是从 processes 派生出来的；保护一下
    ElMessage.error('所选工序已不可用，请重新选择');
    return;
  }
  emit('confirm', selected);
}

function onCancel(): void {
  emit('cancel');
  emit('update:modelValue', false);
}
</script>

<style lang="scss" scoped>
.picker-hint {
  margin-bottom: 12px;
  font-size: 16px;
}
/* 2026-10-15 新增：kind 作用说明行（见模板内同名注释）。 */
.picker-purpose {
  margin: 0 0 8px;
  color: #909399;
  font-size: 15px;
}
.process-tabs {
  // 抵消 el-dialog 默认内边距，让 tabs 内容贴边
  margin: -16px -8px;
  padding: 0 8px;
}
.tab-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  gap: 12px;
  color: #909399;
  p {
    margin: 0;
    font-size: 16px;
  }
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  padding: 16px 0;
  max-height: 60vh;
  overflow-y: auto;
}
.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
  gap: 12px;
  color: #606266;
  p {
    margin: 0;
  }
}
.error-state {
  color: #f56c6c;
  .error-text {
    font-size: 16px;
    font-weight: 600;
  }
}
.is-loading {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
/* HMI 触摸友好 tab 标签 */
:deep(.el-tabs__item) {
  font-size: 20px;
  font-weight: 600;
  padding: 0 32px;
  height: 56px;
  line-height: 56px;
}
:deep(.el-tabs__active-bar) {
  height: 4px;
}
.confirm-btn {
  min-width: 200px;
  font-size: 18px;
  font-weight: 600;
}
</style>
