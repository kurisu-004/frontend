<!--
  ProcessStepCardList.vue
  工序制定页右栏：拖拽工序卡片列表。
  2026-09-11 新增。
  2026-09-16 改造：删除「dirty=true → 800ms 自动保存」防抖链路，改为显式保存按钮触发。
  原 watch(steps) 内的 setTimeout(doAutoSave) 让保存按钮永远 disabled（dirty 在 POST 成功后
  立刻被清零）；现在持久化入口唯一化为 onSave → store.editor.save()。
  2026-09-12 改造（第三轮 UI 精修）：
    - 删除 header 中的「外协警示」<el-alert>（S3）
    - 删除 header 中的「+ 添加工序」按钮（S3）；改在卡片列表末尾放虚线方框占位（点击 → onAdd）
    - 删除卡片中的 <Rank /> 拖拽图标（整卡可拖，无需视觉提示）+ 自产/外协 <el-tag>（颜色由左侧 4px 竖条表达）
    - 删除按钮移到卡片第一列（flex first child）
    - 卡片左侧 4px 竖条按 step.color 着色，null 时回退 category 默认色（INHOUSE → 蓝 / OUTSOURCE → 橙）
    - 占位方框（.step-add-placeholder）显式排除拖拽（filter: '.step-add-placeholder'）
  2026-09-12 改造（第四轮 UI 精修）：
    - 「重置」按钮去掉文字，改为 RefreshLeft 图标 + el-tooltip（T1）
    - 改回 default button（非 text button，disabled 时更可见）
    - toolbar 单行：总耗时 tag + spacer + 保存 + 重置 icon（T1，20% 右栏 ≈256px 内能放下）

  2026-10-05 改造（数据层切 useProcessDesignStore）：
    - 步骤数组、dirty、saving、总耗时、增删改 / 保存 / 重置**全部由 store.editor 持有**
      （服务端链在 store 的 query 里，未保存草稿在 store 私有 draftSteps）；
      本组件退化为纯展示 + 事件接线，删掉三个 watch（partId 同步 / flows 同步 / dirty 同步）
      与本地 savedSnapshot。
    - 行内编辑从 v-model 改成 `:model-value` + `@update:model-value` → store.editor.patchStep /
      selectProcess。**不能继续用 v-model 直改对象**：没有草稿时 steps 派生自服务端链，
      就地改那个对象会在链 query 重算时静默丢失（草稿必须经 store 播种出来）。
    - 拖拽仍绑三参形态的 useLazyDraggable（列表内重排场景，见 useLazyDraggable 注释）：
      steps 是可写 computed，Sortable 的内建 splice 落到 store 草稿上。

  CLAUDE.md 合规：
  - #10：容器 ref 位于 v-else（空态 vs 列表切换），初始 mount 时为 null → 用 useLazyDraggable。
  - #11：step.xxx 模板引用加空值守卫（虽然 :key 不会出空行，但保持习惯）。
  - #13：本组件不直接用 h() 渲染节点（卡片用 <el-card> 模板），无相关违规。
-->
<template>
  <el-card shadow="never" class="step-list-card">
    <template #header>
      <!-- 2026-09-12 第三轮：header 仅保留总耗时 + 保存 + 重置，删除 +添加工序 / 外协警示 -->
      <!-- 2026-09-12 第四轮：重置 button 改 icon-only + tooltip，避免右栏 20% 宽度下换行。
           tag 去掉「总耗时：」前缀（"X 分钟"更紧凑，让 tag+保存+重置 在 234px 内单行排开）。
           保存 button 用 margin-left: auto 推到右侧（替代原来 div spacer，更省空间）。
           2026-09-16：重复点击防御——依赖 EP el-button 在 :loading="saving" 时自动禁用
           点击（无需另加 disabled 锁）；同时 :disabled="!dirty" 防止无变更时点击。 -->
      <div class="toolbar">
        <el-tooltip :content="`总耗时 ${totalMinutes} 分钟`" placement="top">
          <el-tag size="default" effect="plain" class="total-minutes">
            {{ totalMinutes }} 分钟
          </el-tag>
        </el-tooltip>
        <el-button
          class="toolbar-save"
          :disabled="!dirty"
          :loading="saving"
          type="success"
          size="small"
          @click="onSave"
        >
          保存
        </el-button>
        <el-tooltip content="重置" placement="top" :disabled="!dirty">
          <el-button :disabled="!dirty" size="small" @click="store.editor.resetSteps()">
            <el-icon><RefreshLeft /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
    </template>

    <div v-if="steps.length === 0" class="empty-state">
      <!-- 2026-10-05：选中零件的工艺链在途时别先闪「暂无工序」—— steps 是草稿派生，
           链 query 到达前它必然是空数组（chainPending 区分「在加载」与「真的没工序」）。 -->
      <el-empty
        :description="chainPending ? '正在加载工序…' : '该零件暂无工序，点击下方方框添加第一道工序'"
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
              @click="store.editor.removeStep(step.uid)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
            <span class="step-index">工序 {{ idx + 1 }}</span>
            <el-select
              :model-value="step.process_id"
              filterable
              clearable
              size="small"
              placeholder="选择工序"
              class="step-select"
              @update:model-value="(id: string) => store.editor.selectProcess(step.uid, id)"
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
              :model-value="step.estimated_minutes"
              :min="0"
              :step="1"
              :precision="0"
              size="small"
              :controls="false"
              class="step-minutes"
              @update:model-value="(v: number | undefined) => patchMinutes(step.uid, v)"
            />
            <span class="step-minutes-unit">分钟</span>
          </div>
          <el-input
            :model-value="step.note ?? ''"
            placeholder="备注（选填，最多 100 字）"
            size="small"
            maxlength="100"
            show-word-limit
            class="step-note"
            @update:model-value="(v: string) => patchNote(step.uid, v)"
          />
        </div>
      </el-card>

      <!-- 2026-09-12 第三轮：列表末尾虚线占位方框（点击 → onAdd） -->
      <div class="step-add-placeholder" :data-draggable="false" @click="onAdd">
        <el-icon :size="20"><Plus /></el-icon>
        <span>添加工序</span>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Delete, Plus, RefreshLeft } from '@element-plus/icons-vue';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import { ElMessage } from 'element-plus';
