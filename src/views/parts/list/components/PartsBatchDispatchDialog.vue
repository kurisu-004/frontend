<!--
  PartsBatchDispatchDialog.vue

  2026-08-22 从 PartsList.vue 抽出：批量下发对话框。
  2026-09-29 简化：删除「发编程」action（batchDispatchAction='programming' 不再支持，
  sendToProgramming 下线），仅保留「下生产货架」一条 path。批量对话框不再需要
  el-radio-button 切换 action。

  弹窗 width=480px（不绑 top，用 EP 默认 15vh）。

  2026-09-15 重构：状态全部来自 usePartsListStore（Pinia setup store），原 :ctx prop
  模式删除；selectedIds 是 reactive Set，经 store 深代理后身份保持、.size 可跟踪，
  模板直接 store.batch.selectedIds.size 即可触发响应式更新（无需 computed 包一层）。
-->
<template>
  <el-dialog
    v-model="store.dispatch.batchDispatchVisible"
    title="批量下发"
    width="480px"
    destroy-on-close
  >
    <el-form label-width="96px">
      <el-form-item label="下一道工序" required>
        <el-select
          v-model="store.dispatch.batchDispatchNextProcessId"
          placeholder="请先选择下一道工序"
          style="width: 100%"
          filterable
          clearable
        >
          <el-option
            v-for="p in store.dispatch.batchFilteredProcesses"
            :key="p.id"
            :label="`${p.code} / ${p.name}`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="目标货架" required>
        <el-select
          v-model="store.dispatch.batchDispatchShelfId"
          placeholder="先选工序；货架候选按映射过滤"
          style="width: 100%"
          filterable
          clearable
          :disabled="!store.dispatch.batchDispatchNextProcessId"
        >
          <el-option
            v-for="s in store.dispatch.batchFilteredShelves"
            :key="s.id"
            :label="s.name"
            :value="s.id"
          />
          <template #empty>
            <span class="muted">
              {{
                store.dispatch.batchDispatchNextProcessId
                  ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                  : '请先选择下一道工序'
              }}
            </span>
          </template>
        </el-select>
      </el-form-item>
      <el-form-item>
        <span class="muted">
          已选 <strong>{{ store.batch.selectedIds.size }}</strong> 件
          PENDING 零件将执行此操作
        </span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="store.dispatch.batchDispatchVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="store.dispatch.batchDispatchSubmitting"
        :disabled="
          !store.dispatch.batchDispatchShelfId || !store.dispatch.batchDispatchNextProcessId
        "
        @click="store.dispatch.onBatchDispatchConfirm"
        >确认</el-button
      >
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/parts/list/components/PartsBatchDispatchDialog.vue
//
// 2026-09-15 重构：状态全部来自 usePartsListStore（Pinia setup store）。
// 2026-09-29 简化：batchDispatchAction 字段随 usePartDispatch 删除（'shelf' 唯一），
// 对话框不再需要 el-radio-button 切换「下生产货架 / 发编程」。
import { usePartsListStore } from '../composables/usePartsListStore';

const store = usePartsListStore();
</script>

<style lang="scss" scoped>
.muted {
  color: var(--text-secondary);
}
</style>
