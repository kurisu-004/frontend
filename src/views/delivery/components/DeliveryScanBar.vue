<!--
  DeliveryScanBar.vue

  2026-08-25 T11 从 DeliveryNoteScan.vue 抽出：扫码建单入口条（L1 客户选择 + 扫码就绪提示）。

  设计要点：
  - v3 页面已移除手动扫码输入卡，纯靠 useBarcodeScanner 订阅；本组件作为顶部入口
    让用户先选 L1 才能开始扫码。
  - 状态：当前选中的 L1 客户 id（持久化在 useDeliveryScanState 单例）；组件本身不持有
    任何状态，纯受控展示。
  - emit update:l1Id 由 shell 接到 useDeliveryScanState.setL1CustomerId —— setL1CustomerId
    内部写 localStorage 与 _l1CustomerId，触发响应式更新。

  props:
    l1Id          — 当前选中的 L1 id（受控）
    rootCustomers — 一级客户全集（parent_id === null）

  emits:
    update:l1Id   — 用户切换选项时触发；shell 调 setL1CustomerId
-->
<script setup lang="ts">
import type { Customer } from '@/api/customer'

defineProps<{
  l1Id: string
  rootCustomers: Customer[]
}>()

const emit = defineEmits<{
  (e: 'update:l1Id', value: string): void
}>()
</script>

<template>
  <div class="scan-bar">
    <div class="scan-bar__left">
      <span class="scan-bar__title">扫码建单</span>
      <span class="scan-bar__hint">先选一级客户</span>
      <el-select
        :model-value="l1Id"
        placeholder="请选择一级客户"
        filterable
        clearable
        style="width: 280px"
        @update:model-value="(v: string) => emit('update:l1Id', v)"
      >
        <el-option
          v-for="c in rootCustomers"
          :key="c.id"
          :label="c.name"
          :value="c.id"
        />
      </el-select>
    </div>
    <div class="scan-bar__right">
      <el-tag
        v-if="l1Id"
        type="success"
        size="small"
        effect="dark"
      >
        扫码就绪
      </el-tag>
      <el-tag
        v-else
        type="info"
        size="small"
        effect="plain"
      >
        等待选择客户
      </el-tag>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.scan-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #fff;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  gap: 12px;
}

.scan-bar__left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.scan-bar__title {
  font-weight: 600;
  color: var(--text-primary, #303133);
}

.scan-bar__hint {
  color: var(--el-text-color-regular);
  min-width: 64px;
}

.scan-bar__right {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
