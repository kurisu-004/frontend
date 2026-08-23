<!--
  PartsDispatchDialog.vue

  2026-08-22 从 PartsList.vue 抽出：单件下发对话框（直接下货架 / 发 CNC 编程）。

  弹窗 width=480px（不再绑 top，使用 EP 默认 15vh）。
  2026-08-22 a11y：单包 el-radio-group 触发 for= 指向非 labelable 元素警告，
  通过 `<el-form-item label="..." :for="''">` 显式清空 for；radio-group 上加 aria-label。
-->
<template>
  <el-dialog
    v-model="dispatchVisible"
    :title="dispatchMode === 'cnc' ? '发送至 CNC 编程' : '下发零件'"
    width="480px"
    @closed="onDispatchClosed"
  >
    <el-form label-width="96px">
      <!-- 2026-08-22 a11y：单包 el-radio-group 触发 for= 指向非 labelable 元素警告 -->
      <el-form-item label="下发方式" :for="''">
        <el-radio-group v-model="dispatchMode" aria-label="下发方式">
          <el-radio value="direct">直接下到生产货架</el-radio>
          <el-radio value="cnc">发送至 CNC 编程</el-radio>
        </el-radio-group>
      </el-form-item>
      <template v-if="dispatchMode === 'direct'">
        <!-- 2026-07-21：先选下一道工序，再选目标货架；货架候选按映射过滤 -->
        <el-form-item label="下一道工序" required>
          <el-select
            v-model="dispatchNextProcessId"
            placeholder="请先选择下一道工序"
            style="width: 100%"
            filterable
            clearable
          >
            <el-option
              v-for="p in filteredProcesses"
              :key="p.id"
              :label="`${p.code} / ${p.name}`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="目标货架" required>
          <el-select
            v-model="dispatchShelfId"
            placeholder="先选工序；货架候选按映射过滤"
            style="width: 100%"
            filterable
            clearable
            :disabled="!dispatchNextProcessId"
          >
            <el-option
              v-for="s in filteredShelves"
              :key="s.id"
              :label="s.name"
              :value="s.id"
            />
            <template #empty>
              <span class="muted">
                {{
                  dispatchNextProcessId
                    ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                    : '请先选择下一道工序'
                }}
              </span>
            </template>
          </el-select>
        </el-form-item>
      </template>
      <el-form-item v-else>
        <el-alert
          type="info"
          :closable="false"
          title="将零件发送至 CNC 编程环节，零件状态变为「编程中」。"
          description="CNC 编程员在「待编程一览」中下载图纸、上传 G 代码后，会再下发到生产货架。"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dispatchVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="dispatchSubmitting"
        :disabled="dispatchMode === 'direct' && (!dispatchShelfId || !dispatchNextProcessId)"
        @click="onDispatchConfirm"
      >
        {{ dispatchMode === 'cnc' ? '发送至 CNC 编程' : '确认下发' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/parts/components/PartsDispatchDialog.vue
//
// 2026-08-22 从 PartsList.vue 抽出：单件下发 dialog。
// 模板只对顶层 ref 自动解包 —— 从 props.ctx.* 取的嵌套 ref 必须先解构到 script 顶层。

import type { PartsListCtx } from '../composables/partsListCtx'

const props = defineProps<{ ctx: PartsListCtx }>()

// 解构 ctx → 顶层局部变量（模板自动解包）
const { dispatch } = props.ctx

const {
  dispatchVisible,
  dispatchMode,
  dispatchShelfId,
  dispatchNextProcessId,
  dispatchSubmitting,
  filteredShelves,
  filteredProcesses,
  onDispatchClosed,
  onDispatchConfirm,
} = dispatch
</script>

<style lang="scss" scoped>
.muted {
  color: var(--text-secondary);
}
</style>