import type { ProcessStep } from '@/types/partProcess';
import { useProcessDesignStore } from '../composables/useProcessDesignStore';

const props = defineProps<{
  partId: string | null;
}>();

// 不变量 #3：消费侧禁止解构 store，一律 store.query.xxx / store.editor.xxx。
const store = useProcessDesignStore();

const steps = computed<ProcessStep[]>(() => store.editor.steps);
const processes = computed(() => store.query.processes);
const totalMinutes = computed<number>(() => store.editor.totalMinutes);
const dirty = computed<boolean>(() => store.editor.dirty);
const saving = computed<boolean>(() => store.editor.saving);
const chainPending = computed<boolean>(() => store.query.chainPending);

function onAdd(): void {
  if (!props.partId) {
    ElMessage.warning('请先选择零件');
    return;
  }
  store.editor.addStep();
}

/** 预计耗时：el-input-number 清空时给 undefined，归一成 0（后端 CHECK 约束 ≥ 0）。 */
function patchMinutes(uid: string, value: number | undefined): void {
  store.editor.patchStep(uid, { estimated_minutes: value ?? 0 });
}

/** 备注：空串归一成 null（后端「空串 / null 视作 None」）。 */
function patchNote(uid: string, value: string): void {
  store.editor.patchStep(uid, { note: value || null });
}

/** 显式持久化。失败时 store 的 onError 已弹错，这里 catch 住即可：草稿与 dirty
 *  都保持不变（用户编辑不丢，可再点保存重试）。 */
async function onSave(): Promise<void> {
  if (!props.partId) return;
  try {
    await store.editor.save();
  } catch {
    // 已提示，不重复弹
  }
}

/** 2026-09-12 第三轮：卡片左侧 4px 竖条颜色。优先 step.color，无则回退 category 默认色。 */
function cardColor(step: ProcessStep): string {
  if (step.color) return step.color;
  return step.category === 'OUTSOURCE' ? '#E6A23C' : '#409EFF';
}

// ============ 拖拽 ============
// 容器 ref 位于 v-else 块（空态/列表切换），mount 时可能为 null → useLazyDraggable
// 强制 immediate: false + watch elRef 转非 null 时 start(el)，符合 CLAUDE.md #10。
// 2026-09-12 第三轮：filter: '.step-add-placeholder' 显式排除占位方框，避免 Sortable 误选。
// ⚠️ 这里必须传 list（列表内重排语义，见 useLazyDraggable 头注）：steps 是 store 草稿的
// 可写 computed，Sortable 的内建 splice 落到草稿上；不传 list 则拖拽只剩 DOM 变化、
// 数据不动。
const containerRef = ref<HTMLElement | null>(null);
useLazyDraggable(containerRef, steps, {
  animation: 200,
  handle: '.step-card',
  filter: '.step-add-placeholder', // 占位方框不参与拖拽
  preventOnFilter: true, // 占位方框上 mouseup 不触发拖拽开始
  ghostClass: 'step-card-ghost',
  chosenClass: 'step-card-chosen',
  dragClass: 'step-card-drag',
});
</script>

<style lang="scss" scoped>
.step-list-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  // 2026-09-12 第四轮：缩小 el-card__header 横向 padding，给 toolbar 更多空间
  // （默认 18px 20px 会把 234px 的右栏压成 192px usable）
  :deep(.el-card__header) {
    padding: 8px 12px;
  }
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
  gap: 8px;
  flex-wrap: wrap;
  // 2026-09-12 第四轮：子项强制 nowrap，让「总耗时 + 保存 + 重置」优先单行排开
  // 视口极窄时（如 1440px viewport + 20% 右栏 ≈234px）下，应能单行排开；
  // 若更窄（如 < 200px 极窄屏），自然换行到第 2 行，仍保持紧凑。
  :deep(*) {
    white-space: nowrap;
  }
}
.toolbar-save {
  // 2026-09-12 第四轮：用 margin-left: auto 替代 div spacer 把保存按钮推到右侧
  // （div spacer 占用 min-width:8px 是多余的，margin: auto 可以做到 0 宽占位）
  margin-left: auto;
}
.total-minutes {
  font-weight: 600;
  flex-shrink: 0;
  // 紧凑 padding：与按钮同高（size="default" 24px）
  :deep(.el-tag__content) {
    padding: 0 8px;
  }
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
