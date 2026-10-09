<!--
  PartFailInspectionDialog.vue

  零件详情页「指定工序」对话框（品检打回 `POST /prod/batches/{id}/to-process`）。

  2026-10-10 从 `PartDetail.vue` 抽出：shell 里它占了一块 el-dialog（含工序下拉 + 品检
  备注 + 目标批次回显 + 那条「目标货架由后端自动选」的说明），把 shell 撑到近 900 行。

  边界：**纯受控表单壳**，不认识 actions、不 import vue-router / api。
    - 目标批次（`inspectionBatch`）由父级传入并**原样回显** —— 它同时是父级那两个按钮
      的显隐判据与两个品检写操作的锚，口径唯一（`composables/inspectionBatch.ts`），
      本组件绝不再自己挑一次批次。
    - 提交只 emit `confirm`，请求 / 失败提示 / 关闭时机由父级决定（同页另外几个弹窗
      都按这个约定走：组件管「用户填了什么」，shell 管「这次操作成没成」）。

  ⚠️ **根元素必须是单个普通 div**：本组件包着 `el-dialog`，而 `el-dialog` 内部是
    teleport（`ElPopper` / teleport 占位）形态 ⇒ 拿它当组件根会让组件变成多根 vnode
    （Vue 在两侧插锚点）。同页 `BatchCard` 踩过同款坑（CLAUDE.md「拖拽投放」），
    卡片组件的根必须是单个元素才等于它的 vnode DOM footprint。

  ⚠️ 目标货架下拉已不存在：`to-process` 不再收货架字段，货架由后端按负载自动选
    （CLAUDE.md「货架自动选择」）。表单里保留那条 info alert 就是为了让现场明白
    「为什么没有货架可选」。
-->
<template>
  <div class="part-fail-inspection-dialog">
    <el-dialog
      :model-value="modelValue"
      title="指定工序 — 选择下一道工序"
      :width="dlg.width"
      :top="dlg.top"
      :fullscreen="dlg.fullscreen"
      :close-on-click-modal="false"
      @update:model-value="emit('update:modelValue', $event)"
      @closed="onClosed"
    >
      <el-form label-width="96px">
        <el-form-item label="目标批次">
          <span class="mono">{{ inspectionBatch?.batch_label ?? '—' }}</span>
          <span v-if="inspectionBatch" class="muted">
            （{{ inspectionBatch.quantity }} 件，当前状态：{{
              statusLabelOf(inspectionBatch.status)
            }}）
          </span>
        </el-form-item>
        <el-form-item label="下一道工序" required>
          <el-select
            v-model="processId"
            placeholder="请先选择下一道工序"
            filterable
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="p in processes"
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
        <el-form-item label="品检备注">
          <el-input
            v-model="note"
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
          title="指定工序后零件回到「在生产货架上」状态（目标货架由系统按负载自动选择），下一道工序与备注已写入事件历史；工人领取时可在卡片上看到备注。"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button type="warning" :loading="submitting" :disabled="!processId" @click="onConfirm"
          >确认指定工序</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { PartBatch } from '@/api/parts';
import type { Process } from '@/types/process';
import { useDialogSize } from '@/composables/useDialogSize';

const props = defineProps<{
  /** 对话框可见性（v-model:modelValue）。 */
  modelValue: boolean;
  /**
   * 品检锚批次（父级 `resolveInspectionBatch` 的派生）。null = 当前没有可流转的品检
   * 批次，此时父级的两个品检按钮整体不渲染、本框也只可能被外部唤起 —— 一律回显「—」。
   */
  inspectionBatch: PartBatch | null;
  /** 工序下拉数据（共享 `useProcessesQuery` 的响应式派生，打开即已就位）。 */
  processes: Process[];
  /** 父级正在提交（两个品检动作共用的提交态）。 */
  submitting: boolean;
  /** 批次状态 → 中文文案（`usePartDetail.statusLabelOf`）。 */
  statusLabelOf: (s: string | null | undefined) => string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', visible: boolean): void;
  /** 确认提交。备注已 trim、空串归一为 null（后端 `note` 可空）。 */
  (e: 'confirm', payload: { processId: string; note: string | null }): void;
}>();

const dlg = useDialogSize({ desktopWidth: 480 });

// 表单局部态：工序未选时确认键 disabled，父级拿不到空 processId。
const processId = ref('');
const note = ref('');

function resetFields(): void {
  processId.value = '';
  note.value = '';
}

// 关闭（× / ESC / 取消按钮三条路径都汇到 el-dialog 的 `closed`）与打开各清一次，
// 保证「每次打开都是干净的」；打开这一次兜住任何不经 closed 的重新显示。
function onClosed(): void {
  resetFields();
}
watch(
  () => props.modelValue,
  (v) => {
    if (v) resetFields();
  },
);

function onConfirm(): void {
  if (!processId.value) return;
  emit('confirm', { processId: processId.value, note: note.value.trim() || null });
}
</script>

<style lang="scss" scoped>
.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}
.muted {
  color: var(--text-secondary);
}
.opt-tag {
  margin-left: 6px;
}
</style>
