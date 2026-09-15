<!--
  PartsBatchDispatchDialog.vue

  2026-08-22 从 PartsList.vue 抽出：批量下发对话框（货架 / 编程 两动作）。

  弹窗 width=480px（不绑 top，用 EP 默认 15vh）。
  2026-08-22 a11y：单包 radio-group 通过 `<el-form-item label="..." :for="''">` 清空
  for；radio-group 上加 aria-label。

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
      <!-- 2026-08-22 a11y：批量下发同样单包 radio-group -->
      <el-form-item label="下发方式" for="">
        <el-radio-group v-model="store.dispatch.batchDispatchAction" aria-label="下发方式">
          <el-radio-button value="shelf">下生产货架</el-radio-button>
          <el-radio-button value="programming">发编程</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <template v-if="store.dispatch.batchDispatchAction === 'shelf'">
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
      </template>
      <el-alert
        v-else
        type="info"
        :closable="false"
        title="将所选零件发送至 CNC 编程环节，零件状态变为「编程中」。"
        description="CNC 编程员在「待编程一览」中下载图纸、上传 G 代码后，会再下发到生产货架。"
      />
      <el-form-item>
        <span class="muted">
          已选 <strong>{{ store.batch.selectedIds.size }}</strong> 件
          <template v-if="store.batch.batchAction === 'print'">零件将执行此操作</template>
          <template v-else>PENDING 零件将执行此操作</template>
        </span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="store.dispatch.batchDispatchVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="store.dispatch.batchDispatchSubmitting"
        :disabled="
          store.dispatch.batchDispatchAction === 'shelf' &&
          (!store.dispatch.batchDispatchShelfId || !store.dispatch.batchDispatchNextProcessId)
        "
        @click="store.dispatch.onBatchDispatchConfirm"
        >确认</el-button
      >
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/parts/components/PartsBatchDispatchDialog.vue
//
// 2026-09-15 重构：状态全部来自 usePartsListStore（Pinia setup store）。
import { usePartsListStore } from '../composables/usePartsListStore';

const store = usePartsListStore();
</script>

<style lang="scss" scoped>
.muted {
  color: var(--text-secondary);
}
</style>
