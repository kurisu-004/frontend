<!--
  ProcessStepCardList.vue
  工序制定页右栏：拖拽工序卡片列表。
  2026-09-11 新增。
  2026-09-12 改造（第三轮 UI 精修）：
    - 删除 header 中的「外协警示」<el-alert>（S3）
    - 删除 header 中的「+ 添加工序」按钮（S3）；改在卡片列表末尾放虚线方框占位（点击 → onAdd）
    - 删除卡片中的 <Rank /> 拖拽图标（整卡可拖，无需视觉提示）+ 自产/外协 <el-tag>（颜色由左侧 4px 竖条表达）
    - 删除按钮移到卡片第一列（flex first child）
    - 卡片左侧 4px 竖条按 step.color 着色，null 时回退 category 默认色（INHOUSE → 蓝 / OUTSOURCE → 橙）
    - 占位方框（.step-add-placeholder）显式排除拖拽（filter: '.step-add-placeholder'）

  CLAUDE.md 合规：
  - #10：容器 ref 位于 v-else（空态 vs 列表切换），初始 mount 时为 null → 用 useLazyDraggable。
  - #11：step.xxx 模板引用加空值守卫（虽然 :key 不会出空行，但保持习惯）。
  - #13：本组件不直接用 h() 渲染节点（卡片用 <el-card> 模板），无相关违规。
-->
<template>
  <el-card shadow="never" class="step-list-card">
    <template #header>
      <!-- 2026-09-12 第三轮：header 仅保留总耗时 + 保存 + 重置，删除 +添加工序 / 外协警示 -->
      <div class="toolbar">
        <el-tag size="large" effect="plain" class="total-minutes">
          总耗时：{{ totalMinutes }} 分钟
        </el-tag>
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
      <el-empty
        description="该零件暂无工序，点击下方方框添加第一道工序"
        :image-size="80"
      />
      <!-- 2026-09-12 第三轮：空态也展示占位方框（与有步骤时保持一致入口） -->
      <div class="step-add-placeholder step-add-placeholder--solo" @click="onAdd">
        <el-icon :size="20"><Plus /></el-icon>
        <span>添加工序</span>
      </div>
    </div>

    <div v-else ref="containerRef" class="card-list">
      <el-card
        v-for="(step, idx) in steps"
        :key="step.uid"
        shadow="hover"
        class="step-card"
        :style="{ borderLeft: `4px solid ${cardColor(step)}` }"
      >
        <div v-if="step" class="step-row">
          <div class="step-row-line">
            <!-- 2026-09-12 第三轮：删除按钮移到第一列 -->
            <el-button
              link
              type="danger"
              size="small"
              class="step-delete"
              :title="'删除工序 ' + (idx + 1)"
              @click="onDelete(step)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
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

      <!-- 2026-09-12 第三轮：列表末尾虚线占位方框（点击 → onAdd） -->
      <div
        class="step-add-placeholder"
        :data-draggable="false"
        @click="onAdd"
      >
        <el-icon :size="20"><Plus /></el-icon>
        <span>添加工序</span>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import { useLazyDraggable } from '@/composables/useLazyDraggable'
import { ElMessage } from 'element-plus'
import type { ProcessStep } from '@/types/partProcess'
import { usePartProcessDesign } from '../composables/usePartProcessDesign'

const props = defineProps<{
  partId: string | null
}>()

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
// 2026-09-12 第三轮：删除 hasOutsource 派生（不再展示外协警示）。
// 保留 summaries 调用以确保派生触发；如不再需要可后续清理。

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
    step.color = null
    return
  }
  step.process_id = p.id
  step.process_code = p.code
  step.process_name = p.name
  step.category = p.category
  // 2026-09-12 第三轮：选中工序时同步透传 color
  step.color = p.color ?? null
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

/** 2026-09-12 第三轮：卡片左侧 4px 竖条颜色。优先 step.color，无则回退 category 默认色。 */
function cardColor(step: ProcessStep): string {
  if (step.color) return step.color
  return step.category === 'OUTSOURCE' ? '#E6A23C' : '#409EFF'
}

// ============ 拖拽 ============
// 容器 ref 位于 v-else 块（空态/列表切换），mount 时可能为 null → useLazyDraggable
// 强制 immediate: false + watch elRef 转非 null 时 start(el)，符合 CLAUDE.md #10。
// 2026-09-12 第三轮：filter: '.step-add-placeholder' 显式排除占位方框，避免 Sortable 误选。
const containerRef = ref<HTMLElement | null>(null)
useLazyDraggable(containerRef, steps, {
  animation: 200,
  handle: '.step-card',
  filter: '.step-add-placeholder', // 占位方框不参与拖拽
  preventOnFilter: true, // 占位方框上 mouseup 不触发拖拽开始
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  padding-bottom: 32px;
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
  // 2026-09-12 第三轮：左侧 4px 竖条用 inline :style 控制颜色（borderLeft 不进 CSS 变量，
  // 因为颜色是动态 per-step）。留出 padding-left 让内容不被竖条盖住。
  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 14px 10px 14px;
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
  padding: 4px;
}
.step-note {
  width: 100%;
}

// 2026-09-12 第三轮：列表末尾虚线方框（点击 → onAdd）
.step-add-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
  margin-top: 4px;
  border: 1.5px dashed var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 13px;
  transition: all 0.15s;
  user-select: none;
  &:hover {
    border-color: var(--el-color-primary);
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
  }
  &--solo {
    // 空态时的占位方框（单独显示在 .empty-state 内）
    width: 80%;
    max-width: 320px;
  }
}
</style>
