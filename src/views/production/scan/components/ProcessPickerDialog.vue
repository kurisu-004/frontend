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
                                          手填下一道工序弹窗复用）
    currentProcessId?: string | null    工件 next_process_id，预填为推荐
    hint?: string                       常驻横幅提示（缺省不渲染）
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
      <!-- 2026-10-15 新增：按 kind 给一句「选完会发生什么」。两个新 kind（takeover /
           outsource）的确认动作不选货架，工人需要一个能确认语义的地方。 -->
      <p class="picker-purpose">{{ kindText.purpose }}</p>
      <el-tabs v-model="activeTab" class="process-tabs">
        <el-tab-pane v-for="cat in tabs" :key="cat.key" :label="cat.label" :name="cat.key">
          <div v-if="cat.processes.length === 0" class="tab-empty">
            <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
            <p>「{{ cat.label }}」暂无工序</p>
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
 * 数据源：一次性 GET /processes?limit=200 拉所有 INHOUSE+OUTSOURCE 工序，
 * 不按工人 scope 过滤（用户决策：显示全部 + 后端 strict invariant 兜底）。
 * 工件 next_process_id 推荐态通过 currentProcessId prop 传入，预填选中并切到对应 category tab。
 *
 * 与同目录其它 picker 一样基于 HmiPickerCard 视觉规范（kind=process），
 * 视觉一致性靠共享组件保证。
 */
import { computed, ref, watch } from 'vue';
import { Box, CircleCloseFilled, Loading, Select } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import HmiPickerCard from './HmiPickerCard.vue';
import { listProcesses } from '@/api/process';
import type { Process } from '@/types/process';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /**
     * picker 用途。**只影响文案**（title / 作用说明 / 「下一步」按钮），**不改任何行为**：
     *  - `return`     —— 放回页选下一道工序；
     *  - `inspection` —— 送检页选送检对应工序；
     *  - `takeover`   —— 2026-10-15 新增：扫码接管（`POST /prod/scan/take-over`）手填下一道；
     *  - `outsource`  —— 2026-10-15 新增：外协确认收回（`POST /prod/scan/outsource-receive`）
     *    手填下一道。
     *  后两个是 `LocateDialog`（扫码找件诊断弹窗）的复用方：它们的写端点在
     *  `chain_state !== 'NEXT'` 时都要求前端手填 `next_process_id`。
     */
    kind?: 'return' | 'inspection' | 'takeover' | 'outsource';
    /** 工件 next_process_id：预填选中并标推荐（橙色边框） */
    currentProcessId?: string | null;
    /** 不可选的工序 id 列表（被排除的卡片显示为禁用 + hint） */
    excludeProcessIds?: string[];
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

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const processes = ref<Process[]>([]);
const selectedId = ref<string | null>(null);
const activeTab = ref<'INHOUSE' | 'OUTSOURCE'>('INHOUSE');

/** 2026-10-15：四个 kind 的文案映射（**纯文案**，不改变组件的任何行为分支）。
 *
 *  取舍：原先只有 `inspection` 与「其余」两条分支，`takeover` / `outsource` 会各自落到
 *  「其余」那条、放回页的标题与「选货架」按钮文案出现在接管流程里 —— 工人读到的是一句
 *  与本次动作无关的话。逐 kind 列出来后，新增 kind 忘了补会落到 `''`（空串 ⇒ 按钮上没有
 *  文字），比「悄悄显示别人的文案」更容易被发现。 */
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

watch(
  () => [props.modelValue, props.currentProcessId] as const,
  async ([visible, currentId]) => {
    if (!visible) return;
    // 先把 selectedId + activeTab 用 currentId 预填；load 完成后保持
    selectedId.value = currentId ?? null;
    await load();
    if (currentId) {
      const matched = processes.value.find((p) => p.id === currentId);
      if (matched) {
        activeTab.value = matched.category === 'OUTSOURCE' ? 'OUTSOURCE' : 'INHOUSE';
      }
    } else {
      // 无 currentProcessId：默认自产 tab
      activeTab.value = 'INHOUSE';
    }
    // 被排除的工序不能预填：清空（确认按钮会因 selectedId null 而禁用，强制用户改选）
    if (selectedId.value && props.excludeProcessIds.includes(selectedId.value)) {
      selectedId.value = null;
    }
  },
  { immediate: true },
);

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  try {
    const resp = await listProcesses({ limit: 200 });
    processes.value = resp.items;
    // 若 currentProcessId 在新列表中找不到（已被删除），清空选中让用户重选
    if (selectedId.value && !processes.value.some((p) => p.id === selectedId.value)) {
      selectedId.value = null;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessage.value = msg || '加载失败';
    selectedId.value = null;
    ElMessage.error(errorMessage.value);
  } finally {
    loading.value = false;
  }
}

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
