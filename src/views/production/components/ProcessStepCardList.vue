<!--
  ProcessStepCardList.vue
  工序制定页右栏：拖拽工序卡片列表。
  2026-09-11 新增。

  CLAUDE.md 合规：
  - #10：容器 ref 在 mount 时已存在（非 v-if / 非 el-table tbody），用 useDraggable 而非 useLazyDraggable。
  - #11：step.xxx 模板引用加空值守卫（虽然 :key 不会出空行，但保持习惯）。
  - #13：本组件不直接用 h() 渲染节点（卡片用 <el-card> 模板），无相关违规。
-->
<template>
  <el-card shadow="never" class="step-list-card">
    <template #header>
      <div class="toolbar">
        <el-button type="primary" size="small" @click="onAdd">
          <el-icon><Plus /></el-icon>
          <span>添加工序</span>
        </el-button>
        <el-tag size="large" effect="plain" class="total-minutes">
          总耗时：{{ totalMinutes }} 分钟
        </el-tag>
        <el-alert
          v-if="hasOutsource"
          type="warning"
          :closable="false"
          show-icon
          title="本流程包含外协工序，发送前需报价审批"
        />
        <div class="toolbar-spacer" />
        <el-button :disabled="!dirty" :loading="saving" type="success" size="small" @click="onSave">
          保存
        </el-button>
        <el-button :disabled="!dirty" text size="small" @click="onReset">
          重置
        </el-button>
      </div>
    </template>

    <div v-if="steps.length === 0" class="empty-state">
      <el-empty description="该零件暂无工序，点击「添加工序」开始配置" :image-size="80" />
    </div>

    <div v-else ref="containerRef" class="card-list">
      <el-card
        v-for="(step, idx) in steps"
        :key="step.uid"
        shadow="hover"
        class="step-card"
      >
        <div v-if="step" class="step-row">
          <div class="step-row-line">
            <el-icon class="drag-handle" :size="18" color="#909399"><Rank /></el-icon>
            <span class="step-index">工序 {{ idx + 1 }}</span>
            <el-select
              v-model="step.process_id"
              filterable
              clearable
              size="small"
              placeholder="选择工序"
              class="step-select"
              @change="(id: string) => onProcessChange(step, id)"
            >
              <el-option
                v-for="p in processes"
                :key="p.id"
                :label="`${p.code} ${p.name}`"
                :value="p.id"
              />
            </el-select>
            <el-tag
              v-if="step.category"
              :type="step.category === 'INHOUSE' ? 'primary' : 'warning'"
              size="small"
            >
              {{ CATEGORY_LABEL[step.category] }}
            </el-tag>
            <span class="step-minutes-label">预计</span>
            <el-input-number
              v-model="step.estimated_minutes"
              :min="0"
              :step="1"
              :precision="0"
              size="small"
              :controls="false"
              class="step-minutes"
            />
            <span class="step-minutes-unit">分钟</span>
            <el-button
              link
              type="danger"
              size="small"
              class="step-delete"
              @click="onDelete(step)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
          <el-input
            v-model="step.note!"
            placeholder="备注（选填，最多 100 字）"
            size="small"
            maxlength="100"
            show-word-limit
            class="step-note"
          />
        </div>
      </el-card>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Delete, Plus, Rank } from '@element-plus/icons-vue'
import { useDraggable } from 'vue-draggable-plus'
import { ElMessage } from 'element-plus'
import type { ProcessStep } from '@/types/partProcess'
import { PROCESS_CATEGORY_LABEL } from '@/types/process'
import { usePartProcessDesign } from '../composables/usePartProcessDesign'

const props = defineProps<{
  partId: string | null
}>()

const CATEGORY_LABEL = PROCESS_CATEGORY_LABEL

const {
  processes,
  getFlowByPartId,
  upsertSteps,
  deleteStep,
  newStep,
  summaries,
} = usePartProcessDesign()

const steps = ref<ProcessStep[]>([])
const savedSnapshot = ref<string>('') // JSON.stringify 当前已保存的 steps
const dirty = ref(false)
const saving = ref(false)

