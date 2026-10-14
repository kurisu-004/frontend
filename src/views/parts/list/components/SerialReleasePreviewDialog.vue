<!--
  SerialReleasePreviewDialog.vue

  2026-10-19 新增：`POST /serials/release-terminal` 的二次确认框。承载「全局一键释放
  终态工单占用序列号」的预览结果 —— 三个计数 + 被释放序列号的明细表。

  为什么必须是**真的对话框组件**而不是 `useConfirm`：本仓的 `useConfirm` 只是
  `ElMessageBox.confirm` 的薄封装，只吃 (title, message: string)，**渲染不了表格**。
  而这次释放不可撤销，管理员必须在确认前逐格看到「到底会释放哪些号」—— 一句字符串
  说辞做不到这件事（把 200 条明细塞进 message 更是不可用）。

  ⚠️ **右上角 × 保留默认开启**（刻意不写 `:show-close="false"`）：CLAUDE.md「弹窗关闭权」
  的判据是「弹窗若是某条路径的**唯一出口**，关闭权才必须收在自己手里」（`QuantityDialog`
  禁 × 是因为它是提交路径上唯一的闸门）。本对话框不满足那个前提：关掉它不丢任何状态
  —— 此刻一行都还没写，工具栏那个按钮还在，随时可以重新预览再开。所以 × 是合法出口。
  别照 `QuantityDialog` 的口径把它改成 `:show-close="false"`。
-->

<template>
  <el-dialog
    :model-value="modelValue"
    title="释放终态工单占用的序列号"
    width="720px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <!-- 空态：没有任何可释放的序列号时，明确说「没有」，不要只给一张空表让管理员猜 -->
    <el-empty v-if="!preview || preview.released_total === 0" description="没有需要释放的序列号" />

    <template v-else>
      <!-- 计数段：三个数字取自后端的「真实总数」，不受明细截断影响 -->
      <div class="counts">
        <el-tag type="warning" effect="plain" size="large">
          装配件 {{ preview.assembly_count }} 条
        </el-tag>
        <el-tag type="warning" effect="plain" size="large">
          零件 {{ preview.part_count }} 条
        </el-tag>
        <el-tag type="danger" effect="dark" size="large">
          合计 {{ preview.released_total }} 条
        </el-tag>
      </div>

      <!-- 警告段：三条真实后果，逐条上屏，不许含糊（尤其第二条） -->
      <ul class="warnings">
        <li>本次释放<b>不可撤销</b>，没有回滚入口。</li>
        <li>
          序列号会<b>回到号池</b>，可能被后续新建工单立即复用（后端号池是 wrap-around 的）——
          原来已完成的工单在别处的引用会指向另一个工单。
        </li>
        <li>零件侧会为<b>每个</b>被释放的零件写一条 <code>SERIAL_RELEASED</code> 归档事件。</li>
      </ul>

      <!-- 明细表：逐格渲染给管理员看，故 schema 接 `.strict()`（形状漂移当场抛，
           而不是被 Zod 默认 strip 静默少渲染一列）。 -->
      <el-table :data="preview.affected" size="small" border max-height="320">
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            {{ row.kind === 'ASSEMBLY' ? '装配件' : '零件' }}
          </template>
        </el-table-column>
        <el-table-column prop="serial_no" label="序列号" min-width="180" />
        <!-- 图号：⚠️ 刻意不写 `?? '—'`。`drawing_no` 是**必填键、值非空**（两列在 baseline
             里都是 NOT NULL，后端据此声明成 `String`），加兜底等于在消费侧养一个恒不触发
             的死分支，并把「后端哪天真的改成可空」降级成静默渲染「—」而不是当场抛。
             字段真源与跨仓对账见 serialReleaseSchema.ts 的文件头 + serial.contract.spec.ts。 -->
        <el-table-column prop="drawing_no" label="图号" min-width="160" />
        <el-table-column prop="status" label="状态" min-width="120" />
      </el-table>

      <!-- 截断提示：明细上限 RELEASE_DETAIL_LIMIT(=200)，三个计数不受它影响 -->
      <p v-if="preview.truncated" class="truncated-hint">
        仅显示前 {{ preview.affected.length }} 条，共 {{ preview.released_total }} 条
      </p>
    </template>

    <template #footer>
      <el-button @click="emit('cancel')">取消</el-button>
      <el-button
        type="danger"
        :loading="applyPending"
        :disabled="!preview || preview.released_total === 0"
        @click="emit('confirm')"
      >
        确认释放
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/parts/list/components/SerialReleasePreviewDialog.vue
//
// 2026-10-19 新增。纯展示 + 两个事件出口，**零 api / 零 mutation 依赖** —— 数据与写操作
// 都在 `useSerialRelease` 里，本组件只收 `preview` 快照并 emit confirm / cancel。
// 局部 import，不进 `main.ts` 全局注册（同 BatchPickerDialog / PartRowCard 的惯例）。

import type { ReleaseTerminalSerialsData } from '../composables/serialReleaseSchema';

defineProps<{
  /** 对话框显隐（壳上 v-model 绑 store.serialRelease.previewOpen）。 */
  modelValue: boolean;
  /** 预览快照；null = 还没预览过。 */
  preview: ReleaseTerminalSerialsData | null;
  /** 实跑在途：确认按钮 loading + 禁用，防重复提交。 */
  applyPending: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'confirm' | 'cancel'): void;
}>();
</script>

<style lang="scss" scoped>
.counts {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.warnings {
  margin: 0 0 12px;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--el-text-color-regular);

  code {
    font-size: 12px;
  }
}

.truncated-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
