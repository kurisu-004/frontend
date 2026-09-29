<!--
  PartsDispatchDialog.vue

  2026-08-22 从 PartsList.vue 抽出：单件下发对话框（直接下货架）。
  2026-09-29 简化：删除「发送至 CNC 编程」模式（sendToProgramming 下线），仅保留
  直接下生产货架一条 path。dispatchMode 字段随 usePartDispatch 一并删除（'direct' 唯一）。

  弹窗 width=480px（不再绑 top，使用 EP 默认 15vh）。
  2026-08-22 a11y：单包 el-radio-group 触发 for= 指向非 labelable 元素警告，
  通过 `<el-form-item label="..." :for="''">` 显式清空 for；radio-group 上加 aria-label。

  2026-09-15 重构：状态全部来自 usePartsListStore（Pinia setup store），原 :ctx prop
  模式删除。
-->
<template>
  <el-dialog
    v-model="store.dispatch.dispatchVisible"
    title="下发零件"
    width="480px"
    @closed="store.dispatch.onDispatchClosed"
  >
    <el-form label-width="96px">
      <el-form-item label="下一道工序" required>
        <el-select
          v-model="store.dispatch.dispatchNextProcessId"
          placeholder="请先选择下一道工序"
          style="width: 100%"
          filterable
          clearable
        >
          <el-option
            v-for="p in store.dispatch.filteredProcesses"
            :key="p.id"
            :label="`${p.code} / ${p.name}`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="目标货架" required>
        <el-select
          v-model="store.dispatch.dispatchShelfId"
          placeholder="先选工序；货架候选按映射过滤"
          style="width: 100%"
          filterable
          clearable
          :disabled="!store.dispatch.dispatchNextProcessId"
        >
          <el-option
            v-for="s in store.dispatch.filteredShelves"
            :key="s.id"
            :label="s.name"
            :value="s.id"
          />
          <template #empty>
            <span class="muted">
              {{
                store.dispatch.dispatchNextProcessId
                  ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                  : '请先选择下一道工序'
              }}
            </span>
          </template>
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="store.dispatch.dispatchVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="store.dispatch.dispatchSubmitting"
        :disabled="
          !store.dispatch.dispatchShelfId || !store.dispatch.dispatchNextProcessId
        "
        @click="store.dispatch.onDispatchConfirm"
      >
        确认下发
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/parts/list/components/PartsDispatchDialog.vue
//
// 2026-09-15 重构：状态全部来自 usePartsListStore（Pinia setup store）。
// 2026-09-29 简化：dispatchMode 字段随 usePartDispatch 删除（'direct' 唯一），对话框
// 不再需要 el-radio-group 切换「直接下发 / 发编程」。
import { usePartsListStore } from '../composables/usePartsListStore';

const store = usePartsListStore();
</script>

<style lang="scss" scoped>
.muted {
  color: var(--text-secondary);
}
</style>