// 当前 partId 对应流程的派生
const currentFlow = computed(() => (props.partId ? getFlowByPartId(props.partId) : null))
const totalMinutes = computed(() => (props.partId ? summaries(props.partId).total_minutes : 0))
const hasOutsource = computed(() => (props.partId ? summaries(props.partId).has_outsource_approval : false))

/** 当 partId 变化或外部流程变更：载入当前流程到本地 steps，更新 dirty。 */
watch(
  () => props.partId,
  (newId) => {
    if (!newId) {
      steps.value = []
      savedSnapshot.value = ''
      dirty.value = false
      return
    }
    const f = getFlowByPartId(newId)
    steps.value = f ? f.steps.map((s) => ({ ...s })) : []
    savedSnapshot.value = JSON.stringify(steps.value)
    dirty.value = false
  },
  { immediate: true },
)

/** 步骤本地修改：标 dirty，触发自动保存（800ms 防抖）。 */
let saveTimer: ReturnType<typeof setTimeout> | null = null
watch(
  steps,
  () => {
    if (!props.partId) return
    dirty.value = JSON.stringify(steps.value) !== savedSnapshot.value
    if (saveTimer) clearTimeout(saveTimer)
    if (dirty.value) {
      saveTimer = setTimeout(() => { void doAutoSave() }, 800)
    }
  },
  { deep: true },
)

async function doAutoSave(): Promise<void> {
  if (!props.partId) return
  upsertSteps(props.partId, steps.value)
  savedSnapshot.value = JSON.stringify(steps.value)
  dirty.value = false
}

function onAdd(): void {
  if (!props.partId) {
    ElMessage.warning('请先选择零件')
    return
  }
  steps.value = [...steps.value, newStep()]
}

function onDelete(step: ProcessStep): void {
  steps.value = steps.value.filter((s) => s.uid !== step.uid)
}

function onProcessChange(step: ProcessStep, id: string): void {
  const p = processes.value.find((pp) => pp.id === id)
  if (!p) {
    step.process_id = ''
    step.process_code = ''
    step.process_name = ''
    step.category = 'INHOUSE'
    return
  }
  step.process_id = p.id
  step.process_code = p.code
  step.process_name = p.name
  step.category = p.category
}

async function onSave(): Promise<void> {
  if (!props.partId) return
  saving.value = true
  try {
    await doAutoSave()
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存失败')
  } finally {
    saving.value = false
  }
}

function onReset(): void {
  if (!props.partId) return
  const f = getFlowByPartId(props.partId)
  steps.value = f ? f.steps.map((s) => ({ ...s })) : []
  savedSnapshot.value = JSON.stringify(steps.value)
  dirty.value = false
}

// ============ 拖拽 ============
// 容器 ref 在 mount 时已存在（非 v-if/非 el-table tbody，CLAUDE.md #10 不触发 useLazyDraggable）。
const containerRef = ref<HTMLElement | null>(null)
useDraggable(containerRef, steps, {
  animation: 200,
  handle: '.step-card',
  ghostClass: 'step-card-ghost',
  chosenClass: 'step-card-chosen',
  dragClass: 'step-card-drag',
})
</script>

<style lang="scss" scoped>
.step-list-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
    overflow: auto;
  }
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.toolbar-spacer {
  flex: 1;
}
.total-minutes {
  font-weight: 600;
}
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.card-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.step-card {
  margin-bottom: 8px;
  cursor: grab;
  &:active {
    cursor: grabbing;
  }
  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
  }
}
.step-card-ghost {
  opacity: 0.4;
  background: var(--el-color-primary-light-9);
}
.step-card-chosen {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.step-card-drag {
  transform: rotate(1.5deg);
}

.step-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.step-row-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.drag-handle {
  cursor: grab;
  &:active {
    cursor: grabbing;
  }
}
.step-index {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
  flex-shrink: 0;
}
.step-select {
  flex: 1;
  min-width: 200px;
}
.step-minutes-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.step-minutes {
  width: 130px;
}
.step-minutes-unit {
  font-size: 12px;
  color: var(--text-secondary);
}
.step-delete {
  flex-shrink: 0;
}
.step-note {
  width: 100%;
}
</style>
